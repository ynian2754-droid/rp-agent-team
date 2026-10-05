import { teamError } from '../shared/schema.mjs'

export function projectConversationContext(context, agentContext) {
  const sources = agentContext.sources
  const selectedHistory = sources.full_history ?? sources.recent_history
  const history = Array.isArray(selectedHistory) ? selectedHistory : selectedHistory ? [selectedHistory] : []
  const card = sources.character_card
  const input = sources.current_input
  return {
    characterId: card?.id ?? '', characterName: card?.name ?? '',
    persona: card?.persona ?? {},
    history: history.filter(item => item && ['user', 'assistant'].includes(item.role)).map(item => ({
      role: item.role, content: String(item.content ?? ''),
      ...(Array.isArray(item.attachments) ? { attachments: structuredClone(item.attachments) } : {})
    })),
    currentUserInput: typeof input === 'string' ? input : String(input?.text ?? ''),
    ...(sources.worldbook === undefined ? {} : { settingLibrary: structuredClone(sources.worldbook) })
  }
}

export function makeVariableBranch(agent, variables, bridge, canReadNativeNamespace, history = [], writePaths = []) {
  const allowed = canReadNativeNamespace(agent, 'variables')
  const result = {
    enabled: allowed && bridge.enabled === true,
    config: allowed ? structuredClone(bridge.config ?? null) : null,
    state: allowed ? structuredClone(variables) : {},
    writeEnabled: allowed && writePaths.length > 0,
    writePaths: allowed ? [...writePaths] : []
  }
  copyBridgeVersion(bridge, result)
  if (Array.isArray(bridge.history)) result.history = structuredClone(history)
  return result
}

export function makeSettingBranch(agent, flatSettings, bridge, canReadNativeNamespace, history = [], variableState = {}, writePaths = []) {
  const allowed = canReadNativeNamespace(agent, 'settings')
  const library = allowed ? filterSettingLibrary(bridge.library ?? {}, flatSettings ?? {}) : { groups: [], entries: [] }
  const result = {
    enabled: allowed && bridge.enabled === true,
    library,
    frozenLibrary: structuredClone(library),
    history: structuredClone(history),
    variableState: allowed ? structuredClone(variableState) : {},
    writeEnabled: allowed && writePaths.length > 0,
    writePaths: allowed ? [...writePaths] : []
  }
  copyBridgeVersion(bridge, result)
  return result
}

export function filterSettingLibrary(library, flatSettings) {
  const groups = new Map((library.groups ?? []).map(group => [group.id, group]))
  const groupPath = id => {
    const parts = []; const seen = new Set(); let group = groups.get(id)
    while (group && !seen.has(group.id)) { seen.add(group.id); parts.unshift(safeSegment(group.name)); group = groups.get(group.parentId) }
    return parts.filter(Boolean).join('/')
  }
  const entries = (library.entries ?? []).flatMap(entry => {
    const key = [groupPath(entry.groupId), safeSegment(entry.title || '未命名设定')].filter(Boolean).join('/')
    return Object.hasOwn(flatSettings, key) ? [{ ...entry, content: flatSettings[key] }] : []
  })
  const used = new Set(entries.map(entry => entry.groupId).filter(Boolean))
  for (const id of [...used]) {
    let group = groups.get(id)
    while (group) { used.add(group.id); group = groups.get(group.parentId) }
  }
  return {
    groups: (library.groups ?? []).filter(group => used.has(group.id)).map(group => ({ id: group.id, name: group.name, parentId: group.parentId })),
    entries: structuredClone(entries)
  }
}

export function bridgeSettingFiles(library) {
  const groups = new Map((library?.groups ?? []).map(group => [group.id, group]))
  const groupPath = id => {
    const parts = []; const seen = new Set(); let group = groups.get(id)
    while (group && !seen.has(group.id)) { seen.add(group.id); parts.unshift(safeSegment(group.name)); group = groups.get(group.parentId) }
    return parts.filter(Boolean).join('/')
  }
  return Object.fromEntries((library?.entries ?? []).filter(entry => typeof entry.content === 'string').map(entry => [
    [groupPath(entry.groupId), safeSegment(entry.title || '未命名设定')].filter(Boolean).join('/'), String(entry.content)
  ]))
}

