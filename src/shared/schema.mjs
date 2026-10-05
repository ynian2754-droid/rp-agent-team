import { normalizeValueSchema, validateValueSchema } from './value-schema.mjs'
import { normalizeAuthorParameters } from './author-parameters.mjs'
import { normalizeMemoryConfig } from './memory.mjs'
export { normalizeValueSchema, validateValueSchema } from './value-schema.mjs'

const PARAMETER_NAMES = new Set(['temperature', 'topP', 'maxTokens', 'reasoningEffort'])
const CONTEXT_TYPES = new Set([
  'current_input', 'recent_history', 'full_history', 'character_card', 'worldbook',
  'long_memory', 'scene_state', 'agent_messages', 'drafts', 'hidden_state'
])
const ACCESS = new Set(['none', 'read', 'write', 'readwrite'])
const VALUE_TYPES = new Set(['any', 'string', 'number', 'boolean', 'object', 'array', 'null'])
const FAILURE_POLICIES = new Set(['continue', 'stop'])
const CONDITION_OPERATORS = new Set(['eq', 'ne', 'gt', 'gte', 'lt', 'lte'])
const DEFAULT_LIMITS = Object.freeze({ concurrency: 4, maxActivations: 32, maxPerAgent: 3, maxDepth: 4 })

export function teamError(code, message) {
  return Object.assign(new Error(message), { code })
}

export function createAgent(overrides = {}) {
  const base = {
    id: 'agent',
    name: 'Agent',
    description: '',
    systemPrompt: '',
    modelRef: 'inherit',
    parameters: {},
    presetId: '',
    capabilities: [],
    compaction: {},
    triggers: [{ type: 'always' }],
    context: { sources: [{ type: 'current_input' }, { type: 'recent_history' }] },
    communication: { sendTo: [], receiveFrom: [], requestTo: [], requestFrom: [] },
    statePermissions: [],
    outputAuthority: { internal: true, draft: true, state: false, user: false },
    execution: { after: [], onFailure: 'continue', trustedTools: [] },
    ...overrides
  }
  return {
    ...base,
    context: { sources: base.context?.sources ?? [] },
    communication: { sendTo: [], receiveFrom: [], requestTo: [], requestFrom: [], ...(base.communication ?? {}) },
    outputAuthority: { internal: true, draft: true, state: false, user: false, ...(base.outputAuthority ?? {}) },
    execution: { after: [], onFailure: 'continue', trustedTools: [], ...(base.execution ?? {}) }
  }
}

export function defaultTeamConfig() {
  return normalizeTeamConfig({
    schemaVersion: 2,
    id: 'roleplay-team',
    name: 'Roleplay Team',
    version: '1.0.0',
    metadata: {},
    agents: [
      createAgent({
        id: 'agent-1', name: 'Agent 1', description: 'Notice the details that should guide the next scene.',
        systemPrompt: 'Review the current input and recent history. Identify relevant character, continuity, and scene details. Send a concise context note to Agent 2; do not write the user-facing scene.',
        context: { sources: [{ type: 'current_input' }, { type: 'recent_history' }, { type: 'character_card' }] },
        communication: { sendTo: ['agent-2'], receiveFrom: ['agent-2'], requestTo: ['agent-2'], requestFrom: [] },
        outputAuthority: { internal: true, draft: true, state: true, user: false }
      }),
      createAgent({
        id: 'agent-2', name: 'Agent 2', description: 'Continue the scene using the supplied context.',
        systemPrompt: 'Write a natural roleplay continuation grounded in the current character and scene. Use Agent 1’s context note, preserve the established voice, and return the finished scene for the user.',
        triggers: [{ type: 'always' }],
        context: { sources: [
          { type: 'current_input' }, { type: 'recent_history' }, { type: 'character_card' },
          { type: 'agent_messages', agentIds: ['agent-1'] }
        ] },
        communication: { sendTo: ['agent-1'], receiveFrom: ['agent-1'], requestTo: [], requestFrom: ['agent-1'] },
        execution: { after: ['agent-1'], onFailure: 'continue', trustedTools: [] },
        outputAuthority: { internal: true, draft: true, state: true, user: true }
      })
    ],
    state: { definitions: [] },
    execution: { ...DEFAULT_LIMITS },
    output: { agentId: 'agent-2' }
  })
}

