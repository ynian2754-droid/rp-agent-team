import { join } from 'node:path'
import { buildAgentContext } from './context-policy.mjs'
import { bridgeSettingFiles, makeSettingBranch, makeVariableBranch, projectConversationContext, setPointerValue } from './context-world-adapter.mjs'
import { fingerprint, readOptionalJson, safeName, writeJsonAtomic } from './run-persistence.mjs'
import { describeStateToolAccess } from './state-store.mjs'

/** Build the host context categories from a captured roleplay snapshot. */
export function projectAvailableSources(context, { currentInput, attachments = [], worldState = {} } = {}) {
  const snapshot = context ?? {}
  const input = {
    text: currentInput ?? String(snapshot.currentUserInput ?? ''),
    attachments: attachments.map((part, index) => ({
      index, type: part.type, name: part.name, mediaType: part.mediaType, id: part.attachment?.id
    }))
  }
  return {
    current_input: input,
    recent_history: Array.isArray(snapshot.history) ? snapshot.history : [],
    full_history: Array.isArray(snapshot.history) ? snapshot.history : [],
    character_card: { id: snapshot.characterId ?? '', name: snapshot.characterName ?? '', persona: snapshot.persona ?? {} },
    worldbook: snapshot.settingLibrary ?? {},
    long_memory: worldState,
    scene_state: worldState.variables?.scene ?? {},
    hidden_state: worldState
  }
}

/** Pure source selection shared by runtime context construction and author preview. */
export function projectAgentContext(agent, availableSources, options = {}) {
  return buildAgentContext(agent, availableSources, options)
}

export function conditionState(run, agent, stateStore) {
  const projected = {}
  for (const trigger of agent.triggers.filter(item => item.type === 'condition')) {
    for (const ref of conditionRefs(trigger.condition)) {
      const { value } = stateStore.read({
        conversationId: run.conversationId, runId: run.runId, agentId: agent.id,
        namespace: ref.namespace, path: ref.path
      })
      projected[ref.namespace] = setPointerValue(projected[ref.namespace] ?? {}, ref.path, value)
    }
  }
  return projected
}

export function canReadNativeNamespace(agent, key) {
  const rootPath = `/${key}`
  if (!hasBroadPermission(agent, rootPath, 'read')) return false
  return !agent.statePermissions.some(rule => rule.namespace === 'world'
    && rule.path !== '' && rule.path !== rootPath && pathWithin(rootPath, rule.path)
    && !['read', 'readwrite'].includes(rule.access))
}

export function canWriteNativeNamespace(agent, key) {
  const rootPath = `/${key}`
  if (!agent.outputAuthority.state || !canReadNativeNamespace(agent, key)
    || !hasBroadPermission(agent, rootPath, 'write')) return false
  return !agent.statePermissions.some(rule => rule.namespace === 'world'
    && rule.path !== '' && rule.path !== rootPath && pathWithin(rootPath, rule.path)
    && !['write', 'readwrite'].includes(rule.access))
}

export function authorizedWorldState(run, agent, stateStore) {
  const projected = {}
  for (const permission of agent.statePermissions) {
    if (permission.namespace !== 'world' || !['read', 'readwrite'].includes(permission.access)) continue
    for (const definition of run.config.state.definitions.filter(item => item.namespace === 'world')) {
      const intersects = pathWithin(permission.path, definition.path) || pathWithin(definition.path, permission.path)
      if (!intersects) continue
      const path = pathWithin(definition.path, permission.path) ? permission.path : definition.path
      const { value } = stateStore.read({ conversationId: run.conversationId, runId: run.runId, agentId: agent.id, namespace: 'world', path })
      projected.world = setPointerValue(projected.world ?? {}, path, value)
    }
  }
  return projected.world ?? {}
}

export function makeSources(run, conversation) {
  const context = run.rawConversationContext ?? conversation
  return projectAvailableSources(context, { currentInput: run.currentInput, attachments: run.attachments })
}

