import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { parse as parseYaml } from 'yaml'
import { readSessionEvents } from './session-event-policy.mjs'
import { resolveAuthorParameters } from '../shared/author-parameters.mjs'
import { freezeTrialData, importTrialData } from './trial-frozen-data.mjs'
import { trialVariantStorageKey, writeDurableTrialAttempt, writeDurableTrialAttemptSettlement, writeDurableTrialCheckpoint } from './trial-storage.mjs'

export { trialVariantStorageKey }

let active
let activeContext
let activeSessionId
let activeConversationId
let cancellation
let activePromptWork
let cancellationDrain

process.on('message', message => {
  if (message?.type === 'cancel') {
    cancellation?.abort(new Error(message.reason || 'Trial cancelled.'))
    if (!cancellationDrain) cancellationDrain = drainCancellation()
    void cancellationDrain.finally(() => process.send?.({ type: 'cancelled' }))
    return
  }
  if (message?.type === 'run' && !active) {
    cancellation = new AbortController()
    active = message.plan?.recoveryOnly === true
      ? recoverTrialAttempt(message.plan, cancellation.signal)
      : runTrial(message.plan, cancellation.signal)
    active.then(result => process.send?.({ type: 'result', result }), error => sendError(error)).finally(() => {
      active = undefined
      activeContext = undefined
      activeSessionId = undefined
      activeConversationId = undefined
      activePromptWork = undefined
      process.disconnect?.()
    })
  }
})

async function recoverTrialAttempt(plan, signal) {
  const { attempt, variant, snapshot } = plan ?? {}
  if (!attempt || !variant || !snapshot || plan.recoveryOnly !== true) {
    throw new Error('The isolated trial recovery request is incomplete.')
  }
  throwIfCancelled(signal)
  const running = await openExistingTrialVariant(plan)
  activeContext = running.ctx
  try {
    throwIfCancelled(signal)
    return await reconcileTrialAttemptFromHost(running.ctx, plan)
  } finally {
    activeContext = undefined
    await running.shutdown.shutdown(0)
  }
}

/** Reconcile one exact persisted attempt using only the original Host profile's public APIs. */
export async function reconcileTrialAttemptFromHost(ctx, plan) {
  const { attempt, variant, snapshot, workerCheckpointRoot, trialId, scenario } = plan
  const conversationId = attempt.conversationId
  const sessionId = attempt.sessionId
  if (typeof conversationId !== 'string' || !conversationId || typeof sessionId !== 'string' || !sessionId
    || !Number.isSafeInteger(attempt.afterSeq) || !Number.isSafeInteger(attempt.turn)
    || attempt.turn < 1 || attempt.turn > scenario.steps.length || !Number.isSafeInteger(attempt.workerGeneration)) {
    return { outcome: 'unknown' }
  }
  const team = ctx.rpAgentTeam
  const conversations = ctx.eleckoiConversationsApi
  if (!team?.getStatus || !team?.getConfig || !team?.getState || !team?.getTrace
    || !team?.captureTrialStateSnapshot || !conversations?.turnCommitStatus) return { outcome: 'unknown' }

  const rootEvents = await readSessionEvents(ctx, sessionId)
  const status = await team.getStatus({ conversationId })
  const run = status?.run
  const runId = run?.runId
  const details = await conversations.details(conversationId)
  const rootSessionId = details?.runtimeSessionId
  const inputMessageId = run?.inputMessageId
  if (typeof runId !== 'string' || !runId || (attempt.runId && attempt.runId !== runId)
    || run?.conversationId !== conversationId || rootSessionId !== sessionId
    || (status?.binding !== undefined && status.binding !== null && status.binding.rootSessionId !== rootSessionId)
    || typeof inputMessageId !== 'string' || !inputMessageId || !Number.isSafeInteger(run.turn)
    || !Number.isSafeInteger(run.inputEventSeq)) {
    return { outcome: 'unknown' }
  }
  const inputEvents = rootEvents.filter(event => event?.type === 'user/message'
    && Number.isSafeInteger(event.seq) && event.seq > attempt.afterSeq
    && eventMessageId(event, 'user') === inputMessageId
    && (!event.data?.source?.kind || event.data.source.kind === 'user'))
  if (inputEvents.length !== 1 || inputEvents[0].seq !== run.inputEventSeq
    || sessionMessageText(inputEvents[0]) !== attempt.inputText) {
    return { outcome: 'unknown' }
  }
  const inputEvent = inputEvents[0]
  const turnEnds = rootEvents.filter(event => event?.type === 'turn/end'
    && Number.isSafeInteger(event.seq) && event.seq > inputEvent.seq
    && event.data?.turn === run.turn)
  const receipt = await conversations.turnCommitStatus({ conversationId, runId })
  if (!receipt || receipt.conversationId !== conversationId || receipt.runId !== runId
    || (receipt.sessionId !== undefined && receipt.sessionId !== sessionId)
    || (receipt.turn !== undefined && receipt.turn !== run.turn)
    || (receipt.inputMessageId !== undefined && receipt.inputMessageId !== inputMessageId)) {
    return { outcome: 'unknown' }
  }
  const commitIdentity = {
    conversationId, rootSessionId, runId, phase: run.phase, turn: run.turn,
    inputMessageId, productCommitStaged: run.productCommitStaged,
  }
  if (receipt.outcome === 'failed' || receipt.outcome === 'cancelled') {
    const attemptSettlement = {
      ...structuredClone(attempt), status: receipt.outcome, commitOutcome: receipt.outcome,
      commitEvidence: 'host-receipt', commitIdentity, nativeTurn: run.turn, runId, conversationId, sessionId,
      nativeEvents: structuredClone(rootEvents),
      ...(receipt.error ? { error: safeError(receipt.error) } : {}),
    }
    writeDurableTrialAttemptSettlement(workerCheckpointRoot, trialId, variant.id, attemptSettlement)
    return { outcome: receipt.outcome, runId }
  }
  if (turnEnds.length !== 1) return { outcome: 'unknown' }
  const endEvent = turnEnds[0]
  if (receipt.outcome !== 'committed' || receipt.active !== true || run.phase !== 'complete'
    || endEvent.data?.reason?.kind !== 'completed'
    || receipt.sessionId !== sessionId || receipt.turn !== run.turn
    || receipt.inputMessageId !== inputMessageId
    || typeof receipt.assistantMessageId !== 'string' || !Number.isSafeInteger(receipt.assistantSeq)) {
    return { outcome: 'unknown' }
  }

  const configResult = await team.getConfig({ conversationId })
  const turnConfig = configResult?.config
  if (!turnConfig || !Array.isArray(turnConfig.agents)) return { outcome: 'unknown' }
  const currentState = await team.getState({ conversationId })
  const capturedNativePresetIds = new Set((snapshot.nativePresetDocuments ?? []).map(item => item.id))
  const frozen = await freezeTrialData(ctx, {
    conversationId,
    nativePresetIds: turnConfig.agents.map(agent => agent.presetId).filter(id => id && !capturedNativePresetIds.has(id)),
  })
  if (frozen.details.runtimeSessionId !== sessionId) return { outcome: 'unknown' }
  const archivedLog = frozen.archive.sessionLogs.find(log => log.header?.id === sessionId)
  const archiveEvents = archivedLog?.events
  if (!Array.isArray(archiveEvents)) return { outcome: 'unknown' }
  const archiveInput = archiveEvents.find(event => event?.type === 'user/message'
    && eventMessageId(event, 'user') === inputMessageId && event.seq === inputEvent.seq)
  const assistantEvents = archiveEvents.filter(event => event?.type === 'assistant/message'
    && eventMessageId(event, 'assistant') === receipt.assistantMessageId
    && event.seq === receipt.assistantSeq)
  if (!archiveInput || assistantEvents.length !== 1) return { outcome: 'unknown' }
  const assistantEvent = assistantEvents[0]
  const body = sessionMessageText(assistantEvent)
  const checks = evaluateAssertions(scenario.steps[attempt.turn - 1].assertions, body, rootEvents, endEvent, currentState)
  let trace
  const executions = []
  try {
    trace = await team.getTrace({ conversationId, runId })
    for (const association of trace.executionSessions ?? []) {
      const events = await readSessionEvents(ctx, association.sessionId)
      executions.push({ runId, association, events })
    }
  } catch {
    // The committed official archive remains sufficient to restore the native turn if trace projection is unavailable.
  }
  const usage = {
    requests: Number(run.budget?.requestCount ?? 0),
    reportedTokens: Number(run.budget?.reportedTokens ?? 0),
    elapsedMs: Number(run.budget?.elapsedMs ?? 0),
  }
  const checkpoint = {
    ...frozen,
    modelProviders: structuredClone(snapshot.modelProviders ?? []),
    productPresets: structuredClone(snapshot.productPresets ?? []),
    activeProductPresetId: snapshot.activeProductPresetId,
    nativePresetDocuments: mergeNativePresetDocuments(snapshot.nativePresetDocuments, frozen.nativePresetDocuments),
    rootNativePresetId: snapshot.rootNativePresetId,
    teamState: team.captureTrialStateSnapshot({ conversationId }),
    sourceState: currentState,
    sourceConfig: turnConfig,
    sourceParameterValues: variant.parameterValues,
    sourceConfigEnabled: configResult.enabled === true,
  }
  const turn = {
    runId, turn: attempt.turn, workerGeneration: attempt.workerGeneration, nativeTurn: run.turn,
    inputText: attempt.inputText, body, assertions: checks, state: currentState, usage,
    taskUsage: structuredClone(plan.usage), elapsedMs: usage.elapsedMs,
    status: checks.every(check => check.passed) ? 'complete' : 'assertion_failed',
    sessionId, conversationId, afterSeq: attempt.afterSeq, nativeEvents: structuredClone(rootEvents),
    trajectory: { ...(trace ? { run: trace } : {}), executions }, attemptId: attempt.attemptId,
    commitReceipt: durableCommitReceipt(receipt),
  }
  writeDurableTrialCheckpoint(workerCheckpointRoot, trialId, variant.id, {
    format: 'rp-team.trial-worker-checkpoint', version: 1,
    trialId, variantId: variant.id, receipt: turn.commitReceipt, turn, checkpoint,
  })
  return { outcome: 'committed', runId, turn: attempt.turn }
}

