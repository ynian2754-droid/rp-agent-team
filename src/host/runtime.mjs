import { registerExecutionSession, finishExecutionSession, traceAssociation, observeStatePath } from './execution-trace.mjs'
import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  applySavedRunFields, conversationTraceDirectory as conversationTraceDirectoryPath, fingerprint, manualSelectionPath,
  persistedRunValue, readOptionalJson, readRunRecordFile,
  readRunRows, removeRunData, runDataDirectory as runDataDirectoryPath, runFilePath, serializedActiveRun,
  writeJsonAtomic
} from './run-persistence.mjs'
import { interruptPersistedRequests, readRequestRecords } from './request-persistence.mjs'
import {
  bindAgentSession, cancelRun as cancelRunState, commitRun as commitRunState, completeRun,
  configRevision, createRun, failRun, hydrateRun, runStatus, setRunPhase, stagePublication,
  teamError, unbindAgentSession
} from './run-state.mjs'
import { TeamConfigStore } from './config-store.mjs'
import { StateStore, describeStateToolAccess, projectStateValueForAgent, versionForPath } from './state-store.mjs'
import { createScheduler } from './scheduler.mjs'
import { createCommunication } from './communication.mjs'
import { buildAgentContext, draftVisibleTo } from './context-policy.mjs'
import { actualTokenUsage, createTrace, recordTrace, traceSummary } from './trace.mjs'
import { disposeRegisteredAgentPresets, resolveAgentModel, resolveAgentPreset, validateAgentModelRoutes } from './agent-composition.mjs'
import { registerTeamTools } from './team-tools.mjs'
import { registerMemoryTools } from './memory-tools.mjs'
import { resolveAuthorParameters } from '../shared/author-parameters.mjs'
import {
  committedTriggerCooldowns, createTriggerTracker, latestCommittedStateCheckpoint, stateChangesFromCheckpoint
} from './event-triggers.mjs'
import { assertBudgetedRunDispatchable, createRunBudget, isBudgetedTeamRequest, requestOrigin } from './run-budget.mjs'
import {
  canReadNativeNamespace, canWriteNativeNamespace, childPolicy, childPrompt,
  conditionState, createChildContextData, makeSources
} from './agent-context.mjs'
import {
  allowedGroupsForAgent, CAPABILITIES, capabilityAvailableInSnapshot,
  capabilityForDeclaration, capabilityLabel, MANAGED_CAPABILITIES,
  NATIVE_PRESET_TOOLS, toolGroups
} from './native-policy.mjs'
import {
  bridgeSettingFiles, diffLeaves, escapePointer, stableJson, storyOperations
} from './context-world-adapter.mjs'
import { evaluateCondition, migrateV1ToV2, normalizeTeamConfig, parsePreset } from '../shared/schema.mjs'
import { createTeamDeliveryAdapter, TEAM_DELIVERY_MODEL, TEAM_DELIVERY_PROVIDER } from './delivery-adapter.mjs'
import { isOwnedSettledNotice, matchesRunInputMessage, sumTokenSamplesForSessions } from './session-event-policy.mjs'

const TOOL_GROUP = 'rp-team'
const VARIABLE_READ_TOOLS = ['eleckoi_glob_variables', 'eleckoi_grep_variables', 'eleckoi_read_variables']
const VARIABLE_WRITE_TOOLS = ['eleckoi_apply_variable_patch']
const SETTING_READ_TOOLS = ['eleckoi_glob_setting_files', 'eleckoi_grep_setting_files', 'eleckoi_read_setting_files']
const SETTING_WRITE_TOOLS = ['eleckoi_apply_setting_patch', 'eleckoi_create_setting_file', 'eleckoi_update_setting_file', 'eleckoi_delete_setting_file', 'eleckoi_move_setting_file']

function disabledToolNamesForAgent(inherited, agent) {
  const disabled = new Set(inherited ?? [])
  if (!agent || !canWriteNativeNamespace(agent, 'variables')) {
    for (const name of VARIABLE_WRITE_TOOLS) disabled.add(name)
  }
  return [...disabled]
}

