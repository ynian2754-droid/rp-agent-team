import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { chronicleTargets, createChronicleSource } from '../src/host/lived-history-chronicle.mjs'
import { registerMemoryTools } from '../src/host/memory-tools.mjs'
import { StateStore } from '../src/host/state-store.mjs'
import { defaultTeamConfig } from '../src/shared/schema.mjs'

const namespace = 'shared'
const eventPath = '/canon/events'
const event = (id, options = {}) => ({
  id, active: true, content: '递过去一张纸。', source: '正文', shown: '已呈现', weight: '寻常', ...options
})
const newEvent = (options = {}) => ({
  content: '她说会回来。', source: '正文', shown: '已呈现', weight: '寻常', ...options
})

function fixture(t, { memoryAppend = false } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'rp-team-chronicle-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const stateStore = new StateStore(home)
  const config = defaultTeamConfig()
  const agent = config.agents[0]
  const world = config.agents[1]
  agent.statePermissions = [
    ...[eventPath, '/practices', '/readings', '/story/notes'].map(path => ({ namespace, path, access: 'readwrite' })),
    { namespace, path: '/canon/world', access: 'read' },
    { namespace, path: `${eventPath}/3`, access: 'none' }
  ]
  world.statePermissions = [{ namespace, path: eventPath, access: 'readwrite' }]
  if (memoryAppend) {
    world.execution.memoryAppend = true
    config.memory = { collections: [{ id: 'events', name: 'Events', namespace, path: eventPath }] }
  }
  config.state.definitions = [{ namespace, path: eventPath, type: 'array', default: [
    event('e1'), event('e2', { shown: '待呈现', weight: '转折' }), event('e3', { active: false }), event('hidden')
  ] }, ...Object.entries({
    '/canon/world': {}, '/canon/hidden': { secret: true }, '/practices': {}, '/readings': {},
    '/story/notes': { rhythm: '既有节奏', audit: [] }
  }).map(([path, value]) => ({ namespace, path, type: 'object', default: value }))]
  const run = { conversationId: 'conversation', runId: 'run', config }
  stateStore.begin({ ...run, config })
  const source = createChronicleSource({ run, agent, stateStore })
  const endpoint = { ...run, agentId: agent.id }
  const targets = data => chronicleTargets({ source, data, run, agent, stateStore })
  const batch = data => stateStore.writeBatch({ ...endpoint, targets: targets(data) })
  const observe = path => stateStore.read({ ...endpoint, namespace, path }).value
  return { stateStore, source, endpoint, agent, world, targets, batch, observe }
}

test('chronicle preserves ACL projection, order, a concurrent world append, and new event references in one batch', t => {
  const { stateStore, source, world, endpoint, batch, observe } = fixture(t)
  assert.deepEqual(source.context.events.map(row => row.id), ['e1', 'e2'])
  assert.deepEqual(source.context.world, {})
  assert.ok(!Object.hasOwn(source.context, 'hidden'))
  assert.ok(!Object.hasOwn(source.context, 'versions'))
  stateStore.write({ ...endpoint, agentId: world.id, namespace, path: `${eventPath}/4`,
    expectedVersion: 0, value: event('current-world') })
  const accepted = batch({
    state: {
      practices: { '甲/乙': [{ examples: [{ $event: 'fresh' }] }] },
      storyNotes: { audit: [{ where: { $event: 'fresh' } }] }
    },
    events: [
      { op: 'shown', id: 'e2', value: '仅痕迹' },
      { op: 'add', key: 'fresh', record: newEvent() },
      { op: 'add', record: newEvent({ source: '摘要', covers: ['e1'] }) },
      { op: 'archive', id: 'e1' }
    ]
  })
  assert.deepEqual(accepted.map(row => row.path), [
    '/canon/events/5', '/canon/events/6', '/canon/events/1/shown', '/canon/events/0/active',
    '/practices/甲~1乙', '/story/notes/audit'
  ])
  const rows = observe(eventPath)
  assert.equal(rows[0].active, false)
  assert.equal(rows[1].shown, '仅痕迹')
  assert.equal(rows[4].id, 'current-world')
  assert.ok(rows[5].id && rows[5].createdAt)
  assert.deepEqual(rows[6].covers, ['e1'])
  assert.deepEqual(observe('/practices'), { '甲/乙': [{ examples: [rows[5].id] }] })
  assert.deepEqual(observe('/story/notes'), { rhythm: '既有节奏', audit: [{ where: rows[5].id }] })
  const staged = stateStore.stage(endpoint)
  assert.equal(staged.writes.length, 7)
  stateStore.commit({ ...endpoint, receipt: { outcome: 'committed', assistantMessageId: 'body' } })
  assert.equal(stateStore.committedSnapshot(endpoint).namespaces.shared.canon.events[5].id, rows[5].id)
})

