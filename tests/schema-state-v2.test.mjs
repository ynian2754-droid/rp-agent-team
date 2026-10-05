import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  createAgent,
  defaultTeamConfig,
  evaluateCondition,
  examplePresets,
  exportPreset,
  normalizeTeamConfig,
  parsePreset
} from '../src/shared/schema.mjs'
import { migrateV1ToV2 } from '../src/host/migrations/v1-to-v2.mjs'
import { TeamConfigStore } from '../src/host/config-store.mjs'
import { StateStore, versionForPath } from '../src/host/state-store.mjs'

async function inTempHome(run) {
  const home = mkdtempSync(join(tmpdir(), 'rp-team-v2-'))
  try { return await run(home) } finally { rmSync(home, { recursive: true, force: true }) }
}

function legacyConfig() {
  return {
    lead: {
      id: 'lead', name: 'lead', role: 'lead', modelRef: { provider: 'local', model: 'rp-large' },
      parameters: { temperature: 0.4, topP: 0.8 }, systemPrompt: 'Keep the scene coherent.', presetId: 'rp-roleplay',
      context: 'fork', capabilities: [{ id: 'builtin:web', enabled: true }], compaction: { autoCompactTokenLimit: 800 }, required: true
    },
    members: [
      { id: 'old-a', name: 'Old A', role: 'teammate', modelRef: 'inherit', parameters: {}, systemPrompt: 'Observe.', presetId: 'observer', context: 'fresh', capabilities: [], compaction: {}, task: 'Watch continuity.', required: true },
      { id: 'old-b', name: 'Old B', role: 'teammate', modelRef: 'inherit', parameters: {}, systemPrompt: 'Act.', presetId: '', context: 'fresh', capabilities: [], compaction: {}, task: 'Advance the scene.', required: false }
    ]
  }
}

test('default and asymmetric examples are normalized V2 configs with an authorized publisher', () => {
  const [neutral, asymmetric] = examplePresets()
  assert.equal(neutral.schemaVersion, 2)
  assert.equal(neutral.agents.length, 2)
  assert.ok(neutral.agents.every(agent => agent.name && agent.description && agent.systemPrompt))
  assert.deepEqual(neutral.agents[0].communication.sendTo, ['agent-2'])
  assert.deepEqual(neutral.agents[1].context.sources.map(source => source.type), [
    'current_input', 'recent_history', 'character_card', 'agent_messages'
  ])
  assert.deepEqual(neutral.agents[1].context.sources[3].agentIds, ['agent-1'])
  assert.equal(neutral.agents.find(agent => agent.id === neutral.output.agentId).outputAuthority.user, true)
  assert.equal(neutral.agents[0].triggers[0].type, 'always')
  assert.equal(neutral.agents[1].triggers[0].type, 'always')
  assert.deepEqual(neutral.agents[1].execution.after, ['agent-1'])
  assert.equal(asymmetric.agents.length, 4)
  assert.equal(asymmetric.output.agentId, 'agent-4')
  assert.equal(asymmetric.agents[2].triggers[0].type, 'always')
  assert.deepEqual(asymmetric.agents[2].execution.after, ['agent-1', 'agent-2'])
  assert.match(asymmetric.agents[0].systemPrompt, /do not wait or poll during this activation/u)
  assert.match(asymmetric.agents[1].systemPrompt, /rp_team_send before returning/u)
  assert.match(asymmetric.agents[2].systemPrompt, /without inventing a memory result/u)
  assert.equal(asymmetric.agents[3].triggers[0].type, 'always')
  assert.deepEqual(asymmetric.agents[3].execution.after, ['agent-3'])
  assert.deepEqual(asymmetric.agents[3].communication.receiveFrom, ['agent-2', 'agent-3'])
  assert.deepEqual(asymmetric.agents[2].capabilities, [])
  assert.ok(asymmetric.state.definitions.some(item => item.namespace === 'world' && item.path === '/variables/truth'))
  assert.ok(!asymmetric.agents[3].statePermissions.some(item => item.namespace === 'world'))
  assert.ok(!asymmetric.agents[3].context.sources.some(source => source.type === 'hidden_state'))
  assert.deepEqual(asymmetric.state.definitions.find(item => item.namespace === 'shared' && item.path === '/perceptions/agent-3').default, {
    belief: 'The visitor may be a courier.'
  })
  assert.throws(() => normalizeTeamConfig({ ...neutral, agents: neutral.agents.map(agent => ({ ...agent, outputAuthority: { ...agent.outputAuthority, user: false } })) }), /user output authority/)
  assert.deepEqual(createAgent({ outputAuthority: { user: true } }).outputAuthority, {
    internal: true, draft: true, state: false, user: true
  })
})

