import { teamError } from '../shared/schema.mjs'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'

export const TRIAL_FROZEN_DATA_FORMAT = 'rp-team.trial-frozen-data'
export const TRIAL_FROZEN_DATA_VERSION = 2

const SECRET_KEYS = new Set(['apikey', 'apitoken', 'token', 'credential', 'secret', 'password', 'authorization', 'bearer', 'accesstoken', 'refreshtoken'])

/** Capture only public ElecKoi/DSH projections and durable attachment bytes. */
export async function freezeTrialData(ctx, { conversationId, nativePresetIds = [] }) {
  const conversations = requireApi(ctx.eleckoiConversationsApi, 'ElecKoi Conversations API')
  const [details, authorState, archiveText, modelSelection] = await Promise.all([
    conversations.details(conversationId),
    conversations.authorState(conversationId),
    conversations.exportArchive(conversationId),
    ctx.eleckoiConversationModelsApi?.current?.(conversationId) ?? {},
  ])
  const archive = parseArchive(archiveText)
  const characterId = archive.snapshot?.characterId ?? details.conversation?.characterId
  if (typeof characterId !== 'string' || !characterId) throw trialError('Frozen conversation has no public character identity.')
  const character = await requireApi(ctx.eleckoiCharactersApi, 'ElecKoi Characters API').export(characterId, 'json')
  if (!character || typeof character.base64 !== 'string') throw trialError('ElecKoi did not export the selected character.')

  const routeIds = new Set([modelSelection?.provider].filter(text))
  const modelProviders = captureProviderSettings(ctx, routeIds)
  const productPresetApi = requireApi(ctx.eleckoiAgentPresetsApi, 'ElecKoi product Agent Presets API')
  const productCatalog = await productPresetApi.catalog()
  const activeProductPresetId = text(productCatalog.activePresetIds.roleplay) ?? null
  const productPresets = await exportProductAgentPresets(ctx, activeProductPresetId ? [activeProductPresetId] : [])
  const rootNativePresetId = await activeRootNativePresetId(ctx, details.runtimeSessionId, archive)
  const nativePresetDocuments = await exportNativePresets(ctx, nativePresetIds)
  const attachments = await captureAttachments(ctx.attachments, archive)
  const loadedBundles = (await ctx.pluginManager?.listBundles?.() ?? [])
    .filter(bundle => bundle.installed && bundle.enabled && typeof bundle.name === 'string')
    .map(bundle => bundle.name)
  return validateFrozenTrialData({
    format: TRIAL_FROZEN_DATA_FORMAT,
    version: TRIAL_FROZEN_DATA_VERSION,
    conversationId,
    characterId,
    createdAt: new Date().toISOString(),
    archive,
    details: structuredClone(details),
    authorState: { ...authorState, editableSettingLibrary: authorState.editableSettingLibrary ?? null },
    character: structuredClone(character),
    modelSelection: structuredClone(modelSelection ?? {}),
    modelProviders,
    activeProductPresetId,
    productPresets,
    rootNativePresetId,
    nativePresetDocuments,
    attachments,
    loadedBundles,
  })
}

/** Add selected routes and preset documents using DSH's public registries. */
export async function captureTrialDependencies(ctx, snapshot, { providerIds = [], nativePresetIds = [] } = {}) {
  const routeIds = new Set([
    ...(snapshot.modelSelection?.provider ? [snapshot.modelSelection.provider] : []),
    ...(snapshot.modelProviders ?? []).map(item => item.provider),
    ...providerIds,
  ].filter(text))
  const routes = new Map((snapshot.modelProviders ?? []).map(item => [item.provider, item]))
  for (const route of captureProviderSettings(ctx, routeIds)) routes.set(route.provider, route)
  const nativePresets = new Map((snapshot.nativePresetDocuments ?? []).map(item => [item.id, item]))
  for (const item of await exportNativePresets(ctx, nativePresetIds)) nativePresets.set(item.id, item)
  return validateFrozenTrialData({
    ...structuredClone(snapshot),
    modelProviders: [...routes.values()],
    nativePresetDocuments: [...nativePresets.values()],
  })
}

