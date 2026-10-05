import test from 'node:test'
import assert from 'node:assert/strict'
import { createClientApi } from '../src/client/api.js'
import { isCapabilityEnabled, updateCapabilitySelection } from '../src/client/capabilities.js'
import { exportPayload, parseImport } from '../src/client/privacy.js'
import { defaultTeamConfig, examplePresets, normalizeTeamConfig } from '../src/shared/schema.mjs'
import { addAgent, removeAgent, selectPublisher, validJsonShape, effectiveStateAccess } from '../src/client/editor-model.js'
import { findMessageRun } from '../src/client/run-model.js'
import { createConversationStore } from '../src/client/store.js'
import { createSessionConversationIndex } from '../src/client/session-binding.js'

test('native reply keeps its trace when state commit has no product receipt', () => {
  const pending = { runId: 'pending', phase: 'awaiting_commit', assistantMessageId: 'native-message' }
  const complete = { runId: 'complete', phase: 'complete', productMessageId: 'product-message' }
  assert.equal(findMessageRun([undefined, pending, complete], 'native-message', 'native-message'), pending)
  assert.equal(findMessageRun([pending, complete], 'product-message', 'other'), complete)
  assert.equal(findMessageRun([pending, complete], undefined, undefined), undefined)
})

test('generated Team Remote is scoped to the product conversation id', async () => {
  const calls = []
  const api = createClientApi(new Proxy({}, {
    get(_target, name) {
      return async payload => {
        calls.push([name, payload])
        return { ok: true, value: { enabled: true } }
      }
    }
  }))

  await api.getConfig('conversation-17')
  await api.cancel('conversation-17', 'run-4')
  await api.retry('conversation-17', 'run-4', ['canon'], 'request-8')
  await api.discardRetry('conversation-17', 'run-4', 'request-8')

  assert.deepEqual(calls, [
    ['getConfig', { conversationId: 'conversation-17' }],
    ['cancel', { conversationId: 'conversation-17', runId: 'run-4' }],
    ['retry', { conversationId: 'conversation-17', runId: 'run-4', memberIds: ['canon'], requestId: 'request-8' }],
    ['discardRetry', { conversationId: 'conversation-17', runId: 'run-4', requestId: 'request-8' }]
  ])
})

test('overlapping startup and active status polling share one request per conversation', async () => {
  const calls = []
  let release
  const pending = new Promise(resolve => { release = resolve })
  const store = createConversationStore({
    async getStatus(conversationId) {
      calls.push(conversationId)
      return pending
    },
    async listTraces() { return [] }
  })

  const startupPoll = store.refreshStatus('conversation-17')
  const activeRunPoll = store.refreshStatus('conversation-17')
  const otherConversationPoll = store.refreshStatus('conversation-18')
  assert.deepEqual(calls, ['conversation-17', 'conversation-18'])

  release({ conversationId: 'conversation-17', run: { phase: 'working' } })
  await Promise.all([startupPoll, activeRunPoll, otherConversationPoll])
  assert.equal(store.getSnapshot('conversation-17').status.run.phase, 'working')
})

test('disposing the conversation store clears active status polling timers', async () => {
  const nativeSetTimeout = globalThis.setTimeout
  const nativeClearTimeout = globalThis.clearTimeout
  const scheduled = new Map()
  const cleared = []
  let timerId = 0
  globalThis.setTimeout = (callback, delay) => {
    const id = ++timerId
    scheduled.set(id, { callback, delay })
    return id
  }
  globalThis.clearTimeout = id => {
    cleared.push(id)
    scheduled.delete(id)
  }
  try {
    const store = createConversationStore({
      async getStatus(conversationId) { return { conversationId, run: { runId: 'r', phase: 'working' } } },
      async listTraces() { return [] }
    })
    store.watchStatus('conversation-17')
    await new Promise(resolve => nativeSetTimeout(resolve, 0))

    assert.equal(scheduled.size, 1)
    assert.equal([...scheduled.values()][0].delay, 1500)
    store.dispose()
    assert.deepEqual(cleared, [1])
    assert.equal(scheduled.size, 0)
  } finally {
    globalThis.setTimeout = nativeSetTimeout
    globalThis.clearTimeout = nativeClearTimeout
  }
})