async function openExistingTrialVariant(plan) {
  if (typeof plan.desktopHostUrl !== 'string' || !plan.resources) throw new Error('The official desktop-host recovery bootstrap is incomplete.')
  const desktopHost = await import(plan.desktopHostUrl)
  if (typeof desktopHost.runDshDesktopHeadlessProfile !== 'function') throw new Error('The official desktop-host package does not expose its headless profile runner.')
  const variantRoot = join(resolve(plan.workerRoot), trialVariantStorageKey(plan.variant.id))
  const { userDataRoot, runtimeDataRoot, workspaceRoot, mediaRoot, profilePath, sessionRoot, fixtureLog,
    productDatabasePath, patchPath } = trialProfilePaths(variantRoot)
  if (!existsSync(profilePath) || !existsSync(productDatabasePath) || !existsSync(sessionRoot)) {
    throw new Error('The exact isolated trial generation profile is unavailable for receipt recovery.')
  }
  const selectedBundles = selectedTrialBundles(desktopHost, plan.resources, plan.snapshot)
  const running = await desktopHost.runDshDesktopHeadlessProfile({
    runtimeDataRoot, workspaceRoot, productDatabasePath, productMediaRoot: mediaRoot,
    resources: plan.resources, profileDirectory: profilePath, bundles: selectedBundles,
    patchFiles: [patchPath],
    environment: {
      RP_TEAM_TRIAL_MODEL_LOG: fixtureLog,
      DSH_TELEMETRY_DISABLED: '1',
      DSH_DESKTOP_NODE_EXECUTABLE: process.execPath,
    },
  })
  const installed = (await running.ctx.pluginManager?.listBundles?.() ?? [])
    .find(bundle => bundle.name === '@rp-team/dsh-roleplay-team')
  if (!installed?.installed || !installed.enabled || !running.ctx.rpAgentTeam) {
    await running.shutdown.shutdown(0)
    throw new Error('The existing trial generation does not have its original RP Team runtime mounted.')
  }
  try {
    await restoreTrialNativePresetDocuments(running.ctx, plan.snapshot.nativePresetDocuments ?? [])
  } catch (error) {
    try { await running.shutdown.shutdown(1) } catch {}
    throw error
  }
  return running
}

export async function restoreTrialNativePresetDocuments(ctx, presets) {
  if (!presets.length) return
  const api = ctx.agentPresets
  if (!api?.list || !api?.readDocument || !api?.register) throw new Error('The official DSH native Agent preset API is unavailable during trial recovery.')
  const knownIds = new Set((await api.list()).map(item => item.id))
  for (const item of presets) {
    const plugins = parseYaml(item.content)
    if (!Array.isArray(plugins)) throw new Error(`Frozen native Agent preset ${item.id} is not a plugin composition.`)
    if (knownIds.has(item.id)) {
      const existing = await api.readDocument(item.id)
      const existingPlugins = typeof existing.content === 'string' ? parseYaml(existing.content) : undefined
      if (JSON.stringify(existingPlugins) !== JSON.stringify(plugins)) {
        throw new Error(`The isolated DSH profile already has a different native Agent preset registered as ${item.id}.`)
      }
    } else {
      await api.register({ id: item.id, name: item.name, description: item.description, plugins })
      knownIds.add(item.id)
    }
  }
}

