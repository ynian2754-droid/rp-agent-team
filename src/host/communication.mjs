import { randomUUID } from 'node:crypto'
import { teamError } from './run-state.mjs'
import { formatValueIssues, validateValueSchema } from '../shared/value-schema.mjs'
import { createRequestPersistence } from './request-persistence.mjs'
import { stableJson } from './context-world-adapter.mjs'
import { isHandoffRef, MISSING, nextHandoffRef, parsePointer, readPath, requesterFacingError, resolveHandoffRefs } from './handoff-refs.mjs'
import { prepareReviewData } from './lived-history-review.mjs'

const draftReviewLanes = ['check-draft', 'check-draft-presentation']

export function parallelDraftReviewPeer(member) {
  if (!member?.execution?.livedHistoryParallelDraftReview) return undefined
  const lanes = draftReviewLanes.map(id => member.communication?.handoffs?.find(rule => rule.id === id))
  if (!lanes.every(rule => rule?.mode === 'await' && rule.parallel && rule.terminal && rule.references &&
    rule.scopedReview && rule.compactReview === 'draft')) return undefined
  if (!lanes[0].autoPublish || lanes[1].autoPublish || lanes[0].to === lanes[1].to) return undefined
  return lanes[1]
}

export function mergedDraftVerdict(row) {
  return row?.mergedDraftReview?.verdict ?? row?.result?.data
}

