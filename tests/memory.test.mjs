import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { defaultTeamConfig, normalizeTeamConfig } from '../src/shared/schema.mjs'
import { normalizeMemoryConfig, searchMemoryRecords, setMemoryRecordActive, updateMemoryRecord } from '../src/shared/memory.mjs'
import { registerMemoryTools } from '../src/host/memory-tools.mjs'
import { StateStore } from '../src/host/state-store.mjs'

test('memory declarations bind unique collections to declared array paths', () => {
  const definitions = [{ namespace: 'shared', path: '/memories', type: 'array' }]
  assert.deepEqual(normalizeMemoryConfig({ collections: [
    { id: 'journal', name: 'Journal', namespace: 'shared', path: '/memories' }
  ] }, [], definitions), { collections: [
    { id: 'journal', name: 'Journal', namespace: 'shared', path: '/memories' }
  ] })
  assert.throws(() => normalizeMemoryConfig({ collections: [
    { id: 'bad', name: 'Bad', namespace: 'shared', path: '/missing' }
  ] }, [], definitions), { code: 'RP_TEAM_INVALID_CONFIG' })
})

test('search filters redaction placeholders before matching, counts and sorting', () => {
  const records = [
    { id: 'new', content: 'needle in a journal', createdAt: '2026-02-01T00:00:00.000Z', source: 'diary', people: ['Mira'], tags: ['scene'], confidence: 0.7 },
    null,
    {},
    { id: 'old', content: 'needle in a letter', createdAt: '2026-01-01T00:00:00.000Z', source: 'letter', people: ['Mira'], tags: ['memory'], confidence: 0.5 },
    { id: 'archived', content: 'needle archived', createdAt: '2026-03-01T00:00:00.000Z', source: 'diary', active: false }
  ]
  const result = searchMemoryRecords(records, {
    query: 'needle', person: 'mira', source: 'letter', since: '2025-12-31T00:00:00Z',
    until: '2026-01-31T23:59:59Z', sort: 'oldest', fields: { '/confidence': 0.5 }, limit: 10
  })
  assert.deepEqual(result.records.map(item => item.id), ['old'])
  assert.equal(result.total, 1)
  assert.deepEqual(searchMemoryRecords(records, { query: 'needle', includeArchived: true }).records.map(item => item.id), ['archived', 'new', 'old'])
})

test('pure updates preserve null slots and archive without a marker field', () => {
  const records = [
    { id: 'entry', content: 'Visible', secret: 'keep', active: true }, null,
    { id: 'collision', content: 'Marker-like', _memoryActiveMarker: 'authored value' }
  ]
  const updated = updateMemoryRecord(records, 'entry', { content: 'Changed' })
  assert.deepEqual(updated.records[1], null)
  assert.equal(updated.record.secret, 'keep')
  const archived = setMemoryRecordActive(updated.records, 'collision', false)
  assert.equal(archived.records[2].active, false)
  assert.equal(archived.records[2]._memoryActiveMarker, 'authored value')
})