test('V2 config preserves repeated context rows and rejects an unfinished null selector', () => {
  const config = defaultTeamConfig()
  config.agents[0].context.sources = [
    { type: 'character_card', selector: '/id' },
    { type: 'character_card', selector: '/persona' }
  ]
  const normalized = normalizeTeamConfig(config)
  assert.deepEqual(normalized.agents[0].context.sources, config.agents[0].context.sources)
  assert.deepEqual(parsePreset(JSON.stringify(exportPreset(normalized))).agents[0].context.sources,
    config.agents[0].context.sources)

  const unfinished = structuredClone(config)
  unfinished.agents[0].context.sources.push({ type: 'character_card', selector: null })
  assert.throws(() => normalizeTeamConfig(unfinished), /JSON Pointers/u)
})

test('normalization validates roster and declared state references; condition AST evaluates projected data', () => {
  const config = defaultTeamConfig()
  config.state.definitions = [
    { namespace: 'shared', path: '/flag', type: 'boolean', default: false },
    { namespace: 'world', path: '/missing', type: 'any' }
  ]
  config.agents[0].statePermissions = [
    { namespace: 'shared', path: '/flag', access: 'read' },
    { namespace: 'world', path: '/missing', access: 'read' }
  ]
  config.agents[0].triggers = [{
    type: 'condition',
    condition: { op: 'all', conditions: [
      { op: 'exists', namespace: 'shared', path: '/flag' },
      { op: 'compare', namespace: 'shared', path: '/flag', operator: 'eq', value: true },
      { op: 'not', condition: { op: 'exists', namespace: 'world', path: '/missing' } }
    ] }
  }]
  assert.equal(normalizeTeamConfig(config).agents[0].triggers[0].type, 'condition')
  assert.equal(evaluateCondition({ shared: { flag: true }, world: {} }, config.agents[0].triggers[0].condition), true)
  assert.equal(evaluateCondition({ shared: { flag: false }, world: {} }, config.agents[0].triggers[0].condition), false)
  const unknownAgent = defaultTeamConfig()
  unknownAgent.agents[0].communication.sendTo = ['missing']
  assert.throws(() => normalizeTeamConfig(unknownAgent), /unknown agent missing/)
  const undeclaredState = defaultTeamConfig()
  undeclaredState.agents[0].triggers = [{ type: 'condition', condition: { op: 'exists', namespace: 'shared', path: '/flag' } }]
  assert.throws(() => normalizeTeamConfig(undeclaredState), /undeclared state path/)
  const rootDefinition = defaultTeamConfig()
  rootDefinition.state.definitions = [{ namespace: 'shared', path: '', type: 'object' }]
  rootDefinition.agents[0].statePermissions = [{ namespace: 'shared', path: '', access: 'read' }]
  rootDefinition.agents[0].triggers = [{ type: 'condition', condition: { op: 'exists', namespace: 'shared', path: '/flag' } }]
  assert.equal(normalizeTeamConfig(rootDefinition).agents[0].triggers[0].type, 'condition')
  const unreadableCondition = defaultTeamConfig()
  unreadableCondition.state.definitions = [{ namespace: 'shared', path: '/flag', type: 'boolean' }]
  unreadableCondition.agents[0].triggers = [{ type: 'condition', condition: { op: 'exists', namespace: 'shared', path: '/flag' } }]
  assert.throws(() => normalizeTeamConfig(unreadableCondition), /unreadable state path/)
  unreadableCondition.agents[0].statePermissions = [
    { namespace: 'shared', path: '', access: 'read' },
    { namespace: 'shared', path: '/flag', access: 'none' }
  ]
  assert.throws(() => normalizeTeamConfig(unreadableCondition), /unreadable state path/)
  const redactedCondition = defaultTeamConfig()
  redactedCondition.state.definitions = [{ namespace: 'shared', path: '/safe', type: 'object' }]
  redactedCondition.agents[0].statePermissions = [
    { namespace: 'shared', path: '/safe', access: 'read' },
    { namespace: 'shared', path: '/safe/secret', access: 'none' }
  ]
  redactedCondition.agents[0].triggers = [{ type: 'condition', condition: { op: 'exists', namespace: 'shared', path: '/safe/secret' } }]
  assert.throws(() => normalizeTeamConfig(redactedCondition), /unreadable state path/)
  const unknownField = defaultTeamConfig()
  unknownField.unsafe = true
  assert.throws(() => normalizeTeamConfig(unknownField), /unsupported fields/)
  const duplicateSource = defaultTeamConfig()
  duplicateSource.agents[0].context.sources.push({ type: 'recent_history', limit: 4 })
  assert.deepEqual(normalizeTeamConfig(duplicateSource).agents[0].context.sources.filter(source => source.type === 'recent_history'), [
    { type: 'recent_history', limit: 12 }, { type: 'recent_history', limit: 4 }
  ])
  const conflictingPermission = defaultTeamConfig()
  conflictingPermission.agents[0].statePermissions = [
    { namespace: 'shared', path: '/flag', access: 'read' },
    { namespace: 'shared', path: '/flag', access: 'none' }
  ]
  assert.throws(() => normalizeTeamConfig(conflictingPermission), /Duplicate state permission/)
  const unknownPrivateOwner = defaultTeamConfig()
  unknownPrivateOwner.state.definitions = [{ namespace: 'private:missing', path: '/note', type: 'string' }]
  assert.throws(() => normalizeTeamConfig(unknownPrivateOwner), /unknown private agent missing/)
})

