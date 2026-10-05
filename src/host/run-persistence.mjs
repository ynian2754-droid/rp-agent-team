import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createHash } from 'node:crypto'
import { serializeRun } from './run-state.mjs'
import { createTrace, serializeTrace } from './trace.mjs'
import { stableJson } from './context-world-adapter.mjs'

export function writeJsonAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`
  try { writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' }); renameSync(temporary, path) }
  finally { rmSync(temporary, { force: true }) }
}

export function readOptionalJson(path, fallback) {
  if (!path) return structuredClone(fallback)
  try { return JSON.parse(readFileSync(path, 'utf8')) }
  catch (error) { if (error?.code === 'ENOENT') return structuredClone(fallback); throw error }
}

export function fingerprint(value) {
  return createHash('sha256').update(typeof value === 'string' ? value : stableJson(value)).digest('hex')
}

export function runFilePath(traceRoot, conversationId, runId) {
  return join(conversationTraceDirectory(traceRoot, conversationId), `${safeName(runId)}-${fingerprint(runId).slice(0, 12)}.json`)
}

export function conversationTraceDirectory(traceRoot, conversationId) {
  return join(traceRoot, fingerprint(conversationId).slice(0, 28))
}

export function runDataDirectory(dataRoot, conversationId, runId) {
  return join(dataRoot, fingerprint(conversationId).slice(0, 28), `${safeName(runId)}-${fingerprint(runId).slice(0, 12)}`)
}

export function preparedWorldPath(dataRoot, conversationId, runId) {
  return join(runDataDirectory(dataRoot, conversationId, runId), 'prepared-world.json')
}

export function manualSelectionPath(storePath, conversationId) {
  return join(dirname(storePath), 'manual', `${fingerprint(conversationId).slice(0, 28)}.json`)
}

export function readRunRows(traceRoot, conversationId) {
  const directory = conversationTraceDirectory(traceRoot, conversationId)
  if (!existsSync(directory)) return []
  return readdirSync(directory).filter(file => file.endsWith('.json')).map(file => {
    try { return JSON.parse(readFileSync(join(directory, file), 'utf8')) } catch { return undefined }
  }).filter(row => row?.status?.conversationId === conversationId)
}

export function readRunRecordFile(traceRoot, conversationId, runId) {
  try { return JSON.parse(readFileSync(runFilePath(traceRoot, conversationId, runId), 'utf8')) }
  catch (error) { if (error?.code === 'ENOENT') return undefined; throw error }
}

export function persistedRunValue(run) {
  return {
    ...serializeRun(run, serializeTrace(run.trace)),
    configStoreRevision: run.configStoreRevision,
    configRevision: run.configRevision,
    baseHash: run.baseHash,
    contextFingerprint: run.contextFingerprint,
    productMessageId: run.productMessageId,
    productCommitStaged: run.productCommitStaged === true,
    productReceiptOutcome: run.productReceiptOutcome,
    retrySourceRunId: run.retrySourceRunId,
    childSessionIds: [...(run.childSessionIds ?? [])],
    drafts: run.drafts ?? [],
    messages: run.communication?.allMessages() ?? run.messages ?? [],
    internalResults: run.internalResults ?? [],
    preservedStateWrites: run.preservedStateWrites ?? []
  }
}

export function serializedActiveRun(run) {
  return {
    ...serializeRun(run, serializeTrace(run.trace)), configStoreRevision: run.configStoreRevision,
    baseHash: run.baseHash, contextFingerprint: run.contextFingerprint,
    drafts: run.drafts, messages: run.communication?.allMessages() ?? run.messages,
    pendingPrepared: run.pendingPrepared, preservedStateWrites: run.preservedStateWrites ?? [],
    retrySourceRunId: run.retrySourceRunId,
    childSessionIds: [...(run.childSessionIds ?? [])],
    productReceiptOutcome: run.productReceiptOutcome,
    productCommitStaged: run.productCommitStaged === true
  }
}

export function applySavedRunFields(run, row) {
  run.localDeliveryRequestSeq = row.localDeliveryRequestSeq
  run.executionSessions = structuredClone(row.executionSessions ?? run.executionSessions ?? [])
  run.configStoreRevision = row.configStoreRevision
  run.baseHash = row.baseHash
  run.contextFingerprint = row.contextFingerprint
  run.drafts = structuredClone(row.drafts ?? [])
  run.messages = structuredClone(row.messages ?? [])
  run.internalResults = structuredClone(row.internalResults ?? [])
  run.trace = row.trace ?? createTrace(run.runId, run.startedAt)
  run.publication = row.publication ?? row.status?.publication ?? null
  run.productMessageId = row.productMessageId ?? row.status?.productMessageId
  run.productCommitStaged = row.productCommitStaged === true
  run.productReceiptOutcome = row.productReceiptOutcome
  run.retrySourceRunId = row.retrySourceRunId
  run.childSessionIds = [...(row.childSessionIds ?? run.childSessionIds ?? [])]
  run.inputMessageId = row.inputMessageId ?? row.status?.inputMessageId
  run.inputEventSeq = row.inputEventSeq ?? row.status?.inputEventSeq
  run.assistantSeq = row.assistantSeq
  run.assistantMessageId = row.assistantMessageId
  run.phase = row.status?.phase ?? run.phase
  run.pendingPrepared = row.pendingPrepared
  run.preservedStateWrites = structuredClone(row.preservedStateWrites ?? [])
}

export function removeRunData(run) {
  run.pendingPrepared = null
  rmSync(run.dataDir, { recursive: true, force: true })
}

export function safeName(value) { return String(value).replace(/[^a-zA-Z0-9_-]/gu, '_').slice(0, 120) || 'id' }