/** Native DSH supplies Sessions and model/tool composition; this module owns roster policy and publication. */
export function createRpAgentTeam(ctx, dependencies) {
  const { defineTool, parseYaml, stringifyYaml, scopeOf, LlmAdapter } = dependencies
  const store = new TeamConfigStore()
  const stateStore = new StateStore()
  const runs = new Map()
  const latestRunByConversation = new Map()
  const activeRunBySession = new Map()
  const bindingsBySession = new Map()
  const bindingsByConversation = new Map()
  const childBindings = new Map()
  const budgetedRequestOrigins = new WeakMap()
  const controllers = new Map()
  const pendingRetry = new Map()
  const manualSelections = new Map()
  const registeredPresets = new Map()
  const dataRoot = join(dirname(store.path), 'runs')
  const traceRoot = join(dirname(store.path), 'traces')
  let disposed = false
  let disposing = false
  const deliveryRegistration = ctx.llm.registerAdapter(
    [TEAM_DELIVERY_PROVIDER], createTeamDeliveryAdapter(deliverScheduledRun, LlmAdapter)
  )

  const recoveryReceipts = new Map()
  const recoveryWrites = new Map()
  const recoveryReady = stateStore.recover(async ({ conversationId, runId }) => {
    const key = `${conversationId}\u0000${runId}`
    const receipt = await getProductCommitStatus({ conversationId, runId })
    recoveryReceipts.set(key, receipt)
    if (receipt.outcome === 'failed' || receipt.outcome === 'cancelled') {
      const saved = loadRunRecordAsRuntime(conversationId, runId)
      const writes = stateStore.status({ conversationId, runId }).writes
      recoveryWrites.set(key, writes.filter(write => saved?.members?.[write.agentId]?.status === 'complete').map(write => structuredClone(write)))
    }
    return receipt
  }).then(recovered => {
    for (const transaction of recovered) {
      if (!['committed', 'rolled_back'].includes(transaction.status)) continue
      const key = `${transaction.conversationId}\u0000${transaction.runId}`
      const receipt = recoveryReceipts.get(key)
      if (!receipt || !['committed', 'failed', 'cancelled'].includes(receipt.outcome)) continue
      const run = loadRunRecordAsRuntime(transaction.conversationId, transaction.runId)
      if (!run) continue
      run.dataDir = runDataDirectory(run.conversationId, run.runId)
      run.stateTransaction = transaction
      run.productReceiptOutcome = receipt.outcome
      if (receipt.outcome === 'committed') run.triggerCooldownMarkers = structuredClone(run.triggerStarts ?? [])
      closeRunBudget(run)
      if (receipt.outcome !== 'committed') {
        setReceiptFailure(run, receipt)
        run.preservedStateWrites = recoveryWrites.get(key) ?? []
        recordCommitFailure(run, receipt.outcome, new Error(run.failure))
      }
      commitRunState(run, receipt.outcome, receipt.productMessageId)
      record(run, { type: receipt.outcome === 'committed' ? 'publication.committed' : 'publication.rolled_back',
        agentId: run.outputAgentId, data: {
          status: receipt.outcome, productMessageId: receipt.productMessageId,
          ...(run.failure ? { reason: run.failure } : {}),
          assistantSeq: run.assistantSeq, assistantMessageId: run.assistantMessageId
        } })
      cleanRunData(run)
      persistRun(run)
    }
  })

  const extension = {
    id: 'rp-agent-team',
    toolGroups: [{ id: TOOL_GROUP, label: 'RP Agent Team' }],
    resolveSnapshot,
    resolveChildOptions,
    setupAgent,
    prepareConversationRestore,
    classifyTool: ({ declaration }) => declaration?.name?.startsWith('rp_team_') ? TOOL_GROUP : undefined,
    authorizePresetTools,
    mode: ({ sessionId }) => activeRunBySession.has(String(sessionId)) || childBindings.has(String(sessionId)) ? 'team' : 'normal'
  }

  const api = {
    getConfig: ({ conversationId }) => store.get(conversationId),
    saveConfig: async ({ conversationId, expectedRevision, enabled, config, parameterValues }) => {
      const normalized = normalizeTeamConfig(config)
      const storedValues = parameterValues === undefined
        ? store.get(conversationId).parameterValues
        : parameterValues
      const declared = new Set((normalized.authorParameters ?? []).map(parameter => parameter.id))
      const valuesForResolution = parameterValues === undefined
        ? Object.fromEntries(Object.entries(storedValues).filter(([id]) => declared.has(id)))
        : parameterValues
      const resolved = resolveAuthorParameters(normalized, valuesForResolution)
      await validateAgentModelRoutes(resolved.config, ctx.llm)
      const saved = store.save({ conversationId, expectedRevision, enabled, config: normalized, parameterValues })
      pruneManualSelection(conversationId, normalized)
      return saved
    },
    getOptions: ({ conversationId }) => getOptions(conversationId),
    getStatus: async ({ conversationId }) => { await recoveryReady; return await getStatus(conversationId) },
    cancel: ({ conversationId, runId }) => cancelFromClient(conversationId, runId),
    retry: stageRetry,
    discardRetry: discardRetryIntent,
    exportConfig: ({ conversationId }) => store.export(conversationId),
    setManualAgents,
    listTraces: async args => { await recoveryReady; return listTraces(args) },
    getTrace: async args => { await recoveryReady; return getTrace(args) },
    importConfig,
    // Host migration-only method. The public Typert Remote intentionally omits it.
    importHistoricalRun
  }

  const authoring = {
    store, stateStore, recoveryReady,
    isConversationBusy,
    getRunRecords
  }

  const disposeSessionEvents = ctx.on('session/event', (session, event) => onSessionEvent(session, event))
  const disposeBudgetStream = ctx.on('llm/stream', (options, next) => guardTeamModelRequest(options, next))

  async function resolveSnapshot({ sessionId, parentSessionId, child, snapshot }) {
    const session = String(sessionId)
    if (child) return resolveChildSnapshot({ sessionId: session, parentSessionId, snapshot })
    return {}
  }

  function resolveChildOptions({ parentSessionId, label }) {
    const rootSessionId = String(parentSessionId ?? '')
    const run = runs.get(activeRunBySession.get(rootSessionId))
    const pending = run && pendingChildFor(run, label)
    if (!pending) return undefined
    const { provider, model, reasoningEffort, maxTokens } = pending.route
    return {
      provider, model,
      ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
      ...(maxTokens === undefined ? {} : { maxTokens })
    }
  }

  function resolveChildSnapshot({ sessionId, parentSessionId, snapshot }) {
    const parentId = String(parentSessionId ?? snapshot.inheritedFromSessionId ?? '')
    const rootSessionId = String(snapshot.rpTeamRootSessionId ?? parentId)
    const runId = activeRunBySession.get(rootSessionId) ?? snapshot.rpTeamRunId
    const run = runs.get(String(runId))
    if (!run || run.rootSessionId !== rootSessionId) return {}
    if (parentId !== rootSessionId) {
      const parentBinding = run.sessionBindings.get(parentId)
      const owner = agentById(run.config, parentBinding?.agentId ?? snapshot.rpTeamAgentId)
      return {
        rpTeamRunId: run.runId, rpTeamRootSessionId: rootSessionId,
        rpTeamAgentId: owner?.id ?? snapshot.rpTeamAgentId,
        disabledToolNames: disabledToolNamesForAgent(snapshot.disabledToolNames, owner)
      }
    }
    const row = nativeMember(rootSessionId, sessionId)
    const pending = row && pendingChildFor(run, row.description)
    if (!pending) return { rpTeamRunId: run.runId, rpTeamRootSessionId: rootSessionId, rpTeamSourceContextFile: undefined }
    bindPendingChild(run, pending.marker, String(sessionId), row.name)
    return childSnapshotOverlay(run, pending, snapshot)
  }

  function childSnapshotOverlay(run, pending, snapshot) {
    const agent = agentById(run.config, pending.agentId)
    const route = pending.route
    const presetId = pending.presetId
    const groups = pending.allowedGroups
    const currentDisabled = new Set(snapshot.disabledToolGroupIds ?? [])
    const disabledToolGroupIds = [...new Set([
      ...pending.rootGroups.filter(id => !groups.has(id)),
      ...[...currentDisabled].filter(id => !groups.has(id))
    ])]
    return {
      rpTeamBinding: run.binding,
      rpTeamRunId: run.runId,
      rpTeamRootSessionId: run.rootSessionId,
      rpTeamAgentId: agent.id,
      rpTeamActivation: pending.activationNo,
      rpTeamSourceContextFile: undefined,
      contextFile: pending.contextFile,
      variableStateFile: pending.variableStateFile,
      settingStateFile: pending.settingStateFile,
      mountedPresetId: presetId,
      subagentModel: route,
      model: { ...structuredClone(route), systemPrompt: '' },
      disabledToolGroupIds,
      disabledToolNames: disabledToolNamesForAgent(snapshot.disabledToolNames, agent),
      ...(agent.compaction.historyCompactionInstructions === undefined ? {} : {
        historyCompactionInstructions: agent.compaction.historyCompactionInstructions
      })
    }
  }

  async function setupAgent({ agentCtx, agent, sessionId, child, snapshot, binding: hostBinding, getTurnSnapshot }) {
    const session = String(sessionId)
    if (!child) {
      const conversationId = String(hostBinding?.conversationId ?? snapshot.conversationId ?? '')
      if (conversationId) bindingsBySession.set(session, { conversationId, rootSessionId: session })
      const disposers = []
      disposers.push(agentCtx.on('agent/pre-step', async (event, next) => {
        const messages = Array.isArray(event?.messages) ? event.messages : []
        const users = messages.filter(message => message?.role === 'user' && message?.source?.kind === 'user')
        if (users.length === 0) {
          const binding = bindingsBySession.get(session)
          const ownedChildSessionIds = ownedChildSessions(session, binding?.conversationId)
          if (messages.length > 0 && messages.every(message => isOwnedSettledNotice(message, ownedChildSessionIds))) {
            const activeId = activeRunBySession.get(session)
            const active = activeId ? runs.get(activeId) : undefined
            if (active?.phase === 'awaiting_commit' && active.turn === event.turn) {
              await commitPublishedRun(agentCtx, agent, active, event.signal)
            }
            return { kind: 'enter', messages: [] }
          }
          return await next()
        }
        const activeId = activeRunBySession.get(session)
        const active = activeId ? runs.get(activeId) : undefined
        if (active?.turn === event.turn) return { kind: 'enter', messages }
        const captured = await getTurnSnapshot({ messages, turn: event.turn, signal: event.signal })
        const conversationId = String(captured.conversationId ?? hostBinding?.conversationId ?? snapshot.conversationId ?? '')
        if (!conversationId) return await next()
        await recoveryReady
        const saved = store.get(conversationId)
        if (disposing || disposed || !saved.enabled) return await next()
        const run = await beginRun({ sessionId: session, turn: event.turn, snapshot: captured, rootSnapshot: snapshot,
          rootAgent: agent, claimedMessages: messages, config: saved.config, parameterValues: saved.parameterValues, configRevision: saved.revision,
          disabledToolGroupIds: hostBinding?.productDisabledGroups ?? snapshot.disabledToolGroupIds ?? [] })
        if (run) return { kind: 'enter', messages }
        return await next()
      }, { prepend: true }))
      disposers.push(agentCtx.on('agent/request', async (event, next) => {
        const proposed = await next()
        const runId = activeRunBySession.get(session)
        const run = runId ? runs.get(runId) : undefined
        if (!run || run.turn !== event.turn || run.phase !== 'working') return proposed
        const { provider: _provider, model: _model, reasoningEffort: _reasoningEffort,
          temperature: _temperature, topP: _topP, maxTokens: _maxTokens, ...rest } = proposed
        return { ...rest, provider: TEAM_DELIVERY_PROVIDER, model: TEAM_DELIVERY_MODEL }
      }, { prepend: true }))
      disposers.push(agentCtx.on('agent/turn-stopping', async ({ turn, signal }) => {
        const runId = activeRunBySession.get(session)
        const run = runId ? runs.get(runId) : undefined
        if (!run || run.turn !== turn || run.phase !== 'awaiting_commit') return
        await commitPublishedRun(agentCtx, agent, run, signal)
      }))
      return () => { for (const dispose of disposers.reverse()) dispose?.() }
    }

  async function commitPublishedRun(agentCtx, agent, run, signal) {
    try {
      assertBudgetAvailable(run)
      signal?.throwIfAborted()
      await run.localDeliveryMarkerPromise
      assertBudgetAvailable(run)
      if (run.localDeliveryMarkerError) throw run.localDeliveryMarkerError
      const flushed = await agentCtx.sessions.flush(agent.session)
      assertBudgetAvailable(run)
      if (flushed === false) throw teamError('RP_TEAM_SESSION_FLUSH_FAILED', 'The root Session did not confirm persistence')
      const receipt = await ctx.eleckoiStoryState.commitProductTurn({
        conversationId: run.conversationId, runId: run.runId, sessionId: run.rootSessionId, turn: run.turn
      })
      if (receipt?.outcome !== 'committed') throw teamError('RP_TEAM_PRODUCT_COMMIT_FAILED', 'Host did not confirm the Team response commit')
      await commitProductState(run, receipt)
    } catch (error) {
      if (run.budgetFailure) await settleFailedRun(run, 'failed', run.budgetFailure)
      else await settleRunFromReceipt(run)
      throw error
    }
  }
    const run = runs.get(String(snapshot.rpTeamRunId))
    const binding = run?.sessionBindings.get(session)
    const childBinding = childBindings.get(session)
    if (!run) return undefined
    const member = agentById(run.config, binding?.agentId ?? snapshot.rpTeamAgentId)
    if (!member) return undefined
    run.sessionOwners ??= new Map()
    run.sessionOwners.set(session, {
      runId: run.runId, agentId: member.id, activation: binding?.activation ?? snapshot.rpTeamActivation,
      sessionId: session, scheduled: Boolean(binding)
    })
    registerExecutionSession(run, { agentId: member.id, activation: binding?.activation ?? snapshot.rpTeamActivation,
      sessionId: session, parentSessionId: agent.session.parentSessionId ?? agent.session.parentAgent?.session?.id ?? snapshot.inheritedFromSessionId,
      depth: childBinding?.depth ?? ((run.executionSessions.find(row => row.sessionId === snapshot.inheritedFromSessionId)?.depth ?? 0) + 1), scheduled: Boolean(binding) })
    const memberRunState = run.members[member.id]
    if (!memberRunState.sessions.includes(session)) memberRunState.sessions.push(session)
    persistRun(run)
    const requestDispose = agentCtx.on('agent/request', async (event, next) => {
      const proposed = await next()
      if (!binding || !childBinding) return proposed
      const { provider: _provider, model: _model, reasoningEffort: _reasoningEffort,
        temperature: _temperature, topP: _topP, maxTokens: _maxTokens, ...rest } = proposed
      return { ...rest, ...childBinding.route }
    }, { prepend: true })
    if (!binding || !childBinding) {
      const capabilityDispose = await restrictAgentCapabilities(agentCtx, member, run, snapshot, false)
      const stateDispose = restrictManagedStateTools(agentCtx, member)
      return () => { requestDispose?.(); capabilityDispose?.(); stateDispose?.() }
    }
    const disposers = []
    const promptDispose = agentCtx.systemPrompt.section({
      name: `rp-agent-team:${run.runId}:${member.id}:${binding.activation}`,
      order: agentCtx.systemPrompt.getSectionOrder('TEAM_POLICY'),
      text: childPolicy(member, run, binding.activation, run.pendingChildren)
    })
    disposers.push(registerTools(agentCtx, member, run, session))
    disposers.push(await restrictAgentCapabilities(agentCtx, member, run, snapshot, true))
    disposers.push(restrictManagedStateTools(agentCtx, member))
    disposers.push(requestDispose)
    return () => {
      promptDispose?.()
      for (const dispose of disposers.reverse()) if (typeof dispose === 'function') dispose()
    }
  }

  async function restrictAgentCapabilities(agentCtx, member, run, snapshot, scheduled) {
    const allowed = allowedGroupsForAgent(member, run.rootAvailableGroups, run.productDisabledGroups)
    const names = declaration => declaration?.name ?? declaration?.function?.name ?? ''
    const denied = new Set(agentCtx.tools.schemas().flatMap(declaration => {
      const name = names(declaration)
      if (!name) return []
      if (name.startsWith('rp_team_')) return scheduled ? [] : [name]
      if (name === 'eleckoi_capability_probe' || name === 'eleckoi_read_uploaded_file') return []
      return allowed.has(capabilityForDeclaration(declaration)) ? [] : [name]
    }))
    if (denied.size === 0) return undefined
    const restrictable = agentCtx.tools.view(scopeOf(agentCtx)).restrictableNames
    const namesToRestrict = [...denied].filter(name => restrictable.has(name))
    const disposers = []
    if (namesToRestrict.length) disposers.push(agentCtx.tools.restrict({ deny: namesToRestrict }))
    if (typeof agentCtx.tools.guard === 'function') {
      disposers.push(agentCtx.tools.guard(execution => denied.has(execution.name)
        ? `Tool "${execution.name}" is not authorized by this agent's capabilities.` : undefined))
    }
    if (!disposers.length) return undefined
    return () => { for (const dispose of disposers.reverse()) dispose() }
  }

  async function beginRun({ sessionId, turn, snapshot, rootSnapshot, rootAgent, claimedMessages, config, parameterValues = {}, configRevision, disabledToolGroupIds }) {
    if (disposing || disposed) return undefined
    const templateConfig = structuredClone(config)
    const resolvedParameters = resolveAuthorParameters(config, parameterValues)
    config = resolvedParameters.config
    await validateAgentModelRoutes(config, ctx.llm)
    const conversationId = String(snapshot.conversationId)
    await recoveryReady
    const pendingAuthorEdits = stateStore.pendingAuthorEdits(conversationId)
    if (pendingAuthorEdits.length) {
      throw teamError('RP_TEAM_AUTHOR_EDIT_PENDING', 'Resolve the pending author edit before starting another Team run')
    }
    const previousRun = latestRun(conversationId)
    if (previousRun?.phase === 'awaiting_commit') {
      const receipt = await settlePendingReceipt(previousRun)
      persistRun(previousRun)
      if (['pending', 'unknown'].includes(receipt?.outcome)) {
        throw teamError('RP_TEAM_COMMIT_PENDING', 'The prior Team response still has no definitive product receipt')
      }
    }
    const conversationWork = { conversationId, kind: 'team', workId: String(sessionId) }
    if (typeof ctx.eleckoiStoryState.beginConversationWork !== 'function'
      || typeof ctx.eleckoiStoryState.endConversationWork !== 'function') {
      throw teamError('RP_TEAM_WORK_LOCK_UNAVAILABLE', 'Host cannot coordinate Team work with authoring edits')
    }
    await ctx.eleckoiStoryState.beginConversationWork(conversationWork)
    let retainedWorkLock = false
    try {
    const runId = randomUUID()
    const worldSnapshot = snapshot.worldSnapshot ?? await ctx.eleckoiStoryState.snapshot({ conversationId })
    const baseHash = worldSnapshot.baseHash
    const prepared = await ctx.eleckoiStoryState.prepare(worldSnapshot, [], { conversationId, runId, baseHash })
    const destinationSnapshot = {
      ...structuredClone(rootSnapshot), ...structuredClone(snapshot),
      conversationId, model: structuredClone(snapshot.modelSnapshot),
      contextFile: snapshot.sourceContextFile,
      variableBridge: prepared.variableBridge, settingBridge: prepared.settingBridge
    }
    const sourceContextFile = snapshot.sourceContextFile
    const conversation = structuredClone(snapshot.contextSnapshot ?? readOptionalJson(sourceContextFile, {}))
    const binding = {
      conversationId, rootSessionId: String(sessionId), enabled: true, revision: configRevision,
      config: structuredClone(config), templateConfig, parameterValues: structuredClone(resolvedParameters.values),
      resolvedHash: resolvedParameters.resolvedHash, sourceContextFile,
      productDisabledGroups: [...disabledToolGroupIds]
    }
    const initialState = { world: { variables: structuredClone(worldSnapshot.variables ?? {}), settings: structuredClone(worldSnapshot.settings ?? {}) } }
    const userMessage = [...(claimedMessages ?? [])].reverse().find(message => message?.role === 'user' && message?.source?.kind === 'user')
    if (!userMessage) return undefined
    const requestId = userMessage.source?.rpcId ?? snapshot.inputSource?.rpcId
    const content = Array.isArray(userMessage.content) ? userMessage.content : []
    const currentInput = String(conversation.currentUserInput
      ?? content.filter(part => part?.type === 'text').map(part => String(part.text ?? '')).join('\n'))
    const contextFingerprint = fingerprint({ conversationId, currentInput, history: conversation.history ?? [], baseHash })
    let retryIntent
    if (requestId) {
      retryIntent = pendingRetry.get(String(requestId))
      if (retryIntent && (retryIntent.conversationId !== conversationId
        || retryIntent.configStoreRevision !== binding.revision || retryIntent.baseHash !== baseHash
        || retryIntent.contextFingerprint !== contextFingerprint)) {
        pendingRetry.delete(String(requestId))
        throw teamError('RP_TEAM_RETRY_CONTEXT_CHANGED', 'Retry context, story state, or configuration changed; retry intent was discarded')
      }
    }
    const manualAgentIds = retryIntent?.memberIds ?? pruneManualSelection(conversationId, binding.config)
    for (const id of manualAgentIds) {
      const item = agentById(binding.config, id)
      if (!item.triggers.some(trigger => trigger.type === 'manual') && !retryIntent) {
        throw teamError('RP_TEAM_MANUAL_AGENT_INVALID', `Agent ${id} does not have a manual trigger`)
      }
    }
    const run = createRun({
      conversationId, rootSessionId: String(sessionId), config: binding.config,
      templateConfig: binding.templateConfig, parameterValues: binding.parameterValues,
      resolvedHash: binding.resolvedHash, runId: String(runId), manualAgentIds
    })
    run.conversationWork = conversationWork
    run.workLockReleased = false
    run.binding = binding
    run.configStoreRevision = binding.revision
    run.requestId = requestId ? String(requestId) : undefined
    run.turn = Number(turn)
    run.inputMessageId = String(userMessage.id ?? snapshot.inputMessageId ?? '') || undefined
    run.userTurnOrdinal = Number.isSafeInteger(snapshot.userTurnOrdinal) ? snapshot.userTurnOrdinal : undefined
    run.branchId = snapshot.branchId === undefined ? undefined : String(snapshot.branchId)
    run.activeInputMessageIds = [...new Set((snapshot.activeInputMessageIds ?? []).map(String))]
    run.inputEventSeq = snapshot.inputEventSeq ?? findInputEventSeq(rootAgent?.session, userMessage, requestId)
    run.modelSnapshot = structuredClone(snapshot.modelSnapshot)
    run.contextSnapshot = structuredClone(conversation)
    run.worldSnapshot = structuredClone(worldSnapshot)
    run.contextFingerprint = contextFingerprint
    run.baseState = structuredClone(initialState)
    run.baseHash = baseHash
    run.destinationSnapshot = destinationSnapshot
    run.sourceContextFile = sourceContextFile
    run.rawConversationContext = conversation
    run.currentInput = currentInput
    run.attachments = (snapshot.attachments ?? content.filter(part => part?.type === 'image' || part?.type === 'file')).map(part => structuredClone(part))
    run.rootAvailableGroups = await configuredGroups(destinationSnapshot, binding.config)
    if (disposing || disposed) return undefined
    run.productDisabledGroups = new Set(binding.productDisabledGroups)
    run.dataDir = runDataDirectory(binding.conversationId, run.runId)
    run.trace = createTrace(run.runId, run.startedAt)
    run.stateStore = stateStore
    run.record = event => record(run, event)
    run.drafts = []
    run.internalResults = []
    run.reusableHandoffs = []
    run.tokenSamples = {}
    run.preservedStateWrites = []
    run.pendingPrepared = null
    run.pendingChildren = new Map()
    run.childSessionIds = []
    run.activationBases = new Map()
    run.publicationFinalized = false
    run.scheduler = null
    run.schedulerPromise = null
    run.messages = []
    run.triggerStarts = []
    run.triggerCooldownMarkers = []
    run.captureStateBefore = (namespace, path) => captureStateBefore(run, namespace, path)
    run.notifyStateChanged = before => notifyStateChanged(run, before)
    mkdirSync(run.dataDir, { recursive: true })
    run.stateTransaction = stateStore.begin({
      conversationId: run.conversationId, runId: run.runId, config: run.config, initialState
    })
    if (retryIntent) {
      const source = loadRuntimeForRetry(retryIntent.conversationId, retryIntent.sourceRunId)
      run.retrySourceRunId = source.runId
      run.reusableHandoffs = readRequestRecords(traceRoot, retryIntent.conversationId, source.runId)
        .filter(request => request.status === 'completed' && request.targetExecutionId && request.result)
        .map(request => ({ ...request, sourceRunId: source.runId }))
      run.retryAgentIds = [...new Set([...retryIntent.memberIds, run.outputAgentId])]
      run.drafts = structuredClone(source.drafts ?? [])
      const preservedSenders = new Set(Object.entries(source.members ?? {})
        .filter(([id, member]) => member.status === 'complete' && !run.retryAgentIds.includes(id))
        .map(([id]) => id))
      run.messages = structuredClone((source.communication?.allMessages() ?? source.messages ?? [])
        .filter(message => preservedSenders.has(message.from)))
      replayStateWrites(run, source.preservedStateWrites ?? [])
      run.stateTransaction = stateStore.status({ conversationId: run.conversationId, runId: run.runId })
      for (const [id, previous] of Object.entries(source.members ?? {})) {
        if (previous.status === 'complete' && id !== run.outputAgentId && !retryIntent.memberIds.includes(id)) {
          run.members[id] = {
            ...structuredClone(previous), status: 'complete', activations: 0, tokens: undefined, sessions: [],
            reusedFromRunId: source.runId
          }
          record(run, { type: 'activation.reused', agentId: id, data: {
            sourceRunId: source.runId, reason: 'completed agent preserved during explicit retry'
          } })
        }
      }
      pendingRetry.delete(String(requestId))
    }
    run.rawConversationContext = conversation
    run.sources = makeSources(run, conversation)
    run.eventTracker = createTriggerTracker({
      config: run.config, configRevision: run.configRevision, currentInput: run.currentInput,
      currentInputForAgent: agent => {
        const projected = buildAgentContext(agent, run.sources).sources.current_input
        return typeof projected === 'string' ? projected : typeof projected?.text === 'string' ? projected.text : ''
      },
      userTurnOrdinal: run.userTurnOrdinal,
      cooldownMarkers: committedTriggerCooldowns(loadRunRows(conversationId), run.activeInputMessageIds),
      bypassCooldownAgentIds: run.retryAgentIds ?? []
    })
    run.initialStateChanges = initialStateChanges(run)
    run.communication = createCommunication(run.config, {
      run,
      onRequest: async activation => run.scheduler?.requestActivation(activation),
      onMessage: async message => run.scheduler?.notifyMessage(message),
      onAwait: ({ from, requestId, promise }) => run.scheduler.waitForHandoff({ agentId: from, requestId, promise }),
      onResume: ({ requestId, releaseOnly }) => {
        if (releaseOnly) return run.scheduler?.releaseResumeReservation(requestId)
        run.scheduler?.settleResumeReservation(requestId, 'source', true)
        return run.scheduler?.settleResumeReservation(requestId, 'target', true)
      },
      onFailure: ({ request, error }) => run.scheduler?.stop(error, request.from),
      onCancelTarget: ({ requestId, error }) => run.scheduler?.cancelRequestActivation(requestId, error),
      onTrace: event => record(run, event),
      onChange: async () => { await run.scheduler?.notify(); persistRun(run) },
      onPersistRequests: () => persistRun(run),
      requestTraceRoot: traceRoot,
      reusableRequests: run.reusableHandoffs,
      initialMessages: run.messages
    })
    runs.set(run.runId, run)
    latestRunByConversation.set(run.conversationId, run.runId)
    activeRunBySession.set(String(sessionId), run.runId)
    bindingsBySession.set(String(sessionId), binding)
    bindingsByConversation.set(run.conversationId, binding)
    controllers.set(run.runId, new AbortController())
    retainedWorkLock = true
    bindingsByConversation.set(conversationId, binding)
    if (!retryIntent) writeManualSelection(binding.conversationId, [])
    setRunPhase(run, 'working')
    if (run.config.execution.budget) {
      run.budget = createRunBudget({
        runId: run.runId, limits: run.config.execution.budget,
        onExhaust: (error, details) => exhaustRunBudget(run, error, details)
      })
      if (run.budget.hasLimits) scheduleBudgetDeadline(run)
    }
    record(run, { type: 'run.started', data: { configRevision: run.configRevision, outputAgentId: run.outputAgentId, categories: [] } })
    persistRun(run)
    return run
    } finally {
      if (!retainedWorkLock) await ctx.eleckoiStoryState.endConversationWork(conversationWork)
    }
  }

  async function executeSchedule(run) {
    assertBudgetAvailable(run)
    if (run.schedulerPromise) return await run.schedulerPromise
    if (run.phase !== 'working' && run.phase !== 'composing') return
    const controller = controllers.get(run.runId)
    run.scheduler = createScheduler({
      config: run.config,
      manualAgentIds: run.manualAgentIds,
      forceAgentIds: run.retryAgentIds ?? [],
      skipAgentIds: Object.entries(run.members).filter(([id, member]) => member.status === 'complete' && id !== run.outputAgentId).map(([id]) => id),
      evaluateCondition,
      readState: agentId => conditionState(run, agentById(run.config, agentId), stateStore),
      signal: controller?.signal,
      triggerTracker: run.eventTracker,
      initialStateChanges: run.initialStateChanges,
      canReceiveMessage: (agentId, message) => run.communication.messagesFor(agentId).some(item => item.id === message.id && item.sequence === message.sequence),
      onTriggerStarted: ({ matches }) => recordTriggerStarts(run, matches),
      onTrace: event => updateSchedulerTrace(run, event),
      onStop: async (error) => {
        if (run.budgetFailure) failRun(run, run.budgetFailure)
        else if (controller?.signal.aborted) cancelRunState(run, String(controller.signal.reason ?? error?.message ?? error))
        else {
          failRun(run, error)
          controller?.abort(error?.message ?? 'A required RP Team agent failed')
        }
        interruptChildren(run)
      },
      onActivate: activation => activateAgent(run, activation),
      onActivationTerminal: async ({ agent, activation, status, error }) => {
        if (activation.requestId) {
          if (status === 'complete') {
            await run.communication.completeTarget({
              requestId: activation.requestId, targetExecutionId: activation.executionId,
              result: activation.terminalResult
            })
          } else {
            await run.communication.failTarget({
              requestId: activation.requestId, targetExecutionId: activation.executionId,
              error, targetComplete: true
            })
          }
        }
        await run.communication.activationFinished({
          agentId: agent.id, executionId: activation.executionId ?? `${run.runId}:${agent.id}:${activation.activationNo}`,
          status, error, requestId: activation.requestId
        })
      }
    })
    run.schedulerPromise = run.scheduler.run().then(async status => {
      assertBudgetAvailable(run)
      if (!run.publication) throw teamError('RP_TEAM_PUBLICATION_REQUIRED', 'Configured output agent completed without staging a user response')
      for (const [id, state] of Object.entries(status.agents)) run.members[id].status = state.status
      persistRun(run)
      return status
    }).catch(error => {
      if (run.budgetFailure) failRun(run, run.budgetFailure)
      else if (controller?.signal.aborted) cancelRunState(run, String(controller.signal.reason ?? error.message))
      else failRun(run, error)
      interruptChildren(run)
      persistRun(run)
      throw error
    })
    persistRun(run)
    return await run.schedulerPromise
  }

  function captureStateBefore(run, namespace, path) {
    return (run.eventTracker?.stateWatchTargets(namespace, path) ?? []).flatMap(target => {
      const agent = agentById(run.config, target.agentId)
      const access = describeStateToolAccess(agent, [{ namespace: target.namespace, path: target.path }])[0]
      if (!access?.read) return []
      const result = stateStore.read({
        conversationId: run.conversationId, runId: run.runId, agentId: target.agentId,
        namespace: target.namespace, path: target.path
      })
      return [{ ...target, before: stateValue(result.value) }]
    })
  }

  async function notifyStateChanged(run, snapshots = []) {
    const stateChanges = snapshots.map(snapshot => {
      const result = stateStore.read({
        conversationId: run.conversationId, runId: run.runId, agentId: snapshot.agentId,
        namespace: snapshot.namespace, path: snapshot.path
      })
      return { ...snapshot, after: stateValue(result.value) }
    })
    await run.scheduler?.notify({ stateChanges })
  }

  function initialStateChanges(run) {
    const targets = run.eventTracker?.stateWatchTargets() ?? []
    if (!targets.length) return []

    const storedRuns = stateStore.readConversation(run.conversationId).runs
    const selected = latestCommittedStateCheckpoint(
      loadRunRows(run.conversationId), run.activeInputMessageIds, storedRuns
    )
    const checkpoint = selected ? {
      config: selected.transaction.config,
      state: stateStore.snapshot({ conversationId: run.conversationId, runId: selected.runId })
    } : undefined
    const currentValues = new Map()
    for (const target of targets) {
      const agent = agentById(run.config, target.agentId)
      const access = describeStateToolAccess(agent, [{ namespace: target.namespace, path: target.path }])[0]
      if (!access?.read) continue
      const current = stateStore.read({
        conversationId: run.conversationId, runId: run.runId, agentId: target.agentId,
        namespace: target.namespace, path: target.path
      })
      currentValues.set(target.triggerId, stateValue(current.value))
    }
    return stateChangesFromCheckpoint({
      targets, checkpoint, currentValues,
      project: (target, value) => projectStateValueForAgent(
        agentById(run.config, target.agentId), target.namespace, target.path, value
      )
    })
  }

  function recordTriggerStarts(run, matches) {
    const markers = run.eventTracker.markStarted(matches, {
      branchId: run.branchId, inputMessageId: run.inputMessageId, runId: run.runId
    })
    if (!markers.length) return
    run.triggerStarts.push(...markers)
    persistRun(run)
  }

  function assertBudgetAvailable(run) {
    const failure = run.budget?.checkElapsed() ?? run.budgetFailure
    if (failure || run.budgetFailure) throw run.budgetFailure ?? failure
  }

  function scheduleBudgetDeadline(run) {
    const deadline = run.budget.elapsedDeadline
    if (deadline === undefined) return
    const check = () => {
      if (run.budgetFailure || run.budget?.failure) return
      if (run.budget.checkElapsed()) return
      const remaining = Math.max(1, deadline - Date.now())
      run.budgetTimer = setTimeout(check, Math.min(remaining, 2_147_483_647))
      run.budgetTimer?.unref?.()
    }
    const remaining = Math.max(1, deadline - Date.now())
    run.budgetTimer = setTimeout(check, Math.min(remaining, 2_147_483_647))
    run.budgetTimer?.unref?.()
  }

  function exhaustRunBudget(run, error, details) {
    if (run.budgetFailure) return
    const wasAwaitingCommit = run.phase === 'awaiting_commit'
    run.budgetFailure = error
    run.budgetFailureDetails = { ...details }
    failRun(run, error)
    record(run, { type: 'activation.blocked', data: {
      reason: `budget:${details.kind}`, limit: details.limit
    } })
    controllers.get(run.runId)?.abort(error)
    interruptChildren(run)
    persistRun(run)
    void drainBudgetRun(run)
    if (wasAwaitingCommit) {
      const root = ctx.agents.get(run.rootSessionId)
      void Promise.resolve(root?.cancel({ kind: 'user' })).catch(() => {})
    }
  }

  function drainBudgetRun(run) {
    if (!run.budgetDrainPromise) {
      run.budgetDrainPromise = (async () => {
        await run.communication?.cancelAll(run.budgetFailure)
        interruptChildren(run)
        if (run.schedulerPromise) await Promise.allSettled([run.schedulerPromise])
        await drainContinuableChildren(run)
      })().catch(error => {
        run.budgetDrainError = String(error?.message ?? error)
        persistRun(run)
      })
    }
    return run.budgetDrainPromise
  }

  function closeRunBudget(run) {
    if (run.budgetTimer !== undefined) clearTimeout(run.budgetTimer)
    run.budgetTimer = undefined
    if (run.budget) {
      run.budgetSnapshot = run.budget.snapshot()
      run.budget.close()
    }
  }

  function guardTeamModelRequest(options, next) {
    const sessionId = String(options?.sessionId ?? '')
    if (!sessionId) return next()
    const child = childBindings.get(sessionId)
    const runId = activeRunBySession.get(sessionId) ?? child?.runId
      ?? [...runs.values()].find(candidate => candidate.sessionOwners?.has(sessionId))?.runId
    const run = runId ? runs.get(String(runId)) : undefined
    if (!run) return next()
    assertBudgetedRunDispatchable(run, controllers.get(run.runId)?.signal)
    if (!run.budget?.hasLimits || !['working', 'composing', 'publishing'].includes(run.phase)) return next()
    const origin = requestOrigin(options)
    const existing = origin && budgetedRequestOrigins.get(origin)
    if (existing?.runId === run.runId) {
      record(run, { type: 'budget.request', data: {
        sessionId,
        ...(typeof options.provider === 'string' ? { provider: options.provider } : {}),
        ...(typeof options.model === 'string' ? { model: options.model } : {}),
        ...(typeof options.purpose === 'string' ? { purpose: options.purpose } : {}),
        ...(typeof options.requestId === 'string' ? { requestId: options.requestId } : {}),
        ...(Number.isSafeInteger(options.turn) ? { turn: options.turn } : {}),
        ...(Number.isSafeInteger(options.step) ? { step: options.step } : {}),
        stage: 'rerouted', invocationId: existing.invocationId
      } })
      return next()
    }
    if (!isBudgetedTeamRequest(run, options, TEAM_DELIVERY_PROVIDER)) return next()
    const requestDetails = {
      sessionId,
      ...(typeof options.provider === 'string' ? { provider: options.provider } : {}),
      ...(typeof options.model === 'string' ? { model: options.model } : {}),
      ...(typeof options.purpose === 'string' ? { purpose: options.purpose } : {}),
      ...(typeof options.requestId === 'string' ? { requestId: options.requestId } : {}),
      ...(Number.isSafeInteger(options.turn) ? { turn: options.turn } : {}),
      ...(Number.isSafeInteger(options.step) ? { step: options.step } : {})
    }
    record(run, { type: 'budget.request', data: { ...requestDetails, stage: 'before_reserve' } })
    const reservation = run.budget.reserve({
      requestId: options.requestId, sessionId, purpose: options.purpose
    })
    record(run, { type: 'budget.request', data: {
      ...requestDetails, stage: reservation.allowed ? 'reserved' : 'rejected',
      ...(reservation.invocationId ? { invocationId: reservation.invocationId } : {}),
      ...(Number.isSafeInteger(reservation.requestCount) ? { requestCount: reservation.requestCount } : {}),
      ...(reservation.error?.code ? { errorCode: reservation.error.code } : {})
    } })
    if (!reservation.allowed) { persistRun(run); throw reservation.error }
    budgetedRequestOrigins.set(origin ?? options, { runId: run.runId, invocationId: reservation.invocationId })
    const releaseOrigin = () => {
      const current = budgetedRequestOrigins.get(origin ?? options)
      if (current?.runId === run.runId && current.invocationId === reservation.invocationId) {
        budgetedRequestOrigins.delete(origin ?? options)
      }
    }
    record(run, { type: 'budget.request', data: { ...requestDetails, stage: 'before_next', invocationId: reservation.invocationId } })
    persistRun(run)
    let source
    try { source = next() }
    catch (error) {
      record(run, { type: 'budget.request', data: {
        ...requestDetails, stage: 'next_threw', invocationId: reservation.invocationId
      } })
      const cancelled = controllers.get(run.runId)?.signal.aborted === true
      run.budget.finish(reservation.invocationId, { cancelled })
      releaseOrigin()
      persistRun(run)
      throw run.budgetFailure ?? error
    }
    record(run, { type: 'budget.request', data: { ...requestDetails, stage: 'next_returned', invocationId: reservation.invocationId } })
    persistRun(run)
    return (async function* () {
      let completed = false
      let settled = false
      let observedChunk = false
      const finish = cancelled => {
        if (settled) return run.budget.failure
        settled = true
        const error = run.budget.finish(reservation.invocationId, { cancelled })
        releaseOrigin()
        run.budgetSnapshot = run.budget.snapshot()
        record(run, { type: 'budget.request', data: {
          ...requestDetails, stage: 'finished', invocationId: reservation.invocationId,
          cancelled, ...(error?.code ? { errorCode: error.code } : {})
        } })
        persistRun(run)
        return error
      }
      try {
        for await (const chunk of await source) {
          if (!observedChunk) {
            observedChunk = true
            record(run, { type: 'budget.request', data: { ...requestDetails, stage: 'first_chunk', invocationId: reservation.invocationId } })
            persistRun(run)
          }
          if (chunk?.type === 'usage') {
            const usage = actualTokenUsage({ data: { chunk } })
            if (usage) run.budget.reportUsage(reservation.invocationId, usage)
            run.budgetSnapshot = run.budget.snapshot()
            persistRun(run)
            if (run.budgetFailure) throw run.budgetFailure
          }
          if (chunk?.type === 'finish') {
            const error = finish(controllers.get(run.runId)?.signal.aborted === true || chunk.reason?.kind === 'aborted')
            if (run.budgetFailure || error) throw run.budgetFailure ?? error
          }
          yield chunk
        }
        completed = true
      } catch (error) {
        finish(controllers.get(run.runId)?.signal.aborted === true || Boolean(run.budgetFailure) || !completed)
        throw run.budgetFailure ?? error
      } finally {
        if (!settled) finish(controllers.get(run.runId)?.signal.aborted === true || Boolean(run.budgetFailure) || !completed)
      }
    })()
  }

  function stateValue(value) {
    return value === undefined ? { known: true, present: false } : { known: true, present: true, value: structuredClone(value) }
  }

  async function deliverScheduledRun(options) {
    const runId = activeRunBySession.get(String(options.sessionId))
    const run = runId ? runs.get(runId) : undefined
    if (!run || run.phase !== 'working') throw teamError('RP_TEAM_RUN_NOT_ACTIVE', 'No active Team run owns this local delivery request')
    run.rootSignal = options.signal
    if (!run.deliveryPromise) {
      const signal = options.signal
      const controller = controllers.get(run.runId)
      let cancellationDrain
      const cancelScheduledWork = () => {
        void run.communication?.cancelAll(signal?.reason ?? 'Root Session cancelled')
        if (!controller?.signal.aborted) controller?.abort(signal?.reason ?? 'Root Session cancelled')
        interruptChildren(run)
      }
      const drainCancelledChildren = () => cancellationDrain ??= (async () => {
        if (run.schedulerPromise) await Promise.allSettled([run.schedulerPromise])
        interruptChildren(run)
        await drainContinuableChildren(run)
      })()
      const onAbort = () => cancelScheduledWork()
      if (signal?.aborted) cancelScheduledWork()
      else signal?.addEventListener('abort', onAbort, { once: true })

      run.deliveryPromise = (async () => {
      try {
        assertBudgetAvailable(run)
        if (signal?.aborted) throw teamError('RP_TEAM_CANCELLED', String(signal.reason?.message ?? signal.reason ?? 'Root Session cancelled'))
        await executeSchedule(run)
        assertBudgetAvailable(run)
        if (!run.publication) throw teamError('RP_TEAM_PUBLICATION_REQUIRED', 'Configured output agent completed without staging a user response')
        await finalizePublication(run)
        assertBudgetAvailable(run)
        record(run, { type: 'publication.delivered', agentId: run.outputAgentId, data: {
          bodyCharacters: run.publication.body.length, sessionId: run.rootSessionId, turn: run.turn
        } })
        persistRun(run)
        return run.publication.body
      } catch (error) {
        const outcome = run.budgetFailure ? 'failed' : run.phase === 'cancelled' || signal?.aborted ? 'cancelled' : 'failed'
        if (run.budgetFailure) await drainBudgetRun(run)
        else if (signal?.aborted) {
          cancelScheduledWork()
          await drainCancelledChildren()
        }
        if (await settleFailedRun(run, outcome, error) && !run.budgetFailure) return run.publication?.body
        throw error
      } finally {
        signal?.removeEventListener('abort', onAbort)
        if (run.budgetFailure) await drainBudgetRun(run)
        else if (signal?.aborted) {
          cancelScheduledWork()
          await drainCancelledChildren()
        }
      }
      })()
    }
    return await run.deliveryPromise
  }

  async function activateAgent(run, { agent, activation, activationNo, signal }) {
    if (signal?.aborted) throw teamError('RP_TEAM_CANCELLED', String(signal.reason ?? 'Run cancelled'))
    const root = ctx.agents.get(run.rootSessionId)
    if (!root) throw teamError('RP_TEAM_ROOT_NOT_READY', 'Root DSH Session is not registered before scheduling')
    // The root request is temporarily routed through rp-team-local. Member models
    // inherit the frozen product model captured before that per-turn override.
    const route = await resolveAgentModel(agent, run.modelSnapshot, ctx.llm)
    const presetId = await resolveAgentPreset({
      agent, parentPresetId: run.destinationSnapshot.mountedPresetId, model: route, llm: ctx.llm,
      agentPresets: ctx.agentPresets, parseYaml, cache: registeredPresets
    })
    const allowedGroups = allowedGroupsForAgent(agent, run.rootAvailableGroups, run.productDisabledGroups)
    const activationKey = fingerprint(`${run.runId}\u0000${agent.id}`).slice(0, 24)
    const marker = `rp-agent-team-activation:${activationKey}:${activationNo}`
    const childData = createChildContextData({ run, agent, activationNo, stateStore })
    run.pendingChildren.set(marker, {
      marker, agentId: agent.id, activationNo, activation, route, presetId,
      activationState: childData.activationState,
      activationVersions: childData.activationVersions,
      rootGroups: run.rootAvailableGroups, allowedGroups, ...childData
    })
    const waiter = deferred()
    // A native child may finish while spawnTeammate is still resolving.
    void waiter.promise.catch(() => {})
    run.pendingChildren.get(marker).waiter = waiter
    const prompt = childPrompt(agent, run, childData.agentContext, activationNo, run.pendingChildren)
    childData.projected.currentPromptText = prompt[0].text
    writeJsonAtomic(childData.contextFile, childData.projected)
    for (const attachment of childData.attachments) prompt.push(attachment)
    record(run, { type: 'context.selected', agentId: agent.id, data: { categories: childData.agentContext.categories } })
    persistRun(run)
    try {
      const created = await ctx.agentTeams.spawnTeammate(root, {
        name: `rp-${activationKey}-${activationNo}`,
        description: `${marker} | ${agent.description || agent.name}`,
        prompt,
        context: 'fresh',
        provider: 'spawn',
        signal
      })
      const childSessionId = String(created.member.id)
      bindPendingChild(run, marker, childSessionId, created.member.name)
      const result = await waitForActivation(waiter, signal)
      if (result?.error) throw result.error
      const executionId = run.pendingChildren.get(marker)?.executionId
      activation.executionId = executionId
      if (activation.requestId && run.communication.getRequest(activation.requestId)?.mode !== 'notify') {
        activation.terminalResult = handoffTerminalResult(run, agent.id, executionId,
          activation.requestId, ctx.agents.get(childSessionId)?.session, result)
      }
      await stageNativeBranchChanges(run, childBindings.get(childSessionId))
      const member = run.members[agent.id]
      member.status = 'complete'
      persistRun(run)
    } catch (error) {
      const member = run.members[agent.id]
      member.error = String(error?.message ?? error)
      if (signal?.aborted) member.status = 'cancelled'
      else member.status = 'failed'
      throw error
    } finally {
      run.pendingChildren.delete(marker)
      const binding = [...run.sessionBindings.entries()].find(([, value]) => value.agentId === agent.id && value.activation === activationNo)
      if (binding) {
        const sessionId = binding[0]
        childBindings.delete(sessionId)
        unbindAgentSession(run, sessionId)
      }
      persistRun(run)
    }
  }

  async function waitForActivation(waiter, signal) {
    if (!signal) return await waiter.promise
    if (signal.aborted) throw teamError('RP_TEAM_CANCELLED', String(signal.reason ?? 'Run cancelled'))
    let onAbort
    const aborted = new Promise((resolve, reject) => {
      onAbort = () => reject(teamError('RP_TEAM_CANCELLED', String(signal.reason ?? 'Run cancelled')))
      signal.addEventListener('abort', onAbort, { once: true })
    })
    try {
      return await Promise.race([waiter.promise, aborted])
    } finally {
      signal.removeEventListener('abort', onAbort)
    }
  }

  function bindPendingChild(run, marker, sessionId, name) {
    const pending = run.pendingChildren.get(marker)
    if (!pending) return false
    const session = String(sessionId)
    if (run.sessionBindings.has(session)) return true
    bindAgentSession(run, pending.agentId, session, pending.activationNo)
    const execution = registerExecutionSession(run, { agentId: pending.agentId, activation: pending.activationNo,
      sessionId: session, parentSessionId: run.rootSessionId, depth: pending.activation.depth })
    pending.executionId = execution.executionId
    pending.activation.executionId = execution.executionId
    if (pending.activation.requestId) {
      void run.communication?.bindTargetExecution(pending.activation.requestId, execution.executionId)
        .catch(error => run.communication?.failTarget({ requestId: pending.activation.requestId,
          targetExecutionId: execution.executionId, error, targetComplete: true }))
    }
    pending.sessionId = session
    const binding = {
      runId: run.runId, agentId: pending.agentId, activation: pending.activationNo,
      executionId: execution.executionId, depth: pending.activation.depth,
      sessionId: session, marker, name, route: structuredClone(pending.route)
    }
    if (!run.childSessionIds.includes(session)) run.childSessionIds.push(session)
    childBindings.set(session, binding)
    pending.waiter?.bind?.(session)
    run.activationBases.set(session, {
      state: structuredClone(pending.activationState),
      versions: structuredClone(pending.activationVersions),
      world: {
        variables: structuredClone(readOptionalJson(pending.variableStateFile, { state: {} }).state ?? {}),
        settings: bridgeSettingFiles(readOptionalJson(pending.settingStateFile, { library: {} }).library)
      }
    })
    persistRun(run)
    return true
  }

  function onSessionEvent(session, event) {
    if (disposed || !event || typeof event.type !== 'string') return
    const sessionId = String(session?.id ?? session?.sessionId ?? '')
    const rootRunId = activeRunBySession.get(sessionId)
    const rootRun = rootRunId ? runs.get(rootRunId) : undefined
    if (rootRun && sessionId === rootRun.rootSessionId && event.type === 'request/header'
      && event.data?.header?.config?.provider === TEAM_DELIVERY_PROVIDER
      && event.data?.header?.config?.model === TEAM_DELIVERY_MODEL) {
      rootRun.localDeliveryRequestSeq = event.seq
      persistRun(rootRun)
      const callback = ctx.eleckoiRuntimeExtensions?.recordLocalDelivery
      if (typeof callback !== 'function') {
        rootRun.localDeliveryMarkerError = teamError('RP_TEAM_LOCAL_ROUTE_MARKER_UNAVAILABLE', 'Host cannot durably mark the internal Team delivery route')
        rootRun.localDeliveryMarkerPromise = Promise.reject(rootRun.localDeliveryMarkerError)
      } else {
        rootRun.localDeliveryMarkerPromise = Promise.resolve(callback({
          sessionId, requestSeq: event.seq, provider: event.data.header.config.provider, model: event.data.header.config.model
        })).catch(error => {
          rootRun.localDeliveryMarkerError = error instanceof Error ? error : new Error(String(error))
          throw rootRun.localDeliveryMarkerError
        })
      }
      void rootRun.localDeliveryMarkerPromise.catch(error => {
        rootRun.localDeliveryMarkerError = error instanceof Error ? error : new Error(String(error))
        persistRun(rootRun)
      })
      return
    }
    if (rootRun && sessionId === rootRun.rootSessionId && event.type === 'user/message') {
      if (!Number.isSafeInteger(rootRun.inputEventSeq) && Number.isSafeInteger(event.seq)
        && matchesRunInputMessage(rootRun, event.data)) {
        rootRun.inputEventSeq = event.seq
        persistRun(rootRun)
      }
      return
    }
    if (rootRun && sessionId === rootRun.rootSessionId && event.type === 'assistant/message'
      && Number(event.data?.turn) === rootRun.turn) {
      const message = event.data?.message
      const body = assistantText(message)
      if (message?.role === 'assistant' && body === rootRun.publication?.body) {
        rootRun.assistantSeq = Number.isSafeInteger(event.seq) ? event.seq : undefined
        rootRun.assistantMessageId = typeof message.id === 'string' ? message.id : undefined
        record(rootRun, { type: 'publication.assistant_appended', agentId: rootRun.outputAgentId, data: {
          sessionId, turn: rootRun.turn, assistantSeq: rootRun.assistantSeq,
          assistantMessageId: rootRun.assistantMessageId, bodyCharacters: body.length
        } })
        persistRun(rootRun)
      }
      return
    }
    if (rootRun && sessionId === rootRun.rootSessionId && event.type === 'turn/end'
      && Number(event.data?.turn) === rootRun.turn) {
      const failure = childTurnEndError(event.data ?? {})
      if (failure || rootRun.phase !== 'complete') {
        void settleFailedRun(rootRun,
          rootRun.budgetFailure ? 'failed' : event.data?.reason?.kind === 'aborted' || event.data?.outcome === 'cancelled' ? 'cancelled' : 'failed',
          failure ?? new Error('Root Session ended before the Team product commit completed'))
          .catch(error => { rootRun.settlementError = String(error?.message ?? error); persistRun(rootRun) })
      }
      return
    }
    let binding = childBindings.get(sessionId)
    if (!binding) {
      const rootId = String(session?.parentSessionId ?? session?.parentAgent?.session?.id ?? '')
      const run = runs.get(activeRunBySession.get(rootId))
      const row = run && nativeMember(rootId, sessionId)
      const pending = row && pendingChildFor(run, row.description)
      if (pending && bindPendingChild(run, pending.marker, sessionId, row.name)) binding = childBindings.get(sessionId)
    }
    const scheduledBinding = childBindings.get(sessionId)
    if (!binding) {
      for (const candidate of runs.values()) {
        const owner = candidate.sessionOwners?.get(sessionId)
        if (owner && activeRunBySession.get(candidate.rootSessionId) === candidate.runId) {
          binding = owner
          break
        }
      }
    }
    if (!binding) return
    const run = runs.get(binding.runId)
    if (!run || activeRunBySession.get(run.rootSessionId) !== run.runId) return
    const usage = actualTokenUsage(event)
    if (usage) captureUsage(run, binding, event, usage)
    if (event.type === 'turn/end') {
      finishExecutionSession(run, sessionId, event.data?.reason?.kind === 'aborted' ? 'cancelled' : childTurnEndError(event.data ?? {}) ? 'failed' : 'complete', event.seq)
      persistRun(run)
    }
    if (event.type === 'turn/end' && scheduledBinding) {
      const data = event.data ?? {}
      const failure = childTurnEndError(data)
      binding.pendingTurnEnd = true
      record(run, {
        type: failure ? 'activation.native_failed' : 'activation.native_completed', agentId: binding.agentId,
        data: { activation: binding.activation, seq: event.seq, ...(data.reason?.kind ? { reason: data.reason.kind } : {}) }
      })
      const pending = run.pendingChildren.get(binding.marker)
      if (failure) pending?.waiter?.reject?.(failure)
      else pending?.waiter?.resolve?.({ sessionId, seq: event.seq, turn: data.turn })
      persistRun(run)
    }
  }

  function captureUsage(run, binding, event, usage) {
    const data = event.data ?? {}
    const turn = data.turn ?? data.turnId ?? '?'
    const step = data.step ?? data.stepId ?? '?'
    const key = stableJson([binding.sessionId, turn, step])
    const previous = run.tokenSamples[key]
    if (stableJson(previous?.usage) === stableJson(usage)) return
    run.tokenSamples[key] = { sessionId: binding.sessionId, turn, step, usage: structuredClone(usage) }
    const member = run.members[binding.agentId]
    const memberSessions = new Set([
      ...member.sessions,
      ...[...(run.sessionOwners ?? new Map()).entries()]
        .filter(([, owner]) => owner.agentId === binding.agentId)
        .map(([sessionId]) => sessionId)
    ])
    member.tokens = sumTokenSamplesForSessions(run.tokenSamples, memberSessions)
    record(run, {
      type: 'model.usage', agentId: binding.agentId,
      data: { provider: member.model?.provider, model: member.model?.model, requestSequence: event.seq, ...usage }
    })
    persistRun(run)
  }

  function ownedChildSessions(rootSessionId, conversationId) {
    const ids = new Set()
    if (!conversationId) return ids
    for (const run of runs.values()) {
      if (run.rootSessionId === rootSessionId && run.conversationId === conversationId) {
        for (const childId of run.childSessionIds ?? []) ids.add(String(childId))
      }
    }
    for (const row of loadRunRows(conversationId)) {
      if (row.rootSessionId === rootSessionId) {
        for (const childId of row.childSessionIds ?? []) ids.add(String(childId))
      }
    }
    return ids
  }

  function updateSchedulerTrace(run, event) {
    const member = event.agentId ? run.members[event.agentId] : undefined
    if (member) {
      if (event.type === 'activation.queued') member.status = 'queued'
      if (event.type === 'activation.started') {
        member.status = 'running'
        member.activations = event.data.activation
        member.model = member.model ?? (agentById(run.config, event.agentId).modelRef === 'inherit'
          ? run.destinationSnapshot.subagentModel ?? run.destinationSnapshot.model
          : agentById(run.config, event.agentId).modelRef)
      }
      if (event.type === 'activation.skipped') member.status = 'skipped'
      if (event.type === 'activation.cancelled') member.status = 'cancelled'
      if (event.type === 'activation.completed') member.status = 'complete'
      if (event.type === 'activation.failed') {
        member.status = 'failed'
        member.error = event.data.error
      }
    }
    record(run, event)
  }

  async function stageNativeBranchChanges(run, binding) {
    if (!binding) return
    const pending = run.pendingChildren.get(binding.marker)
    if (!pending) return
    const member = agentById(run.config, binding.agentId)
    const nativeVars = readOptionalJson(pending.variableStateFile, {})
    const nativeSettings = readOptionalJson(pending.settingStateFile, {})
    const activationBase = run.activationBases.get(binding.sessionId)
    const beforeVariables = activationBase?.world?.variables ?? {}
    const afterVariables = nativeVars.state ?? {}
    const stateChanges = []
    if (canWriteNativeNamespace(member, 'variables')) {
      for (const change of diffLeaves(beforeVariables, afterVariables)) {
        stateChanges.push({ namespace: 'world', path: `/variables${change.path}`, removed: change.removed, value: change.value })
      }
    }
    const beforeSettings = activationBase?.world?.settings ?? {}
    const afterSettings = bridgeSettingFiles(nativeSettings.library)
    if (canWriteNativeNamespace(member, 'settings')) {
      for (const key of new Set([...Object.keys(beforeSettings), ...Object.keys(afterSettings)])) {
        if (beforeSettings[key] === afterSettings[key]) continue
        if (!Object.hasOwn(afterSettings, key)) throw teamError('RP_TEAM_STATE_DELETE_UNSUPPORTED', `Native setting deletion ${key} is not supported by this transaction`)
        stateChanges.push({ namespace: 'world', path: `/settings/${escapePointer(key)}`, value: afterSettings[key] })
      }
    }
    const beforeSnapshots = new Map()
    for (const change of stateChanges) {
      for (const snapshot of captureStateBefore(run, change.namespace, change.path)) {
        if (!beforeSnapshots.has(snapshot.triggerId)) beforeSnapshots.set(snapshot.triggerId, snapshot)
      }
    }
    for (const change of stateChanges) {
      if (change.removed) await stageStateRemoval(run, member, change.namespace, change.path, activationBase)
      else await stageStateChange(run, member, change.namespace, change.path, change.value, activationBase)
    }
    run.activationBases.delete(binding.sessionId)
    await notifyStateChanged(run, [...beforeSnapshots.values()])
  }

  async function stageStateChange(run, member, namespace, path, value, activationBase) {
    if (!member.outputAuthority.state) throw teamError('RP_TEAM_OUTPUT_FORBIDDEN', `Agent ${member.id} has no state-write authority`)
    const version = capturedVersion(activationBase, namespace, path)
    const before = observeStatePath(stateStore, run, namespace, path)
    stateStore.write({ conversationId: run.conversationId, runId: run.runId, agentId: member.id, namespace, path, value, expectedVersion: version })
    record(run, { type: 'state.operation', agentId: member.id, data: { namespace, path, operation: 'write', version: version + 1, ...before, after: value, valuesRecorded: true } })
  }

  async function stageStateRemoval(run, member, namespace, path, activationBase) {
    if (!member.outputAuthority.state) throw teamError('RP_TEAM_OUTPUT_FORBIDDEN', `Agent ${member.id} has no state-write authority`)
    const version = capturedVersion(activationBase, namespace, path)
    const before = observeStatePath(stateStore, run, namespace, path)
    stateStore.remove({ conversationId: run.conversationId, runId: run.runId, agentId: member.id, namespace, path, expectedVersion: version })
    record(run, { type: 'state.operation', agentId: member.id, data: { namespace, path, operation: 'remove', version: version + 1, ...before, afterMissing: true, valuesRecorded: true } })
  }

  async function cancelFromClient(conversationId, runId) {
    const run = requireConversationRun(conversationId, runId)
    if (run.phase === 'awaiting_commit') {
      interruptChildren(run)
      ctx.agents.get(run.rootSessionId)?.cancel({ kind: 'user' })
      await settlePendingReceipt(run)
      persistRun(run)
      return runStatus(run)
    }
    const reason = new Error('Cancelled from RP Team controls')
    controllers.get(run.runId)?.abort(reason.message)
    await run.communication?.cancelAll(reason)
    interruptChildren(run)
    const root = ctx.agents.get(run.rootSessionId)
    root?.cancel({ kind: 'user' })
    const pending = [run.deliveryPromise, run.schedulerPromise].filter(Boolean)
    if (pending.length) await Promise.allSettled(pending)
    await drainContinuableChildren(run)
    if (run.phase === 'awaiting_commit') await settlePendingReceipt(run)
    else if (!['failed', 'cancelled', 'complete'].includes(run.phase)) await settleFailedRun(run, 'cancelled', reason)
    persistRun(run)
    return runStatus(run)
  }

  function interruptChildren(run) {
    const root = ctx.agents.get(run.rootSessionId)
    if (!root) return
    for (const binding of childBindings.values()) {
      if (binding.runId !== run.runId) continue
      try { ctx.agentTeams.interrupt(root, binding.name) } catch { /* A native turn may already have ended. */ }
    }
  }

  async function drainContinuableChildren(run) {
    const root = ctx.agents.get(run.rootSessionId)
    if (root) {
      const ids = [...new Set(run.childSessionIds ?? [])]
      if (ids.length && typeof ctx.subagents?.drainContinuableChildren === 'function') {
        await ctx.subagents.drainContinuableChildren(root, ids)
      }
    }
  }

  async function settlePendingReceipt(run) {
    if (['committed', 'failed', 'cancelled'].includes(run.productReceiptOutcome)) {
      return { outcome: run.productReceiptOutcome, productMessageId: run.productMessageId }
    }
    if (run.phase === 'complete') return { outcome: 'committed', productMessageId: run.productMessageId }
    const receipt = await getProductCommitStatus({ conversationId: run.conversationId, runId: run.runId })
    return await settleRunFromReceipt(run, receipt)
  }

  function registerTools(agentCtx, member, run, sessionId) {
    const args = {
      agentCtx, defineTool, member, run, stateStore,
      assertActiveCaller: agent => assertActiveCaller(agent, run, member, sessionId),
      assertInternalAuthority: () => assertInternalAuthority(member),
      requestDepth: agent => childBindings.get(String(agent?.session?.id))?.depth ?? 0,
      requestExecutionId: () => run.executionSessions.find(row => row.sessionId === String(sessionId))?.executionId,
      record: event => record(run, event), persistRun: () => persistRun(run),
      saveDraft: args => saveDraft(run, member, args),
      submitInternal: (args, exec) => submitInternal(run, member, args, exec),
      publish: (args, exec) => publishFromAgent(run, member, args, exec),
      captureStateBefore: run.captureStateBefore,
      notifyStateChanged: run.notifyStateChanged
    }
    const disposers = [registerTeamTools(args)]
    if (run.config.memory?.collections?.length) disposers.push(registerMemoryTools(args))
    return () => { for (const dispose of disposers.reverse()) dispose?.() }
  }

  async function saveDraft(run, member, args) {
    if (!member.outputAuthority.draft) throw teamError('RP_TEAM_OUTPUT_FORBIDDEN', `Agent ${member.id} has no draft authority`)
    const visibleTo = [...new Set(args.visibleTo ?? [])].filter(recipientId => recipientId !== member.id)
    for (const recipientId of visibleTo) {
      const recipient = agentById(run.config, recipientId)
      if (!allows(member.communication.sendTo, recipientId) || !allows(recipient.communication.receiveFrom, member.id)) {
        throw teamError('RP_TEAM_MESSAGE_NOT_ALLOWED', `Draft sharing from ${member.id} to ${recipientId} is not authorized`)
      }
    }
    const prior = args.draftId && run.drafts.find(item => item.draftId === args.draftId && item.agentId === member.id)
    const draft = {
      draftId: prior?.draftId ?? String(args.draftId || randomUUID()), agentId: member.id,
      text: String(args.text), visibleTo, revision: (prior?.revision ?? 0) + 1,
      createdAt: prior?.createdAt ?? new Date().toISOString(), updatedAt: new Date().toISOString()
    }
    if (prior) Object.assign(prior, draft)
    else run.drafts.push(draft)
    record(run, { type: prior ? 'draft.updated' : 'draft.created', agentId: member.id, data: { draftId: draft.draftId, status: 'saved', characters: draft.text.length, revision: draft.revision } })
    await run.scheduler?.notify()
    persistRun(run)
    return { draftId: draft.draftId, revision: draft.revision, visibleTo }
  }

  async function submitInternal(run, member, args, exec) {
    if (!member.outputAuthority.internal) throw teamError('RP_TEAM_OUTPUT_FORBIDDEN', `Agent ${member.id} has no internal-result authority`)
    const sessionId = String(exec?.agent?.session?.id ?? '')
    const executionId = run.executionSessions.find(row => row.sessionId === sessionId)?.executionId
    const item = { agentId: member.id, executionId, summary: args.summary,
      data: args.data === undefined ? undefined : structuredClone(args.data), at: new Date().toISOString() }
    run.internalResults.push(item)
    run.members[member.id].result = { summary: item.summary }
    record(run, { type: 'internal.submitted', agentId: member.id, data: { status: 'submitted' } })
    persistRun(run)
    return { status: 'accepted' }
  }

  async function publishFromAgent(run, member, args, exec) {
    assertBudgetAvailable(run)
    if (member.id !== run.outputAgentId || !member.outputAuthority.user) throw teamError('RP_TEAM_OUTPUT_FORBIDDEN', 'Only the configured user-output agent may publish')
    const sessionId = String(exec?.agent?.session?.id ?? '')
    const activation = run.sessionBindings.get(sessionId)?.activation
    if (run.publication) {
      if (run.publicationFinalized) throw teamError('RP_TEAM_ALREADY_PUBLISHED', 'The final publication is already locked')
      if (run.publication.agentId !== member.id) throw teamError('RP_TEAM_OUTPUT_FORBIDDEN', 'Only the configured user-output agent may replace the publication')
      if (run.publication.activation === activation) throw teamError('RP_TEAM_ALREADY_PUBLISHED', 'An activation may publish only once')
      run.publication = null
    }
    const selectedDraftIds = [...new Set(args.selectedDraftIds ?? [])]
    const projectedDrafts = buildAgentContext(member, {}, { drafts: run.drafts }).sources.drafts
    const visibleDrafts = new Map((Array.isArray(projectedDrafts) ? projectedDrafts : [])
      .filter(draft => draft && typeof draft === 'object' && typeof draft.draftId === 'string')
      .map(draft => [draft.draftId, draft]))
    for (const id of selectedDraftIds) {
      const ownedDraft = run.drafts.find(item => item.draftId === id && item.agentId === member.id)
      const draft = ownedDraft ?? visibleDrafts.get(id)
      if (!draft || !draftVisibleTo(member.id, draft)) {
        throw teamError('RP_TEAM_DRAFT_NOT_VISIBLE', `Draft ${id} is not available to output agent ${member.id}`)
      }
    }
    const publication = stagePublication(run, member.id, { body: args.body, selectedDraftIds, operationCount: 0 })
    run.publication.activation = activation
    record(run, { type: 'publication.candidate', agentId: member.id, data: { status: 'candidate', activation, bodyCharacters: publication.body.length } })
    persistRun(run)
    exec?.concludeTurn?.()
    return { status: 'staged', runId: run.runId, publicationId: `${run.runId}:publication` }
  }

  async function finalizePublication(run) {
    assertBudgetAvailable(run)
    if (!run.publication) return
    run.publicationFinalized = true
    const transaction = stateStore.stage({ conversationId: run.conversationId, runId: run.runId })
    run.stateTransaction = transaction
    const operations = storyOperations(transaction.writes, run.baseState)
    try {
      await ctx.eleckoiStoryState.prepare(run.worldSnapshot, operations, {
        conversationId: run.conversationId, runId: run.runId, baseHash: run.baseHash
      })
      assertBudgetAvailable(run)
      await ctx.eleckoiStoryState.stageProductCommit({
        conversationId: run.conversationId, runId: run.runId, sessionId: run.rootSessionId,
        turn: run.turn, baseHash: run.baseHash, operations, body: run.publication.body
      })
      run.productCommitStaged = true
      assertBudgetAvailable(run)
      run.publication.operationCount = operations.length
      completeRun(run)
      record(run, { type: 'publication.staged', agentId: run.outputAgentId, data: {
        status: 'staged', selectedProposalCount: run.publication.selectedDraftIds.length,
        operationCount: operations.length, bodyCharacters: run.publication.body.length
      } })
      record(run, { type: 'publication.awaiting_commit', agentId: run.outputAgentId, data: { status: 'awaiting_commit' } })
      persistRun(run)
    } catch (error) {
      rollbackState(run, error?.message ?? error)
      throw error
    }
  }

  async function releaseConversationWork(run) {
    if (!run.conversationWork || run.workLockReleased) return
    await ctx.eleckoiStoryState.endConversationWork(run.conversationWork)
    run.workLockReleased = true
  }

  async function commitProductState(run, receipt) {
    run.triggerCooldownMarkers = structuredClone(run.triggerStarts ?? [])
    run.stateTransaction = stateStore.commit({
      conversationId: run.conversationId, runId: run.runId,
      receipt: { outcome: 'committed', productMessageId: receipt.productMessageId }
    })
    commitRunState(run, 'committed', receipt.productMessageId)
    run.productReceiptOutcome = 'committed'
    run.productMessageId = receipt.productMessageId
    run.assistantSeq = receipt.assistantSeq
    run.assistantMessageId = receipt.assistantMessageId
    record(run, { type: 'publication.committed', agentId: run.outputAgentId, data: {
      status: 'committed', productMessageId: receipt.productMessageId,
      assistantSeq: receipt.assistantSeq, assistantMessageId: receipt.assistantMessageId
    } })
    activeRunBySession.delete(run.rootSessionId)
    controllers.delete(run.runId)
    closeRunBudget(run)
    cleanRunData(run)
    persistRun(run)
    await releaseConversationWork(run)
  }

  async function settleRunFromReceipt(run, knownReceipt) {
    const receipt = knownReceipt ?? await getProductCommitStatus({ conversationId: run.conversationId, runId: run.runId })
    if (receipt.outcome === 'committed') {
      if (run.stateTransaction?.status !== 'committed') await commitProductState(run, receipt)
      return receipt
    }
    if (receipt.outcome === 'failed' || receipt.outcome === 'cancelled') {
      setReceiptFailure(run, receipt)
      rollbackState(run, run.failure)
      recordCommitFailure(run, receipt.outcome, new Error(run.failure))
      if (run.phase === 'awaiting_commit') commitRunState(run, receipt.outcome, receipt.productMessageId)
      else if (receipt.outcome === 'cancelled') cancelRunState(run, 'Product receipt: cancelled')
      else failRun(run, 'Product receipt: failed')
      run.productReceiptOutcome = receipt.outcome
      closeRunBudget(run)
      record(run, { type: 'publication.rolled_back', agentId: run.outputAgentId, data: {
        status: receipt.outcome, productMessageId: receipt.productMessageId, reason: run.failure,
        assistantSeq: run.assistantSeq, assistantMessageId: run.assistantMessageId
      } })
      activeRunBySession.delete(run.rootSessionId)
      controllers.delete(run.runId)
      cleanRunData(run)
      persistRun(run)
      await releaseConversationWork(run)
    } else if (run.productCommitStaged && (receipt.outcome === 'pending' || receipt.outcome === 'unknown')) {
      recordCommitFailure(run, receipt.outcome, new Error(run.failure ?? 'The product commit has not been confirmed'))
      persistRun(run)
    }
    return receipt
  }

  function setReceiptFailure(run, receipt) {
    if (receipt.reason !== undefined && receipt.reason !== null && String(receipt.reason).trim()) {
      run.failure = String(receipt.reason)
    } else {
      run.failure ||= `Product receipt: ${receipt.outcome}`
    }
    return run.failure
  }

  async function settleFailedRun(run, outcome, error) {
    if (run.productReceiptOutcome === 'committed') return true
    if (run.productReceiptOutcome === 'failed' || run.productReceiptOutcome === 'cancelled') return false
    if (outcome === 'cancelled') await run.communication?.cancelAll(error)
    if (!run.productCommitStaged) {
      run.failure = String(error?.message ?? error)
      if (outcome === 'cancelled') cancelRunState(run, run.failure)
      else failRun(run, run.failure)
      // No final body was returned to the official Session. Keep this failure
      // local; the Host has no product commit row to settle or recover.
      run.failure = String(error?.message ?? error)
      run.productReceiptOutcome = outcome
      rollbackState(run, run.failure)
      activeRunBySession.delete(run.rootSessionId)
      controllers.delete(run.runId)
      closeRunBudget(run)
      cleanRunData(run)
      persistRun(run)
      await releaseConversationWork(run)
      return false
    }
    let receipt
    try {
      receipt = await ctx.eleckoiStoryState.settleProductCommit({
        conversationId: run.conversationId, runId: run.runId, outcome
      })
    } catch (settleError) {
      receipt = await getProductCommitStatus({ conversationId: run.conversationId, runId: run.runId })
      if (receipt.outcome === 'committed') {
        await commitProductState(run, receipt)
        return true
      }
      if (run.productCommitStaged && ['pending', 'unknown'].includes(receipt.outcome)) {
        run.productReceiptOutcome = receipt.outcome
        recordCommitFailure(run, receipt.outcome, error)
        closeRunBudget(run)
        persistRun(run)
        return false
      }
      run.failure = String(error?.message ?? error)
      if (run.productCommitStaged) recordCommitFailure(run, receipt?.outcome ?? outcome, error)
      if (outcome === 'cancelled') cancelRunState(run, String(error?.message ?? error))
      else failRun(run, error)
      rollbackState(run, error?.message ?? error)
      run.productReceiptOutcome = receipt?.outcome
      activeRunBySession.delete(run.rootSessionId)
      controllers.delete(run.runId)
      closeRunBudget(run)
      cleanRunData(run)
      persistRun(run)
      await releaseConversationWork(run)
      throw new AggregateError([error, settleError], 'Team run failed and its product receipt could not be settled')
    }
    if (receipt?.outcome === 'committed') {
      await commitProductState(run, receipt)
      return true
    }
    if (run.productCommitStaged && ['pending', 'unknown'].includes(receipt?.outcome)) {
      run.productReceiptOutcome = receipt.outcome
      recordCommitFailure(run, receipt.outcome, error)
      closeRunBudget(run)
      persistRun(run)
      return false
    }
    run.productReceiptOutcome = receipt?.outcome ?? outcome
    run.failure = String(error?.message ?? error)
    if (run.productCommitStaged) recordCommitFailure(run, receipt?.outcome ?? outcome, error)
    if (receipt?.outcome === 'cancelled' || outcome === 'cancelled') cancelRunState(run, String(error?.message ?? error))
    else failRun(run, error)
    rollbackState(run, error?.message ?? error)
    if (run.productCommitStaged) record(run, { type: 'publication.rolled_back', agentId: run.outputAgentId, data: {
      status: receipt?.outcome ?? outcome, reason: run.failure,
      assistantSeq: run.assistantSeq, assistantMessageId: run.assistantMessageId
    } })
    activeRunBySession.delete(run.rootSessionId)
    controllers.delete(run.runId)
    closeRunBudget(run)
    persistRun(run)
    await releaseConversationWork(run)
    return false
  }

  function recordCommitFailure(run, status, error) {
    const reason = String(error?.message ?? error)
    run.failure = reason
    const key = `${status}\u0000${reason}`
    if (run.lastCommitFailureKey === key) return
    run.lastCommitFailureKey = key
    record(run, { type: 'publication.commit_failed', agentId: run.outputAgentId, data: {
      status, reason, sessionId: run.rootSessionId, turn: run.turn,
      assistantSeq: run.assistantSeq, assistantMessageId: run.assistantMessageId
    } })
  }

  function assertInternalAuthority(member) {
    if (!member.outputAuthority.internal) throw teamError('RP_TEAM_OUTPUT_FORBIDDEN', `Agent ${member.id} has no internal collaboration authority`)
  }

  function assertActiveCaller(agent, run, member, sessionId) {
    if (String(agent?.session?.id) !== String(sessionId)) throw teamError('RP_TEAM_CALLER_MISMATCH', 'Tool caller does not match its child Session')
    const binding = run.sessionBindings.get(String(sessionId))
    if (!binding || binding.agentId !== member.id || run.activeSessions.get(member.id) !== String(sessionId)) {
      throw teamError('RP_TEAM_CALLER_MISMATCH', 'Tool caller is not the active scheduled agent Session')
    }
    if (activeRunBySession.get(run.rootSessionId) !== run.runId || ['cancelled', 'failed', 'complete'].includes(run.phase)) {
      throw teamError('RP_TEAM_TERMINAL', 'This RP Team run no longer accepts tool calls')
    }
  }

  async function authorizePresetTools({ sessionId, snapshot, presetToolNames = [] }) {
    const id = String(sessionId)
    const runId = snapshot?.rpTeamRunId ?? childBindings.get(id)?.runId
    const run = runs.get(String(runId))
    const memberId = snapshot?.rpTeamAgentId ?? childBindings.get(id)?.agentId
    const member = run?.config.agents.find(item => item.id === memberId)
    if (!run || !member) return []
    const selected = allowedGroupsForAgent(member, run.rootAvailableGroups, run.productDisabledGroups)
    if (!selected.has(NATIVE_PRESET_TOOLS)) return []
    const presetId = snapshot?.mountedPresetId ?? member.presetId
    if (!presetId || !(await nativePresetIds()).has(presetId)) return []
    const declarations = await presetDeclarations(presetId)
    const names = new Set(declarations.filter(item => capabilityForDeclaration(item) === NATIVE_PRESET_TOOLS).map(item => item.name))
    return presetToolNames.filter(name => names.has(name))
  }

  async function getOptions(conversationId) {
    const saved = store.get(conversationId)
    const providers = []
    for (const provider of ctx.llm.listProviders()) {
      if (provider.id === TEAM_DELIVERY_PROVIDER) continue
      const models = await ctx.llm.listModels(provider.id)
      providers.push({ id: provider.id, name: provider.name, models: await Promise.all(models.map(async model => {
        const info = await ctx.llm.resolveModelInfo(provider.id, model.id)
        return {
          id: info.id, name: info.name,
          ...(info.description ? { description: info.description } : {}),
          ...(info.inputModalities ? { inputModalities: [...info.inputModalities] } : {}),
          reasoning: {
            efforts: (info.reasoning?.efforts ?? []).map(({ id, name, description }) => ({ id, name, ...(description ? { description } : {}) })),
            ...(info.reasoning?.defaultEffort ? { defaultEffort: info.reasoning.defaultEffort } : {})
          },
          parameters: { temperature: true, topP: true, maxTokens: true, reasoningEffort: Boolean(info.reasoning?.efforts?.length) },
          ...(info.context ? { context: { ...info.context } } : {})
        }
      })) })
    }
    const presets = (await ctx.agentPresets.list()).map(({ id, name, description, broken }) => ({ id, name: name || id, ...(description ? { description } : {}), ...(broken ? { broken } : {}) }))
    const groups = new Set([...CAPABILITIES.map(([id]) => id), ...toolGroups(ctx.tools.schemas?.() ?? [])])
    for (const preset of presets.filter(item => !item.broken)) for (const id of await groupsForPreset(preset.id)) groups.add(id)
    const capabilities = [...groups].map(id => ({
      id, label: capabilityLabel(id), groupId: id,
      enabledByDefault: false,
      requiresTrust: !MANAGED_CAPABILITIES.has(id)
    }))
    return { conversationId, revision: saved.revision, providers, presets, capabilities }
  }

  async function getStatus(conversationId) {
    const saved = store.get(conversationId)
    const binding = bindingsByConversation.get(String(conversationId)) ?? store.latestRuntimeBinding(conversationId)
    const run = latestRun(conversationId)
    if (run?.phase === 'awaiting_commit') {
      await settlePendingReceipt(run)
      persistRun(run)
    }
    const boundRevision = binding?.revision ?? binding?.boundConfigRevision ?? binding?.configRevision
    const bindingDto = binding ? {
      conversationId, rootSessionId: binding.rootSessionId, enabled: binding.enabled,
      configRevision: boundRevision, currentConfigRevision: binding.currentConfigRevision ?? saved.revision,
      stale: binding.stale ?? boundRevision !== saved.revision
    } : null
    return { conversationId, binding: bindingDto, run: run ? runStatus(run) : null, manualAgentIds: readManualSelection(conversationId) }
  }

  function isConversationBusy(conversationId) {
    const conversation = String(conversationId)
    if ([...runs.values()].some(run => run.conversationId === conversation
      && !['complete', 'failed', 'cancelled'].includes(run.phase))) return true
    if ([...pendingRetry.values()].some(intent => intent.conversationId === conversation)) return true
    return loadRunRows(conversation).some(row => row.status?.phase === 'awaiting_commit')
  }

  function getRunRecords(conversationId) {
    const conversation = String(conversationId)
    const records = new Map(loadRunRows(conversation).map(row => [String(row.status?.runId), row]))
    for (const run of runs.values()) {
      if (run.conversationId === conversation) records.set(run.runId, serializeActiveRun(run))
    }
    return [...records.values()].map(row => {
      const runId = String(row.status?.runId ?? '')
      const active = runs.get(runId)
      const handoffRequests = active
        ? structuredClone(active.handoffRequests ?? [])
        : interruptPersistedRequests(traceRoot, conversation, runId)
      return { ...structuredClone(row), handoffRequests }
    }).sort((left, right) => String(right.status?.startedAt).localeCompare(String(left.status?.startedAt)))
  }

  async function configuredGroups(snapshot, config) {
    const groups = new Set([...CAPABILITIES.map(([id]) => id), ...toolGroups(ctx.tools.schemas?.() ?? [])])
    const ids = new Set([snapshot?.mountedPresetId, ...config.agents.map(agent => agent.presetId)].filter(Boolean))
    const registered = await nativePresetIds()
    for (const id of ids) if (registered.has(id)) for (const group of await groupsForPreset(id, snapshot)) groups.add(group)
    return [...groups].filter(id => capabilityAvailableInSnapshot(id, snapshot))
  }

  async function groupsForPreset(presetId, snapshot) {
    if (presetId && !(await nativePresetIds()).has(presetId)) return []
    const declarations = presetId ? await presetDeclarations(presetId) : []
    return [...new Set(toolGroups(declarations))].filter(id => capabilityAvailableInSnapshot(id, snapshot))
  }

  async function presetDeclarations(presetId) {
    const lease = await ctx.agentPresets.acquireScope(presetId)
    try { return ctx.tools.schemas(lease.key) } finally { await lease[Symbol.asyncDispose]() }
  }

  async function nativePresetIds() { return new Set((await ctx.agentPresets.list()).map(({ id }) => id)) }

  async function importConfig({ conversationId, preset }) {
    const config = normalizeTeamConfig(parsePreset(preset))
    await validateAgentModelRoutes(config, ctx.llm)
    pruneManualSelection(conversationId, config)
    return { conversationId, config }
  }

  async function importHistoricalRun({ conversationId, run, stateBaselineBefore }) {
    await recoveryReady
    const row = normalizeHistoricalRun(conversationId, run)
    const existing = readRunRecord(conversationId, row.status.runId)
    if (existing) {
      if (!sameHistoricalRunIdentity(existing, row)) {
        throw teamError('RP_TEAM_IMPORT_CONFLICT', `Run ${row.status.runId} already exists with another Session mapping`)
      }
      stateStore.importCommittedBaseline({ conversationId, runId: row.status.runId, snapshot: stateBaselineBefore })
      return { imported: false, runId: row.status.runId, status: structuredClone(existing.status) }
    }
    stateStore.importCommittedBaseline({ conversationId, runId: row.status.runId, snapshot: stateBaselineBefore })
    writeJsonAtomic(runFile(conversationId, row.status.runId), row)
    latestRunByConversation.delete(String(conversationId))
    return { imported: true, runId: row.status.runId, status: structuredClone(row.status) }
  }

  function setManualAgents({ conversationId, agentIds }) {
    const saved = store.get(conversationId)
    const selected = [...new Set(agentIds ?? [])]
    for (const id of selected) {
      const agent = agentById(saved.config, id)
      if (!agent.triggers.some(trigger => trigger.type === 'manual')) throw teamError('RP_TEAM_MANUAL_AGENT_INVALID', `Agent ${id} does not have a manual trigger`)
    }
    writeManualSelection(conversationId, selected)
    return { conversationId, manualAgentIds: selected }
  }

  function stageRetry({ conversationId, runId, memberIds, requestId }) {
    const source = requireConversationRun(conversationId, runId)
    const hasDefinitiveReceipt = ['failed', 'cancelled'].includes(source.productReceiptOutcome)
    const failedBeforePublication = source.productCommitStaged !== true
      && !source.assistantSeq && !source.assistantMessageId && !source.productMessageId
    if (!['failed', 'cancelled'].includes(source.phase)
      || (!hasDefinitiveReceipt && !failedBeforePublication)
      || !Number.isInteger(source.inputEventSeq)) {
      throw teamError('RP_TEAM_RETRY_UNAVAILABLE', 'Retry requires a failed run with either a definitive product receipt or no staged body, plus its original user event')
    }
    if (typeof requestId !== 'string' || !requestId.trim()) throw teamError('RP_TEAM_INVALID_REQUEST', 'requestId is required for retry')
    const failed = Object.entries(source.members).filter(([, item]) => ['failed', 'cancelled'].includes(item.status)).map(([id]) => id)
    const selected = memberIds?.length ? [...new Set(memberIds)] : failed
    if (!selected.length || selected.some(id => !failed.includes(id))) throw teamError('RP_TEAM_RETRY_NOT_FAILED', 'Retry can target only failed or cancelled agents')
    const intent = {
      conversationId, sourceRunId: source.runId, requestId, targetEventSeq: source.inputEventSeq,
      memberIds: selected, configStoreRevision: source.configStoreRevision, baseHash: source.baseHash,
      contextFingerprint: source.contextFingerprint
    }
    if (pendingRetry.has(requestId)) throw teamError('RP_TEAM_RETRY_REQUEST_EXISTS', 'A retry intent already uses this requestId')
    pendingRetry.set(requestId, intent)
    return { accepted: true, sourceRunId: source.runId, requestId, targetEventSeq: source.inputEventSeq, memberIds: selected }
  }

  function discardRetryIntent({ conversationId, runId, requestId }) {
    const intent = pendingRetry.get(String(requestId))
    if (!intent || intent.conversationId !== conversationId || intent.sourceRunId !== runId) return { discarded: false }
    pendingRetry.delete(String(requestId))
    return { discarded: true }
  }

  function listTraces({ conversationId }) {
    const rows = loadRunRows(conversationId).map(row => traceSummary(row.trace ?? createTrace(row.status.runId, row.status.startedAt), { ...row.status, ...traceAssociation(row) }))
    return rows.sort((left, right) => String(right.startedAt).localeCompare(String(left.startedAt)))
  }

  function getTrace({ conversationId, runId }) {
    const row = readRunRecord(conversationId, runId)
    if (!row) throw teamError('RP_TEAM_RUN_NOT_FOUND', `Unknown RP Team run ${runId}`)
    return { ...row.status, ...traceAssociation(row), configuration: row.config, events: structuredClone(row.trace?.events ?? []) }
  }

  function latestRun(conversationId) {
    const cached = runs.get(latestRunByConversation.get(conversationId))
    if (cached) return cached
    const row = loadRunRows(conversationId).sort((a, b) => String(b.status.startedAt).localeCompare(String(a.status.startedAt)))[0]
    if (!row) return undefined
    const run = hydrateRun(row, { conversationId })
    applySavedFields(run, row)
    run.dataDir ??= runDataDirectory(run.conversationId, run.runId)
    latestRunByConversation.set(conversationId, run.runId)
    return run
  }

  function requireConversationRun(conversationId, runId) {
    const run = loadRuntimeForRetry(conversationId, runId)
    if (!run || run.conversationId !== conversationId || run.runId !== String(runId)) throw teamError('RP_TEAM_RUN_NOT_FOUND', `Unknown RP Team run ${runId}`)
    return run
  }

  async function getProductCommitStatus(input) {
    return await ctx.eleckoiStoryState.getProductCommitStatus(input)
  }

  async function prepareConversationRestore({ conversationId, sessionId, fromTurn, beforeEventSeq }) {
    await recoveryReady
    const conversation = String(conversationId)
    const cutoffSeq = Number.isSafeInteger(beforeEventSeq) ? beforeEventSeq : undefined
    const cutoffTurn = Number.isSafeInteger(fromTurn) ? fromTurn : undefined
    if (cutoffSeq === undefined && cutoffTurn === undefined) {
      throw teamError('RP_TEAM_RESTORE_TARGET_REQUIRED', 'A Session event sequence or turn is required to restore Team state')
    }
    const includesTarget = row => cutoffSeq !== undefined
      ? Number.isSafeInteger(row.status?.inputEventSeq) && row.status.inputEventSeq >= cutoffSeq
      : Number.isSafeInteger(row.status?.turn) && row.status.turn >= cutoffTurn
    const belongsToSession = row => !sessionId || String(row.rootSessionId) === String(sessionId)
    const isRewound = row => row.trace?.events?.some(event => event.type === 'publication.rewound') === true
    let affected = loadRunRows(conversation).filter(row => belongsToSession(row) && !isRewound(row) && includesTarget(row)
      && (row.status?.phase === 'complete' || row.status?.phase === 'awaiting_commit'))
    for (const row of affected.filter(item => item.status.phase === 'awaiting_commit')) {
      const receipt = await getProductCommitStatus({ conversationId: conversation, runId: row.status.runId })
      if (receipt.outcome === 'pending' || receipt.outcome === 'unknown') {
        throw teamError('RP_TEAM_COMMIT_PENDING', 'Cannot rewind while a Team publication has no definitive receipt')
      }
      await settleRecoveredRun(conversation, row.status.runId, receipt)
    }
    // A recovered committed receipt changes an awaiting row into a complete
    // run. Re-read after settlement so this very rewind uses its checkpoint.
    affected = loadRunRows(conversation).filter(row => belongsToSession(row) && !isRewound(row) && includesTarget(row)
      && (row.status?.phase === 'complete' || row.status?.phase === 'awaiting_commit'))
    const committed = affected.filter(row => row.status?.phase === 'complete'
      && row.status?.runId && row.status?.productMessageId)
      .sort((left, right) => {
        const leftOrder = left.status.inputEventSeq ?? Number.MAX_SAFE_INTEGER
        const rightOrder = right.status.inputEventSeq ?? Number.MAX_SAFE_INTEGER
        return leftOrder - rightOrder || String(left.status.startedAt).localeCompare(String(right.status.startedAt))
      })
    if (!committed.length) return { apply() {}, rollback() {} }
    const targetRunId = String(committed[0].status.runId)
    const before = stateStore.committedSnapshot({ conversationId: conversation })
    const baseline = stateStore.committedBaseline({ conversationId: conversation, runId: targetRunId })
    const originalTraces = committed.map(row => [String(row.status.runId), structuredClone(row.trace)])
    let applied = false
    return {
      apply() {
        if (applied) return
        stateStore.restoreCommittedSnapshot({ conversationId: conversation, snapshot: baseline })
        for (const row of committed) {
          const run = loadRuntimeForRetry(conversation, row.status.runId)
          if (!run) continue
          run.trace ??= createTrace(run.runId, run.startedAt)
          record(run, { type: 'publication.rewound', agentId: run.outputAgentId, data: {
            targetEventSeq: cutoffSeq, targetTurn: cutoffTurn, sessionId
          } })
          persistRun(run)
        }
        applied = true
      },
      rollback() {
        if (!applied) return
        stateStore.restoreCommittedSnapshot({ conversationId: conversation, snapshot: before })
        for (const [runId, trace] of originalTraces) {
          const run = runs.get(runId) ?? loadRuntimeForRetry(conversation, runId)
          if (!run) continue
          run.trace = structuredClone(trace)
          persistRun(run)
        }
        applied = false
      }
    }
  }

  async function settleRecoveredRun(conversationId, runId, receipt) {
    const run = runs.get(String(runId)) ?? loadRuntimeForRetry(conversationId, runId)
    if (!run) throw teamError('RP_TEAM_RUN_NOT_FOUND', `Cannot settle missing Team run ${runId}`)
    run.dataDir ??= runDataDirectory(run.conversationId, run.runId)
    const transaction = stateStore.status({ conversationId, runId })
    if (receipt.outcome === 'committed' && transaction.status === 'open') {
      run.stateTransaction = stateStore.stage({ conversationId, runId })
    }
    await settleRunFromReceipt(run, receipt)
  }

  function capturedVersion(activationBase, namespace, path) {
    if (!activationBase?.versions) throw teamError('RP_TEAM_STATE_VERSION_REQUIRED', `No activation-start version was captured for ${namespace}${path}`)
    return versionForPath(activationBase.versions, namespace, path)
  }

  function replayStateWrites(run, writes) {
    const authorized = writes.map(write => {
      const agent = agentById(run.config, write.agentId)
      if (!agent.outputAuthority.state) throw teamError('RP_TEAM_OUTPUT_FORBIDDEN', `Agent ${agent.id} no longer has state-write authority`)
      const input = { conversationId: run.conversationId, runId: run.runId, agentId: agent.id, namespace: write.namespace, path: write.path }
      const version = stateStore.version(input).version
      const before = observeStatePath(stateStore, run, write.namespace, write.path)
      if (version !== write.expectedVersion) {
        throw teamError('RP_TEAM_STATE_CONFLICT', `Cannot replay ${write.namespace}${write.path}: state changed since the source run`)
      }
      return { write, agent, input }
    })
    for (const { write, agent, input } of authorized) {
      const version = stateStore.version(input).version
      const before = observeStatePath(stateStore, run, write.namespace, write.path)
      if (write.operation === 'remove') stateStore.remove({ ...input, expectedVersion: version })
      else stateStore.write({ ...input, value: write.value, expectedVersion: version })
      record(run, { type: 'state.operation', agentId: agent.id, data: {
        namespace: write.namespace, path: write.path, operation: write.operation === 'remove' ? 'retry_replay_remove' : 'retry_replay', version: version + 1,
        ...before, ...(write.operation === 'remove' ? { afterMissing: true } : { after: write.value }), valuesRecorded: true
      } })
    }
  }

  function restrictManagedStateTools(agentCtx, agent) {
    const deny = []
    if (!canReadNativeNamespace(agent, 'variables')) deny.push(...VARIABLE_READ_TOOLS)
    if (!canWriteNativeNamespace(agent, 'variables')) deny.push(...VARIABLE_WRITE_TOOLS)
    if (!canReadNativeNamespace(agent, 'settings')) deny.push(...SETTING_READ_TOOLS)
    if (!canWriteNativeNamespace(agent, 'settings')) deny.push(...SETTING_WRITE_TOOLS)
    const scope = scopeOf(agentCtx)
    const restrictableNames = agentCtx.tools.view(scope).restrictableNames
    const disposers = []
    const restrictableDeny = deny.filter(name => restrictableNames.has(name))
    if (restrictableDeny.length) disposers.push(agentCtx.tools.restrict({ deny: restrictableDeny }))
    if (deny.length && typeof agentCtx.tools.guard === 'function') {
      disposers.push(agentCtx.tools.guard(execution => deny.includes(execution.name)
        ? `Tool "${execution.name}" is forbidden by this agent's state permissions.` : undefined))
    }
    if (!disposers.length) return undefined
    return () => { for (const dispose of disposers.reverse()) dispose() }
  }

  function rollbackState(run, reason) {
    const current = stateStore.status({ conversationId: run.conversationId, runId: run.runId })
    const status = current.status
    if (status === 'open' || status === 'pending') {
      run.preservedStateWrites = current.writes.filter(write => run.members[write.agentId]?.status === 'complete').map(write => structuredClone(write))
    }
    if (status === 'open' || status === 'pending') {
      run.stateTransaction = stateStore.rollback({ conversationId: run.conversationId, runId: run.runId, reason })
      record(run, { type: 'publication.rolled_back', agentId: run.outputAgentId, data: { status: 'rolled_back', reason } })
    }
  }

  function persistRun(run) {
    if (!run.trace || !run.config) return
    writeJsonAtomic(runFile(run.conversationId, run.runId), persistedRunValue(run))
  }

  function record(run, event) {
    if (!run.trace) return
    recordTrace(run.trace, event)
  }

  function loadRunRecord(conversationId, runId) {
    const active = runs.get(String(runId))
    if (active) return serializeActiveRun(active)
    return readRunRecord(conversationId, runId)
  }

  function loadRunRows(conversationId) {
    return readRunRows(traceRoot, conversationId)
  }

  function readRunRecord(conversationId, runId) {
    return readRunRecordFile(traceRoot, conversationId, runId)
  }

  function loadRunRecordAsRuntime(conversationId, runId) {
    const row = readRunRecord(conversationId, runId)
    if (!row) return undefined
    const run = hydrateRun(row, { conversationId })
    applySavedFields(run, row)
    return run
  }

  function loadRuntimeForRetry(conversationId, runId) {
    return runs.get(String(runId)) ?? loadRunRecordAsRuntime(conversationId, runId)
  }

  function serializeActiveRun(run) {
    return serializedActiveRun(run)
  }

  function applySavedFields(run, row) {
    applySavedRunFields(run, row)
  }

  function writeManualSelection(conversationId, agentIds) {
    manualSelections.set(conversationId, [...agentIds])
    const path = manualFile(conversationId)
    writeJsonAtomic(path, { agentIds: [...agentIds] })
  }

  function readManualSelection(conversationId) {
    if (manualSelections.has(conversationId)) return [...manualSelections.get(conversationId)]
    const value = readOptionalJson(manualFile(conversationId), { agentIds: [] })
    const ids = Array.isArray(value.agentIds) ? value.agentIds : []
    manualSelections.set(conversationId, ids)
    return [...ids]
  }

  function pruneManualSelection(conversationId, config) {
    const eligible = new Set(config.agents.filter(agent => agent.triggers.some(trigger => trigger.type === 'manual')).map(agent => agent.id))
    const selected = readManualSelection(conversationId)
    const filtered = selected.filter(id => eligible.has(id))
    if (filtered.length !== selected.length) writeManualSelection(conversationId, filtered)
    return filtered
  }

  function cleanRunData(run) {
    removeRunData(run)
  }

  let disposePromise
  function dispose() {
    if (disposePromise) return disposePromise
    disposing = true
    const active = [...runs.values()].filter(run => !['complete', 'failed', 'cancelled'].includes(run.phase))
    const awaitingCommit = active.filter(run => run.phase === 'awaiting_commit')
    const working = active.filter(run => run.phase !== 'awaiting_commit')
    for (const run of working) {
      void run.communication?.cancelAll('RP Agent Team runtime disposed')
      controllers.get(run.runId)?.abort('RP Agent Team runtime disposed')
      interruptChildren(run)
    }
    disposePromise = Promise.allSettled([
      ...awaitingCommit.map(async run => {
        try {
          await settlePendingReceipt(run)
          persistRun(run)
        } finally {
          await releaseConversationWork(run)
        }
      }),
      ...working.map(async run => {
        try {
          await run.communication?.cancelAll('RP Agent Team runtime disposed')
          const pending = [run.deliveryPromise, run.schedulerPromise].filter(Boolean)
          if (pending.length) await Promise.allSettled(pending)
          await drainContinuableChildren(run)
        } finally {
          cancelRunState(run, 'RP Agent Team runtime disposed')
          rollbackState(run, 'RP Agent Team runtime disposed')
          persistRun(run)
          await releaseConversationWork(run)
        }
      })
    ]).then(async () => {
      await disposeRegisteredAgentPresets(registeredPresets)
      deliveryRegistration()
    }).finally(() => {
      disposed = true
      for (const run of runs.values()) closeRunBudget(run)
      disposeSessionEvents?.()
      disposeBudgetStream?.()
    })
    return disposePromise
  }

  return { api, extension, dispose, authoring }

  function runFile(conversationId, runId) { return runFilePath(traceRoot, conversationId, runId) }
  function conversationTraceDirectory(conversationId) { return conversationTraceDirectoryPath(traceRoot, conversationId) }
  function runDataDirectory(conversationId, runId) { return runDataDirectoryPath(dataRoot, conversationId, runId) }
  function manualFile(conversationId) { return manualSelectionPath(store.path, conversationId) }

  function nativeMember(rootSessionId, memberSessionId) {
    const root = ctx.agents.get(String(rootSessionId))
    return root ? ctx.agentTeams.listMembers(root).find(item => String(item.id) === String(memberSessionId)) : undefined
  }

  function pendingChildFor(run, description = '') {
    const marker = String(description).match(/rp-agent-team-activation:[^\s|]+/)?.[0]
    return marker ? run.pendingChildren.get(marker) : undefined
  }

}

