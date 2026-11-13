import { registerExecutionSession, finishExecutionSession, traceAssociation, observeStatePath } from './execution-trace.mjs'
import { randomUUID } from 'node:crypto'
import { mkdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  applySavedRunFields, conversationTraceDirectory as conversationTraceDirectoryPath, fingerprint, manualSelectionPath,
  persistedRunValue, readOptionalJson, readRunRecordFile,
  readRunRows, removeRunData, runDataDirectory as runDataDirectoryPath, runFilePath, serializedActiveRun,
  writeJsonAtomic, conversationTraceDirectory
} from './run-persistence.mjs'
import { interruptPersistedRequests, readRequestRecords } from './request-persistence.mjs'
import {
  bindAgentSession, cancelRun as cancelRunState, commitRun as commitRunState, completeRun,
  configRevision, createRun, failRun, hydrateRun, runStatus, setRunPhase, stagePublication, writesToReplayOnRetry,
  teamError, unbindAgentSession
} from './run-state.mjs'
import { TeamConfigStore } from './config-store.mjs'
import { StateStore, describeStateToolAccess, projectStateValueForAgent } from './state-store.mjs'
import { createScheduler } from './scheduler.mjs'
import { createCommunication } from './communication.mjs'
import { buildAgentContext, draftVisibleTo } from './context-policy.mjs'
import { actualTokenUsage, createTrace, recordTrace, traceSummary } from './trace.mjs'
import { disposeRegisteredAgentPresets, resolveAgentModel, resolveAgentPreset, restoreRegisteredAgentPreset, validateAgentModelRoutes } from './agent-composition.mjs'
import { registerTeamTools } from './team-tools.mjs'
import { registerMemoryTools } from './memory-tools.mjs'
import { registerContextTools } from './context-tools.mjs'
import { resolveAuthorParameters } from '../shared/author-parameters.mjs'
import {
  committedTriggerCooldowns, createTriggerTracker, latestCommittedStateCheckpoint, stateChangesFromCheckpoint
} from './event-triggers.mjs'
import { assertBudgetedRunDispatchable, createRunBudget, isBudgetedTeamRequest, requestOrigin } from './run-budget.mjs'
import {
  childPolicy, childPrompt,
  conditionState, createChildContextData, makeSources
} from './agent-context.mjs'
import {
  CAPABILITIES, capabilityAvailableInSnapshot,
  allowedGroupsForAgent, capabilityLabel, MANAGED_CAPABILITIES,
  toolGroups, restrictMemberTools
} from './native-policy.mjs'
import { setPointerValue, stableJson } from './context-world-adapter.mjs'
import { evaluateCondition, migrateV1ToV2, normalizeTeamConfig, parsePreset } from '../shared/schema.mjs'
import { createTeamDeliveryAdapter, TEAM_DELIVERY_MODEL, TEAM_DELIVERY_PROVIDER } from './delivery-adapter.mjs'
import { activeUserInputIds, isAppendedSurfaceEvent, isOwnedSettledNotice, matchesRunInputMessage, readSessionEvents, sumTokenSamplesForSessions } from './session-event-policy.mjs'

const TOOL_GROUP = 'rp-team'