/** ACL-checked messages and durable, execution-correlated handoff requests. */
export function createCommunication(config, {
  run = {}, onRequest = async () => undefined, onAwait = async ({ promise }) => await promise,
  onResume = async () => undefined, onFailure = async () => undefined, onCancelTarget = async () => undefined,
  onTrace = () => {}, onChange = async () => undefined, onMessage = async () => undefined, onMaterialPack, onWriterPresentation,
  onPersistRequests = () => {}, initialMessages = [],
  initialRequests = [], reusableRequests = [], requestTraceRoot,
  now = () => new Date(), setTimer = setTimeout, clearTimer = clearTimeout
} = {}) {
  const agents = new Map(config.agents.map(agent => [agent.id, agent]))
  const maxDepth = config.execution.maxDepth
  const mailbox = structuredClone(initialMessages)
  run.handoffRequests = structuredClone(initialRequests.length ? initialRequests : run.handoffRequests ?? [])
  let sequence = mailbox.reduce((max, message) => Math.max(max, Number(message.sequence) || 0), 0)
  const waiters = new Map()
  const timers = new Map()
  const awaitingByAgent = new Map()
  // Members that may write handoff references see the ref of each result they receive; everyone else keeps the
  // plain {summary, data} result. A member writes references when one of its own handoffs allows them, or when it
  // answers one that does and has requests of its own to forward.
  const referenceWriters = new Set(config.agents.flatMap(agent => (agent.communication?.handoffs ?? [])
    .filter(rule => rule.references).flatMap(rule => [agent.id, rule.to]))
    .filter(id => agents.get(id)?.communication?.handoffs?.length))
  const requests = createRequestPersistence(run, {
    traceRoot: requestTraceRoot, persist: onPersistRequests,
    onTrace: (type, row, data) => onTrace({ type, agentId: row.from, data: { requestId: row.requestId, handoffId: row.handoffId, from: row.from, to: row.to, mode: row.mode, ...data } })
  })

  async function send({ from, to, body, handoffId, summary, data, topic }) {
    const sender = requireAgent(from)
    const recipients = to === '*'
      ? config.agents.filter(agent => canSend(sender, agent))
      : [requireAgent(to)]
    if (!recipients.length) throw teamError('RP_TEAM_MESSAGE_NOT_ALLOWED', `Agent ${from} has no authorized recipients`)
    if (to !== '*' && !canSend(sender, recipients[0])) {
      throw teamError('RP_TEAM_MESSAGE_NOT_ALLOWED', `Message from ${from} to ${to} is not authorized`)
    }

    let payload = normalizeEnvelope({ body, summary, data })
    let rule
    if (handoffId !== undefined) {
      if (to === '*') throw teamError('RP_TEAM_HANDOFF_TARGET_MISMATCH', 'A handoff message must have one configured target')
      rule = handoffFor(sender, handoffId, recipients[0])
      if (rule.mode !== 'notify') throw teamError('RP_TEAM_HANDOFF_REQUEST_REQUIRED', `Use rp_team_request for ${rule.mode} handoff ${rule.id}`)
      const resolved = rule.references ? resolveHandoffRefs(data, { rows: run.handoffRequests, writer: from }) : undefined
      if (resolved) payload = normalizeEnvelope({ body, summary, data: resolved.value })
      payload = projectEnvelope(payload, rule.requestSelectors)
      validateEnvelope(payload, rule.requestSchema, 'request')
      traceResolvedRefs(from, rule.id, 'request', resolved)
    } else {
      const configuredTargets = new Set((sender.communication.handoffs ?? []).map(item => item.to))
      const bypassed = recipients.find(recipient => configuredTargets.has(recipient.id))
      if (bypassed) throw teamError('RP_TEAM_HANDOFF_REQUIRED', `Use handoffId for the configured message to ${bypassed.id}`)
    }

    const messageId = randomUUID()
    const createdAt = now().toISOString()
    const delivered = []
    for (const recipient of recipients) {
      const message = {
        id: messageId, sequence: ++sequence, type: 'message', from, to: recipient.id,
        body: payload.summary ?? '', summary: payload.summary ?? '',
        ...(payload.data === undefined ? {} : { data: structuredClone(payload.data) }),
        ...(handoffId ? { handoffId } : {}), ...(topic === undefined ? {} : { topic: String(topic) }), createdAt
      }
      mailbox.push(message)
      delivered.push(message)
      onTrace({ type: 'message.sent', agentId: from, data: {
        id: message.id, sequence: message.sequence, from, to: recipient.id,
        body: message.body, ...(handoffId ? { handoffId } : {})
      } })
    }
    await onChange()
    for (const message of delivered) await onMessage(structuredClone(message))
    return { id: messageId, recipients: recipients.map(agent => agent.id) }
  }

  async function request(input) {
    const prepared = prepareRequest(input)
    if (prepared.rule?.mode !== 'await') return dispatchRequest(prepared)
    return withWaitTargets(prepared.from, new Set([prepared.to]), () => dispatchRequest(prepared))
  }

  async function requestMany({ from, requests: inputs, depth = 0, executionId, draftReview = false }) {
    if (!Array.isArray(inputs) || inputs.length < 2) {
      throw teamError('RP_TEAM_HANDOFF_BATCH_INVALID', 'A handoff batch needs at least two independent await requests')
    }
    const prepared = inputs.map(input => {
      if (!input || typeof input !== 'object' || Array.isArray(input)) {
        throw teamError('RP_TEAM_HANDOFF_BATCH_INVALID', 'Each handoff batch entry must be a request object')
      }
      const entry = prepareRequest({ ...input, from, depth, executionId })
      if (entry.rule?.mode !== 'await' || entry.rule.parallel !== true) {
        throw teamError('RP_TEAM_HANDOFF_BATCH_INVALID', `Handoff ${entry.handoffId ?? entry.to} is not configured for parallel await`)
      }
      return entry
    })
    const targetIds = prepared.map(entry => entry.to)
    const targets = new Set(targetIds)
    if (targets.size !== targetIds.length
      || targetIds.some(target => targetIds.some(peer => target !== peer && createsWaitCycle(peer, target)))) {
      throw teamError('RP_TEAM_HANDOFF_BATCH_INVALID', 'A handoff batch requires distinct targets that do not depend on each other')
    }
    const people = prepared.filter(entry => entry.rule.materialPack).flatMap(entry => entry.projected.data.group)
    if (new Set(people).size !== people.length) {
      throw teamError('RP_TEAM_HANDOFF_BATCH_INVALID', 'Parallel material packs must have disjoint groups')
    }
    const batchId = draftReview ? randomUUID() : undefined
    if (draftReview) {
      const peer = parallelDraftReviewPeer(requireAgent(from))
      if (!peer || prepared.length !== 2 || prepared[0].rule.id !== draftReviewLanes[0] || prepared[1].rule.id !== peer.id ||
        prepared[0].worldReviewRequestId !== prepared[1].worldReviewRequestId ||
        stableJson(prepared[0].projected.data) !== stableJson(prepared[1].projected.data)) {
        throw teamError('RP_TEAM_HANDOFF_BATCH_INVALID', 'Both draft-review lanes must receive the same original draft and world result')
      }
    }

    return withWaitTargets(prepared[0].from, targets, async () => {
      const requestId = batchId ?? randomUUID()
      const resumed = []
      const promise = Promise.all(prepared.map(async entry => {
        try {
          const result = await dispatchRequest(entry, resumed, batchId)
          return { handoffId: entry.rule.id, status: 'completed', ...result }
        } catch (error) {
          return { handoffId: entry.rule.id, status: 'failed', error: requesterFacingError(error, entry) }
        } finally {
          targets.delete(entry.to)
        }
      }))
      const results = await onAwait({ from, requestId, promise })
      for (const event of resumed) onTrace(event)
      if (!batchId) return { results }
      const lanes = draftReviewLanes.map(id => run.handoffRequests.find(row => row.draftReviewBatchId === batchId && row.handoffId === id))
      const [primary] = lanes
      const merged = { ...mergeDraftReviewIssues(primary.request.data.draft, lanes.map(row => row.status === 'completed' ? row.result?.data : undefined)),
        lanes: lanes.map(({ requestId, ref, handoffId, status }) => ({ requestId, ref, handoffId, status })) }
      requests.update(primary.requestId, row => { row.mergedDraftReview = merged })
      onTrace({ type: 'publication.draft_review_merged', agentId: from, data: {
        requestId: primary.requestId, batchId, lanes: merged.lanes, pass: merged.verdict.pass, issues: merged.verdict.issues.length
      } })
      return { results, review: { ref: primary.ref, data: merged.verdict, incomplete: merged.incomplete } }
    })
  }

  async function withWaitTargets(from, targets, runWait) {
    if (awaitingByAgent.has(from)) {
      throw teamError('RP_TEAM_HANDOFF_EXECUTION_INACTIVE', `Agent ${from} is already waiting for a handoff`)
    }
    awaitingByAgent.set(from, targets)
    try {
      return await runWait()
    } finally {
      if (awaitingByAgent.get(from) === targets) awaitingByAgent.delete(from)
    }
  }

  function prepareRequest({ from, to, body = '', summary, data, handoffId, topic, depth = 0, reason = 'agent request', executionId, presentation }) {
    const sender = requireAgent(from)
    const recipient = requireAgent(to)
    const status = requestStatus(sender, recipient)
    if (status === 'acl' || status === 'trigger') {
      throw teamError('RP_TEAM_REQUEST_NOT_ALLOWED', `Activation request from ${from} to ${to} is not authorized`)
    }
    if (status === 'not-requestable') {
      throw teamError('RP_TEAM_AGENT_NOT_REQUESTABLE', `Agent ${to} does not accept requested activations`)
    }
    if (!Number.isInteger(depth) || depth < 0 || depth + 1 > maxDepth) {
      throw teamError('RP_TEAM_ACTIVATION_DEPTH', `Agent activation depth cannot exceed ${maxDepth}`)
    }

    const rule = handoffId === undefined ? undefined : handoffFor(sender, handoffId, recipient)
    if (handoffId === undefined && sender.communication.handoffs?.some(item => item.to === recipient.id)) {
      throw teamError('RP_TEAM_HANDOFF_REQUIRED', `Use handoffId for the configured request to ${recipient.id}`)
    }
    if (rule?.mode === 'notify') {
      throw teamError('RP_TEAM_HANDOFF_MESSAGE_REQUIRED', `Use rp_team_send for notify handoff ${rule.id}; it does not schedule an activation`)
    }
    if (rule && !canSend(recipient, sender)) {
      throw teamError('RP_TEAM_MESSAGE_NOT_ALLOWED', `Handoff result from ${to} to ${from} is not authorized`)
    }
    if (rule && ['await', 'resume'].includes(rule.mode)) {
      if (from === to) throw teamError('RP_TEAM_HANDOFF_CYCLE', 'An agent cannot wait for or resume itself')
      if (createsWaitCycle(from, to)) throw teamError('RP_TEAM_HANDOFF_CYCLE', `Handoff ${from} -> ${to} would create a wait or dependency cycle`)
    }

    // Expand handoff references first, so selectors and the request schema see the exact forwarded originals.
    const resolved = rule?.references ? resolveHandoffRefs(data, { rows: run.handoffRequests, writer: from }) : undefined
    const writerPresentationMode = rule?.compactReview === 'draft' && sender.execution?.livedHistoryWriterPresentation
    const worldRef = rule?.compactReview === 'draft' &&
      (writerPresentationMode || recipient.execution?.livedHistoryDialoguePremises || recipient.execution?.livedHistoryReviewPresentation ||
        recipient.execution?.livedHistoryIndependentPremises)
      ? resolved?.refs.find(ref => ref.at === '/world_return' && ref.side === 'result' && !ref.pointer) : undefined
    const world = worldRef && run.handoffRequests.find(row => row.from === sender.id &&
      row.sourceExecutionId === String(executionId ?? '') && row.handoffId === 'ask-world' &&
      row.ref === worldRef.ref && row.status === 'completed')
    const worldReviewRequestId = world?.requestId
    let preparedData = resolved ? resolved.value : data
    if (rule?.materialPack) preparedData = onMaterialPack({ from, to, executionId, data: preparedData })
    if (rule?.compactReview) preparedData = prepareReviewData(rule.compactReview, preparedData, run.currentInput)
    const payload = normalizeEnvelope({ body, summary, data: preparedData })
    const projected = rule ? projectEnvelope(payload, rule.requestSelectors) : payload
    if (rule) validateEnvelope(projected, rule.requestSchema, 'request')
    let writerPresentation
    if (writerPresentationMode) {
      writerPresentation = rule.id === draftReviewLanes[1] ? [] : onWriterPresentation?.({
        writer: sender, world, draft: projected.data?.draft, presentation
      }) ?? []
    }
    return { from: sender.id, to: recipient.id, handoffId, topic, depth, reason, executionId, rule, resolved, projected,
      worldReviewRequestId, writerPresentation }
  }

  async function dispatchRequest({ from, to, handoffId, topic, depth, reason, executionId, rule, resolved, projected,
    worldReviewRequestId, writerPresentation }, batchResumeEvents, draftReviewBatchId) {
    if (rule) traceResolvedRefs(from, rule.id, 'request', resolved)
    const reusable = rule && !rule.simulation && !rule.scopedReview && ['await', 'resume'].includes(rule.mode)
      ? reusableRequests.find(previous => previous.status === 'completed'
        && previous.mode === rule.mode && previous.handoffId === rule.id
        && previous.from === from && previous.to === to && previous.topic === topic && previous.targetExecutionId
        && previous.result && stableJson(previous.request) === stableJson(projected)
        && Boolean(previous.terminal) === Boolean(rule.terminal)
        && stableJson(previous.responseSchema ?? null) === stableJson(rule.responseSchema ?? null)
        && stableJson(previous.responseSelectors ?? null) === stableJson(rule.responseSelectors ?? null))
      : undefined
    const requestId = randomUUID()
    const createdAt = now().toISOString()
    const message = {
      id: requestId, requestId, sequence: ++sequence, type: 'request', from, to,
      body: projected.summary ?? '', summary: projected.summary ?? '',
      ...(projected.data === undefined ? {} : { data: structuredClone(projected.data) }),
      depth: depth + 1, createdAt,
      ...(handoffId ? { handoffId } : {}), ...(rule ? { mode: rule.mode } : {}),
      ...(topic === undefined ? {} : { topic: String(topic) })
    }
    mailbox.push(message)
    if (rule) {
      requests.create({
        requestId, ref: nextHandoffRef(run.handoffRequests, { from, handoffId: rule.id }),
        handoffId: rule.id, mode: rule.mode, from, to, sourceExecutionId: String(executionId ?? ''),
        ...(rule.references ? { references: true } : {}),
        ...(rule.terminal ? { terminal: true } : {}),
        ...(rule.simulation ? { simulation: true } : {}),
        ...(rule.materialPack ? { materialPack: true } : {}),
        ...(rule.compactReview ? { compactReview: rule.compactReview } : {}),
        ...(rule.scopedReview ? { scopedReview: true } : {}),
        ...(draftReviewBatchId ? { draftReviewBatchId } : {}),
        ...(worldReviewRequestId ? { worldReviewRequestId } : {}),
        ...(writerPresentation === undefined ? {} : { writerPresentation: structuredClone(writerPresentation) }),
        request: structuredClone(projected), responseSelectors: rule.responseSelectors,
        responseSchema: rule.responseSchema, onFailure: rule.onFailure, timeoutMs: rule.timeoutMs,
        depth: depth + 1, ...(topic === undefined ? {} : { topic: String(topic) }), ...(reusable ? { reusedFromRunId: reusable.sourceRunId,
          reusedFromRequestId: reusable.requestId } : {})
      })
      if (rule.mode === 'await') {
        const waiter = deferred()
        void waiter.promise.catch(() => {})
        waiters.set(requestId, waiter)
      }
      if (!reusable && !rule.simulation) startRequestTimer(requests.get(requestId))
    }

    onTrace({ type: rule ? 'handoff.request_queued' : 'message.requested', agentId: from, data: {
      id: message.id, requestId, sequence: message.sequence, from, to, body: message.body, depth: message.depth,
      ...(handoffId ? { handoffId } : {}), ...(rule ? { mode: rule.mode, sourceExecutionId: executionId } : {})
    } })
    await onChange()
    let activation
    try {
      const queued = rule && requests.get(requestId)
      if (isTerminal(queued?.status)) {
        throw teamError(queued.error.code, queued.error.message)
      }
      if (reusable) {
        validateEnvelope(reusable.result, rule.responseSchema, 'response')
        if (rule.mode === 'resume') {
          // The scheduler takes the requester's depth and adds the hop itself; message.depth is already the target depth.
          activation = await onRequest({
            from, to, depth, reason, messageId: message.id, message: structuredClone(message), reuseTarget: true,
            requestId, handoffId: rule.id, mode: rule.mode,
            fromExecutionId: String(executionId ?? ''), reserveResume: true
          })
        } else activation = { reused: true, targetExecutionId: reusable.targetExecutionId }
        requests.update(requestId, row => {
          row.activation = structuredClone(activation)
          row.targetExecutionId = String(reusable.targetExecutionId)
          row.targetActivationStatus = 'reused'
          if (reusable.publicationReview) row.publicationReview = structuredClone(reusable.publicationReview)
          row.status = 'running'
        })
        requests.complete(requestId, { targetExecutionId: reusable.targetExecutionId, result: reusable.result })
        clearRequestTimer(requestId)
        await deliverResultMessage(requests.get(requestId), { status: 'completed', ...structuredClone(reusable.result) })
        waiters.get(requestId)?.resolve(withRef(requests.get(requestId), reusable.result, referenceWriters))
        onTrace({ type: 'handoff.target_reused', agentId: from, data: {
          requestId, handoffId: rule.id, reusedFromRunId: reusable.sourceRunId,
          reusedFromRequestId: reusable.requestId, targetExecutionId: reusable.targetExecutionId
        } })
      } else {
        activation = await onRequest({
          from, to, depth, reason, messageId: message.id, message: structuredClone(message),
          ...(rule ? { requestId, handoffId: rule.id, mode: rule.mode, fromExecutionId: String(executionId ?? ''), reserveResume: rule.mode === 'resume' } : {})
        })
        if (rule) requests.update(requestId, row => { row.activation = structuredClone(activation) })
      }
      await onChange()
    } catch (error) {
      if (rule) await failRequest(requestId, error, { targetComplete: true })
      waiters.delete(requestId)
      throw batchResumeEvents ? handoffFailure(requests.get(requestId), error) : error
    }

    if (!rule || rule.mode !== 'await') return { id: requestId, activation, ...(rule ? { handoffId: rule.id, mode: rule.mode } : {}) }
    const resultPromise = waiters.get(requestId).promise
    onTrace({ type: 'handoff.waiting', agentId: from, data: { requestId, handoffId: rule.id, from, to, sourceExecutionId: executionId, targetActivation: activation } })
    await onChange()
    try {
      const result = batchResumeEvents ? await resultPromise : await onAwait({ from, requestId, promise: resultPromise })
      const resumed = { type: 'handoff.resumed', agentId: from, data: {
        requestId, handoffId: rule.id, sourceExecutionId: executionId, targetExecutionId: requests.get(requestId)?.targetExecutionId
      } }
      if (batchResumeEvents) batchResumeEvents.push(resumed)
      else onTrace(resumed)
      return result
    } catch (error) {
      if (!isTerminal(requests.get(requestId)?.status)) await failRequest(requestId, error)
      throw handoffFailure(requests.get(requestId), error)
    } finally {
      waiters.delete(requestId)
    }
  }

  async function bindTargetExecution(requestId, executionId) {
    const row = requests.get(requestId)
    if (!row || isTerminal(row.status)) return false
    const bound = requests.bindTarget(requestId, String(executionId))
    if (bound && row.simulation && !timers.has(row.requestId)) startRequestTimer(row)
    await onChange()
    return bound
  }

  function bindWorldReviewFile(worldRequestId, fileRequestId, worldExecutionId) {
    const world = requests.get(worldRequestId)
    const file = requests.get(fileRequestId)
    if (world?.handoffId !== 'ask-world' || world.status !== 'running' || world.targetExecutionId !== worldExecutionId ||
      file?.handoffId !== 'ask-file' || file.status !== 'completed' || file.from !== world.to) return
    requests.update(worldRequestId, row => { row.worldReviewFileRequestId = fileRequestId })
  }

  // Check a target's submission against its incoming handoff contract when it is made, so the target can fix it
  // in the same activation. completeTarget still validates the final result after the activation ends.
  function checkTargetResult({ requestId, agentId, result }) {
    const row = requests.get(requestId)
    if (!row || isTerminal(row.status) || row.mode === 'notify' || !row.responseSchema || row.to !== agentId) return false
    validateEnvelope(projectEnvelope(normalizeEnvelope(result), row.responseSelectors), row.responseSchema, 'response')
    return true
  }

  function sealTargetResult(requestId) {
    // The response was accepted before the deadline. The native turn/end still decides delivery.
    clearRequestTimer(requestId)
  }

  async function completeTarget({ requestId, targetExecutionId, result }) {
    const row = requests.get(requestId)
    if (!row || isTerminal(row.status)) return false
    if (row.mode === 'notify') {
      if (requests.complete(requestId, { targetExecutionId, result: {} })) {
        clearRequestTimer(requestId)
        await onChange()
        return true
      }
      return false
    }
    const projected = projectEnvelope(normalizeEnvelope(result), row.responseSelectors)
    validateEnvelope(projected, row.responseSchema, 'response')
    if (row.responseSchema && result?.typed !== true) {
      throw teamError('RP_TEAM_HANDOFF_RESULT_REQUIRED', `Handoff ${row.handoffId} requires rp_team_submit_internal with typed data`)
    }
    if (requests.complete(requestId, { targetExecutionId, result: projected, publicationReview: result?.publicationReview })) {
      clearRequestTimer(requestId)
      await deliverResultMessage(row, { status: 'completed', ...projected })
      waiters.get(requestId)?.resolve(withRef(row, projected, referenceWriters))
      await onChange()
      return true
    }
    return false
  }

  async function failTarget({ requestId, targetExecutionId, error, targetComplete = true }) {
    return await failRequest(requestId, error ?? teamError('RP_TEAM_HANDOFF_FAILED', 'Requested target failed'), {
      targetExecutionId, targetComplete
    })
  }

  async function activationFinished({ agentId, executionId, status, error, requestId }) {
    const completedRows = requests.finishSource(executionId, status, error)
    if (requestId) requests.finishTarget(requestId, executionId, status)
    for (const row of completedRows) await maybeQueueResume(row)
    if (requestId) await maybeQueueResume(requests.get(requestId))
    await onChange()
  }

  async function maybeQueueResume(row) {
    if (!row || row.mode !== 'resume' || row.resumeQueued || !row.sourceActivationComplete) return false
    if (row.sourceActivationStatus !== 'complete') {
      requests.update(row.requestId, current => { current.resumeQueued = true })
      await onResume({
        requestId: row.requestId, from: row.from, to: row.to, sourceExecutionId: row.sourceExecutionId,
        targetExecutionId: row.targetExecutionId, depth: row.depth, succeeded: false, releaseOnly: true
      })
      return false
    }
    if (!row.targetActivationComplete) return false
    if (row.status !== 'completed' && row.onFailure === 'stop') return false
    requests.update(row.requestId, current => { current.resumeQueued = true })
    await onResume({
      requestId: row.requestId, from: row.from, to: row.to, sourceExecutionId: row.sourceExecutionId,
      targetExecutionId: row.targetExecutionId, depth: row.depth, succeeded: row.status === 'completed'
    })
    onTrace({ type: 'handoff.resume_queued', agentId: row.from, data: {
      requestId: row.requestId, handoffId: row.handoffId, sourceExecutionId: row.sourceExecutionId,
      targetExecutionId: row.targetExecutionId, succeeded: row.status === 'completed'
    } })
    await onChange()
    return true
  }

  async function failRequest(requestId, error, { targetExecutionId, targetComplete = false, cancelled = false } = {}) {
    const row = requests.get(requestId)
    if (!row || isTerminal(row.status)) return false
    const targetWasNotStarted = !row.targetExecutionId
    const changed = requests.fail(requestId, error, { targetExecutionId, targetComplete, cancelled })
    if (!changed) return false
    clearRequestTimer(requestId)
    // Requesters get a cleaned message; the request row and the trace keep the full upstream text.
    const errorValue = requesterFacingError(requests.get(requestId).error, row)
    if (row.mode !== 'notify') await deliverResultMessage(row, { status: cancelled ? 'cancelled' : 'failed', error: errorValue })
    waiters.get(requestId)?.reject(handoffFailure(row, error))
    if (!cancelled && (targetWasNotStarted || error?.code === 'RP_TEAM_HANDOFF_TIMEOUT')) {
      const removed = await onCancelTarget({ requestId, request: structuredClone(row), error })
      if (targetWasNotStarted && removed) requests.update(requestId, current => { current.targetActivationComplete = true })
    }
    await onChange()
    if (row.mode === 'resume') {
      if (cancelled) {
        requests.update(requestId, current => { current.resumeQueued = true })
        await onResume({ requestId, from: row.from, to: row.to, releaseOnly: true, succeeded: false })
      } else await maybeQueueResume(requests.get(requestId))
    }
    if (row.onFailure === 'stop' && !cancelled) await onFailure({ request: structuredClone(row), error: handoffFailure(row, error) })
    return true
  }

  async function cancelAll(reason = 'Run cancelled') {
    const error = teamError('RP_TEAM_CANCELLED', String(reason?.message ?? reason))
    for (const row of requests.pending()) await failRequest(row.requestId, error, { cancelled: true, targetComplete: true })
    for (const requestId of [...timers.keys()]) clearRequestTimer(requestId)
    awaitingByAgent.clear()
    await onChange()
  }

  async function deliverResultMessage(row, result) {
    const message = {
      id: `${row.requestId}:result`, requestId: row.requestId, sequence: ++sequence,
      type: 'handoff_result', from: row.to, to: row.from, handoffId: row.handoffId,
      ...(row.ref && referenceWriters.has(row.from) ? { ref: row.ref } : {}),
      status: result.status, body: result.summary ?? result.error?.message ?? '',
      summary: result.summary ?? '',
      ...(result.data === undefined ? {} : { data: structuredClone(result.data) }),
      ...(result.error ? { error: structuredClone(result.error) } : {}),
      ...(row.topic === undefined ? {} : { topic: String(row.topic) }), createdAt: now().toISOString()
    }
    mailbox.push(message)
    onTrace({ type: result.status === 'completed' ? 'handoff.result_delivered' : 'handoff.error_delivered',
      agentId: row.to, data: { requestId: row.requestId, handoffId: row.handoffId, from: row.to, to: row.from, status: result.status } })
    await onMessage(structuredClone(message))
  }

  /** Expand handoff references in data `writer` sends or submits; `trace()` records which ones were used. */
  function resolveRefs({ writer, data, handoffId, direction = 'response' }) {
    const resolved = resolveHandoffRefs(data, { rows: run.handoffRequests, writer })
    return { data: resolved.value, refs: resolved.refs, trace: () => traceResolvedRefs(writer, handoffId, direction, resolved) }
  }

  /**
   * Expand references in an answer to an incoming handoff, when that handoff allows them. The answering member
   * forwards what it received from its own requests, so the requester gets the exact originals.
   */
  function resolveAnswerRefs({ requestId, agentId, data }) {
    const row = requests.get(requestId)
    if (!row?.references || row.to !== agentId || data === undefined) return { data, refs: [], trace() {} }
    return resolveRefs({ writer: agentId, data, handoffId: row.handoffId, direction: 'response' })
  }

  function resolveApprovedBody({ writer, bodyRef }) {
    if (!isHandoffRef(bodyRef) || bodyRef.side !== 'request' || bodyRef.pointer !== '/draft') {
      throw teamError('RP_TEAM_HANDOFF_REF_INVALID', 'Publication bodyRef must reference /draft of an approved handoff request with side: "request"')
    }
    const row = run.handoffRequests.find(item => item.from === writer && item.ref === bodyRef.$ref)
    const paired = parallelDraftReviewPeer(requireAgent(writer))
    const approved = paired ? row?.handoffId === draftReviewLanes[0] && row.mergedDraftReview?.verdict.pass === true
      : row?.handoffId !== draftReviewLanes[1] && row?.result?.data?.pass === true
    if (!row?.terminal || !row.references || row.status !== 'completed' || !approved) {
      throw teamError('RP_TEAM_HANDOFF_REF_INVALID', 'Publication bodyRef needs your completed terminal handoff with references enabled and data.pass equal to true')
    }
    const resolved = resolveRefs({ writer, data: bodyRef, handoffId: row.handoffId, direction: 'publication' })
    if (typeof resolved.data !== 'string' || !resolved.data.trim()) {
      throw teamError('RP_TEAM_EMPTY_PUBLICATION', 'Publication bodyRef must resolve to non-empty text')
    }
    return resolved
  }

  function traceResolvedRefs(agentId, handoffId, direction, resolved) {
    if (!resolved?.refs.length) return
    onTrace({ type: 'handoff.refs_resolved', agentId, data: { handoffId, direction, refs: structuredClone(resolved.refs) } })
  }

  function clearRequestTimer(requestId) {
    const timer = timers.get(requestId)
    if (timer !== undefined) clearTimer(timer)
    timers.delete(requestId)
  }

  function startRequestTimer(row) {
    const timer = setTimer(() => {
      void failRequest(row.requestId, teamError('RP_TEAM_HANDOFF_TIMEOUT', `Handoff ${row.handoffId} timed out after ${row.timeoutMs} ms`), { targetComplete: false })
    }, row.timeoutMs)
    timer?.unref?.()
    timers.set(row.requestId, timer)
  }

  function messagesFor(agentId, senderIds) {
    const receiver = requireAgent(agentId)
    const selected = senderIds === undefined ? receiver.communication.receiveFrom : senderIds
    const senders = new Set(selected)
    return mailbox.filter(message => {
      if (message.to !== agentId) return false
      if (message.type === 'request') {
        return (senderIds === undefined || allows(senders, message.from)) && receiver.triggers.some(trigger => trigger.type === 'requested_by_agent'
          && (!trigger.from?.length || allows(trigger.from, message.from)))
      }
      return allows(senders, message.from) && allows(receiver.communication.receiveFrom, message.from)
    }).map(message => structuredClone(message))
  }

  function allMessages() { return structuredClone(mailbox) }

  function targetsFor(agentId) {
    const sender = requireAgent(agentId)
    const handoffs = (sender.communication.handoffs ?? []).map(rule => structuredClone(rule))
    const incomingHandoffs = config.agents.flatMap(agent => (agent.communication.handoffs ?? [])
      .filter(rule => rule.to === agentId)
      .map(rule => ({ from: agent.id, ...structuredClone(rule) })))
    return {
      sendTo: config.agents.filter(agent => canSend(sender, agent)).map(agent => agent.id),
      requestTo: config.agents.filter(agent => requestStatus(sender, agent) === 'allowed').map(agent => agent.id),
      ...(handoffs.length ? { handoffs } : {}),
      ...(incomingHandoffs.length ? { incomingHandoffs } : {})
    }
  }

  function canSend(sender, recipient) {
    return recipient.id !== sender.id && allows(sender.communication.sendTo, recipient.id)
      && allows(recipient.communication.receiveFrom, sender.id)
  }

  function requestStatus(sender, recipient) {
    if (!allows(sender.communication.requestTo, recipient.id) || !allows(recipient.communication.requestFrom, sender.id)) return 'acl'
    const triggers = recipient.triggers.filter(item => item.type === 'requested_by_agent')
    if (!triggers.length) return 'not-requestable'
    if (!triggers.some(trigger => !trigger.from?.length || allows(trigger.from, sender.id))) return 'trigger'
    return 'allowed'
  }

  function handoffFor(sender, id, recipient) {
    const rule = (sender.communication.handoffs ?? []).find(item => item.id === String(id))
    if (!rule) throw teamError('RP_TEAM_HANDOFF_NOT_FOUND', `Agent ${sender.id} has no handoff ${id}`)
    if (rule.to !== recipient.id) throw teamError('RP_TEAM_HANDOFF_TARGET_MISMATCH', `Handoff ${id} is configured for ${rule.to}, not ${recipient.id}`)
    return rule
  }

  function createsWaitCycle(from, to) {
    const visited = new Set()
    const reachesSource = agentId => {
      if (agentId === from) return true
      if (visited.has(agentId)) return false
      visited.add(agentId)
      const agent = agents.get(agentId)
      if (!agent) return false
      for (const dependency of agent.execution.after) if (reachesSource(dependency)) return true
      for (const target of awaitingByAgent.get(agentId) ?? []) if (reachesSource(target)) return true
      return false
    }
    return reachesSource(to)
  }

  function requireAgent(id) {
    const agent = agents.get(String(id))
    if (!agent) throw teamError('RP_TEAM_AGENT_NOT_FOUND', `Unknown agent ${id}`)
    return agent
  }

  return {
    send, request, requestMany, validateRequest: input => { prepareRequest(input) }, messagesFor, allMessages, targetsFor,
    bindTargetExecution, bindWorldReviewFile, checkTargetResult, sealTargetResult, completeTarget, failTarget, activationFinished, cancelAll, resolveRefs, resolveAnswerRefs, resolveApprovedBody,
    getRequest: requestId => requests.get(requestId), pendingRequests: () => requests.pending()
  }
}

