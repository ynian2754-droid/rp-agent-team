import { createHash, randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { teamError } from '../shared/schema.mjs'

export const TRIAL_DOCUMENT_VERSION = 1

export function trialVariantStorageKey(variantId) {
  const id = String(variantId)
  return `${id.replace(/[^a-z0-9-]/giu, '_').slice(0, 40)}-${createHash('sha256').update(id).digest('hex').slice(0, 32)}`
}

/** Durable plugin-owned trial results, scenarios and frozen official-data archives. */
export class TrialStorage {
  constructor(storePath, home) {
    const base = storePath ? dirname(storePath) : home ? join(home, 'plugins', 'rp-agent-team') : undefined
    if (!base) throw new Error('DSH_HOME or RP Team config storage is required for trial storage.')
    this.root = join(base, 'trials')
    this.path = join(this.root, 'trials.json')
    this.snapshotRoot = join(this.root, 'snapshots')
    this.durableWorkerRoot = join(this.root, 'worker-checkpoints')
    // Native package managers create deep trees; keep Windows worker paths short.
    // Durable results and retry checkpoints remain in the plugin's own store.
    this.workerRoot = (trialId, generation = 0) => {
      const root = join(tmpdir(), 'rpt', hash(this.root).slice(0, 12), hash(trialId).slice(0, 12))
      return generation === 0 ? root : join(root, `retry-${generation}`)
    }
  }

  read() {
    try {
      const value = JSON.parse(readFileSync(this.path, 'utf8'))
      if (value?.version !== TRIAL_DOCUMENT_VERSION || !isRecord(value.scenarios) || !isRecord(value.trials)) {
        throw teamError('RP_TEAM_TRIAL_STORE_INVALID', 'Trial storage has an unsupported format.')
      }
      return value
    } catch (error) {
      if (error?.code === 'ENOENT') return { version: TRIAL_DOCUMENT_VERSION, scenarios: {}, trials: {} }
      throw error
    }
  }

  write(document) {
    mkdirSync(this.root, { recursive: true })
    const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`
    try { writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' }); renameSync(temporary, this.path) }
    finally { rmSync(temporary, { force: true }) }
  }

  writeSnapshot(snapshotId, value) {
    mkdirSync(this.snapshotRoot, { recursive: true })
    const path = this.snapshotPath(snapshotId)
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
    try { writeFileSync(temporary, `${JSON.stringify(value)}\n`, { encoding: 'utf8', flag: 'wx' }); renameSync(temporary, path) }
    finally { rmSync(temporary, { force: true }) }
  }

  readSnapshot(snapshotId) {
    try { return JSON.parse(readFileSync(this.snapshotPath(snapshotId), 'utf8')) }
    catch (error) { if (error?.code === 'ENOENT') return undefined; throw error }
  }

  snapshotPath(snapshotId) {
    const id = requiredText(snapshotId, 'snapshotId')
    if (!/^trial-snapshot-[a-f0-9]{32}$/u.test(id)) throw teamError('RP_TEAM_TRIAL_SNAPSHOT_INVALID', 'Invalid trial snapshot id.')
    return join(this.snapshotRoot, `${id}.json`)
  }

  readWorkerCheckpoints(trialId, variantId) {
    return readDurableFiles(this.variantWorkerRoot(trialId, variantId), 'checkpoints', /^turn-(\d{6})\.json$/u)
  }

  readWorkerAttempts(trialId, variantId) {
    return readDurableAttempts(this.variantWorkerRoot(trialId, variantId))
  }

  variantWorkerRoot(trialId, variantId) {
    return join(this.durableWorkerRoot, hash(requiredText(trialId, 'trialId')), hash(requiredText(variantId, 'variantId')))
  }
}

/** Persist the committed archive, Team state and receipt before the worker acknowledges a turn. */
export function writeDurableTrialCheckpoint(root, trialId, variantId, value) {
  const turn = value?.turn?.turn
  if (!Number.isSafeInteger(turn) || turn < 1) throw new Error('A durable trial checkpoint needs a positive turn number.')
  const directory = join(durableVariantRoot(root, trialId, variantId), 'checkpoints')
  const path = join(directory, `turn-${String(turn).padStart(6, '0')}.json`)
  writeImmutableJson(path, value)
  return path
}

/** Mark dispatch before the provider request so a worker crash cannot silently replay it. */
export function writeDurableTrialAttempt(root, trialId, variantId, attempt) {
  return writeAttemptRecord(root, trialId, variantId, attempt, 'started')
}

/** Record an attempt settlement separately; started evidence remains crash-safe. */
export function writeDurableTrialAttemptSettlement(root, trialId, variantId, attempt) {
  return writeAttemptRecord(root, trialId, variantId, attempt, 'settled')
}

function writeAttemptRecord(root, trialId, variantId, attempt, stage) {
  const directory = join(durableVariantRoot(root, trialId, variantId), 'attempts')
  const attemptHash = hash(requiredText(attempt?.attemptId, 'attemptId'))
  const suffix = stage === 'started' ? 'started' : 'settled'
  const path = join(directory, `attempt-${attemptHash}.${suffix}.json`)
  writeImmutableJson(path, {
    format: 'rp-team.trial-worker-attempt', version: 1, trialId, variantId,
    stage, attempt: structuredClone(attempt),
  })
  return path
}

function readDurableAttempts(root) {
  const rows = readDurableFiles(root, 'attempts', /^attempt-([a-f0-9]{64})\.(started|settled)\.json$/u)
  const byId = new Map()
  for (const row of rows) {
    const match = row.name.match(/^attempt-([a-f0-9]{64})\.(started|settled)\.json$/u)
    if (row.invalid) {
      byId.set(match?.[1] ?? row.name, { invalid: true, name: row.name })
      continue
    }
    const attempt = row.value?.attempt
    if (row.value?.format !== 'rp-team.trial-worker-attempt' || row.value.version !== 1
      || !attempt || typeof attempt.attemptId !== 'string' || !attempt.attemptId) {
      byId.set(row.value?.attempt?.attemptId ?? match?.[1] ?? row.name, { invalid: true, name: row.name })
      continue
    }
    const prior = byId.get(attempt.attemptId)
    if (!prior || row.value.stage === 'settled') byId.set(attempt.attemptId, row.value)
  }
  return [...byId.values()]
}

function readDurableFiles(root, child, pattern) {
  const directory = join(root, child)
  if (!existsSync(directory)) return []
  return readdirSync(directory).filter(name => pattern.test(name)).map(name => {
    const match = name.match(pattern)
    try { return { name, turn: match?.[1] ? Number(match[1]) : undefined, value: JSON.parse(readFileSync(join(directory, name), 'utf8')) } }
    catch { return { name, turn: match?.[1] ? Number(match[1]) : undefined, invalid: true } }
  })
}

function durableVariantRoot(root, trialId, variantId) {
  return join(root, hash(requiredText(trialId, 'trialId')), hash(requiredText(variantId, 'variantId')))
}

function writeImmutableJson(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  if (existsSync(path)) {
    const prior = JSON.parse(readFileSync(path, 'utf8'))
    if (JSON.stringify(prior) !== JSON.stringify(value)) throw new Error(`Conflicting durable trial record at ${path}.`)
    return
  }
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  try { writeFileSync(temporary, `${JSON.stringify(value)}\n`, { encoding: 'utf8', flag: 'wx' }); renameSync(temporary, path) }
  finally { rmSync(temporary, { force: true }) }
}

function isRecord(value) { return Boolean(value && typeof value === 'object' && !Array.isArray(value)) }
function requiredText(value, field) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw teamError('RP_TEAM_TRIAL_INPUT_INVALID', `${field} must be a non-empty string.`)
  }
  return value.trim()
}
function hash(value) { return createHash('sha256').update(JSON.stringify(value)).digest('hex') }
