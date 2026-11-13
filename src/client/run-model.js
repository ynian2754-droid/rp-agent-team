export const ACTIVE_PHASES = new Set(['preparing', 'working', 'composing', 'publishing', 'awaiting_commit'])
export const TERMINAL_PHASES = new Set(['complete', 'failed', 'cancelled'])
const FINISHED_MEMBER = new Set(['complete', 'completed', 'failed', 'cancelled', 'skipped'])

export function isActivePhase(phase) {
  return ACTIVE_PHASES.has(phase)
}

export function runMembers(run) {
  return Array.isArray(run?.members) ? run.members : Object.values(run?.members || {})
}

export function findMessageRun(runs, productMessageId, messageId) {
  return runs.find(run => run && (
    (productMessageId && run.productMessageId === productMessageId) ||
    (messageId && run.assistantMessageId === messageId)
  ))
}

/** awaiting_commit is still running: the reply exists but its persistence is unconfirmed. */
export function phaseTone(phase) {
  if (phase === 'awaiting_commit') return 'pending'
  if (ACTIVE_PHASES.has(phase)) return 'active'
  if (phase === 'complete') return 'done'
  if (phase === 'failed') return 'failed'
  if (phase === 'cancelled') return 'cancelled'
  return 'idle'
}

export function memberProgress(run) {
  const started = runMembers(run).filter(member => member.status && member.status !== 'pending')
  if (!started.length) return null
  return { done: started.filter(member => FINISHED_MEMBER.has(member.status)).length, total: started.length }
}

/** What the composer may show. Disabled teams only surface a run that is still active. */
export function composerStatus(snapshot) {
  const run = snapshot?.status?.run
  if (!run) return snapshot?.statusState === 'error' ? { tone: 'unavailable' } : null
  const active = isActivePhase(run.phase)
  if (!snapshot.enabled && !active) return null
  return { tone: phaseTone(run.phase), phase: run.phase, runId: run.runId, progress: run.phase === 'working' ? memberProgress(run) : null }
}

export function runHistory(liveRun, traces = []) {
  const list = traces.filter(Boolean).map(item => item.runId === liveRun?.runId ? { ...item, ...liveRun } : item)
  if (liveRun && !list.some(item => item.runId === liveRun.runId)) list.push(liveRun)
  return list.sort((left, right) => String(right.startedAt || right.createdAt || '').localeCompare(String(left.startedAt || left.createdAt || '')))
}

export function selectRunId(requestedRunId, currentRunId, liveRun, history) {
  if (requestedRunId) return requestedRunId
  if (currentRunId && history.some(item => item.runId === currentRunId)) return currentRunId
  return liveRun?.runId || history[0]?.runId || ''
}

/** Retry rewinds the conversation to the run's input, so only the latest run may offer it. */
export function canRetry(run, liveRun) {
  return Boolean(run && liveRun && run.runId === liveRun.runId && liveRun.retryAvailable === true)
}

export function retryTargets(run) {
  return runMembers(run).filter(member => member.status === 'failed' || member.status === 'cancelled')
}

const TOKEN_KEYS = [['inputTokens', 'input'], ['outputTokens', 'output'], ['totalTokens', 'total'], ['cacheReadTokens', 'cacheRead'], ['cacheWriteTokens', 'cacheWrite'], ['uncachedInputTokens', 'uncachedInput']]

/** Only provider-reported numbers; absent values stay absent. */
export function tokenParts(tokens) {
  if (!tokens || typeof tokens !== 'object') return []
  return TOKEN_KEYS.filter(([key]) => Number.isFinite(tokens[key])).map(([key, label]) => ({ key: label, value: tokens[key] }))
}

export function memberModel(member) {
  if (typeof member?.model === 'string') return member.model
  if (!member?.model?.model) return ''
  return member.model.provider ? `${member.model.provider} / ${member.model.model}` : member.model.model
}

export function eventCategory(type = '') {
  const prefix = type.split('.')[0]
  if (prefix === 'activation' || prefix === 'model') return 'activation'
  if (prefix === 'message') return 'message'
  if (prefix === 'context') return 'context'
  if (prefix === 'state') return 'state'
  if (prefix === 'draft' || prefix === 'output') return 'draft'
  if (prefix === 'publication' || prefix === 'run') return 'publication'
  return 'other'
}

export const EVENT_CATEGORIES = ['activation', 'message', 'context', 'state', 'draft', 'publication', 'other']

/** Turns recorded trace data into labelled rows without inventing missing values. */
export function eventFields(event, { nameOf = id => id, sourceLabel = type => type } = {}) {
  const fields = []
  const names = value => (Array.isArray(value) ? value : [value]).map(item => item === '*' ? '*' : nameOf(String(item))).join(', ')
  for (const [key, value] of Object.entries(event?.data || {})) {
    if (value === undefined || value === null || value === '') continue
    if (key === 'reason' && typeof value === 'object') {
      fields.push({ key, value: [value.type, value.detail].filter(Boolean).join(': ') || JSON.stringify(value) })
    } else if (['from', 'to', 'requestedBy'].includes(key)) {
      fields.push({ key, value: names(value) })
    } else if (key === 'categories' && Array.isArray(value)) {
      fields.push({ key, value: value.length ? value.map(sourceLabel).join(', ') : '' })
    } else if (key === 'model' && typeof value === 'object') {
      fields.push({ key, value: [value.provider, value.model].filter(Boolean).join(' / ') })
    } else if (key === 'tokens' && typeof value === 'object') {
      fields.push({ key, parts: tokenParts(value) })
    } else if (typeof value === 'object') {
      fields.push({ key, value: JSON.stringify(value, null, 2), code: true })
    } else {
      fields.push({ key, value: String(value), long: key === 'body' || key === 'error' })
    }
  }
  return fields
}