export function examplePresets() {
  const generic = defaultTeamConfig()
  const asymmetric = normalizeTeamConfig({
    schemaVersion: 2,
    id: 'asymmetric-example',
    name: 'Asymmetric Coordination Example',
    version: '1.0.0',
    metadata: { example: true },
    agents: [
      createAgent({
        id: 'agent-1', name: 'World Observer',
        description: 'Read private world truth and turn relevant details into a safe observation for the perception agent.',
        systemPrompt: 'Read declared world truth and form a concise observation for Perception. If a prior memory would help, request Long Memory with rp_team_request; a request only queues work, so do not wait or poll during this activation. Finish this activation so the scheduler can run the requested work before Perception, then send only safe observations. Never send raw hidden state to the scene actor or write the user-facing scene.',
        context: { sources: [{ type: 'current_input' }, { type: 'recent_history' }, { type: 'hidden_state', selector: '/variables/truth' }] },
        communication: { sendTo: ['agent-2', 'agent-3'], receiveFrom: [], requestTo: ['agent-2'], requestFrom: [] },
        statePermissions: [
          { namespace: 'world', path: '/variables/truth', access: 'read' },
          { namespace: 'world', path: '/variables/memory', access: 'read' },
          { namespace: 'shared', path: '/observations/agent-1', access: 'write' }
        ],
        outputAuthority: { internal: true, draft: true, state: true, user: false }
      }),
      createAgent({
        id: 'agent-2', name: 'Long Memory',
        description: 'Retrieve only the prior memories relevant to this scene and share a short excerpt when requested.',
        systemPrompt: 'When requested, select only the few long-term memories that matter to the current scene and preserve their source and uncertainty. Send the concise result to Perception with rp_team_send before returning. You are intentionally skipped when no memory lookup is needed.',
        triggers: [{ type: 'requested_by_agent', from: ['agent-1'] }],
        context: { sources: [{ type: 'long_memory', selector: '/variables/memory' }, { type: 'current_input' }] },
        communication: { sendTo: ['agent-3'], receiveFrom: ['agent-1'], requestTo: [], requestFrom: ['agent-1'] },
        statePermissions: [
          { namespace: 'world', path: '/variables/memory', access: 'read' },
          { namespace: 'shared', path: '/memory-context/agent-2', access: 'write' }
        ],
        outputAuthority: { internal: true, draft: true, state: true, user: false }
      }),
      createAgent({
        id: 'agent-3', name: 'Perception',
        description: 'Transform world observations and optional memories into a character’s subjective view.',
        systemPrompt: 'You do not have direct access to private world truth. Wait for the Observer and any requested Long Memory activation to settle, then transform their messages into what the character might notice, believe, or misunderstand. If memory was not requested or its activation failed, continue from the available observation without inventing a memory result. Keep beliefs separate from facts.',
        triggers: [{ type: 'always' }],
        execution: { after: ['agent-1', 'agent-2'], onFailure: 'continue', trustedTools: [] },
        context: { sources: [{ type: 'current_input' }, { type: 'recent_history' }, { type: 'character_card' }, { type: 'agent_messages', agentIds: ['agent-1', 'agent-2'] }] },
        communication: { sendTo: ['agent-4'], receiveFrom: ['agent-1', 'agent-2'], requestTo: [], requestFrom: [] },
        statePermissions: [
          { namespace: 'shared', path: '/observations/agent-1', access: 'read' },
          { namespace: 'shared', path: '/memory-context/agent-2', access: 'read' },
          { namespace: 'shared', path: '/perceptions/agent-3', access: 'readwrite' }
        ],
        outputAuthority: { internal: true, draft: false, state: true, user: false }
      }),
      createAgent({
        id: 'agent-4', name: 'Scene Actor',
        description: 'Write the user-facing scene using character perceptions and relevant memories.',
        systemPrompt: 'Write the finished roleplay scene from the character’s available perspective. Use observations as clues and memories as recollections; either may be incomplete or mistaken. You have no access to hidden world truth. Preserve the established character voice.',
        triggers: [{ type: 'always' }],
        execution: { after: ['agent-3'], onFailure: 'continue', trustedTools: [] },
        context: { sources: [{ type: 'current_input' }, { type: 'recent_history' }, { type: 'character_card' }, { type: 'agent_messages', agentIds: ['agent-2', 'agent-3'] }] },
        communication: { sendTo: [], receiveFrom: ['agent-2', 'agent-3'], requestTo: [], requestFrom: [] },
        statePermissions: [
          { namespace: 'shared', path: '/perceptions/agent-3', access: 'read' },
          { namespace: 'shared', path: '/memory-context/agent-2', access: 'read' }
        ],
        outputAuthority: { internal: true, draft: true, state: false, user: true }
      })
    ],
    state: { definitions: [
      { namespace: 'world', path: '/variables/truth', type: 'object', default: { visitor: 'Mara', purpose: 'She left a warning.' } },
      { namespace: 'world', path: '/variables/memory', type: 'array', default: [] },
      { namespace: 'shared', path: '/observations/agent-1', type: 'object', default: {} },
      { namespace: 'shared', path: '/memory-context/agent-2', type: 'array', default: [] },
      { namespace: 'shared', path: '/perceptions/agent-3', type: 'object', default: { belief: 'The visitor may be a courier.' } },
      { namespace: 'shared', path: '/drafts/scene', type: 'string', default: '' }
    ] },
    execution: { ...DEFAULT_LIMITS },
    output: { agentId: 'agent-4' }
  })
  return [generic, asymmetric]
}

export function migrateV1ToV2(value) {
  if (!isRecord(value) || !value.lead || !Array.isArray(value.members)) {
    throw teamError('RP_TEAM_INVALID_CONFIG', 'Legacy team config requires a lead and members array')
  }
  if (value.members.length < 2) throw teamError('RP_TEAM_INVALID_CONFIG', 'Legacy roleplay teams require at least two members')

  const leadId = identifier(value.lead.id, 'legacy lead id')
  const roster = [value.lead, ...value.members]
  const ids = new Set()
  for (const member of roster) {
    const id = identifier(member?.id, 'legacy member id')
    if (ids.has(id)) throw teamError('RP_TEAM_INVALID_CONFIG', `Duplicate legacy member id: ${id}`)
    ids.add(id)
  }
  const teammateIds = value.members.map(member => identifier(member?.id, 'legacy member id'))
  const requiredAgentIds = roster.filter(member => member.required === true).map(member => member.id)
  const agents = roster.map((member, index) => {
    const isLead = index === 0
    const task = textOrEmpty(member.task, 'legacy task')
    const systemPrompt = [textOrEmpty(member.systemPrompt, 'systemPrompt'), task ? `Legacy task: ${task}` : ''].filter(Boolean).join('\n\n')
    const trustedTools = Array.isArray(member.capabilities)
      ? member.capabilities.filter(capability => capability?.enabled === true).map(capability => capability.id)
      : []
    const sources = [
      { type: 'current_input' }, { type: 'recent_history' }, { type: 'character_card' },
      { type: 'worldbook' }, { type: 'scene_state' }, { type: 'hidden_state' }
    ]
    if (member.context === 'fork' || (member.context === undefined && isLead)) sources.push({ type: 'full_history' })
    return createAgent({
      id: identifier(member.id, 'legacy member id'),
      name: text(member.name, 'legacy member name'),
      description: task,
      systemPrompt,
      modelRef: member.modelRef ?? 'inherit',
      parameters: member.parameters ?? {},
      presetId: member.presetId ?? '',
      capabilities: Array.isArray(member.capabilities) ? member.capabilities : [],
      compaction: member.compaction ?? {},
      triggers: [{ type: 'always' }],
      context: { sources },
      communication: isLead
        ? { sendTo: teammateIds, receiveFrom: teammateIds, requestTo: teammateIds, requestFrom: [] }
        : { sendTo: [leadId], receiveFrom: [leadId], requestTo: [], requestFrom: [leadId] },
      statePermissions: [{ namespace: 'world', path: '', access: 'readwrite' }],
      outputAuthority: { internal: true, draft: true, state: true, user: isLead },
      execution: {
        after: isLead ? teammateIds : [],
        onFailure: member.required === true ? 'stop' : 'continue',
        trustedTools
      }
    })
  })

  return normalizeTeamConfig({
    schemaVersion: 2,
    id: 'migrated-roleplay-team',
    name: 'Migrated Roleplay Team',
    version: '1.0.0',
    metadata: { migration: 'rp-team-config-v1', fixedLegacyTopology: true, requiredAgentIds },
    agents,
    state: { definitions: [{ namespace: 'world', path: '', type: 'object' }] },
    execution: { ...DEFAULT_LIMITS },
    output: { agentId: leadId }
  })
}