async function runTrial(plan, userSignal) {
  if (typeof plan.workerCheckpointRoot !== 'string' || !plan.workerCheckpointRoot) {
    throw new Error('The trial worker has no durable checkpoint directory.')
  }
  const base = resolve(plan.workerRoot)
  mkdirSync(base, { recursive: true })
  const workerStartedAt = Date.now()
  const priorElapsedMs = Number(plan.usage?.elapsedMs ?? 0)
  const taskRemainingMs = plan.budget.task.maxElapsedMs - priorElapsedMs
  const taskController = new AbortController()
  const signal = taskController.signal
  let taskExpired = false
  let taskTimer
  let cancelRequested
  const cancelCurrentSession = () => {
    if (cancelRequested) return cancelRequested
    const sessionId = activeSessionId
    const ctx = activeContext
    cancelRequested = sessionId && ctx?.sessionController?.cancel
      ? Promise.resolve(ctx.sessionController.cancel({ sessionId })).catch(() => undefined)
      : Promise.resolve()
    return cancelRequested
  }
  const abortForUser = () => taskController.abort(userSignal.reason ?? new Error('Trial cancelled.'))
  const taskUsage = () => ({ ...totalUsage, elapsedMs: priorElapsedMs + Math.max(0, Date.now() - workerStartedAt) })
  if (userSignal.aborted) abortForUser()
  else userSignal.addEventListener('abort', abortForUser, { once: true })
  if (taskRemainingMs <= 0) {
    taskExpired = true
    const error = new Error('Trial task elapsed-time budget was exhausted before worker startup.')
    error.code = 'RP_TEAM_TRIAL_TASK_BUDGET_EXHAUSTED'
    taskController.abort(error)
  } else {
    taskTimer = setTimeout(() => {
      taskExpired = true
      const error = new Error('Trial task elapsed-time budget was exhausted.')
      error.code = 'RP_TEAM_TRIAL_TASK_BUDGET_EXHAUSTED'
      taskController.abort(error)
      void cancelCurrentSession()
    }, taskRemainingMs)
  }
  let profile
  let totalUsage = { ...(plan.usage ?? { requests: 0, reportedTokens: 0, elapsedMs: 0 }) }
  let currentVariantId
  let lastAccountedRunId
  let currentAttempt
  try {
    emit({ type: 'trial:started' })
    const completedVariantIds = []
    if (plan.usage?.reportedTokensKnown === false && plan.budget.task.maxReportedTokens > 0) {
      currentVariantId = plan.variants.find(variant => variant.status !== 'complete'
        && variant.turns.length < plan.scenario.steps.length)?.id
      const error = new Error('The previous worker stopped during a provider request without reporting usage. A token-budgeted retry cannot safely dispatch another request.')
      error.code = 'RP_TEAM_TRIAL_BUDGET_USAGE_UNAVAILABLE'
      throw error
    }
    for (const variant of plan.variants) {
      throwIfCancelled(signal)
      if (variant.status === 'complete' || variant.turns.length >= plan.scenario.steps.length) {
        completedVariantIds.push(variant.id)
        continue
      }
      currentVariantId = variant.id
      const snapshot = plan.snapshots?.[variant.id] ?? plan.snapshot
      const seeded = await startVariant({ plan, variant, snapshot, variantRoot: join(base, trialVariantStorageKey(variant.id)), signal })
      profile = seeded.profile
      const { ctx, team, conversationId, sessionId, config } = seeded
      activeContext = ctx
      activeConversationId = conversationId
      activeSessionId = sessionId
      throwIfCancelled(signal)
      emit({ type: 'variant:started', variantId: variant.id, conversationId, sessionId,
        workerGeneration: plan.workerGeneration,
        parameterResolution: seeded.parameterResolution })

      for (let index = variant.turns.length; index < plan.scenario.steps.length; index += 1) {
        throwIfCancelled(signal)
        const step = plan.scenario.steps[index]
        const currentUsage = taskUsage()
        const remaining = remainingBudget(plan.budget, currentUsage)
        const turnLimits = Object.fromEntries(Object.keys(remaining).map(key => [
          key,
          Math.min(plan.budget.turn[key], remaining[key]),
        ]))
        const exhausted = Object.entries(turnLimits).find(([, value]) => value <= 0)
        if (exhausted) throw new Error(`Trial task budget exhausted before turn ${index + 1} (${exhausted[0]}).`)
        const turnConfig = withTurnBudget(config, turnLimits)
        const saved = await team.getConfig({ conversationId })
        throwIfCancelled(signal)
        await team.saveConfig({
          conversationId,
          expectedRevision: saved.revision,
          enabled: true,
          config: turnConfig,
          parameterValues: variant.parameterValues,
        })
        const startedAt = Date.now()
        const before = await readSessionEvents(ctx, sessionId, signal)
        const afterSeq = before.at(-1)?.seq ?? -1
        const priorEnds = before.filter(event => event.type === 'turn/end').length
        throwIfCancelled(signal)
        const attemptId = `attempt-${randomUUID()}`
        const requestId = `rp-team-trial-${plan.trialId}-${variant.id}-${index + 1}-${randomUUID()}`
        currentAttempt = {
          attemptId, turn: index + 1, inputText: step.inputText, sessionId, conversationId,
          startedAt, afterSeq, requestId, variantId: variant.id,
          workerGeneration: plan.workerGeneration, nativeEvents: before,
        }
        const durableAttempt = {
          attemptId, turn: index + 1, inputText: step.inputText, sessionId, conversationId, afterSeq,
          workerGeneration: plan.workerGeneration,
          startedAt: new Date(startedAt).toISOString(), status: 'running', elapsedMs: 0,
          nativeEvents: before,
        }
        writeDurableTrialAttempt(plan.workerCheckpointRoot, plan.trialId, variant.id, durableAttempt)
        emit({ type: 'turn:attempt-started', variantId: variant.id, attempt: durableAttempt })
        activeSessionId = sessionId
        const turnController = new AbortController()
        const abortTurnFromTask = () => turnController.abort(signal.reason ?? new Error('Trial cancelled.'))
        if (signal.aborted) abortTurnFromTask()
        else signal.addEventListener('abort', abortTurnFromTask, { once: true })
        const promptWork = observeTrialPromptWork(prepareTrialPrompt(ctx, {
          conversationId, sessionId, requestId, inputText: step.inputText,
        }, turnController.signal))
        activePromptWork = promptWork
        let turnExpired = false
        const turnTimer = setTimeout(() => {
          turnExpired = true
          const error = new Error(`Trial turn ${index + 1} elapsed-time budget was exhausted.`)
          error.code = 'RP_TEAM_TRIAL_TURN_BUDGET_EXHAUSTED'
          turnController.abort(error)
          void cancelCurrentSession()
        }, turnLimits.maxElapsedMs)
        let lastProgressSeq = afterSeq
        const publishAttemptProgress = events => {
          const latestSeq = events.at(-1)?.seq ?? -1
          if (latestSeq === lastProgressSeq) return
          lastProgressSeq = latestSeq
          currentAttempt.nativeEvents = events
          emit({ type: 'turn:attempt-progress', variantId: variant.id, attemptId,
            sessionId, conversationId, afterSeq, nativeEvents: events })
        }
        let ended
        try {
          ended = await waitForTurnEnd(ctx, sessionId, priorEnds, afterSeq,
            startedAt + turnLimits.maxElapsedMs, turnController.signal, publishAttemptProgress)
          await promptWork
          throwIfCancelled(signal)
        } catch (error) {
          if (turnExpired && !userSignal.aborted && !taskExpired) {
            error.code = 'RP_TEAM_TRIAL_TURN_BUDGET_EXHAUSTED'
          }
          throw error
        } finally {
          clearTimeout(turnTimer)
          signal.removeEventListener('abort', abortTurnFromTask)
          if (turnExpired || signal.aborted) await cancelCurrentSession()
          await promptWork.catch(() => undefined)
          activeSessionId = undefined
          activePromptWork = undefined
        }
        const status = await team.getStatus({ conversationId })
        const run = status.run
        if (ended.event.data?.reason?.kind !== 'completed' || run?.phase !== 'complete') {
          const error = new Error(`Native Team turn ${index + 1} did not commit.`)
          error.nativeReason = ended.event.data?.reason?.kind
          throw error
        }
        const receipt = await ctx.eleckoiConversationsApi.turnCommitStatus({ conversationId, runId: run.runId })
        if (receipt?.outcome !== 'committed' || receipt.active !== true) throw new Error(`Native Team turn ${index + 1} has no active committed product receipt.`)
        if (receipt.conversationId !== conversationId || receipt.runId !== run.runId
          || receipt.sessionId !== sessionId || receipt.turn !== ended.event.data?.turn) {
          throw new Error(`Native Team turn ${index + 1} product receipt does not match its Session identity.`)
        }
        emit({ type: 'turn:receipt-verified', variantId: variant.id, attemptId,
          runId: run.runId, nativeTurn: receipt.turn, sessionId, conversationId,
          inputMessageId: receipt.inputMessageId, rootSessionId: status.binding?.rootSessionId })
        if (plan.testGate) await waitForSmokeReceiptGate(plan.testGate, {
          trialId: plan.trialId, variantId: variant.id, attemptId,
          workerGeneration: plan.workerGeneration, receipt: durableCommitReceipt(receipt),
        }, signal)
        const rootEvents = ended.events
        const body = run.publication?.body ?? ''
        const checks = evaluateAssertions(step.assertions, body, rootEvents, ended.event, await team.getState({ conversationId }))
        const trace = await team.getTrace({ conversationId, runId: run.runId })
        const executions = []
        for (const association of trace.executionSessions ?? []) {
          const events = await readSessionEvents(ctx, association.sessionId, signal)
          executions.push({ runId: run.runId, association, events })
        }
        const usage = {
          requests: run.budget?.requestCount ?? 0,
          reportedTokens: run.budget?.reportedTokens ?? 0,
          elapsedMs: run.budget?.elapsedMs ?? Math.max(0, Date.now() - startedAt),
        }
        totalUsage.requests += usage.requests
        totalUsage.reportedTokens += usage.reportedTokens
        totalUsage.elapsedMs = priorElapsedMs + Math.max(0, Date.now() - workerStartedAt)
        lastAccountedRunId = run.runId
        const currentState = await team.getState({ conversationId })
        const frozen = await freezeTrialData(ctx, {
          conversationId,
          nativePresetIds: (turnConfig.agents ?? []).map(agent => agent.presetId).filter(Boolean),
        })
        const checkpoint = {
          ...frozen,
          modelProviders: structuredClone(snapshot.modelProviders ?? []),
          productPresets: structuredClone(snapshot.productPresets ?? []),
          activeProductPresetId: snapshot.activeProductPresetId,
          nativePresetDocuments: mergeNativePresetDocuments(snapshot.nativePresetDocuments, frozen.nativePresetDocuments),
          rootNativePresetId: snapshot.rootNativePresetId,
          teamState: team.captureTrialStateSnapshot({ conversationId }),
          sourceState: currentState,
          sourceConfig: turnConfig,
          sourceParameterValues: variant.parameterValues,
          sourceConfigEnabled: true,
        }
        const turn = {
          runId: run.runId,
          turn: index + 1,
          workerGeneration: plan.workerGeneration,
          nativeTurn: receipt.turn,
          inputText: step.inputText,
          body,
          assertions: checks,
          state: currentState,
          usage,
          taskUsage: taskUsage(),
          elapsedMs: Math.max(0, Date.now() - startedAt),
          status: checks.every(check => check.passed) ? 'complete' : 'assertion_failed',
          sessionId,
          conversationId,
          afterSeq,
          nativeEvents: rootEvents,
          trajectory: { run: trace, executions },
          attemptId,
          commitReceipt: durableCommitReceipt(receipt),
        }
        writeDurableTrialCheckpoint(plan.workerCheckpointRoot, plan.trialId, variant.id, {
          format: 'rp-team.trial-worker-checkpoint', version: 1,
          trialId: plan.trialId, variantId: variant.id, receipt: turn.commitReceipt, turn, checkpoint,
        })
        emit({ type: 'turn:completed', variantId: variant.id, turn: {
          turn: turn.turn, runId: turn.runId, attemptId: turn.attemptId,
        } })
        currentAttempt = undefined
      }
      await seeded.profile.shutdown.shutdown(0)
      profile = undefined
      completedVariantIds.push(variant.id)
      emit({ type: 'variant:completed', variantId: variant.id })
    }
    totalUsage.elapsedMs = taskUsage().elapsedMs
    emit({ type: 'trial:completed', taskUsage: taskUsage() })
    return { trialId: plan.trialId, completedVariantIds, usage: taskUsage() }
  } catch (error) {
    await cancelRequested
    const priorRunId = lastAccountedRunId
    if (activeContext && currentVariantId) {
      try {
        const { run } = await activeContext.rpAgentTeam.getStatus({
          conversationId: activeConversationId,
        })
        if (run?.runId && run.runId !== lastAccountedRunId) {
          totalUsage.requests += run.budget?.requestCount ?? 0
          totalUsage.reportedTokens += run.budget?.reportedTokens ?? 0
          if (run.budget?.reportedTokensKnown === false) totalUsage.reportedTokensKnown = false
          lastAccountedRunId = run.runId
        }
      } catch {}
    }
    if (currentAttempt && activeContext) {
      const evidence = await collectAttemptEvidence({
        ctx: activeContext,
        conversationId: activeConversationId,
        sessionId: currentAttempt.sessionId,
        priorRunId,
      })
      const run = evidence.trajectory?.run
      if (run?.runId && run.runId !== lastAccountedRunId) {
        totalUsage.requests += run.budget?.requestCount ?? 0
        totalUsage.reportedTokens += run.budget?.reportedTokens ?? 0
        if (run.budget?.reportedTokensKnown === false) totalUsage.reportedTokensKnown = false
        lastAccountedRunId = run.runId
      }
      const receipt = evidence.runId ? await readCommitReceipt(activeContext, activeConversationId, evidence.runId) : undefined
      const commitResolution = classifyAttemptCommitOutcome(receipt, currentAttempt, evidence)
      const commitOutcome = commitResolution.outcome
      const settledStatus = commitOutcome === 'failed' || commitOutcome === 'cancelled'
        ? commitOutcome : 'needs_confirmation'
      const attempt = {
        attemptId: currentAttempt.attemptId,
        turn: currentAttempt.turn,
        workerGeneration: currentAttempt.workerGeneration,
        ...(Number.isSafeInteger(evidence.commitEvidence?.turn) ? { nativeTurn: evidence.commitEvidence.turn } : {}),
        inputText: currentAttempt.inputText,
        conversationId: currentAttempt.conversationId,
        afterSeq: currentAttempt.afterSeq,
        status: settledStatus,
        commitOutcome,
        commitEvidence: commitResolution.evidence,
        ...(evidence.commitEvidence ? { commitIdentity: evidence.commitEvidence } : {}),
        ...(evidence.runId ? { runId: evidence.runId } : {}),
        sessionId: currentAttempt.sessionId,
        error: safeError(error),
        elapsedMs: Math.max(0, Date.now() - currentAttempt.startedAt),
        nativeEvents: evidence.nativeEvents,
        trajectory: evidence.trajectory,
      }
      writeDurableTrialAttemptSettlement(plan.workerCheckpointRoot, plan.trialId, currentAttempt.variantId, attempt)
      emit({ type: 'turn:attempt-settled', variantId: currentAttempt.variantId, attempt: {
        ...attempt,
      }, taskUsage: taskUsage() })
      currentAttempt = undefined
    }
    totalUsage.elapsedMs = taskUsage().elapsedMs
    if (profile) {
      try { await profile.shutdown.shutdown(0) } catch {}
    }
    if (userSignal.aborted) {
      emit({ type: 'trial:cancelled', taskUsage: taskUsage() })
      return { trialId: plan.trialId, cancelled: true }
    }
    emit({
      type: 'trial:failed',
      interrupted: error?.code === 'RP_TEAM_TRIAL_WORKER_INTERRUPTED',
      code: error?.code,
      variantId: currentVariantId,
      message: safeError(error?.message ?? error),
      taskUsage: taskUsage(),
    })
    throw error
  } finally {
    clearTimeout(taskTimer)
    userSignal.removeEventListener('abort', abortForUser)
  }
}