test('execution dependencies reject self-dependencies and cycles', () => {
  const self = defaultTeamConfig()
  self.agents[0].execution.after = ['agent-1']
  assert.throws(() => normalizeTeamConfig(self), /dependencies contain a cycle/)
  const cycle = defaultTeamConfig()
  cycle.agents[0].execution.after = ['agent-2']
  assert.throws(() => normalizeTeamConfig(cycle), /dependencies contain a cycle/)
})

test('preset export retains native settings and topP while removing credential-shaped metadata', () => {
  const config = defaultTeamConfig()
  config.metadata = { label: 'portable', apiKey: 'must-not-export', nested: { access_token: 'also-secret', note: 'keep' } }
  config.agents[1].modelRef = { provider: 'local', model: 'rp-large' }
  config.agents[1].parameters = { temperature: 0.5, topP: 0.73, maxTokens: 900 }
  config.agents[1].presetId = 'native-rp'
  config.agents[1].capabilities = [{ id: 'native:preset', enabled: true }]
  config.agents[1].execution.trustedTools = ['test:trusted']
  config.agents[0].presetId = 'observer'
  config.agents[0].capabilities = [{ id: 'test:disabled', enabled: false }]
  config.agents[0].execution.trustedTools = ['test:custom']
  const payload = exportPreset(config)
  assert.equal(payload.format, 'rp-team-preset-v2')
  assert.deepEqual(payload.dependencies, {
    presets: ['native-rp', 'observer'],
    models: [{ provider: 'local', model: 'rp-large' }],
    toolGroups: ['native:preset', 'test:custom', 'test:trusted']
  })
  assert.deepEqual(Object.keys(payload).sort(), ['config', 'dependencies', 'format'])
  assert.equal(payload.config.metadata.apiKey, undefined)
  assert.deepEqual(payload.config.metadata.nested, { note: 'keep' })
  assert.equal(payload.config.agents[1].parameters.topP, 0.73)
  assert.deepEqual(payload.config.agents[1].capabilities, [{ id: 'native:preset', enabled: true }])
  assert.deepEqual(parsePreset(JSON.stringify(payload)), payload.config)
  assert.throws(() => parsePreset({ ...payload, config: { ...payload.config, surprise: true } }), /unsupported fields/)
})

