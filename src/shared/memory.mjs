import { teamError } from './schema.mjs'

/** Normalize the conversation's memory collections against declared array paths. */
export function normalizeMemoryConfig(value, agents, definitions) {
  if (!isRecord(value)) throw invalid('memory must be an object')
  rejectUnknown(value, ['collections'], 'memory')
  if (!Array.isArray(value.collections)) throw invalid('memory.collections must be an array')
  if (!Array.isArray(agents) || !Array.isArray(definitions)) throw invalid('Memory references require agents and state definitions')
  const ids = new Set()
  const collections = value.collections.map((item, index) => {
    if (!isRecord(item)) throw invalid(`memory.collections[${index}] must be an object`)
    rejectUnknown(item, ['id', 'name', 'description', 'namespace', 'path'], `memory.collections[${index}]`)
    const id = identifier(item.id, `memory.collections[${index}].id`)
    if (ids.has(id)) throw invalid(`Duplicate memory collection id: ${id}`)
    ids.add(id)
    const namespace = requiredText(item.namespace, `Memory collection ${id} namespace`)
    if (!(namespace === 'shared' || namespace === 'world' || namespace.startsWith('private:'))) {
      throw invalid(`Memory collection ${id} has an invalid namespace`)
    }
    const path = jsonPointer(item.path, `Memory collection ${id} path`)
    const definition = definitions.find(candidate => candidate.namespace === namespace && candidate.path === path)
    if (!definition || definition.type !== 'array') {
      throw invalid(`Memory collection ${id} must bind a declared array state path`)
    }
    const collection = { id, name: requiredText(item.name, `Memory collection ${id} name`), namespace, path }
    if (item.description !== undefined) {
      if (typeof item.description !== 'string') throw invalid(`Memory collection ${id} description must be text`)
      collection.description = item.description
    }
    return collection
  })
  return { collections }
}

/** Search an ACL-projected collection. Null or non-record redaction placeholders are removed first. */
export function searchMemoryRecords(records, options = {}) {
  if (!Array.isArray(records)) throw teamError('RP_TEAM_INVALID_STATE', 'Memory collection state must be an array')
  if (!isRecord(options)) throw teamError('RP_TEAM_INVALID_REQUEST', 'Memory search options must be an object')
  const query = options.query ?? ''
  if (typeof query !== 'string') throw teamError('RP_TEAM_INVALID_REQUEST', 'Memory query must be text')
  const person = options.person
  if (person !== undefined && typeof person !== 'string') throw teamError('RP_TEAM_INVALID_REQUEST', 'Memory person filter must be text')
  const tag = options.tag
  if (tag !== undefined && typeof tag !== 'string') throw teamError('RP_TEAM_INVALID_REQUEST', 'Memory tag filter must be text')
  const source = options.source
  if (source !== undefined && typeof source !== 'string') throw teamError('RP_TEAM_INVALID_REQUEST', 'Memory source filter must be text')
  const since = dateBoundary(options.since, 'since')
  const until = dateBoundary(options.until, 'until')
  if (since !== undefined && until !== undefined && since > until) throw teamError('RP_TEAM_INVALID_REQUEST', 'Memory since must not be later than until')
  const sort = options.sort ?? 'newest'
  if (sort !== 'newest' && sort !== 'oldest') throw teamError('RP_TEAM_INVALID_REQUEST', 'Memory sort must be newest or oldest')
  const fields = options.fields ?? {}
  if (!isRecord(fields)) throw teamError('RP_TEAM_INVALID_REQUEST', 'Memory fields filter must be an object')
  const includeArchived = options.includeArchived === true
  const limit = options.limit ?? 20
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw teamError('RP_TEAM_INVALID_REQUEST', 'Memory search limit must be between 1 and 100')
  }

  const needle = query.toLocaleLowerCase()
  const visible = records.filter(record => isRecord(record) && Object.keys(record).length > 0)
  const matches = visible.filter(record => {
    if (!includeArchived && record.active === false) return false
    if (person !== undefined && !containsText(record.people, person)) return false
    if (tag !== undefined && !containsText(record.tags, tag)) return false
    if (source !== undefined && (typeof record.source !== 'string' || record.source.toLocaleLowerCase() !== source.toLocaleLowerCase())) return false
    const createdAt = typeof record.createdAt === 'string' ? Date.parse(record.createdAt) : NaN
    if (since !== undefined && (!Number.isFinite(createdAt) || createdAt < since)) return false
    if (until !== undefined && (!Number.isFinite(createdAt) || createdAt > until)) return false
    for (const [field, expected] of Object.entries(fields)) {
      const found = field.startsWith('/') ? lookupPointer(record, field) : { exists: Object.hasOwn(record, field), value: record[field] }
      if (!found.exists || stableJson(found.value) !== stableJson(expected)) return false
    }
    if (!needle) return true
    return [record.content, record.source, record.perspective, ...(Array.isArray(record.people) ? record.people : []), ...(Array.isArray(record.tags) ? record.tags : [])]
      .some(value => typeof value === 'string' && value.toLocaleLowerCase().includes(needle))
  })
  const direction = sort === 'newest' ? -1 : 1
  matches.sort((left, right) => direction * (memoryTime(left) - memoryTime(right))
    || String(left.id ?? '').localeCompare(String(right.id ?? '')))
  return { records: matches.slice(0, limit).map(cloneJson), total: matches.length }
}