function normalizeHistoricalRun(conversationId, value) {
  const source = value?.run && !value.status ? value.run : value
  const sourceStatus = source?.status ?? source
  const runId = String(sourceStatus?.runId ?? source?.runId ?? '').trim()
  const conversation = String(conversationId)
  if (!runId || (sourceStatus?.conversationId && String(sourceStatus.conversationId) !== conversation)) {
    throw teamError('RP_TEAM_IMPORT_INVALID', 'A migrated Team run must keep its runId and target conversationId')
  }
  const sourceConfig = source?.config
  const config = sourceConfig?.schemaVersion === 2
    ? normalizeTeamConfig(sourceConfig)
    : sourceConfig?.lead && Array.isArray(sourceConfig.members)
      ? migrateV1ToV2(sourceConfig)
      : normalizeTeamConfig(sourceConfig)
  const phase = sourceStatus?.phase
  if (!['complete', 'failed', 'cancelled'].includes(phase)) {
    throw teamError('RP_TEAM_IMPORT_INVALID', `Migrated run ${runId} must have a terminal phase`)
  }
  const rootSessionId = String(source?.rootSessionId ?? source?.sessionId ?? '').trim()
  const startedAt = String(sourceStatus?.startedAt ?? source?.startedAt ?? sourceStatus?.createdAt ?? source?.createdAt ?? '').trim()
  if (!rootSessionId || !startedAt) throw teamError('RP_TEAM_IMPORT_INVALID', 'Migrated run requires its stable root Session and original start time')

  const inputMessageId = source?.inputMessageId ?? sourceStatus?.inputMessageId
  const inputEventSeq = source?.inputEventSeq ?? sourceStatus?.inputEventSeq
  const turn = source?.turn ?? sourceStatus?.turn
  const assistantSeq = source?.assistantSeq ?? sourceStatus?.assistantSeq
  const assistantMessageId = source?.assistantMessageId ?? sourceStatus?.assistantMessageId
  const productMessageId = source?.productMessageId ?? sourceStatus?.productMessageId
  if (phase === 'complete' && (!inputMessageId || !Number.isSafeInteger(inputEventSeq)
    || !Number.isSafeInteger(turn) || !Number.isSafeInteger(assistantSeq) || !productMessageId)) {
    throw teamError('RP_TEAM_IMPORT_INVALID', 'A completed migrated run needs its real input event and committed assistant message mapping')
  }
  if (inputEventSeq !== undefined && !Number.isSafeInteger(inputEventSeq)) {
    throw teamError('RP_TEAM_IMPORT_INVALID', 'Migrated inputEventSeq must be a durable Session sequence')
  }

  const rawMembers = source?.members ?? sourceStatus?.members
  const memberEntries = Array.isArray(rawMembers)
    ? rawMembers.map(item => [item?.id, item])
    : rawMembers && typeof rawMembers === 'object' && !Array.isArray(rawMembers)
      ? Object.entries(rawMembers)
      : []
  const memberMap = new Map(memberEntries.map(([id, member]) => [String(member?.id ?? id), member]))
  const members = {}
  for (const agent of config.agents) {
    const member = memberMap.get(agent.id)
    if (!member || typeof member.status !== 'string') {
      throw teamError('RP_TEAM_IMPORT_INVALID', `Migrated run ${runId} is missing member ${agent.id}`)
    }
    members[agent.id] = {
      ...structuredClone(member), id: agent.id, name: String(member.name ?? agent.name),
      result: member.result ?? null, error: member.error ?? null,
      activations: Number.isSafeInteger(member.activations) ? member.activations : 0,
      sessions: Array.isArray(member.sessions) ? [...member.sessions].map(String) : []
    }
  }

  const outputAgentId = config.output.agentId
  const productPublication = source?.publication ?? sourceStatus?.publication
  const publication = productPublication ? {
    runId, agentId: outputAgentId,
    status: phase === 'complete' ? 'committed' : String(productPublication.status ?? phase),
    operationCount: Number.isSafeInteger(productPublication.operationCount) ? productPublication.operationCount : 0,
    selectedDraftIds: Array.isArray(productPublication.selectedDraftIds) ? [...productPublication.selectedDraftIds] : [],
    ...(productPublication.stagedAt ? { stagedAt: productPublication.stagedAt } : {}),
    ...((Number.isSafeInteger(productPublication.bodyCharacters) || typeof productPublication.body === 'string')
      ? { bodyCharacters: productPublication.bodyCharacters ?? Array.from(productPublication.body).length } : {})
  } : (phase === 'complete' ? { runId, agentId: outputAgentId, status: 'committed', operationCount: 0, selectedDraftIds: [] } : null)
  const productCommitStaged = phase === 'complete' || Boolean(productPublication
    && ['awaiting_commit', 'committed', 'rolled_back'].includes(productPublication.status))

  const traceStartedAt = String(source?.trace?.startedAt ?? startedAt)
  const trace = createTrace(runId, traceStartedAt)
  const priorEvents = Array.isArray(source?.trace?.events) ? source.trace.events : []
  for (const event of priorEvents) {
    if (typeof event?.type !== 'string') continue
    recordTrace(trace, { type: event.type, agentId: event.agentId, at: event.at ?? traceStartedAt, data: event.data ?? {} })
    const saved = trace.events.at(-1)
    if (Number.isSafeInteger(event.seq)) saved.seq = event.seq
    trace.nextSeq = Math.max(trace.nextSeq, saved.seq + 1)
  }

  const status = {
    runId, conversationId: conversation, phase, startedAt,
    createdAt: String(sourceStatus?.createdAt ?? source?.createdAt ?? startedAt),
    updatedAt: String(sourceStatus?.updatedAt ?? source?.updatedAt ?? startedAt),
    outputAgentId, members, publication, productCommitStaged,
    ...(Number.isSafeInteger(turn) ? { turn } : {}),
    ...(inputMessageId ? { inputMessageId: String(inputMessageId) } : {}),
    ...(Number.isSafeInteger(inputEventSeq) ? { inputEventSeq } : {}),
    ...(Number.isSafeInteger(assistantSeq) ? { assistantSeq } : {}),
    ...(assistantMessageId ? { assistantMessageId: String(assistantMessageId) } : {}),
    ...(productMessageId ? { productMessageId: String(productMessageId) } : {}),
    ...(sourceStatus?.failure || source?.failure ? { failure: String(sourceStatus.failure ?? source.failure) } : {}),
    retryAvailable: false
  }
  return {
    version: 2, status, rootSessionId, configRevision: source?.configRevision ?? configRevision(config),
    config: structuredClone(config), members, publication,
    failure: status.failure, productMessageId: status.productMessageId,
    inputMessageId: status.inputMessageId, inputEventSeq: status.inputEventSeq,
    assistantSeq: status.assistantSeq, assistantMessageId: status.assistantMessageId,
    turn, trace,
    configStoreRevision: source?.configStoreRevision,
    baseHash: source?.baseHash,
    contextFingerprint: source?.contextFingerprint,
    productReceiptOutcome: phase === 'complete' ? 'committed'
      : source?.productReceiptOutcome ?? (phase === 'failed' || phase === 'cancelled' ? phase : undefined),
    productCommitStaged,
    drafts: Array.isArray(source?.drafts) ? structuredClone(source.drafts) : [],
    messages: Array.isArray(source?.messages) ? structuredClone(source.messages) : [],
    internalResults: Array.isArray(source?.internalResults) ? structuredClone(source.internalResults) : [],
    preservedStateWrites: Array.isArray(source?.preservedStateWrites) ? structuredClone(source.preservedStateWrites) : []
  }
}

