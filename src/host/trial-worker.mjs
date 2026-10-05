import { createRequire } from 'node:module'
import { mkdirSync, writeFileSync } from 'node:fs'
import { delimiter, dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createHash, randomUUID } from 'node:crypto'
import { resolveAuthorParameters } from '../shared/author-parameters.mjs'

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
    active = runTrial(message.plan, cancellation.signal)
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

async function runTrial(plan, userSignal) {
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
        const before = await ctx.sessionController.inspect(sessionId)
        const afterSeq = before.events.at(-1)?.seq ?? -1
        const priorEnds = before.events.filter(event => event.type === 'turn/end').length
        throwIfCancelled(signal)
        const attemptId = `attempt-${randomUUID()}`
        const requestId = `rp-team-trial-${plan.trialId}-${variant.id}-${index + 1}-${randomUUID()}`
        currentAttempt = {
          attemptId, turn: index + 1, inputText: step.inputText, sessionId, conversationId,
          startedAt, afterSeq, requestId, variantId: variant.id, nativeEvents: before.events,
        }
        emit({ type: 'turn:attempt-started', variantId: variant.id, attempt: {
          attemptId, turn: index + 1, inputText: step.inputText, sessionId, conversationId, afterSeq,
          startedAt: new Date(startedAt).toISOString(), status: 'running', elapsedMs: 0,
          nativeEvents: before.events,
        } })
        activeSessionId = sessionId
        const turnController = new AbortController()
        const abortTurnFromTask = () => turnController.abort(signal.reason ?? new Error('Trial cancelled.'))
        if (signal.aborted) abortTurnFromTask()
        else signal.addEventListener('abort', abortTurnFromTask, { once: true })
        const promptWork = prepareTrialPrompt(ctx, {
          conversationId, sessionId, requestId, inputText: step.inputText,
        }, turnController.signal)
        activePromptWork = promptWork
        let turnExpired = false
        const turnTimer = setTimeout(() => {
          turnExpired = true
          const error = new Error(`Trial turn ${index + 1} elapsed-time budget was exhausted.`)
          error.code = 'RP_TEAM_TRIAL_TURN_BUDGET_EXHAUSTED'
          turnController.abort(error)
          void cancelCurrentSession()
        }, turnLimits.maxElapsedMs)
        let lastProgressSeq = before.events.at(-1)?.seq ?? -1
        const publishAttemptProgress = inspection => {
          const latestSeq = inspection.events.at(-1)?.seq ?? -1
          if (latestSeq === lastProgressSeq) return
          lastProgressSeq = latestSeq
          currentAttempt.nativeEvents = inspection.events
          emit({ type: 'turn:attempt-progress', variantId: variant.id, attemptId,
            sessionId, conversationId, afterSeq, nativeEvents: inspection.events })
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
        const receipt = await ctx.eleckoiProductData.getProductCommitStatus({ conversationId, runId: run.runId })
        if (receipt?.outcome !== 'committed') throw new Error(`Native Team turn ${index + 1} has no committed product receipt.`)
        const rootEvents = ended.inspection.events
        const body = run.publication?.body ?? ''
        const checks = evaluateAssertions(step.assertions, body, rootEvents, ended.event, await team.getState({ conversationId }))
        const trace = await team.getTrace({ conversationId, runId: run.runId })
        const executions = []
        for (const association of trace.executionSessions ?? []) {
          const inspection = await ctx.sessionController.inspect(association.sessionId)
          executions.push({ runId: run.runId, association, events: inspection.events })
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
        const frozen = await ctx.eleckoiTrialSnapshots.freeze({ conversationId })
        const checkpoint = {
          ...frozen.privateSnapshot,
          modelProviders: structuredClone(snapshot.modelProviders ?? []),
          referencedPresets: structuredClone(snapshot.referencedPresets ?? []),
          teamState: team.captureTrialStateSnapshot({ conversationId }),
          sourceState: currentState,
          sourceConfig: turnConfig,
          sourceParameterValues: variant.parameterValues,
          sourceConfigEnabled: true,
        }
        const turn = {
          runId: run.runId,
          turn: index + 1,
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
        }
        emit({ type: 'turn:completed', variantId: variant.id, turn, checkpoint })
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
      const attemptStatus = userSignal.aborted ? 'cancelled' : error?.code === 'RP_TEAM_TRIAL_WORKER_INTERRUPTED' ? 'interrupted' : 'failed'
      emit({ type: 'turn:attempt-settled', variantId: currentAttempt.variantId, attempt: {
        attemptId: currentAttempt.attemptId,
        turn: currentAttempt.turn,
        inputText: currentAttempt.inputText,
        conversationId: currentAttempt.conversationId,
        afterSeq: currentAttempt.afterSeq,
        status: attemptStatus,
        ...(evidence.runId ? { runId: evidence.runId } : {}),
        sessionId: currentAttempt.sessionId,
        error: safeError(error),
        elapsedMs: Math.max(0, Date.now() - currentAttempt.startedAt),
        nativeEvents: evidence.nativeEvents,
        trajectory: evidence.trajectory,
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
  return ctx.sessionController.prompt({
    sessionId,
    conversationId,
    requestId,
    mode: 'queue',
    content: [{ type: 'text', text: inputText }],
  }, signal)
}

async function startVariant({ plan, variant, snapshot, variantRoot, signal }) {
  if (!snapshot) throw new Error(`Variant ${variant.id} has no frozen snapshot.`)
  const hostRoot = resolve(plan.hostRoot)
  const hostRequire = createRequire(join(hostRoot, 'package.json'))
  const appBoot = await importResolved(hostRequire, '@deepseek-ai/dsh-app-boot')
  const profileBoot = await importResolved(hostRequire, '@deepseek-ai/dsh/profile-boot')
  const runtime = await importResolved(hostRequire, '@eleckoi/dsh-runtime')
  const userDataRoot = join(variantRoot, 'userdata')
  const runtimeDataRoot = join(userDataRoot, 'runtime')
  const home = join(runtimeDataRoot, 'home')
  const profilePath = join(home, 'profiles', 'desktop')
  const sessionRoot = join(runtimeDataRoot, 'sessions')
  const workspaceRoot = join(userDataRoot, 'workspace')
  const mediaRoot = join(userDataRoot, 'media')
  const patchPath = join(userDataRoot, 'trial-profile.patch.yml')
  const fixtureLog = join(userDataRoot, 'trial-model-fixture.jsonl')
  for (const path of [runtimeDataRoot, home, sessionRoot, workspaceRoot, mediaRoot]) mkdirSync(path, { recursive: true })
  writeFileSync(patchPath, [
    '- id: desktop-product-telemetry', '  disabled: true',
    '- id: product-analytics', '  disabled: true',
    ''
  ].join('\n'))

  const sourceBundles = profileBundles(appBoot, plan.sourceProfileDir)
  const { initProfile, loadProfileDirectory, PROFILE_TEMPLATES } = appBoot
  const { ELECKOI_DESKTOP_BUNDLES, ELECKOI_INSTALL_ANCHOR, registerDesktopBundles } = runtime
  const baseBundles = new Set([
    ...PROFILE_TEMPLATES.web.bundles,
    ...ELECKOI_DESKTOP_BUNDLES,
    // The official pi-ai adapter is a dsh-runtime dependency, not a profile plugin bundle.
    '@deepseek-ai/dsh-llm-pi-ai',
  ])
  const modelBundles = selectedModelBundles(plan.snapshot, sourceBundles, baseBundles)
  const presetBundles = selectedPresetBundles(plan.snapshot?.referencedPresets ?? [], sourceBundles, baseBundles)
  const selectedBundles = [...new Set([...modelBundles, ...presetBundles])]
  initProfile(profilePath, [...PROFILE_TEMPLATES.web.bundles, ...ELECKOI_DESKTOP_BUNDLES, ...selectedBundles])
  registerDesktopBundles(profilePath)
  const profile = loadProfileDirectory('dsh', profilePath, ELECKOI_INSTALL_ANCHOR)
  if (profile.skippedBundles?.length) throw new Error(`Trial profile is missing required bundles: ${profile.skippedBundles.join(', ')}`)

  const paths = {
    DSH_HOME: home,
    DSH_SESSION_ROOT: sessionRoot,
    DSH_CWD: workspaceRoot,
    ELECKOI_SESSION_SNAPSHOT_ROOT: join(runtimeDataRoot, 'session-snapshots'),
    ELECKOI_PRESET_ROOT: join(runtimeDataRoot, 'generated-presets'),
    ELECKOI_SESSION_BRIDGE_ROOT: join(runtimeDataRoot, 'session-bridges'),
    ELECKOI_PRESET_TEMPLATE_PATH: join(hostRoot, 'resources', 'dsh', 'agent-preset-template', 'agent.cordis.yml'),
    ELECKOI_DATABASE_PATH: join(userDataRoot, 'eleckoi-common.sqlite3'),
    ELECKOI_MEDIA_ROOT: mediaRoot,
    ELECKOI_WORKSPACE_ROOT: workspaceRoot,
    RP_TEAM_TRIAL_MODEL_LOG: fixtureLog,
    DSH_TELEMETRY_DISABLED: '1',
  }
  const nodeBinPath = join(hostRoot, 'resources', 'dsh', 'node-bin')
  const packageManagerPath = join(dirname(hostRequire.resolve('pnpm')), 'bin', 'pnpm.mjs')
  Object.assign(process.env, paths)
  const running = await profileBoot.runProfile({
    environment: appBoot.loadLayeredEnv('dsh', workspaceRoot),
    profile: 'desktop',
    resolvedProfile: { profile, installAnchor: ELECKOI_INSTALL_ANCHOR },
    patchFiles: [patchPath, join(hostRoot, 'resources', 'dsh', 'desktop-agent.patch.yml')],
    args: ['--no-open', '--port', '0'],
    packageManager: {
      command: process.execPath,
      args: ['--expose-internals', packageManagerPath],
      env: { ...process.env, ...paths, ELECTRON_RUN_AS_NODE: '1', DSH_DESKTOP_NODE_EXECUTABLE: process.execPath,
        PATH: `${nodeBinPath}${delimiter}${process.env.PATH ?? ''}` },
    },
  })
  const ctx = running.ctx
  try {
    throwIfCancelled(signal)
    const manager = ctx.pluginManager
    const installed = (await manager.listBundles()).find(bundle => bundle.name === '@rp-team/dsh-roleplay-team')
    if (!installed?.installed) {
      const result = await manager.installBundle(plan.pluginRoot)
      if (result.application !== 'applied') throw new Error(`The RP Team runtime could not be loaded into the isolated worker profile: ${JSON.stringify(result)}`)
    } else if (!installed.enabled) {
      const result = await manager.setBundleEnabled('@rp-team/dsh-roleplay-team', true)
      if (result.application !== 'applied') throw new Error('The RP Team runtime could not be enabled in the isolated worker profile.')
    }
    const team = ctx.rpAgentTeam
    if (!team || typeof team.getConfig !== 'function') throw new Error('The isolated RP Team runtime did not mount.')
    const seeded = await ctx.eleckoiTrialSnapshots.seed({ snapshot, trialId: plan.trialId, variantId: variant.id })
    const conversationId = seeded.conversationId
    const missingRoutes = (snapshot.modelProviders ?? []).filter(route =>
      !ctx.llm.listProviders().some(provider => provider.id === route.provider))
    if (missingRoutes.length) {
      throw new Error(`Selected model adapter route is missing from the isolated profile: ${missingRoutes.map(item => item.provider).join(', ')}.`)
    }
    await team.restoreTrialStateSnapshot({ conversationId, snapshot: snapshot.teamState ?? { revision: 0, namespaces: {}, pathVersions: {} } })

    const limits = remainingBudget(plan.budget, plan.usage ?? { requests: 0, reportedTokens: 0, elapsedMs: 0 })
    const effectiveConfig = remapAgentPresetIds(variant.config, seeded.presetIds)
        const parameterResolution = materializeTrialConfig(effectiveConfig, variant.parameterValues, limits, plan.budget.turn, {
          allowTrustedTools: plan.allowTrustedTools === true,
        })
    const { config } = parameterResolution
    const saved = await team.getConfig({ conversationId })
    await team.saveConfig({ conversationId, expectedRevision: saved.revision, enabled: true, config,
      parameterValues: variant.parameterValues })

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
    const inspection = await ctx.sessionController.inspect(sessionId)
    const latestSeq = inspection.events.at(-1)?.seq ?? -1
    const now = Date.now()
    if (onProgress && latestSeq !== lastReportedSeq && (lastReportedAt === 0 || now - lastReportedAt >= 1000)) {
      onProgress(inspection)
      lastReportedSeq = latestSeq
      lastReportedAt = now
    }
    const event = inspection.events.find(item => item.type === 'turn/end' && item.seq > afterSeq)
    if (event && inspection.events.filter(item => item.type === 'turn/end').length > priorEnds) return { inspection, event }
    await sleep(50, signal)
  }
  const error = new Error('The native Session did not finish the trial turn before its deadline.')
  error.code = 'RP_TEAM_TRIAL_WORKER_INTERRUPTED'
  throw error
}

async function collectAttemptEvidence({ ctx, conversationId, sessionId, priorRunId }) {
  const inspection = await ctx.sessionController.inspect(sessionId)
  const result = { nativeEvents: inspection.events, trajectory: { executions: [] } }
  const { run } = await ctx.rpAgentTeam.getStatus({ conversationId })
  if (!run?.runId || run.runId === priorRunId) return result
  result.runId = run.runId
  try {
    const trace = await ctx.rpAgentTeam.getTrace({ conversationId, runId: run.runId })
    result.trajectory.run = trace
    for (const association of trace.executionSessions ?? []) {
      const child = await ctx.sessionController.inspect(association.sessionId)
      result.trajectory.executions.push({ runId: run.runId, association, events: child.events })
    }
  } catch {
    // A run that failed before trace projection still has its native root Session evidence.
  }
  return result
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

function profileBundles(appBoot, sourceProfileDir) {
  if (!sourceProfileDir) return []
  const manifest = appBoot.readProfileManifest('dsh', sourceProfileDir)
  const bundles = manifest?.dsh?.profile?.bundles
  if (!Array.isArray(bundles)) throw new Error('The source DSH profile has no selected bundle manifest for this trial.')
  return bundles.filter(bundle => typeof bundle === 'string')
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

function selectedPresetBundles(presets, sourceBundles, baseBundles) {
  const selected = new Set()
  const visit = rows => {
    for (const row of rows ?? []) {
      if (!row || typeof row !== 'object') continue
      const specifier = row.name
      if (typeof specifier === 'string' && specifier.startsWith('@') && !baseBundles.has(specifier)) {
        if (!sourceBundles.includes(specifier)) {
          throw new Error(`The source profile is missing a plugin required by a selected Team preset: ${specifier}.`)
        }
        selected.add(specifier)
      }
      if (Array.isArray(row.config)) visit(row.config)
    }
  }
  for (const preset of presets) visit(preset.plugins)
  return [...selected]
}

function remapAgentPresetIds(config, presetIds = {}) {
  const result = structuredClone(config)
  for (const agent of result.agents ?? []) if (presetIds[agent.presetId]) agent.presetId = presetIds[agent.presetId]
  return result
}

async function importResolved(hostRequire, specifier) {
  return import(pathToFileURL(hostRequire.resolve(specifier)).href)
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

function safePart(value) { return String(value).replace(/[^a-z0-9-]/giu, '_') }

export function trialVariantStorageKey(variantId) {
  const id = String(variantId)
  return `${safePart(id).slice(0, 40)}-${createHash('sha256').update(id).digest('hex').slice(0, 32)}`
}