test('chronicle rejects unauthorized event IDs, destructive archives and invalid references without an accepted prefix', t => {
  const { stateStore, endpoint, targets, batch } = fixture(t)
  const initial = stateStore.status(endpoint)
  const add = { op: 'add', record: newEvent() }
  for (const operation of [
    { op: 'shown', id: 'hidden', value: '已呈现' },
    { op: 'shown', id: 'e3', value: '已呈现' },
    { op: 'shown', id: 'e2', value: '未呈现' },
    { op: 'archive', id: 'e1' },
    { op: 'archive', id: 'e2' },
    { op: 'add', record: newEvent({ source: '裁定' }) }
  ]) {
    assert.throws(() => batch({ state: {}, events: [add, operation] }), { code: 'RP_TEAM_CHRONICLE_INVALID' })
  }
  assert.throws(() => targets({ state: { storyNotes: { audit: [{ where: { $event: 'missing' } }] } }, events: [add] }),
    { code: 'RP_TEAM_CHRONICLE_INVALID' })
  assert.throws(() => targets({ state: { hidden: {} }, events: [] }), { code: 'RP_TEAM_CHRONICLE_INVALID' })
  assert.throws(() => targets({ state: {}, events: Array(9).fill(add) }), { code: 'RP_TEAM_CHRONICLE_INVALID' })
  assert.deepEqual(stateStore.status(endpoint), initial)
})

test('a stale field cancels the whole batch while irrelevant sibling writes remain intact', t => {
  const { stateStore, endpoint, world, batch, observe } = fixture(t)
  stateStore.write({ ...endpoint, agentId: world.id, namespace, path: `${eventPath}/1/shown`, expectedVersion: 0, value: '已呈现' })
  const before = stateStore.status(endpoint)
  assert.throws(() => batch({ events: [
    { op: 'add', record: newEvent() }, { op: 'shown', id: 'e2', value: '仅痕迹' }
  ], state: { storyNotes: { audit: ['尚未写入'] } } }), { code: 'RP_TEAM_STATE_CONFLICT' })
  assert.deepEqual(stateStore.status(endpoint), before)
  assert.equal(observe(eventPath).length, 4)
  assert.deepEqual(observe('/story/notes').audit, [])
})

test('provenance chronicle detects both original replay errors and only transcribes an exact published quote', t => {
  const { source, batch, observe } = fixture(t)
  source.publishedSources = [{ id: 'published-1', text: '她说会回来。窗外的雨停了。' }]
  const record = { storyTime: '当晚', people: [], perceivers: [], weight: '寻常' }
  const userInput = '现在就回答我。'
  const proposed = { op: 'add', sourceId: 'published-1', quote: userInput, record: { ...record, source: '用户' } }
  assert.throws(() => batch({ state: { storyNotes: { clocks_near: [{ what: '关门' }] } }, events: [proposed] }),
    error => error.code === 'RP_TEAM_CHRONICLE_INVALID' && error.message.includes('clocks_near') && error.message.includes('events[0]'))
  const mislabeled = { ...proposed, record: { ...record, source: '正文' } }
  assert.throws(() => batch({ state: {}, events: [mislabeled] }), /exact passage from its published assistant text/)
  assert.equal(observe(eventPath).length, 4)
  const published = { ...mislabeled, quote: '她说会回来。' }
  assert.equal(batch({ state: { storyNotes: { clocks_near: ['关门'] } }, events: [published] }).length, 2)
  assert.equal(observe(eventPath).at(-1).content, published.quote)
  assert.equal(observe(eventPath).at(-1).shown, '已呈现')
  assert.throws(() => batch({ state: {}, events: [published] }), /already in the event ledger/)
})

