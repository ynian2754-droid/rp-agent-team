import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTrialApi } from '../src/host/trials.mjs'

function base64Json(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64')
}

test('scenario export scrubs JSON card and preset credentials and omits transport metadata', async () => {
  const home = mkdtempSync(join(tmpdir(), 'rp-team-trial-export-'))
  try {
    const privateSnapshot = {
      format: 'eleckoi.rp-team-trial-snapshot', version: 1,
      conversationId: 'source-chat', createdAt: new Date().toISOString(),
      archive: { format: 'selected-conversation-only' },
      character: { fileName: 'card.json', mimeType: 'application/json', base64: base64Json({ name: 'Card', apiToken: 'embedded-card-secret' }) },
      nativePreset: { id: 'author-preset', document: { displayName: 'preset.json', mimeType: 'application/json', base64: base64Json({ name: 'Preset', api_key: 'embedded-preset-secret' }) } },
      modelSelection: { provider: 'local', model: 'fixture', endpoint: 'https://private.invalid', apiToken: 'selection-secret' },
      modelProviders: [{ provider: 'local', settingsValue: { apiKey: 'transport-secret', endpoint: 'https://private.invalid' } }],
      sourceOptions: { credential: 'options-secret' },
    }
    const api = createTrialApi({
      ctx: { eleckoiTrialSnapshots: { async freeze() { return { createdAt: privateSnapshot.createdAt, summary: {}, privateSnapshot } } } },
      store: { path: join(home, 'config.json'), get() { return { config: {}, parameterValues: {}, enabled: false } } },
      stateStore: { committedSnapshot() { return { revision: 0, namespaces: {}, pathVersions: {} } } },
      readState: async () => ({ values: [] }),
      getOptions: async () => ({ sourceOption: true }),
    })
    const frozen = await api.freezeTrialSnapshot({ conversationId: 'source-chat' })
    await api.saveTrialScenario({ scenario: { id: 'scenario-1', name: 'Export scrub', snapshotId: frozen.snapshotId, steps: [{ id: 'step-1', inputText: 'hello' }] } })
    const { export: exported } = await api.exportTrialScenario({ scenarioId: 'scenario-1', includeSnapshot: true })
    const snapshot = exported.snapshot

    assert.equal(snapshot.character.base64 && JSON.parse(Buffer.from(snapshot.character.base64, 'base64').toString('utf8')).apiToken, undefined)
    assert.equal(snapshot.nativePreset.document.base64 && JSON.parse(Buffer.from(snapshot.nativePreset.document.base64, 'base64').toString('utf8')).api_key, undefined)
    assert.equal(snapshot.modelProviders, undefined)
    assert.equal(snapshot.sourceOptions, undefined)
    assert.deepEqual(snapshot.modelSelection, { provider: 'local', model: 'fixture' })
    assert.doesNotMatch(JSON.stringify(exported), /embedded-card-secret|embedded-preset-secret|transport-secret|options-secret|selection-secret|private\.invalid/u)
    await api.dispose()
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
