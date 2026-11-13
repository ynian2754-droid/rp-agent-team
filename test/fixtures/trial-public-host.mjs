import { createHash } from 'node:crypto'
import { stringify as stringifyYaml } from 'yaml'

export const fixtureImage = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/+XcAAAAASUVORK5CYII=', 'base64')
export const fixtureFile = Buffer.from('fixture-file-bytes')
const imageId = attachmentId(fixtureImage)
const fileId = attachmentId(fixtureFile)
const historySettingLibrary = characterId => ({ characterId, name: 'History {{char}} fixture', activeVersionId: 'v1',
  groups: [], entries: [], promptPositions: [], versions: [], listAllExpanded: false, expandedGroupIds: [] })

export const sourceArchive = {
  format: 'eleckoi.desktop-chat-history', version: 2, exportedAt: '2026-10-10T00:00:00.000Z',
  snapshot: {
    format: 'eleckoi.desktop-conversation', version: 2, conversationId: 'source-chat', characterId: 'source-character',
    tables: {
      chat_sessions: [{ id: 'source-chat', title: 'Fixture conversation', characterId: 'source-character',
        characterName: 'Fixture character', characterAvatar: '', historyMessageCount: 2,
        createdAt: '2026-10-10T00:00:00.000Z', updatedAt: '2026-10-10T00:00:01.000Z' }],
      chat_session_character_snapshots: [],
      chat_session_variable_states: [],
      agent_conversations: [{ id: 'source-chat', activeBranchId: 'source-branch',
        runtimeThreadId: 'source-session', variableVersionId: 'variable-config-default' }],
      agent_branches: [{ id: 'source-branch', conversationId: 'source-chat' }],
      conversation_speakers: [],
      agent_turns: [],
      agent_responses: [],
      agent_branch_turns: [],
      agent_openings: [],
      agent_setting_snapshots: [],
    },
    stateHistory: { version: 1, operations: [{
      operationId: 'source-edit-1', kind: 'edit', outcome: 'committed', baseHash: 'source-world-hash', revision: 1,
      anchor: { sessionId: 'source-session', turn: 1, inputMessageId: 'message-user', outputMessageId: 'message-assistant' },
      before: { variableStateJson: '{"mood":0}', settingLibrary: historySettingLibrary('source-character') },
      after: { variableStateJson: '{"mood":1}', settingLibrary: historySettingLibrary('source-character') },
      createdAt: '2026-10-10T00:00:01.000Z',
    }] },
  },
  sessionLogs: [{
    header: { version: 4, id: 'source-session', createdAt: 1791590400000, cwd: 'C:\\fixture\\source-workspace', isSeeded: false, agentPreset: 'native-root' },
    inheritedEventCount: 0,
    events: [
      { seq: 0, time: 1791590400000, type: 'user/message', surfaceOp: 'append', data: { id: 'message-user', role: 'user', source: { kind: 'user' }, content: [
        { type: 'text', text: 'A local fixture prompt' },
        { type: 'image', attachment: { attachmentId: imageId, mediaType: 'image/png', bytes: fixtureImage.length, width: 1, height: 1, name: 'sample.png' } },
        { type: 'file', attachment: { attachmentId: fileId, bytes: fixtureFile.length, name: 'sample.txt' } },
      ] } },
      { seq: 1, time: 1791590401000, type: 'assistant/message', surfaceOp: 'append', data: { turn: 1, step: 1,
        message: { id: 'message-assistant', role: 'assistant', source: { kind: 'model', provider: 'fixture-local', model: 'fixture-chat' },
          content: [{ type: 'text', text: 'A deterministic local reply' }] }, stream: [] } },
    ],
  }],
}

