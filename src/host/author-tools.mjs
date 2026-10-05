import { createHash } from 'node:crypto'
import { MANAGED_CAPABILITIES, TRUSTED_CAPABILITIES, capabilityLabel } from './native-policy.mjs'
import { describeStateToolAccess, projectStateValueForAgent } from './state-store.mjs'
import { missingContextSelections } from './context-policy.mjs'
import { projectAgentContext, projectAvailableSources } from './agent-context.mjs'
import { exportComponent, prepareComponentImport } from '../shared/components.mjs'
import { evaluateCondition, normalizeTeamConfig, teamError } from '../shared/schema.mjs'
import { resolveAuthorParameters } from '../shared/author-parameters.mjs'
import { setPointerValue } from './context-world-adapter.mjs'
import { PresetLibrary, presetLibraryPath } from './preset-library.mjs'

const SOURCE_LABELS = Object.freeze({
  current_input: 'Current input', recent_history: 'Recent history', full_history: 'Full history',
  character_card: 'Character card', worldbook: 'Worldbook', long_memory: 'Long memory',
  scene_state: 'Scene state', agent_messages: 'Agent messages', drafts: 'Drafts', hidden_state: 'Hidden state'
})
const SOURCE_ORDER = Object.freeze(Object.keys(SOURCE_LABELS))
const DYNAMIC_CONTEXT_SOURCES = new Set(['agent_messages', 'drafts'])

/** Author-facing read-only preview and persistent library API. */
export function createAuthorToolsApi({ ctx, store, stateStore, getOptions, readState, presetLibrary } = {}) {
  let library = presetLibrary ?? null
  const getLibrary = () => {
    if (!library) library = new PresetLibrary(presetLibraryPath(store, ctx))
    return library
  }

  const api = {
    async getContextCatalog({ conversationId }) {
      const id = requireConversationId(conversationId)
      const snapshot = await readAuthorSnapshot(ctx, id)
      const state = typeof readState === 'function' ? await readState({ conversationId: id }) : null
      const sources = projectAvailableSources(snapshot.context, { worldState: snapshot.world ?? {} })
      return {
        version: sourceVersion(snapshot, state),
        anchor: snapshot.anchor ?? null,
        sources: SOURCE_ORDER.map(type => ({
          type,
          label: SOURCE_LABELS[type],
          fields: catalogFields(type, sources[type])
        })),
        busy: snapshot.busy === true || state?.busy === true
      }
    },

    async previewConfig({ conversationId, config, parameterValues = {}, inputText, manualAgentIds = [] }) {
      const id = requireConversationId(conversationId)
      if (inputText !== undefined && typeof inputText !== 'string') throw teamError('RP_TEAM_INVALID_REQUEST', 'inputText must be text')
      if (!Array.isArray(manualAgentIds) || manualAgentIds.some(value => typeof value !== 'string')) {
        throw teamError('RP_TEAM_INVALID_REQUEST', 'manualAgentIds must be a list of agent ids')
      }
      const resolved = resolveAuthorParameters(normalizeTeamConfig(config), parameterValues)
      const normalized = resolved.config
      const snapshot = await readAuthorSnapshot(ctx, id)
      const issues = []
      const knownIds = new Set(normalized.agents.map(agent => agent.id))
      const unknownManualIds = [...new Set(manualAgentIds)].filter(agentId => !knownIds.has(agentId))
      if (unknownManualIds.length) issues.push({ code: 'unknown-manual-agent', severity: 'warning', agentIds: unknownManualIds })

      let initialState = null
      let stateBusy = false
      if (typeof readState === 'function') {
        try {
          initialState = await readState({ conversationId: id })
          if (!initialState || !Array.isArray(initialState.values)) initialState = null
          else {
            stateBusy = initialState.busy === true
          }
          if (initialState && snapshot.anchor && initialState.anchor
            && stableJson(snapshot.anchor) !== stableJson(initialState.anchor)) {
            initialState = null
            issues.push({
              code: 'initial-state-stale', severity: 'warning',
              message: 'The committed state snapshot belongs to a different conversation anchor; state-dependent preview results are unknown.'
            })
          }
        } catch (error) {
          issues.push({ code: 'initial-state-unavailable', severity: 'warning', message: error?.message ?? String(error) })
        }
      } else {
        issues.push({ code: 'initial-state-unavailable', severity: 'warning', message: 'Author state reader is unavailable.' })
      }
      const previewBusy = snapshot.busy === true || stateBusy
      const previewSnapshot = previewBusy === (snapshot.busy === true) ? snapshot : { ...snapshot, busy: true }
      const members = normalized.agents.map(agent => previewMember({
        agent, config: normalized, snapshot: previewSnapshot, initialState, inputText,
        manualAgentIds: new Set(manualAgentIds.filter(agentId => knownIds.has(agentId)))
      }))
      if (previewBusy) {
        for (const member of members) member.dynamic.push('Conversation is busy; the source snapshot or initial values may change before a run starts.')
      }
      return {
        configHash: sha256(stableJson(normalized)),
        parameterResolution: { values: resolved.values, changes: resolved.changes, sourceHash: resolved.sourceHash, resolvedHash: resolved.resolvedHash },
        sourceVersion: sourceVersion(snapshot, initialState),
        anchor: snapshot.anchor ?? null,
        members,
        issues
      }
    },

    listPresets() { return { presets: getLibrary().list() } },
    getPreset({ id, version }) { return getLibrary().get(id, version) },
    savePreset({ config }) { return getLibrary().save(config) },
    copyPreset({ id, version, name }) { return getLibrary().copy({ id, version, name }) },
    deletePreset({ id }) { return getLibrary().delete(id) },
    exportPreset({ id, version }) { return { preset: getLibrary().export(id, version) } },
    importPreset({ preset }) { return getLibrary().import(preset) },
    exportComponent({ config, agentIds, name }) { return { component: exportComponent(config, agentIds, name) } },
    prepareComponentImport(input) { return prepareComponentImport(input) }
  }
  // These runtime services are intentionally not consulted by previews. In particular,
  // getOptions may inspect executable native preset scopes; static preview stays inert.
  void stateStore
  void getOptions
  return Object.freeze(api)
}

