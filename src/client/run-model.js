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
