import { readFileSync } from 'node:fs'
import { runFilePath, writeJsonAtomic } from './run-persistence.mjs'

const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'interrupted'])

export function requestRecordPath(traceRoot, conversationId, runId) {
  return `${runFilePath(traceRoot, conversationId, runId)}.handoffs.json`
}

export function readRequestRecords(traceRoot, conversationId, runId) {
  const path = requestRecordPath(traceRoot, conversationId, runId)
  try {
    const document = JSON.parse(readFileSync(path, 'utf8'))
    return Array.isArray(document.requests) ? structuredClone(document.requests) : []
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
}

/** Resolve orphaned in-flight requests as interrupted; never restart their model work. */
export function interruptPersistedRequests(traceRoot, conversationId, runId) {
  const requests = readRequestRecords(traceRoot, conversationId, runId)
  let changed = false
  for (const request of requests) {
    if (TERMINAL.has(request.status)) continue
    request.status = 'interrupted'
    request.error = { code: 'RP_TEAM_HANDOFF_INTERRUPTED', message: 'Runtime ended before this handoff completed; retry explicitly to run models again' }
    request.completedAt = new Date().toISOString()
    changed = true
  }
  if (changed) writeRequestRecords(traceRoot, conversationId, runId, requests)
  return requests
}

export function writeRequestRecords(traceRoot, conversationId, runId, requests) {
  writeJsonAtomic(requestRecordPath(traceRoot, conversationId, runId), {
    version: 1, conversationId: String(conversationId), runId: String(runId), requests: structuredClone(requests)
  })
}

/** Small durable state machine for collaboration requests stored with their owning run. */
export function createRequestPersistence(run, { traceRoot, persist = () => {}, onTrace = () => {} } = {}) {
  run.handoffRequests ??= []

  function create(value) {
    if (run.handoffRequests.some(item => item.requestId === value.requestId)) {
      throw requestError('RP_TEAM_HANDOFF_DUPLICATE', `Handoff request ${value.requestId} already exists`)
    }
    const row = {
      ...structuredClone(value), status: 'queued', createdAt: new Date().toISOString(),
      sourceActivationComplete: false, targetActivationComplete: false, resumeQueued: false
    }
    run.handoffRequests.push(row)
    onTrace('handoff.requested', row, { status: row.status })
    persistAll()
    return row
  }

  function get(requestId) {
    return run.handoffRequests.find(item => item.requestId === String(requestId))
  }

  function update(requestId, updater) {
    const row = get(requestId)
    if (!row) return undefined
    updater(row)
    row.updatedAt = new Date().toISOString()
    persistAll()
    return row
  }

  function bindTarget(requestId, executionId) {
    const row = get(requestId)
    if (!row || TERMINAL.has(row.status)) return false
    if (row.targetExecutionId && row.targetExecutionId !== executionId) {
      throw requestError('RP_TEAM_HANDOFF_TARGET_MISMATCH', `Handoff ${requestId} was already bound to another target execution`)
    }
    update(requestId, current => {
      current.targetExecutionId = String(executionId)
      current.status = 'running'
      current.targetStartedAt = new Date().toISOString()
    })
    onTrace('handoff.target_started', row, { targetExecutionId: String(executionId) })
    return true
  }

  function complete(requestId, { targetExecutionId, result }) {
    const row = get(requestId)
    if (!row || TERMINAL.has(row.status)) return false
    if (!row.targetExecutionId || row.targetExecutionId !== String(targetExecutionId)) {
      throw requestError('RP_TEAM_HANDOFF_TARGET_MISMATCH', `Handoff ${requestId} result did not come from its exact target execution`)
    }
    update(requestId, current => {
      current.status = 'completed'
      current.targetActivationComplete = true
      current.result = structuredClone(result)
      current.completedAt = new Date().toISOString()
    })
    onTrace('handoff.completed', row, { targetExecutionId: row.targetExecutionId })
    return true
  }

  function fail(requestId, error, { targetExecutionId, cancelled = false, targetComplete = false } = {}) {
    const row = get(requestId)
    if (!row || TERMINAL.has(row.status)) return false
    if (targetExecutionId && row.targetExecutionId && row.targetExecutionId !== String(targetExecutionId)) {
      throw requestError('RP_TEAM_HANDOFF_TARGET_MISMATCH', `Handoff ${requestId} failure came from another target execution`)
    }
    update(requestId, current => {
      current.status = cancelled ? 'cancelled' : 'failed'
      current.error = { code: String(error?.code ?? (cancelled ? 'RP_TEAM_CANCELLED' : 'RP_TEAM_HANDOFF_FAILED')),
        message: String(error?.message ?? error ?? 'Handoff failed') }
      if (targetExecutionId) current.targetExecutionId = String(targetExecutionId)
      if (targetComplete) current.targetActivationComplete = true
      current.completedAt = new Date().toISOString()
    })
    onTrace(cancelled ? 'handoff.cancelled' : 'handoff.failed', row, { error: row.error })
    return true
  }

  function finishSource(executionId, status, error) {
    const completed = []
    for (const row of run.handoffRequests) {
      if (row.sourceExecutionId !== String(executionId) || row.sourceActivationComplete) continue
      update(row.requestId, current => {
        current.sourceActivationComplete = true
        current.sourceActivationStatus = status
      })
      if (status !== 'complete' && !TERMINAL.has(row.status)) fail(row.requestId, error ?? requestError('RP_TEAM_HANDOFF_SOURCE_FAILED', 'Requesting activation failed'))
      completed.push(get(row.requestId))
    }
    return completed
  }

  function finishTarget(requestId, executionId, status) {
    const row = get(requestId)
    if (!row || row.targetExecutionId !== String(executionId)) return false
    update(requestId, current => {
      current.targetActivationComplete = true
      current.targetActivationStatus = status
    })
    return true
  }

  function pending() { return run.handoffRequests.filter(item => !TERMINAL.has(item.status)).map(item => structuredClone(item)) }

  function persistAll() {
    if (traceRoot) writeRequestRecords(traceRoot, run.conversationId, run.runId, run.handoffRequests)
    persist()
  }

  return { create, get, update, bindTarget, complete, fail, finishSource, finishTarget, pending }
}

function requestError(code, message) { return Object.assign(new Error(message), { code }) }
