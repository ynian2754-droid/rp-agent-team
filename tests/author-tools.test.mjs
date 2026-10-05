import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { PresetLibrary } from '../src/host/preset-library.mjs'
import { createAuthorToolsApi } from '../src/host/author-tools.mjs'
import { childPolicy } from '../src/host/agent-context.mjs'
import { exportComponent, prepareComponentImport } from '../src/shared/components.mjs'
import { defaultTeamConfig } from '../src/shared/schema.mjs'

test('preset IDs that match object keys remain ordinary persistent records', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'rp-team-preset-id-'))
  try {
    const library = new PresetLibrary(join(directory, 'presets.json'))
    const config = defaultTeamConfig()
    config.id = '__proto__'
    const saved = await library.save(config)
    assert.equal(library.get(config.id).hash, saved.hash)
    assert.deepEqual(library.list().map(item => item.id), [config.id])
    assert.deepEqual(await library.delete(config.id), { deleted: true })
    assert.deepEqual(library.list(), [])
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('author preview hashes complete source snapshots and never inspects executable option scopes', async () => {
  let history = [{ role: 'user', content: 'First turn' }]
  let authorBusy = false
  let stateRevision = 0
  const ctx = { eleckoiStoryState: { authorSnapshot: async () => ({
    context: { currentUserInput: 'Continue', history, characterName: 'Aster', persona: { name: 'Aster' } },
    world: { variables: { scene: { place: 'garden' } } },
    baseHash: 'same-world-hash', anchor: { sessionId: 'session-1', turn: 1 }, busy: false
  }) } }
  const api = createAuthorToolsApi({
    ctx,
    store: { path: join(tmpdir(), 'never-opened-store.json') },
    getOptions() { throw new Error('preview must not inspect executable option scopes') },
    readState: async () => ({ values: [], busy: authorBusy, revision: stateRevision })
  })
  const config = defaultTeamConfig()
  config.agents[0].context.sources = [{ type: 'current_input' }, { type: 'recent_history' }]

  const firstCatalog = await api.getContextCatalog({ conversationId: 'conversation-1' })
  const first = await api.previewConfig({ conversationId: 'conversation-1', config })
  assert.equal(first.members[0].context.current_input.text, 'Continue')
  assert.deepEqual(first.members[0].context.recent_history, history)
  assert.equal(first.members[0].triggered, true)

  history = [...history, { role: 'assistant', content: 'A reply' }]
  authorBusy = true
  const secondCatalog = await api.getContextCatalog({ conversationId: 'conversation-1' })
  assert.notEqual(firstCatalog.version, secondCatalog.version, 'history changes invalidate the source snapshot even when baseHash is unchanged')
  const busyPreview = await api.previewConfig({ conversationId: 'conversation-1', config })
  assert.ok(busyPreview.members[0].dynamic.some(message => message.includes('Conversation is busy')))
  const beforeStateChange = busyPreview.sourceVersion
  stateRevision++
  const changedStatePreview = await api.previewConfig({ conversationId: 'conversation-1', config })
  const changedStateCatalog = await api.getContextCatalog({ conversationId: 'conversation-1' })
  assert.notEqual(changedStatePreview.sourceVersion, beforeStateChange, 'shared/private author edits also invalidate a preview')
  assert.equal(changedStateCatalog.version, changedStatePreview.sourceVersion)
})

test('preview applies draft defaults without persistence and uses runtime nested ACL redaction', async () => {
  const config = defaultTeamConfig()
  config.state.definitions = [{
    namespace: 'world', path: '/profile', type: 'object',
    default: { public: 'draft default', secret: 'never show' }
  }]
  const agent = config.agents[0]
  agent.statePermissions = [
    { namespace: 'world', path: '/profile', access: 'read' },
    { namespace: 'world', path: '/profile/secret', access: 'none' }
  ]
  agent.context.sources = [{ type: 'hidden_state', selector: '/profile' }]
  agent.triggers = [{ type: 'condition', condition: {
    op: 'compare', namespace: 'world', path: '/profile/public', operator: 'eq', value: 'draft default'
  } }]
  const ctx = { eleckoiStoryState: { authorSnapshot: async () => ({
    context: { currentUserInput: 'Hello', history: [] }, world: {},
    baseHash: 'unchanged', anchor: { sessionId: 'session-1', turn: 0 }, busy: false
  }) } }
  const api = createAuthorToolsApi({
    ctx, store: { path: join(tmpdir(), 'unused-state.json') },
    readState: async () => ({
      definitions: [{ namespace: 'world', path: '/profile', type: 'object', default: { public: 'saved default' } }],
      values: [{ namespace: 'world', path: '/profile', missing: true, initial: { public: 'saved default' }, version: 0 }]
    })
  })

  const preview = await api.previewConfig({ conversationId: 'conversation-1', config })
  assert.equal(preview.members[0].triggered, true)
  assert.deepEqual(preview.members[0].context.hidden_state, { public: 'draft default' })
  assert.equal(JSON.stringify(preview.members[0].context).includes('never show'), false)
})

test('preview reports messages and drafts as dynamic instead of fabricating future values', async () => {
  const config = defaultTeamConfig()
  config.agents[0].context.sources = [
    { type: 'agent_messages', selector: '/summary' },
    { type: 'drafts', selector: '/text' }
  ]
  const ctx = { eleckoiStoryState: { authorSnapshot: async () => ({
    context: { currentUserInput: 'Hello', history: [] }, world: {}, baseHash: 'hash', anchor: null, busy: false
  }) } }
  const api = createAuthorToolsApi({ ctx, store: { path: join(tmpdir(), 'unused-state.json') }, readState: async () => ({ definitions: [], values: [] }) })
  const preview = await api.previewConfig({ conversationId: 'conversation-1', config })
  const member = preview.members[0]
  assert.deepEqual(member.context, {})
  assert.deepEqual(member.missingSelections, [])
  assert.equal(member.dynamic.filter(message => /messages|drafts/u.test(message)).length, 2)
})

test('preset versions are immutable, persistent, and portable without secret metadata', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'rp-team-presets-'))
  try {
    const path = join(directory, 'presets.json')
    const library = new PresetLibrary(path)
    const config = defaultTeamConfig()
    config.metadata = { author: 'Ada', nested: { apiKey: 'remove-me' } }
    const saved = await library.save(config)
    assert.equal((await library.save(config)).hash, saved.hash)
    assert.equal(new PresetLibrary(path).get(config.id, config.version).hash, saved.hash)
    assert.deepEqual(new PresetLibrary(path).list().map(item => item.id), [config.id])
    const api = createAuthorToolsApi({ presetLibrary: library })
    assert.deepEqual(api.listPresets().presets.map(item => item.id), [config.id])
    assert.equal(api.getPreset({ id: config.id }).version, config.version, 'library reads do not need a conversation id')

    const changed = structuredClone(config)
    changed.name = 'Changed without changing version'
    await assert.rejects(library.save(changed), { code: 'RP_TEAM_PRESET_CONFLICT' })

    const portable = library.export(config.id)
    assert.equal(portable.config.metadata.nested.apiKey, undefined)
    assert.equal((await library.import(portable)).hash, saved.hash)
    changed.version = '1.0.1'
    const nextVersion = await library.save(changed)
    assert.equal(nextVersion.version, '1.0.1')
    assert.deepEqual(library.list()[0].versions.map(item => item.version), ['1.0.0', '1.0.1'])
    const copied = await library.copy({ id: config.id, name: 'Independent copy' })
    assert.notEqual(copied.id, config.id)
    assert.equal((await library.delete(copied.id)).deleted, true)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('component import expands external refs into deterministic ports and never edits literal prompt IDs', () => {
  const source = defaultTeamConfig()
  source.agents[0].systemPrompt = 'Coordinate with agent-2 as described in this prose.'
  source.agents[0].communication.sendTo = ['*']
  const component = exportComponent(source, ['agent-1'], 'Researcher')
  const externalAgentPort = component.ports.find(port => port.kind === 'agent')
  assert.ok(externalAgentPort)
  assert.ok(!component.agents.some(agent => Object.values(agent.communication).flat().includes('*')))

  const target = defaultTeamConfig()
  const prepared = prepareComponentImport({
    config: target,
    component,
    importId: 'batch-one',
    bindings: { agents: { [externalAgentPort.id]: 'agent-2' } }
  })
  assert.ok(prepared.config)
  assert.equal(prepared.agentIdMap['component-agent-1'], prepareComponentImport({
    config: target, component, importId: 'batch-one', bindings: { agents: { [externalAgentPort.id]: 'agent-2' } }
  }).agentIdMap['component-agent-1'])
  const imported = prepared.config.agents.at(-1)
  assert.equal(imported.systemPrompt, source.agents[0].systemPrompt)
  assert.deepEqual(imported.communication.sendTo, [imported.id, 'agent-2'], 'wildcard grants expand to the source roster only')
  assert.ok(prepared.issues.some(issue => issue.code === 'literal-agent-id' && issue.severity === 'warning'))
})

test('component state-port conflicts can be resolved by remapping to a new address', () => {
  const source = defaultTeamConfig()
  source.state.definitions = [{ namespace: 'shared', path: '/profile', type: 'object', default: { notes: [] } }]
  source.agents[0].statePermissions = [{ namespace: 'shared', path: '/profile', access: 'read' }]
  const component = exportComponent(source, ['agent-1'], 'Reader')
  const agentPort = component.ports.find(port => port.kind === 'agent')
  const statePort = component.ports.find(port => port.kind === 'state')
  assert.ok(statePort)

  const target = defaultTeamConfig()
  target.state.definitions = [{ namespace: 'shared', path: '/occupied', type: 'string', default: 'existing' }]
  const commonBindings = { agents: { [agentPort.id]: 'agent-2' } }
  const conflict = prepareComponentImport({
    config: target, component, importId: 'remap-test',
    bindings: { ...commonBindings, states: { [statePort.id]: { namespace: 'shared', path: '/occupied' } } }
  })
  assert.ok(conflict.conflicts.some(item => item.kind === 'state-definition' && item.severity === 'error'))
  assert.equal(conflict.config, undefined)

  const resolved = prepareComponentImport({
    config: target, component, importId: 'remap-test',
    bindings: { ...commonBindings, states: { [statePort.id]: { namespace: 'shared', path: '/new-profile' } } }
  })
  assert.ok(resolved.config)
  assert.ok(resolved.config.state.definitions.some(item => item.namespace === 'shared' && item.path === '/new-profile'))
  assert.equal(resolved.config.output.agentId, target.output.agentId, 'component publisher is preserved unless explicitly rebound')
  assert.ok(resolved.changes.some(item => item.kind === 'publisher-preserved'))

  const disconnected = prepareComponentImport({
    config: target, component, importId: 'explicit-disconnect',
    bindings: { agents: { [agentPort.id]: null }, states: { [statePort.id]: null } }
  })
  assert.ok(disconnected.config)
  assert.ok(disconnected.issues.some(item => item.severity === 'warning' && item.code === 'state-reference-removed'))
})

test('component export and import remap handoff targets through explicit agent ports', () => {
  const source = defaultTeamConfig()
  source.agents[0].communication.handoffs = [{ id: 'research', to: 'agent-2', mode: 'await', responseSchema: { type: 'object' } }]
  const component = exportComponent(source, ['agent-1'], 'Requester')
  const port = component.ports.find(item => item.kind === 'agent')
  assert.ok(port)
  const prepared = prepareComponentImport({
    config: defaultTeamConfig(), component, importId: 'handoff-import',
    bindings: { agents: { [port.id]: 'agent-2' } }
  })
  assert.ok(prepared.config)
  assert.equal(prepared.config.agents.at(-1).communication.handoffs[0].to, 'agent-2')
})

test('preview flags schema-constrained handoffs whose target cannot submit typed results', async () => {
  const config = defaultTeamConfig()
  config.agents[0].communication.handoffs = [{
    id: 'research', to: config.agents[1].id, mode: 'await', responseSchema: { type: 'object' }
  }]
  config.agents[1].outputAuthority.internal = false
  const ctx = { eleckoiStoryState: { authorSnapshot: async () => ({
    context: { currentUserInput: 'Hello', history: [] }, world: {}, baseHash: 'hash', anchor: null, busy: false
  }) } }
  const api = createAuthorToolsApi({ ctx, store: { path: join(tmpdir(), 'unused-state.json') }, readState: async () => ({ definitions: [], values: [] }) })
  const preview = await api.previewConfig({ conversationId: 'conversation-1', config })
  const issue = preview.members[1].issues.find(item => item.code === 'typed-handoff-result-unavailable')
  assert.equal(issue.severity, 'error')
  assert.match(issue.message, /requires this agent to submit typed/)
})

test('handoff guidance states exact typed request and automatic terminal-result contract', () => {
  const config = defaultTeamConfig()
  const agent = config.agents[0]
  const target = config.agents[1]
  agent.communication.handoffs = [{
    id: 'research', to: target.id, mode: 'await',
    requestSchema: { type: 'object' }, responseSchema: { type: 'object' },
    requestSelectors: ['/summary', '/data/question'], responseSelectors: ['/summary'],
    timeoutMs: 30000, onFailure: 'return_error'
  }]
  const text = childPolicy(agent, {
    runId: 'run-1', outputAgentId: target.id,
    communication: { targetsFor: () => ({
      sendTo: [target.id], requestTo: [target.id],
      handoffs: agent.communication.handoffs.map(handoff => ({ to: handoff.to, handoff })),
      incomingHandoffs: []
    }) }
  }, 1, new Map())
  assert.match(text, /handoffId/)
  assert.match(text, /await blocks this native tool call/)
  assert.match(text, /terminal \{summary,data\}/)
  assert.match(text, /requestSchema/)
  assert.match(text, /responseSelectors/)
  assert.match(text, /delivered back automatically/)
  assert.match(text, /extra rp_team_send/)

  const recipient = structuredClone(target)
  recipient.outputAuthority.internal = false
  const recipientText = childPolicy(recipient, {
    runId: 'run-2', outputAgentId: target.id,
    communication: { targetsFor: () => ({ sendTo: [], requestTo: [], incomingHandoffs: [
      { from: agent.id, handoff: agent.communication.handoffs[0] }
    ] }) }
  }, 1, new Map())
  assert.match(recipientText, /cannot succeed/)
  assert.match(recipientText, /requires typed \{summary,data\}/)
})
