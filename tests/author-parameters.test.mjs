import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { normalizeTeamConfig, defaultTeamConfig, exportPreset, parsePreset } from '../src/shared/schema.mjs'
import { normalizeSuppliedParameterValues, parameterInsertText, resolveAuthorParameters } from '../src/shared/author-parameters.mjs'
import { previewParameters } from '../src/host/parameter-api.mjs'
import { portablePreset } from '../src/host/preset-library.mjs'

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

function insertionConfig() {
  const config = defaultTeamConfig()
  const prompt = { kind: 'agent', agentId: 'agent-1', path: '/systemPrompt' }
  config.agents[0].systemPrompt = 'Style: {{param:style}}\nLength: {{param:length}} words.\n{{param:fix-ups}}End.'
  config.authorParameters = [
    { id: 'style', name: 'Style', group: 'Presentation', type: 'choice', default: 'plain', options: [
      { label: 'Plain', value: 'plain', text: 'Short plain sentences.' },
      { label: 'Detailed', value: 'detailed', text: 'Dwell on objects and gestures.' }
    ], bindings: [{ target: prompt, mode: 'text' }] },
    { id: 'length', name: 'Length', group: 'Presentation', type: 'number', default: 600, valueSchema: { type: 'number', minimum: 100 },
      bindings: [{ target: prompt, mode: 'text' }] },
    { id: 'fix-ups', name: 'Allow fix-ups', group: 'Adjudication', type: 'boolean', default: false,
      textOn: 'Find a plausible condition that lets the user succeed.\n',
      bindings: [{ target: prompt, mode: 'text' }] }
  ]
  return config
}

test('choices, switches and numbers insert their prompt text like toggled preset entries', () => {
  const config = insertionConfig()
  const defaults = resolveAuthorParameters(config, {})
  assert.equal(defaults.config.agents[0].systemPrompt, 'Style: Short plain sentences.\nLength: 600 words.\nEnd.')
  const chosen = resolveAuthorParameters(config, { style: 'detailed', length: 1200, 'fix-ups': true })
  assert.equal(chosen.config.agents[0].systemPrompt,
    'Style: Dwell on objects and gestures.\nLength: 1200 words.\nFind a plausible condition that lets the user succeed.\nEnd.')
  assert.deepEqual(chosen.changes.map(change => change.mode), ['text', 'text', 'text'])
  assert.equal(chosen.config.authorParameters[0].group, 'Presentation')
  assert.equal(parameterInsertText(chosen.config.authorParameters[2], false), '', 'an omitted textOff inserts nothing')

  const exported = exportPreset(config)
  assert.equal(exported.dependencies.minimumPluginVersion, '0.7.0')
  assert.equal(portablePreset(config).dependencies.minimumPluginVersion, '0.7.0')
  assert.deepEqual(exportPreset(parsePreset(JSON.stringify(exported))), exported, 'groups and inserted texts survive a round trip')
  assert.equal(exported.config.authorParameters[0].options[1].text, 'Dwell on objects and gestures.')
  assert.equal(exported.config.authorParameters[2].textOn, 'Find a plausible condition that lets the user succeed.\n')
  assert.throws(() => resolveAuthorParameters(config, { length: 50 }), { code: 'RP_TEAM_INVALID_PARAMETER_VALUE' })
})

test('prompt insertion declarations are rejected when they cannot produce text', () => {
  const variants = [
    config => { delete config.authorParameters[0].options[1].text },
    config => { delete config.authorParameters[2].textOn },
    config => { config.authorParameters[1].textOn = 'only for switches' },
    config => { config.authorParameters[1].options = [{ label: 'One', value: 1, text: 'x' }] },
    config => { config.authorParameters[0].options[0].text = 42 },
    config => { config.authorParameters[0].group = '  ' },
    config => { config.authorParameters[0].type = 'agent'; config.authorParameters[0].default = 'agent-1'; delete config.authorParameters[0].options }
  ]
  for (const [index, change] of variants.entries()) {
    const config = insertionConfig()
    change(config)
    assert.throws(() => normalizeTeamConfig(config), { code: 'RP_TEAM_INVALID_CONFIG' }, `variant ${index}`)
  }
  const unbound = insertionConfig()
  unbound.agents[0].systemPrompt = 'No tokens.'
  for (const parameter of unbound.authorParameters) parameter.bindings = []
  delete unbound.authorParameters[2].textOn
  delete unbound.authorParameters[0].options[0].text
  assert.doesNotThrow(() => normalizeTeamConfig(unbound), 'texts are only required when a text binding uses them')
})

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value !== null && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`
  return JSON.stringify(value)
}