export function normalizeTeamConfig(value) {
  if (!isRecord(value) || value.schemaVersion !== 2) {
    throw teamError('RP_TEAM_INVALID_CONFIG', 'Team config must use schemaVersion 2')
  }
  rejectUnknown(value, ['schemaVersion', 'id', 'name', 'version', 'metadata', 'agents', 'state', 'execution', 'output', 'authorParameters', 'memory'], 'Team config')
  if (!Array.isArray(value.agents) || value.agents.length === 0) {
    throw teamError('RP_TEAM_INVALID_CONFIG', 'Team config requires at least one agent')
  }
  const agents = value.agents.map(normalizeAgent)
  const agentIds = new Set()
  for (const agent of agents) {
    if (agentIds.has(agent.id)) throw teamError('RP_TEAM_INVALID_CONFIG', `Duplicate agent id: ${agent.id}`)
    agentIds.add(agent.id)
  }

  const state = normalizeState(value.state ?? { definitions: [] })
  for (const definition of state.definitions) {
    if (definition.namespace.startsWith('private:') && !agentIds.has(definition.namespace.slice('private:'.length))) {
      throw teamError('RP_TEAM_INVALID_CONFIG', `State definition references unknown private agent ${definition.namespace.slice('private:'.length)}`)
    }
  }
  for (const agent of agents) validateAgentReferences(agent, agentIds, state.definitions)
  validateExecutionGraph(agents)

  const execution = normalizeLimits(value.execution ?? {})
  const output = normalizeOutput(value.output, agents)
  return {
    schemaVersion: 2,
    id: identifier(value.id, 'team id'),
    name: text(value.name, 'team name'),
    version: text(value.version, 'team version'),
    metadata: cloneJsonRecord(value.metadata ?? {}, 'Team metadata'),
    agents,
    state,
    execution,
    output,
    ...(value.authorParameters === undefined ? {} : { authorParameters: normalizeAuthorParameters(value.authorParameters, agents, state.definitions) }),
    ...(value.memory === undefined ? {} : { memory: normalizeMemoryConfig(value.memory, agents, state.definitions) })
  }
}

function normalizeAgent(value) {
  if (!isRecord(value)) throw teamError('RP_TEAM_INVALID_CONFIG', 'Each agent must be an object')
  rejectUnknown(value, [
    'id', 'name', 'description', 'systemPrompt', 'modelRef', 'parameters', 'presetId', 'capabilities', 'compaction',
    'triggers', 'context', 'communication', 'statePermissions', 'outputAuthority', 'execution'
  ], 'Agent')

  const base = createAgent()
  const candidate = { ...base, ...value, outputAuthority: { ...base.outputAuthority, ...(value.outputAuthority ?? {}) } }
  const modelRef = candidate.modelRef
  if (modelRef !== 'inherit' && (!isRecord(modelRef) || !text(modelRef.provider, 'model provider') || !text(modelRef.model, 'model id'))) {
    throw teamError('RP_TEAM_INVALID_CONFIG', `Agent ${candidate.name ?? candidate.id} has an invalid modelRef`)
  }
  if (modelRef !== 'inherit') rejectUnknown(modelRef, ['provider', 'model'], 'modelRef')

  return {
    id: identifier(candidate.id, 'agent id'),
    name: text(candidate.name, 'agent name'),
    description: textOrEmpty(candidate.description, 'agent description'),
    systemPrompt: textOrEmpty(candidate.systemPrompt, 'systemPrompt'),
    modelRef: modelRef === 'inherit' ? 'inherit' : { provider: text(modelRef.provider, 'model provider'), model: text(modelRef.model, 'model id') },
    parameters: normalizeParameters(candidate.parameters),
    presetId: textOrEmpty(candidate.presetId, 'presetId'),
    capabilities: normalizeCapabilities(candidate.capabilities),
    compaction: normalizeCompaction(candidate.compaction),
    triggers: normalizeTriggers(candidate.triggers),
    context: normalizeContext(candidate.context),
    communication: normalizeCommunication(candidate.communication),
    statePermissions: normalizeStatePermissions(candidate.statePermissions),
    outputAuthority: normalizeAuthority(candidate.outputAuthority),
    execution: normalizeAgentExecution(candidate.execution)
  }
}

function normalizeParameters(value = {}) {
  if (!isRecord(value)) throw teamError('RP_TEAM_INVALID_CONFIG', 'Agent parameters must be an object')
  const unsupported = Object.keys(value).filter(key => !PARAMETER_NAMES.has(key))
  if (unsupported.length) throw teamError('RP_TEAM_INVALID_CONFIG', `Unsupported model parameters: ${unsupported.join(', ')}`)
  const result = {}
  for (const [key, candidate] of Object.entries(value)) {
    if (key === 'temperature' && (!Number.isFinite(candidate) || candidate < 0 || candidate > 2)) {
      throw teamError('RP_TEAM_INVALID_CONFIG', 'temperature must be between 0 and 2')
    }
    if (key === 'topP' && (!Number.isFinite(candidate) || candidate < 0 || candidate > 1)) {
      throw teamError('RP_TEAM_INVALID_CONFIG', 'topP must be between 0 and 1')
    }
    if (key === 'maxTokens' && (!Number.isSafeInteger(candidate) || candidate < 1)) {
      throw teamError('RP_TEAM_INVALID_CONFIG', 'maxTokens must be a positive integer')
    }
    if (key === 'reasoningEffort' && (typeof candidate !== 'string' || !candidate.trim())) {
      throw teamError('RP_TEAM_INVALID_CONFIG', 'reasoningEffort must be non-empty text')
    }
    result[key] = candidate
  }
  return result
}