test('memory tools search only ACL-projected rows and stage one-leaf CAS writes', async () => {
  const home = mkdtempSync(join(tmpdir(), 'rp-team-memory-'))
  try {
    const config = defaultTeamConfig()
    config.state.definitions = [{ namespace: 'shared', path: '/memories', type: 'array', default: [
      { id: 'visible', content: 'Find this journal', createdAt: '2026-01-01T00:00:00.000Z', source: 'journal', active: true, secret: 'preserve me' },
      { id: 'hidden', content: 'Do not count this', createdAt: '2026-02-01T00:00:00.000Z', source: 'private' }
    ] }]
    config.agents[0].statePermissions = [
      { namespace: 'shared', path: '/memories', access: 'readwrite' },
      { namespace: 'shared', path: '/memories/0/secret', access: 'write' },
      { namespace: 'shared', path: '/memories/1', access: 'write' }
    ]
    config.memory = { collections: [{ id: 'journal', name: 'Journal', namespace: 'shared', path: '/memories' }] }
    const normalized = normalizeTeamConfig(config)
    const stateStore = new StateStore(undefined, { filePath: join(home, 'state.json') })
    stateStore.begin({ conversationId: 'conversation', runId: 'run', config: normalized })
    const tools = new Map()
    const traces = []
    const captured = []
    const notified = []
    const calls = { genericNotify: 0, persist: 0 }
    const member = normalized.agents[0]
    const run = {
      conversationId: 'conversation', runId: 'run', config: normalized,
      scheduler: { notify: async () => { calls.genericNotify += 1 } }
    }
    registerMemoryTools({
      agentCtx: { tools: { register: tool => { tools.set(tool.name, tool); return () => {} } } },
      defineTool: tool => tool,
      member, run, stateStore, assertActiveCaller: () => {},
      captureStateBefore: (namespace, path) => {
        const before = [{ triggerId: 'watch-memory', agentId: 'agent-2', namespace, path, before: { known: true, present: false } }]
        captured.push({ namespace, path, before })
        return before
      },
      notifyStateChanged: async before => { notified.push(before) },
      record: event => traces.push(event),
      persistRun: async () => { calls.persist += 1 }
    })
    const exec = { agent: { session: { id: 'memory-agent' } } }
    const search = await tools.get('rp_team_memory_search').execute({ collectionId: 'journal', query: 'journal' }, exec)
    assert.equal(search.total, 1, 'the fully redacted record is removed before count')
    assert.equal(search.records[0].secret, undefined)
    assert.equal(search.records[0].id, 'visible')

    await tools.get('rp_team_memory_update').execute({
      collectionId: 'journal', id: 'visible', patch: { content: 'Updated visible entry' }, expectedVersion: search.version
    }, exec)
    const afterUpdate = stateStore.snapshot({ conversationId: 'conversation', runId: 'run' }).shared.memories
    assert.equal(afterUpdate[0].content, 'Updated visible entry')
    assert.equal(afterUpdate[0].secret, 'preserve me', 'leaf write keeps fields hidden from this agent')
    assert.equal(afterUpdate[1].content, 'Do not count this')
    await assert.rejects(tools.get('rp_team_memory_update').execute({
      collectionId: 'journal', id: 'visible', patch: { content: 'Stale overwrite' }, expectedVersion: search.version
    }, exec), { code: 'RP_TEAM_STATE_CONFLICT' })

    const current = await tools.get('rp_team_memory_search').execute({ collectionId: 'journal' }, exec)
    await tools.get('rp_team_memory_archive').execute({
      collectionId: 'journal', id: 'visible', expectedVersion: current.version
    }, exec)
    const afterArchive = stateStore.snapshot({ conversationId: 'conversation', runId: 'run' }).shared.memories
    assert.equal(afterArchive[0].active, false)
    assert.equal(afterArchive[0].secret, 'preserve me')
    const archived = await tools.get('rp_team_memory_search').execute({ collectionId: 'journal', includeArchived: true }, exec)
    await tools.get('rp_team_memory_restore').execute({ collectionId: 'journal', id: 'visible', expectedVersion: archived.version }, exec)
    const restored = await tools.get('rp_team_memory_search').execute({ collectionId: 'journal' }, exec)
    const added = await tools.get('rp_team_memory_add').execute({
      collectionId: 'journal', expectedVersion: restored.version,
      record: { content: 'New note', source: 'chat', people: ['Mira'], tags: ['new'] }
    }, exec)
    assert.equal(added.added, true)
    const finalState = stateStore.snapshot({ conversationId: 'conversation', runId: 'run' }).shared.memories
    assert.equal(finalState[0].active, true)
    assert.equal(finalState[2].content, 'New note')

    const beforeWriteOnlyUpdate = await tools.get('rp_team_memory_search').execute({ collectionId: 'journal' }, exec)
    await tools.get('rp_team_memory_update').execute({
      collectionId: 'journal', id: 'visible', patch: { secret: 'write-only value' }, expectedVersion: beforeWriteOnlyUpdate.version
    }, exec)
    assert.equal(stateStore.snapshot({ conversationId: 'conversation', runId: 'run' }).shared.memories[0].secret, 'write-only value')

    const data = traces.map(event => event.data)
    assert.deepEqual(data.map(({ operation, path }) => ({ operation, path })), [
      { operation: 'memory.update', path: '/memories/0/content' },
      { operation: 'memory.archive', path: '/memories/0/active' },
      { operation: 'memory.restore', path: '/memories/0/active' },
      { operation: 'memory.add', path: '/memories/2' },
      { operation: 'memory.update', path: '/memories/0/secret' },
    ])
    assert.equal(data[0].before, 'Find this journal')
    assert.equal(data[0].after, 'Updated visible entry')
    assert.equal(data[1].before, true)
    assert.equal(data[1].after, false)
    assert.equal(data[2].before, false)
    assert.equal(data[2].after, true)
    assert.equal(data[3].beforeMissing, true)
    assert.deepEqual(data[3].after, finalState[2])
    assert.deepEqual(data.slice(0, 4).map(item => item.version), [1, 2, 3, 4])
    assert.ok(data.slice(0, 4).every(event => event.valuesRecorded === true))
    assert.equal(data[4].beforeMissing, undefined, 'an unreadable before value must not be described as absent')
    assert.equal(data[4].valuesRecorded, false, 'write-only state values are omitted from trace')
    assert.equal(Object.hasOwn(data[4], 'before'), false)
    assert.equal(Object.hasOwn(data[4], 'after'), false)
    assert.deepEqual(notified, captured.map(item => item.before), 'state-change callbacks receive the exact captured snapshots')
    assert.equal(calls.genericNotify, 0, 'the state-change notifier owns the scheduler wakeup')
    assert.equal(calls.persist, 5)
    assert.equal(traces.length, 5)
    assert.ok(!JSON.stringify(traces).includes('preserve me'), 'a hidden prior field is never copied into trace')
    assert.ok(!JSON.stringify(traces).includes('write-only value'), 'write-only values are omitted from trace')
    await assert.rejects(tools.get('rp_team_memory_search').execute({ collectionId: 'not-declared' }, exec), { code: 'RP_TEAM_MEMORY_COLLECTION_NOT_FOUND' })
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