export function createTrialPublicHost({ onImportArchive, onSettingMutation, onSettingLibrarySave } = {}) {
  const savedImages = new Map()
  const savedFiles = new Map()
  const settings = [{ ns: 'llm-pi-ai', revision: 1, value: {
    providers: {
      'fixture-local': { api: 'openai-completions', apiKeyEnv: 'FIXTURE_LOCAL_API_KEY', baseURL: 'http://127.0.0.1:5010/v1', apiKey: 'fixture-secret' },
      'local-route': { api: 'openai-completions', apiKeyEnv: 'LOCAL_ROUTE_API_KEY', baseURL: 'http://127.0.0.1:5011/v1' },
    },
  } }]
  let importedCharacterId = 0
  let importedProductPresetId = 0
  let importedConversationId = 0
  let activeProductPresetId = 'product-source'
  const nativeDocuments = new Map([
    ['native-root', { agentPreset: 'native-root', name: 'Native root', description: 'Fixture root', content: stringifyYaml([
      { id: 'system-prompt', config: { personaPrefix: 'Fixture root prompt' } },
    ]) }],
    ['native-member', { agentPreset: 'native-member', name: 'Native member', description: 'Fixture member', content: stringifyYaml([
      { id: 'system-prompt', config: { personaPrefix: 'Fixture member prompt' } },
      { id: 'member-tool', name: '@fixture/dsh-member-tool', config: { apiKey: 'native-preset-secret' } },
    ]) }],
    ['worker-default', { agentPreset: 'worker-default', name: 'Worker default', description: '', content: stringifyYaml([]) }],
  ])
  const rootAgent = { id: 'source-session', ctx: { agentPreset: 'native-root' } }
  const selectedNativePresets = []
  const productPreset = id => ({ id, name: 'Fixture product preset', toolGroups: [{ id: 'builtin-tools', source: 'built_in', included: true }], entries: [] })
  const ctx = {
    eleckoiConversationsApi: {
      details: async conversationId => !conversationId.startsWith('worker-conversation-')
        ? { conversation: { id: conversationId, title: 'Fixture conversation', characterId: 'source-character' }, runtimeSessionId: 'source-session', messages: [{ id: 'message-user' }, { id: 'message-assistant' }] }
        : { conversation: { id: conversationId, title: 'Imported fixture', characterId: `worker-character-${importedCharacterId}` }, runtimeSessionId: 'worker-session-1', messages: [{ id: 'message-user' }, { id: 'message-assistant' }] },
      authorState: async () => ({ initialVariableStateJson: '{"mood":0}', currentVariableStateJson: '{"mood":1}', variableConfig: null,
        settingLibrarySummary: null, settingLibrary: { characterId: 'source-character', name: 'Expanded fixture', groups: [], entries: [] },
        editableSettingLibrary: { characterId: 'source-character', name: 'Raw {{char}} fixture', activeVersionId: 'v1', groups: [], entries: [],
          promptPositions: [], versions: [], listAllExpanded: false, expandedGroupIds: [] } }),
      exportArchive: async () => JSON.stringify(sourceArchive),
      importArchiveWithMapping: async (characterId, archiveText) => {
        onImportArchive?.({ characterId, archive: JSON.parse(archiveText) })
        const archive = JSON.parse(archiveText)
        const sessions = Object.fromEntries(archive.sessionLogs.map((log, index) => [log.header.id, `worker-session-${index + 1}`]))
        rootAgent.id = sessions['source-session']
        rootAgent.ctx.agentPreset = 'worker-default'
        const messages = Object.fromEntries(archive.sessionLogs.flatMap(log => log.events.flatMap(event => {
          if (event.type === 'user/message') return [[event.data.id, event.data.id]]
          if (event.type === 'assistant/message') return [[event.data.message.id, event.data.message.id]]
          return []
        })))
        for (const operation of archive.snapshot.stateHistory?.operations ?? []) {
          if (typeof operation.anchor?.sessionId === 'string') operation.anchor.sessionId = sessions[operation.anchor.sessionId] ?? operation.anchor.sessionId
        }
        return { conversationId: `worker-conversation-${++importedConversationId}`, sessions, messages }
      },
    },
    eleckoiCharactersApi: {
      export: async () => ({ fileName: 'fixture.json', mimeType: 'application/json', base64: Buffer.from('{"name":"Fixture"}').toString('base64') }),
      prepareImport: async files => ({ token: files[0].displayName }),
      commitImport: async () => ({ importedCharacterIds: [`worker-character-${++importedCharacterId}`] }),
    },
    eleckoiCharacterConfigurationApi: {
      saveSettingLibrary: async (characterId, library) => {
        onSettingLibrarySave?.({ characterId, library })
        return library
      },
    },
    eleckoiConversationModelsApi: {
      current: async () => ({ provider: 'fixture-local', model: 'fixture-chat', reasoningEffort: 'low' }),
      select: async (_conversationId, selection) => selection,
    },
    eleckoiAgentPresetsApi: {
      catalog: async () => ({ activePresetIds: { roleplay: activeProductPresetId, creator: 'creator-fixture' }, presets: [productPreset(activeProductPresetId)] }),
      setActive: async id => { activeProductPresetId = id; return { activePresetIds: { roleplay: id, creator: 'creator-fixture' } } },
      read: async id => productPreset(id),
      export: async id => ({ fileName: `${id}.json`, mimeType: 'application/json', base64: Buffer.from(JSON.stringify(productPreset(id))).toString('base64') }),
      import: async (_source, document) => ({ preset: { ...productPreset(`worker-product-${++importedProductPresetId}`), sourceDocument: document }, document }),
    },
    agentPresets: {
      list: async () => [...nativeDocuments.values()].map(({ agentPreset, name }) => ({ id: agentPreset, name })),
      readDocument: async id => {
        const document = nativeDocuments.get(id)
        if (!document) throw new Error(`Unknown native Agent preset: ${id}`)
        return structuredClone(document)
      },
      register: async definition => {
        nativeDocuments.set(definition.id, { agentPreset: definition.id, name: definition.name, description: definition.description,
          content: stringifyYaml(definition.plugins) })
        return () => nativeDocuments.delete(definition.id)
      },
      composedPreset: agentContext => agentContext.agentPreset,
      select: async (agent, id) => {
        agent.ctx.agentPreset = id
        selectedNativePresets.push({ agentId: agent.id, id })
      },
    },
    agents: { get: id => id === rootAgent.id ? rootAgent : undefined },
    sessionController: {
      resolveAgent: async id => id === rootAgent.id ? { agent: rootAgent } : { error: new Error(`Unknown Session: ${id}`) },
    },
    sessionQuery: { observeSession: async () => ({ events: [], [Symbol.dispose]() {} }) },
    llm: {
      listConfigurableProviders: () => [
        { provider: 'fixture-local', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'fixture-local'] },
        { provider: 'local-route', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'local-route'] },
      ],
      listProviders: () => [{ id: 'fixture-local' }, { id: 'local-route' }],
    },
    pluginManager: { listBundles: async () => [
      { name: '@deepseek-ai/dsh-llm-pi-ai', installed: true, enabled: true },
      { name: '@rp-team/dsh-roleplay-team', installed: true, enabled: true },
    ] },
    settings: {
      describe: () => structuredClone(settings),
      mutate: async (namespace, operations, revision) => {
        onSettingMutation?.({ namespace, operations, revision })
        return undefined
      },
    },
    credentials: { resolve: async ref => ({ value: ref === 'FIXTURE_LOCAL_API_KEY' ? 'credential-only-in-worker-env' : '' }) },
    attachments: {
      readImage: async ref => {
        if (ref.attachmentId !== imageId) throw new Error('Unexpected public image attachment ref.')
        return { ref, data: new Uint8Array(fixtureImage) }
      },
      readFileStream: async function* (ref) {
        if (ref.attachmentId !== fileId) throw new Error('Unexpected public file attachment ref.')
        yield new Uint8Array(fixtureFile)
      },
      saveImage: async input => {
        const bytes = Buffer.from(input.data)
        const ref = { attachmentId: attachmentId(bytes), mediaType: input.mediaType, bytes: bytes.length, width: 1, height: 1, name: input.name }
        savedImages.set(ref.attachmentId, bytes)
        return ref
      },
      saveFileStream: async input => {
        const chunks = []
        for await (const chunk of input.data) chunks.push(Buffer.from(chunk))
        const bytes = Buffer.concat(chunks)
        const ref = { attachmentId: attachmentId(bytes), bytes: bytes.length, name: input.name }
        savedFiles.set(ref.attachmentId, bytes)
        return ref
      },
    },
  }
  return { ctx, savedImages, savedFiles, nativeDocuments, selectedNativePresets, getActiveProductPresetId: () => activeProductPresetId }
}

function attachmentId(bytes) { return `sha256:${createHash('sha256').update(bytes).digest('hex')}` }
