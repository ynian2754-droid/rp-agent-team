import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createCommunication } from '../src/host/communication.mjs'
import { portablePreset } from '../src/host/preset-library.mjs'
import { StateStore } from '../src/host/state-store.mjs'
import { resolveAuthorParameters } from '../src/shared/author-parameters.mjs'
import { defaultTeamConfig, exportPreset, normalizeTeamConfig, parsePreset } from '../src/shared/schema.mjs'

const auxiliary = 'agent-1'
const publisher = 'agent-2'
const remaining = 'agent-3'
const privateState = { namespace: `private:${auxiliary}`, path: '/memory' }
const sharedState = { namespace: 'shared', path: '/chapter' }
const promptTarget = agentId => ({ target: { kind: 'agent', agentId, path: '/systemPrompt' }, mode: 'text' })

function structureConfig() {
  const config = defaultTeamConfig()
  const [observer, writer] = config.agents
  const peer = structuredClone(observer)
  peer.id = remaining
  peer.name = 'Remaining peer'
  peer.triggers = [{ type: 'manual' }]
  peer.statePermissions = []
  peer.communication = { sendTo: [publisher], receiveFrom: [publisher], requestTo: [publisher], requestFrom: [] }
  config.agents.push(peer)
  config.state.definitions = [
    { ...privateState, type: 'string', default: 'original' },
    { ...sharedState, type: 'number', default: 1 }
  ]
  observer.systemPrompt = 'Observer {{param:voice}}.'
  observer.statePermissions = [{ ...privateState, access: 'readwrite' }]
  writer.systemPrompt = 'Write with split review, {{param:voice}}.'
  writer.statePermissions = [{ ...privateState, access: 'read' }, { ...sharedState, access: 'read' }]
  writer.context.sources = [{ type: 'agent_messages', agentIds: [auxiliary, remaining] }]
  writer.communication = { sendTo: [auxiliary, remaining], receiveFrom: [auxiliary, remaining], requestTo: [auxiliary, remaining],
    requestFrom: [auxiliary, remaining], handoffs: [{ id: 'consult-observer', to: auxiliary, mode: 'await' }] }
  writer.execution.after = [auxiliary, remaining]
  writer.triggers.push(
    { type: 'requested_by_agent', id: 'only-observer', from: [auxiliary] },
    { type: 'message_received', id: 'only-observer-message', from: [auxiliary] },
    { type: 'requested_by_agent', id: 'either-source', from: [auxiliary, remaining] },
    { type: 'state_changed', id: 'private-watch', ...privateState },
    { type: 'condition', id: 'private-condition', condition: { op: 'not', condition: { op: 'exists', ...privateState } } },
    { type: 'condition', id: 'mixed-condition', condition: { op: 'any', conditions: [
      { op: 'exists', ...privateState }, { op: 'exists', ...sharedState }
    ] } },
    { type: 'state_changed', id: 'public-watch', ...sharedState }
  )
  config.authorParameters = [
    { id: 'composition', name: 'Composition', type: 'choice', default: 'full', options: [
      { label: 'Full', value: 'full' },
      { label: 'Compact', value: 'compact', structure: {
        excludeAgents: [auxiliary], prompts: { [publisher]: 'Write directly.\n\nVoice {{param:voice}}.' }
      } },
      { label: 'No change', value: 'empty', structure: {} }
    ], bindings: [] },
    { id: 'voice', name: 'Voice', type: 'text', default: 'natural', bindings: [promptTarget(publisher), promptTarget(auxiliary)] }
  ]
  return config
}

test('one author choice changes the active graph and exact prompt before ordinary interpolation', () => {
  const source = normalizeTeamConfig(structureConfig())
  const before = structuredClone(source)
  const full = resolveAuthorParameters(source)
  assert.deepEqual(full.config.agents.map(agent => agent.id), [auxiliary, publisher, remaining])
  assert.equal(full.config.agents.find(agent => agent.id === publisher).systemPrompt, 'Write with split review, natural.')
  assert.deepEqual(resolveAuthorParameters(source, { composition: 'empty' }).config, full.config)

  const compact = resolveAuthorParameters(source, { composition: 'compact', voice: 'quiet' })
  assert.deepEqual(compact.config.agents.map(agent => agent.id), [publisher, remaining])
  const writer = compact.config.agents.find(agent => agent.id === publisher)
  assert.equal(writer.systemPrompt, 'Write directly.\n\nVoice quiet.')
  assert.equal(compact.config.output.agentId, publisher)
  assert.deepEqual(writer.execution.after, [remaining])
  for (const key of ['sendTo', 'receiveFrom', 'requestTo', 'requestFrom']) {
    assert.deepEqual(writer.communication[key], [remaining])
  }
  assert.deepEqual(writer.communication.handoffs, [])
  assert.deepEqual(writer.context.sources, [{ type: 'agent_messages', agentIds: [remaining] }])
  assert.deepEqual(writer.statePermissions, [{ ...sharedState, access: 'read' }])
  assert.deepEqual(writer.triggers, [
    { type: 'always' }, { type: 'requested_by_agent', id: 'either-source', from: [remaining] },
    { type: 'state_changed', id: 'public-watch', ...sharedState }
  ])
  assert.deepEqual(compact.config.state.definitions, [{ ...sharedState, type: 'number', default: 1 }])
  assert.equal(compact.config.authorParameters, undefined)
  assert.deepEqual(source.authorParameters.find(parameter => parameter.id === 'voice').bindings,
    [promptTarget(publisher), promptTarget(auxiliary)])
  assert.deepEqual(compact.values, { composition: 'compact', voice: 'quiet' })
  assert.equal(compact.sourceHash, full.sourceHash)
  assert.notEqual(compact.resolvedHash, full.resolvedHash)
  assert.deepEqual(source, before)
  assert.deepEqual(normalizeTeamConfig(compact.config), compact.config)
})

