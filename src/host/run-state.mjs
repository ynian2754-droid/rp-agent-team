import { createHash, randomUUID } from 'node:crypto'
import { normalizeTeamConfig, teamError } from '../shared/schema.mjs'

export { teamError } from '../shared/schema.mjs'

const TERMINAL = new Set(['complete', 'cancelled', 'failed'])

export function configRevision(config) {
  return createHash('sha256').update(stableJson(config)).digest('hex')
}

export function createRun({ conversationId, rootSessionId, config, templateConfig = config, parameterValues = {}, resolvedHash, contextPacket = {}, baseState = {}, baseHash, runId = randomUUID(), manualAgentIds = [] }) {
  const team = normalizeTeamConfig(config)
  const members = Object.fromEntries(team.agents.map(agent => [agent.id, {
    id: agent.id, name: agent.name, status: 'pending', activations: 0, result: null, error: null,
    model: undefined, tokens: undefined, sessions: []
  }]))
  return {
    runId: String(runId), conversationId: String(conversationId), rootSessionId: String(rootSessionId),
    configRevision: configRevision(team), config: team, outputAgentId: team.output.agentId,
    templateConfig: normalizeTeamConfig(templateConfig), parameterValues: structuredClone(parameterValues), resolvedHash,
    contextPacket: structuredClone(contextPacket), baseState: structuredClone(baseState), baseHash,
    manualAgentIds: [...manualAgentIds], members, sessionBindings: new Map(), activeSessions: new Map(),
    childSessionIds: [], sessionOwners: new Map(), executionSessions: [],
    drafts: [], publication: null, phase: 'preparing', startedAt: new Date().toISOString(),
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), activationCount: 0,
    productCommitStaged: false
  }
}

export function bindAgentSession(run, agentId, sessionId, activation) {
  if (!run.members[agentId]) throw teamError('RP_TEAM_AGENT_NOT_FOUND', `Unknown agent ${agentId}`)
  const session = String(sessionId)
  const existing = run.sessionBindings.get(session)
  if (existing && existing.agentId !== agentId) throw teamError('RP_TEAM_SESSION_ALREADY_BOUND', `Session ${session} is already bound to ${existing.agentId}`)
  const active = run.activeSessions.get(agentId)
  if (active && active !== session) throw teamError('RP_TEAM_AGENT_OVERLAP', `Agent ${agentId} already has an active native Session`)
  run.sessionBindings.set(session, { agentId, activation })
  run.activeSessions.set(agentId, session)
  const member = run.members[agentId]
  if (!member.sessions.includes(session)) member.sessions.push(session)
  member.status = 'running'
  member.activations = Math.max(member.activations, Number(activation) || 1)
  touch(run)
}

export function unbindAgentSession(run, sessionId) {
  const session = String(sessionId)
  const binding = run.sessionBindings.get(session)
  if (!binding) return undefined
  if (run.activeSessions.get(binding.agentId) === session) run.activeSessions.delete(binding.agentId)
  run.sessionBindings.delete(session)
  touch(run)
  return binding
}

export function agentForSession(run, sessionId) {
  const binding = run.sessionBindings.get(String(sessionId))
  return binding ? run.config.agents.find(agent => agent.id === binding.agentId) : undefined
}

export function setRunPhase(run, phase, failure) {
  if (!['preparing', 'working', 'composing', 'publishing', 'awaiting_commit', 'failed', 'cancelled', 'complete'].includes(phase)) {
    throw teamError('RP_TEAM_INVALID_PHASE', `Unknown run phase ${phase}`)
  }
  if (TERMINAL.has(run.phase)) throw teamError('RP_TEAM_TERMINAL', `Run is already ${run.phase}`)
  run.phase = phase
  if (failure !== undefined) run.failure = String(failure)
  touch(run)
  return run.phase
}