export function createChildContextData({ run, agent, activationNo, stateStore }) {
  const transaction = { conversationId: run.conversationId, runId: run.runId }
  const activationState = stateStore.snapshot(transaction)
  const activationVersions = stateStore.versionsSnapshot(transaction)
  const stateToolAccess = describeStateToolAccess(agent, run.config.state.definitions)
  const worldState = authorizedWorldState(run, agent, stateStore)
  const sources = {
    ...run.sources, hidden_state: worldState, long_memory: worldState,
    scene_state: worldState.variables?.scene ?? {}
  }
  const agentContext = projectAgentContext(agent, sources, { messages: run.communication.allMessages(), drafts: run.drafts })
  const attachmentSources = agent.context.sources.filter(source => source.type === 'current_input')
  const includeAllAttachments = attachmentSources.some(source => source.selector === undefined || source.selector === '')
  const attachmentCount = run.attachments.length
  const allowedAttachmentIndexes = new Set(attachmentSources.flatMap(source => {
    if (source.selector === '/attachments') {
      const limit = source.limit ?? attachmentCount
      return Array.from({ length: Math.min(limit, attachmentCount) }, (_unused, index) => index)
    }
    const match = /^\/attachments\/(\d+)(?:\/.*)?$/u.exec(source.selector ?? '')
    const index = match ? Number(match[1]) : -1
    return index >= 0 && index < attachmentCount ? [index] : []
  }))
  const attachments = run.attachments.flatMap((part, index) => includeAllAttachments || allowedAttachmentIndexes.has(index) ? [structuredClone(part)] : [])
  const agentFileKey = `${safeName(agent.id)}-${fingerprint(agent.id).slice(0, 10)}`
  const contextFile = join(run.dataDir, `context-${agentFileKey}-${activationNo}.json`)
  const projected = projectConversationContext(run.rawConversationContext, agentContext)
  const variableStateFile = join(run.dataDir, `variables-${agentFileKey}-${activationNo}.json`)
  const settingStateFile = join(run.dataDir, `settings-${agentFileKey}-${activationNo}.json`)
  const variableBridge = run.destinationSnapshot.variableBridge
    ?? readOptionalJson(run.destinationSnapshot.variableStateFile, { enabled: false, state: {} })
  const settingBridge = run.destinationSnapshot.settingBridge
    ?? readOptionalJson(run.destinationSnapshot.settingStateFile, { enabled: false, library: {} })
  // Native patch tools replace staged bridge trees, so only whole-subtree
  // grants are safe there; exact path ACLs remain available through Team state tools.
  const variableWritePaths = canWriteNativeNamespace(agent, 'variables') ? [''] : []
  const settingWritePaths = canWriteNativeNamespace(agent, 'settings') ? [''] : []
  writeJsonAtomic(variableStateFile, makeVariableBranch(
    agent, activationState.world?.variables ?? {}, variableBridge, canReadNativeNamespace, projected.history, variableWritePaths
  ))
  writeJsonAtomic(settingStateFile, makeSettingBranch(
    agent, activationState.world?.settings ?? {}, settingBridge, canReadNativeNamespace, projected.history,
    worldState.variables ?? {}, settingWritePaths
  ))
  return { activationState, activationVersions, stateToolAccess, agentContext, attachments, contextFile, projected, variableStateFile, settingStateFile }
}

export function createRootContextFile(run, stateStore) {
  const publisher = run.config.agents.find(agent => agent.id === run.outputAgentId)
  const worldState = authorizedWorldState(run, publisher, stateStore)
  const sources = { ...run.sources, hidden_state: worldState, long_memory: worldState, scene_state: worldState.variables?.scene ?? {} }
  const agentContext = projectAgentContext(publisher, sources, { messages: [], drafts: run.drafts })
  const path = join(run.dataDir, 'root-context.json')
  writeJsonAtomic(path, projectConversationContext(run.rawConversationContext, agentContext))
  return path
}

