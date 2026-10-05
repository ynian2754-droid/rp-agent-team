import { randomUUID } from 'node:crypto'
import { teamError } from './run-state.mjs'
import { validateValueSchema } from '../shared/value-schema.mjs'
import { createRequestPersistence } from './request-persistence.mjs'
import { stableJson } from './context-world-adapter.mjs'

/** ACL-checked messages and durable, execution-correlated handoff requests. */
export function createCommunication(config, {
  run = {}, onRequest = async () => undefined, onAwait = async ({ promise }) => await promise,
  onResume = async () => undefined, onFailure = async () => undefined, onCancelTarget = async () => undefined,
  onTrace = () => {}, onChange = async () => undefined, onMessage = async () => undefined,
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
      payload = projectEnvelope(payload, rule.requestSelectors)
      validateEnvelope(payload, rule.requestSchema, 'request')
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

  async function request({ from, to, body = '', summary, data, handoffId, topic, depth = 0, reason = 'agent request', executionId }) {
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

    const payload = normalizeEnvelope({ body, summary, data })
    const projected = rule ? projectEnvelope(payload, rule.requestSelectors) : payload
    if (rule) validateEnvelope(projected, rule.requestSchema, 'request')
    const reusable = rule && ['await', 'resume'].includes(rule.mode)
      ? reusableRequests.find(previous => previous.status === 'completed'
        && previous.mode === rule.mode && previous.handoffId === rule.id
        && previous.from === from && previous.to === to && previous.topic === topic && previous.targetExecutionId
        && previous.result && stableJson(previous.request) === stableJson(projected)
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
        requestId, handoffId: rule.id, mode: rule.mode, from, to, sourceExecutionId: String(executionId ?? ''),
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
      if (!reusable) {
        const timer = setTimer(() => {
          void failRequest(requestId, teamError('RP_TEAM_HANDOFF_TIMEOUT', `Handoff ${rule.id} timed out after ${rule.timeoutMs} ms`), { targetComplete: false })
        }, rule.timeoutMs)
        timer?.unref?.()
        timers.set(requestId, timer)
      }
    }

    onTrace({ type: rule ? 'handoff.request_queued' : 'message.requested', agentId: from, data: {
      id: message.id, requestId, sequence: message.sequence, from, to, body: message.body, depth: message.depth,
      ...(handoffId ? { handoffId } : {}), ...(rule ? { mode: rule.mode, sourceExecutionId: executionId } : {})
    } })
    await onChange()
    let activation
    try {
      if (reusable) {
        validateEnvelope(reusable.result, rule.responseSchema, 'response')
        if (rule.mode === 'resume') {
          activation = await onRequest({
          from, to, depth: message.depth, reason, messageId: message.id, message: structuredClone(message), reuseTarget: true,
            requestId, handoffId: rule.id, mode: rule.mode,
            fromExecutionId: String(executionId ?? ''), reserveResume: true
          })
        } else activation = { reused: true, targetExecutionId: reusable.targetExecutionId }
        requests.update(requestId, row => {
          row.activation = structuredClone(activation)
          row.targetExecutionId = String(reusable.targetExecutionId)
          row.targetActivationStatus = 'reused'
          row.status = 'running'
        })
        requests.complete(requestId, { targetExecutionId: reusable.targetExecutionId, result: reusable.result })
        clearRequestTimer(requestId)
        await deliverResultMessage(requests.get(requestId), { status: 'completed', ...structuredClone(reusable.result) })
        waiters.get(requestId)?.resolve(structuredClone(reusable.result))
        onTrace({ type: 'handoff.target_reused', agentId: from, data: {
          requestId, handoffId: rule.id, reusedFromRunId: reusable.sourceRunId,
          reusedFromRequestId: reusable.requestId, targetExecutionId: reusable.targetExecutionId
        } })
      } else {
        activation = await onRequest({
          from, to, depth: message.depth, reason, messageId: message.id, message: structuredClone(message),
          ...(rule ? { requestId, handoffId: rule.id, mode: rule.mode, fromExecutionId: String(executionId ?? ''), reserveResume: rule.mode === 'resume' } : {})
        })
        if (rule) requests.update(requestId, row => { row.activation = structuredClone(activation) })
      }
      await onChange()
    } catch (error) {
      if (rule) await failRequest(requestId, error, { targetComplete: true })
      waiters.delete(requestId)
      throw error
    }

    if (!rule || rule.mode !== 'await') return { id: requestId, activation, ...(rule ? { handoffId: rule.id, mode: rule.mode } : {}) }
    const resultPromise = waiters.get(requestId).promise
    awaitingByAgent.set(from, { to, requestId, executionId: String(executionId ?? '') })
    onTrace({ type: 'handoff.waiting', agentId: from, data: { requestId, handoffId: rule.id, from, to, sourceExecutionId: executionId, targetActivation: activation } })
    await onChange()
    try {
      const result = await onAwait({ from, requestId, promise: resultPromise })
      onTrace({ type: 'handoff.resumed', agentId: from, data: {
        requestId, handoffId: rule.id, sourceExecutionId: executionId, targetExecutionId: requests.get(requestId)?.targetExecutionId
      } })
      return result
    } catch (error) {
      if (!isTerminal(requests.get(requestId)?.status)) await failRequest(requestId, error)
      throw handoffFailure(requests.get(requestId), error)
    } finally {
      if (awaitingByAgent.get(from)?.requestId === requestId) awaitingByAgent.delete(from)
      waiters.delete(requestId)
    }
  }

  async function bindTargetExecution(requestId, executionId) {
    const row = requests.get(requestId)
    if (!row || isTerminal(row.status)) return false
    const bound = requests.bindTarget(requestId, String(executionId))
    await onChange()
    return bound
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
    if (requests.complete(requestId, { targetExecutionId, result: projected })) {
      clearRequestTimer(requestId)
      await deliverResultMessage(row, { status: 'completed', ...projected })
      waiters.get(requestId)?.resolve(structuredClone(projected))
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
    const errorValue = requests.get(requestId).error
    if (row.mode !== 'notify') await deliverResultMessage(row, { status: cancelled ? 'cancelled' : 'failed', error: errorValue })
    waiters.get(requestId)?.reject(handoffFailure(row, error))
    if (targetWasNotStarted && !cancelled) {
      const removed = await onCancelTarget({ requestId, request: structuredClone(row), error })
      if (removed) requests.update(requestId, current => { current.targetActivationComplete = true })
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

  function clearRequestTimer(requestId) {
    const timer = timers.get(requestId)
    if (timer !== undefined) clearTimer(timer)
    timers.delete(requestId)
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
      const waiting = awaitingByAgent.get(agentId)
      return Boolean(waiting && reachesSource(waiting.to))
    }
    return reachesSource(to)
  }

  function requireAgent(id) {
    const agent = agents.get(String(id))
    if (!agent) throw teamError('RP_TEAM_AGENT_NOT_FOUND', `Unknown agent ${id}`)
    return agent
  }

  return {
    send, request, messagesFor, allMessages, targetsFor,
    bindTargetExecution, completeTarget, failTarget, activationFinished, cancelAll,
    getRequest: requestId => requests.get(requestId), pendingRequests: () => requests.pending()
  }
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
    const first = issues[0]
    throw teamError(`RP_TEAM_HANDOFF_${label.toUpperCase()}_INVALID`, `Handoff ${label} ${first.path || '/'} ${first.message}`)
  }
}

const MISSING = Symbol('missing')
function parsePointer(pointer) {
  if (pointer === '') return null
  if (typeof pointer !== 'string' || !pointer.startsWith('/')) throw teamError('RP_TEAM_HANDOFF_SELECTOR_INVALID', 'Handoff selectors must be JSON Pointer paths')
  return pointer.slice(1).split('/').map(segment => {
    if (/~(?:[^01]|$)/u.test(segment)) throw teamError('RP_TEAM_HANDOFF_SELECTOR_INVALID', `Invalid JSON Pointer escape in ${pointer}`)
    return segment.replace(/~1/g, '/').replace(/~0/g, '~')
  })
}

function readPath(value, segments) {
  let current = value
  for (const segment of segments) {
    if (Array.isArray(current) && /^(?:0|[1-9]\d*)$/u.test(segment)) current = current[Number(segment)]
    else if (current && typeof current === 'object' && Object.hasOwn(current, segment)) current = current[segment]
    else return MISSING
  }
  return current
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
  const issue = request?.error
  return teamError(issue?.code ?? String(error?.code ?? 'RP_TEAM_HANDOFF_FAILED'), issue?.message ?? String(error?.message ?? error))
}

function allows(configured, value) {
  return configured instanceof Set
    ? configured.has('*') || configured.has(value)
    : configured.includes('*') || configured.includes(value)
}