export function stagePublication(run, agentId, publication) {
  if (run.publication) throw teamError('RP_TEAM_ALREADY_PUBLISHED', 'This run already has a publication')
  if (agentId !== run.config.output.agentId) throw teamError('RP_TEAM_OUTPUT_FORBIDDEN', 'Only the configured output agent may publish')
  const agent = run.config.agents.find(item => item.id === agentId)
  if (!agent?.outputAuthority.user) throw teamError('RP_TEAM_OUTPUT_FORBIDDEN', 'The configured output agent has no user-facing output authority')
  const body = String(publication?.body ?? '').trim()
  if (!body) throw teamError('RP_TEAM_EMPTY_PUBLICATION', 'Publication body must not be empty')
  if (run.phase !== 'working' && run.phase !== 'composing' && run.phase !== 'publishing') {
    throw teamError('RP_TEAM_INVALID_PHASE', `Cannot publish while run is ${run.phase}`)
  }
  run.publication = {
    runId: run.runId, agentId, body, status: 'staged',
    operationCount: Number(publication.operationCount) || 0,
    selectedDraftIds: [...new Set(publication.selectedDraftIds ?? [])],
    stagedAt: new Date().toISOString()
  }
  run.phase = 'publishing'
  touch(run)
  return structuredClone(run.publication)
}

export function completeRun(run) {
  if (run.phase !== 'publishing' || !run.publication) throw teamError('RP_TEAM_INVALID_PHASE', 'No publication is awaiting DSH completion')
  run.phase = 'awaiting_commit'
  run.publication.status = 'awaiting_commit'
  touch(run)
  return run.phase
}

export function commitRun(run, outcome, productMessageId) {
  if (run.phase !== 'awaiting_commit' && !['failed', 'cancelled'].includes(run.phase)) {
    throw teamError('RP_TEAM_INVALID_PHASE', `Cannot commit a run in ${run.phase}`)
  }
  if (outcome === 'committed') {
    if (run.phase !== 'awaiting_commit') throw teamError('RP_TEAM_INVALID_PHASE', 'A failed or cancelled run cannot commit')
    run.phase = 'complete'
    run.completedAt = new Date().toISOString()
    if (run.publication) run.publication.status = 'committed'
    if (productMessageId) run.productMessageId = String(productMessageId)
  } else if (outcome === 'failed' || outcome === 'cancelled') {
    run.phase = outcome
    run.failure ||= 'ElecKoi did not commit this Team response'
    if (run.publication) run.publication.status = 'rolled_back'
    if (productMessageId) run.productMessageId = String(productMessageId)
  } else {
    throw teamError('RP_TEAM_INVALID_COMMIT', `Unknown commit outcome ${outcome}`)
  }
  touch(run)
  return run.phase
}

export function cancelRun(run, reason = 'User cancelled') {
  if (TERMINAL.has(run.phase)) return run.phase
  run.phase = 'cancelled'
  run.failure = String(reason)
  for (const member of Object.values(run.members)) if (member.status === 'running' || member.status === 'queued') member.status = 'cancelled'
  touch(run)
  return run.phase
}

export function failRun(run, reason) {
  if (TERMINAL.has(run.phase)) return run.phase
  run.phase = 'failed'
  run.failure = String(reason?.message ?? reason)
  touch(run)
  return run.phase
}

export function runStatus(run) {
  const members = Object.fromEntries(Object.entries(run.members).map(([id, value]) => [id, {
    id, name: value.name, status: value.status, result: value.result ?? null,
    ...(value.error ? { error: value.error } : {}),
    ...(value.model ? { model: value.model } : {}),
    ...(value.tokens ? { tokens: value.tokens } : {}),
    ...(value.activations || value.reusedFromRunId ? { activations: value.activations ?? 0 } : {}),
    ...(value.reusedFromRunId ? { reusedFromRunId: value.reusedFromRunId } : {})
  }]))
  return {
    runId: run.runId, conversationId: run.conversationId, phase: run.phase,
    startedAt: run.startedAt, createdAt: run.createdAt, updatedAt: run.updatedAt,
    ...(Number.isSafeInteger(run.turn) ? { turn: run.turn } : {}),
    outputAgentId: run.outputAgentId, members, publication: run.publication ? structuredClone(run.publication) : null,
    ...(run.inputMessageId ? { inputMessageId: run.inputMessageId } : {}),
    ...(Number.isInteger(run.inputEventSeq) ? { inputEventSeq: run.inputEventSeq } : {}),
    ...(Number.isSafeInteger(run.assistantSeq) ? { assistantSeq: run.assistantSeq } : {}),
    ...(run.assistantMessageId ? { assistantMessageId: run.assistantMessageId } : {}),
    ...(run.retrySourceRunId ? { retrySourceRunId: run.retrySourceRunId } : {}),
    ...(run.productMessageId ? { productMessageId: run.productMessageId } : {}),
    ...(run.budget ? { budget: run.budget.snapshot() } : run.budgetSnapshot ? { budget: structuredClone(run.budgetSnapshot) } : {}),
    productCommitStaged: run.productCommitStaged === true,
    ...(run.failure ? { failure: run.failure } : {}),
    retryAvailable: ['failed', 'cancelled'].includes(run.phase)
      && Object.values(members).some(member => member.status === 'failed' || member.status === 'cancelled')
      && (['failed', 'cancelled'].includes(run.productReceiptOutcome)
        || (run.productCommitStaged !== true && !run.assistantSeq && !run.assistantMessageId && !run.productMessageId))
  }
}