test('V1 migration preserves member identity, prompts, models, context, capabilities and its fixed topology', () => {
  const migrated = migrateV1ToV2(legacyConfig())
  assert.equal(migrated.output.agentId, 'lead')
  assert.equal(migrated.metadata.migration, 'rp-team-config-v1')
  assert.equal(migrated.metadata.fixedLegacyTopology, true)
  assert.deepEqual(migrated.metadata.requiredAgentIds, ['lead', 'old-a'])
  assert.deepEqual(migrated.agents.map(agent => agent.id), ['lead', 'old-a', 'old-b'])
  assert.equal(migrated.agents[0].systemPrompt, 'Keep the scene coherent.')
  assert.equal(migrated.agents[0].parameters.topP, 0.8)
  assert.equal(migrated.agents[0].modelRef.model, 'rp-large')
  assert.ok(migrated.agents[0].context.sources.some(source => source.type === 'full_history'))
  assert.ok(migrated.agents[0].context.sources.some(source => source.type === 'recent_history'))
  assert.deepEqual(migrated.agents.map(agent => agent.triggers), [
    [{ type: 'always' }], [{ type: 'always' }], [{ type: 'always' }]
  ])
  assert.deepEqual(migrated.agents[0].execution.after, ['old-a', 'old-b'])
  assert.deepEqual(migrated.agents[1].execution.after, [])
  assert.deepEqual(migrated.agents[0].execution.trustedTools, ['builtin:web'])
  assert.deepEqual(migrated.agents.map(agent => agent.statePermissions), [
    [{ namespace: 'world', path: '', access: 'readwrite' }],
    [{ namespace: 'world', path: '', access: 'readwrite' }],
    [{ namespace: 'world', path: '', access: 'readwrite' }]
  ])
  assert.deepEqual(migrated.state.definitions, [{ namespace: 'world', path: '', type: 'object' }])
  assert.deepEqual(migrated.agents[0].communication.requestTo, ['old-a', 'old-b'])
  assert.equal(migrated.agents[2].outputAuthority.user, false)
  assert.deepEqual(parsePreset(legacyConfig()), migrated)
  assert.deepEqual(parsePreset({ format: 'rp-team-config-v1', config: legacyConfig() }), migrated)
})

test('ConfigStore lazily reads V1, backs up before first V2 save, keeps CAS and round-trips exports', async () => {
  await inTempHome(async home => {
    const directory = join(home, 'plugins', 'rp-agent-team')
    const oldPath = join(directory, 'conversations.json')
    const backupPath = join(directory, 'conversations.v1.backup.json')
    const oldDocument = {
      version: 1,
      conversations: {
        'conversation-1': {
          enabled: true, revision: 4, config: legacyConfig(),
          runtimeBindings: { 'root-session': { revision: 4, runId: 'r1', updatedAt: '2026-10-01T00:00:00.000Z' } }
        }
      }
    }
    mkdirSync(directory, { recursive: true })
    writeFileSync(oldPath, `${JSON.stringify(oldDocument, null, 2)}\n`)
    const store = new TeamConfigStore(home)
    const loaded = store.get('conversation-1')
    assert.equal(loaded.revision, 4)
    assert.equal(loaded.config.schemaVersion, 2)
    assert.equal(loaded.config.agents[0].id, 'lead')
    assert.equal(JSON.parse(readFileSync(oldPath, 'utf8')).version, 1)

    const changed = structuredClone(loaded.config)
    changed.name = 'Migrated and edited'
    await assert.rejects(store.save({ conversationId: 'conversation-1', expectedRevision: 3, enabled: true, config: changed }), { code: 'RP_TEAM_CONFIG_CONFLICT' })
    const saved = await store.save({ conversationId: 'conversation-1', expectedRevision: 4, enabled: true, config: changed })
    assert.equal(saved.revision, 5)
    assert.equal(saved.config.name, 'Migrated and edited')
    assert.equal(JSON.parse(readFileSync(oldPath, 'utf8')).version, 2)
    assert.deepEqual(JSON.parse(readFileSync(backupPath, 'utf8')), oldDocument)
    assert.ok(saved.config.agents[0].id === 'lead')
    assert.equal(store.latestRuntimeBinding('conversation-1').rootSessionId, 'root-session')
    const exported = store.export('conversation-1')
    assert.equal(exported.format, 'rp-team-preset-v2')
    assert.deepEqual(store.import(exported), saved.config)
    const specialId = await store.save({ conversationId: '__proto__', expectedRevision: 0, enabled: true, config: defaultTeamConfig() })
    assert.equal(specialId.revision, 1)
    assert.equal(store.get('__proto__').config.schemaVersion, 2)
    assert.equal({}.config, undefined)
  })
})

