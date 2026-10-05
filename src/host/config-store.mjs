import { randomUUID } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { exportPreset, defaultTeamConfig, normalizeTeamConfig, parsePreset, teamError } from '../shared/schema.mjs'
import { normalizeSuppliedParameterValues } from '../shared/author-parameters.mjs'
import { migrateV1ToV2, normalizeStoredConfig } from './migrations/v1-to-v2.mjs'
import { configRevision } from './run-state.mjs'

export class TeamConfigStore {
  constructor(home = process.env.DSH_HOME) {
    if (!home) throw new Error('DSH_HOME is required for RP Team configuration storage')
    this.path = join(home, 'plugins', 'rp-agent-team', 'conversations.json')
    this.backupPath = join(home, 'plugins', 'rp-agent-team', 'conversations.v1.backup.json')
    this.queue = Promise.resolve()
  }

  get(conversationId) {
    const id = requiredConversationId(conversationId)
    const record = own(this.read().conversations, id)
    if (!record) return { conversationId: id, enabled: false, revision: 0, config: defaultTeamConfig(), parameterValues: {} }
    const config = normalizeStoredConfig(record.config)
    return {
      conversationId: id,
      enabled: record.enabled === true,
      revision: record.revision,
      config,
      parameterValues: storedParameterValues(config, record.parameterValues)
    }
  }