function previewMember({ agent, config, snapshot, initialState, inputText, manualAgentIds }) {
  const dynamic = []
  const reasons = []
  const issues = []
  const stateNamespaces = projectAgentState(agent, config.state.definitions, initialState)
  const sources = projectAvailableSources(snapshot.context, {
    currentInput: inputText,
    worldState: stateNamespaces.world ?? {}
  })
  const projection = projectAgentContext(agent, sources, { messages: [], drafts: [] })
  const missingSelections = missingContextSelections(agent, sources)
  for (const selection of agent.context.sources) {
    if (DYNAMIC_CONTEXT_SOURCES.has(selection.type)) {
      dynamic.push(`${SOURCE_LABELS[selection.type]} will depend on messages or drafts created during the run; none are fabricated in this preview.`)
    }
    if (selection.type === 'current_input' && selection.selector?.startsWith('/attachments') && sources.current_input.attachments.length === 0) {
      dynamic.push('Selected attachments are not present in the current author snapshot.')
    }
  }

  let triggered = false
  for (const trigger of agent.triggers) {
    if (trigger.type === 'always') {
      triggered = true
      reasons.push('Always trigger is enabled.')
    } else if (trigger.type === 'manual') {
      if (manualAgentIds.has(agent.id)) {
        triggered = true
        reasons.push('Agent is included in manualAgentIds.')
      } else reasons.push('Manual trigger is not selected.')
    } else if (trigger.type === 'requested_by_agent') {
      dynamic.push('Incoming agent requests are not available before a run starts.')
      reasons.push('Waiting for a configured incoming agent request.')
    } else if (trigger.type === 'condition') {
      if (initialState === null) {
        dynamic.push('Condition trigger cannot be evaluated because the initial state snapshot is unavailable.')
        reasons.push('Initial condition is unknown.')
      } else {
        const matches = evaluateCondition(stateNamespaces, trigger.condition)
        triggered ||= matches
        reasons.push(matches ? 'Initial state condition matches.' : 'Initial state condition does not match.')
        dynamic.push('Condition result can change if an earlier agent edits state before this agent activates.')
      }
    } else if (trigger.type === 'keyword') {
      const input = projection.sources.current_input
      const text = typeof input === 'string' ? input : input?.text
      const normalize = value => trigger.caseSensitive ? value : value.toLowerCase()
      const matches = typeof text === 'string' && trigger.keywords[trigger.match === 'all' ? 'every' : 'some'](word => normalize(text).includes(normalize(word)))
      triggered ||= matches
      reasons.push(matches ? 'Visible input keywords match.' : 'Visible input keywords do not match.')
    } else if (trigger.type === 'periodic') {
      if (Number.isSafeInteger(snapshot.userTurnOrdinal)) {
        const ordinal = snapshot.userTurnOrdinal + 1, offset = trigger.offset || 0
        const matches = ordinal >= offset && (ordinal - offset) % trigger.every === 0
        triggered ||= matches
        reasons.push(`Next active-branch user turn ${ordinal}: ${matches ? 'periodic trigger matches' : 'periodic trigger does not match'}.`)
      } else dynamic.push('User turn ordinal is unavailable; periodic trigger cannot be predicted.')
    } else if (trigger.type === 'state_changed' || trigger.type === 'message_received') {
      dynamic.push('This event is evaluated from authorized changes/messages during an explicit run; the preview does not invent events.')
    }
    if (trigger.cooldownTurns) dynamic.push('Committed cooldown markers are checked at run start; this static preview does not override them.')
  }

  const permissions = previewPermissions(agent, config)
  const incomingHandoffs = config.agents.flatMap(sender => (sender.communication.handoffs ?? [])
    .filter(handoff => handoff.to === agent.id && handoff.mode !== 'notify' && handoff.responseSchema)
    .map(handoff => ({ from: sender.id, id: handoff.id })))
  if (incomingHandoffs.length && !agent.outputAuthority.internal) {
    issues.push({
      code: 'typed-handoff-result-unavailable', severity: 'error', handoffs: incomingHandoffs,
      message: 'A responseSchema requires this agent to submit typed {summary,data} with rp_team_submit_internal, but internal-output authority is disabled.'
    })
  }
  const tools = staticTools(agent)
  if (agent.capabilities.length === 0) dynamic.push('Default tool groups depend on the host and product settings; no executable tool scopes were inspected.')
  else if (agent.capabilities.some(capability => capability.enabled)) dynamic.push('Configured tool availability and trust are checked again by the host at activation time.')
  if (agent.presetId) dynamic.push(`Native preset functions from “${agent.presetId}” require an activation-time scope and were not inspected.`)
  if (agent.modelRef !== 'inherit') dynamic.push(`Model availability for ${agent.modelRef.provider}/${agent.modelRef.model} was not checked.`)
  if (snapshot.busy === true) dynamic.push('Conversation is busy; the source snapshot or initial values may change before a run starts.')

  return {
    id: agent.id,
    name: agent.name,
    triggered,
    reasons,
    context: projection.sources,
    missingSelections,
    permissions,
    tools,
    dependencies: [...agent.execution.after],
    dynamic: [...new Set(dynamic)],
    issues
  }
}