test('pruning an entirely removed sender filter never makes an optional request trigger or context public', async () => {
  const source = structureConfig()
  const writer = source.agents.find(agent => agent.id === publisher)
  writer.context.sources = [{ type: 'agent_messages', agentIds: [auxiliary] }]
  writer.triggers = writer.triggers.filter(trigger => ['only-observer', 'only-observer-message'].includes(trigger.id) || trigger.type === 'always')
  const { config } = resolveAuthorParameters(source, { composition: 'compact' })
  assert.deepEqual(config.agents[0].triggers, [{ type: 'always' }])
  assert.ok(config.agents[0].context.sources.every(entry => !['agent_messages', 'drafts'].includes(entry.type) ||
    Array.isArray(entry.agentIds) && !entry.agentIds.length))
  const communication = createCommunication(config)
  await assert.rejects(communication.request({ from: remaining, to: publisher, data: { unwanted: true } }),
    { code: 'RP_TEAM_AGENT_NOT_REQUESTABLE' })
  assert.deepEqual(communication.allMessages(), [])
})

test('a disabled member cannot read state, and re-enabling recovers its committed private state', t => {
  const home = mkdtempSync(join(tmpdir(), 'rp-team-structural-choice-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const store = new StateStore(home)
  const source = structureConfig()
  const ids = { conversationId: 'configuration-switch' }
  const prepare = (runId, composition) => {
    const run = { ...ids, runId }
    store.begin({ ...run, config: resolveAuthorParameters(source, { composition }).config })
    return run
  }
  const commit = run => { store.stage(run); store.commit({ ...run, receipt: { outcome: 'committed' } }) }
  const write = prepare('enabled', 'full')
  const before = store.read({ ...write, agentId: auxiliary, ...privateState })
  store.write({ ...write, agentId: auxiliary, ...privateState, value: 'persist across choice', expectedVersion: before.version })
  commit(write)
  const disabled = prepare('disabled', 'compact')
  assert.throws(() => store.read({ ...disabled, agentId: auxiliary, ...privateState }), { code: 'RP_TEAM_AGENT_NOT_FOUND' })
  assert.throws(() => store.read({ ...disabled, agentId: publisher, ...privateState }), { code: 'RP_TEAM_STATE_FORBIDDEN' })
  commit(disabled)
  const reopened = prepare('re-enabled', 'full')
  assert.equal(store.read({ ...reopened, agentId: auxiliary, ...privateState }).value, 'persist across choice')
})

test('invalid structural declarations fail explicitly and portable presets require plugin 0.7.19', () => {
  const invalid = [
    config => { config.authorParameters[0].options[1].structure.excludeAgents = ['ghost'] },
    config => { config.authorParameters[0].options[1].structure.excludeAgents = [publisher] },
    config => { config.authorParameters[0].options[1].structure.prompts[auxiliary] = 'Disabled agent replacement' },
    config => { config.authorParameters[0].options[1].structure.prompts.ghost = 'Unknown agent replacement' },
    config => { config.authorParameters[0].options[1].structure.extra = true },
    config => { config.authorParameters[0].options[1].structure.prompts[publisher] = 123 },
    config => { config.authorParameters.push({ ...structuredClone(config.authorParameters[0]), id: 'second-choice' }) }
  ]
  for (const [index, change] of invalid.entries()) {
    const config = structureConfig()
    change(config)
    assert.throws(() => resolveAuthorParameters(config, { composition: 'compact' }), { code: 'RP_TEAM_INVALID_CONFIG' }, `variant ${index}`)
  }
  const source = structureConfig()
  const envelope = exportPreset(source)
  assert.equal(envelope.dependencies.minimumPluginVersion, '0.7.19')
  assert.equal(portablePreset(source).dependencies.minimumPluginVersion, '0.7.19')
  const imported = parsePreset(JSON.stringify(envelope))
  assert.deepEqual(exportPreset(imported), envelope)
  assert.deepEqual(resolveAuthorParameters(imported, { composition: 'compact' }),
    resolveAuthorParameters(source, { composition: 'compact' }))
})
