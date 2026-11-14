import { buildAgentContext } from './context-policy.mjs'
import { projectDraftLaneMessage, scopedDraftLane, scopedDraftPremiseEvidence, scopedDraftSceneEvidence, scopedReviewEvidence, scopedReviewPrompt } from './lived-history-review.mjs'
import { draftPassageChoices, scopedDraftOutcomes } from './lived-history-publication.mjs'
import { setPointerValue } from './context-world-adapter.mjs'
import { describeStateToolAccess } from './state-store.mjs'
import { describeValueSchema } from '../shared/value-schema.mjs'
import { createLivedHistoryPackSource, primeLivedHistoryPackReaders } from './lived-history-pack.mjs'
import { simulationGroundChoiceIds } from './lived-history-sim-evidence.mjs'
import { createLivedHistoryWorldFacts, focusLivedHistoryWorldContext, focusedWorldPrompt } from './lived-history-world.mjs'

/** Build the host context categories from a captured roleplay snapshot. */
export function projectAvailableSources(context, { currentInput, attachments = [], worldState = {} } = {}) {
  const snapshot = context ?? {}
  const input = {
    text: currentInput ?? String(snapshot.currentUserInput ?? ''),
    attachments: attachments.map((part, index) => ({
      index, type: part.type, name: part.name ?? part.attachment?.name, mediaType: part.mediaType ?? part.attachment?.mediaType, id: part.attachment?.attachmentId ?? part.attachment?.id
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

/** A metadata field selection must not implicitly grant the entire file. */
export function selectedAgentAttachments(agent, attachments = []) {
  const indexes = new Set()
  for (const selection of agent.context.sources.filter(source => source.type === 'current_input')) {
    if (selection.selector === undefined || selection.selector === '' || selection.selector === '/attachments') {
      for (let index = 0; index < Math.min(selection.limit ?? attachments.length, attachments.length); index++) indexes.add(index)
    } else {
      const match = /^\/attachments\/(\d+)$/u.exec(selection.selector)
      if (match && Number(match[1]) < attachments.length) indexes.add(Number(match[1]))
    }
  }
  return attachments.filter((_part, index) => indexes.has(index))
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

export function createChildContextData({ run, agent, stateStore, activation }) {
  const transaction = { conversationId: run.conversationId, runId: run.runId }
  const activationState = stateStore.snapshot(transaction)
  const activationVersions = stateStore.versionsSnapshot(transaction)
  const stateToolAccess = describeStateToolAccess(agent, run.config.state.definitions)
  const requestId = activation?.requestId
  const request = requestId && !activation.resumeFromRequestId && run.communication.getRequest?.(requestId)
  if (request?.to === agent.id && request.scopedReview) {
    const messages = run.communication.allMessages().filter(message =>
      message.type === 'request' && message.requestId === requestId && message.to === agent.id)
    const reviewer = { ...agent, context: { sources: agent.context.sources.filter(source => source.type === 'agent_messages') } }
    const agentContext = projectAgentContext(reviewer, {}, { messages })
    const currentMessage = Array.isArray(agentContext.sources.agent_messages)
      ? agentContext.sources.agent_messages.find(message => message?.requestId === requestId)
      : undefined
    const draftLane = scopedDraftLane(request, agent)
    if (currentMessage && draftLane) agentContext.sources.agent_messages = [projectDraftLaneMessage(currentMessage, draftLane)]
    const evidence = draftLane === 'fact' ? [] : scopedReviewEvidence(request.compactReview, currentMessage, { run, agent, stateStore })
    if (evidence.length) {
      agentContext.sources.review_evidence = evidence
      agentContext.categories.push('review_evidence')
    }
    if (currentMessage && (draftLane || agent.execution?.livedHistoryDialoguePremises)) {
      const cues = scopedDraftSceneEvidence(request, run)
      if (cues.length) {
        agentContext.sources.review_scene_cues = cues
        agentContext.categories.push('review_scene_cues')
      }
    }
    if (currentMessage && request.compactReview === 'draft' && draftLane !== 'presentation' && agent.execution?.livedHistoryIndependentPremises) {
      agentContext.sources.review_independent_facts = scopedDraftPremiseEvidence(currentMessage, { run, agent, stateStore })
      agentContext.categories.push('review_independent_facts')
    }
    let draftPassages
    if (currentMessage && request.compactReview === 'draft' && !draftLane && request.writerPresentation === undefined && agent.execution?.livedHistoryReviewPresentation) {
      const outcomes = scopedDraftOutcomes(run, agent, stateStore, request)
      const draft = currentMessage.data?.draft
      if (agent.execution.livedHistoryPassageChoices && agent.execution.livedHistoryDirectDraftReview && typeof draft === 'string') {
        draftPassages = draftPassageChoices(draft, outcomes)
        const { draft: _draft, ...data } = currentMessage.data
        agentContext.sources.agent_messages = [{ ...currentMessage, data }]
        agentContext.sources.review_passages = draftPassages.choices.map(({ id, text }) => [id, text])
        agentContext.categories.push('review_passages')
      }
      agentContext.sources.review_outcomes = draftPassages?.outcomes ?? outcomes
      agentContext.categories.push('review_outcomes')
    }
    return { activationState, activationVersions, stateToolAccess: [], agentContext, attachments: [], scopedReview: request.compactReview,
      draftLane, draftPassages, writerPresentationReview: request.writerPresentation !== undefined }
  }
  const worldState = authorizedWorldState(run, agent, stateStore)
  const sources = {
    ...run.sources, hidden_state: worldState, long_memory: worldState,
    scene_state: worldState.variables?.scene ?? {}
  }
  let messages = run.communication.allMessages()
  if (request?.simulation && agent.execution?.livedHistoryGroundChoices && simulationGroundChoiceIds(request.request.data).length) {
    messages = messages.filter(message => message.type === 'request' && message.requestId === requestId && message.to === agent.id)
      .map(message => {
        const people = Object.fromEntries(Object.entries(message.data.people).map(([who, { ground_refs, ...material }]) => [who, material]))
        return { ...message, data: { ...message.data, people } }
      })
  }
  const agentContext = projectAgentContext(agent, sources, { messages, drafts: run.drafts })
  primeLivedHistoryPackReaders({ run, agent, stateStore, versions: activationVersions })
  const worldFacts = createLivedHistoryWorldFacts({ run, agent, stateStore })
  if (worldFacts) {
    agentContext.sources.world_facts = worldFacts
    agentContext.categories.push('world_facts')
  }
  const focusedWorld = agent.execution?.livedHistoryFocusedWorld === true && request?.to === agent.id &&
    request.handoffId === 'ask-world' && request.request?.data?.mode === '裁定'
  if (focusedWorld) focusLivedHistoryWorldContext(agentContext, requestId)
  const packSource = createLivedHistoryPackSource({ run, agent, stateStore, activation, versions: activationVersions })
  if (packSource) agentContext.sources.material_selection = packSource.selection
  const chronicle = agent.execution?.livedHistoryPhase === 'chronicleProvenance'
  const opening = chronicle && run.currentInput?.startsWith('【开卷】')
  const chronicleSources = chronicle ? scopeChronicleHistory(agentContext, opening) : undefined
  const attachments = chronicle && !opening ? [] : structuredClone(selectedAgentAttachments(agent, run.attachments))
  return {
    activationState, activationVersions, stateToolAccess, agentContext, attachments,
    ...(packSource ? { packSource } : {}), ...(chronicle ? { chronicleSources } : {}), ...(focusedWorld ? { focusedWorld } : {})
  }
}

function scopeChronicleHistory(agentContext, opening) {
  const { sources } = agentContext
  const history = Array.isArray(sources.recent_history) ? sources.recent_history : []
  const published = opening ? [] : history
    .filter(message => message?.role === 'assistant' && typeof message.content === 'string' && message.content.trim())
    .map((message, index) => ({ id: `published-${index + 1}`, text: message.content }))
  const omitted = new Set(['recent_history', 'full_history', ...(!opening ? ['current_input'] : [])])
  for (const category of omitted) delete sources[category]
  agentContext.categories = agentContext.categories.filter(category => !omitted.has(category))
  if (!opening) {
    sources.chronicle_sources = published
    agentContext.categories.push('chronicle_sources')
  }
  return published
}

export function childPolicy(agent, run, activation, pendingChildren) {
  const packet = pendingChildren && [...pendingChildren.values()].find(item => item.agentId === agent.id && item.activationNo === activation)
  const context = packet?.agentContext?.sources ?? {}
  const policy = [
    `You are configured agent “${agent.name}” (id ${agent.id}) for run ${run.runId}, activation ${activation}.`,
    packet?.scopedReview ? scopedReviewPrompt(agent.systemPrompt, packet.scopedReview, { directDraftReview: agent.execution?.livedHistoryDirectDraftReview === true,
      passageChoices: Boolean(packet.draftPassages), independentPremises: agent.execution?.livedHistoryIndependentPremises === true,
      draftLane: packet.draftLane })
      : agent.execution?.livedHistoryFocusedWorld ? focusedWorldPrompt(agent.systemPrompt, packet?.focusedWorld) : agent.systemPrompt,
    packet?.focusedWorld
      ? 'Use the current adjudication packet first. When a missing fact can change this beat, read only the necessary excerpt from an authorized source with rp_team_read_context or rp_team_search_context. Do not infer access to anything else.'
      : 'Use only the context categories explicitly supplied below. Do not infer or request access to omitted parent history, role cards, hidden state, variables, world books, or attachments.',
    `Agent context categories: ${Object.keys(context).join(', ') || '(none)'}.`,
    teamToolGuidance(agent, run, packet),
    agent.id === run.outputAgentId && agent.outputAuthority.user
      ? 'You are the only user-output agent. Publish exactly one final response with rp_team_publish.'
      : `Only configured output agent ${run.outputAgentId} may publish with rp_team_publish; you are not that agent.`
  ].filter(Boolean)
  return policy.join('\n\n')
}

function teamToolGuidance(agent, run, packet) {
  if (packet?.scopedReview === 'draft' && agent.execution?.livedHistoryDirectDraftReview) {
    const fields = agent.execution.livedHistoryReviewPresentation && !packet.writerPresentationReview ? 'pass, issues, presentation' : 'pass, issues'
    return `Use only the current draft, adjudication and supplied evidence. Submit one verdict using rp_team_submit_internal({ ${fields} }). The host ends the activation on an accepted verdict.`
  }
  if (packet?.scopedReview) return 'The host prepared the complete material for this review. Use only the current request and its attached evidence. Submit one verdict using rp_team_submit_internal({ summary, data: { pass, issues } }). The host ends the activation on an accepted verdict.'
  if (packet?.focusedWorld) return 'Start with rp_team_world_start and finish with rp_team_world_submit. They validate against the authorized state definitions. Ask-file returns its ref; use {"$ref":"ask-file#1","pointer":"/groups"} (your actual ref) to forward its groups. Additional source tools read only the configured character_card, worldbook or recent_history projections. Use existing state and memory tools only for a concrete missing fact or current version.'
  if (packet?.simulation) return 'Submit the complete simulation once with rp_team_submit_internal({ summary, data: { beats, stateOps } }). The host checks and stages stateOps and supplies each beat’s wrote field. Use only the assigned material packet. There are no direct state or collaboration tools in this activation.'
  if (packet?.chronicleSource) return 'Use the prepared chronicle_material and submit once using rp_team_submit_internal({ summary, data: { state, events } }). The host validates and stages the batch. The accepted submission ends the activation.'
  if (agent.execution?.livedHistorySingleGroup && packet?.packSource?.present.length === 1) {
    return 'The host prepared material_selection for the sole actor. Select evidence and immediately call rp_team_clerk_single_group once. The host handles simulation, retries, configured review and the final handoff.'
  }
  const lines = [`Team tools for ${agent.id}:`]
  lines.push('Use rp_team_read_context({ source, path }) or rp_team_search_context({ source, query }) to inspect only your configured context. Read authorized file contents with rp_team_read_attachment({ index, offset }). Paths are relative to the filtered packet. ElecKoi native product tools and update_roleplay_plan are unavailable; do not use them. Write variables/settings through declared world state paths with rp_team_write_state, never host tools.')
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
      if (new Set(outboundHandoffs.filter(rule => rule.mode === 'await' && rule.parallel).map(rule => rule.to)).size > 1) {
        lines.push('Use rp_team_request_many({ requests: [{ to, handoffId, summary, data }, ...] }) for independent await handoffs marked parallel:true to distinct agents. Start them in one call when their inputs are ready. Its results follow the input order and each has a handoffId, status and a successful {summary,data} result or {error: {code,message}}. Keep a handoff that needs another result in a later call.')
      }
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
      ? 'For an incoming handoff with a responseSchema, return the terminal result through rp_team_submit_internal({ summary, data }). A submission that breaks the responseSchema is rejected with every problem listed; fix them all and submit again. Without a responseSchema, your terminal assistant text is captured as summary. The requester receives the terminal result automatically; do not send an extra rp_team_send.'
      : 'This agent has no rp_team_submit_internal tool. An incoming handoff with a responseSchema cannot succeed because that contract requires typed {summary,data}; without responseSchema, terminal assistant text is captured as summary and returned automatically. Do not send an extra rp_team_send.')
    if (agent.outputAuthority.internal && incomingHandoffs.some(item => item.terminal)) {
      lines.push('For a handoff marked terminal:true, finish all other tools before calling rp_team_submit_internal. The first accepted result ends this activation immediately.')
    }
  }

  // Only requests a member sent can be referenced, so a member without outbound handoffs gets no reference guidance.
  const outbound = Array.isArray(targets.handoffs) ? targets.handoffs : []
  const referenceHandoffs = [...outbound, ...incomingHandoffs].filter(item => item.references)
  if (agent.outputAuthority.internal && outbound.length && referenceHandoffs.length) {
    lines.push(`Handoff references (${[...new Set(referenceHandoffs.map(item => item.id))].join(', ')}): every handoff result you receive carries a ref such as "ask-file#1" (your 1st ask-file request this run). In data for a handoff marked references:true you may write {"$ref": "ask-file#1"} instead of copying that result's data; add "pointer": "/groups" to take one part of it, or "side": "request" to forward the data you sent in that request. The host replaces the reference with the exact original before validation, so never re-type what a reference can carry. Only requests you sent in this run can be referenced.`)
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
    // An empty default array shows a member nothing about the items it must write, so spell out declared shapes.
    const shapes = writable.flatMap(item => {
      const definition = run.config?.state?.definitions?.find(row => row.namespace === item.namespace && row.path === item.path)
      return definition?.valueSchema ? [`${formatStatePath(item)} ${describeValueSchema(definition.valueSchema)}`] : []
    })
    if (shapes.length) {
      lines.push(`Declared value shapes (* marks a required key; a write below one of these paths must keep the whole value valid): ${shapes.join('; ')}.`)
    }
    lines.push('Remove a permitted object property with rp_team_remove_state({ namespace, path, expectedVersion }); whole namespaces and world setting files cannot be removed.')
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
    ...(handoff.materialPack
      ? { materialPack: true, requestData: 'Submit the material-selection sheet from your instructions. The host supplies all packet fields from authorized originals.' }
      : { requestSchema: handoff.requestSchema, requestSelectors: handoff.requestSelectors }),
    responseSchema: handoff.responseSchema, responseSelectors: handoff.responseSelectors,
    timeoutMs: handoff.timeoutMs, onFailure: handoff.onFailure,
    ...(handoff.references ? { references: true } : {}), ...(handoff.terminal ? { terminal: true } : {}),
    ...(handoff.parallel ? { parallel: true } : {})
  })
}

function formatIncomingHandoff(value) {
  const handoff = value?.handoff ?? value
  return JSON.stringify({
    from: value.from, id: handoff.id, mode: handoff.mode,
    requestSchema: handoff.requestSchema, responseSchema: handoff.responseSchema,
    requestSelectors: handoff.requestSelectors, responseSelectors: handoff.responseSelectors,
    timeoutMs: handoff.timeoutMs, onFailure: handoff.onFailure,
    ...(handoff.references ? { references: true } : {}), ...(handoff.terminal ? { terminal: true } : {})
  })
}

export function childPrompt(agent, run, agentContext, activationNo, pendingChildren) {
  return [{ type: 'text', text: [
    childPolicy(agent, run, activationNo, pendingChildren),
    'Filtered context packet:', JSON.stringify(agentContext.sources, null,
      agentContext.sources.world_last_beat || agentContext.sources.world_source_lookup || agentContext.sources.review_passages ? undefined : 2)
  ].join('\n\n') }]
}

function pathWithin(parent, child) { return parent === '' || parent === child || child.startsWith(`${parent}/`) }

function conditionRefs(condition) {
  if (!condition) return []
  if (condition.op === 'all' || condition.op === 'any') return condition.conditions.flatMap(conditionRefs)
  if (condition.op === 'not') return conditionRefs(condition.condition)
  return [{ namespace: condition.namespace, path: condition.path }]
}