function normalizeCapabilities(value = []) {
  if (!Array.isArray(value)) throw teamError('RP_TEAM_INVALID_CONFIG', 'capabilities must be an array')
  return value.map(item => {
    if (!isRecord(item) || typeof item.enabled !== 'boolean') throw teamError('RP_TEAM_INVALID_CONFIG', 'Each capability requires an enabled flag')
    rejectUnknown(item, ['id', 'enabled'], 'Capability')
    return { id: text(item.id, 'capability id'), enabled: item.enabled }
  })
}

function normalizeCompaction(value = {}) {
  if (!isRecord(value)) throw teamError('RP_TEAM_INVALID_CONFIG', 'compaction must be an object')
  rejectUnknown(value, ['historyCompactionInstructions', 'autoCompactTokenLimit'], 'Compaction')
  const result = {}
  if (Object.hasOwn(value, 'historyCompactionInstructions')) result.historyCompactionInstructions = textOrEmpty(value.historyCompactionInstructions, 'compaction instructions')
  if (Object.hasOwn(value, 'autoCompactTokenLimit')) {
    if (!Number.isSafeInteger(value.autoCompactTokenLimit) || value.autoCompactTokenLimit < 1) {
      throw teamError('RP_TEAM_INVALID_CONFIG', 'autoCompactTokenLimit must be a positive integer')
    }
    result.autoCompactTokenLimit = value.autoCompactTokenLimit
  }
  return result
}

function normalizeTriggers(value = []) {
  if (!Array.isArray(value)) throw teamError('RP_TEAM_INVALID_CONFIG', 'triggers must be an array')
  const ids = new Set()
  return value.map(trigger => {
    if (!isRecord(trigger)) throw teamError('RP_TEAM_INVALID_CONFIG', 'Each trigger must be an object')
    const extra = {}
    if (trigger.id !== undefined) {
      extra.id = identifier(trigger.id, 'trigger id')
      if (ids.has(extra.id)) throw teamError('RP_TEAM_INVALID_CONFIG', `Duplicate trigger id: ${extra.id}`)
      ids.add(extra.id)
    }
    if (trigger.cooldownTurns !== undefined) {
      if (!Number.isSafeInteger(trigger.cooldownTurns) || trigger.cooldownTurns < 0) throw teamError('RP_TEAM_INVALID_CONFIG', 'cooldownTurns must be a non-negative integer')
      extra.cooldownTurns = trigger.cooldownTurns
    }
    const allowed = ['id', 'cooldownTurns']
    if (trigger.type === 'always' || trigger.type === 'manual') {
      rejectUnknown(trigger, ['type', ...allowed], 'Trigger')
      return { type: trigger.type, ...extra }
    }
    if (trigger.type === 'requested_by_agent') {
      rejectUnknown(trigger, ['type', 'from', ...allowed], 'Trigger')
      return { type: trigger.type, from: normalizeAllowlist(trigger.from ?? [], 'trigger.from'), ...extra }
    }
    if (trigger.type === 'condition') {
      rejectUnknown(trigger, ['type', 'condition', ...allowed], 'Trigger')
      return { type: trigger.type, condition: normalizeCondition(trigger.condition), ...extra }
    }
    if (trigger.type === 'periodic') {
      rejectUnknown(trigger, ['type', 'every', 'offset', ...allowed], 'Trigger')
      if (!Number.isSafeInteger(trigger.every) || trigger.every < 1 || !Number.isSafeInteger(trigger.offset ?? 0) || (trigger.offset ?? 0) < 0) throw teamError('RP_TEAM_INVALID_CONFIG', 'Periodic trigger requires a positive interval and non-negative offset')
      return { type: trigger.type, every: trigger.every, offset: trigger.offset ?? 0, ...extra }
    }
    if (trigger.type === 'state_changed') {
      rejectUnknown(trigger, ['type', 'namespace', 'path', ...allowed], 'Trigger')
      return { type: trigger.type, namespace: normalizeNamespace(trigger.namespace), path: jsonPointer(trigger.path), ...extra }
    }
    if (trigger.type === 'message_received') {
      rejectUnknown(trigger, ['type', 'from', 'messageTypes', 'topic', ...allowed], 'Trigger')
      const messageTypes = uniqueStrings(trigger.messageTypes ?? ['message'], 'messageTypes')
      if (!messageTypes.length || messageTypes.some(type => !['message', 'request', 'handoff_result'].includes(type))) throw teamError('RP_TEAM_INVALID_CONFIG', 'Unsupported message trigger category')
      return { type: trigger.type, from: normalizeAllowlist(trigger.from ?? [], 'trigger.from'), messageTypes, ...(trigger.topic === undefined ? {} : { topic: text(trigger.topic, 'message topic') }), ...extra }
    }
    if (trigger.type === 'keyword') {
      rejectUnknown(trigger, ['type', 'keywords', 'match', 'caseSensitive', ...allowed], 'Trigger')
      const keywords = uniqueStrings(trigger.keywords, 'keywords'), match = trigger.match ?? 'any'
      if (!keywords.length || !['any', 'all'].includes(match) || (trigger.caseSensitive !== undefined && typeof trigger.caseSensitive !== 'boolean')) throw teamError('RP_TEAM_INVALID_CONFIG', 'Invalid keyword trigger')
      return { type: trigger.type, keywords, match, caseSensitive: trigger.caseSensitive ?? false, ...extra }
    }
    throw teamError('RP_TEAM_INVALID_CONFIG', `Unsupported trigger type: ${String(trigger.type)}`)
  })
}

