import assert from 'node:assert/strict'
import test from 'node:test'
import { defaultTeamConfig } from '../src/shared/schema.mjs'
import { exportComponent, prepareComponentImport } from '../src/shared/components.mjs'

test('component export/import remaps author agent/state references, memory ports, and parameter tokens', () => {
  const source = defaultTeamConfig()
  source.agents[0].systemPrompt = 'Speak {{param:tone}}.'
  source.state.definitions = [{ namespace: 'shared', path: '/memory', type: 'array', default: [] }]
  source.memory = { collections: [{ id: 'diary', name: 'Diary', namespace: 'shared', path: '/memory' }] }
  source.authorParameters = [
    { id: 'tone', name: 'Tone', type: 'text', default: 'calm', bindings: [
      { target: { kind: 'agent', agentId: 'agent-1', path: '/systemPrompt' }, mode: 'text' }
    ] },
    { id: 'reviewer', name: 'Reviewer', type: 'agent', default: 'agent-2', bindings: [] },
    { id: 'memoryPath', name: 'Memory path', type: 'state', default: { namespace: 'shared', path: '/memory' }, bindings: [
      { target: { kind: 'state_default', namespace: 'shared', path: '/memory' }, mode: 'set' }
    ] }
  ]
  const component = exportComponent(source, ['agent-1'], 'Parameterized observer')
  const agentPort = component.ports.find(port => port.kind === 'agent')
  const statePort = component.ports.find(port => port.kind === 'state')
  assert.ok(agentPort)
  assert.ok(statePort)
  assert.equal(component.dependencies.minimumPluginVersion, '0.4.0')
  assert.ok(component.agents[0].systemPrompt.includes('{{param:component-parameter-1}}'))
  assert.equal(component.authorParameters[0].id, 'component-parameter-1')
  assert.equal(component.authorParameters[1].default, `@rp-team-agent-port:${agentPort.id}`)
  assert.equal(component.authorParameters[2].default.namespace, `@rp-team-state-port:${statePort.id}`)
  assert.equal(component.memory.collections[0].namespace, `@rp-team-state-port:${statePort.id}`)

  const imported = prepareComponentImport({
    config: defaultTeamConfig(), component, importId: 'parameterized-observer',
    bindings: { agents: { [agentPort.id]: 'agent-2' }, states: { [statePort.id]: { namespace: 'shared', path: '/imported-memory' } } }
  })
  assert.ok(imported.config)
  const newAgentId = imported.agentIdMap['component-agent-1']
  const tone = imported.config.authorParameters.find(parameter => parameter.name === 'Tone')
  const reviewer = imported.config.authorParameters.find(parameter => parameter.name === 'Reviewer')
  const memoryPath = imported.config.authorParameters.find(parameter => parameter.name === 'Memory path')
  assert.notEqual(tone.id, component.authorParameters[0].id)
  assert.equal(imported.config.agents.at(-1).systemPrompt, `Speak {{param:${tone.id}}}.`)
  assert.equal(tone.bindings[0].target.agentId, newAgentId)
  assert.equal(reviewer.default, 'agent-2')
  assert.deepEqual(memoryPath.default, { namespace: 'shared', path: '/imported-memory' })
  assert.deepEqual(memoryPath.bindings[0].target, { kind: 'state_default', namespace: 'shared', path: '/imported-memory' })
  assert.equal(imported.config.memory.collections[0].path, '/imported-memory')
  assert.ok(imported.config.state.definitions.some(definition => definition.namespace === 'shared' && definition.path === '/imported-memory'))
})

test('unbound component references stay unresolved and block a draft', () => {
  const source = defaultTeamConfig()
  source.state.definitions = [{ namespace: 'shared', path: '/memory', type: 'array', default: [] }]
  source.memory = { collections: [{ id: 'diary', name: 'Diary', namespace: 'shared', path: '/memory' }] }
  source.authorParameters = [{ id: 'reviewer', name: 'Reviewer', type: 'agent', default: 'agent-2', bindings: [] }]
  const component = exportComponent(source, ['agent-1'], 'Observer')
  const imported = prepareComponentImport({ config: defaultTeamConfig(), component, importId: 'unbound-observer' })
  assert.equal(imported.config, undefined)
  assert.ok(imported.issues.some(issue => issue.code === 'author-parameter-agent-unresolved' && issue.severity === 'error'))
  assert.ok(imported.issues.some(issue => issue.code === 'unbound-port' && issue.kind === 'state'))
})

test('components without 0.4 features keep the older minimum plugin dependency', () => {
  const component = exportComponent(defaultTeamConfig(), ['agent-1'], 'Plain observer')
  assert.equal(component.dependencies.minimumPluginVersion, '0.3.0')
  assert.equal(Object.hasOwn(component, 'authorParameters'), false)
  assert.equal(Object.hasOwn(component, 'memory'), false)
})
