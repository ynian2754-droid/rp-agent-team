import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defaultTeamConfig, normalizeTeamConfig } from '../src/shared/schema.mjs'
import { normalizeValueSchema, validateValueSchema } from '../src/shared/value-schema.mjs'
import { StateStore } from '../src/host/state-store.mjs'

test('value schemas normalize the supported data contract and report nested JSON Pointer paths', () => {
  const schema = normalizeValueSchema({
    type: 'object',
    required: ['status'],
    properties: {
      status: { enum: ['idle', 'active'] },
      count: { type: 'number', minimum: 0, maximum: 5 },
      tags: { type: 'array', items: { type: 'string' } }
    }
  })
  assert.deepEqual(schema, {
    type: 'object',
    required: ['status'],
    properties: {
      status: { enum: ['idle', 'active'] },
      count: { type: 'number', minimum: 0, maximum: 5 },
      tags: { type: 'array', items: { type: 'string' } }
    }
  })
  assert.deepEqual(validateValueSchema({ status: 'done', count: -1, tags: ['ok', 2] }, schema), [
    { path: '/status', message: 'must be one of "idle", "active"' },
    { path: '/count', message: 'must be at least 0' },
    { path: '/tags/1', message: 'must be string' }
  ])
  assert.throws(() => normalizeValueSchema({ executable: 'no' }), { code: 'RP_TEAM_INVALID_CONFIG' })
})

test('team config validates defaults and StateStore validates edits against nested schemas', () => {
  const config = defaultTeamConfig()
  const valueSchema = {
    type: 'object',
    required: ['status'],
    properties: { status: { enum: ['idle', 'active'] }, count: { type: 'number', minimum: 0 } }
  }
  config.state.definitions = [{
    namespace: 'shared', path: '/profile', type: 'object',
    default: { status: 'idle', count: 1 }, valueSchema
  }]
  config.agents[0].statePermissions = [{ namespace: 'shared', path: '/profile', access: 'readwrite' }]

  const normalized = normalizeTeamConfig(config)
  assert.deepEqual(normalized.state.definitions[0].valueSchema, valueSchema)
  assert.throws(() => normalizeTeamConfig({
    ...config,
    state: { definitions: [{ ...config.state.definitions[0], default: { status: 'done' } }] }
  }), { code: 'RP_TEAM_INVALID_CONFIG' })

  const directory = mkdtempSync(join(tmpdir(), 'rp-team-value-schema-'))
  try {
    const store = new StateStore(undefined, { filePath: join(directory, 'state.json') })
    store.begin({ conversationId: 'schema-test', runId: 'run-1', config: normalized })
    const write = input => store.write({
      conversationId: 'schema-test', runId: 'run-1', agentId: 'agent-1',
      namespace: 'shared', expectedVersion: 0, ...input
    })
    assert.throws(() => write({ path: '/profile/status', value: 'done' }), { code: 'RP_TEAM_STATE_TYPE_MISMATCH' })
    assert.throws(() => write({ path: '/profile/count', value: -1 }), { code: 'RP_TEAM_STATE_TYPE_MISMATCH' })
    assert.throws(() => store.remove({
      conversationId: 'schema-test', runId: 'run-1', agentId: 'agent-1',
      namespace: 'shared', path: '/profile/status', expectedVersion: 0
    }), { code: 'RP_TEAM_STATE_TYPE_MISMATCH' })
    assert.deepEqual(store.read({
      conversationId: 'schema-test', runId: 'run-1', agentId: 'agent-1',
      namespace: 'shared', path: '/profile'
    }).value, { status: 'idle', count: 1 })
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('a rejected state write reports up to eight problems of the value at once', () => {
  const config = defaultTeamConfig()
  const str = { type: 'string' }
  const strs = { type: 'array', items: str }
  config.state.definitions = [{
    namespace: 'shared', path: '/world', type: 'object', default: { clocks: [], ties: [] },
    valueSchema: {
      type: 'object', required: ['clocks', 'ties'], properties: {
        clocks: { type: 'array', items: { type: 'object', required: ['what', 'due', 'known_to'], properties: { what: str, due: str, known_to: strs } } },
        ties: { type: 'array', items: { type: 'object', required: ['between', 'kind', 'content'], properties: { between: str, kind: str, content: str } } }
      }
    }
  }]
  config.agents[0].statePermissions = [{ namespace: 'shared', path: '/world', access: 'readwrite' }]
  const directory = mkdtempSync(join(tmpdir(), 'rp-team-value-issues-'))
  try {
    const store = new StateStore(undefined, { filePath: join(directory, 'state.json') })
    store.begin({ conversationId: 'issues', runId: 'run-1', config: normalizeTeamConfig(config) })
    const write = value => store.write({ conversationId: 'issues', runId: 'run-1', agentId: 'agent-1',
      namespace: 'shared', path: '/world', expectedVersion: 0, value })
    assert.throws(() => write({ clocks: [{ name: 'pickup window' }], ties: [{ between: ['A', 'B'] }] }), error => {
      assert.equal(error.code, 'RP_TEAM_STATE_TYPE_MISMATCH')
      assert.equal(error.message, 'State value at shared/world/clocks/0/what is required; shared/world/clocks/0/due is required; '
        + 'shared/world/clocks/0/known_to is required; shared/world/ties/0/kind is required; '
        + 'shared/world/ties/0/content is required; shared/world/ties/0/between must be string')
      return true
    })
    assert.throws(() => write({ clocks: [{}, {}, {}, {}], ties: [] }), error => {
      assert.match(error.message, /clocks\/2\/due is required; and 4 more problems$/u)
      return true
    })
    assert.throws(() => write({ clocks: [{ what: 'x', due: 'y' }], ties: [] }),
      { message: 'State value at shared/world/clocks/0/known_to is required' })
    write({ clocks: [{ what: 'pickup window', due: 'Friday 18:00', known_to: ['A'] }], ties: [] })
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