export function childPolicy(agent, run, activation, pendingChildren) {
  const packet = pendingChildren && [...pendingChildren.values()].find(item => item.agentId === agent.id && item.activationNo === activation)
  const context = packet?.agentContext?.sources ?? {}
  const policy = [
    `You are configured agent “${agent.name}” (id ${agent.id}) for run ${run.runId}, activation ${activation}.`,
    agent.systemPrompt,
    `Use only the context categories explicitly supplied below. Do not infer or request access to omitted parent history, role cards, hidden state, variables, world books, or attachments.`,
    `Agent context categories: ${Object.keys(context).join(', ') || '(none)'}.`,
    teamToolGuidance(agent, run, packet),
    agent.id === run.outputAgentId && agent.outputAuthority.user
      ? 'You are the only user-output agent. Publish exactly one final response with rp_team_publish.'
      : `Only configured output agent ${run.outputAgentId} may publish with rp_team_publish; you are not that agent.`
  ].filter(Boolean)
  return policy.join('\n\n')
}

function teamToolGuidance(agent, run, packet) {
  const lines = [`Team tools for ${agent.id}:`]
  const targets = run.communication.targetsFor(agent.id)
  const stateToolAccess = packet?.stateToolAccess ?? []
  const hasDraftContext = packet?.agentContext?.categories?.includes('drafts') === true
  if (agent.outputAuthority.internal) {
    lines.push('Use rp_team_submit_internal with a non-empty summary (required) and optional structured data for orchestration results.')
    lines.push(targets.sendTo.length
      ? `You may send with rp_team_send only to: ${targets.sendTo.join(', ')}.`
      : 'You have no authorized rp_team_send targets.')
    const outboundHandoffs = Array.isArray(targets.handoffs) ? targets.handoffs : (agent.communication.handoffs ?? [])
    if (outboundHandoffs.length) {
      lines.push(`Configured handoffs: ${outboundHandoffs.map(formatHandoff).join(' ')}`)
      lines.push('Use the exact handoffId for a configured target. A target with declared handoffs cannot be called by omitting handoffId. Use rp_team_send({ to, handoffId, summary, data }) for notify; use rp_team_request({ to, handoffId, summary, data }) for await/resume. Legacy body calls remain available only where no handoff contract applies.')
      lines.push('Handoff modes: notify sends a message and returns immediately without scheduling the target; await blocks this native tool call, then resumes this same Session with the target’s validated terminal {summary,data}; resume queues a later activation after this activation and the target finish. The target’s terminal result is delivered back automatically; do not poll, add an after dependency, or send an extra rp_team_send to return it.')
      lines.push('Handoff selectors project the {summary,data} envelope: omitted selectors pass the whole envelope, an empty selector list passes no fields, and a non-empty list passes only those JSON Pointer fields.')
    } else {
      lines.push(targets.requestTo.length
        ? `You may queue legacy rp_team_request only to: ${targets.requestTo.join(', ')}. A legacy request notifies the target and returns immediately; do not wait or poll for its result in this activation. Finish this activation so the scheduler can run the target; consume its message in a later activation.`
        : 'You have no authorized rp_team_request targets.')
    }
  } else {
    lines.push('Internal messages, activation requests, and internal-result submissions are unavailable to this agent.')
  }

  const incomingHandoffs = Array.isArray(targets.incomingHandoffs) ? targets.incomingHandoffs.filter(item => item.mode !== 'notify') : []
  if (incomingHandoffs.length) {
    lines.push(`Incoming handoffs: ${incomingHandoffs.map(formatIncomingHandoff).join(' ')}`)
    lines.push(agent.outputAuthority.internal
      ? 'For an incoming handoff with a responseSchema, return the validated terminal result through rp_team_submit_internal({ summary, data }); otherwise your terminal assistant text is captured as summary. The requester receives the terminal result automatically; do not send an extra rp_team_send.'
      : 'This agent has no rp_team_submit_internal tool. An incoming handoff with a responseSchema cannot succeed because that contract requires typed {summary,data}; without responseSchema, terminal assistant text is captured as summary and returned automatically. Do not send an extra rp_team_send.')
  }

  if (agent.outputAuthority.draft) {
    lines.push('Save a private draft with rp_team_save_draft({ text: "..." });')
    lines.push(hasDraftContext
      ? 'This activation has a drafts source: you can read your own drafts; peer drafts still require sharing plus the configured source agentIds and receive permission.'
      : 'This activation has no readable drafts source. Saving still works, but configure a drafts context source before expecting a later activation to read draft contents.')
    if (targets.sendTo.length) {
      lines.push(`Share a draft only with an authorized recipient, for example rp_team_save_draft({ text: "...", visibleTo: ["${targets.sendTo[0]}"] });.`)
    }
  }

  const readable = stateToolAccess.filter(item => item.read)
  const versionable = stateToolAccess.filter(item => item.version)
  const writable = agent.outputAuthority.state ? stateToolAccess.filter(item => item.write) : []
  if (readable.length) lines.push(`Read only these declared state paths with rp_team_read_state: ${readable.map(formatStatePath).join(', ')}.`)
  if (versionable.length) {
    lines.push(`CAS versions are available without revealing values for: ${versionable.map(formatStatePath).join(', ')}; use rp_team_state_version before a permitted write.`)
  }
  if (writable.length) {
    lines.push(`Write only these declared paths with rp_team_write_state after reading the current version: ${writable.map(formatStatePath).join(', ')}. Include that expectedVersion and do not mutate product state directly.`)
  } else if (agent.outputAuthority.state) {
    lines.push('You have no state paths that can be safely replaced with rp_team_write_state.')
  }
  return lines.join('\n')
}