/** Import the frozen public archive into a fresh worker profile and return exact identity maps. */
export async function importTrialData(ctx, snapshot) {
  const frozen = validateFrozenTrialData(snapshot)
  const rootLog = frozen.archive.sessionLogs.find(log => log.header?.id === frozen.details.runtimeSessionId)
  if (!rootLog || (archivedNativePresetId(rootLog) && archivedNativePresetId(rootLog) !== frozen.rootNativePresetId)) {
    throw trialError('The frozen official Session archive does not preserve its root native Agent preset identity.')
  }
  const characters = requireApi(ctx.eleckoiCharactersApi, 'ElecKoi Characters API')
  const preview = await characters.prepareImport([{
    displayName: frozen.character.fileName,
    mimeType: frozen.character.mimeType,
    base64: frozen.character.base64,
  }], 'eleckoi')
  const importedCharacter = await characters.commitImport(preview.token)
  const characterId = importedCharacter.importedCharacterIds?.[0]
  if (!characterId) throw trialError('The character archive was not imported into the isolated profile.')

  const settingLibrary = frozen.authorState.editableSettingLibrary
  if (settingLibrary !== null) {
    const configuration = requireApi(ctx.eleckoiCharacterConfigurationApi, 'ElecKoi Character Configuration API')
    if (typeof configuration.saveSettingLibrary !== 'function') {
      throw trialError('The Host is missing the public SettingLibrary import API.')
    }
    await configuration.saveSettingLibrary(characterId, { ...structuredClone(settingLibrary), characterId })
  }

  const productPresetIds = await importProductAgentPresets(ctx, frozen.productPresets)
  const activeProductPresetId = frozen.activeProductPresetId
    ? productPresetIds[frozen.activeProductPresetId]
    : undefined
  if (activeProductPresetId) await requireApi(ctx.eleckoiAgentPresetsApi, 'ElecKoi product Agent Presets API').setActive(activeProductPresetId)
  const nativePresetIds = await importNativePresets(ctx, frozen.nativePresetDocuments)
  const rootNativePresetId = frozen.rootNativePresetId

  const attachmentIds = await importAttachments(ctx.attachments, frozen.attachments)
  const archive = structuredClone(frozen.archive)
  archive.snapshot.characterId = characterId
  for (const session of archive.snapshot.tables?.chat_sessions ?? []) {
    if (session.id === archive.snapshot.conversationId) session.characterId = characterId
  }
  for (const operation of archive.snapshot.stateHistory?.operations ?? []) {
    for (const state of [operation.before, operation.after]) {
      const library = state?.settingLibrary
      if (library && typeof library === 'object' && library.characterId === frozen.characterId) {
        library.characterId = characterId
      }
    }
  }
  rewriteAttachmentRefs(archive, attachmentIds)
  const conversations = requireApi(ctx.eleckoiConversationsApi, 'ElecKoi Conversations API')
  if (typeof conversations.importArchiveWithMapping !== 'function') {
    throw trialError('The Host is missing the exact archive identity mapping API.')
  }
  const mapping = await conversations.importArchiveWithMapping(characterId, JSON.stringify(archive))
  const conversationId = mapping?.conversationId
  const oldRootSessionId = frozen.details.runtimeSessionId
  const sessionId = mapping?.sessions?.[oldRootSessionId]
  if (typeof conversationId !== 'string' || typeof sessionId !== 'string') {
    throw trialError('Archive import did not return the conversation and root Session mappings.')
  }
  const importedDetails = await conversations.details(conversationId)
  if (importedDetails.runtimeSessionId !== sessionId) throw trialError('Imported root Session mapping does not match the public conversation projection.')

  await restoreModelSettings(ctx, frozen.modelProviders)
  if (frozen.modelSelection?.provider) {
    await ctx.eleckoiConversationModelsApi?.select?.(conversationId, frozen.modelSelection)
  }
  return {
    conversationId,
    sessionId,
    sessionMapping: structuredClone(mapping.sessions),
    messageMapping: structuredClone(mapping.messages),
    productPresetIds,
    nativePresetIds,
    rootNativePresetId,
    characterId,
  }
}

