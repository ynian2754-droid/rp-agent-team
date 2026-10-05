import { randomUUID } from 'node:crypto'
import { searchMemoryRecords, setMemoryRecordActive, updateMemoryRecord } from '../shared/memory.mjs'
import { teamError } from '../shared/schema.mjs'

/** Register ACL-scoped memory tools using the same host and caller checks as the Team tools. */
export function registerMemoryTools({
  agentCtx, defineTool, member, run, stateStore, assertActiveCaller,
  record, persistRun, captureStateBefore, notifyStateChanged
}) {
  const collections = run.config.memory?.collections ?? []
  if (!collections.length) return () => {}
  const disposers = []
  const register = definition => disposers.push(agentCtx.tools.register(defineTool({
    ...definition,
    async execute(args, exec) {
      assertActiveCaller(exec.agent)
      return losslessJson(await definition.execute(args ?? {}, exec))
    }
  })))
  const output = {
    schema: { type: 'object', additionalProperties: true },
    render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }]
  }
  register({
    name: 'rp_team_memory_search',
    description: 'Search records from one configured memory collection. Results contain only fields the current agent may read.',
    parameters: {
      collectionId: { type: 'string', required: true }, query: { type: 'string' }, person: { type: 'string' },
      tag: { type: 'string' }, source: { type: 'string' }, since: { type: 'string' }, until: { type: 'string' },
      sort: { type: 'string' }, fields: { type: 'json' }, includeArchived: { type: 'boolean' }, limit: { type: 'integer' }
    }, output,
    execute: args => {
      const collection = requireCollection(collections, args.collectionId)
      const state = readCollection(stateStore, run, member, collection)
      const visible = searchVisibleRows(stateStore, run, member, collection, state.value, args.includeArchived === true)
      const result = searchMemoryRecords(visible, args)
      return { ...result, version: state.version }
    }
  })
  register({
    name: 'rp_team_memory_add',
    description: 'Add one record to a configured memory collection. State-write permission and output authority are required.',
    parameters: {
      collectionId: { type: 'string', required: true }, record: { type: 'json', required: true },
      expectedVersion: { type: 'integer', required: true }
    }, output,
    execute: async args => {
      assertStateOutput(member)
      const collection = requireCollection(collections, args.collectionId)
      const state = readCollection(stateStore, run, member, collection)
      assertExpectedVersion(args.expectedVersion, state.version)
      if (!Array.isArray(state.value)) throw teamError('RP_TEAM_MEMORY_UNAVAILABLE', 'Memory collection must be initialized as an array before adding records')
      const item = createMemoryRecord(args.record)
      const path = pointerJoin(collection.path, String(state.value.length))
      const staged = stageWrite({ stateStore, run, member, collection, path, value: item, captureStateBefore })
      const current = await finishMutation({ stateStore, run, member, collection, record, persistRun, notifyStateChanged, ...staged, operation: 'memory.add' })
      return { added: true, id: item.id, version: current.version }
    }
  })
  register({
    name: 'rp_team_memory_update',
    description: 'Update one field on a visible record. Send a one-key patch; the host stages only that field to preserve hidden fields.',
    parameters: {
      collectionId: { type: 'string', required: true }, id: { type: 'string', required: true },
      patch: { type: 'json', required: true }, expectedVersion: { type: 'integer', required: true }
    }, output,
    execute: async args => {
      assertStateOutput(member)
      const collection = requireCollection(collections, args.collectionId)
      const state = readCollection(stateStore, run, member, collection)
      assertExpectedVersion(args.expectedVersion, state.version)
      if (!Array.isArray(state.value)) throw teamError('RP_TEAM_INVALID_STATE', 'Memory collection state must be an array')
      if (!args.patch || typeof args.patch !== 'object' || Array.isArray(args.patch) || Object.keys(args.patch).length !== 1) {
        throw teamError('RP_TEAM_INVALID_REQUEST', 'Memory update requires a one-key patch')
      }
      const visible = searchVisibleRows(stateStore, run, member, collection, state.value, false)
      updateMemoryRecord(visible, args.id, args.patch)
      const field = Object.keys(args.patch)[0]
      const sourceIndex = recordIndex(state.value, args.id)
      const actualPath = pointerJoin(pointerJoin(collection.path, String(sourceIndex)), field)
      const staged = stageWrite({ stateStore, run, member, collection, path: actualPath, value: args.patch[field], captureStateBefore })
      const current = await finishMutation({ stateStore, run, member, collection, record, persistRun, notifyStateChanged, ...staged, operation: 'memory.update' })
      return { updated: true, id: args.id, field, version: current.version }
    }
  })
  register({
    name: 'rp_team_memory_archive',
    description: 'Archive one visible memory record without deleting it.',
    parameters: {
      collectionId: { type: 'string', required: true }, id: { type: 'string', required: true },
      expectedVersion: { type: 'integer', required: true }
    }, output,
    execute: async args => setRecordActive(args, false, collections, { stateStore, run, member, record, persistRun, captureStateBefore, notifyStateChanged })
  })
  register({
    name: 'rp_team_memory_restore',
    description: 'Restore one visible archived memory record.',
    parameters: {
      collectionId: { type: 'string', required: true }, id: { type: 'string', required: true },
      expectedVersion: { type: 'integer', required: true }
    }, output,
    execute: async args => setRecordActive(args, true, collections, { stateStore, run, member, record, persistRun, captureStateBefore, notifyStateChanged })
  })
  return () => { for (const dispose of disposers.reverse()) dispose?.() }
}