test('StateStore enforces ACLs and staged per-path CAS, then recovers state from a product receipt', async () => {
  await inTempHome(async home => {
    const config = defaultTeamConfig()
    config.state.definitions = [
      { namespace: 'shared', path: '/score', type: 'number', default: 0 },
      { namespace: 'private:agent-1', path: '/notes', type: 'string', default: '' },
      { namespace: 'world', path: '/variables/truth', type: 'object', default: {} },
      { namespace: 'world', path: '/settings', type: 'object', default: {} }
    ]
    config.agents[0].statePermissions = [
      { namespace: 'shared', path: '/score', access: 'write' },
      { namespace: 'private:agent-1', path: '/notes', access: 'readwrite' },
      { namespace: 'world', path: '/variables/truth', access: 'readwrite' },
      { namespace: 'world', path: '/settings', access: 'readwrite' }
    ]
    config.agents[1].statePermissions = [{ namespace: 'shared', path: '/score', access: 'readwrite' }]
    const store = new StateStore(home)
    const begun = store.begin({
      conversationId: 'conversation-1', runId: 'run-1', config,
      initialState: { world: { variables: { truth: { door: 'locked' } }, settings: { 'scene.md': 'A room.', 'chapters/scene.md': 'Old text.' } } }
    })
    assert.equal(begun.status, 'open')
    assert.throws(() => store.read({ conversationId: 'conversation-1', runId: 'run-1', agentId: 'agent-1', namespace: 'forbidden', path: '/score' }), {
      code: 'RP_TEAM_STATE_PATH_INVALID'
    })
    assert.deepEqual(store.version({ conversationId: 'conversation-1', runId: 'run-1', agentId: 'agent-1', namespace: 'shared', path: '/score' }), { version: 0 })
    assert.throws(() => store.read({ conversationId: 'conversation-1', runId: 'run-1', agentId: 'agent-1', namespace: 'shared', path: '/score' }), { code: 'RP_TEAM_STATE_FORBIDDEN' })
    const firstView = store.read({ conversationId: 'conversation-1', runId: 'run-1', agentId: 'agent-2', namespace: 'shared', path: '/score' })
    assert.deepEqual(firstView, { value: 0, version: 0 })
    store.write({ conversationId: 'conversation-1', runId: 'run-1', agentId: 'agent-1', namespace: 'shared', path: '/score', value: 10, expectedVersion: 0 })
    assert.throws(() => store.write({ conversationId: 'conversation-1', runId: 'run-1', agentId: 'agent-2', namespace: 'shared', path: '/score', value: 20, expectedVersion: firstView.version }), { code: 'RP_TEAM_STATE_CONFLICT' })
    const updated = store.read({ conversationId: 'conversation-1', runId: 'run-1', agentId: 'agent-2', namespace: 'shared', path: '/score' })
    assert.deepEqual(updated, { value: 10, version: 1 })
    store.write({ conversationId: 'conversation-1', runId: 'run-1', agentId: 'agent-2', namespace: 'shared', path: '/score', value: 11, expectedVersion: updated.version })
    assert.equal(store.read({ conversationId: 'conversation-1', runId: 'run-1', agentId: 'agent-1', namespace: 'world', path: '/settings/chapters~1scene.md' }).value, 'Old text.')
    store.write({ conversationId: 'conversation-1', runId: 'run-1', agentId: 'agent-1', namespace: 'world', path: '/settings/chapters~1scene.md', value: 'New text.', expectedVersion: 0 })
    assert.throws(() => store.write({ conversationId: 'conversation-1', runId: 'run-1', agentId: 'agent-1', namespace: 'world', path: '/settings/chapters/scene.md', value: 'nested path', expectedVersion: 0 }), { code: 'RP_TEAM_STATE_TYPE_MISMATCH' })
    assert.throws(() => store.write({ conversationId: 'conversation-1', runId: 'run-1', agentId: 'agent-1', namespace: 'world', path: '/settings/scene.md', value: null, expectedVersion: 0 }), { code: 'RP_TEAM_STATE_TYPE_MISMATCH' })
    const pending = store.stage({ conversationId: 'conversation-1', runId: 'run-1' })
    assert.equal(pending.status, 'pending')
    assert.deepEqual(pending.writes, [
      { namespace: 'shared', path: '/score', value: 11, expectedVersion: 0, agentId: 'agent-2' },
      { namespace: 'world', path: '/settings/chapters~1scene.md', value: 'New text.', expectedVersion: 0, agentId: 'agent-1' }
    ])

    const recovered = new StateStore(home)
    assert.equal(recovered.status({ conversationId: 'conversation-1', runId: 'run-1' }).status, 'pending')
    const unknown = await recovered.recover(async () => ({ outcome: 'unknown' }))
    assert.equal(unknown[0].status, 'pending')
    const committed = await recovered.recover(async ({ receiptKey }) => ({ outcome: 'committed', receiptKey, productMessageId: 'message-7' }))
    assert.equal(committed[0].status, 'committed')
    assert.equal(recovered.begin({
      conversationId: 'conversation-1', runId: 'run-2', config,
      initialState: { world: { variables: { truth: { door: 'open' } }, settings: {} } }
    }).state.shared.score, 11)
    assert.equal(recovered.status({ conversationId: 'conversation-1', runId: 'run-1' }).receipt.productMessageId, 'message-7')
    assert.equal(recovered.commit({ conversationId: 'conversation-1', runId: 'run-1', receipt: { outcome: 'committed' } }).status, 'committed')
  })
})