function formatStatePath({ namespace, path }) { return JSON.stringify({ namespace, path }) }

function formatHandoff(value) {
  const handoff = value?.handoff ?? value
  return JSON.stringify({
    id: handoff.id, to: handoff.to, mode: handoff.mode,
    requestSchema: handoff.requestSchema, responseSchema: handoff.responseSchema,
    requestSelectors: handoff.requestSelectors, responseSelectors: handoff.responseSelectors,
    timeoutMs: handoff.timeoutMs, onFailure: handoff.onFailure
  })
}

function formatIncomingHandoff(value) {
  const handoff = value?.handoff ?? value
  return JSON.stringify({
    from: value.from, id: handoff.id, mode: handoff.mode,
    requestSchema: handoff.requestSchema, responseSchema: handoff.responseSchema,
    requestSelectors: handoff.requestSelectors, responseSelectors: handoff.responseSelectors,
    timeoutMs: handoff.timeoutMs, onFailure: handoff.onFailure
  })
}

export function childPrompt(agent, run, agentContext, activationNo, pendingChildren) {
  return [{ type: 'text', text: [
    childPolicy(agent, run, activationNo, pendingChildren),
    'Filtered context packet:', JSON.stringify(agentContext.sources, null, 2)
  ].join('\n\n') }]
}

function hasBroadPermission(agent, rootPath, action) {
  return agent.statePermissions.some(rule => {
    const can = action === 'read' ? rule.access === 'read' || rule.access === 'readwrite' : rule.access === 'write' || rule.access === 'readwrite'
    return rule.namespace === 'world' && can && (rule.path === '' || rule.path === rootPath)
  })
}

function pathWithin(parent, child) { return parent === '' || parent === child || child.startsWith(`${parent}/`) }

function conditionRefs(condition) {
  if (!condition) return []
  if (condition.op === 'all' || condition.op === 'any') return condition.conditions.flatMap(conditionRefs)
  if (condition.op === 'not') return conditionRefs(condition.condition)
  return [{ namespace: condition.namespace, path: condition.path }]
}