async function setRecordActive(args, active, collections, deps) {
  const { stateStore, run, member, record, persistRun, captureStateBefore, notifyStateChanged } = deps
  assertStateOutput(member)
  const collection = requireCollection(collections, args.collectionId)
  const state = readCollection(stateStore, run, member, collection)
  assertExpectedVersion(args.expectedVersion, state.version)
  if (!Array.isArray(state.value)) throw teamError('RP_TEAM_INVALID_STATE', 'Memory collection state must be an array')
  const visible = searchVisibleRows(stateStore, run, member, collection, state.value, true)
  setMemoryRecordActive(visible, args.id, active)
  const sourceIndex = recordIndex(state.value, args.id)
  const path = pointerJoin(pointerJoin(collection.path, String(sourceIndex)), 'active')
  const staged = stageWrite({ stateStore, run, member, collection, path, value: active, captureStateBefore })
  const current = await finishMutation({ stateStore, run, member, collection, record, persistRun, notifyStateChanged, ...staged, operation: active ? 'memory.restore' : 'memory.archive' })
  return { [active ? 'restored' : 'archived']: true, id: args.id, version: current.version }
}

function stageWrite({ stateStore, run, member, collection, path, value, captureStateBefore }) {
  const target = { conversationId: run.conversationId, runId: run.runId, agentId: member.id, namespace: collection.namespace, path }
  const triggerBefore = captureStateBefore?.(collection.namespace, path)
  let expectedVersion
  let beforeData
  let canRecordValues = true
  try {
    const current = stateStore.read(target)
    expectedVersion = current.version
    beforeData = current.value === undefined ? { beforeMissing: true } : { before: cloneJson(current.value) }
  } catch (error) {
    if (error?.code !== 'RP_TEAM_STATE_FORBIDDEN') throw error
    expectedVersion = stateStore.version(target).version
    beforeData = {}
    canRecordValues = false
  }
  stateStore.write({ ...target, value: cloneJson(value), expectedVersion })
  const version = stateStore.version(target).version
  const traceData = {
    namespace: collection.namespace,
    path,
    version,
    ...beforeData,
    ...(canRecordValues ? { after: cloneJson(value), valuesRecorded: true } : { valuesRecorded: false })
  }
  return { triggerBefore, traceData }
}

function recordIndex(records, id) {
  const matches = []
  for (let index = 0; index < records.length; index += 1) {
    if (isRecord(records[index]) && records[index].id === id) matches.push(index)
  }
  if (matches.length !== 1) throw teamError(matches.length ? 'RP_TEAM_MEMORY_CONFLICT' : 'RP_TEAM_MEMORY_NOT_FOUND', matches.length
    ? `Memory record id ${id} is ambiguous` : `Unknown memory record ${id}`)
  return matches[0]
}

async function finishMutation({ stateStore, run, member, collection, record, persistRun, notifyStateChanged, triggerBefore, traceData, operation }) {
  run.stateTransaction = stateStore.status({ conversationId: run.conversationId, runId: run.runId })
  record({
    type: 'state.operation', agentId: member.id,
    data: { ...traceData, operation }
  })
  if (notifyStateChanged && triggerBefore) await notifyStateChanged(triggerBefore)
  else await run.scheduler?.notify()
  await persistRun()
  return readCollection(stateStore, run, member, collection)
}

function readCollection(stateStore, run, member, collection) {
  const result = stateStore.read({
    conversationId: run.conversationId, runId: run.runId, agentId: member.id,
    namespace: collection.namespace, path: collection.path
  })
  return { value: result.value, version: result.version }
}