function normalizeCondition(value) {
  if (!isRecord(value)) throw teamError('RP_TEAM_INVALID_CONFIG', 'Condition must be an object')
  if (value.op === 'exists') {
    rejectUnknown(value, ['op', 'namespace', 'path'], 'exists condition')
    return { op: 'exists', namespace: normalizeNamespace(value.namespace), path: jsonPointer(value.path) }
  }
  if (value.op === 'compare') {
    rejectUnknown(value, ['op', 'namespace', 'path', 'operator', 'value'], 'compare condition')
    if (!CONDITION_OPERATORS.has(value.operator)) throw teamError('RP_TEAM_INVALID_CONFIG', `Unsupported comparison operator: ${String(value.operator)}`)
    return {
      op: 'compare', namespace: normalizeNamespace(value.namespace), path: jsonPointer(value.path),
      operator: value.operator, value: cloneJson(value.value, 'condition value')
    }
  }
  if (value.op === 'all' || value.op === 'any') {
    rejectUnknown(value, ['op', 'conditions'], `${value.op} condition`)
    if (!Array.isArray(value.conditions) || value.conditions.length === 0) throw teamError('RP_TEAM_INVALID_CONFIG', `${value.op} requires conditions`)
    return { op: value.op, conditions: value.conditions.map(normalizeCondition) }
  }
  if (value.op === 'not') {
    rejectUnknown(value, ['op', 'condition'], 'not condition')
    return { op: 'not', condition: normalizeCondition(value.condition) }
  }
  throw teamError('RP_TEAM_INVALID_CONFIG', `Unsupported condition operation: ${String(value.op)}`)
}

function normalizeContext(value = {}) {
  if (!isRecord(value)) throw teamError('RP_TEAM_INVALID_CONFIG', 'context must be an object')
  rejectUnknown(value, ['sources'], 'Context')
  if (!Array.isArray(value.sources)) throw teamError('RP_TEAM_INVALID_CONFIG', 'context.sources must be an array')
  const sources = value.sources.map(source => {
    if (!isRecord(source) || !CONTEXT_TYPES.has(source.type)) throw teamError('RP_TEAM_INVALID_CONFIG', `Unsupported context source: ${String(source?.type)}`)
    rejectUnknown(source, ['type', 'selector', 'limit', 'agentIds'], 'Context source')
    const result = { type: source.type }
    if (source.selector !== undefined) result.selector = jsonPointer(source.selector)
    if (source.limit !== undefined) {
      if (!Number.isSafeInteger(source.limit) || source.limit < 1) throw teamError('RP_TEAM_INVALID_CONFIG', 'Context source limit must be a positive integer')
      result.limit = source.limit
    }
    if (source.type === 'recent_history' && result.limit === undefined) result.limit = 12
    if (source.agentIds !== undefined) result.agentIds = normalizeAllowlist(source.agentIds, 'context agentIds', false)
    return result
  })
  return { sources }
}

function normalizeCommunication(value = {}) {
  if (!isRecord(value)) throw teamError('RP_TEAM_INVALID_CONFIG', 'communication must be an object')
  rejectUnknown(value, ['sendTo', 'receiveFrom', 'requestTo', 'requestFrom', 'handoffs'], 'Communication')
  return {
    sendTo: normalizeAllowlist(value.sendTo ?? [], 'communication.sendTo'),
    receiveFrom: normalizeAllowlist(value.receiveFrom ?? [], 'communication.receiveFrom'),
    requestTo: normalizeAllowlist(value.requestTo ?? [], 'communication.requestTo'),
    requestFrom: normalizeAllowlist(value.requestFrom ?? [], 'communication.requestFrom'),
    ...(value.handoffs === undefined ? {} : { handoffs: normalizeHandoffs(value.handoffs) })
  }
}

function normalizeHandoffs(value) {
  if (!Array.isArray(value)) throw teamError('RP_TEAM_INVALID_CONFIG', 'communication.handoffs must be a list')
  const ids = new Set()
  return value.map(item => {
    if (!isRecord(item)) throw teamError('RP_TEAM_INVALID_CONFIG', 'Each handoff must be an object')
    rejectUnknown(item, ['id', 'to', 'mode', 'requestSchema', 'responseSchema', 'requestSelectors', 'responseSelectors', 'timeoutMs', 'onFailure'], 'Handoff')
    const id = identifier(item.id, 'handoff id')
    if (ids.has(id)) throw teamError('RP_TEAM_INVALID_CONFIG', `Duplicate handoff id: ${id}`)
    ids.add(id)
    if (!['notify', 'await', 'resume'].includes(item.mode)) throw teamError('RP_TEAM_INVALID_CONFIG', `Unsupported handoff mode: ${String(item.mode)}`)
    const timeoutMs = item.timeoutMs ?? 300000, onFailure = item.onFailure ?? 'return_error'
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw teamError('RP_TEAM_INVALID_CONFIG', 'Handoff timeoutMs must be a positive integer')
    if (!['return_error', 'stop'].includes(onFailure)) throw teamError('RP_TEAM_INVALID_CONFIG', 'Handoff onFailure must be return_error or stop')
    const result = { id, to: identifier(item.to, 'handoff target'), mode: item.mode, timeoutMs, onFailure }
    for (const direction of ['request', 'response']) {
      if (item[`${direction}Schema`] !== undefined) result[`${direction}Schema`] = normalizeValueSchema(item[`${direction}Schema`], `handoff ${direction} requirements`)
      const selectors = item[`${direction}Selectors`]
      if (selectors !== undefined) {
        if (!Array.isArray(selectors)) throw teamError('RP_TEAM_INVALID_CONFIG', `Handoff ${direction}Selectors must be a list`)
        result[`${direction}Selectors`] = [...new Set(selectors.map(jsonPointer))]
      }
    }
    return result
  })
}