/** Resolve official prompt preparation before dispatch, and never dispatch after cancellation. */
export async function prepareTrialPrompt(ctx, { conversationId, sessionId, requestId, inputText }, signal) {
  throwIfCancelled(signal)
  const prepared = await ctx.eleckoiConversationsApi.preparePrompt(conversationId, inputText)
  if (prepared.runtimeSessionId !== sessionId) throw new Error('The native conversation changed its root Session identity.')
  throwIfCancelled(signal)
  const receipt = await ctx.sessionController.prompt({
    sessionId,
    conversationId,
    requestId,
    mode: 'queue',
    content: [{ type: 'text', text: inputText }],
  }, signal)
  const resolved = await ctx.sessionController.resolveAgent(sessionId)
  if ('error' in resolved) throw resolved.error
  await resolved.agent.whenIdle()
  await ctx.eleckoiConversationsApi.waitForGeneration(conversationId, prepared.operationId)
  return receipt
}

/** Keep a prompt rejection observed while the worker waits for its native turn-end event. */
export function observeTrialPromptWork(promise) {
  void promise.catch(() => undefined)
  return promise
}

async function waitForSmokeReceiptGate(testGate, value, signal) {
  const root = resolve(testGate.fixtureRoot)
  const path = resolve(testGate.path)
  const withinFixture = relative(root, path)
  if (!testGate.fixtureOnly || !isAbsolute(root) || !isAbsolute(path)
    || !withinFixture || withinFixture === '..' || withinFixture.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)
    || isAbsolute(withinFixture)) throw new Error('The test receipt gate must stay inside its fixture directory.')
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify({ format: 'rp-team.trial-receipt-smoke-gate', ...value })}\n`, 'utf8')
  while (!existsSync(`${path}.continue`)) await sleep(25, signal)
}

function trialProfilePaths(variantRoot) {
  const userDataRoot = join(variantRoot, 'userdata')
  const runtimeDataRoot = join(userDataRoot, 'runtime')
  const home = join(runtimeDataRoot, 'home')
  const profilePath = join(home, 'profiles', 'desktop')
  const sessionRoot = join(runtimeDataRoot, 'sessions')
  const workspaceRoot = join(userDataRoot, 'workspace')
  const mediaRoot = join(userDataRoot, 'media')
  const patchPath = join(userDataRoot, 'trial-profile.patch.yml')
  const fixtureLog = join(userDataRoot, 'trial-model-fixture.jsonl')
  const productDatabasePath = join(userDataRoot, 'eleckoi-common.sqlite3')
  return { userDataRoot, runtimeDataRoot, home, profilePath, sessionRoot, workspaceRoot, mediaRoot,
    patchPath, fixtureLog, productDatabasePath }
}

function selectedTrialBundles(desktopHost, resources, snapshot) {
  // The official template includes Agent-plane modules that are shipped by
  // the host but absent from the profile's list of installed bundles.
  const template = readFileSync(resources.presetTemplatePath, 'utf8')
    .replace('__ELECKOI_COMPACTION_RETENTION__', 'retainTokens: 0')
  const baseBundles = new Set([
    ...(desktopHost.ELECKOI_DESKTOP_BUNDLES ?? []),
    ...nativePresetPackages(template),
    '@deepseek-ai/dsh-llm-pi-ai',
  ])
  const sourceBundles = snapshot.loadedBundles ?? []
  const modelBundles = selectedModelBundles(snapshot, sourceBundles, baseBundles)
  const presetBundles = selectedPresetBundles(snapshot.productPresets ?? [], snapshot.nativePresetDocuments ?? [], sourceBundles, baseBundles)
  return [...new Set([...modelBundles, ...presetBundles])]
}

async function startVariant({ plan, variant, snapshot, variantRoot, signal }) {
  if (!snapshot) throw new Error(`Variant ${variant.id} has no frozen snapshot.`)
  if (typeof plan.desktopHostUrl !== 'string' || !plan.resources) throw new Error('The official desktop-host worker bootstrap is incomplete.')
  const desktopHost = await import(plan.desktopHostUrl)
  if (typeof desktopHost.runDshDesktopHeadlessProfile !== 'function') throw new Error('The official desktop-host package does not expose its headless profile runner.')
  const { userDataRoot, runtimeDataRoot, home, profilePath, sessionRoot, workspaceRoot, mediaRoot, patchPath,
    fixtureLog, productDatabasePath } = trialProfilePaths(variantRoot)
  for (const path of [runtimeDataRoot, home, sessionRoot, workspaceRoot, mediaRoot]) mkdirSync(path, { recursive: true })
  writeFileSync(patchPath, [
    '- id: desktop-product-telemetry', '  disabled: true',
    '- id: product-analytics', '  disabled: true',
    ''
  ].join('\n'))

  const selectedBundles = selectedTrialBundles(desktopHost, plan.resources, snapshot)
  const paths = {
    DSH_HOME: home,
    DSH_SESSION_ROOT: sessionRoot,
    DSH_CWD: workspaceRoot,
    ELECKOI_SESSION_SNAPSHOT_ROOT: join(runtimeDataRoot, 'session-snapshots'),
    ELECKOI_PRESET_ROOT: join(runtimeDataRoot, 'generated-presets'),
    ELECKOI_SESSION_BRIDGE_ROOT: join(runtimeDataRoot, 'session-bridges'),
    ELECKOI_DATABASE_PATH: productDatabasePath,
    ELECKOI_MEDIA_ROOT: mediaRoot,
    ELECKOI_WORKSPACE_ROOT: workspaceRoot,
    RP_TEAM_TRIAL_MODEL_LOG: fixtureLog,
    DSH_TELEMETRY_DISABLED: '1',
  }
  const packageManagerPath = plan.resources.packageManagerEntryPath
  if (!packageManagerPath) throw new Error('The official desktop-host resources do not provide the bundled package manager entry.')
  const running = await desktopHost.runDshDesktopHeadlessProfile({
    runtimeDataRoot,
    workspaceRoot,
    productDatabasePath: paths.ELECKOI_DATABASE_PATH,
    productMediaRoot: mediaRoot,
    resources: plan.resources,
    profileDirectory: profilePath,
    bundles: selectedBundles,
    patchFiles: [patchPath],
    environment: {
      RP_TEAM_TRIAL_MODEL_LOG: fixtureLog,
      DSH_TELEMETRY_DISABLED: '1',
      DSH_DESKTOP_NODE_EXECUTABLE: process.execPath,
    },
  })
  const ctx = running.ctx
  try {
    throwIfCancelled(signal)
    const manager = ctx.pluginManager
    const installed = (await manager.listBundles()).find(bundle => bundle.name === '@rp-team/dsh-roleplay-team')
    if (!installed?.installed) {
      // A directory install creates a link back to another profile. DSH's
      // peer resolver then cannot bind that package to this profile's scope.
      // Pack the already loaded code so each trial owns a normal bundle install.
      const manifest = JSON.parse(readFileSync(join(plan.pluginRoot, 'package.json'), 'utf8'))
      const archiveDir = join(userDataRoot, 'runtime-bundle')
      mkdirSync(archiveDir, { recursive: true })
      execFileSync(process.execPath, ['--expose-internals', packageManagerPath, 'pack', '--pack-destination', archiveDir], {
        cwd: plan.pluginRoot, env: packageManagerEnvironment(), stdio: 'pipe'
      })
      const archive = join(archiveDir, `${manifest.name.replace(/^@/u, '').replace(/\//gu, '-')}-${manifest.version}.tgz`)
      throwIfCancelled(signal)
      const result = await manager.installBundle(archive)
      if (result.application !== 'applied') throw new Error(`The RP Team runtime could not be loaded into the isolated worker profile: ${JSON.stringify(result)}`)
    } else if (!installed.enabled) {
      const result = await manager.setBundleEnabled('@rp-team/dsh-roleplay-team', true)
      if (result.application !== 'applied') throw new Error('The RP Team runtime could not be enabled in the isolated worker profile.')
    }
    const team = ctx.rpAgentTeam
    if (!team || typeof team.getConfig !== 'function') throw new Error('The isolated RP Team runtime did not mount.')
    const seeded = await importTrialData(ctx, snapshot)
    const conversationId = seeded.conversationId
    const missingRoutes = (snapshot.modelProviders ?? []).filter(route =>
      route.settingsNs && !ctx.llm.listProviders().some(provider => provider.id === route.provider))
    if (missingRoutes.length) {
      throw new Error(`Selected model adapter route is missing from the isolated profile: ${missingRoutes.map(item => item.provider).join(', ')}.`)
    }
    await team.restoreTrialStateSnapshot({ conversationId, snapshot: snapshot.teamState ?? { revision: 0, namespaces: {}, pathVersions: {} } })

    const limits = remainingBudget(plan.budget, plan.usage ?? { requests: 0, reportedTokens: 0, elapsedMs: 0 })
    const effectiveConfig = variant.config
        const parameterResolution = materializeTrialConfig(effectiveConfig, variant.parameterValues, limits, plan.budget.turn, {
          allowTrustedTools: plan.allowTrustedTools === true,
        })
    const { config } = parameterResolution
    const saved = await team.getConfig({ conversationId })
    await team.saveConfig({ conversationId, expectedRevision: saved.revision, enabled: true, config,
      parameterValues: config.authorParameters ? variant.parameterValues : {} })

    await applySourceWorldState(team, conversationId, snapshot.sourceState)
    const completed = variant.turns.length
    if (completed === 0) {
      for (const operation of plan.scenario.initialState ?? []) {
        const state = await team.getState({ conversationId })
        const result = await team.applyStateEdit({
          conversationId,
          operationId: `rp-team-trial-initial-${plan.trialId}-${variant.id}-${operation.namespace}-${operation.path}`,
          expectedRevision: state.revision,
          expectedWorldHash: state.worldHash,
          anchor: state.anchor,
          operations: [{ namespace: operation.namespace, path: operation.path, operation: 'set', value: operation.value }],
        })
        if (result.status !== 'committed') throw new Error('The trial initial state did not commit.')
      }
    }
    return { profile: running, ctx, team, conversationId, sessionId: seeded.sessionId, config, parameterResolution }
  } catch (error) {
    await running.shutdown.shutdown(0)
    throw error
  }
}