export function validateFrozenTrialData(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.format !== TRIAL_FROZEN_DATA_FORMAT || value.version !== TRIAL_FROZEN_DATA_VERSION
    || typeof value.conversationId !== 'string' || typeof value.characterId !== 'string'
    || !value.archive || !Array.isArray(value.archive.sessionLogs)
    || !value.character || typeof value.character.base64 !== 'string'
    || !value.details || typeof value.details.runtimeSessionId !== 'string'
    || !value.authorState || !Object.hasOwn(value.authorState, 'editableSettingLibrary')
    || !Array.isArray(value.attachments) || !Array.isArray(value.modelProviders)
    || !(value.activeProductPresetId === null || typeof value.activeProductPresetId === 'string')
    || !Array.isArray(value.productPresets) || typeof value.rootNativePresetId !== 'string'
    || !Array.isArray(value.nativePresetDocuments) || !Array.isArray(value.loadedBundles)) {
    throw teamError('RP_TEAM_TRIAL_SNAPSHOT_INVALID', 'The public trial snapshot is incomplete.')
  }
  return structuredClone(value)
}

function captureProviderSettings(ctx, providerIds) {
  if (!providerIds.size) return []
  const providers = ctx.llm?.listConfigurableProviders?.() ?? []
  const settings = ctx.settings?.describe?.() ?? []
  return [...providerIds].flatMap(provider => {
    const route = providers.find(item => item.provider === provider)
    if (!route) return [{ provider }]
    const descriptor = settings.find(item => item.ns === route.settingsNs)
    if (!descriptor) return [{ provider, settingsNs: route.settingsNs, settingsPath: [...route.settingsPath] }]
    const settingsValue = getPath(descriptor.value, route.settingsPath)
    return [{
      provider,
      settingsNs: route.settingsNs,
      settingsPath: [...route.settingsPath],
      ...(settingsValue === undefined ? {} : { settingsValue: scrubSetting(settingsValue) }),
      credentialRefs: [...collectCredentialRefs(settingsValue)],
    }]
  })
}

async function exportProductAgentPresets(ctx, ids) {
  if (!ids.length) return []
  const api = requireApi(ctx.eleckoiAgentPresetsApi, 'ElecKoi Agent Presets API')
  return Promise.all([...new Set(ids)].map(async id => {
    const [preset, document] = await Promise.all([api.read(id), api.export(id, 'json')])
    return { id, preset: scrubSetting(preset), document: scrubDocument(document) }
  }))
}

async function exportNativePresets(ctx, ids) {
  if (!ids.length) return []
  const api = requireApi(ctx.agentPresets, 'DSH native Agent preset API')
  return Promise.all([...new Set(ids)].map(async id => {
    const document = await api.readDocument(id)
    if (!document || document.agentPreset !== id || typeof document.content !== 'string') {
      throw trialError(`DSH did not expose the complete native Agent preset document ${id}.`)
    }
    const plugins = parseYaml(document.content)
    if (!Array.isArray(plugins)) throw trialError(`DSH native Agent preset ${id} is not a portable plugin composition.`)
    return {
      id,
      name: typeof document.name === 'string' ? document.name : id,
      description: typeof document.description === 'string' ? document.description : '',
      content: stringifyYaml(scrubSetting(plugins)),
    }
  }))
}