function normalizeStatePermissions(value = []) {
  if (!Array.isArray(value)) throw teamError('RP_TEAM_INVALID_CONFIG', 'statePermissions must be an array')
  const permissions = value.map(permission => {
    if (!isRecord(permission)) throw teamError('RP_TEAM_INVALID_CONFIG', 'Each state permission must be an object')
    rejectUnknown(permission, ['namespace', 'path', 'access'], 'State permission')
    if (!ACCESS.has(permission.access)) throw teamError('RP_TEAM_INVALID_CONFIG', 'State permission access must be none, read, write, or readwrite')
    return { namespace: normalizeNamespace(permission.namespace), path: jsonPointer(permission.path), access: permission.access }
  })
  const paths = new Set()
  for (const permission of permissions) {
    const key = JSON.stringify([permission.namespace, permission.path])
    if (paths.has(key)) throw teamError('RP_TEAM_INVALID_CONFIG', `Duplicate state permission: ${permission.namespace}${permission.path}`)
    paths.add(key)
  }
  return permissions
}

function normalizeAuthority(value = {}) {
  if (!isRecord(value)) throw teamError('RP_TEAM_INVALID_CONFIG', 'outputAuthority must be an object')
  rejectUnknown(value, ['internal', 'draft', 'state', 'user'], 'outputAuthority')
  return Object.fromEntries(['internal', 'draft', 'state', 'user'].map(key => {
    if (typeof value[key] !== 'boolean') throw teamError('RP_TEAM_INVALID_CONFIG', `outputAuthority.${key} must be a boolean`)
    return [key, value[key]]
  }))
}

function normalizeAgentExecution(value = {}) {
  if (!isRecord(value)) throw teamError('RP_TEAM_INVALID_CONFIG', 'Agent execution must be an object')
  rejectUnknown(value, ['after', 'onFailure', 'trustedTools'], 'Agent execution')
  const onFailure = value.onFailure ?? 'continue'
  if (!FAILURE_POLICIES.has(onFailure)) throw teamError('RP_TEAM_INVALID_CONFIG', 'Agent onFailure must be continue or stop')
  return {
    after: normalizeAllowlist(value.after ?? [], 'execution.after', false),
    onFailure,
    trustedTools: uniqueStrings(value.trustedTools ?? [], 'execution.trustedTools')
  }
}

function normalizeState(value) {
  if (!isRecord(value)) throw teamError('RP_TEAM_INVALID_CONFIG', 'state must be an object')
  rejectUnknown(value, ['definitions'], 'State')
  if (!Array.isArray(value.definitions ?? [])) throw teamError('RP_TEAM_INVALID_CONFIG', 'state.definitions must be an array')
  const definitions = (value.definitions ?? []).map(definition => {
    if (!isRecord(definition)) throw teamError('RP_TEAM_INVALID_CONFIG', 'Each state definition must be an object')
    rejectUnknown(definition, ['namespace', 'path', 'type', 'default', 'description', 'valueSchema'], 'State definition')
    if (!VALUE_TYPES.has(definition.type)) throw teamError('RP_TEAM_INVALID_CONFIG', `Unsupported state value type: ${String(definition.type)}`)
    const result = { namespace: normalizeNamespace(definition.namespace), path: jsonPointer(definition.path), type: definition.type }
    if (definition.valueSchema !== undefined) result.valueSchema = normalizeValueSchema(definition.valueSchema, 'state valueSchema')
    if (Object.hasOwn(definition, 'default')) {
      result.default = cloneJson(definition.default, 'state default')
      if (!matchesType(result.default, result.type)) throw teamError('RP_TEAM_INVALID_CONFIG', `State default does not match ${result.type}`)
      const issues = validateValueSchema(result.default, result.valueSchema)
      if (issues.length) throw teamError('RP_TEAM_INVALID_CONFIG', `State default at ${result.namespace}${result.path} ${issues[0].path || ''} ${issues[0].message}`)
    }
    if (definition.description !== undefined) result.description = textOrEmpty(definition.description, 'state description')
    return result
  })
  const keys = new Set()
  for (const definition of definitions) {
    const key = definitionKey(definition)
    if (keys.has(key)) throw teamError('RP_TEAM_INVALID_CONFIG', `Duplicate state definition: ${key}`)
    keys.add(key)
  }
  return { definitions }
}

function normalizeLimits(value) {
  if (!isRecord(value)) throw teamError('RP_TEAM_INVALID_CONFIG', 'execution must be an object')
  rejectUnknown(value, ['concurrency', 'maxActivations', 'maxPerAgent', 'maxDepth', 'budget'], 'Execution limits')
  const limits = { ...DEFAULT_LIMITS, ...value }
  for (const key of Object.keys(DEFAULT_LIMITS)) {
    if (!Number.isSafeInteger(limits[key]) || limits[key] < 1) throw teamError('RP_TEAM_INVALID_CONFIG', `${key} must be a positive integer`)
  }
  if (limits.concurrency > limits.maxActivations || limits.maxPerAgent > limits.maxActivations) {
    throw teamError('RP_TEAM_INVALID_CONFIG', 'Execution concurrency limits cannot exceed maxActivations')
  }
  if (value.budget !== undefined) {
    if (!isRecord(value.budget)) throw teamError('RP_TEAM_INVALID_CONFIG', 'Execution budget must be an object')
    rejectUnknown(value.budget, ['maxRequests', 'maxReportedTokens', 'maxElapsedMs'], 'Execution budget')
    limits.budget = {}
    for (const [key, number] of Object.entries(value.budget)) {
      if (!Number.isSafeInteger(number) || number < 1) throw teamError('RP_TEAM_INVALID_CONFIG', `${key} must be a positive integer`)
      limits.budget[key] = number
    }
  }
  return limits
}

function normalizeOutput(value, agents) {
  if (!isRecord(value)) throw teamError('RP_TEAM_INVALID_CONFIG', 'output must be an object')
  rejectUnknown(value, ['agentId'], 'Output')
  const agentId = identifier(value.agentId, 'output.agentId')
  const agent = agents.find(item => item.id === agentId)
  if (!agent) throw teamError('RP_TEAM_INVALID_CONFIG', `output.agentId references unknown agent ${agentId}`)
  if (!agent.outputAuthority.user) throw teamError('RP_TEAM_INVALID_CONFIG', `Output agent ${agentId} must have user output authority`)
  return { agentId }
}