async function applySourceWorldState(team, conversationId, sourceState) {
  const sourceWorld = sourceState?.values?.filter(item => item.namespace === 'world' && !item.missing && Object.hasOwn(item, 'value')) ?? []
  if (!sourceWorld.length) return
  const state = await team.getState({ conversationId })
  const allowed = new Set((state.definitions ?? []).filter(item => item.namespace === 'world').map(item => `${item.namespace}\u0000${item.path}`))
  const operations = sourceWorld.filter(item => allowed.has(`${item.namespace}\u0000${item.path}`))
    .map(item => ({ namespace: item.namespace, path: item.path, operation: 'set', value: item.value }))
  if (!operations.length) return
  const result = await team.applyStateEdit({
    conversationId,
    operationId: `rp-team-trial-world-seed-${randomUUID()}`,
    expectedRevision: state.revision,
    expectedWorldHash: state.worldHash,
    anchor: state.anchor,
    operations,
  })
  if (result.status !== 'committed') throw new Error('The source world state did not seed into the isolated trial conversation.')
}

async function waitForTurnEnd(ctx, sessionId, priorEnds, afterSeq, deadline, signal, onProgress) {
  let lastReportedSeq = -1
  let lastReportedAt = 0
  while (Date.now() < deadline) {
    throwIfCancelled(signal)
    const events = await readSessionEvents(ctx, sessionId, signal)
    const latestSeq = events.at(-1)?.seq ?? -1
    const now = Date.now()
    if (onProgress && latestSeq !== lastReportedSeq && (lastReportedAt === 0 || now - lastReportedAt >= 1000)) {
      onProgress(events)
      lastReportedSeq = latestSeq
      lastReportedAt = now
    }
    const event = events.find(item => item.type === 'turn/end' && item.seq > afterSeq)
    if (event && events.filter(item => item.type === 'turn/end').length > priorEnds) return { events, event }
    await sleep(50, signal)
  }
  const error = new Error('The native Session did not finish the trial turn before its deadline.')
  error.code = 'RP_TEAM_TRIAL_WORKER_INTERRUPTED'
  throw error
}

