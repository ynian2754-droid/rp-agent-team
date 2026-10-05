import { teamError } from '../shared/schema.mjs'

const FINISHED = new Set(['complete', 'failed', 'skipped'])

/** Runs one bounded schedule; each logical agent may have revisions, never overlapping activations. */
export function createScheduler({
  config, manualAgentIds = [], forceAgentIds = [], skipAgentIds = [], evaluateCondition = () => false, readState = async () => ({}),
  onActivate, onTrace = () => {}, onStop = () => {}, onActivationTerminal = async () => {},
  triggerTracker, initialStateChanges = [], canReceiveMessage, onTriggerStarted = async () => {}, signal
}) {
  const agents = new Map(config.agents.map(agent => [agent.id, agent]))
  const { concurrency, maxActivations, maxPerAgent, maxDepth } = config.execution
  const manual = new Set(manualAgentIds)
  const states = new Map(config.agents.map(agent => [agent.id, {
    agentId: agent.id, status: 'pending', activations: 0, running: false, completed: 0, error: null
  }]))
  const queue = []
  const active = new Map()
  const slotsByAgent = new Map()
  const reacquireQueue = []
  const resumeReservations = new Map()
  const firedConditions = new Set()
  const initialQueued = new Set()
  let activationCount = 0
  let reservedCount = 0
  let stopped = false
  let runningLoop
  let wakePromise
  let resolveWake

  const trace = (type, agentId, data = {}) => onTrace({ type, agentId, data })
  const skip = async (state, reason, activation) => {
    state.status = 'skipped'
    trace('activation.skipped', state.agentId, {
      reason, dependencies: agents.get(state.agentId).execution.after,
      ...(activation?.requestId ? { requestId: activation.requestId } : {})
    })
    if (activation) await onActivationTerminal({
      agent: agents.get(state.agentId), activation, status: 'skipped', error: teamError('RP_TEAM_ACTIVATION_SKIPPED', `Activation skipped: ${reason}`)
    })
  }

  function wake() {
    resolveWake?.()
    resolveWake = undefined
    wakePromise = undefined
  }

  function waitForWake() {
    if (!wakePromise) wakePromise = new Promise(resolve => { resolveWake = resolve })
    return wakePromise
  }

  function assertCapacity(agentId, amount = 1) {
    const state = states.get(agentId)
    if (!state) throw teamError('RP_TEAM_AGENT_NOT_FOUND', `Unknown agent ${agentId}`)
    const queued = queue.filter(item => item.agentId === agentId).length
    const reserved = [...resumeReservations.values()].filter(item => item.agentId === agentId).length
    if (state.activations + queued + reserved + amount > maxPerAgent) {
      trace('activation.blocked', agentId, { reason: 'member_limit', limit: maxPerAgent })
      throw teamError('RP_TEAM_AGENT_ACTIVATION_LIMIT', `Agent ${agentId} reached its ${maxPerAgent}-activation limit`)
    }
    if (activationCount + queue.length + reservedCount + amount > maxActivations) {
      trace('activation.blocked', agentId, { reason: 'run_limit', limit: maxActivations })
      throw teamError('RP_TEAM_ACTIVATION_LIMIT', `Run reached its ${maxActivations}-activation limit`)
    }
  }

  function enqueue(agentId, reason, depth = 0, requestedBy, metadata = {}) {
    const agent = agents.get(agentId)
    if (!agent) throw teamError('RP_TEAM_AGENT_NOT_FOUND', `Unknown agent ${agentId}`)
    if (!Number.isSafeInteger(depth) || depth < 0 || depth > maxDepth) {
      trace('activation.blocked', agentId, { reason: 'depth_limit', depth, limit: maxDepth, ...metadata })
      throw teamError('RP_TEAM_ACTIVATION_DEPTH', `Agent activation depth must be between 0 and ${maxDepth}`)
    }
    assertCapacity(agentId)
    return enqueueReserved(agentId, reason, depth, requestedBy, metadata)
  }

  function enqueueReserved(agentId, reason, depth = 0, requestedBy, metadata = {}) {
    const state = states.get(agentId)
    const activation = {
      agentId, reason, depth, requestedBy, queuedAt: new Date().toISOString(), ...metadata
    }
    queue.push(activation)
    state.status = state.running ? 'running' : 'queued'
    trace('activation.queued', agentId, {
      reason, depth, ...(requestedBy ? { requestedBy } : {}),
      ...(activation.requestId ? { requestId: activation.requestId } : {}),
      ...(activation.resumeFromRequestId ? { resumeFromRequestId: activation.resumeFromRequestId } : {})
    })
    wake()
    return { queued: true, agentId, depth, requestId: activation.requestId }
  }

  function mergeInitialReason(agentId, reason) {
    if (initialQueued.has(agentId)) {
      const queued = queue.find(item => item.agentId === agentId && item.reason?.type === 'initial')
      if (queued) {
        mergeReason(queued, reason)
        return true
      }
      return false
    }
    initialQueued.add(agentId)
    enqueue(agentId, { type: 'initial', triggers: reason.triggers }, 0, undefined, {
      triggerMatches: [...(reason.triggerMatches ?? [])]
    })
    return true
  }

  function mergeReason(activation, reason) {
    const triggers = [...new Set([...(activation.reason?.triggers ?? []), ...(reason.triggers ?? [])])]
    activation.reason = { ...(activation.reason ?? {}), ...(!activation.reason?.type && reason.type ? { type: reason.type } : {}), triggers }
    const known = new Set((activation.triggerMatches ?? []).map(item => item.triggerId))
    const added = (reason.triggerMatches ?? []).filter(item => !known.has(item.triggerId))
    if (added.length) activation.triggerMatches = [...(activation.triggerMatches ?? []), ...added]
    return added
  }

  async function markTriggerStart(activation, matches) {
    if (matches?.length) await onTriggerStarted({ activation, matches })
  }

  function triggerReason(matches, fallback) {
    return [...new Set([...(fallback ?? []), ...(matches ?? []).map(match => match.triggerType)])]
  }

  async function evaluateConditions() {
    const matched = new Map()
    for (const agent of config.agents) {
      const pending = agent.triggers.flatMap((trigger, index) =>
        trigger.type === 'condition' && !firedConditions.has(`${agent.id}:${index}`) ? [{ trigger, index }] : [])
      if (!pending.length) continue
      const projected = await readState(agent.id)
      for (const { trigger, index } of pending) {
        if (!await evaluateCondition(projected, trigger.condition, agent.id)) continue
        const triggerMatches = triggerTracker
          ? [triggerTracker.matchTrigger(agent.id, trigger, index)].filter(Boolean)
          : []
        if (triggerTracker && triggerMatches.length === 0) continue
        firedConditions.add(`${agent.id}:${index}`)
        const reason = matched.get(agent.id) ?? { triggers: [], triggerMatches: [] }
        reason.triggers.push(`condition:${index}`)
        reason.triggerMatches.push(...triggerMatches)
        matched.set(agent.id, reason)
      }
    }
    for (const [agentId, reason] of matched) {
      const state = states.get(agentId)
      if (state.activations === 0 && (!state.status || state.status === 'pending' || state.status === 'queued')) {
        mergeInitialReason(agentId, reason)
      } else {
        enqueue(agentId, { type: 'condition', triggers: reason.triggers }, 0, undefined, {
          triggerMatches: reason.triggerMatches
        })
      }
    }
  }

  async function seed() {
    for (const agent of config.agents) {
      if (skipAgentIds.includes(agent.id) && !forceAgentIds.includes(agent.id)) {
        states.get(agent.id).status = 'complete'
        continue
      }
      const triggers = []
      const triggerMatches = []
      if (triggerTracker) {
        const alwaysMatches = triggerTracker.configured(agent.id, 'always')
        if (alwaysMatches.length) { triggers.push('always'); triggerMatches.push(...alwaysMatches) }
        if (manual.has(agent.id)) {
          const manualMatches = triggerTracker.configured(agent.id, 'manual')
          if (manualMatches.length) { triggers.push('manual'); triggerMatches.push(...manualMatches) }
        }
      } else {
        if (agent.triggers.some(trigger => trigger.type === 'always')) triggers.push('always')
        if (manual.has(agent.id) && agent.triggers.some(trigger => trigger.type === 'manual')) triggers.push('manual')
      }
      if (forceAgentIds.includes(agent.id)) triggers.push('retry')
      if (triggers.length) mergeInitialReason(agent.id, { triggers, triggerMatches })
    }
    if (triggerTracker) {
      const matched = new Map()
      const initialMatches = [
        ...triggerTracker.matchInput(),
        ...triggerTracker.matchStateChanges(initialStateChanges)
      ]
      for (const value of initialMatches) {
        const reason = matched.get(value.agentId) ?? { triggers: [], triggerMatches: [] }
        reason.triggers.push(value.triggerType)
        reason.triggerMatches.push(value)
        matched.set(value.agentId, reason)
      }
      for (const [agentId, reason] of matched) mergeInitialReason(agentId, reason)
    }
    await evaluateConditions()
  }

  async function notify({ stateChanges = [] } = {}) {
    if (stopped || signal?.aborted) return getStatus()
    if (triggerTracker && stateChanges.length) await enqueueTriggerMatches(triggerTracker.matchStateChanges(stateChanges), 'state_changed')
    await evaluateConditions()
    wake()
    return getStatus()
  }

  async function notifyMessage(message) {
    if (!triggerTracker || stopped || signal?.aborted) return getStatus()
    await enqueueTriggerMatches(triggerTracker.matchMessage(message, canReceiveMessage), message?.type ?? 'message')
    wake()
    return getStatus()
  }

  async function enqueueTriggerMatches(matches, reasonType) {
    const grouped = new Map()
    for (const match of matches ?? []) {
      const values = grouped.get(match.agentId) ?? []
      values.push(match)
      grouped.set(match.agentId, values)
    }
    for (const [agentId, triggerMatches] of grouped) {
      const reason = { type: reasonType, triggers: triggerReason(triggerMatches), triggerMatches }
      const activeActivation = slotsByAgent.get(agentId)?.activation
      const queuedActivation = queue.find(item => item.agentId === agentId)
      if (activeActivation) {
        const added = mergeReason(activeActivation, reason)
        await markTriggerStart(activeActivation, added)
      } else if (queuedActivation) {
        mergeReason(queuedActivation, reason)
      } else {
        const reservation = [...resumeReservations.values()].find(item => item.agentId === agentId)
        if (reservation) {
          const placeholder = { reason: {}, triggerMatches: reservation.triggerMatches ?? [] }
          mergeReason(placeholder, reason)
          reservation.triggerMatches = placeholder.triggerMatches
          reservation.triggerReasons = placeholder.reason.triggers
        } else {
          enqueue(agentId, reason, 0, undefined, { triggerMatches: [...triggerMatches] })
        }
      }
    }
  }

  function dependenciesSettled(agent) {
    return agent.execution.after.every(id => FINISHED.has(states.get(id)?.status))
  }

  function grantReacquireWaiters() {
    while (active.size < concurrency && reacquireQueue.length) {
      const waiter = reacquireQueue.shift()
      const { slot } = waiter
      if (signal?.aborted) {
        waiter.reject(teamError('RP_TEAM_CANCELLED', String(signal.reason ?? 'Run cancelled')))
        continue
      }
      if (slot.held) {
        waiter.resolve()
        continue
      }
      slot.held = true
      active.set(slot.key, slot.task)
      trace('activation.slot_reacquired', slot.agentId, {
        ...(waiter.requestId ? { requestId: waiter.requestId } : {}), activation: slot.activationNo
      })
      waiter.resolve()
    }
  }

  function makeSlot(agent, activation, activationNo) {
    const slot = { key: Symbol(agent.id), agentId: agent.id, activationNo, task: undefined, held: false }
    slotsByAgent.set(agent.id, slot)
    slot.release = requestId => {
      if (!slot.held) return
      active.delete(slot.key)
      slot.held = false
      trace('activation.slot_released', agent.id, { activation: activationNo, ...(requestId ? { requestId } : {}) })
      wake()
    }
    slot.acquire = requestId => {
      if (slot.held) return Promise.resolve()
      if (signal?.aborted) return Promise.reject(teamError('RP_TEAM_CANCELLED', String(signal.reason ?? 'Run cancelled')))
      return new Promise((resolve, reject) => {
        const waiter = { slot, requestId, resolve: () => { cleanup(); resolve() }, reject: error => { cleanup(); reject(error) } }
        const onAbort = () => {
          const index = reacquireQueue.indexOf(waiter)
          if (index >= 0) reacquireQueue.splice(index, 1)
          waiter.reject(teamError('RP_TEAM_CANCELLED', String(signal.reason ?? 'Run cancelled')))
        }
        const cleanup = () => signal?.removeEventListener('abort', onAbort)
        signal?.addEventListener('abort', onAbort, { once: true })
        reacquireQueue.push(waiter)
        wake()
      })
    }
    return slot
  }

  async function waitForHandoff({ agentId, requestId, promise }) {
    const slot = slotsByAgent.get(agentId)
    if (!slot || !slot.held) throw teamError('RP_TEAM_HANDOFF_EXECUTION_INACTIVE', `Agent ${agentId} has no active scheduler slot to release`)
    slot.release(requestId)
    try {
      const result = await promise
      if (!signal?.aborted) await slot.acquire(requestId)
      return result
    } catch (error) {
      if (!signal?.aborted) await slot.acquire(requestId)
      throw error
    }
  }

  async function runOne(activation, slot) {
    const agent = agents.get(activation.agentId)
    const state = states.get(agent.id)
    state.running = true
    state.status = 'running'
    state.activations += 1
    activationCount += 1
    trace('activation.started', agent.id, {
      reason: activation.reason, depth: activation.depth, activation: state.activations,
      parallel: active.size, model: agent.modelRef === 'inherit' ? undefined : agent.modelRef,
      ...(activation.requestId ? { requestId: activation.requestId } : {}),
      ...(activation.resumeFromRequestId ? { resumeFromRequestId: activation.resumeFromRequestId } : {})
    })
    let terminalStatus = 'complete'
    let failure
    try {
      await markTriggerStart(activation, activation.triggerMatches ?? [])
      await onActivate({ agent, activation, activationNo: state.activations, signal, waitForHandoff })
      await onActivationTerminal({ agent, activation, status: 'complete' })
      state.completed += 1
      state.status = 'complete'
      trace('activation.completed', agent.id, {
        activation: state.activations, parallel: active.size,
        ...(activation.requestId ? { requestId: activation.requestId } : {})
      })
    } catch (error) {
      terminalStatus = signal?.aborted ? 'cancelled' : 'failed'
      failure = error
      state.error = String(error?.message ?? error)
      state.status = terminalStatus
      trace('activation.failed', agent.id, {
        activation: state.activations, parallel: active.size, error: state.error,
        ...(activation.requestId ? { requestId: activation.requestId } : {})
      })
      try { await onActivationTerminal({ agent, activation, status: terminalStatus, error }) }
      catch (terminalError) { state.error = `${state.error}; terminal handling: ${String(terminalError?.message ?? terminalError)}` }
      if (agent.execution.onFailure === 'stop' || config.output.agentId === agent.id) {
        stopped = true
        await onStop(failure, agent)
      }
    } finally {
      state.running = false
      if (state.status === 'running') state.status = 'complete'
      if (slot.held) {
        active.delete(slot.key)
        slot.held = false
      }
      if (slotsByAgent.get(agent.id) === slot) slotsByAgent.delete(agent.id)
      await notify()
    }
    return terminalStatus
  }

  function requestActivation({ from, to, depth = 0, reason = 'requested', requestId, fromExecutionId, reserveResume = false, reuseTarget = false, message }) {
    const agent = agents.get(to)
    if (!agent) throw teamError('RP_TEAM_AGENT_NOT_FOUND', `Unknown agent ${to}`)
    const requestTriggers = agent.triggers.filter(item => item.type === 'requested_by_agent')
    if (!requestTriggers.length) throw teamError('RP_TEAM_AGENT_NOT_REQUESTABLE', `Agent ${to} does not accept requested activations`)
    const allowedRequestTriggers = requestTriggers.filter(trigger => !trigger.from?.length || allows(trigger.from, from))
    if (!allowedRequestTriggers.length) throw teamError('RP_TEAM_REQUEST_NOT_ALLOWED', `Agent ${from} is not allowed to request ${to}`)
    const requestMatches = triggerTracker
      ? triggerTracker.configured(to, 'requested_by_agent', trigger => !trigger.from?.length || allows(trigger.from, from), { dedupe: false })
      : []
    if (triggerTracker && !requestMatches.length) throw teamError('RP_TEAM_TRIGGER_COOLDOWN', `Agent ${to} request trigger is cooling down`)
    if (!Number.isSafeInteger(depth) || depth < 0 || depth + 1 > maxDepth) {
      trace('activation.blocked', to, { reason: 'depth_limit', depth: depth + 1, limit: maxDepth, requestId })
      throw teamError('RP_TEAM_ACTIVATION_DEPTH', `Agent activation depth must be between 0 and ${maxDepth}`)
    }
    const resumeAgent = reserveResume ? agents.get(from) : undefined
    if (reserveResume && !resumeAgent) throw teamError('RP_TEAM_AGENT_NOT_FOUND', `Unknown resume agent ${from}`)
    const activationAmount = reserveResume ? reuseTarget ? 1 : 2 : reuseTarget ? 0 : 1
    if (!reuseTarget) assertCapacity(to)
    if (reserveResume) assertCapacity(from, 1)
    if (activationCount + queue.length + reservedCount + activationAmount > maxActivations) {
      trace('activation.blocked', to, { reason: 'run_limit', limit: maxActivations, requestId })
      throw teamError('RP_TEAM_ACTIVATION_LIMIT', `Run reached its ${maxActivations}-activation limit`)
    }
    const messageMatches = triggerTracker && message && !reuseTarget
      ? triggerTracker.matchMessage(message, canReceiveMessage)
      : []
    const triggerMatches = [...requestMatches, ...messageMatches]
    const queued = reuseTarget ? { queued: false, reused: true, agentId: to, requestId }
      : enqueueReserved(to, {
        type: 'requested_by_agent', detail: reason,
        ...(triggerMatches.length ? { triggers: triggerReason(triggerMatches) } : {})
      }, depth + 1, from, {
        ...(requestId ? { requestId } : {}), ...(fromExecutionId ? { requestedByExecutionId: fromExecutionId } : {}),
        triggerMatches
      })
    if (reserveResume) {
      const reserved = {
        agentId: from, depth, requestedBy: to, requestId,
        fromExecutionId, sourceDone: false, targetDone: reuseTarget, failed: false
      }
      resumeReservations.set(requestId, reserved)
      reservedCount += 1
      trace('activation.reserved', from, { reason: 'handoff_resume', requestId, requestedBy: to })
    }
    return { ...queued, requestId }
  }

  function settleResumeReservation(requestId, side, succeeded = true) {
    const reservation = resumeReservations.get(requestId)
    if (!reservation) return false
    const doneField = side === 'source' ? 'sourceDone' : side === 'target' ? 'targetDone' : undefined
    if (!doneField) throw new TypeError(`Unknown resume reservation side ${side}`)
    if (!succeeded) reservation.failed = true
    reservation[doneField] = true
    if (!reservation.sourceDone || !reservation.targetDone) return false
    resumeReservations.delete(requestId)
    reservedCount -= 1
    if (reservation.failed) {
      trace('activation.reservation_released', reservation.agentId, { requestId, reason: 'handoff_failed' })
      wake()
      return false
    }
    const status = states.get(reservation.agentId)
    const activation = {
      agentId: reservation.agentId, depth: reservation.depth,
      requestedBy: reservation.requestedBy, requestId, resumeFromRequestId: requestId,
      queuedAt: new Date().toISOString(), triggerMatches: [...(reservation.triggerMatches ?? [])],
      reason: { type: 'handoff_resume', ...(reservation.triggerReasons?.length ? { triggers: [...reservation.triggerReasons] } : {}) }
    }
    queue.push(activation)
    status.status = status.running ? 'running' : 'queued'
    trace('activation.queued', reservation.agentId, {
      reason: activation.reason, depth: activation.depth, requestedBy: activation.requestedBy,
      requestId, resumeFromRequestId: requestId
    })
    wake()
    return true
  }

  function releaseResumeReservation(requestId) {
    const reservation = resumeReservations.get(requestId)
    if (!reservation) return false
    resumeReservations.delete(requestId)
    reservedCount -= 1
    trace('activation.reservation_released', reservation.agentId, { requestId, reason: 'request_failed' })
    wake()
    return true
  }

  async function stop(error, agentId) {
    stopped = true
    const agent = agents.get(agentId)
    await onStop(error, agent)
    wake()
  }

  async function cancelRequestActivation(requestId, error) {
    const index = queue.findIndex(item => item.requestId === String(requestId))
    if (index < 0) return false
    const [activation] = queue.splice(index, 1)
    const state = states.get(activation.agentId)
    state.status = state.running ? 'running'
      : queue.some(item => item.agentId === activation.agentId) ? 'queued' : 'pending'
    const failure = error ?? teamError('RP_TEAM_HANDOFF_TIMEOUT', `Handoff ${requestId} expired before activation`)
    trace('activation.cancelled', activation.agentId, { requestId: String(requestId), reason: String(failure?.message ?? failure) })
    await onActivationTerminal({ agent: agents.get(activation.agentId), activation, status: 'cancelled', error: failure })
    wake()
    return true
  }

  async function run() {
    if (runningLoop) return await runningLoop
    runningLoop = (async () => {
      await seed()
      while (!signal?.aborted) {
        grantReacquireWaiters()
        if (stopped) {
          for (const pending of queue.splice(0)) await skip(states.get(pending.agentId), 'aborted_by_failure', pending)
          for (const requestId of [...resumeReservations.keys()]) releaseResumeReservation(requestId)
        }
        const queuedAgents = new Set(queue.map(item => item.agentId))
        for (const state of states.values()) {
          if (state.status === 'pending' && !state.running && !queuedAgents.has(state.agentId)) skip(state, 'not_triggered')
        }
        let index = 0
        while (index < queue.length && active.size < concurrency && !stopped) {
          const activation = queue[index]
          const state = states.get(activation.agentId)
          const agent = agents.get(activation.agentId)
          if (state.running || !dependenciesSettled(agent)) { index += 1; continue }
          queue.splice(index, 1)
          if (activationCount >= maxActivations) {
            await skip(state, 'run_limit', activation)
            continue
          }
          const slot = makeSlot(agent, activation, state.activations + 1)
          slot.activation = activation
          slot.held = true
          const task = runOne(activation, slot)
          slot.task = task
          if (slot.held) active.set(slot.key, task)
        }
        if (active.size) {
          await Promise.race([...active.values(), waitForWake()])
          continue
        }
        if (queue.length) {
          const blocked = queue.splice(0)
          for (const activation of blocked) {
            const state = states.get(activation.agentId)
            if (!state.running && state.status === 'queued') await skip(state, 'dependency_blocked', activation)
          }
          continue
        }
        if (reacquireQueue.length) {
          await waitForWake()
          continue
        }
        const suspended = [...slotsByAgent.values()].some(slot => !slot.held)
        if (suspended) {
          await waitForWake()
          continue
        }
        for (const state of states.values()) if (state.status === 'pending') await skip(state, 'not_triggered')
        break
      }
      if (signal?.aborted) {
        for (const requestId of [...resumeReservations.keys()]) releaseResumeReservation(requestId)
        for (const waiter of reacquireQueue.splice(0)) waiter.reject(teamError('RP_TEAM_CANCELLED', String(signal.reason ?? 'Run cancelled')))
        await Promise.allSettled([...active.values(), ...[...slotsByAgent.values()].map(slot => slot.task).filter(Boolean)])
        throw teamError('RP_TEAM_CANCELLED', String(signal.reason ?? 'Run cancelled'))
      }
      return getStatus()
    })()
    try { return await runningLoop } finally { runningLoop = undefined }
  }

  function getStatus() {
    return {
      activationCount, active: active.size, reserved: reservedCount, stopped,
      agents: Object.fromEntries([...states].map(([id, state]) => [id, { ...state }])),
      pending: queue.map(item => ({ ...item }))
    }
  }

  return {
    run, notify, notifyMessage, requestActivation, getStatus, waitForHandoff, settleResumeReservation,
    releaseResumeReservation, cancelRequestActivation, stop
  }
}

function allows(configured, value) { return configured.includes('*') || configured.includes(value) }