export function mergeDraftReviewIssues(draft, verdicts) {
  const issues = new Map()
  let incomplete = verdicts.length !== draftReviewLanes.length
  for (const data of verdicts) {
    if (typeof data?.pass !== 'boolean' || !Array.isArray(data.issues) || data.pass !== (data.issues.length === 0) ||
      data.issues.some(issue => typeof issue?.quote !== 'string' || !issue.quote.trim() || !draft.includes(issue.quote))) {
      incomplete = true
      continue
    }
    for (const issue of data.issues) {
      const key = JSON.stringify([issue.quote, issue.kind])
      const prior = issues.get(key)
      if (!prior) issues.set(key, { ...issue })
      else if (issue.note && issue.note !== prior.note) prior.note = [prior.note, issue.note].filter(Boolean).join('\n')
    }
  }
  const ordered = [...issues.values()].sort((a, b) => draft.indexOf(a.quote) - draft.indexOf(b.quote))
  return { verdict: { pass: !incomplete && ordered.length === 0, issues: ordered }, incomplete }
}

function normalizeEnvelope({ body, summary, data }) {
  const value = summary === undefined ? body === undefined ? '' : String(body) : String(summary)
  return { summary: value, ...(data === undefined ? {} : { data: structuredClone(data) }) }
}

function projectEnvelope(envelope, selectors) {
  if (selectors === undefined) return structuredClone(envelope)
  const projected = {}
  for (const selector of selectors) {
    const segments = parsePointer(selector)
    if (segments === null) return structuredClone(envelope)
    const value = readPath(envelope, segments)
    if (value === MISSING) continue
    writePath(projected, segments, structuredClone(value))
  }
  return projected
}