export function serializeRun(run, trace) {
  return {
    version: 2,
    status: runStatus(run),
    rootSessionId: run.rootSessionId,
    localDeliveryRequestSeq: run.localDeliveryRequestSeq,
    executionSessions: structuredClone(run.executionSessions ?? []),
    childSessionIds: [...(run.childSessionIds ?? [])],
    configRevision: run.configRevision,
    config: structuredClone(run.config),
    templateConfig: structuredClone(run.templateConfig ?? run.config),
    parameterValues: structuredClone(run.parameterValues ?? {}),
    resolvedHash: run.resolvedHash,
    triggerStarts: structuredClone(run.triggerStarts ?? []),
    triggerCooldownMarkers: structuredClone(run.triggerCooldownMarkers ?? []),
    branchId: run.branchId,
    userTurnOrdinal: run.userTurnOrdinal,
    budget: run.budget ? run.budget.snapshot() : structuredClone(run.budgetSnapshot),
    members: structuredClone(run.members),
    publication: run.publication ? structuredClone(run.publication) : null,
    failure: run.failure,
    productMessageId: run.productMessageId,
    productCommitStaged: run.productCommitStaged === true,
    retrySourceRunId: run.retrySourceRunId,
    inputMessageId: run.inputMessageId,
    inputEventSeq: run.inputEventSeq,
    assistantSeq: run.assistantSeq,
    assistantMessageId: run.assistantMessageId,
    trace: trace ? structuredClone(trace) : undefined
  }
}

export function hydrateRun(saved, { conversationId, rootSessionId } = {}) {
  const status = saved?.status ?? saved
  const config = normalizeTeamConfig(saved?.config)
  const run = createRun({
    conversationId: status.conversationId ?? conversationId,
    rootSessionId: rootSessionId ?? saved?.rootSessionId ?? `restored:${status.runId}`,
    config,
    runId: status.runId
  })
  run.phase = status.phase
  run.startedAt = status.startedAt ?? status.createdAt
  run.createdAt = status.createdAt ?? run.startedAt
  run.updatedAt = status.updatedAt ?? run.startedAt
  run.members = structuredClone(saved.members ?? status.members ?? run.members)
  run.templateConfig = normalizeTeamConfig(saved.templateConfig ?? saved.config)
  run.parameterValues = structuredClone(saved.parameterValues ?? {})
  run.resolvedHash = saved.resolvedHash
  run.triggerStarts = structuredClone(saved.triggerStarts ?? [])
  run.triggerCooldownMarkers = structuredClone(saved.triggerCooldownMarkers ?? [])
  run.branchId = saved.branchId
  run.userTurnOrdinal = saved.userTurnOrdinal
  run.budgetSnapshot = structuredClone(saved.budget ?? status.budget)
  run.publication = saved.publication ?? status.publication ?? null
  run.failure = saved.failure ?? status.failure
  run.productMessageId = saved.productMessageId ?? status.productMessageId
  run.retrySourceRunId = saved.retrySourceRunId ?? status.retrySourceRunId
  run.inputMessageId = saved.inputMessageId ?? status.inputMessageId
  run.inputEventSeq = saved.inputEventSeq ?? status.inputEventSeq
  run.assistantSeq = saved.assistantSeq
  run.assistantMessageId = saved.assistantMessageId
  run.turn = saved.turn ?? status.turn
  run.localDeliveryRequestSeq = saved.localDeliveryRequestSeq
  run.childSessionIds = [...(saved.childSessionIds ?? [])]
  run.executionSessions = structuredClone(saved.executionSessions ?? [])
  return run
}

function touch(run) { run.updatedAt = new Date().toISOString() }

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`
  return JSON.stringify(value)
}