  save({ conversationId, expectedRevision, enabled, config, parameterValues }) {
    const id = requiredConversationId(conversationId)
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      throw teamError('RP_TEAM_INVALID_REVISION', 'expectedRevision must be a non-negative integer')
    }
    if (typeof enabled !== 'boolean') throw teamError('RP_TEAM_INVALID_CONFIG', 'enabled must be a boolean')
    const normalized = normalizeTeamConfig(config)
    const suppliedValues = parameterValues === undefined
      ? undefined
      : normalizeSuppliedParameterValues(normalized, parameterValues)
    const operation = this.queue.then(() => {
      const document = this.read()
      const storedPrevious = own(document.conversations, id) ?? {
        enabled: false,
        revision: 0,
        config: defaultTeamConfig(),
        parameterValues: {}
      }
      const previous = { ...storedPrevious, config: normalizeStoredConfig(storedPrevious.config) }
      if (previous.revision !== expectedRevision) {
        throw teamError('RP_TEAM_CONFIG_CONFLICT', `Configuration revision is ${previous.revision}, not ${expectedRevision}`)
      }
      const nextParameterValues = suppliedValues === undefined
        ? storedParameterValues(normalized, storedParameterValues(previous.config, previous.parameterValues))
        : suppliedValues
      const storedConfigsAreV2 = document.version === 2 && Object.values(document.conversations).every(record => record.config?.schemaVersion === 2)
      if (storedConfigsAreV2 && previous.enabled === enabled && configRevision(previous.config) === configRevision(normalized)
        && stableJson(storedParameterValues(previous.config, previous.parameterValues)) === stableJson(nextParameterValues)) {
        return this.get(id)
      }
      const conversations = Object.fromEntries(Object.entries(document.conversations).map(([conversationId, record]) => [
        conversationId,
        { ...record, config: normalizeStoredConfig(record.config) }
      ]))
      const next = {
        ...document,
        version: 2,
        conversations: {
          ...conversations,
          [id]: { ...previous, enabled, revision: previous.revision + 1, config: normalized, parameterValues: nextParameterValues }
        }
      }
      this.backupLegacyDocument()
      this.write(next)
      return this.get(id)
    })
    this.queue = operation.then(() => undefined, () => undefined)
    return operation
  }

  export(conversationId) {
    const { config } = this.get(conversationId)
    return exportPreset(config)
  }

  import(value) {
    if (value?.format === 'rp-team-config-v1') return migrateV1ToV2(value.config)
    return parsePreset(value)
  }

  runtimeThreadId(conversationId, revision, runId) {
    const id = requiredConversationId(conversationId)
    if (!Number.isSafeInteger(revision) || revision < 0) throw teamError('RP_TEAM_INVALID_REVISION', 'revision must be a non-negative integer')
    if (typeof runId !== 'string' || !runId) throw teamError('RP_TEAM_INVALID_REQUEST', 'runId is required for a Team runtime thread')
    const key = `${revision}:${runId}`
    const current = own(this.read().conversations, id)
    if (!current || current.revision !== revision) throw teamError('RP_TEAM_CONFIG_CONFLICT', 'Runtime id requested for a stale configuration revision')
    const existing = current.runtimeThreadIds?.[key]
    if (existing) return Promise.resolve(existing)
    const operation = this.queue.then(() => {
      const document = this.read()
      const record = own(document.conversations, id)
      if (!record || record.revision !== revision) throw teamError('RP_TEAM_CONFIG_CONFLICT', 'Configuration changed while creating a runtime thread')
      const runtimeThreadIds = { ...(record.runtimeThreadIds ?? {}), [key]: `rp-${randomUUID()}` }
      this.write({ ...document, conversations: { ...document.conversations, [id]: { ...record, runtimeThreadIds } } })
      return runtimeThreadIds[key]
    })
    this.queue = operation.then(() => undefined, () => undefined)
    return operation
  }

  bindRuntimeThread(conversationId, revision, runtimeThreadId, runId) {
    const id = requiredConversationId(conversationId)
    if (typeof runtimeThreadId !== 'string' || !runtimeThreadId) throw teamError('RP_TEAM_INVALID_REQUEST', 'runtimeThreadId is required')
    const operation = this.queue.then(() => {
      const document = this.read()
      const record = own(document.conversations, id) ?? { enabled: false, revision: 0, config: defaultTeamConfig() }
      if (record.revision !== revision) return false
      const runtimeThreadIds = { ...(record.runtimeThreadIds ?? {}), [`${revision}:${runId}`]: runtimeThreadId }
      const runtimeBindings = { ...(record.runtimeBindings ?? {}), [runtimeThreadId]: { revision, runId, updatedAt: new Date().toISOString() } }
      this.write({ ...document, conversations: { ...document.conversations, [id]: { ...record, runtimeThreadIds, runtimeBindings } } })
      return true
    })
    this.queue = operation.then(() => undefined, () => undefined)
    return operation
  }

  boundRuntimeThread(conversationId, revision) {
    const record = own(this.read().conversations, requiredConversationId(conversationId))
    return own(record?.runtimeThreadIds, revision)
  }

  revisionForRuntimeThread(conversationId, runtimeThreadId) {
    const record = own(this.read().conversations, requiredConversationId(conversationId))
    return own(record?.runtimeBindings, runtimeThreadId)?.revision
  }

  latestRuntimeBinding(conversationId) {
    const record = own(this.read().conversations, requiredConversationId(conversationId))
    if (!record) return null
    const entries = Object.entries(record.runtimeBindings ?? {}).sort(([, left], [, right]) => right.updatedAt.localeCompare(left.updatedAt))
    const [rootSessionId, binding] = entries[0] ?? []
    return binding === undefined ? null : {
      conversationId,
      rootSessionId,
      enabled: record.enabled,
      configRevision: binding.revision,
      currentConfigRevision: record.revision,
      stale: binding.revision !== record.revision
    }
  }

  read() {
    try {
      const value = JSON.parse(readFileSync(this.path, 'utf8'))
      if (![1, 2].includes(value?.version) || !value.conversations || typeof value.conversations !== 'object') {
        throw teamError('RP_TEAM_CONFIG_STORE_INVALID', 'RP Team configuration store has an unsupported format')
      }
      return value
    } catch (error) {
      if (error?.code === 'ENOENT') return { version: 1, conversations: {} }
      throw error
    }
  }

  write(document) {
    mkdirSync(dirname(this.path), { recursive: true })
    const temporary = `${this.path}.${process.pid}.${Date.now()}.tmp`
    try {
      writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
      renameSync(temporary, this.path)
    } finally {
      rmSync(temporary, { force: true })
    }
  }

  backupLegacyDocument() {
    if (!existsSync(this.path) || existsSync(this.backupPath)) return
    const current = JSON.parse(readFileSync(this.path, 'utf8'))
    if (current.version !== 1 && !Object.values(current.conversations ?? {}).some(record => isLegacyConfig(record?.config))) return
    copyFileSync(this.path, this.backupPath)
  }
}

function requiredConversationId(value) {
  if (typeof value !== 'string' || !value.trim()) throw teamError('RP_TEAM_INVALID_REQUEST', 'conversationId is required')
  return value.trim()
}

function isLegacyConfig(value) {
  return value && typeof value === 'object' && !Array.isArray(value) && value.lead && Array.isArray(value.members)
}

function own(record, key) {
  return record && typeof record === 'object' && !Array.isArray(record) && Object.hasOwn(record, key) ? record[key] : undefined
}

function storedParameterValues(config, values) {
  const ids = new Set((config.authorParameters ?? []).map(parameter => parameter.id))
  const retained = Object.fromEntries(Object.entries(values && typeof values === 'object' && !Array.isArray(values) ? values : {})
    .filter(([id]) => ids.has(id)))
  return normalizeSuppliedParameterValues(config, retained)
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}