async function activeRootNativePresetId(ctx, sessionId, archive) {
  const agent = await resolveSessionAgent(ctx, sessionId)
  const composed = agent && ctx.agentPresets?.composedPreset?.(agent.ctx)
  const rootLog = archive.sessionLogs.find(log => log.header?.id === sessionId)
  const headerPreset = archivedNativePresetId(rootLog)
  if (typeof composed === 'string' && composed && typeof headerPreset === 'string' && headerPreset !== composed) {
    throw trialError(`The public DSH Agent and Session disagree on native preset identity for ${sessionId}.`)
  }
  if (typeof composed === 'string' && composed) return composed
  if (typeof headerPreset === 'string' && headerPreset) return headerPreset
  throw trialError(`The public DSH Session ${sessionId} did not expose its active native Agent preset.`)
}

function archivedNativePresetId(inspectionOrLog) {
  const events = inspectionOrLog?.events ?? []
  const selected = [...events].reverse().find(event => event.type === 'agent-preset/selected'
    && typeof event.data?.agentPreset === 'string')?.data?.agentPreset
  return selected ?? inspectionOrLog?.header?.agentPreset
}

async function resolveSessionAgent(ctx, sessionId) {
  const resolved = await ctx.sessionController?.resolveAgent?.(sessionId)
  if (resolved?.error) throw resolved.error
  const agent = resolved?.agent ?? ctx.agents?.get?.(sessionId)
  if (!agent) throw trialError(`The public DSH Session ${sessionId} could not be resolved to an Agent.`)
  return agent
}

async function captureAttachments(attachments, archive) {
  const refs = collectAttachmentRefs(archive)
  if (refs.length && !attachments) throw trialError('DSH attachments are required to freeze the selected conversation.')
  return Promise.all(refs.map(async ({ kind, ref }) => {
    const data = kind === 'image'
      ? (await attachments.readImage(ref)).data
      : await collectStream(attachments.readFileStream(ref))
    return { kind, ref: structuredClone(ref), dataBase64: Buffer.from(data).toString('base64') }
  }))
}

async function importAttachments(attachments, rows) {
  const mapping = new Map()
  for (const item of rows) {
    const data = Buffer.from(item.dataBase64, 'base64')
    const ref = item.kind === 'image'
      ? await attachments.saveImage({ data: new Uint8Array(data), mediaType: item.ref.mediaType, name: item.ref.name })
      : await attachments.saveFileStream({ data: bufferChunks(data), name: item.ref.name })
    mapping.set(`${item.kind}:${item.ref.attachmentId}`, ref)
  }
  return mapping
}

async function restoreModelSettings(ctx, routes) {
  for (const route of routes) {
    if (!route.settingsNs || !Array.isArray(route.settingsPath) || route.settingsValue === undefined) continue
    const descriptor = ctx.settings?.describe?.().find(item => item.ns === route.settingsNs)
    if (!descriptor || typeof ctx.settings?.mutate !== 'function') throw trialError(`The isolated profile is missing DSH model settings namespace ${route.settingsNs}.`)
    await ctx.settings.mutate(route.settingsNs, [{ op: 'set', path: route.settingsPath, value: structuredClone(route.settingsValue) }], descriptor.revision)
  }
}

async function importProductAgentPresets(ctx, presets) {
  const mapping = {}
  if (!presets.length) return mapping
  const api = requireApi(ctx.eleckoiAgentPresetsApi, 'ElecKoi Agent Presets API')
  for (const item of presets) {
    const imported = await api.import('eleckoi', {
      displayName: item.document.fileName,
      mimeType: item.document.mimeType,
      base64: item.document.base64,
    }, 'roleplay')
    mapping[item.id] = imported.preset.id
  }
  return mapping
}

async function importNativePresets(ctx, presets) {
  const mapping = {}
  if (!presets.length) return mapping
  const api = requireApi(ctx.agentPresets, 'DSH native Agent preset API')
  for (const item of presets) {
    const plugins = parseYaml(item.content)
    if (!Array.isArray(plugins)) throw trialError(`Frozen native Agent preset ${item.id} is not a plugin composition.`)
    const existing = await api.readDocument(item.id).catch(() => undefined)
    if (existing) {
      const existingPlugins = typeof existing.content === 'string' ? parseYaml(existing.content) : undefined
      if (JSON.stringify(existingPlugins) !== JSON.stringify(plugins)) {
        throw trialError(`The isolated DSH profile already has a different native Agent preset registered as ${item.id}.`)
      }
    } else {
      await api.register({ id: item.id, name: item.name, description: item.description, plugins })
    }
    mapping[item.id] = item.id
  }
  return mapping
}