test('StateStore redacts denied descendants and blocks parent writes that would overwrite them', async () => {
  await inTempHome(async home => {
    const config = defaultTeamConfig()
    config.state.definitions = [
      { namespace: 'shared', path: '/safe', type: 'object', default: { public: 'ok', secret: 'private', 'a/b': 'escaped' } },
      { namespace: 'shared', path: '/safe/a~1b', type: 'string' }
    ]
    config.agents[0].statePermissions = [
      { namespace: 'shared', path: '/safe', access: 'readwrite' },
      { namespace: 'shared', path: '/safe/secret', access: 'none' }
    ]
    const store = new StateStore(home)
    store.begin({ conversationId: 'conversation-1', runId: 'run-1', config })
    const parentRead = store.read({ conversationId: 'conversation-1', runId: 'run-1', agentId: 'agent-1', namespace: 'shared', path: '/safe' })
    assert.deepEqual(parentRead, { value: { public: 'ok', 'a/b': 'escaped' }, version: 0 })
    assert.equal(store.read({ conversationId: 'conversation-1', runId: 'run-1', agentId: 'agent-1', namespace: 'shared', path: '/safe/a~1b' }).value, 'escaped')
    assert.throws(() => store.read({ conversationId: 'conversation-1', runId: 'run-1', agentId: 'agent-1', namespace: 'shared', path: '/safe/secret' }), { code: 'RP_TEAM_STATE_FORBIDDEN' })
    assert.throws(() => store.write({
      conversationId: 'conversation-1', runId: 'run-1', agentId: 'agent-1', namespace: 'shared', path: '/safe',
      value: { public: 'changed', secret: 'overwrite' }, expectedVersion: 0
    }), { code: 'RP_TEAM_STATE_FORBIDDEN' })
  })
})

