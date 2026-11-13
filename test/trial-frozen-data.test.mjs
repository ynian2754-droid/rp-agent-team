import test from 'node:test'
import assert from 'node:assert/strict'
import { captureTrialDependencies, freezeTrialData, importTrialData } from '../src/host/trial-frozen-data.mjs'
import { createTrialPublicHost, fixtureFile, fixtureImage } from './fixtures/trial-public-host.mjs'

test('trial freeze captures official archive, public author projections, loaded routes and attachment bytes', async () => {
  const { ctx } = createTrialPublicHost()
  const snapshot = await freezeTrialData(ctx, { conversationId: 'source-chat' })

  assert.equal(snapshot.format, 'rp-team.trial-frozen-data')
  assert.equal(snapshot.archive.format, 'eleckoi.desktop-chat-history')
  assert.equal(snapshot.archive.version, 2)
  assert.equal(snapshot.details.runtimeSessionId, 'source-session')
  assert.equal(snapshot.authorState.currentVariableStateJson, '{"mood":1}')
  assert.equal(snapshot.authorState.settingLibrary.name, 'Expanded fixture')
  assert.equal(snapshot.authorState.editableSettingLibrary.name, 'Raw {{char}} fixture')
  assert.equal(snapshot.modelProviders[0].provider, 'fixture-local')
  assert.equal(snapshot.modelProviders[0].settingsValue.apiKey, undefined)
  assert.deepEqual(snapshot.modelProviders[0].credentialRefs, ['FIXTURE_LOCAL_API_KEY'])
  assert.deepEqual(snapshot.loadedBundles, ['@deepseek-ai/dsh-llm-pi-ai', '@rp-team/dsh-roleplay-team'])
  assert.deepEqual(Buffer.from(snapshot.attachments.find(item => item.kind === 'image').dataBase64, 'base64'), fixtureImage)
  assert.deepEqual(Buffer.from(snapshot.attachments.find(item => item.kind === 'file').dataBase64, 'base64'), fixtureFile)

  assert.equal(snapshot.activeProductPresetId, 'product-source')
  assert.deepEqual(snapshot.productPresets.map(item => item.id), ['product-source'])
  assert.equal(snapshot.rootNativePresetId, 'native-root')
  const enriched = await captureTrialDependencies(ctx, snapshot, { providerIds: ['fixture-local'], nativePresetIds: ['native-member'] })
  assert.deepEqual(enriched.nativePresetDocuments.map(item => item.id), ['native-member'])
  assert.equal(enriched.rootNativePresetId, 'native-root', 'The root native identity comes from the official Session and remains separate from imported member definitions.')
  assert.doesNotMatch(JSON.stringify(enriched.nativePresetDocuments), /native-preset-secret|apiKey/u,
    'Native preset JSON must not carry credential-shaped configuration values.')
})

test('trial import admits attachments through DSH and verifies the official session/message identity map', async () => {
  let importedArchive
  let importedSettingLibrary
  const { ctx, savedImages, savedFiles } = createTrialPublicHost({
    onImportArchive: input => { importedArchive = input.archive },
    onSettingLibrarySave: input => { importedSettingLibrary = input },
  })
  const snapshot = await freezeTrialData(ctx, { conversationId: 'source-chat' })
  const imported = await importTrialData(ctx, snapshot)

  assert.equal(imported.conversationId.startsWith('worker-conversation-'), true)
  assert.equal(imported.sessionId, 'worker-session-1')
  assert.deepEqual(imported.messageMapping, { 'message-user': 'message-user', 'message-assistant': 'message-assistant' })
  assert.equal(importedArchive.snapshot.characterId, imported.characterId)
  assert.equal(importedArchive.snapshot.tables.chat_sessions[0].characterId, imported.characterId)
  assert.equal(importedArchive.snapshot.tables.chat_sessions[0].characterId === snapshot.characterId, false)
  assert.equal(importedArchive.snapshot.version, 2)
  const history = importedArchive.snapshot.stateHistory.operations[0]
  assert.equal(history.before.settingLibrary.characterId, imported.characterId)
  assert.equal(history.after.settingLibrary.characterId, imported.characterId)
  assert.equal(importedSettingLibrary.characterId, imported.characterId)
  assert.equal(importedSettingLibrary.library.name, 'Raw {{char}} fixture')
  const image = importedArchive.sessionLogs[0].events[0].data.content.find(item => item.type === 'image')
  const file = importedArchive.sessionLogs[0].events[0].data.content.find(item => item.type === 'file')
  assert.equal(image.attachment.attachmentId, [...savedImages.keys()][0])
  assert.equal(file.attachment.attachmentId, [...savedFiles.keys()][0])
  assert.deepEqual(imported.sessionMapping, { 'source-session': 'worker-session-1' })
  assert.equal(imported.rootNativePresetId, 'native-root')
  assert.equal(imported.productPresetIds['product-source'], 'worker-product-1')
  assert.equal(ctx.eleckoiAgentPresetsApi && ctx.agentPresets.composedPreset({ agentPreset: 'native-root' }), 'native-root')
})

test('trial import keeps product and native preset identities separate and selects the exact native root composition', async () => {
  let importedPresetDocument
  const { ctx, nativeDocuments, selectedNativePresets, getActiveProductPresetId } = createTrialPublicHost()
  ctx.eleckoiAgentPresetsApi.import = async (_source, document, purpose) => {
    assert.equal(purpose, 'roleplay')
    importedPresetDocument = document
    return { preset: { id: 'worker-product-copy' } }
  }
  const snapshot = await freezeTrialData(ctx, { conversationId: 'source-chat', nativePresetIds: ['native-member'] })
  // This import represents a new worker profile; source-registry definitions
  // must not leak into the destination and mask the frozen-document import.
  nativeDocuments.delete('native-member')
  const imported = await importTrialData(ctx, snapshot)

  assert.equal(snapshot.productPresets[0].id, 'product-source')
  assert.equal(imported.productPresetIds['product-source'], 'worker-product-copy')
  assert.equal(imported.nativePresetIds['native-member'], 'native-member')
  assert.equal(imported.rootNativePresetId, 'native-root')
  assert.equal(importedPresetDocument.displayName, 'product-source.json')
  assert.equal(JSON.parse(Buffer.from(importedPresetDocument.base64, 'base64').toString()).id, 'product-source')
  assert.deepEqual(selectedNativePresets, [], 'Root native preset selection stays with the official product prepare lifecycle.')
  assert.equal(ctx.agents.get('worker-session-1').ctx.agentPreset, 'worker-default')
  assert.equal(getActiveProductPresetId(), 'worker-product-copy')
})
