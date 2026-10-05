import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { exportPreset, normalizeTeamConfig, parsePreset, teamError } from '../shared/schema.mjs'

const LIBRARY_VERSION = 1

/** A plugin-local immutable preset/version library, independent of conversations. */
export class PresetLibrary {
  constructor(path) {
    if (typeof path !== 'string' || !path.trim()) throw new TypeError('Preset library path is required')
    this.path = path
    this.queue = Promise.resolve()
  }

  list() {
    const document = this.read()
    return Object.values(document.presets).map(preset => ({
      id: preset.id,
      name: preset.name,
      version: latestVersion(preset).version,
      versions: preset.versions.map(({ version, hash, createdAt }) => ({ version, hash, createdAt }))
    })).sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id))
  }

  get(id, version) {
    const key = requiredText(id, 'preset id')
    const preset = own(this.read().presets, key)
    if (!preset) throw teamError('RP_TEAM_PRESET_NOT_FOUND', `Unknown preset ${key}`)
    const record = version === undefined
      ? latestVersion(preset)
      : preset.versions.find(item => item.version === requiredText(version, 'preset version'))
    if (!record) throw teamError('RP_TEAM_PRESET_VERSION_NOT_FOUND', `Unknown version ${String(version)} for preset ${key}`)
    return {
      id: key,
      version: record.version,
      hash: record.hash,
      config: structuredClone(record.config),
      dependencies: structuredClone(record.dependencies)
    }
  }

  save(config) {
    const portable = portablePreset(config)
    const normalized = portable.config
    const id = normalized.id
    const version = normalized.version
    const hash = sha256(stableJson({ config: normalized, dependencies: portable.dependencies }))
    const operation = this.queue.then(() => {
      const document = this.read()
      const presets = { ...document.presets }
      const current = own(presets, id)
      const existing = current?.versions.find(item => item.version === version)
      if (existing) {
        if (existing.hash !== hash) throw teamError('RP_TEAM_PRESET_CONFLICT', `Preset ${id}@${version} is immutable and already has different content`)
        return this.get(id, version)
      }
      const record = {
        version,
        hash,
        createdAt: new Date().toISOString(),
        config: normalized,
        dependencies: portable.dependencies
      }
      Object.defineProperty(presets, id, { value: {
        id,
        name: normalized.name,
        versions: [...(current?.versions ?? []), record]
      }, enumerable: true, configurable: true, writable: true })
      this.write({ version: LIBRARY_VERSION, presets })
      return this.get(id, version)
    })
    this.queue = operation.then(() => undefined, () => undefined)
    return operation
  }

  async copy({ id, version, name }) {
    const source = this.get(id, version)
    const copy = structuredClone(source.config)
    copy.id = `preset-${randomUUID()}`
    if (name !== undefined) copy.name = requiredText(name, 'preset name')
    else copy.name = `${copy.name} copy`
    return this.save(copy)
  }

  async delete(id) {
    const key = requiredText(id, 'preset id')
    const operation = this.queue.then(() => {
      const document = this.read()
      if (!own(document.presets, key)) throw teamError('RP_TEAM_PRESET_NOT_FOUND', `Unknown preset ${key}`)
      const presets = { ...document.presets }
      delete presets[key]
      this.write({ version: LIBRARY_VERSION, presets })
      return { deleted: true }
    })
    this.queue = operation.then(() => undefined, () => undefined)
    return operation
  }

  export(id, version) {
    const record = this.get(id, version)
    return portablePreset(record.config)
  }

  import(value) {
    const config = parsePreset(value)
    return this.save(config)
  }

  read() {
    try {
      const value = JSON.parse(readFileSync(this.path, 'utf8'))
      if (value?.version !== LIBRARY_VERSION || !isRecord(value.presets)) {
        throw teamError('RP_TEAM_PRESET_LIBRARY_INVALID', 'Preset library has an unsupported format')
      }
      return value
    } catch (error) {
      if (error?.code === 'ENOENT') return { version: LIBRARY_VERSION, presets: {} }
      throw error
    }
  }

  write(document) {
    mkdirSync(dirname(this.path), { recursive: true })
    const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`
    try {
      writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
      renameSync(temporary, this.path)
    } finally {
      rmSync(temporary, { force: true })
    }
  }
}

export function portablePreset(config) {
  const portable = exportPreset(normalizeTeamConfig(config))
  if (requires040(portable.config)) portable.dependencies.minimumPluginVersion = '0.4.0'
  else if (requires030(portable.config)) portable.dependencies.minimumPluginVersion = '0.3.0'
  return portable
}

export function presetLibraryPath(store, ctx) {
  if (typeof store?.presetLibraryPath === 'string' && store.presetLibraryPath) return store.presetLibraryPath
  if (typeof store?.path === 'string' && store.path) return join(dirname(store.path), 'presets.json')
  if (typeof ctx?.eleckoiStoryState?.pluginDataDir === 'string' && ctx.eleckoiStoryState.pluginDataDir) {
    return join(ctx.eleckoiStoryState.pluginDataDir, 'presets.json')
  }
  const home = process.env.DSH_HOME
  if (home) return join(home, 'plugins', 'rp-agent-team', 'presets.json')
  throw teamError('RP_TEAM_PRESET_LIBRARY_UNAVAILABLE', 'Preset library storage path is unavailable')
}

function requires030(config) {
  return config.state.definitions.some(definition => definition.valueSchema !== undefined)
    || config.agents.some(agent => (agent.communication.handoffs ?? []).length > 0)
}

function requires040(config) {
  return (config.authorParameters ?? []).length > 0
    || (config.memory?.collections ?? []).length > 0
    || config.execution.budget !== undefined
    || config.agents.some(agent => agent.triggers.some(trigger => ['periodic', 'state_changed', 'message_received', 'keyword'].includes(trigger.type)
      || trigger.cooldownTurns !== undefined || trigger.id !== undefined))
}

function latestVersion(preset) { return preset.versions.at(-1) }
function requiredText(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw teamError('RP_TEAM_INVALID_REQUEST', `${label} is required`)
  return value.trim()
}
function own(record, key) { return record && Object.hasOwn(record, key) ? record[key] : undefined }
function sha256(value) { return createHash('sha256').update(value, 'utf8').digest('hex') }
function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (isRecord(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`
  return JSON.stringify(value)
}
function isRecord(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) }