function searchVisibleRows(stateStore, run, member, collection, projected, includeArchived) {
  if (projected === undefined) return []
  if (!Array.isArray(projected)) throw teamError('RP_TEAM_INVALID_STATE', 'Memory collection state must be an array')
  const visible = []
  for (let index = 0; index < projected.length; index += 1) {
    const row = projected[index]
    if (!isRecord(row) || Object.keys(row).length === 0) continue
    let active = row.active
    if (!Object.hasOwn(row, 'active')) {
      try {
        active = stateStore.read({
          conversationId: run.conversationId, runId: run.runId, agentId: member.id,
          namespace: collection.namespace, path: pointerJoin(pointerJoin(collection.path, String(index)), 'active')
        }).value
      } catch (error) {
        if (error?.code === 'RP_TEAM_STATE_FORBIDDEN') continue
        throw error
      }
    }
    if (!includeArchived && active === false) continue
    if (active !== undefined && typeof active !== 'boolean') continue
    visible.push(Object.hasOwn(row, 'active') || active === undefined ? row : { ...row, active })
  }
  return visible
}

function createMemoryRecord(value) {
  if (!isRecord(value)) throw teamError('RP_TEAM_INVALID_REQUEST', 'Memory record must be an object')
  for (const field of ['id', 'createdAt', 'updatedAt']) {
    if (Object.hasOwn(value, field)) throw teamError('RP_TEAM_INVALID_REQUEST', `Memory record ${field} is assigned by the host`)
  }
  if (typeof value.content !== 'string' || !value.content.trim()) throw teamError('RP_TEAM_INVALID_REQUEST', 'Memory record content is required')
  if (Object.hasOwn(value, 'active') && typeof value.active !== 'boolean') throw teamError('RP_TEAM_INVALID_REQUEST', 'Memory record active must be boolean')
  if (Object.hasOwn(value, 'people') && !stringArray(value.people)) throw teamError('RP_TEAM_INVALID_REQUEST', 'Memory record people must be a string array')
  if (Object.hasOwn(value, 'tags') && !stringArray(value.tags)) throw teamError('RP_TEAM_INVALID_REQUEST', 'Memory record tags must be a string array')
  for (const field of ['source', 'perspective']) {
    if (Object.hasOwn(value, field) && typeof value[field] !== 'string') throw teamError('RP_TEAM_INVALID_REQUEST', `Memory record ${field} must be text`)
  }
  if (Object.hasOwn(value, 'confidence') && (typeof value.confidence !== 'number' || !Number.isFinite(value.confidence))) {
    throw teamError('RP_TEAM_INVALID_REQUEST', 'Memory record confidence must be a finite number')
  }
  const clone = cloneJson(value)
  return { ...clone, id: randomUUID(), createdAt: new Date().toISOString(), active: clone.active ?? true }
}

function requireCollection(collections, id) {
  if (typeof id !== 'string') throw teamError('RP_TEAM_INVALID_REQUEST', 'collectionId is required')
  const collection = collections.find(item => item.id === id)
  if (!collection) throw teamError('RP_TEAM_MEMORY_COLLECTION_NOT_FOUND', `Unknown memory collection ${id}`)
  return collection
}

function assertStateOutput(member) {
  if (!member.outputAuthority?.state) throw teamError('RP_TEAM_OUTPUT_FORBIDDEN', `Agent ${member.id} has no state-write authority`)
}

function assertExpectedVersion(expected, actual) {
  if (!Number.isSafeInteger(expected) || expected < 0) throw teamError('RP_TEAM_STATE_VERSION_REQUIRED', 'expectedVersion is required')
  if (actual !== expected) throw teamError('RP_TEAM_STATE_CONFLICT', `Memory collection version is ${actual}, not ${expected}`)
}

function pointerJoin(base, segment) { return `${base}/${String(segment).replace(/~/g, '~0').replace(/\//g, '~1')}` }
function stringArray(value) { return Array.isArray(value) && value.every(item => typeof item === 'string') }
function cloneJson(value) {
  const serialized = JSON.stringify(value)
  if (serialized === undefined) throw teamError('RP_TEAM_INVALID_REQUEST', 'Memory data must be JSON serializable')
  return JSON.parse(serialized)
}
function losslessJson(value) { const serialized = JSON.stringify(value); return serialized === undefined ? {} : JSON.parse(serialized) }
function isRecord(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) }