for (const chronicleFirst of [true, false]) {
  test(`tail appends and a chronicle update commit in order with ${chronicleFirst ? 'the chronicle' : 'an append'} first`, async t => {
    const { stateStore, endpoint, agent, world, batch } = fixture(t, { memoryAppend: true })
    const trace = []
    const toolset = member => {
      const tools = new Map()
      registerMemoryTools({
        agentCtx: { tools: { register: tool => { tools.set(tool.name, tool); return () => {} } } },
        defineTool: tool => tool, member, run: endpoint, stateStore,
        assertActiveCaller: () => {}, persistRun: () => {}, record: event => trace.push(event)
      })
      return tools
    }
    const worldTools = toolset(world)
    const legacyTools = toolset(agent)
    const exec = { agent: {} }
    assert.ok(worldTools.has('rp_team_memory_append'))
    assert.ok(!worldTools.has('rp_team_memory_add'))
    assert.ok(legacyTools.has('rp_team_memory_add'))
    assert.ok(!legacyTools.has('rp_team_memory_append'))

    const stale = await legacyTools.get('rp_team_memory_search').execute({ collectionId: 'events' }, exec)
    const markOldEvent = () => batch({ state: {}, events: [{ op: 'shown', id: 'e2', value: '仅痕迹' }] })
    const append = record => worldTools.get('rp_team_memory_append').execute({ collectionId: 'events', record }, exec)
    if (chronicleFirst) markOldEvent()
    const first = await append(newEvent({ content: 'World registered the stimulus.', source: '用户' }))
    if (!chronicleFirst) markOldEvent()
    const second = await append(newEvent({
      content: 'World resolved the stimulus.', source: '裁定', because: [first.id]
    }))
    assert.notEqual(first.id, second.id)
    await assert.rejects(legacyTools.get('rp_team_memory_add').execute({
      collectionId: 'events', expectedVersion: stale.version, record: newEvent({ content: 'Stale legacy add.' })
    }, exec), { code: 'RP_TEAM_STATE_CONFLICT' })
    assert.throws(() => batch({ state: {}, events: [{ op: 'shown', id: 'e2', value: '已呈现' }] }),
      { code: 'RP_TEAM_STATE_CONFLICT' })

    const staged = stateStore.stage(endpoint)
    assert.equal(staged.status, 'pending')
    const receipt = { outcome: 'committed', receiptKey: staged.receiptKey, assistantMessageId: 'body' }
    assert.equal(stateStore.commit({ ...endpoint, receipt }).status, 'committed')
    assert.deepEqual(stateStore.status(endpoint).receipt, receipt)
    const { revision, namespaces } = stateStore.committedSnapshot(endpoint)
    assert.equal(revision, 1)
    const committed = namespaces.shared.canon.events
    assert.deepEqual(committed.map(row => row.id), ['e1', 'e2', 'e3', 'hidden', first.id, second.id])
    assert.equal(committed[1].shown, '仅痕迹')
    assert.equal(committed[2].active, false)
    assert.deepEqual(committed[5].because, [first.id])
    assert.deepEqual(trace.map(({ data }) => [data.operation, data.path]), [
      ['memory.append', `${eventPath}/4`], ['memory.append', `${eventPath}/5`]
    ])
  })
}