function projectAgentState(agent, definitions, state) {
  const namespaces = {}
  const values = new Map((state?.values ?? []).map(item => [JSON.stringify([item.namespace, item.path]), item]))
  for (const definition of definitions) {
    const key = JSON.stringify([definition.namespace, definition.path])
    const value = values.get(key)
    // getState values are the committed snapshot; stagedValue is deliberately
    // ignored. If the path is missing, the draft definition's default is what
    // a run opened with that draft config would initialize, without writing it.
    const hasCommittedValue = value && !value.missing && Object.hasOwn(value, 'value')
    const sourceValue = hasCommittedValue ? value.value
      : Object.hasOwn(definition, 'default') ? definition.default
        : undefined
    if (sourceValue === undefined) continue
    const projected = projectStateValueForAgent(agent, definition.namespace, definition.path, sourceValue)
    if (projected === undefined) continue
    namespaces[definition.namespace] = setPointerValue(namespaces[definition.namespace] ?? {}, definition.path, projected)
  }
  return namespaces
}

function previewPermissions(agent, config) {
  const canSend = recipient => recipient.id !== agent.id
    && allows(agent.communication.sendTo, recipient.id)
    && allows(recipient.communication.receiveFrom, agent.id)
  const canRequest = recipient => allows(agent.communication.requestTo, recipient.id)
    && allows(recipient.communication.requestFrom, agent.id)
    && recipient.triggers.some(trigger => trigger.type === 'requested_by_agent'
      && (!trigger.from.length || allows(trigger.from, agent.id)))
  const stateTools = describeStateToolAccess(agent, config.state.definitions).map(item => ({
    ...item,
    write: agent.outputAuthority.state && item.write
  }))
  return {
    authority: structuredClone(agent.outputAuthority),
    stateRules: structuredClone(agent.statePermissions),
    stateTools,
    communication: {
      sendTo: config.agents.filter(canSend).map(item => item.id),
      requestTo: config.agents.filter(canRequest).map(item => item.id),
      receiveFrom: [...agent.communication.receiveFrom],
      requestFrom: [...agent.communication.requestFrom]
    },
    handoffs: structuredClone(agent.communication.handoffs ?? [])
  }
}