/** Purely update one visible record while retaining every other field and array slot. */
export function updateMemoryRecord(records, id, patch, { updatedAt } = {}) {
  if (!Array.isArray(records)) throw teamError('RP_TEAM_INVALID_STATE', 'Memory collection state must be an array')
  if (typeof id !== 'string' || !id) throw teamError('RP_TEAM_INVALID_REQUEST', 'Memory record id is required')
  if (!isRecord(patch) || Object.keys(patch).length === 0) throw teamError('RP_TEAM_INVALID_REQUEST', 'Memory update patch must contain fields')
  const forbidden = Object.keys(patch).filter(key => ['id', 'createdAt', 'updatedAt', 'active'].includes(key))
  if (forbidden.length) throw teamError('RP_TEAM_INVALID_REQUEST', `Memory update cannot change ${forbidden.join(', ')}`)
  if (updatedAt !== undefined && typeof updatedAt !== 'string') throw teamError('RP_TEAM_INVALID_REQUEST', 'updatedAt must be text')
  const index = recordIndex(records, id)
  const result = records.map(item => item === null ? null : cloneJson(item))
  const next = { ...result[index], ...cloneJson(patch) }
  if (updatedAt !== undefined) next.updatedAt = updatedAt
  result[index] = next
  return { records: result, record: cloneJson(next), index }
}

/** Pure archive/restore projection; host tools stage only the active leaf through StateStore. */
export function setMemoryRecordActive(records, id, active, updatedAt) {
  if (typeof active !== 'boolean') throw teamError('RP_TEAM_INVALID_REQUEST', 'Memory active state must be boolean')
  if (updatedAt !== undefined && typeof updatedAt !== 'string') throw teamError('RP_TEAM_INVALID_REQUEST', 'updatedAt must be text')
  const index = recordIndex(records, id)
  const nextRecords = records.map(item => item === null ? null : cloneJson(item))
  nextRecords[index].active = active
  if (updatedAt !== undefined) nextRecords[index].updatedAt = updatedAt
  return { records: nextRecords, record: cloneJson(nextRecords[index]), index }
}

function containsText(values, expected) {
  return Array.isArray(values) && values.some(value => typeof value === 'string' && value.toLocaleLowerCase() === expected.toLocaleLowerCase())
}
function memoryTime(record) {
  const value = typeof record.updatedAt === 'string' ? record.updatedAt : record.createdAt
  const time = typeof value === 'string' ? Date.parse(value) : NaN
  return Number.isFinite(time) ? time : 0
}
function dateBoundary(value, name) {
  if (value === undefined || value === '') return undefined
  if (typeof value !== 'string') throw teamError('RP_TEAM_INVALID_REQUEST', `Memory ${name} filter must be a date string`)
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed)) throw teamError('RP_TEAM_INVALID_REQUEST', `Memory ${name} filter must be a valid date`)
  return parsed
}
function recordIndex(records, id) {
  if (!Array.isArray(records)) throw teamError('RP_TEAM_INVALID_STATE', 'Memory collection state must be an array')
  if (typeof id !== 'string' || !id) throw teamError('RP_TEAM_INVALID_REQUEST', 'Memory record id is required')
  const matches = []
  for (let index = 0; index < records.length; index += 1) {
    if (isRecord(records[index]) && records[index].id === id) matches.push(index)
  }
  if (matches.length !== 1) throw teamError(matches.length ? 'RP_TEAM_MEMORY_CONFLICT' : 'RP_TEAM_MEMORY_NOT_FOUND', matches.length
    ? `Memory record id ${id} is ambiguous` : `Unknown memory record ${id}`)
  return matches[0]
}
function lookupPointer(value, pointer) {
  if (pointer === '') return { exists: true, value }
  let current = value
  for (const segment of pointer.slice(1).split('/').map(item => item.replace(/~1/g, '/').replace(/~0/g, '~'))) {
    if (current === null || typeof current !== 'object' || !Object.hasOwn(current, segment)) return { exists: false }
    current = current[segment]
  }
  return { exists: true, value: current }
}
function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (isRecord(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`
  return JSON.stringify(value)
}
function jsonPointer(value, label) {
  if (typeof value !== 'string' || (value !== '' && !value.startsWith('/'))
    || value.split('/').slice(1).some(segment => /~(?![01])/u.test(segment))) throw invalid(`${label} must be a JSON Pointer`)
  return value
}
function requiredText(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw invalid(`${label} must not be empty`)
  return value.trim()
}
function identifier(value, label) {
  const result = requiredText(value, label)
  if (result.length > 128 || /[\u0000-\u001f\u007f]/u.test(result)) throw invalid(`${label} has an invalid format`)
  return result
}
function rejectUnknown(value, allowed, label) {
  const unknown = Object.keys(value).filter(key => !allowed.includes(key))
  if (unknown.length) throw invalid(`${label} has unsupported fields: ${unknown.join(', ')}`)
}
function cloneJson(value) {
  const serialized = JSON.stringify(value)
  if (serialized === undefined) throw teamError('RP_TEAM_INVALID_STATE', 'Memory data must be JSON serializable')
  return JSON.parse(serialized)
}
function isRecord(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) }
function invalid(message) { return teamError('RP_TEAM_INVALID_CONFIG', message) }