/** Native DSH supplies Sessions and model/tool composition; this module owns roster policy and publication. */
export function createRpAgentTeam(ctx, dependencies) {
  const { defineTool, parseYaml, stringifyYaml, scopeOf, createScope, LlmAdapter } = dependencies
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
  const derivedPresetFile = join(dirname(store.path), 'derived-presets.json')
  const derivedPresetDefinitions = new Map()
  const installedAgentScopes = new Map()
  const latestStepBySession = new Map()
  const pendingRootSteps = new Map()
  const dataRoot = join(dirname(store.path), 'runs')
  const traceRoot = join(dirname(store.path), 'traces')
  let disposed = false
  let disposing = false
  let installed = false
  let uninstallNativeHooks = () => {}
  const deliveryRegistration = ctx.llm.registerAdapter(
    [TEAM_DELIVERY_PROVIDER], createTeamDeliveryAdapter(deliverScheduledRun, LlmAdapter)
  )

  const runRowsCache = new Map()
  const recoveryReceipts = new Map()
  const recoveryWrites = new Map()
  const ready = restoreDerivedAgentPresets()
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
      // One damaged run record must not reject recovery: that would break every Team call until the next restart.
      try { recoverSettledTransaction(transaction) } catch (error) {
        console.error(`[rp-team] recovery skipped run ${transaction.runId}: ${error?.message ?? error}`)
      }
    }
    recoverInterruptedRuns()
  })

  function recoverSettledTransaction(transaction) {
    {
      if (!['committed', 'rolled_back'].includes(transaction.status)) return
      const key = `${transaction.conversationId}\u0000${transaction.runId}`
      const receipt = recoveryReceipts.get(key)
      if (!receipt || !['committed', 'failed', 'cancelled'].includes(receipt.outcome)) return
      const run = loadRunRecordAsRuntime(transaction.conversationId, transaction.runId)
      if (!run) return
      // The process may have stopped after persisting `publishing` but before the Host acknowledged the stage.
      if (run.phase === 'publishing' && run.publication) completeRun(run)
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
      commitRunState(run, receipt.outcome, receipt.assistantMessageId)
      record(run, { type: receipt.outcome === 'committed' ? 'publication.committed' : 'publication.rolled_back',
        agentId: run.outputAgentId, data: {
          status: receipt.outcome, productMessageId: receipt.assistantMessageId,
          ...(run.failure ? { reason: run.failure } : {}),
          assistantSeq: run.assistantSeq, assistantMessageId: run.assistantMessageId
        } })
      cleanRunData(run)
      persistRun(run)
    }
  }

  /**
   * A run whose state transaction is still open at startup stopped before its reply reached the Host
   * (an app crash or forced quit). It can never finish, so fail it, release its state paths and allow a retry.
   */
  function recoverInterruptedRuns() {
    const reason = 'Interrupted: the app stopped before this round finished'
    for (const [conversationId, conversation] of Object.entries(stateStore.readDocument().conversations ?? {})) {
      for (const transaction of Object.values(conversation?.runs ?? {})) {
        if (transaction?.status !== 'open') continue
        try {
          const run = loadRunRecordAsRuntime(conversationId, transaction.runId)
          if (run?.productCommitStaged || run?.phase === 'awaiting_commit') continue
          if (!run) {
            stateStore.rollback({ conversationId, runId: transaction.runId, reason })
            continue
          }
          run.dataDir = runDataDirectory(run.conversationId, run.runId)
          for (const member of Object.values(run.members ?? {})) {
            if (!['complete', 'skipped', 'failed'].includes(member.status)) {
              member.status = 'failed'
              member.error ??= reason
            }
          }
          failRun(run, run.failure || reason)
          run.productReceiptOutcome = 'failed'
          rollbackState(run, reason)
          closeRunBudget(run)
          record(run, { type: 'run.interrupted', agentId: run.outputAgentId, data: { reason } })
          cleanRunData(run)
          persistRun(run)
        } catch (error) {
          console.error(`[rp-team] could not recover interrupted run ${transaction.runId}: ${error?.message ?? error}`)
        }
      }
    }
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
    getRunRecords,
    reconcileBranch,
    // Committed cooldown markers still on the active branch, for the next-round forecast.
    readCooldownMarkers: (conversationId, activeInputMessageIds) =>
      committedTriggerCooldowns(loadRunRows(String(conversationId)), activeInputMessageIds)
  }

  function install() {
    if (installed) return uninstallNativeHooks
    installed = true
    const disposers = [
      ctx.on('agent/created', async ({ agent }) => await installAgentScope(agent)),
      ctx.on('agent/disposed', ({ agent }) => disposeAgentScope(agent?.session?.id ?? agent?.id)),
      ctx.on('agent/prepare-step', prepareAgentModel),
      ctx.on('agent/pre-step', onAgentPreStep, { prepend: true }),
      ctx.on('session/event', (session, event) => onSessionEvent(session, event)),
      ctx.on('llm/stream', (options, next) => {
        const run = runForSession(options?.sessionId)
        if (run) captureModelInput(run, options)
        return guardTeamModelRequest(options, next)
      })
    ]
    uninstallNativeHooks = () => {
      for (const dispose of disposers.reverse()) dispose?.()
      for (const id of [...installedAgentScopes.keys()]) disposeAgentScope(id)
      pendingRootSteps.clear()
      installed = false
    }
    return uninstallNativeHooks
  }

  async function restoreDerivedAgentPresets() {
    const saved = readOptionalJson(derivedPresetFile, { version: 1, presets: [] })
    if (saved.version !== 1 || !Array.isArray(saved.presets)) {
      throw teamError('RP_TEAM_PRESET_STORE_INVALID', 'RP Team derived preset storage has an unsupported format')
    }
    for (const recipe of saved.presets) {
      if (!recipe || typeof recipe.id !== 'string' || !recipe.id.startsWith('rp-team-')) {
        throw teamError('RP_TEAM_PRESET_STORE_INVALID', 'RP Team derived preset storage contains an invalid definition')
      }
      const prior = derivedPresetDefinitions.get(recipe.id)
      if (prior && stableJson(prior) !== stableJson(recipe)) {
        throw teamError('RP_TEAM_PRESET_STORE_INVALID', `RP Team derived preset ${recipe.id} is duplicated`)
      }
      derivedPresetDefinitions.set(recipe.id, structuredClone(recipe))
      const registration = restoreRegisteredAgentPreset(recipe, { agentPresets: ctx.agentPresets, parseYaml })
      registeredPresets.set(recipe.id, registration)
      await registration
    }
  }

  async function persistDerivedAgentPreset(recipe) {
    const prior = derivedPresetDefinitions.get(recipe.id)
    if (prior && stableJson(prior) !== stableJson(recipe)) {
      throw teamError('RP_TEAM_PRESET_STORE_INVALID', `RP Team derived preset ${recipe.id} changed unexpectedly`)
    }
    derivedPresetDefinitions.set(recipe.id, structuredClone(recipe))
    writeJsonAtomic(derivedPresetFile, {
      version: 1,
      presets: [...derivedPresetDefinitions.values()].sort((left, right) => left.id.localeCompare(right.id))
    })
  }

  async function prepareAgentModel({ agent, turn, step, signal }) {
    const sessionId = String(agent?.session?.id ?? '')
    if (!sessionId || disposing || disposed) return
    await installAgentScope(agent)
    const child = childBindings.get(sessionId)
    if (child) {
      agent.model.select(modelSelection(child.route))
      return
    }
    if (agent.session.header?.origin === 'subagent' || step !== 1) return

    const prepared = await ctx.eleckoiConversationsApi.preparedTurn({ sessionId })
    signal?.throwIfAborted()
    if (!prepared || String(prepared.sessionId) !== sessionId || Number(prepared.turn) !== turn) return
    const conversationId = String(prepared.conversationId)
    const saved = store.get(conversationId)
    if (!saved?.enabled) {
      // An ordinary turn cannot consume a staged Team retry; drop it so it does not linger.
      for (const [id, intent] of pendingRetry) if (intent.conversationId === conversationId) pendingRetry.delete(id)
      return
    }

    const selected = agent.model.current()
    const ordinary = isTeamDeliveryModel(selected) ? prepared.model : selected ?? prepared.model
    const modelSnapshot = freezeProposedModel(ordinary, prepared.model)
    pendingRootSteps.set(sessionId, {
      turn, conversationId, operationId: String(prepared.operationId), configRevision: saved.revision,
      modelSnapshot, agent, signal, messages: [], routeSelected: true
    })
    agent.model.select({ provider: TEAM_DELIVERY_PROVIDER, model: TEAM_DELIVERY_MODEL })
  }

  function restoreRootSelection(pending) {
    if (pending && isTeamDeliveryModel(pending.agent.model.current())) {
      pending.agent.model.select(modelSelection(pending.modelSnapshot))
    }
  }

  async function onAgentPreStep(event, next) {
    const agent = event?.agent
    if (!agent?.session?.id || disposing || disposed) return await next()
    const sessionId = String(agent.session.id)
    await installAgentScope(agent)
    const activeId = activeRunBySession.get(sessionId)
    const active = activeId ? runs.get(activeId) : undefined
    if (agent.session.header?.origin === 'subagent' || childBindings.has(sessionId)) return await next()
    const pending = pendingRootSteps.get(sessionId)
    // DSH has already captured the route for this step. Restore the ordinary
    // Session selection before it is read by later steps or by the composer.
    if (pending?.turn === event.turn) restoreRootSelection(pending)
    const originalMessages = Array.isArray(event.messages) ? event.messages : []
    const messages = await excludeOwnedSettledNotices(sessionId, active?.conversationId, originalMessages, event.signal)
    if (active?.turn === event.turn) {
      if (originalMessages.length && !messages.length) return { kind: 'enter', messages: [] }
      return { kind: 'enter', messages }
    }
    if (originalMessages.length && !messages.length) return { kind: 'enter', messages: [] }
    const excludedNoticeIds = new Set(originalMessages.filter(message => !messages.includes(message)
      && typeof message?.id === 'string').map(message => message.id))
    const excludedNoticeSenders = new Set(originalMessages.filter(message => !messages.includes(message))
      .map(message => String(message?.source?.senderSessionId ?? '')).filter(Boolean))
    if (pending?.turn === event.turn) pending.messages = messages
    const decision = await next()
    if (decision?.kind === 'reject' || decision?.kind === 'error') pendingRootSteps.delete(sessionId)
    if (decision?.kind !== 'enter' || (!excludedNoticeIds.size && !excludedNoticeSenders.size)) return decision
    return { ...decision, messages: (decision.messages ?? []).filter(message => !excludedNoticeIds.has(message?.id)
      && !(message?.role === 'user' && message?.source?.kind === 'subagent-settled'
        && excludedNoticeSenders.has(String(message.source.senderSessionId ?? '')))) }
  }

  async function installAgentScope(agent) {
    await ready
    const sessionId = String(agent?.session?.id ?? agent?.id ?? '')
    if (!sessionId || installedAgentScopes.has(sessionId)) return installedAgentScopes.get(sessionId)?.ctx
    if (typeof createScope !== 'function') throw new Error('DSH createScope is required to install native Agent hooks')
    const key = scopeOf(agent.ctx)
    if (!key) throw new Error(`Native Agent ${sessionId} has no public DSH scope identity`)
    const scope = createScope(agent.ctx, key)
    const agentCtx = scope.ctx
    const disposers = []
    const entry = { scope, ctx: agentCtx, disposers, owner: undefined }
    installedAgentScopes.set(sessionId, entry)
    disposers.push(agentCtx.on('agent/request', async (event, next) => {
      const proposed = await next()
      const childBinding = childBindings.get(sessionId)
      if (childBinding) {
        const { provider, model, reasoningEffort, ...controls } = childBinding.route
        return { ...proposed, ...controls }
      }
      if (!isTeamDeliveryModel(proposed)) return proposed
      const pending = pendingRootSteps.get(sessionId)
      if (pending?.turn === event.turn) {
        pending.modelSnapshot = freezeProposedModel(pending.modelSnapshot, { ...pending.modelSnapshot, ...proposed })
      }
      const { temperature, topP, maxTokens, ...local } = proposed
      return local
    }, { prepend: true }))
    agent.ctx.effect?.(() => () => disposeAgentScope(sessionId))

    const parentSessionId = String(agent.session.header?.parentSession ?? '')
    let run, member, binding, childBinding
    const rootRunId = activeRunBySession.get(parentSessionId)
    if (rootRunId) {
      run = runs.get(rootRunId)
      const row = nativeMember(parentSessionId, sessionId)
      const pending = row && pendingChildFor(run, row.description)
      if (pending && bindPendingChild(run, pending.marker, sessionId, row.name)) childBinding = childBindings.get(sessionId)
      if (childBinding) binding = run.sessionBindings.get(sessionId)
    } else {
      const parent = [...runs.values()].map(candidate => [candidate, candidate.sessionOwners?.get(parentSessionId)]).find(([, owner]) => owner)
      if (parent) {
        [run] = parent
        const owner = parent[1]
        member = agentById(run.config, owner.agentId)
        if (member) {
          const depth = (run.executionSessions.find(item => item.sessionId === parentSessionId)?.depth ?? 0) + 1
          run.sessionOwners.set(sessionId, { ...owner, sessionId, scheduled: false })
          registerExecutionSession(run, { agentId: member.id, activation: owner.activation, sessionId,
            parentSessionId, depth, scheduled: false })
          if (!run.members[member.id].sessions.includes(sessionId)) run.members[member.id].sessions.push(sessionId)
        }
      }
    }
    if (run && childBinding) {
      binding = run.sessionBindings.get(sessionId)
      member = agentById(run.config, binding?.agentId)
    } else if (run && binding) member = agentById(run.config, binding.agentId)
    if (run && member) {
      const scheduled = Boolean(childBinding)
      entry.owner = { runId: run.runId, agentId: member.id, scheduled, sessionId }
      if (scheduled) {
        // Team's native spawn request has no preset field. Select through the
        // public registry while the new child Session is still blank; this
        // persists the actual composition used by the first prompt and by any
        // later cold resume. `composeFrom` already joined the inherited preset.
        const presetId = childBinding.presetId
        if (presetId && ctx.agentPresets.composedPreset(agent.ctx) !== presetId) {
          await ctx.agentPresets.select(agent, presetId)
        }
        disposers.push(agentCtx.systemPrompt.section({
          name: `rp-agent-team:${run.runId}:${member.id}:${binding.activation}`,
          order: agentCtx.systemPrompt.getSectionOrder('TEAM_POLICY'),
          text: childPolicy(member, run, binding.activation, run.pendingChildren)
        }))
        disposers.push(registerTools(agentCtx, member, run, sessionId))
      }
      disposers.push(await restrictAgentCapabilities(agentCtx, member, run, agent.session.header ?? {}, scheduled))
      record(run, { type: 'session.scope_installed', agentId: member.id, data: { sessionId, scheduled } })
      persistRun(run)
    }
    return agentCtx
  }

  function disposeAgentScope(sessionId) {
    restoreRootSelection(pendingRootSteps.get(String(sessionId)))
    pendingRootSteps.delete(String(sessionId))
    const entry = installedAgentScopes.get(String(sessionId))
    if (!entry) return
    installedAgentScopes.delete(String(sessionId))
    for (const dispose of entry.disposers.reverse()) if (typeof dispose === 'function') dispose()
    entry.scope.dispose?.()
  }

  async function capturePreparedTurn(current, agent, signal) {
    const conversationId = String(current.conversationId)
    const sessionId = String(current.sessionId ?? agent.session.id)
    const [details, author] = await Promise.all([
      ctx.eleckoiConversationsApi.details(conversationId),
      ctx.eleckoiConversationsApi.authorState(conversationId)
    ])
    const events = await readSessionEvents(ctx, sessionId, signal)
    const inputEvent = events.find(event => event.type === 'user/message'
      && (String(sessionMessage(event)?.id ?? '') === String(current.inputMessageId ?? '')
        || Number.isSafeInteger(current.inputEventSeq) && event.seq === current.inputEventSeq))
    const inputMessage = inputEvent ? sessionMessage(inputEvent) : undefined
    const inputEventSeq = current.inputEventSeq ?? inputEvent?.seq
    const history = events.filter(event => ['user/message', 'assistant/message'].includes(event.type)
      && isAppendedSurfaceEvent(event)
      && (event.type !== 'user/message' || sessionMessage(event)?.source?.kind === 'user')
      && Number.isSafeInteger(inputEventSeq) && event.seq < inputEventSeq)
      .map(event => ({
        role: sessionMessage(event)?.role,
        content: assistantText(sessionMessage(event)),
        ...(Array.isArray(sessionMessage(event)?.content) ? {
          attachments: sessionMessage(event).content
            .filter(part => part?.type === 'image' || part?.type === 'file')
            .map(part => structuredClone(part))
        } : {})
      })).filter(item => ['user', 'assistant'].includes(item.role))
    const variables = JSON.parse((author.editableVariableStateJson ?? author.currentVariableStateJson) || '{}')
    const editableSettingLibrary = structuredClone(author.editableSettingLibrary !== undefined
      ? author.editableSettingLibrary : author.settingLibrary ?? { groups: [], entries: [] })
    const runtimeSettingLibrary = structuredClone(author.settingLibrary ?? editableSettingLibrary ?? { groups: [], entries: [] })
    // State reads must match what a write replaces: the editable entry, not its macro-expanded projection.
    const settings = Object.fromEntries((editableSettingLibrary?.entries ?? []).map(entry => [entry.id, String(entry.content ?? '')]))
    const content = Array.isArray(inputMessage?.content) ? inputMessage.content : []
    const currentInput = content.filter(part => part?.type === 'text').map(part => String(part.text ?? '')).join('\n')
    return {
      conversationId, sessionId, turn: current.turn,
      inputMessageId: current.inputMessageId ?? inputMessage?.id,
      inputEventSeq,
      operationId: String(current.operationId),
      modelSnapshot: structuredClone(current.model ?? {}),
      worldSnapshot: { variables, settings, settingLibrary: editableSettingLibrary, baseHash: current.worldHash },
      contextSnapshot: {
        characterId: details.metadata?.characterId ?? details.metadata?.character?.id ?? '',
        characterName: details.metadata?.characterName ?? details.metadata?.character?.name ?? '',
        persona: structuredClone(details.metadata?.characterPersona ?? details.metadata?.persona ?? {}),
        history, currentUserInput: currentInput, settingLibrary: runtimeSettingLibrary
      },
      attachments: content.filter(part => part?.type === 'image' || part?.type === 'file').map(part => structuredClone(part)),
      inputSource: inputMessage?.source,
      userTurnOrdinal: history.filter(item => item.role === 'user').length + 1,
      // Cooldowns and between-turn state checkpoints only count runs whose input is still on the surface.
      activeInputMessageIds: activeUserInputIds(
        events.filter(event => Number.isSafeInteger(inputEventSeq) && event.seq < inputEventSeq),
        inputMessage ?? (current.inputMessageId ? { id: String(current.inputMessageId), source: { kind: 'user' } } : undefined)
      ),
      mountedPresetId: ctx.agentPresets.composedPreset(agent.ctx)
    }
  }
  async function restrictAgentCapabilities(agentCtx, member, run, snapshot, scheduled) {
    return restrictMemberTools(agentCtx, {
      member, rootGroups: run.rootAvailableGroups, productDisabled: run.productDisabledGroups,
      scheduled
    })
  }

  async function beginRun({ sessionId, turn, snapshot, rootAgent, claimedMessages, config, parameterValues = {}, configRevision, disabledToolGroupIds }) {
    if (disposing || disposed) return undefined
    const templateConfig = structuredClone(config)
    const resolvedParameters = resolveAuthorParameters(config, parameterValues)
    config = resolvedParameters.config
    await validateAgentModelRoutes(config, ctx.llm)
    const conversationId = String(snapshot.conversationId)
    await recoveryReady
    await reconcileBranch(conversationId)
    const pendingAuthorEdits = stateStore.pendingAuthorEdits(conversationId)
    if (pendingAuthorEdits.length) {
      throw teamError('RP_TEAM_AUTHOR_EDIT_PENDING', 'Resolve the pending author edit before starting another Team run')
    }
    const previousRun = latestRun(conversationId)
    if (isAwaitingProductReceipt(previousRun)) {
      const receipt = await settlePendingReceipt(previousRun)
      persistRun(previousRun)
      if (['pending', 'unknown'].includes(receipt?.outcome)) {
        throw teamError('RP_TEAM_COMMIT_PENDING', 'The prior Team response still has no definitive product receipt')
      }
    }
    const runId = randomUUID()
    const worldSnapshot = snapshot.worldSnapshot
    if (!worldSnapshot || typeof snapshot.operationId !== 'string' || !snapshot.operationId) {
      throw teamError('RP_TEAM_CURRENT_TURN_INVALID', 'Prepared product turn is missing its public world snapshot or operation identity')
    }
    const baseHash = worldSnapshot.baseHash
    const conversation = structuredClone(snapshot.contextSnapshot ?? {})
    const destinationSnapshot = {
      ...structuredClone(snapshot), conversationId,
      model: structuredClone(snapshot.modelSnapshot)
    }
    const binding = {
      conversationId, rootSessionId: String(sessionId), enabled: true, revision: configRevision,
      config: structuredClone(config), templateConfig, parameterValues: structuredClone(resolvedParameters.values),
      resolvedHash: resolvedParameters.resolvedHash,
      productDisabledGroups: [...disabledToolGroupIds]
    }
    const initialState = { world: { variables: structuredClone(worldSnapshot.variables ?? {}), settings: structuredClone(worldSnapshot.settings ?? {}) } }
    const userMessage = [...(claimedMessages ?? [])].reverse().find(message => message?.role === 'user'
      && String(message.id ?? '') === String(snapshot.inputMessageId ?? ''))
    if (!userMessage) return undefined
    const requestId = userMessage.source?.rpcId ?? snapshot.inputSource?.rpcId
    const content = Array.isArray(userMessage.content) ? userMessage.content : []
    const currentInput = String(conversation.currentUserInput
      ?? content.filter(part => part?.type === 'text').map(part => String(part.text ?? '')).join('\n'))
    const contextFingerprint = fingerprint({ conversationId, currentInput, history: conversation.history ?? [], baseHash })
    let retryIntentId
    let retryIntent
    const stagedRetry = [...pendingRetry.entries()].find(([, intent]) => intent.conversationId === conversationId
      && intent.targetEventSeq === snapshot.inputEventSeq)
    if (stagedRetry) [retryIntentId, retryIntent] = stagedRetry
    else if (requestId) {
      retryIntentId = String(requestId)
      retryIntent = pendingRetry.get(retryIntentId)
    }
    if (retryIntent) {
      // A save that leaves the effective configuration unchanged (such as switching the team off and on) keeps the retry valid.
      const sameConfig = retryIntent.configStoreRevision === binding.revision
        || (retryIntent.resolvedHash !== undefined && retryIntent.resolvedHash === binding.resolvedHash)
      if (retryIntent && (retryIntent.conversationId !== conversationId
        || !sameConfig || retryIntent.baseHash !== baseHash
        || retryIntent.contextFingerprint !== contextFingerprint)) {
        pendingRetry.delete(retryIntentId)
        throw teamError('RP_TEAM_RETRY_CONTEXT_CHANGED', 'Retry context, world state, or configuration changed; retry intent was discarded')
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
    run.binding = binding
    run.configStoreRevision = binding.revision
    run.requestId = requestId ? String(requestId) : undefined
    run.turn = Number(turn)
    run.inputMessageId = String(userMessage.id ?? snapshot.inputMessageId ?? '') || undefined
    run.userTurnOrdinal = Number.isSafeInteger(snapshot.userTurnOrdinal) ? snapshot.userTurnOrdinal : undefined
    run.branchId = snapshot.branchId === undefined ? undefined : String(snapshot.branchId)
    run.activeInputMessageIds = [...new Set((snapshot.activeInputMessageIds ?? []).map(String))]
    run.operationId = snapshot.operationId
    run.inputEventSeq = snapshot.inputEventSeq ?? findInputEventSeq(rootAgent?.session, userMessage, requestId)
    run.modelSnapshot = structuredClone(snapshot.modelSnapshot)
    run.contextSnapshot = structuredClone(conversation)
    run.worldSnapshot = structuredClone(worldSnapshot)
    run.contextFingerprint = contextFingerprint
    run.baseState = structuredClone(initialState)
    run.baseHash = baseHash
    run.destinationSnapshot = destinationSnapshot
    run.rawConversationContext = conversation
    run.currentInput = currentInput
    run.attachments = (snapshot.attachments ?? content.filter(part => part?.type === 'image' || part?.type === 'file')).map(part => structuredClone(part))
    run.rootAvailableGroups = await configuredGroups(destinationSnapshot, binding.config, rootAgent)
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
      // Members that run again (including the publisher) write afresh; replaying their old writes would apply them twice.
      replayStateWrites(run, writesToReplayOnRetry(source.preservedStateWrites, run.retryAgentIds))
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
      pendingRetry.delete(retryIntentId)
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
    pruneSettledRuns(run.conversationId)
    activeRunBySession.set(String(sessionId), run.runId)
    bindingsBySession.set(String(sessionId), binding)
    bindingsByConversation.set(run.conversationId, binding)
    controllers.set(run.runId, new AbortController())
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
    // Once the Host acknowledged the staged reply no further model work happens; the budget must not discard it.
    if (run.productStageReceipt && !run.budgetFailure) return
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
    if (!run.productCommitStaged) failRun(run, error)
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

  function stopBudgetDeadline(run) {
    if (run.budgetTimer !== undefined) clearTimeout(run.budgetTimer)
    run.budgetTimer = undefined
  }

  function closeRunBudget(run) {
    stopBudgetDeadline(run)
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

  function runForSession(sessionId) {
    const id = String(sessionId ?? '')
    const runId = activeRunBySession.get(id) ?? childBindings.get(id)?.runId
      ?? [...runs.values()].find(candidate => candidate.sessionOwners?.has(id))?.runId
    return runId ? runs.get(String(runId)) : undefined
  }

  function captureModelInput(run, options) {
    const sessionId = String(options?.sessionId ?? '')
    if (!sessionId || !Array.isArray(options?.messages)) return
    const step = latestStepBySession.get(sessionId)
    const turn = Number.isSafeInteger(step?.turn) ? step.turn : (sessionId === run.rootSessionId ? run.turn : undefined)
    const stepNo = Number.isSafeInteger(step?.step) ? step.step : undefined
    const key = stableJson([sessionId, turn, stepNo])
    run.modelInputOrdinals ??= {}
    const ordinal = (run.modelInputOrdinals[key] ?? 0) + 1
    run.modelInputOrdinals[key] = ordinal
    const requestId = String(options.requestId ?? `${sessionId}:${turn ?? 'unknown'}:${stepNo ?? 'unknown'}:${ordinal}`)
    const context = options.messages.flatMap((message, originalOrder) => {
      if (!message || typeof message !== 'object' || !['system', 'developer', 'user', 'assistant', 'tool'].includes(message.role)) return []
      if (['analysis', 'reasoning', 'private_reasoning'].includes(String(message.channel ?? message.kind ?? '').toLowerCase())) return []
      const content = safeRequestContent(message.content)
      return [{
        order: originalOrder,
        ...(typeof message.id === 'string' ? { messageId: message.id } : {}),
        role: message.role,
        ...(typeof message.kind === 'string' ? { kind: message.kind } : {}),
        ...(typeof message.title === 'string' ? { title: redactRequestText(message.title) } : {}),
        ...(message.source && typeof message.source === 'object' ? { source: safeRequestIdentity(message.source) } : {}),
        ...(message.anchor && typeof message.anchor === 'object' ? { anchor: safeRequestIdentity(message.anchor) } : {}),
        content
      }]
    })
    record(run, { type: 'model.input', agentId: run.sessionOwners?.get(sessionId)?.agentId ?? run.outputAgentId,
      data: {
        sessionId, ...(turn === undefined ? {} : { turn }), ...(stepNo === undefined ? {} : { step: stepNo }),
        requestId, provider: options.provider, model: options.model,
        ...(options.purpose ? { purpose: options.purpose } : {}),
        ...(sessionId === run.rootSessionId && options.provider === TEAM_DELIVERY_PROVIDER ? { localDelivery: true } : {}),
        ...(step?.eventSeq !== undefined ? { stepStartSeq: step.eventSeq } : {}),
        context
      } })
    persistRunSoon(run)
  }

  function safeRequestContent(content) {
    if (typeof content === 'string') return redactRequestText(content)
    if (!Array.isArray(content)) return ''
    return content.flatMap(part => {
      if (!part || typeof part !== 'object') return []
      if (part.type === 'text') return [{ type: 'text', text: redactRequestText(part.text ?? '') }]
      if (part.type === 'tool-call') return [{ type: 'tool-call', name: redactRequestText(part.name ?? ''), arguments: redactRequestText(JSON.stringify(part.arguments ?? {})) }]
      if (part.type === 'tool-result') return [{ type: 'tool-result', name: redactRequestText(part.name ?? ''), content: redactRequestText(typeof part.content === 'string' ? part.content : JSON.stringify(part.content ?? '')) }]
      if (part.type === 'image') return [{ type: 'image' }]
      return []
    })
  }

  function safeRequestIdentity(value) {
    const keys = ['kind', 'type', 'id', 'rpcId', 'messageId', 'sessionId', 'seq', 'turn', 'name']
    return Object.fromEntries(keys.filter(key => ['string', 'number'].includes(typeof value[key]))
      .map(key => [key, typeof value[key] === 'string' ? redactRequestText(value[key]) : value[key]]))
  }

  function redactRequestText(value) {
    return String(value)
      .replace(/\b["']?(api[_-]?key|access[_-]?token|refresh[_-]?token|secret|password)["']?\s*([:=])\s*["']?([^\s,"'};]+)["']?/giu, '$1$2[redacted]')
      .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/giu, 'Bearer [redacted]')
      .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/gu, '[redacted credential]')
  }

  function stateValue(value) {
    return value === undefined ? { known: true, present: false } : { known: true, present: true, value: structuredClone(value) }
  }

  async function deliverScheduledRun(options) {
    const sessionId = String(options.sessionId ?? '')
    let runId = activeRunBySession.get(sessionId)
    let run = runId ? runs.get(runId) : undefined
    if (!run) {
      const pending = pendingRootSteps.get(sessionId)
      const step = latestStepBySession.get(sessionId)
      if (!pending?.routeSelected || Number(pending.turn) !== Number(step?.turn)) {
        throw teamError('RP_TEAM_RUN_NOT_ACTIVE', 'The local delivery route has no matching admitted root turn')
      }
      const current = await ctx.eleckoiConversationsApi.currentTurn({ sessionId })
      if (!current || String(current.sessionId ?? '') !== sessionId
        || Number(current.turn) !== Number(pending.turn)
        || String(current.operationId ?? '') !== pending.operationId
        || String(current.conversationId ?? '') !== String(pending.conversationId ?? '')) {
        throw teamError('RP_TEAM_CURRENT_TURN_INVALID', 'Host could not confirm the admitted local-delivery turn identity')
      }
      const userMessage = [...pending.messages].reverse().find(message => isRootInputMessage(message)
        && String(message.id ?? '') === String(current.inputMessageId ?? ''))
      if (!current.inputMessageId || !userMessage) {
        throw teamError('RP_TEAM_CURRENT_TURN_INVALID', 'Host input identity does not match the captured root user message')
      }
      await recoveryReady
      const saved = store.get(current.conversationId)
      if (!saved.enabled || saved.revision !== pending.configRevision) {
        throw teamError('RP_TEAM_CONFIG_CHANGED', 'The enabled Team configuration changed before local delivery began')
      }
      const proposedModel = pending.modelSnapshot
      if (current.model && proposedModel && !sameFrozenModel(current.model, proposedModel)) {
        throw teamError('RP_TEAM_MODEL_CHANGED', 'The prepared product model changed before local delivery began')
      }
      const agent = pending.agent ?? ctx.agents.get(sessionId)
      if (!agent) throw teamError('RP_TEAM_ROOT_NOT_READY', 'Root DSH Agent is not available at local delivery')
      const snapshot = await capturePreparedTurn(current, agent, options.signal ?? pending.signal)
      const actualModel = current.model ? freezeProposedModel(current.model) : proposedModel
      if (!actualModel || isTeamDeliveryModel(actualModel)) {
        throw teamError('RP_TEAM_MODEL_INVALID', 'Host did not provide the actual product model for local delivery')
      }
      snapshot.modelSnapshot = {
        ...(proposedModel ?? {}),
        ...actualModel,
        ...(actualModel.reasoningEffort === undefined && proposedModel?.reasoningEffort !== undefined
          ? { reasoningEffort: proposedModel.reasoningEffort } : {})
      }
      run = await beginRun({
        sessionId, turn: pending.turn, snapshot, rootAgent: agent, claimedMessages: pending.messages,
        config: saved.config, parameterValues: saved.parameterValues, configRevision: saved.revision,
        disabledToolGroupIds: agent.session.header?.disabledToolGroupIds ?? []
      })
      if (!run) throw teamError('RP_TEAM_CURRENT_TURN_INVALID', 'Captured root input could not start the Team run')
      pendingRootSteps.delete(sessionId)
      if (Number.isSafeInteger(pending.localDeliveryRequestSeq)) {
        run.localDeliveryRequestSeq = pending.localDeliveryRequestSeq
        record(run, { type: 'publication.local_delivery_route', agentId: run.outputAgentId, data: {
          sessionId, turn: run.turn, requestHeaderSeq: pending.localDeliveryRequestSeq,
          provider: TEAM_DELIVERY_PROVIDER, model: TEAM_DELIVERY_MODEL
        } })
        persistRun(run)
      }
      captureModelInput(run, options)
      runId = run.runId
    }
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
      agentPresets: ctx.agentPresets, parseYaml, cache: registeredPresets,
      persistDefinition: persistDerivedAgentPreset
    })
    const allowedGroups = allowedGroupsForAgent(agent, run.rootAvailableGroups, run.productDisabledGroups)
    const activationKey = fingerprint(`${run.runId}\u0000${agent.id}`).slice(0, 24)
    const marker = `rp-agent-team-activation:${activationKey}:${activationNo}`
    const childData = createChildContextData({ run, agent, stateStore })
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
      sessionId: session, marker, name, route: structuredClone(pending.route), presetId: pending.presetId
    }
    if (!run.childSessionIds.includes(session)) run.childSessionIds.push(session)
    childBindings.set(session, binding)
    pending.waiter?.bind?.(session)
    persistRun(run)
    return true
  }

  function onSessionEvent(session, event) {
    if (disposed || !event || typeof event.type !== 'string') return
    const sessionId = String(session?.id ?? session?.sessionId ?? '')
    if (event.type === 'turn/end' && Number(pendingRootSteps.get(sessionId)?.turn) === Number(event.data?.turn)) {
      restoreRootSelection(pendingRootSteps.get(sessionId))
      pendingRootSteps.delete(sessionId)
    }
    if (event.type === 'step/start') {
      latestStepBySession.set(sessionId, { turn: event.data?.turn, step: event.data?.step, eventSeq: event.seq })
    }
    const pendingRoot = pendingRootSteps.get(sessionId)
    const headerConfig = event.type === 'request/header' ? event.data?.header?.config : undefined
    if (pendingRoot?.routeSelected && Number(latestStepBySession.get(sessionId)?.turn) === Number(pendingRoot.turn)
      && headerConfig?.provider === TEAM_DELIVERY_PROVIDER && headerConfig?.model === TEAM_DELIVERY_MODEL) {
      pendingRoot.localDeliveryRequestSeq = event.seq
    }
    const rootRunId = activeRunBySession.get(sessionId)
    const rootRun = rootRunId ? runs.get(rootRunId) : undefined
    if (rootRun && sessionId === rootRun.rootSessionId && event.type === 'request/header'
      && event.data?.header?.config?.provider === TEAM_DELIVERY_PROVIDER
      && event.data?.header?.config?.model === TEAM_DELIVERY_MODEL) {
      rootRun.localDeliveryRequestSeq = event.seq
      record(rootRun, { type: 'publication.local_delivery_route', agentId: rootRun.outputAgentId, data: {
        sessionId, turn: rootRun.turn, requestHeaderSeq: event.seq,
        provider: event.data.header.config.provider, model: event.data.header.config.model
      } })
      persistRun(rootRun)
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
      if (rootRun.productCommitStaged) void settleEndedTurn(rootRun, event.data ?? {}, failure)
        .catch(error => { rootRun.settlementError = String(error?.message ?? error); persistRun(rootRun) })
      else if (failure || rootRun.phase !== 'complete') void settleFailedRun(rootRun,
        rootRun.budgetFailure ? 'failed' : event.data?.reason?.kind === 'aborted' || event.data?.outcome === 'cancelled' ? 'cancelled' : 'failed',
        failure ?? new Error('Root Session ended before Team publication was staged'))
        .catch(error => { rootRun.settlementError = String(error?.message ?? error); persistRun(rootRun) })
      return
    }
    let binding = childBindings.get(sessionId)
    if (!binding) {
      const rootId = String(session?.header?.parentSession ?? session?.parentSessionId ?? session?.parentAgent?.session?.id ?? '')
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
      latestStepBySession.delete(sessionId)
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
    persistRunSoon(run)
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

  async function excludeOwnedSettledNotices(sessionId, conversationId, messages, signal) {
    if (!messages.some(message => message?.source?.kind === 'subagent-settled')) return messages
    if (!conversationId) {
      const matches = (await ctx.eleckoiConversationsApi.list(signal))
        .filter(item => String(item.runtimeSessionId ?? '') === sessionId)
      if (matches.length !== 1) return messages
      conversationId = String(matches[0].id ?? '')
    }
    if (!conversationId) return messages
    const childIds = ownedChildSessions(sessionId, conversationId)
    return messages.filter(message => !isOwnedSettledNotice(message, childIds))
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

  async function cancelFromClient(conversationId, runId) {
    const run = requireConversationRun(conversationId, runId)
    // A finished run has nothing to stop; cancelling the root Session here would interrupt whatever runs on it now.
    if (['failed', 'cancelled', 'complete'].includes(run.phase)) return runStatus(run)
    if (isAwaitingProductReceipt(run)) {
      interruptChildren(run)
      if (mayCancelRoot(run)) ctx.agents?.get(run.rootSessionId)?.cancel({ kind: 'user' })
      const receipt = await settlePendingReceipt(run)
      // Loaded from disk (no delivery in flight here) and the Host has no row for it: the stage never reached the Host,
      // so nothing can commit it. An explicit cancel is the author's way out instead of a chat blocked for good.
      if (receipt?.outcome === 'unknown' && !run.deliveryPromise) {
        await settleRunFromReceipt(run, { outcome: 'cancelled', conversationId: run.conversationId, runId: run.runId,
          error: 'Cancelled: the Host has no record of this staged turn' })
      }
      persistRun(run)
      return runStatus(run)
    }
    const reason = new Error('Cancelled from RP Team controls')
    controllers.get(run.runId)?.abort(reason.message)
    await run.communication?.cancelAll(reason)
    interruptChildren(run)
    const root = mayCancelRoot(run) ? ctx.agents?.get(run.rootSessionId) : undefined
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
      if (ids.length) await ctx.subagents.drainChildren(root, ids)
    }
  }

  async function settlePendingReceipt(run) {
    if (['committed', 'failed', 'cancelled'].includes(run.productReceiptOutcome)) {
      return { outcome: run.productReceiptOutcome, productMessageId: run.productMessageId }
    }
    if (run.phase === 'complete') return { outcome: 'committed', productMessageId: run.productMessageId }
    promoteStagedPublication(run)
    const receipt = await getProductCommitStatus({ conversationId: run.conversationId, runId: run.runId })
    return await settleRunFromReceipt(run, receipt)
  }

  function isAwaitingProductReceipt(run) {
    return run?.phase === 'awaiting_commit'
      || (run?.phase === 'publishing' && run.productCommitStaged === true)
  }

  function promoteStagedPublication(run) {
    if (!run || run.phase !== 'publishing' || run.productCommitStaged !== true) return false
    completeRun(run)
    persistRun(run)
    return true
  }

  async function pollTurnCommitStatus(run, { attempts = 30, intervalMs = 50 } = {}) {
    let receipt
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      receipt = await getProductCommitStatus({ conversationId: run.conversationId, runId: run.runId })
      if (!['pending', 'unknown'].includes(receipt?.outcome)) return receipt
      if (attempt + 1 < attempts) await new Promise(resolve => setTimeout(resolve, intervalMs))
    }
    return receipt
  }

  async function settleEndedTurn(run, eventData, failure) {
    const receipt = await pollTurnCommitStatus(run)
    if (['committed', 'failed', 'cancelled'].includes(receipt?.outcome)) {
      await settleRunFromReceipt(run, receipt)
      return receipt
    }
    if (run.productStageRejected !== undefined && receipt?.outcome === 'unknown') {
      const local = { outcome: 'failed', conversationId: run.conversationId, runId: run.runId, error: run.productStageRejected }
      await settleRunFromReceipt(run, local)
      return local
    }
    const status = receipt?.outcome ?? 'unknown'
    const detail = failure?.message ?? eventData?.error?.message ?? 'The official product save has no terminal receipt yet'
    const key = `${status}\u0000${detail}`
    if (run.lastCommitPendingKey !== key) {
      run.lastCommitPendingKey = key
      record(run, { type: 'publication.commit_pending', agentId: run.outputAgentId, data: {
        status, reason: String(detail), sessionId: run.rootSessionId, turn: run.turn,
        assistantSeq: run.assistantSeq, assistantMessageId: run.assistantMessageId
      } })
    }
    persistRun(run)
    return receipt
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
    const disposers = [registerTeamTools(args), registerContextTools({ ...args, attachments: ctx.attachments })]
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
    const signal = run.rootSignal ?? controllers.get(run.runId)?.signal
    if (disposing || disposed || signal?.aborted) {
      throw teamError('RP_TEAM_CANCELLED', String(signal?.reason?.message ?? signal?.reason ?? 'RP Agent Team runtime disposed'))
    }
    run.publicationFinalized = true
    const transaction = stateStore.stage({ conversationId: run.conversationId, runId: run.runId })
    run.stateTransaction = transaction
    const nextWorld = worldStateAfterWrites(run.worldSnapshot, transaction.writes)
    const hostPayload = {
      conversationId: run.conversationId,
      operationId: run.operationId,
      runId: run.runId,
      expectedWorldHash: run.baseHash,
      inputMessageId: run.inputMessageId,
      ...(stableJson(nextWorld.variables) === stableJson(run.worldSnapshot.variables)
        ? {} : { variableStateJson: JSON.stringify(nextWorld.variables) }),
      ...(stableJson(nextWorld.settingLibrary) === stableJson(run.worldSnapshot.settingLibrary)
        ? {} : { settingLibrary: nextWorld.settingLibrary }),
      localDelivery: { provider: TEAM_DELIVERY_PROVIDER, model: TEAM_DELIVERY_MODEL }
    }
    let stageAttempted = false
    try {
      // Stage is the point after which the Host may still commit even if this
      // process loses the local acknowledgement. Persist that uncertainty
      // before crossing the Host boundary so cancellation cannot roll it back.
      run.productCommitStaged = true
      record(run, { type: 'publication.stage_requested', agentId: run.outputAgentId, data: {
        status: 'requested', operationId: run.operationId
      } })
      persistRun(run)
      stageAttempted = true
      const staged = await ctx.eleckoiConversationsApi.stageTurnState(hostPayload)
      if (staged?.outcome !== 'pending' || String(staged.operationId ?? run.operationId) !== run.operationId) {
        throw teamError('RP_TEAM_PRODUCT_STAGE_FAILED', 'Host did not acknowledge the staged product state for this prepared turn')
      }
      run.productStageReceipt = structuredClone(staged)
      stopBudgetDeadline(run)
      if (run.phase === 'publishing') completeRun(run)
      assertBudgetAvailable(run)
      run.publication.operationCount = transaction.writes.filter(write => write.namespace === 'world').length
      record(run, { type: 'publication.staged', agentId: run.outputAgentId, data: {
        status: 'staged', selectedProposalCount: run.publication.selectedDraftIds.length,
        operationCount: run.publication.operationCount, bodyCharacters: run.publication.body.length
      } })
      record(run, { type: 'publication.awaiting_commit', agentId: run.outputAgentId, data: { status: 'awaiting_commit' } })
      persistRun(run)
    } catch (error) {
      if (!stageAttempted) {
        run.productCommitStaged = false
        rollbackState(run, error?.message ?? error)
      } else {
        // The Host call returned a rejection in this process. If the Host also has no turn row for this run,
        // nothing can commit it any more; settleFailedRun treats that as a local failure instead of waiting.
        // An abort or timeout says nothing about the Host side, which may still write the row; keep waiting then.
        const inconclusive = ['AbortError', 'TimeoutError'].includes(error?.name) || /time(?:d)?\s?out/iu.test(String(error?.message ?? ''))
        if (run.productStageReceipt === undefined && !inconclusive) run.productStageRejected = String(error?.message ?? error)
        if (run.phase === 'publishing') completeRun(run)
        persistRun(run)
      }
      throw error
    }
  }

  function worldStateAfterWrites(baseWorld, writes) {
    let variables = structuredClone(baseWorld.variables ?? {})
    const settingWrites = writes.filter(item => item.namespace === 'world' && item.path.startsWith('/settings/'))
    const settingLibrary = baseWorld.settingLibrary === null
      ? (settingWrites.length ? { groups: [], entries: [] } : null)
      : structuredClone(baseWorld.settingLibrary ?? { groups: [], entries: [] })
    for (const write of writes.filter(item => item.namespace === 'world')) {
      if (write.path.startsWith('/variables/')) {
        const path = write.path.slice('/variables'.length)
        if (write.operation === 'remove') removePointerValue(variables, path)
        else variables = setPointerValue(variables, path, write.value)
      } else if (write.path.startsWith('/settings/')) {
        const entryId = decodeWorldSettingId(write.path)
        const entry = settingLibrary?.entries?.find(item => item.id === entryId)
        if (!entry) throw teamError('RP_TEAM_STATE_PATH_UNDEFINED', `Unknown SettingLibrary entry ${entryId}`)
        entry.content = String(write.value)
      } else {
        throw teamError('RP_TEAM_STATE_PATH_INVALID', `Unsupported world state path ${write.path}`)
      }
    }
    return { variables, settingLibrary }
  }

  function decodeWorldSettingId(path) {
    const encoded = path.slice('/settings/'.length)
    if (!encoded || encoded.includes('/')) throw teamError('RP_TEAM_STATE_PATH_INVALID', 'A SettingLibrary entry path must contain one stable entry ID')
    return encoded.replace(/~1/gu, '/').replace(/~0/gu, '~')
  }

  function removePointerValue(value, pointer) {
    const segments = pointer === '' ? [] : pointer.slice(1).split('/').map(part => part.replace(/~1/gu, '/').replace(/~0/gu, '~'))
    if (!segments.length) throw teamError('RP_TEAM_STATE_PATH_INVALID', 'The world namespace root cannot be removed')
    let current = value
    for (const segment of segments.slice(0, -1)) {
      if (!current || typeof current !== 'object' || !Object.hasOwn(current, segment)) return value
      current = current[segment]
    }
    if (current && typeof current === 'object') delete current[segments.at(-1)]
    return value
  }

  async function commitProductState(run, receipt) {
    run.triggerCooldownMarkers = structuredClone(run.triggerStarts ?? [])
    run.stateTransaction = stateStore.commit({
      conversationId: run.conversationId, runId: run.runId,
      receipt: { outcome: 'committed', productMessageId: receipt.assistantMessageId }
    })
    commitRunState(run, 'committed', receipt.assistantMessageId)
    run.productReceiptOutcome = 'committed'
    run.productMessageId = receipt.assistantMessageId
    run.assistantSeq = receipt.assistantSeq
    run.assistantMessageId = receipt.assistantMessageId
    record(run, { type: 'publication.committed', agentId: run.outputAgentId, data: {
      status: 'committed', productMessageId: receipt.assistantMessageId,
      assistantSeq: receipt.assistantSeq, assistantMessageId: receipt.assistantMessageId
    } })
    releaseRun(run)
    controllers.delete(run.runId)
    closeRunBudget(run)
    cleanRunData(run)
    persistRun(run)
  }

  /** Forget the Session mapping only while it still points at this run; a newer run may already own the Session. */
  function releaseRun(run) {
    if (activeRunBySession.get(run.rootSessionId) === run.runId) activeRunBySession.delete(run.rootSessionId)
  }

  /** Cancel the root Session only for this run, or when no other run owns it (for example after a plugin reload). */
  function mayCancelRoot(run) {
    const owner = activeRunBySession.get(run.rootSessionId)
    return owner === undefined || owner === run.runId
  }

  async function settleRunFromReceipt(run, knownReceipt) {
    // A failed or cancelled run is final; a late poll must not roll back, record or release anything again.
    if (['failed', 'cancelled'].includes(run.productReceiptOutcome) && ['failed', 'cancelled'].includes(run.phase)) {
      return { outcome: run.productReceiptOutcome, conversationId: run.conversationId, runId: run.runId }
    }
    let receipt = knownReceipt ?? await getProductCommitStatus({ conversationId: run.conversationId, runId: run.runId })
    // The Host rejected this run's stage and holds no row for it (also after a restart): it can never commit.
    if (receipt?.outcome === 'unknown' && run.productStageRejected !== undefined) {
      receipt = { outcome: 'failed', conversationId: run.conversationId, runId: run.runId, error: run.productStageRejected }
    }
    if (receipt.outcome === 'committed' && receipt.active === false) {
      rollbackState(run, 'The committed output is no longer on the active Session branch')
      run.productReceiptOutcome = 'committed'
      run.productMessageId = receipt.assistantMessageId
      run.assistantSeq = receipt.assistantSeq
      run.assistantMessageId = receipt.assistantMessageId
      if (run.phase === 'awaiting_commit') commitRunState(run, 'committed', receipt.assistantMessageId)
      record(run, { type: 'publication.rewound', agentId: run.outputAgentId, data: {
        sessionId: receipt.sessionId, turn: receipt.turn,
        assistantSeq: receipt.assistantSeq, assistantMessageId: receipt.assistantMessageId
      } })
      closeRunBudget(run)
      releaseRun(run)
      controllers.delete(run.runId)
      cleanRunData(run)
      persistRun(run)
      return receipt
    }
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
      releaseRun(run)
      controllers.delete(run.runId)
      cleanRunData(run)
      persistRun(run)
    } else if (run.productCommitStaged && (receipt.outcome === 'pending' || receipt.outcome === 'unknown')) {
      const key = `${receipt.outcome}\u0000pending`
      if (run.lastCommitPendingKey !== key) {
        run.lastCommitPendingKey = key
        record(run, { type: 'publication.commit_pending', agentId: run.outputAgentId, data: {
          status: receipt.outcome, sessionId: run.rootSessionId, turn: run.turn,
          assistantSeq: run.assistantSeq, assistantMessageId: run.assistantMessageId
        } })
      }
      persistRun(run)
    }
    return receipt
  }

  function setReceiptFailure(run, receipt) {
    if (receipt.error !== undefined && receipt.error !== null && String(receipt.error).trim()) {
      run.failure = String(receipt.error)
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
      releaseRun(run)
      controllers.delete(run.runId)
      closeRunBudget(run)
      cleanRunData(run)
      persistRun(run)
      return false
    }
    const receipt = await pollTurnCommitStatus(run)
    if (['committed', 'failed', 'cancelled'].includes(receipt?.outcome)) {
      await settleRunFromReceipt(run, receipt)
      return receipt.outcome === 'committed'
    }
    if (run.productStageRejected !== undefined && receipt?.outcome === 'unknown') {
      // The stage call was rejected before the Host wrote a turn row: settle locally so the chat is not wedged.
      await settleRunFromReceipt(run, {
        outcome: outcome === 'cancelled' ? 'cancelled' : 'failed',
        conversationId: run.conversationId, runId: run.runId,
        error: run.productStageRejected
      })
      return false
    }
    const status = receipt?.outcome ?? 'unknown'
    const reason = String(error?.message ?? error)
    const key = `${status}\u0000${reason}`
    if (run.lastCommitPendingKey !== key) {
      run.lastCommitPendingKey = key
      record(run, { type: 'publication.commit_pending', agentId: run.outputAgentId, data: {
        status, reason, sessionId: run.rootSessionId, turn: run.turn,
        assistantSeq: run.assistantSeq, assistantMessageId: run.assistantMessageId
      } })
    }
    persistRun(run)
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
    if (isAwaitingProductReceipt(run)) {
      await settlePendingReceipt(run)
      persistRun(run)
    }
    const boundRevision = binding?.revision ?? binding?.boundConfigRevision ?? binding?.configRevision
    const bindingDto = binding ? {
      conversationId, rootSessionId: binding.rootSessionId, enabled: binding.enabled,
      configRevision: boundRevision, currentConfigRevision: binding.currentConfigRevision ?? saved.revision,
      stale: binding.stale ?? boundRevision !== saved.revision
    } : null
    const runDto = run ? runStatus(run) : null
    if (runDto?.retryAvailable) {
      const blocked = retryBlockedReason(run, saved)
      if (blocked) Object.assign(runDto, { retryAvailable: false, retryBlockedReason: blocked })
    }
    return { conversationId, binding: bindingDto, run: runDto, manualAgentIds: readManualSelection(conversationId) }
  }

  /** Why the host would refuse or skip a retry of this run right now: the team is off, or its effective config changed. */
  function retryBlockedReason(run, saved) {
    if (!saved?.enabled) return 'disabled'
    // Mirror the run-start gate: the same store revision, or else the same resolved configuration.
    if (run.configStoreRevision !== undefined && run.configStoreRevision === saved.revision) return undefined
    try {
      const config = normalizeTeamConfig(saved.config)
      const declared = new Set((config.authorParameters ?? []).map(parameter => parameter.id))
      const values = Object.fromEntries(Object.entries(saved.parameterValues ?? {}).filter(([id]) => declared.has(id)))
      const current = resolveAuthorParameters(config, values).resolvedHash
      return run.resolvedHash !== undefined && current === run.resolvedHash ? undefined : 'config_changed'
    } catch { return 'config_changed' }
  }

  function isConversationBusy(conversationId) {
    const conversation = String(conversationId)
    if ([...runs.values()].some(run => run.conversationId === conversation
      && !['complete', 'failed', 'cancelled'].includes(run.phase))) return true
    if ([...pendingRetry.values()].some(intent => intent.conversationId === conversation)) return true
    return loadRunRows(conversation).some(row => isAwaitingProductReceipt(row.status))
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

  async function configuredGroups(snapshot, config, rootAgent) {
    const toolScope = rootAgent?.ctx ? scopeOf(rootAgent.ctx) : undefined
    const groups = new Set([...CAPABILITIES.map(([id]) => id), ...toolGroups(ctx.tools.schemas?.(toolScope) ?? [])])
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
    runRowsCache.delete(String(conversationId))
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
    const blocked = retryBlockedReason(source, store.get(conversationId))
    if (blocked === 'disabled') throw teamError('RP_TEAM_RETRY_DISABLED', 'Turn the team on before retrying this round')
    if (blocked === 'config_changed') throw teamError('RP_TEAM_RETRY_CONTEXT_CHANGED', 'The team configuration changed since this round; a retry would reuse the old configuration')
    const failed = Object.entries(source.members).filter(([, item]) => ['failed', 'cancelled'].includes(item.status)).map(([id]) => id)
    const selected = memberIds?.length ? [...new Set(memberIds)] : failed
    if (!selected.length || selected.some(id => !failed.includes(id))) throw teamError('RP_TEAM_RETRY_NOT_FAILED', 'Retry can target only failed or cancelled agents')
    const intent = {
      conversationId, sourceRunId: source.runId, requestId, targetEventSeq: source.inputEventSeq,
      memberIds: selected, configStoreRevision: source.configStoreRevision, resolvedHash: source.resolvedHash, baseHash: source.baseHash,
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

  /**
   * Keeps the newest few runs of a chat in memory. Older settled runs (with no write pending) live only on disk,
   * where every lookup (status, retry, traces) already falls back to, so a long session does not grow without bound.
   */
  function pruneSettledRuns(conversationId, keep = 5) {
    const own = [...runs.values()].filter(item => item.conversationId === conversationId)
      .sort((left, right) => String(right.startedAt).localeCompare(String(left.startedAt)))
    for (const item of own.slice(keep)) {
      const settled = ['complete', 'failed', 'cancelled'].includes(item.phase)
        && item.persistTimer === undefined && activeRunBySession.get(item.rootSessionId) !== item.runId
        && !controllers.has(item.runId)
      if (settled) runs.delete(item.runId)
    }
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
    return await ctx.eleckoiConversationsApi.turnCommitStatus(input)
  }

  async function reconcileBranch(conversationId) {
    const conversation = String(conversationId)
    await recoveryReady
    let rows = loadRunRows(conversation)
    for (const row of rows.filter(item => isAwaitingProductReceipt(item.status))) {
      const run = runs.get(String(row.status.runId)) ?? loadRuntimeForRetry(conversation, row.status.runId)
      promoteStagedPublication(run)
      const receipt = await getProductCommitStatus({ conversationId: conversation, runId: row.status.runId })
      if (['committed', 'failed', 'cancelled'].includes(receipt?.outcome)) {
        await settleRecoveredRun(conversation, row.status.runId, receipt)
      } else if (run) {
        await settleRunFromReceipt(run, receipt)
      }
    }
    rows = loadRunRows(conversation)
    const isRewound = row => row.trace?.events?.some(event => event.type === 'publication.rewound') === true
    const inactive = []
    // A rewind or edit removes a suffix of the conversation (the baseline restore below relies on that too), so scan
    // committed runs newest first and stop at the first one still active: one Host call per turn in the usual case.
    const committed = rows.filter(item => item.status?.productCommitStaged && item.status?.phase === 'complete' && !isRewound(item))
      .sort((left, right) => (right.status.inputEventSeq ?? -1) - (left.status.inputEventSeq ?? -1)
        || (right.status.turn ?? -1) - (left.status.turn ?? -1)
        || String(right.status.startedAt).localeCompare(String(left.status.startedAt)))
    for (const row of committed) {
      const receipt = await getProductCommitStatus({ conversationId: conversation, runId: row.status.runId })
      if (receipt?.outcome === 'committed' && receipt.active === false) inactive.push({ row, receipt })
      else if (receipt?.outcome === 'committed' && receipt.active === true) break
    }
    if (!inactive.length) return { reconciled: false, runIds: [] }
    inactive.sort((left, right) => {
      const leftSeq = left.row.status.inputEventSeq ?? Number.MAX_SAFE_INTEGER
      const rightSeq = right.row.status.inputEventSeq ?? Number.MAX_SAFE_INTEGER
      return leftSeq - rightSeq || (left.row.status.turn ?? Number.MAX_SAFE_INTEGER) - (right.row.status.turn ?? Number.MAX_SAFE_INTEGER)
        || String(left.row.status.startedAt).localeCompare(String(right.row.status.startedAt))
    })
    const targetRunId = String(inactive[0].row.status.runId)
    const baseline = stateStore.committedBaseline({ conversationId: conversation, runId: targetRunId })
    stateStore.restoreCommittedSnapshot({ conversationId: conversation, snapshot: baseline })
    for (const { row, receipt } of inactive) {
      const run = runs.get(String(row.status.runId)) ?? loadRuntimeForRetry(conversation, row.status.runId)
      if (!run) continue
      run.trace ??= createTrace(run.runId, run.startedAt)
      record(run, { type: 'publication.rewound', agentId: run.outputAgentId, data: {
        sessionId: receipt.sessionId, turn: receipt.turn,
        assistantSeq: receipt.assistantSeq, assistantMessageId: receipt.assistantMessageId
      } })
      persistRun(run)
    }
    return { reconciled: true, runIds: inactive.map(item => String(item.row.status.runId)) }
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
    if (run.persistTimer !== undefined) { clearTimeout(run.persistTimer); run.persistTimer = undefined }
    writeJsonAtomic(runFile(run.conversationId, run.runId), persistedRunValue(run))
    runRowsCache.delete(String(run.conversationId))
  }

  /** High-frequency updates (usage chunks, model inputs) are written at most every 250 ms; any phase change writes at once. */
  function persistRunSoon(run) {
    if (disposing || disposed) { persistRun(run); return }
    if (run.persistTimer !== undefined) return
    run.persistTimer = setTimeout(() => { run.persistTimer = undefined; persistRun(run) }, 250)
    run.persistTimer.unref?.()
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

  // Parsed run rows per conversation; every write through this runtime drops the entry, so reads stay current.
  function loadRunRows(conversationId) {
    const key = String(conversationId)
    // Writing a run file (temp file + rename) changes the directory's mtime, which also catches writes from another
    // runtime instance, such as one still draining after a reload.
    let stamp = -1
    try { stamp = statSync(conversationTraceDirectory(traceRoot, key)).mtimeMs } catch {}
    const cached = runRowsCache.get(key)
    if (cached?.stamp === stamp && stamp !== -1) return [...cached.rows]
    const rows = readRunRows(traceRoot, key)
    runRowsCache.delete(key)
    runRowsCache.set(key, { stamp, rows })
    // Only the few chats in use stay parsed; traces can be large.
    while (runRowsCache.size > 4) runRowsCache.delete(runRowsCache.keys().next().value)
    return [...rows]
  }

  function readRunRecord(conversationId, runId) {
    return readRunRecordFile(traceRoot, conversationId, runId)
  }

  function loadRunRecordAsRuntime(conversationId, runId) {
    const row = readRunRecord(conversationId, runId)
    if (!row) return undefined
    const run = hydrateRun(row, { conversationId })
    applySavedFields(run, row)
    // Settling a run loaded from disk cleans its data directory like a live one.
    run.dataDir ??= runDataDirectory(conversationId, run.runId)
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
    if (row.status?.productCommitStaged === true) run.productCommitStaged = true
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
    for (const run of runs.values()) if (run.persistTimer !== undefined) persistRun(run)
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
        const pending = [run.deliveryPromise, run.schedulerPromise].filter(Boolean)
        if (pending.length) await Promise.allSettled(pending)
        await drainContinuableChildren(run)
        if (!['committed', 'failed', 'cancelled'].includes(run.productReceiptOutcome)) {
          await settleRunFromReceipt(run, await pollTurnCommitStatus(run))
        }
        persistRun(run)
      }),
      ...working.map(async run => {
        await Promise.allSettled([run.communication?.cancelAll('RP Agent Team runtime disposed')])
        const pending = [run.deliveryPromise, run.schedulerPromise].filter(Boolean)
        if (pending.length) await Promise.allSettled(pending)
        await Promise.allSettled([drainContinuableChildren(run)])
        if (['committed', 'failed', 'cancelled'].includes(run.productReceiptOutcome)) {
          persistRun(run)
        } else if (run.productCommitStaged || run.phase === 'awaiting_commit') {
          try {
            await settleRunFromReceipt(run, await pollTurnCommitStatus(run))
          } catch (error) {
            run.settlementError = String(error?.message ?? error)
            persistRun(run)
          }
        } else {
          cancelRunState(run, 'RP Agent Team runtime disposed')
          rollbackState(run, 'RP Agent Team runtime disposed')
          persistRun(run)
        }
      })
    ]).then(async () => {
      await ready.catch(() => undefined)
      await disposeRegisteredAgentPresets(registeredPresets)
      deliveryRegistration()
    }).finally(() => {
      disposed = true
      for (const run of runs.values()) closeRunBudget(run)
      uninstallNativeHooks?.()
    })
    return disposePromise
  }

  return { api, dispose, authoring, ready, install }

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

function sessionMessage(event) {
  return event?.type === 'user/message' ? event.data : event?.data?.message
}

function isRootInputMessage(message) {
  return message?.role === 'user' && message.source?.kind === 'user'
    && typeof message.id === 'string' && message.id.length > 0
}

function freezeProposedModel(config, parameters = config) {
  if (typeof config?.provider !== 'string' || !config.provider
    || typeof config?.model !== 'string' || !config.model) {
    throw teamError('RP_TEAM_MODEL_INVALID', 'Native request did not propose a provider and model to freeze')
  }
  return {
    provider: config.provider,
    model: config.model,
    ...(typeof config.reasoningEffort === 'string' ? { reasoningEffort: config.reasoningEffort } : {}),
    ...(Number.isFinite(parameters?.temperature) ? { temperature: parameters.temperature } : {}),
    ...(Number.isFinite(parameters?.topP) ? { topP: parameters.topP } : {}),
    ...(Number.isSafeInteger(parameters?.maxTokens) && parameters.maxTokens > 0 ? { maxTokens: parameters.maxTokens } : {})
  }
}

function isTeamDeliveryModel(config) {
  return config?.provider === TEAM_DELIVERY_PROVIDER && config?.model === TEAM_DELIVERY_MODEL
}

function modelSelection({ provider, model, reasoningEffort }) {
  return { provider, model, ...(reasoningEffort === undefined ? {} : { reasoningEffort }) }
}

function sameFrozenModel(left, right) {
  return left?.provider === right?.provider && left?.model === right?.model
    && (left?.reasoningEffort === undefined || right?.reasoningEffort === undefined
      || left.reasoningEffort === right.reasoningEffort)
}

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