function validateAgentReferences(agent, agentIds, stateDefinitions) {
  const checkAllowlist = (items, label) => {
    for (const id of items) if (id !== '*' && !agentIds.has(id)) throw teamError('RP_TEAM_INVALID_CONFIG', `${label} references unknown agent ${id}`)
  }
  checkAllowlist(agent.communication.sendTo, `${agent.name} sendTo`)
  checkAllowlist(agent.communication.receiveFrom, `${agent.name} receiveFrom`)
  checkAllowlist(agent.communication.requestTo, `${agent.name} requestTo`)
  checkAllowlist(agent.communication.requestFrom, `${agent.name} requestFrom`)
  for (const handoff of agent.communication.handoffs || []) {
    if (!agentIds.has(handoff.to)) throw teamError('RP_TEAM_INVALID_CONFIG', `Handoff ${handoff.id} references unknown agent ${handoff.to}`)
    if (handoff.to === agent.id && handoff.mode !== 'notify') throw teamError('RP_TEAM_INVALID_CONFIG', `Handoff ${handoff.id} cannot wait for the same agent`)
  }
  checkAllowlist(agent.execution.after, `${agent.name} execution.after`)
  for (const trigger of agent.triggers) {
    if (trigger.type === 'requested_by_agent') checkAllowlist(trigger.from, `${agent.name} trigger.from`)
    if (trigger.type === 'condition') validateConditionReferences(trigger.condition, stateDefinitions, agent)
    if (trigger.type === 'state_changed') validateConditionReferences({ op: 'exists', namespace: trigger.namespace, path: trigger.path }, stateDefinitions, agent)
    if (trigger.type === 'message_received') {
      checkAllowlist(trigger.from, `${agent.name} trigger.from`)
      if (!agent.context.sources.some(source => source.type === 'agent_messages')) throw teamError('RP_TEAM_INVALID_CONFIG', `${agent.name} needs visible agent messages for a message trigger`)
    }
    if (trigger.type === 'keyword' && !agent.context.sources.some(source => source.type === 'current_input' && (source.selector === undefined || source.selector === '' || source.selector === '/text'))) throw teamError('RP_TEAM_INVALID_CONFIG', `${agent.name} needs visible current input text for a keyword trigger`)
  }
  for (const source of agent.context.sources) if (source.agentIds) checkAllowlist(source.agentIds, `${agent.name} context.agentIds`)
  for (const permission of agent.statePermissions) {
    if (permission.namespace.startsWith('private:') && !agentIds.has(permission.namespace.slice('private:'.length))) {
      throw teamError('RP_TEAM_INVALID_CONFIG', `${agent.name} state permission references unknown private agent`)
    }
  }
}

function validateExecutionGraph(agents) {
  const byId = new Map(agents.map(agent => [agent.id, agent]))
  const visiting = new Set()
  const visited = new Set()
  const visit = id => {
    if (visiting.has(id)) throw teamError('RP_TEAM_INVALID_CONFIG', `Agent execution dependencies contain a cycle at ${id}`)
    if (visited.has(id)) return
    visiting.add(id)
    for (const dependency of byId.get(id).execution.after) visit(dependency)
    visiting.delete(id)
    visited.add(id)
  }
  for (const agent of agents) visit(agent.id)
}

function validateConditionReferences(condition, stateDefinitions, agent) {
  if (condition.op === 'all' || condition.op === 'any') {
    condition.conditions.forEach(item => validateConditionReferences(item, stateDefinitions, agent))
  } else if (condition.op === 'not') {
    validateConditionReferences(condition.condition, stateDefinitions, agent)
  } else {
    if (!stateDefinitions.some(definition => definition.namespace === condition.namespace && pointerContains(definition.path, condition.path))) {
      throw teamError('RP_TEAM_INVALID_CONFIG', `Condition references undeclared state path ${condition.namespace}${condition.path}`)
    }
    const permission = agent.statePermissions
      .filter(item => item.namespace === condition.namespace && pointerContains(item.path, condition.path))
      .sort((left, right) => right.path.length - left.path.length)[0]
    if (permission?.access !== 'read' && permission?.access !== 'readwrite') {
      throw teamError('RP_TEAM_INVALID_CONFIG', `Condition references unreadable state path ${condition.namespace}${condition.path}`)
    }
  }
}

export function evaluateCondition(projected, condition) {
  const ast = normalizeCondition(condition)
  return evaluate(projected ?? {}, ast)
}

function evaluate(projected, condition) {
  if (condition.op === 'all') return condition.conditions.every(item => evaluate(projected, item))
  if (condition.op === 'any') return condition.conditions.some(item => evaluate(projected, item))
  if (condition.op === 'not') return !evaluate(projected, condition.condition)
  const found = lookupPointer(projected?.[condition.namespace], condition.path)
  if (condition.op === 'exists') return found.exists
  if (!found.exists) return condition.operator === 'ne'
  switch (condition.operator) {
    case 'eq': return deepEqual(found.value, condition.value)
    case 'ne': return !deepEqual(found.value, condition.value)
    case 'gt': return found.value > condition.value
    case 'gte': return found.value >= condition.value
    case 'lt': return found.value < condition.value
    case 'lte': return found.value <= condition.value
    default: return false
  }
}

export function exportPreset(config) {
  const normalized = normalizeTeamConfig(config)
  const dependencies = {
    ...(normalized.authorParameters?.length || normalized.memory?.collections?.length || normalized.execution.budget || normalized.agents.some(agent => agent.triggers.some(trigger => ['periodic', 'state_changed', 'message_received', 'keyword'].includes(trigger.type) || trigger.cooldownTurns !== undefined || trigger.id !== undefined)) ? { minimumPluginVersion: '0.4.0' } : normalized.state.definitions.some(item => item.valueSchema) || normalized.agents.some(agent => agent.communication.handoffs?.length) ? { minimumPluginVersion: '0.3.0' } : {}),
    presets: [...new Set(normalized.agents.map(agent => agent.presetId).filter(Boolean))].sort(),
    models: [...new Map(normalized.agents
      .filter(agent => agent.modelRef !== 'inherit')
      .map(agent => [`${agent.modelRef.provider}\u0000${agent.modelRef.model}`, agent.modelRef]))]
      .map(([, model]) => ({ ...model }))
      .sort((left, right) => `${left.provider}/${left.model}`.localeCompare(`${right.provider}/${right.model}`)),
    toolGroups: [...new Set(normalized.agents.flatMap(agent => [
      ...agent.capabilities.filter(capability => capability.enabled).map(capability => capability.id),
      ...agent.execution.trustedTools
    ]))].sort()
  }
  return {
    format: 'rp-team-preset-v2',
    dependencies,
    config: { ...normalized, metadata: stripSecrets(normalized.metadata) }
  }
}