async function collectAttemptEvidence({ ctx, conversationId, sessionId, priorRunId }) {
  const result = { nativeEvents: await readSessionEvents(ctx, sessionId), trajectory: { executions: [] } }
  const status = await ctx.rpAgentTeam.getStatus({ conversationId })
  const { run } = status
  if (!run?.runId || run.runId === priorRunId) return result
  result.runId = run.runId
  result.commitEvidence = {
    conversationId: run.conversationId,
    rootSessionId: status.binding?.rootSessionId,
    runId: run.runId,
    phase: run.phase,
    turn: run.turn,
    inputMessageId: run.inputMessageId,
    productCommitStaged: run.productCommitStaged,
  }
  try {
    const trace = await ctx.rpAgentTeam.getTrace({ conversationId, runId: run.runId })
    result.trajectory.run = trace
    for (const association of trace.executionSessions ?? []) {
      const events = await readSessionEvents(ctx, association.sessionId)
      result.trajectory.executions.push({ runId: run.runId, association, events })
    }
  } catch {
    // A run that failed before trace projection still has its native root Session evidence.
  }
  return result
}

/** A Host `unknown` receipt is safely retryable only when the exact failed root turn never staged. */
export function classifyNoStageOutcome(attempt, evidence) {
  const identity = evidence?.commitEvidence
  const events = evidence?.nativeEvents
  if (!identity || !Array.isArray(events) || identity.productCommitStaged !== false
    || identity.conversationId !== attempt?.conversationId
    || identity.rootSessionId !== attempt?.sessionId
    || identity.runId !== evidence.runId
    || (Number.isSafeInteger(attempt?.nativeTurn) && identity.turn !== attempt.nativeTurn)
    || typeof identity.inputMessageId !== 'string' || !identity.inputMessageId) return undefined

  const input = events.find(event => event?.type === 'user/message'
    && Number.isSafeInteger(event.seq) && event.seq > attempt.afterSeq
    && String(event.data?.id ?? event.data?.message?.id ?? '') === identity.inputMessageId)
  if (!input) return undefined
  const end = events.find(event => event?.type === 'turn/end'
    && Number.isSafeInteger(event.seq) && event.seq > input.seq
    && Number(event.data?.turn) === identity.turn)
  if (!end) return undefined

  const phase = identity.phase
  const reason = end.data?.reason?.kind
  const outcome = phase === 'failed' && reason === 'error' ? 'failed'
    : phase === 'cancelled' && reason === 'aborted' ? 'cancelled'
      : undefined
  if (!outcome) return undefined

  const hasCandidateAssistant = events.some(event => event?.type === 'assistant/message'
    && Number.isSafeInteger(event.seq) && event.seq > input.seq
    && (event.data?.turn === undefined || Number(event.data.turn) === identity.turn))
  return hasCandidateAssistant ? undefined : outcome
}