function collectAttachmentRefs(archive) {
  const found = new Map()
  const visit = value => {
    if (!value || typeof value !== 'object') return
    if ((value.type === 'image' || value.type === 'file') && value.attachment?.attachmentId) {
      const kind = value.type
      const ref = value.attachment
      found.set(`${kind}:${ref.attachmentId}`, { kind, ref })
    }
    if (Array.isArray(value)) for (const child of value) visit(child)
    else for (const child of Object.values(value)) visit(child)
  }
  visit(archive.sessionLogs)
  return [...found.values()]
}

function rewriteAttachmentRefs(archive, mapping) {
  const visit = value => {
    if (!value || typeof value !== 'object') return
    if ((value.type === 'image' || value.type === 'file') && value.attachment?.attachmentId) {
      const ref = mapping.get(`${value.type}:${value.attachment.attachmentId}`)
      if (!ref) throw trialError(`Frozen ${value.type} attachment ${value.attachment.attachmentId} is missing its bytes.`)
      value.attachment = structuredClone(ref)
    }
    if (Array.isArray(value)) for (const child of value) visit(child)
    else for (const child of Object.values(value)) visit(child)
  }
  visit(archive.sessionLogs)
}

function parseArchive(value) {
  try {
    const archive = typeof value === 'string' ? JSON.parse(value) : structuredClone(value)
    if (archive?.format !== 'eleckoi.desktop-chat-history' || ![1, 2].includes(archive.version) || !Array.isArray(archive.sessionLogs)) throw new Error('Invalid archive')
    return archive
  } catch (error) {
    throw teamError('RP_TEAM_TRIAL_SNAPSHOT_INVALID', `The selected conversation archive is not a valid public DSH archive: ${error.message}`)
  }
}

function scrubDocument(document) {
  const result = { ...structuredClone(document) }
  if (result.mimeType === 'application/json' && typeof result.base64 === 'string') {
    const parsed = JSON.parse(Buffer.from(result.base64, 'base64').toString('utf8'))
    result.base64 = Buffer.from(JSON.stringify(scrubSetting(parsed))).toString('base64')
  }
  return result
}

function scrubSetting(value) {
  if (Array.isArray(value)) return value.map(scrubSetting)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !SECRET_KEYS.has(key.replace(/[^a-z0-9]/giu, '').toLowerCase()))
    .map(([key, child]) => [key, scrubSetting(child)]))
}

function collectCredentialRefs(value) {
  const refs = new Set()
  const visit = item => {
    if (!item || typeof item !== 'object') return
    if (typeof item.apiKeyEnv === 'string') refs.add(item.apiKeyEnv)
    if (typeof item.credentialRef === 'string') refs.add(item.credentialRef)
    if (Array.isArray(item)) for (const child of item) visit(child)
    else for (const child of Object.values(item)) visit(child)
  }
  visit(value)
  return refs
}

function getPath(value, path) {
  return path.reduce((current, key) => current?.[key], value)
}

async function collectStream(stream) {
  const chunks = []
  for await (const chunk of stream) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks)
}

async function* bufferChunks(buffer) {
  const chunkSize = 64 * 1024
  for (let offset = 0; offset < buffer.length; offset += chunkSize) yield new Uint8Array(buffer.subarray(offset, offset + chunkSize))
}

function requireApi(value, label) {
  if (!value) throw trialError(`${label} is not available in the active DSH profile.`)
  return value
}

function trialError(message) {
  return teamError('RP_TEAM_TRIAL_SNAPSHOT_INVALID', message)
}

function text(value) { return typeof value === 'string' && value ? value : undefined }