test('retry admission regenerates the durable user event and discards intent on admission failure', async () => {
  const calls = []
  const api = {
    async retry(conversationId, runId, memberIds, requestId) {
      calls.push(['retry', conversationId, runId, memberIds, requestId])
      return { accepted: true, requestId, targetEventSeq: 17 }
    },
    async discardRetry(conversationId, runId, requestId) {
      calls.push(['discardRetry', conversationId, runId, requestId])
      return { discarded: true }
    }
  }
  const conversations = {
    async regenerate(payload) {
      calls.push(['regenerate', payload])
      throw new Error('product run admission failed')
    }
  }
  const store = createConversationStore(api, conversations)

  await assert.rejects(store.retry('conversation-17', 'run-4', ['drama']), /product run admission failed/)

  const requestId = calls[0][4]
  assert.match(requestId, /^[0-9a-f-]{36}$/i)
  assert.deepEqual(calls, [
    ['retry', 'conversation-17', 'run-4', ['drama'], requestId],
    ['regenerate', {
      conversationId: 'conversation-17',
      requestId,
      eventSeq: 17
    }],
    ['discardRetry', 'conversation-17', 'run-4', requestId]
  ])
})

test('V2 exports only preset data and rejects undeclared credential fields', () => {
  const config = defaultTeamConfig()
  const exported = exportPayload(config)
  assert.equal(exported.config.schemaVersion, 2)
  assert.deepEqual(parseImport(exported), config)
  const unsafe = structuredClone(config)
  unsafe.agents[0].parameters.apiKey = 'secret'
  assert.throws(() => exportPayload(unsafe))
  assert.throws(() => parseImport({ format: 'unknown', config }))
})

test('member duplication and deletion maintain stable references and one publisher', () => {
  const config = defaultTeamConfig()
  const added = addAgent(config, config.agents[0])
  assert.notEqual(added.selectedId, config.agents[0].id)
  assert.equal(added.config.agents.at(-1).outputAuthority.user, false)
  const chosen = selectPublisher(added.config, added.selectedId)
  assert.equal(chosen.agents.filter(agent => agent.outputAuthority.user).length, 1)
  const removed = removeAgent(chosen, added.selectedId)
  assert.equal(removed.output.agentId, removed.agents[0].id)
  assert.equal(normalizeTeamConfig(removed).agents.length, config.agents.length)
})

test('manual selection and trace Remote use only the target conversation', async () => {
  const calls = []
  const api = createClientApi(new Proxy({}, { get(_target, method) { return async payload => { calls.push({ method, payload }); return { ok: true, value: method === 'listTraces' ? [] : {} } } } }))
  await api.setManualAgents('c-1', ['a'])
  await api.listTraces('c-1')
  await api.getTrace('c-1', 'r-1')
  assert.deepEqual(calls.map(call => call.payload), [{ conversationId: 'c-1', agentIds: ['a'] }, { conversationId: 'c-1' }, { conversationId: 'c-1', runId: 'r-1' }])
})

test('retained workspace bodies keep their own conversation when selection changes', () => {
  let details = { id: 'c-1', runtimeSessionId: 's-1' }
  const listeners = new Set()
  const conversations = {
    getDetailsSnapshot: () => details,
    getSnapshot: () => ({ items: [] }),
    subscribeDetails(fn) { listeners.add(fn); return () => listeners.delete(fn) },
    subscribe: () => () => {}
  }
  const index = createSessionConversationIndex(conversations)
  const stop = index.subscribe(() => {})
  assert.equal(index.get('s-1'), 'c-1')
  details = { id: 'c-2', details: { runtimeSessionId: 's-2' } }
  for (const listener of listeners) listener()
  assert.equal(index.get('s-2'), 'c-2')
  assert.equal(index.get('s-1'), 'c-1')
  assert.equal(index.get('s-unknown'), '')
  stop()
  assert.equal(listeners.size, 0)
})