test('StateStore treats JSON Pointer magic names as ordinary own keys and isolates prototype-like run ids', async () => {
  await inTempHome(async home => {
    const config = defaultTeamConfig()
    config.state.definitions = [{ namespace: 'shared', path: '', type: 'object', default: {} }]
    config.agents[0].statePermissions = [{ namespace: 'shared', path: '', access: 'readwrite' }]
    const store = new StateStore(home)
    store.begin({ conversationId: '__proto__', runId: '__proto__', config })
    store.write({ conversationId: '__proto__', runId: '__proto__', agentId: 'agent-1', namespace: 'shared', path: '/__proto__/polluted', value: true, expectedVersion: 0 })
    assert.equal(store.read({ conversationId: '__proto__', runId: '__proto__', agentId: 'agent-1', namespace: 'shared', path: '/__proto__/polluted' }).value, true)
    assert.equal({}.polluted, undefined)
    assert.equal(store.status({ conversationId: '__proto__', runId: '__proto__' }).status, 'open')
  })
})

test('StateStore snapshots root versions without making sibling leaf writes conflict', async () => {
  await inTempHome(async home => {
    const config = defaultTeamConfig()
    config.state.definitions = [{ namespace: 'shared', path: '', type: 'object', default: {} }]
    config.agents[0].statePermissions = [{ namespace: 'shared', path: '', access: 'readwrite' }]
    const store = new StateStore(home)
    store.begin({
      conversationId: 'conversation-1', runId: 'run-1', config,
      initialState: { shared: { tree: { a: 1, b: 2 } } }
    })
    const capturedBeforeWrite = store.versionsSnapshot({ conversationId: 'conversation-1', runId: 'run-1' })
    store.write({
      conversationId: 'conversation-1', runId: 'run-1', agentId: 'agent-1',
      namespace: 'shared', path: '/tree', value: { a: 1, b: 2, c: 3 }, expectedVersion: 0
    })
    const capturedAfterRootWrite = store.versionsSnapshot({ conversationId: 'conversation-1', runId: 'run-1' })
    assert.deepEqual(capturedBeforeWrite, {})
    assert.equal(versionForPath(capturedAfterRootWrite, 'shared', '/tree/a'), 1)
    assert.equal(versionForPath(capturedAfterRootWrite, 'shared', '/tree/b'), 1)

    store.write({
      conversationId: 'conversation-1', runId: 'run-1', agentId: 'agent-1',
      namespace: 'shared', path: '/tree/a', value: 4, expectedVersion: 1
    })
    const capturedAfterLeafWrite = store.versionsSnapshot({ conversationId: 'conversation-1', runId: 'run-1' })
    assert.equal(versionForPath(capturedAfterLeafWrite, 'shared', '/tree/a'), 2)
    assert.equal(versionForPath(capturedAfterLeafWrite, 'shared', '/tree/b'), 1)
    assert.throws(() => store.write({
      conversationId: 'conversation-1', runId: 'run-1', agentId: 'agent-1',
      namespace: 'shared', path: '/tree/a', value: 5, expectedVersion: 1
    }), { code: 'RP_TEAM_STATE_CONFLICT' })
    assert.doesNotThrow(() => store.write({
      conversationId: 'conversation-1', runId: 'run-1', agentId: 'agent-1',
      namespace: 'shared', path: '/tree/b', value: 6, expectedVersion: 1
    }))
  })
})