function eventMessageId(event, role) {
  const data = event?.data ?? {}
  const message = data.message ?? data
  if (role && message.role && message.role !== role) return undefined
  const id = message.id ?? data.id
  return typeof id === 'string' && id ? id : undefined
}

function sessionMessageText(event) {
  const data = event?.data ?? {}
  const content = data.message?.content ?? data.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.filter(part => part?.type === 'text').map(part => String(part.text ?? '')).join('')
}

export function classifyAttemptCommitOutcome(receipt, attempt, evidence) {
  if (receipt && (receipt.conversationId !== attempt?.conversationId || receipt.runId !== evidence?.runId)) {
    return { outcome: 'unknown', evidence: 'unconfirmed' }
  }
  if (receipt?.outcome === 'failed' || receipt?.outcome === 'cancelled') {
    return { outcome: receipt.outcome, evidence: 'host-receipt' }
  }
  if (receipt?.outcome === 'unknown') {
    const noStageOutcome = classifyNoStageOutcome(attempt, evidence)
    if (noStageOutcome) return { outcome: noStageOutcome, evidence: 'session-no-stage' }
  }
  return { outcome: receipt?.outcome ?? 'unknown', evidence: 'unconfirmed' }
}

async function readCommitReceipt(ctx, conversationId, runId) {
  try { return await ctx?.eleckoiConversationsApi?.turnCommitStatus?.({ conversationId, runId }) }
  catch { return undefined }
}

function durableCommitReceipt(value) {
  const keys = ['outcome', 'conversationId', 'runId', 'operationId', 'sessionId', 'turn', 'inputMessageId',
    'assistantMessageId', 'assistantSeq', 'baseHash', 'active']
  return Object.fromEntries(keys.filter(key => value[key] !== undefined).map(key => [key, structuredClone(value[key])]))
}

