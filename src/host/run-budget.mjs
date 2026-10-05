import { teamError } from '../shared/schema.mjs'

export const ORIGINAL_LLM_REQUEST = Symbol.for('eleckoi.llm.originalRequest')

/** Resolve Host-only llm/stream reroutes to their original logical request. */
export function requestOrigin(options) {
  const origin = options?.[ORIGINAL_LLM_REQUEST]
  return isObjectLike(origin) ? origin : options
}

function isObjectLike(value) {
  return value !== null && (typeof value === 'object' || typeof value === 'function')
}

/** Synchronous, run-local accounting for provider calls owned by a Team run. */
export function createRunBudget({ runId, limits = {}, startedAt = Date.now(), now = Date.now, onExhaust = () => {} } = {}) {
  const activeLimits = Object.fromEntries(['maxRequests', 'maxReportedTokens', 'maxElapsedMs']
    .filter(key => Number.isSafeInteger(limits[key]) && limits[key] > 0)
    .map(key => [key, limits[key]]))
  const inflight = new Map()
  const usageIdentities = new Map()
  let requestCount = 0
  let reportedTokens = 0
  let unreportedFinished = false
  let requestSequence = 0
  let failure
  let closed = false

  function exhaust(kind, limit, observed, message) {
    if (failure) return failure
    failure = teamError(kind === 'usage_unavailable' ? 'RP_TEAM_BUDGET_USAGE_UNAVAILABLE' : 'RP_TEAM_BUDGET_EXCEEDED', message)
    failure.budget = { kind, limit, observed }
    onExhaust(failure, { kind, limit, observed })
    return failure
  }

  function checkElapsed() {
    const limit = activeLimits.maxElapsedMs
    if (limit === undefined) return undefined
    const elapsed = Math.max(0, now() - startedAt)
    if (elapsed < limit) return undefined
    return exhaust('maxElapsedMs', limit, elapsed, `RP Team elapsed-time budget exceeded (${elapsed} ms of ${limit} ms)`)
  }

  function reserve(context = {}) {
    if (failure) return { allowed: false, error: failure }
    if (closed) return { allowed: false, error: teamError('RP_TEAM_RUN_NOT_ACTIVE', 'RP Team run no longer accepts model requests') }
    const elapsedFailure = checkElapsed()
    if (elapsedFailure) return { allowed: false, error: elapsedFailure }
    const requestLimit = activeLimits.maxRequests
    if (requestLimit !== undefined && requestCount >= requestLimit) {
      const error = exhaust('maxRequests', requestLimit, requestCount + 1,
        `RP Team model-request budget exceeded (${requestCount + 1} requests of ${requestLimit})`)
      return { allowed: false, error }
    }
    requestCount += 1
    requestSequence += 1
    const invocationId = `${String(runId ?? 'run')}:llm:${requestSequence}`
    const requestIdentity = context.requestId === undefined
      ? stableIdentity([context.sessionId, context.turn, context.step, context.purpose, requestSequence])
      : String(context.requestId)
    inflight.set(invocationId, { requestIdentity, usage: undefined })
    return { allowed: true, invocationId, requestIdentity, requestCount }
  }

  function reportUsage(invocationId, usage) {
    const request = inflight.get(String(invocationId))
    if (!request) return false
    const total = reportedTotal(usage)
    if (total === undefined) return false
    request.usage = { totalTokens: Math.max(request.usage?.totalTokens ?? 0, total) }
    const previous = usageIdentities.get(request.requestIdentity)
    if (previous !== undefined && total <= previous) return false
    usageIdentities.set(request.requestIdentity, total)
    reportedTokens += total - (previous ?? 0)
    const tokenLimit = activeLimits.maxReportedTokens
    if (tokenLimit !== undefined && reportedTokens >= tokenLimit) {
      exhaust('maxReportedTokens', tokenLimit, reportedTokens,
        `RP Team reported-token budget exceeded (${reportedTokens} tokens of ${tokenLimit})`)
    }
    return true
  }

  function finish(invocationId, { cancelled = false } = {}) {
    const request = inflight.get(String(invocationId))
    if (!request) return failure
    inflight.delete(String(invocationId))
    if (!request.usage) unreportedFinished = true
    if (!cancelled && activeLimits.maxReportedTokens !== undefined && !request.usage && !failure) {
      exhaust('usage_unavailable', activeLimits.maxReportedTokens, reportedTokens,
        'RP Team cannot enforce the reported-token budget because a provider request returned no actual usage')
    }
    return failure
  }

  function snapshot() {
    const elapsedMs = Math.max(0, now() - startedAt)
    return {
      ...(Object.keys(activeLimits).length ? { limits: { ...activeLimits } } : {}),
      requestCount, reportedTokens, elapsedMs,
      reportedTokensKnown: !unreportedFinished && [...inflight.values()].every(request => request.usage !== undefined),
      ...(failure ? { failure: { code: failure.code, message: failure.message, ...failure.budget } } : {})
    }
  }

  function close() {
    closed = true
    inflight.clear()
  }

  return {
    reserve, reportUsage, finish, checkElapsed, close, snapshot,
    get failure() { return failure },
    get hasTokenLimit() { return activeLimits.maxReportedTokens !== undefined },
    get elapsedDeadline() { return activeLimits.maxElapsedMs === undefined ? undefined : startedAt + activeLimits.maxElapsedMs },
    get hasLimits() { return Object.keys(activeLimits).length > 0 }
  }
}

/** Prevent late requests from an owned Session after its bounded run has stopped accepting work. */
export function assertBudgetedRunDispatchable(run, signal) {
  if (!run?.budget?.hasLimits) return
  const failure = run.budgetFailure ?? run.budget.failure
  if (failure) throw failure
  if (signal?.aborted || !['working', 'composing', 'publishing'].includes(run.phase)) {
    throw teamError('RP_TEAM_RUN_NOT_ACTIVE', 'RP Team run no longer accepts model requests')
  }
}

/** Root-session ordinary dispatch is the Team's local delivery envelope, not a model call. */
export function isBudgetedTeamRequest(run, options, deliveryProvider = 'rp-team-local') {
  if (options?.provider === deliveryProvider || options?.purpose === 'session-title') return false
  const sessionId = String(options?.sessionId ?? '')
  return sessionId !== String(run?.rootSessionId ?? '') || options?.purpose === 'compaction'
}

function reportedTotal(usage) {
  if (!usage || typeof usage !== 'object') return undefined
  if (Number.isSafeInteger(usage.totalTokens) && usage.totalTokens >= 0) return usage.totalTokens
  const input = usage.inputTokens
  const output = usage.outputTokens
  return Number.isSafeInteger(input) && input >= 0 && Number.isSafeInteger(output) && output >= 0
    ? input + output : undefined
}

function stableIdentity(parts) {
  return JSON.stringify(parts.map(value => value === undefined ? null : value))
}
