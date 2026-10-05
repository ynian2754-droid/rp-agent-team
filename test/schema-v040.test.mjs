import test from 'node:test'
import assert from 'node:assert/strict'
import { examplePresets, exportPreset, normalizeTeamConfig } from '../src/shared/schema.mjs'
const preset = () => examplePresets()[0]

test('legacy configuration keeps absent 0.4 features absent and new exports declare their minimum version', () => {
  const old = normalizeTeamConfig(preset())
  assert.equal(old.execution.budget, undefined)
  assert.equal(old.authorParameters, undefined)
  const next = normalizeTeamConfig({ ...old, execution: { ...old.execution, budget: { maxRequests: 2 } } })
  assert.equal(exportPreset(next).dependencies.minimumPluginVersion, '0.4.0')
  assert.deepEqual(normalizeTeamConfig(JSON.parse(JSON.stringify(next))), next)
})
test('event triggers retain machine rules and reject unreadable input or state', () => {
  const config = preset(), agent = config.agents[0]
  agent.triggers = [{ id: 'attention-interval', type: 'periodic', every: 3, offset: 1, cooldownTurns: 2 }, { type: 'keyword', keywords: ['door'], match: 'all' }]
  assert.equal(normalizeTeamConfig(config).agents[0].triggers[0].id, 'attention-interval')
  agent.context.sources = []
  assert.throws(() => normalizeTeamConfig(config), /current input/u)
  agent.triggers = [{ type: 'state_changed', namespace: 'shared', path: '/secret' }]
  config.state.definitions = [{ namespace: 'shared', path: '/secret', type: 'string', default: 'x' }]
  agent.statePermissions = []
  assert.throws(() => normalizeTeamConfig(config), /read|permission/u)
})
test('resource limits accept only positive integral values', () => {
  for (const value of [0, -1, 1.5, '2']) {
    const config = preset()
    config.execution.budget = { maxRequests: value }
    assert.throws(() => normalizeTeamConfig(config), /positive/u)
  }
})
