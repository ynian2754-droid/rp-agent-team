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
    { path: '/status', message: 'must match one of the allowed values' },
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