export function parsePreset(value) {
  let parsed = value
  if (typeof parsed === 'string') {
    try { parsed = JSON.parse(parsed) } catch (error) { throw teamError('RP_TEAM_PRESET_INVALID', `Preset JSON is invalid: ${error.message}`) }
  }
  if (!isRecord(parsed)) throw teamError('RP_TEAM_PRESET_INVALID', 'Preset must be a JSON object')
  if (parsed.format === 'rp-team-config-v1') return migrateV1ToV2(parsed.config)
  if (parsed.lead && Array.isArray(parsed.members)) return migrateV1ToV2(parsed)
  if (parsed.format === 'rp-team-preset-v2' || parsed.format === 'rp-team-config-v2') return normalizeTeamConfig(parsed.config)
  if (parsed.schemaVersion === 2) return normalizeTeamConfig(parsed)
  throw teamError('RP_TEAM_PRESET_INVALID', 'Unsupported RP Team preset format')
}

function stripSecrets(value) {
  const secretKey = /(?:api[-_]?key|secret|password|credential|authorization|private[-_]?key|access[-_]?token|refresh[-_]?token)/iu
  if (Array.isArray(value)) return value.map(stripSecrets)
  if (!isRecord(value)) return value
  return Object.fromEntries(Object.entries(value).filter(([key]) => !secretKey.test(key)).map(([key, child]) => [key, stripSecrets(child)]))
}

function normalizeAllowlist(value, label, allowStar = true) {
  if (!Array.isArray(value)) throw teamError('RP_TEAM_INVALID_CONFIG', `${label} must be an array`)
  const items = uniqueStrings(value, label)
  if (!allowStar && items.includes('*')) throw teamError('RP_TEAM_INVALID_CONFIG', `${label} cannot contain *`)
  if (items.includes('*') && items.length !== 1) throw teamError('RP_TEAM_INVALID_CONFIG', `${label} must use * alone`)
  return items
}

function uniqueStrings(value, label) {
  if (!Array.isArray(value)) throw teamError('RP_TEAM_INVALID_CONFIG', `${label} must be an array`)
  const result = value.map(item => text(item, label))
  return [...new Set(result)]
}

function normalizeNamespace(value) {
  const namespace = text(value, 'state namespace')
  if (namespace === 'shared' || namespace === 'world') return namespace
  if (namespace.startsWith('private:') && namespace.length > 'private:'.length) return namespace
  throw teamError('RP_TEAM_INVALID_CONFIG', `Unsupported state namespace: ${namespace}`)
}

function jsonPointer(value) {
  if (typeof value !== 'string' || (value !== '' && !value.startsWith('/'))) {
    throw teamError('RP_TEAM_INVALID_CONFIG', 'State path and selector must be JSON Pointers')
  }
  if (value.split('/').slice(1).some(segment => /~(?![01])/u.test(segment))) {
    throw teamError('RP_TEAM_INVALID_CONFIG', `Invalid JSON Pointer: ${value}`)
  }
  return value
}

function lookupPointer(value, pointer) {
  if (pointer === '') return { exists: value !== undefined, value }
  let current = value
  for (const raw of pointer.slice(1).split('/')) {
    const key = raw.replace(/~1/g, '/').replace(/~0/g, '~')
    if (current === null || typeof current !== 'object' || !Object.hasOwn(current, key)) return { exists: false }
    current = current[key]
  }
  return { exists: true, value: current }
}

function pointerContains(parent, child) {
  if (parent === '' || parent === child) return true
  return child.startsWith(`${parent}/`)
}

function definitionKey(definition) { return JSON.stringify([definition.namespace, definition.path]) }
function matchesType(value, type) {
  return type === 'any' || (type === 'null' ? value === null
    : type === 'array' ? Array.isArray(value)
      : type === 'object' ? isRecord(value)
        : typeof value === type)
}

function cloneJsonRecord(value, label) {
  if (!isRecord(value)) throw teamError('RP_TEAM_INVALID_CONFIG', `${label} must be an object`)
  const clone = cloneJson(value, label)
  return clone
}

function cloneJson(value, label) {
  try {
    const serialized = JSON.stringify(value)
    if (serialized === undefined) throw new Error('value is not JSON serializable')
    return JSON.parse(serialized)
  } catch (error) {
    throw teamError('RP_TEAM_INVALID_CONFIG', `${label} must contain JSON values: ${error.message}`)
  }
}

function deepEqual(left, right) {
  return stableJson(left) === stableJson(right)
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (isRecord(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`
  return JSON.stringify(value)
}

function identifier(value, label) {
  const result = text(value, label)
  if (result.length > 128 || /[\u0000-\u001f\u007f]/u.test(result)) throw teamError('RP_TEAM_INVALID_CONFIG', `${label} has an invalid format`)
  return result
}

function text(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw teamError('RP_TEAM_INVALID_CONFIG', `${label} must not be empty`)
  return value.trim()
}

function textOrEmpty(value, label) {
  if (value === undefined || value === null) return ''
  if (typeof value !== 'string') throw teamError('RP_TEAM_INVALID_CONFIG', `${label} must be text`)
  return value
}

function rejectUnknown(value, allowed, label) {
  const unknown = Object.keys(value).filter(key => !allowed.includes(key))
  if (unknown.length) throw teamError('RP_TEAM_INVALID_CONFIG', `${label} has unsupported fields: ${unknown.join(', ')}`)
}

function isRecord(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) }
