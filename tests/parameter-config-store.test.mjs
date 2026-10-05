import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { defaultTeamConfig } from '../src/shared/schema.mjs'
import { previewParameters } from '../src/host/parameter-api.mjs'
import { TeamConfigStore } from '../src/host/config-store.mjs'
import { portablePreset } from '../src/host/preset-library.mjs'

test('ConfigStore keeps explicit values outside preset declarations and preserves them for old saves', async () => {
  const home = mkdtempSync(join(tmpdir(), 'rp-team-parameters-'))
  try {
    const store = new TeamConfigStore(home)
    assert.deepEqual(store.get('conversation').parameterValues, {})
    const config = defaultTeamConfig()
    config.authorParameters = [{ id: 'voice', name: 'Voice', type: 'text', bindings: [] }]
    const first = await store.save({ conversationId: 'conversation', expectedRevision: 0, enabled: true, config, parameterValues: { voice: 'quiet' } })
    assert.deepEqual(first.parameterValues, { voice: 'quiet' })

    const changed = structuredClone(config)
    changed.name = 'Edited team'
    const second = await store.save({ conversationId: 'conversation', expectedRevision: first.revision, enabled: true, config: changed })
    assert.equal(second.revision, first.revision + 1)
    assert.deepEqual(second.parameterValues, { voice: 'quiet' }, 'omitting the map keeps values for declarations that remain')
    assert.deepEqual(store.export('conversation').config.authorParameters, changed.authorParameters)
    assert.equal(Object.hasOwn(store.export('conversation'), 'parameterValues'), false)

    const changedValue = await store.save({
      conversationId: 'conversation', expectedRevision: second.revision, enabled: true, config: changed,
      parameterValues: { voice: 'loud' }
    })
    assert.equal(changedValue.revision, second.revision + 1, 'value-only changes participate in revision conflict detection')
    assert.deepEqual(changedValue.parameterValues, { voice: 'loud' })

    assert.throws(() => store.save({
      conversationId: 'conversation', expectedRevision: changedValue.revision, enabled: true, config: changed,
      parameterValues: { voice: 3 }
    }), { code: 'RP_TEAM_INVALID_PARAMETER_VALUE' })
    const removed = structuredClone(changed)
    removed.authorParameters = []
    const third = await store.save({ conversationId: 'conversation', expectedRevision: changedValue.revision, enabled: true, config: removed })
    assert.deepEqual(third.parameterValues, {}, 'values for removed declarations are discarded')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('preview rejects missing required values and 0.4 presets advertise their minimum version', () => {
  const config = defaultTeamConfig()
  config.authorParameters = [{ id: 'required', name: 'Required', type: 'text', bindings: [] }]
  assert.throws(() => previewParameters({ config, parameterValues: {} }), { code: 'RP_TEAM_PARAMETER_REQUIRED' })
  assert.equal(portablePreset(config).dependencies.minimumPluginVersion, '0.4.0')

  const old = defaultTeamConfig()
  assert.equal(portablePreset(old).dependencies.minimumPluginVersion, undefined)
})