function evaluateAssertions(assertions = [], body, events, endEvent, state) {
  const assistantRows = events.filter(event => event.type === 'assistant/message' && event.data?.turn === endEvent.data?.turn)
  return assertions.map(assertion => {
    let passed
    let actual
    if (assertion.type === 'body_contains') {
      actual = body
      passed = body.includes(assertion.text)
    } else if (assertion.type === 'body_not_contains') {
      actual = body
      passed = !body.includes(assertion.text)
    } else if (assertion.type === 'single_output') {
      actual = assistantRows.length
      passed = assistantRows.length === 1
    } else {
      const row = state.values?.find(item => item.namespace === assertion.namespace && item.path === assertion.path)
      actual = row?.value
      passed = stableJson(actual) === stableJson(assertion.value)
    }
    return { ...assertion, passed, ...(actual === undefined ? {} : { actual }) }
  })
}

function remainingBudget(budget, usage) {
  const usageKeys = { maxRequests: 'requests', maxReportedTokens: 'reportedTokens', maxElapsedMs: 'elapsedMs' }
  return Object.fromEntries(Object.entries(usageKeys).map(([limit, used]) => [
    limit, Math.max(0, budget.task[limit] - (usage[used] ?? 0)),
  ]))
}

function intersectLimits(saved, taskRemaining, turn) {
  return Object.fromEntries(Object.keys(turn).map(key => {
    const current = Number.isSafeInteger(saved?.[key]) && saved[key] > 0 ? saved[key] : Number.MAX_SAFE_INTEGER
    return [key, Math.min(current, taskRemaining[key], turn[key])]
  }))
}

function withTurnBudget(config, limits) {
  const result = structuredClone(config)
  result.execution ??= {}
  result.execution.budget = intersectLimits(result.execution.budget, limits, limits)
  return result
}

export function materializeTrialConfig(template, parameterValues, taskRemaining, turnBudget, { allowTrustedTools = false } = {}) {
  const resolved = resolveAuthorParameters(template, parameterValues)
  const config = structuredClone(resolved.config)
  for (const parameter of config.authorParameters ?? []) parameter.bindings = []
  if (!allowTrustedTools) for (const agent of config.agents) agent.execution.trustedTools = []
  config.execution ??= {}
  config.execution.budget = intersectLimits(config.execution.budget, taskRemaining, turnBudget)
  return { config, values: resolved.values, sourceHash: resolved.sourceHash, resolvedHash: resolved.resolvedHash }
}

function selectedModelBundles(snapshot, sourceBundles, baseBundles) {
  const selected = new Set()
  for (const route of snapshot?.modelProviders ?? []) {
    const specifier = route.settingsNs === 'llm-pi-ai'
      ? '@deepseek-ai/dsh-llm-pi-ai'
      : route.settingsNs === 'llm-deepseek' || route.provider === 'deepseek-official'
        ? '@deepseek-ai/dsh-llm-deepseek-api-key'
        : sourceBundles.find(bundle => /(?:^|\/)dsh-llm(?:-|$)/iu.test(bundle)
          && bundle.endsWith(`-${route.provider}`))
    if (!specifier || baseBundles.has(specifier)) continue
    if (!sourceBundles.includes(specifier)) {
      throw new Error(`The source profile is missing the selected model route bundle ${specifier} (${route.provider}).`)
    }
    selected.add(specifier)
  }
  return [...selected]
}

export function selectedPresetBundles(productPresets, nativePresetDocuments, sourceBundles, baseBundles) {
  const selected = new Set()
  const include = packageName => {
    if (baseBundles.has(packageName)) return
    if (!sourceBundles.includes(packageName)) throw new Error(`The frozen DSH profile does not include a required Agent preset bundle: ${packageName}.`)
    selected.add(packageName)
  }
  for (const item of nativePresetDocuments) {
    for (const packageName of nativePresetPackages(item.content)) include(packageName)
  }
  for (const item of productPresets) {
    for (const group of item.preset?.toolGroups ?? []) {
      if (group.source !== 'extension' || !group.included) continue
      const packageName = /^bundle:(.+)$/u.exec(group.plugin?.id ?? '')?.[1]
      if (!packageName) throw new Error(`The product Agent preset ${item.id} includes extension tools with no owning DSH package association.`)
      include(packageName)
    }
  }
  return [...selected]
}

function nativePresetPackages(content) {
  const packages = new Set()
  const visit = rows => {
    for (const row of rows) {
      const specifier = typeof row === 'string' ? row : row?.name
      if (typeof specifier === 'string' && specifier.startsWith('@')) {
        packages.add(specifier.split('/').slice(0, 2).join('/'))
      }
      if (Array.isArray(row?.config)) visit(row.config)
    }
  }
  visit(parseNativePresetPlugins(content))
  return packages
}

function parseNativePresetPlugins(content) {
  const value = parseYaml(content)
  if (!Array.isArray(value)) throw new Error('A frozen native DSH Agent preset is not a public plugin composition.')
  return value
}

function mergeNativePresetDocuments(left = [], right = []) {
  return [...new Map([...left, ...right].map(item => [item.id, item])).values()]
}

function emit(event) {
  process.send?.({ type: 'progress', event })
}

function sendError(error) {
  process.send?.({ type: 'error', code: error?.code, message: safeError(error?.message ?? error) })
}

function safeError(error) {
  return String(error?.message ?? error)
    .replace(/\bsk-[A-Za-z0-9_-]{16,}\b/gu, '[credential omitted]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/giu, 'Bearer [credential omitted]')
    .replace(/([?&](?:api[_-]?key|token|secret)=)[^&#\s]*/giu, '$1[credential omitted]')
}

function throwIfCancelled(signal) {
  if (signal.aborted) throw signal.reason ?? new Error('Trial cancelled.')
}

async function drainCancellation() {
  const sessionId = activeSessionId
  if (sessionId && activeContext?.sessionController?.cancel) {
    try { await activeContext.sessionController.cancel({ sessionId }) } catch {}
  }
  await activePromptWork?.catch(() => undefined)
  await active?.catch(() => undefined)
}

function sleep(milliseconds, signal) {
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise((resolveSleep, reject) => {
    const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolveSleep() }, milliseconds)
    const onAbort = () => { clearTimeout(timer); reject(signal.reason ?? new Error('Trial cancelled.')) }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`
  return JSON.stringify(value)
}

function packageManagerEnvironment() {
  const environment = {}
  for (const key of ['PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'COMSPEC']) {
    if (process.env[key] !== undefined) environment[key] = process.env[key]
  }
  environment.ELECTRON_RUN_AS_NODE = '1'
  environment.DSH_DESKTOP_NODE_EXECUTABLE = process.execPath
  return environment
}