function sameHistoricalRunIdentity(existing, imported) {
  return existing.status?.runId === imported.status.runId
    && existing.status?.conversationId === imported.status.conversationId
    && existing.rootSessionId === imported.rootSessionId
    && existing.configRevision === imported.configRevision
    && existing.status?.phase === imported.status.phase
    && existing.status?.turn === imported.status.turn
    && existing.status?.inputMessageId === imported.status.inputMessageId
    && existing.status?.inputEventSeq === imported.status.inputEventSeq
    && existing.status?.assistantSeq === imported.status.assistantSeq
    && existing.status?.assistantMessageId === imported.status.assistantMessageId
    && existing.status?.productMessageId === imported.status.productMessageId
}

function deferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

function findInputEventSeq(session, message, requestId) {
  const events = session?.snapshotEvents?.()
  return events?.findLast(event => event.type === 'user/message'
    && ((message?.id && event.data?.id === message.id)
      || (requestId && event.data?.source?.rpcId === requestId)))?.seq
}

function handoffTerminalResult(run, agentId, executionId, requestId, session, terminal) {
  const request = run.communication.getRequest(requestId)
  const submitted = [...run.internalResults].reverse().find(item =>
    item.agentId === agentId && item.executionId === executionId)
  if (request?.responseSchema && !submitted) {
    throw teamError('RP_TEAM_HANDOFF_RESULT_REQUIRED', 'This handoff requires rp_team_submit_internal from its exact target execution')
  }
  if (submitted) return { summary: submitted.summary, data: submitted.data, typed: true }
  const summary = terminalAssistantText(session, terminal)
  if (!summary.trim()) throw teamError('RP_TEAM_HANDOFF_RESULT_REQUIRED', 'The target execution ended without a handoff result')
  return { summary }
}

