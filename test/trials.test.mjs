import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTrialApi } from '../src/host/trials.mjs'
import { TrialStorage } from '../src/host/trial-storage.mjs'
import { createTrialPublicHost } from './fixtures/trial-public-host.mjs'

function base64Json(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64')
}

test('trial storage persists JSON records and frozen-data checkpoints under validated ids', () => {
  const home = mkdtempSync(join(tmpdir(), 'rp-team-trial-storage-'))
  try {
    const storage = new TrialStorage(join(home, 'config.json'))
    assert.deepEqual(storage.read(), { version: 1, scenarios: {}, trials: {} })
    const record = { version: 1, scenarios: { scene: { id: 'scene' } }, trials: {} }
    storage.write(record)
    assert.deepEqual(storage.read(), record)

    const snapshotId = `trial-snapshot-${'a'.repeat(32)}`
    const snapshot = { snapshotId, archive: { version: 1 }, checkpoint: { turn: 2 } }
    storage.writeSnapshot(snapshotId, snapshot)
    assert.deepEqual(storage.readSnapshot(snapshotId), snapshot)
    assert.throws(() => storage.snapshotPath('trial-snapshot-../outside'), /Invalid trial snapshot id/u)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('scenario export scrubs credentials from official character and preset archives', async () => {
  const home = mkdtempSync(join(tmpdir(), 'rp-team-trial-export-'))
  try {
    const { ctx } = createTrialPublicHost()
    ctx.eleckoiCharactersApi.export = async () => ({ fileName: 'card.json', mimeType: 'application/json',
      base64: base64Json({ name: 'Card', apiToken: 'embedded-card-secret' }) })
    ctx.eleckoiAgentPresetsApi.read = async id => ({ id, name: 'Preset', api_key: 'preset-secret', plugins: [] })
    ctx.eleckoiAgentPresetsApi.export = async id => ({ fileName: 'preset.json', mimeType: 'application/json',
      base64: base64Json({ name: 'Preset', api_key: 'embedded-preset-secret' }) })
    const api = createTrialApi({
      ctx,
      store: { path: join(home, 'config.json'), get() { return { config: { agents: [{ presetId: 'native-member' }] }, parameterValues: {}, enabled: false } } },
      stateStore: { committedSnapshot() { return { revision: 0, namespaces: {}, pathVersions: {} } } },
    })
    const frozen = await api.freezeTrialSnapshot({ conversationId: 'source-chat' })
    await api.saveTrialScenario({ scenario: { id: 'scenario-1', name: 'Export scrub', snapshotId: frozen.snapshotId, steps: [{ id: 'step-1', inputText: 'hello' }] } })
    const { export: exported } = await api.exportTrialScenario({ scenarioId: 'scenario-1', includeSnapshot: true })
    const snapshot = exported.snapshot

    assert.equal(snapshot.character.base64 && JSON.parse(Buffer.from(snapshot.character.base64, 'base64').toString('utf8')).apiToken, undefined)
    assert.equal(snapshot.productPresets[0].document.base64 && JSON.parse(Buffer.from(snapshot.productPresets[0].document.base64, 'base64').toString('utf8')).api_key, undefined)
    assert.equal(snapshot.modelProviders[0].settingsValue.apiKey, undefined)
    assert.doesNotMatch(JSON.stringify(exported), /embedded-card-secret|embedded-preset-secret|preset-secret|fixture-secret/u)
    await api.dispose()
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