const RAN_STATUSES = new Set(['running', 'complete', 'completed', 'failed', 'cancelled'])

/** Members that were actually activated in a round, as opposed to everyone on the team. */
export function participants(run) {
  return runMembers(run).filter(member => RAN_STATUSES.has(member.status))
}

/** The member a live round is waiting on right now, if any. */
export function activeMember(run) {
  return runMembers(run).find(member => member.status === 'running') || runMembers(run).find(member => member.status === 'queued') || null
}

/**
 * Why a member that never started stayed out of a round, read from its configured triggers.
 * Codes are translated by the page; they describe the rule, not a recorded event.
 */
export function idleReasons(agent) {
  const triggers = agent?.triggers || []
  if (!triggers.length) return [{ code: 'noTrigger' }]
  const reasons = []
  const add = reason => { if (!reasons.some(item => item.code === reason.code)) reasons.push(reason) }
  for (const trigger of triggers) {
    if (trigger.type === 'always') add({ code: 'notReached' })
    else if (trigger.type === 'requested_by_agent') add({ code: 'onRequest', from: trigger.from || [] })
    else if (trigger.type === 'periodic') add({ code: 'periodic', every: trigger.every })
    else if (trigger.type === 'manual') add({ code: 'manual' })
    else if (trigger.type === 'condition') add({ code: 'condition' })
    else if (trigger.type === 'keyword') add({ code: 'keyword' })
    else if (trigger.type === 'state_changed') add({ code: 'stateChanged' })
    else if (trigger.type === 'message_received') add({ code: 'messageReceived' })
  }
  return reasons
}

/** How an activated member entered the round: one of its own triggers, or another member's request. */
export function activationCause(events = [], agentId) {
  const event = events.find(item => item.agentId === agentId && (item.type === 'activation.queued' || item.type === 'activation.started'))
  if (!event) return null
  const data = event.data || {}
  if (data.requestedBy) return { type: 'request', by: String(data.requestedBy) }
  const reason = data.reason
  if (reason && typeof reason === 'object') {
    if (reason.type === 'handoff_resume') return { type: 'resume' }
    const triggers = Array.isArray(reason.triggers) ? reason.triggers.map(item => typeof item === 'string' ? item : item?.type).filter(Boolean) : []
    if (triggers.length) return { type: 'trigger', triggers: [...new Set(triggers)] }
    if (reason.type && reason.type !== 'initial') return { type: 'trigger', triggers: [reason.type] }
  }
  return { type: 'trigger', triggers: [] }
}

/** What a member did besides answering: who it asked or told, and what it wrote. Counts only recorded events. */
export function memberActivity(events = [], agentId) {
  const activity = { requests: 0, asked: [], told: [], writes: 0, failures: [] }
  const push = (list, id) => { if (id && !list.includes(id)) list.push(id) }
  for (const event of events) {
    if (event.agentId !== agentId) continue
    const data = event.data || {}
    if (event.type === 'model.usage') activity.requests++
    else if (event.type === 'message.requested' || event.type === 'handoff.request_queued') push(activity.asked, data.to)
    else if (event.type === 'message.sent') for (const id of Array.isArray(data.to) ? data.to : [data.to]) push(activity.told, id)
    else if (event.type === 'state.operation' && ['write', 'set', 'remove'].includes(data.operation)) activity.writes++
    else if (event.type === 'activation.blocked') activity.failures.push(String(data.reason || 'blocked'))
  }
  return activity
}

/** Sums only numbers a provider reported. `known` is false when any activated member is missing usage. */
export function runTotals(run, events = []) {
  const ran = participants(run)
  let tokens = 0
  let known = ran.length > 0
  for (const member of ran) {
    const total = member.tokens?.totalTokens ?? ((member.tokens?.inputTokens ?? NaN) + (member.tokens?.outputTokens ?? NaN))
    if (Number.isFinite(total)) tokens += total
    else if (member.status !== 'running' && !member.reusedFromRunId) known = false
  }
  const requests = events.filter(event => event.type === 'model.usage').length
  const started = Date.parse(run?.startedAt || run?.createdAt || '')
  const ended = Date.parse(run?.updatedAt || '')
  return {
    tokens, tokensKnown: known, requests,
    elapsedMs: Number.isFinite(started) && Number.isFinite(ended) && ended >= started ? ended - started : null
  }
}

/** 1234 -> "1.2k"; small numbers stay exact so short runs are not rounded away. */
export function compactNumber(value) {
  if (!Number.isFinite(value)) return ''
  if (value < 1000) return String(value)
  if (value < 10000) return `${(value / 1000).toFixed(1).replace(/\.0$/, '')}k`
  return `${Math.round(value / 1000)}k`
}

export function formatElapsed(ms) {
  if (!Number.isFinite(ms)) return ''
  if (ms < 1000) return `${ms}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)}s`
  return `${Math.floor(ms / 60000)}m${String(Math.round((ms % 60000) / 1000)).padStart(2, '0')}s`
}