export function storyOperations(writes, baseState) {
  return writes.filter(item => item.namespace === 'world').map(item => {
    if (item.path.startsWith('/variables/')) {
      const path = item.path.slice('/variables'.length)
      if (item.operation === 'remove') return { kind: 'variables', op: 'remove', path }
      return { kind: 'variables', op: hasPointer(baseState.world?.variables ?? {}, path) ? 'replace' : 'add', path, value: item.value }
    }
    if (item.path.startsWith('/settings/')) {
      const encoded = item.path.slice('/settings/'.length)
      if (!encoded || encoded.includes('/')) throw teamError('RP_TEAM_STATE_PATH_INVALID', 'A world setting path must encode one complete virtual file path')
      if (item.operation === 'remove') throw teamError('RP_TEAM_STATE_DELETE_UNSUPPORTED', 'World setting deletion is not supported')
      return { kind: 'settings', op: 'write_file', path: decodePointerSegment(encoded), content: String(item.value) }
    }
    throw teamError('RP_TEAM_STATE_PATH_INVALID', `Unsupported world state path ${item.path}`)
  })
}

export function setPointerValue(value, pointer, next) {
  const parts = pointerSegments(pointer)
  if (!parts.length) return structuredClone(next)
  const result = structuredClone(value ?? {})
  let current = result
  for (let index = 0; index < parts.length - 1; index += 1) {
    const part = parts[index]
    if (!Object.hasOwn(current, part) || current[part] === null || typeof current[part] !== 'object') {
      Object.defineProperty(current, part, {
        value: /^\d+$/u.test(parts[index + 1]) ? [] : {}, enumerable: true, configurable: true, writable: true
      })
    }
    current = current[part]
  }
  Object.defineProperty(current, parts.at(-1), {
    value: structuredClone(next), enumerable: true, configurable: true, writable: true
  })
  return result
}

export function diffLeaves(before, after, path = '') {
  if (stableJson(before) === stableJson(after)) return []
  if (isRecord(before) && isRecord(after)) {
    const keys = new Set([...Object.keys(before), ...Object.keys(after)])
    return [...keys].flatMap(key => {
      const nextPath = `${path}/${escapePointer(key)}`
      if (!Object.hasOwn(after, key)) return [{ path: nextPath, removed: true }]
      if (!Object.hasOwn(before, key)) return [{ path: nextPath, value: after[key] }]
      return diffLeaves(before[key], after[key], nextPath)
    })
  }
  return [{ path: path || '', value: after }]
}

export function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (isRecord(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`
  return JSON.stringify(value)
}

export function escapePointer(value) { return String(value).replace(/~/gu, '~0').replace(/\//gu, '~1') }
export function decodePointerSegment(value) { return value.replace(/~1/gu, '/').replace(/~0/gu, '~') }
export function safeSegment(value) { return String(value ?? '').trim().replace(/[\\/:*?"<>|]/gu, '_').replace(/[\u0000-\u001f]/gu, '').replace(/^[. ]+|[. ]+$/gu, '') }

function hasPointer(value, pointer) {
  let current = value
  for (const part of pointerSegments(pointer)) { if (current === null || typeof current !== 'object' || !Object.hasOwn(current, part)) return false; current = current[part] }
  return true
}

function pointerSegments(pointer) { return pointer === '' ? [] : pointer.slice(1).split('/').map(decodePointerSegment) }
function isRecord(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) }

function copyBridgeVersion(source, target) {
  if (source.version !== undefined) target.version = source.version
  if (source.schemaVersion !== undefined) target.schemaVersion = source.schemaVersion
}