function staticTools(agent) {
  const entries = [{ id: 'rp-team', label: 'RP Team', configured: true, enabled: true, requiresTrust: false, trustGranted: true, runtimeAvailability: 'static' }]
  if (!agent.capabilities.length) {
    entries.push({ id: 'host-defaults', label: 'Host default tool groups', configured: false, enabled: null, requiresTrust: null, trustGranted: null, runtimeAvailability: 'dynamic' })
  }
  for (const capability of agent.capabilities) {
    const requiresTrust = TRUSTED_CAPABILITIES.has(capability.id) || capability.id.startsWith('extension:') || capability.id.startsWith('mcp:')
    entries.push({
      id: capability.id,
      label: capabilityLabel(capability.id),
      configured: true,
      enabled: capability.enabled,
      managed: MANAGED_CAPABILITIES.has(capability.id),
      requiresTrust,
      trustGranted: !requiresTrust || agent.execution.trustedTools.includes(capability.id),
      runtimeAvailability: 'dynamic'
    })
  }
  for (const id of agent.execution.trustedTools) {
    if (entries.some(item => item.id === id)) continue
    entries.push({ id, label: capabilityLabel(id), configured: true, enabled: false, managed: false, requiresTrust: true, trustGranted: true, runtimeAvailability: 'dynamic', trustOnly: true })
  }
  return entries
}

function catalogFields(type, value) {
  if (type === 'agent_messages') return [
    { path: '/type', label: 'Message type', type: 'string' },
    { path: '/summary', label: 'Summary', type: 'string' },
    { path: '/body', label: 'Legacy body / summary', type: 'string' },
    { path: '/data', label: 'Structured data', type: 'json' },
    { path: '/from', label: 'Sender', type: 'string' },
    { path: '/to', label: 'Recipient', type: 'string' },
    { path: '/handoffId', label: 'Handoff ID', type: 'string' },
    { path: '/requestId', label: 'Request ID', type: 'string' },
    { path: '/mode', label: 'Handoff mode', type: 'string' },
    { path: '/status', label: 'Handoff result status', type: 'string' }
  ]
  if (type === 'drafts') return [
    { path: '/draftId', label: 'Draft ID', type: 'string' },
    { path: '/text', label: 'Text', type: 'string' },
    { path: '/agentId', label: 'Owner agent', type: 'string' },
    { path: '/visibleTo', label: 'Shared with agent IDs', type: 'array' },
    { path: '/revision', label: 'Revision', type: 'number' }
  ]
  const result = new Map()
  const visit = (current, path, depth) => {
    if (depth > 8 || current === undefined) return
    const item = { path, label: path ? path.split('/').at(-1).replace(/~1/g, '/').replace(/~0/g, '~') : 'Root', type: valueType(current) }
    const previous = result.get(path)
    if (previous && previous.type !== item.type) item.type = 'mixed'
    result.set(path, item)
    if (Array.isArray(current)) {
      if (current.length) visit(current[0], `${path}/0`, depth + 1)
    } else if (isRecord(current)) {
      for (const [key, child] of Object.entries(current)) visit(child, `${path}/${escapePointer(key)}`, depth + 1)
    }
  }
  visit(value, '', 0)
  return [...result.values()]
}

function sourceVersion(snapshot, state) {
  return sha256(stableJson({
    baseHash: snapshot.baseHash ?? null,
    context: snapshot.context ?? {},
    world: snapshot.world ?? {},
    anchor: snapshot.anchor ?? null,
    state: state ? { revision: state.revision ?? null, worldHash: state.worldHash ?? null } : null
  }))
}

async function readAuthorSnapshot(ctx, conversationId) {
  const service = ctx?.eleckoiStoryState
  if (!service || typeof service.authorSnapshot !== 'function') {
    throw teamError('RP_TEAM_AUTHORING_UNAVAILABLE', 'Roleplay author snapshot service is unavailable')
  }
  const snapshot = await service.authorSnapshot({ conversationId })
  if (!snapshot || !isRecord(snapshot.context)) {
    throw teamError('RP_TEAM_AUTHORING_SNAPSHOT_INVALID', 'Roleplay author snapshot is unavailable for this conversation')
  }
  return snapshot
}

function requireConversationId(value) {
  if (typeof value !== 'string' || !value.trim()) throw teamError('RP_TEAM_INVALID_REQUEST', 'conversationId is required')
  return value.trim()
}
function allows(values, id) { return values.includes('*') || values.includes(id) }
function valueType(value) { return value === null ? 'null' : Array.isArray(value) ? 'array' : isRecord(value) ? 'object' : typeof value }
function escapePointer(value) { return String(value).replace(/~/gu, '~0').replace(/\//gu, '~1') }
function sha256(value) { return createHash('sha256').update(value, 'utf8').digest('hex') }
function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (isRecord(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`
  return JSON.stringify(value)
}
function isRecord(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) }