test('StateStore imports explicit pre-run checkpoints for migrated runs that have no state journal', async () => {
  await inTempHome(async home => {
    const store = new StateStore(home)
    const conversationId = 'migrated-conversation'
    const runId = 'preserved-legacy-run-id'
    const emptyLegacyBaseline = { revision: 0, namespaces: {}, pathVersions: {} }
    assert.deepEqual(store.importCommittedBaseline({ conversationId, runId, snapshot: emptyLegacyBaseline }), emptyLegacyBaseline)
    assert.deepEqual(store.importCommittedBaseline({ conversationId, runId, snapshot: emptyLegacyBaseline }), emptyLegacyBaseline,
      'repeated host migration imports are idempotent')
    assert.deepEqual(store.committedBaseline({ conversationId, runId }), emptyLegacyBaseline)

    store.restoreCommittedSnapshot({ conversationId, snapshot: {
      revision: 2, namespaces: { shared: { progress: 'after the legacy turn' } },
      pathVersions: { [JSON.stringify(['shared', '/progress'])]: 2 }
    } })
    store.restoreCommittedSnapshot({ conversationId, snapshot: store.committedBaseline({ conversationId, runId }) })
    assert.deepEqual(store.committedSnapshot({ conversationId }), emptyLegacyBaseline,
      'rewind restores the explicitly imported pre-run plugin state')
    assert.throws(() => store.importCommittedBaseline({ conversationId, runId,
      snapshot: { revision: 1, namespaces: {}, pathVersions: {} } }), { code: 'RP_TEAM_STATE_BASELINE_CONFLICT' })
  })
})

test('StateStore journals ACL-checked removals, rolls them back, commits them, and rejects stale parallel removals', async () => {
  await inTempHome(async home => {
    const config = defaultTeamConfig()
    config.state.definitions = [{ namespace: 'shared', path: '', type: 'object', default: {} }]
    config.agents[0].statePermissions = [
      { namespace: 'shared', path: '', access: 'readwrite' },
      { namespace: 'shared', path: '/tree/secret', access: 'none' }
    ]
    const store = new StateStore(home)
    const initialState = { shared: { tree: { first: 'keep', secret: 'private', second: 'also keep' } } }
    store.begin({ conversationId: 'conversation-1', runId: 'rollback-remove', config, initialState })
    assert.throws(() => store.remove({
      conversationId: 'conversation-1', runId: 'rollback-remove', agentId: 'agent-1',
      namespace: 'shared', path: '/tree', expectedVersion: 0
    }), { code: 'RP_TEAM_STATE_FORBIDDEN' }, 'a parent deletion cannot erase a denied child')
    store.remove({
      conversationId: 'conversation-1', runId: 'rollback-remove', agentId: 'agent-1',
      namespace: 'shared', path: '/tree/first', expectedVersion: 0
    })
    assert.equal(store.read({
      conversationId: 'conversation-1', runId: 'rollback-remove', agentId: 'agent-1',
      namespace: 'shared', path: '/tree/first'
    }).value, undefined)
    assert.equal(store.status({ conversationId: 'conversation-1', runId: 'rollback-remove' }).writes[0].operation, 'remove')
    store.rollback({ conversationId: 'conversation-1', runId: 'rollback-remove' })

    store.begin({ conversationId: 'conversation-1', runId: 'commit-remove', config, initialState })
    store.remove({
      conversationId: 'conversation-1', runId: 'commit-remove', agentId: 'agent-1',
      namespace: 'shared', path: '/tree/first', expectedVersion: 0
    })
    const pending = store.stage({ conversationId: 'conversation-1', runId: 'commit-remove' })
    assert.deepEqual(pending.writes, [{
      namespace: 'shared', path: '/tree/first', operation: 'remove', expectedVersion: 0, agentId: 'agent-1'
    }])

    store.begin({ conversationId: 'conversation-1', runId: 'parallel-remove', config, initialState })
    store.remove({
      conversationId: 'conversation-1', runId: 'parallel-remove', agentId: 'agent-1',
      namespace: 'shared', path: '/tree/first', expectedVersion: 0
    })
    store.commit({ conversationId: 'conversation-1', runId: 'commit-remove', receipt: { outcome: 'committed' } })
    assert.throws(() => store.stage({ conversationId: 'conversation-1', runId: 'parallel-remove' }), { code: 'RP_TEAM_STATE_CONFLICT' })
    store.rollback({ conversationId: 'conversation-1', runId: 'parallel-remove' })

    const afterCommit = store.begin({ conversationId: 'conversation-1', runId: 'verify-remove', config, initialState })
    assert.deepEqual(afterCommit.state.shared.tree, { secret: 'private', second: 'also keep' })
  })
})