function terminalAssistantText(session, terminal) {
  const events = session?.snapshotEvents?.() ?? []
  const terminalSeq = Number(terminal?.seq)
  const terminalTurn = terminal?.turn
  const candidates = events.filter(event => event.type === 'assistant/message'
    && (terminalTurn === undefined || event.data?.turn === terminalTurn)
    && (!Number.isFinite(terminalSeq) || Number(event.seq) < terminalSeq))
    .sort((left, right) => Number(right.seq) - Number(left.seq))
  for (const event of candidates) {
    const text = assistantText(event.data?.message)
    if (text.trim()) return text
  }
  return ''
}

function agentById(config, id) {
  const agent = config.agents.find(item => item.id === id)
  if (!agent) throw teamError('RP_TEAM_AGENT_NOT_FOUND', `Unknown configured agent ${id}`)
  return agent
}

function allows(configured, value) { return configured.includes('*') || configured.includes(value) }

function assistantText(message) {
  if (typeof message?.content === 'string') return message.content
  if (!Array.isArray(message?.content)) return ''
  return message.content.filter(part => part?.type === 'text').map(part => String(part.text ?? '')).join('')
}

function childTurnEndError(data) {
  if (data.error) return new Error(String(data.error.message ?? data.error))
  const reason = data.reason
  if (reason?.kind === 'error') {
    const failure = reason.error
    return new Error(String(failure?.message ?? (failure ? JSON.stringify(failure) : 'Native child turn failed')))
  }
  if (data.outcome === 'failed') return new Error(String(data.reason ?? 'Native child turn failed'))
  if (reason?.kind === 'aborted' || data.outcome === 'cancelled') {
    const cause = reason?.reason?.kind ?? reason?.reason
    return teamError('RP_TEAM_NATIVE_TURN_ABORTED', `Native child turn was aborted${cause ? ` (${cause})` : ''}`)
  }
  if (reason?.kind && reason.kind !== 'completed') {
    return teamError('RP_TEAM_NATIVE_TURN_INCOMPLETE', `Native child turn ended as ${reason.kind}`)
  }
  return undefined
}