function validateEnvelope(envelope, schema, label) {
  const issues = validateValueSchema(envelope, schema)
  if (issues.length) {
    throw teamError(`RP_TEAM_HANDOFF_${label.toUpperCase()}_INVALID`, `Handoff ${label} ${formatValueIssues(issues, { emptyPath: '/' })}`)
  }
}

function writePath(target, segments, value) {
  if (!segments.length) return
  let current = target
  for (let index = 0; index < segments.length - 1; index += 1) {
    const segment = segments[index]
    const next = segments[index + 1]
    if (!Object.hasOwn(current, segment)) Object.defineProperty(current, segment, {
      value: /^(?:0|[1-9]\d*)$/u.test(next) ? [] : {}, enumerable: true, configurable: true, writable: true
    })
    current = current[segment]
    if (current === null || typeof current !== 'object') return
  }
  Object.defineProperty(current, segments.at(-1), { value, enumerable: true, configurable: true, writable: true })
}

function deferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

function isTerminal(status) { return ['completed', 'failed', 'cancelled'].includes(status) }

function handoffFailure(request, error) {
  if (request?.onFailure === 'stop' || request?.error?.code === 'RP_TEAM_CANCELLED') return error
  const issue = requesterFacingError(request?.error ?? error, request)
  return teamError(issue.code, issue.message)
}

/** An await result as the requester receives it: the projected envelope, plus its reference for a member that can use one. */
function withRef(row, envelope, referenceWriters) {
  return { ...(row?.ref && referenceWriters.has(row.from) ? { ref: row.ref } : {}), ...structuredClone(envelope) }
}

function allows(configured, value) {
  return configured instanceof Set
    ? configured.has('*') || configured.has(value)
    : configured.includes('*') || configured.includes(value)
}