test('Remote error preserves revision conflict details for the editor', async () => {
  const api = createClientApi({
    getConfig() {},
    async saveConfig() { return { ok: false, error: { message: 'revision conflict', code: 'CONFLICT', details: { revision: 3 } } } }
  })
  await assert.rejects(api.saveConfig('c-1', 2, true, defaultTeamConfig()), error => error.code === 'CONFLICT' && error.details.revision === 3)
})

test('turning off one inherited capability preserves every other default', () => {
  const options = [
    { id: 'story.read', enabledByDefault: true },
    { id: 'story.propose', enabledByDefault: true },
    { id: 'setting.write', enabledByDefault: false }
  ]
  const explicit = updateCapabilitySelection([], options, 'story.read', false)

  assert.deepEqual(explicit, [
    { id: 'story.read', enabled: false },
    { id: 'story.propose', enabled: true },
    { id: 'setting.write', enabled: false }
  ])
  assert.deepEqual(options.map(item => isCapabilityEnabled(explicit, item)), [false, true, false])
})

test('explicit capability lists disable omitted options and preserve unknown ids', () => {
  const options = [
    { id: 'story.read', enabledByDefault: true },
    { id: 'story.propose', enabledByDefault: true }
  ]
  const current = [
    { id: 'plugin.legacy', enabled: true },
    { id: 'story.read', enabled: true }
  ]

  assert.equal(isCapabilityEnabled(current, options[1]), false)
  const changed = updateCapabilitySelection(current, options, 'story.read', false)
  assert.deepEqual(changed, [
    { id: 'plugin.legacy', enabled: true },
    { id: 'story.read', enabled: false }
  ])
})

test('advanced JSON rejects shapes that would crash the editor', () => {
  assert.equal(validJsonShape('context', {}), false)
  assert.equal(validJsonShape('context', { sources: [] }), true)
  assert.equal(validJsonShape('definitions', [null]), false)
  assert.equal(validJsonShape('statePermissions', {}), false)
  assert.equal(validJsonShape('capabilities', [{ id: 'tool', enabled: true }]), true)
})

test('old preset imports become ordinary members with preserved execution order', () => {
  const legacy = { lead: { id: 'old-output', name: 'Writer', context: 'fork' }, members: [{ id: 'old-a', name: 'Attention' }, { id: 'old-b', name: 'Memory' }] }
  const config = parseImport({ format: 'rp-team-config-v1', config: legacy })
  assert.equal(config.schemaVersion, 2)
  assert.equal(config.output.agentId, 'old-output')
  assert.deepEqual(config.agents[0].execution.after, ['old-a', 'old-b'])
  assert.ok(config.agents.every(agent => agent.triggers.some(trigger => trigger.type === 'always')))
  assert.equal(parseImport(exportPayload(config)).agents.length, 3)
})

test('state editor displays inherited permission and the most specific denial', () => {
  const agent = { statePermissions: [{ namespace: 'world', path: '', access: 'readwrite' }, { namespace: 'world', path: '/variables/private', access: 'none' }] }
  assert.equal(effectiveStateAccess(agent, 'world', '/variables/public'), 'readwrite')
  assert.equal(effectiveStateAccess(agent, 'world', '/variables/private/value'), 'none')
  assert.equal(effectiveStateAccess(agent, 'shared', '/variables/public'), 'none')
})

test('example presets still describe two different topologies', () => {
  const [generic, asymmetric] = examplePresets()
  assert.notEqual(generic.agents.length, asymmetric.agents.length)
  assert.ok(asymmetric.agents.some(agent => agent.triggers.some(trigger => trigger.type === 'requested_by_agent')))
})
