import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { normalizeTeamConfig, defaultTeamConfig } from '../src/shared/schema.mjs'
import { normalizeSuppliedParameterValues, resolveAuthorParameters } from '../src/shared/author-parameters.mjs'
import { previewParameters } from '../src/host/parameter-api.mjs'

test('author parameters resolve defaults, optional agent fields, text tokens, state defaults, and stable hashes', () => {
  const config = defaultTeamConfig()
  config.agents[0].systemPrompt = 'Speak {{param:voice}}; repeat {{param:voice}}.'
  config.agents[0].outputAuthority.user = true
  config.agents[1].outputAuthority.user = true
  config.output.agentId = 'agent-1'
  config.state.definitions = [{ namespace: 'shared', path: '/chapter', type: 'number', default: 1 }]
  config.authorParameters = [
    { id: 'voice', name: 'Voice', type: 'text', default: 'warm', bindings: [
      { target: { kind: 'agent', agentId: 'agent-1', path: '/systemPrompt' }, mode: 'text' }
    ] },
    { id: 'temperature', name: 'Temperature', type: 'number', default: 0.45, bindings: [
      { target: { kind: 'agent', agentId: 'agent-1', path: '/parameters/temperature' }, mode: 'set' }
    ] },
    { id: 'chapter', name: 'Starting chapter', type: 'number', default: 2, bindings: [
      { target: { kind: 'state_default', namespace: 'shared', path: '/chapter' }, mode: 'set' }
    ] },
    { id: 'publisher', name: 'Publisher', type: 'agent', default: 'agent-2', bindings: [
      { target: { kind: 'team', path: '/output/agentId' }, mode: 'set' }
    ] }
  ]

  const source = normalizeTeamConfig(config)
  const resolved = resolveAuthorParameters(source, { voice: 'calm' })
  assert.equal(resolved.config.agents[0].systemPrompt, 'Speak calm; repeat calm.')
  assert.equal(resolved.config.agents[0].parameters.temperature, 0.45)
  assert.equal(resolved.config.state.definitions[0].default, 2)
  assert.equal(resolved.config.output.agentId, 'agent-2')
  assert.equal(resolved.values.temperature, 0.45, 'declaration defaults are materialized only for omitted values')
  assert.equal(resolved.sourceHash, resolveAuthorParameters(source, { voice: 'another' }).sourceHash)
  assert.notEqual(resolved.resolvedHash, resolveAuthorParameters(source, { voice: 'another' }).resolvedHash)
  assert.match(resolved.sourceHash, /^[0-9a-f]{64}$/u)
  assert.equal(resolved.sourceHash, createHash('sha256').update(stableJson(source), 'utf8').digest('hex'))
  assert.equal(resolved.changes.length, 4)
})

test('required values, invalid overrides, and unsafe binding destinations fail explicitly', () => {
  const config = defaultTeamConfig()
  config.authorParameters = [{ id: 'required', name: 'Required', type: 'text', bindings: [] }]
  assert.throws(() => resolveAuthorParameters(config, {}), { code: 'RP_TEAM_PARAMETER_REQUIRED' })
  assert.throws(() => normalizeSuppliedParameterValues(config, { missing: 'x' }), { code: 'RP_TEAM_INVALID_PARAMETER_VALUE' })
  assert.throws(() => normalizeTeamConfig({ ...config, authorParameters: [
    { id: 'bad', name: 'Bad', type: 'text', bindings: [{ target: { kind: 'agent', agentId: 'unknown', path: '/systemPrompt' }, mode: 'set' }] }
  ] }), { code: 'RP_TEAM_INVALID_CONFIG' })
  assert.throws(() => normalizeTeamConfig({ ...config, authorParameters: [
    { id: 'bad', name: 'Bad', type: 'text', bindings: [{ target: { kind: 'team', path: '/metadata/credentials/apiKey' }, mode: 'set' }] }
  ] }), { code: 'RP_TEAM_INVALID_CONFIG' })
  assert.throws(() => normalizeSuppliedParameterValues({
    ...defaultTeamConfig(), authorParameters: [{ id: 'temp', name: 'Temp', type: 'number', bindings: [] }]
  }, { temp: 'hot' }), { code: 'RP_TEAM_INVALID_PARAMETER_VALUE' })
})

test('author parameters may set native preset/reference fields but never stable IDs or trigger IDs', () => {
  const config = defaultTeamConfig()
  config.authorParameters = [{ id: 'preset', name: 'Native preset', type: 'text', default: 'observer', bindings: [
    { target: { kind: 'agent', agentId: 'agent-1', path: '/presetId' }, mode: 'set' }
  ] }]
  const resolved = resolveAuthorParameters(config, {})
  assert.equal(resolved.config.agents[0].presetId, 'observer')
  for (const path of ['/id', '/triggers/0/id']) {
    const bad = defaultTeamConfig()
    bad.agents[0].triggers = [{ type: 'always', id: 'trigger-1' }]
    bad.authorParameters = [{ id: 'identity', name: 'Identity', type: 'text', default: 'changed', bindings: [
      { target: { kind: 'agent', agentId: 'agent-1', path }, mode: 'set' }
    ] }]
    assert.throws(() => normalizeTeamConfig(bad), { code: 'RP_TEAM_INVALID_CONFIG' })
  }
})

test('authority-affecting changes are returned for explicit review and the host preview is pure', () => {
  const config = defaultTeamConfig()
  config.agents[0].outputAuthority.state = false
  config.authorParameters = [{ id: 'state-output', name: 'State output', type: 'boolean', default: true, bindings: [
    { target: { kind: 'agent', agentId: 'agent-1', path: '/outputAuthority/state' }, mode: 'set' }
  ] }]
  const preview = previewParameters({ config, parameterValues: {} })
  assert.equal(preview.config.agents[0].outputAuthority.state, true)
  assert.equal(preview.changes[0].authorityChange, true)
  assert.equal(config.agents[0].outputAuthority.state, false, 'preview does not mutate the author draft')
})

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value !== null && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`
  return JSON.stringify(value)
}
