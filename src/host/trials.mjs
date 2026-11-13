import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { normalizeTeamConfig, teamError } from '../shared/schema.mjs'
import { resolveAuthorParameters } from '../shared/author-parameters.mjs'
import { stableJson } from './context-world-adapter.mjs'
import { traceAssociation } from './execution-trace.mjs'
import { readRunRows } from './run-persistence.mjs'
import { trialVariantStorageKey } from './trial-worker.mjs'
import { runTrialWorkerProcess } from './trial-worker-client.mjs'
import { TrialStorage } from './trial-storage.mjs'
import { captureTrialDependencies, freezeTrialData, validateFrozenTrialData } from './trial-frozen-data.mjs'
import { fileURLToPath } from 'node:url'

const LIVE_STATUSES = new Set(['queued', 'running', 'cancelling'])
const TERMINAL_STATUSES = new Set(['complete', 'failed', 'cancelled', 'interrupted'])
const SECRET_KEYS = new Set(['apikey', 'apitoken', 'token', 'credential', 'credentialref', 'secret', 'password', 'authorization', 'bearer', 'accesstoken', 'refreshtoken'])

/** Host-side durable scenario/trial API. Frozen source material is a plugin-owned public DSH archive. */
export function createTrialApi({
  ctx,
  store,
  stateStore,
  recoveryReady,
  isConversationBusy = () => false,
  getRunRecords = () => [],
  readState,
  getOptions,
  workerFactory = runTrialWorkerProcess,
  recoveryFactory,
}) {
  const recoveryWorkerFactory = recoveryFactory ?? (workerFactory === runTrialWorkerProcess ? runTrialWorkerProcess : undefined)
  const storage = new TrialStorage(store?.path, process.env.DSH_HOME)
  const activeWorkers = new Map()
  const launchingWorkers = new Map()
  const recoveryTasks = new Map()
  let shuttingDown = false
  const starting = Promise.resolve(recoveryReady).then(async () => {
    const document = storage.read()
    let changed = false
    for (const trial of Object.values(document.trials)) {
      const recovered = reconcileDurableWorkerState(trial, storage)
      changed ||= recovered
      if (LIVE_STATUSES.has(trial.status)) {
        reconcileIsolatedUsage(trial, storage, { includeUnreportedElapsed: false })
        trial.status = allVariantsComplete(trial) ? 'complete' : 'interrupted'
        trial.updatedAt = new Date().toISOString()
        const unknownResult = hasUnknownResult(trial)
        trial.failure = trial.status === 'complete' ? undefined
          : unknownResult ? 'A worker result has no committed checkpoint and needs confirmation before retry.'
            : 'The isolated worker stopped before the trial completed. Explicit retry resumes from the last committed checkpoint.'
        trial.failureCode = trial.status === 'complete' ? undefined
          : unknownResult ? 'RP_TEAM_TRIAL_RESULT_UNKNOWN' : 'RP_TEAM_TRIAL_WORKER_INTERRUPTED'
        for (const variant of trial.variants) {
          variant.status = variant.turns.length >= trial.scenario.steps.length ? 'complete' : 'interrupted'
          for (const attempt of variant.attempts ?? []) if ((attempt.status === 'running' || attempt.status === 'interrupted')
            && !knownUncommittedOutcome(attempt.commitOutcome)) {
            attempt.status = 'needs_confirmation'
          }
        }
        clearWorkerClock(trial)
        changed = true
      } else if (recovered) {
        trial.updatedAt = new Date().toISOString()
        if (allVariantsComplete(trial)) {
          trial.status = 'complete'
          trial.failure = undefined
          trial.failureCode = undefined
          for (const variant of trial.variants) variant.status = 'complete'
          clearWorkerClock(trial)
        }
      }
    }
    if (changed) storage.write(document)
    await recoverUnknownTrialAttempts()
  })

  async function listTrialScenarios() {
    await starting
    const scenarios = Object.values(storage.read().scenarios).map(scenario => ({
      id: scenario.id,
      name: scenario.name,
      stepCount: scenario.steps.length,
      updatedAt: scenario.updatedAt,
      ...(scenario.snapshotId ? { snapshotId: scenario.snapshotId } : {}),
    })).sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id))
    return { scenarios }
  }

  async function getTrialScenario({ scenarioId }) {
    await starting
    const scenario = storage.read().scenarios[requiredText(scenarioId, 'scenarioId')]
    if (!scenario) throw teamError('RP_TEAM_TRIAL_SCENARIO_NOT_FOUND', `Unknown trial scenario ${scenarioId}`)
    return { scenario: scrubCredentials(scenario) }
  }

  async function saveTrialScenario(input) {
    await starting
    const supplied = input?.scenario ?? input
    const scenario = normalizeScenario(supplied, input?.scenarioId)
    if (scenario.snapshotId && !storage.readSnapshot(scenario.snapshotId)) {
      throw teamError('RP_TEAM_TRIAL_SNAPSHOT_NOT_FOUND', `Unknown trial snapshot ${scenario.snapshotId}`)
    }
    const document = storage.read()
    const prior = document.scenarios[scenario.id]
    scenario.createdAt = prior?.createdAt ?? new Date().toISOString()
    scenario.updatedAt = new Date().toISOString()
    document.scenarios[scenario.id] = scenario
    storage.write(document)
    return { scenario: scrubCredentials(scenario) }
  }

  async function deleteTrialScenario({ scenarioId }) {
    await starting
    const id = requiredText(scenarioId, 'scenarioId')
    const document = storage.read()
    if (!document.scenarios[id]) throw teamError('RP_TEAM_TRIAL_SCENARIO_NOT_FOUND', `Unknown trial scenario ${id}`)
    delete document.scenarios[id]
    storage.write(document)
    return { deleted: true, scenarioId: id }
  }

  async function exportTrialScenario({ scenarioId, includeSnapshot = false }) {
    const { scenario } = await getTrialScenario({ scenarioId })
    const exported = {
      format: 'rp-team-trial-scenario',
      version: 1,
      scenario: structuredClone(scenario),
    }
    if (includeSnapshot === true && scenario.snapshotId) {
      const snapshot = storage.readSnapshot(scenario.snapshotId)
      if (!snapshot) throw teamError('RP_TEAM_TRIAL_SNAPSHOT_NOT_FOUND', `Unknown trial snapshot ${scenario.snapshotId}`)
      exported.snapshot = exportSnapshot(snapshot)
    }
    return { export: exported }
  }

  async function importTrialScenario({ export: value, scenario: supplied }) {
    await starting
    const imported = value ?? supplied
    if (imported?.format && (imported.format !== 'rp-team-trial-scenario' || imported.version !== 1)) {
      throw teamError('RP_TEAM_TRIAL_SCENARIO_INVALID', 'Unsupported trial scenario export.')
    }
    const scenario = normalizeScenario(imported?.scenario ?? imported)
    if (imported?.snapshot) {
      const snapshot = validateTrialSnapshot(imported.snapshot)
      snapshot.snapshotId = snapshot.snapshotId || createSnapshotId(snapshot)
      storage.writeSnapshot(snapshot.snapshotId, snapshot)
      scenario.snapshotId = snapshot.snapshotId
    }
    scenario.createdAt = new Date().toISOString()
    scenario.updatedAt = scenario.createdAt
    const document = storage.read()
    document.scenarios[scenario.id] = scenario
    storage.write(document)
    return { scenario: scrubCredentials(scenario) }
  }

  async function freezeTrialSnapshot({ conversationId }) {
    await starting
    const id = requiredText(conversationId, 'conversationId')
    if (await isConversationBusy(id)) throw teamError('RP_TEAM_TRIAL_SOURCE_BUSY', 'Wait for the selected conversation to finish before freezing a trial snapshot.')
    const config = store.get(id)
    const nativePresetIds = (config.config?.agents ?? []).map(agent => agent.presetId).filter(Boolean)
    const frozen = await freezeTrialData(ctx, { conversationId: id, nativePresetIds })
    const teamState = stateStore.committedSnapshot({ conversationId: id })
    const sourceState = readState ? await readState({ conversationId: id }) : undefined
    const snapshot = validateTrialSnapshot({
      ...frozen,
      teamState,
      sourceConfig: config.config,
      sourceParameterValues: config.parameterValues ?? {},
      sourceConfigEnabled: config.enabled === true,
      sourceState,
    })
    snapshot.snapshotId = createSnapshotId(snapshot)
    storage.writeSnapshot(snapshot.snapshotId, snapshot)
    return {
      snapshotId: snapshot.snapshotId,
      conversationId: id,
      createdAt: frozen.createdAt,
      summary: {
        title: frozen.details.conversation.title ?? '',
        messageCount: frozen.details.messages.length,
      },
    }
  }

  async function startTrial(input) {
    await starting
    const conversationId = requiredText(input?.conversationId, 'conversationId')
    const operationId = requiredText(input?.operationId, 'operationId')
    const scenario = normalizeScenario(input?.scenario, input?.scenario?.id || `trial-scenario-${hash(operationId).slice(0, 24)}`)
    const variants = normalizeVariants(input?.variants)
    const snapshotId = scenario.snapshotId ?? requiredText(input?.snapshotId, 'snapshotId')
    let snapshot = storage.readSnapshot(snapshotId)
    if (!snapshot) throw teamError('RP_TEAM_TRIAL_SNAPSHOT_NOT_FOUND', `Unknown trial snapshot ${snapshotId}`)
    scenario.snapshotId = snapshotId
    const resolvedVariants = variants.map(variant => resolveAuthorParameters(variant.config, variant.parameterValues).config)
    const modelRoutes = new Set([
      snapshot.modelSelection?.provider,
      ...resolvedVariants.flatMap(config => config.agents
        .filter(agent => agent.modelRef !== 'inherit')
        .map(agent => agent.modelRef.provider)),
    ].filter(value => typeof value === 'string' && value))
    const nativePresetIds = [...new Set(resolvedVariants.flatMap(config => config.agents
      .map(agent => agent.presetId).filter(Boolean)))]
    snapshot = await captureTrialDependencies(ctx, snapshot, {
      providerIds: [...modelRoutes], nativePresetIds,
    })
    snapshot.snapshotId = createSnapshotId(snapshot)
    storage.writeSnapshot(snapshot.snapshotId, snapshot)
    const budget = normalizeBudget(input?.budget, input?.turnBudget)
    const requestHash = hash({ conversationId, scenario, variants, budget, allowTrustedTools: input?.allowTrustedTools === true })
    const document = storage.read()
    const existing = Object.values(document.trials).find(trial => trial.operationId === operationId)
    if (existing) {
      if (existing.requestHash !== requestHash) throw teamError('RP_TEAM_TRIAL_OPERATION_CONFLICT', 'operationId was already used for a different trial request.')
      return { trialId: existing.trialId, status: existing.status, scopeId: existing.scopeId }
    }
    if (Object.values(document.trials).some(trial => LIVE_STATUSES.has(trial.status))) {
      throw teamError('RP_TEAM_TRIAL_BUSY', 'Only one isolated trial task can run at a time in this profile.')
    }
    const trialId = `trial-${randomUUID()}`
    const timestamp = new Date().toISOString()
    const record = {
      trialId,
      conversationId,
      sourceConversationId: snapshot.conversationId,
      operationId,
      requestHash,
      snapshotId: snapshot.snapshotId,
      status: 'queued',
      scopeId: `rp-team-trial:${trialId}`,
      scenario,
      variants: variants.map(variant => ({ ...variant, status: 'queued', turns: [], attempts: [], checkpointSnapshotId: snapshot.snapshotId })),
      budget,
      usage: { requests: 0, reportedTokens: 0, elapsedMs: 0 },
      allowTrustedTools: input?.allowTrustedTools === true,
      createdAt: timestamp,
      updatedAt: timestamp,
    }
    document.trials[trialId] = record
    storage.write(document)
    launch(record)
    return { trialId, status: record.status, scopeId: record.scopeId }
  }

  async function listTrials({ conversationId } = {}) {
    await starting
    const rows = Object.values(storage.read().trials)
      .filter(trial => !conversationId || trial.conversationId === conversationId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map(trial => ({
        trialId: trial.trialId,
        conversationId: trial.conversationId,
        sourceConversationId: trial.sourceConversationId,
        operationId: trial.operationId,
        status: trial.status,
        scopeId: trial.scopeId,
        scenarioName: trial.scenario.name,
        variantCount: trial.variants.length,
        completedTurns: trial.variants.reduce((sum, variant) => sum + variant.turns.length, 0),
        createdAt: trial.createdAt,
        updatedAt: trial.updatedAt,
      }))
    return { trials: rows }
  }

  async function getTrial({ trialId }) {
    await starting
    const trial = storage.read().trials[requiredText(trialId, 'trialId')]
    if (!trial) throw teamError('RP_TEAM_TRIAL_NOT_FOUND', `Unknown RP Team trial ${trialId}`)
    return publicTrial(trial)
  }

  async function cancelTrial({ trialId }) {
    await starting
    const id = requiredText(trialId, 'trialId')
    const trial = requireTrial(id)
    if (!LIVE_STATUSES.has(trial.status)) return publicTrial(trial)
    let worker = activeWorkers.get(id)
    if (!worker && launchingWorkers.has(id)) {
      updateTrial(id, record => { record.status = 'cancelled' })
      await launchingWorkers.get(id)
      worker = activeWorkers.get(id)
    }
    if (!worker) return publicTrial(requireTrial(id))
    updateTrial(id, record => { record.status = 'cancelling' })
    await worker.cancel('cancelled by user')
    await worker.done
    const settled = requireTrial(id)
    if (LIVE_STATUSES.has(settled.status)) updateTrial(id, record => { record.status = 'cancelled' })
    return publicTrial(requireTrial(id))
  }

  async function retryTrial({ trialId, operationId }) {
    await starting
    const id = requiredText(trialId, 'trialId')
    const retryOperationId = requiredText(operationId, 'operationId')
    await recoverUnknownTrialAttempts(id)
    updateTrial(id, record => {
      reconcileDurableWorkerState(record, storage)
      if (allVariantsComplete(record)) {
        record.status = 'complete'
        record.failure = undefined
        record.failureCode = undefined
        for (const variant of record.variants) variant.status = 'complete'
        clearWorkerClock(record)
      }
    })
    const trial = requireTrial(id)
    const retryOperationIds = trial.retryOperationIds ?? (trial.retryOperationId ? [trial.retryOperationId] : [])
    if (retryOperationIds.includes(retryOperationId)) {
      return { trialId: id, status: trial.status, scopeId: trial.scopeId }
    }
    if (!['interrupted', 'failed', 'cancelled'].includes(trial.status)) {
      throw teamError('RP_TEAM_TRIAL_NOT_RETRYABLE', `Trial ${id} cannot be retried from ${trial.status}.`)
    }
    if (trial.recoveryBlocked || trial.variants.some(variant =>
      (variant.attempts ?? []).some(attempt => attempt.status === 'needs_confirmation'))) {
      throw teamError('RP_TEAM_TRIAL_RESULT_UNKNOWN', 'A trial turn has no durable committed checkpoint. Confirm its product receipt before retrying so the model is not called twice.')
    }
    if (Object.values(storage.read().trials).some(row => row.trialId !== id && LIVE_STATUSES.has(row.status))) {
      throw teamError('RP_TEAM_TRIAL_BUSY', 'Another isolated trial task is active in this profile.')
    }
    const document = storage.read()
    const record = document.trials[id]
    record.retryOperationIds = [...(record.retryOperationIds ?? (record.retryOperationId ? [record.retryOperationId] : [])), retryOperationId]
    record.retryOperationId = retryOperationId
    record.status = 'queued'
    record.failure = undefined
    record.failureCode = undefined
    record.updatedAt = new Date().toISOString()
    for (const variant of record.variants) {
      variant.status = variant.turns.length >= record.scenario.steps.length ? 'complete' : 'queued'
    }
    storage.write(document)
    launch(record)
    return { trialId: id, status: 'queued', scopeId: record.scopeId }
  }

  async function getTrialTrajectory({ trialId, variantId, runId, cursor, limit = 100 }) {
    await starting
    const trial = requireTrial(requiredText(trialId, 'trialId'))
    const variant = trial.variants.find(item => item.id === requiredText(variantId, 'variantId'))
    if (!variant) throw teamError('RP_TEAM_TRIAL_VARIANT_NOT_FOUND', `Unknown trial variant ${variantId}`)
    const selectedRunId = requiredText(runId, 'runId')
    const evidence = [...variant.turns, ...(variant.attempts ?? [])]
      .find(item => item.runId === selectedRunId || item.attemptId === selectedRunId)
    if (!evidence || !Array.isArray(evidence.nativeEvents)) {
      throw teamError('RP_TEAM_TRIAL_TRAJECTORY_NOT_FOUND', `No native trajectory is available for run ${selectedRunId}`)
    }
    const page = decodeTrajectoryCursor(cursor)
    const pageLimit = normalizeLimit(limit)
    const rootEvents = evidence.nativeEvents
    const evidenceTurn = trialEvidenceTurn(evidence)
    const sessionEvidence = [...variant.turns, ...(variant.attempts ?? [])]
      .filter(item => item.sessionId === evidence.sessionId && isAtOrBeforeEvidence(item, evidence, evidenceTurn))
    const visibleTurns = [...new Set(sessionEvidence.map(trialEvidenceTurn).filter(Number.isSafeInteger))].sort((left, right) => left - right)
    const runsById = new Map()
    const executionsById = new Map()
    for (const item of sessionEvidence) {
      const run = item.trajectory?.run
      if (run?.runId) runsById.set(run.runId, run)
      for (const execution of item.trajectory?.executions ?? []) {
        const key = `${execution.runId}\u0000${execution.association?.sessionId ?? ''}`
        if (!executionsById.has(key)) executionsById.set(key, execution)
      }
    }
    const runs = [...runsById.values()].sort((left, right) => (left.turn ?? Number.MAX_SAFE_INTEGER) - (right.turn ?? Number.MAX_SAFE_INTEGER))
    const childExecutions = [...executionsById.values()]
    const nextEventOffset = Math.min(rootEvents.length, page.eventOffset + pageLimit)
    const nextExecutionOffset = Math.min(childExecutions.length, page.executionOffset + pageLimit)
    const eventPage = rootEvents.slice(0, nextEventOffset)
    const executionPage = childExecutions.slice(0, nextExecutionOffset)
    const next = {
      eventOffset: nextEventOffset,
      executionOffset: nextExecutionOffset,
    }
    const hasMore = next.eventOffset < rootEvents.length || next.executionOffset < childExecutions.length
    return {
      native: {
        visibleTurns,
        events: scrubCredentials(eventPage),
        executions: scrubCredentials(executionPage),
        runs: scrubCredentials(runs),
      },
      sourceSessionId: evidence.sessionId,
      hasMore,
      cursor: hasMore ? encodeTrajectoryCursor(next) : null,
    }
  }

  async function compareTrial({ trialId }) {
    const { trial } = await getTrial({ trialId })
    return {
      trialId,
      variants: trial.variants.map(variant => ({
        variantId: variant.id,
        label: variant.label,
        turns: variant.turns.map(turn => ({
          turn: turn.turn,
          body: scrubText(turn.body ?? ''),
          state: turn.state,
          usage: turn.usage,
          elapsedMs: turn.elapsedMs,
          status: turn.status,
          assertions: turn.assertions,
        })),
      })),
    }
  }

  function launch(record) {
    const id = record.trialId
    const launching = launchWorker(record).catch(error => {
      updateTrial(id, value => {
        if (LIVE_STATUSES.has(value.status)) {
          value.status = 'failed'
          value.failure = redactMessage(error?.message ?? String(error))
          for (const variant of value.variants) if (LIVE_STATUSES.has(variant.status)) variant.status = 'failed'
          value.updatedAt = new Date().toISOString()
        }
      })
    }).finally(() => { if (launchingWorkers.get(id) === launching) launchingWorkers.delete(id) })
    launchingWorkers.set(id, launching)
  }

  async function launchWorker(record) {
    const id = record.trialId
    const snapshot = storage.readSnapshot(record.snapshotId)
    const workerCredentials = await resolveWorkerCredentials(ctx, snapshot)
    if (shuttingDown || !LIVE_STATUSES.has(requireTrial(id).status)) return
    const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
    const hostBootstrap = workerFactory === runTrialWorkerProcess ? await resolveTrialHostBootstrap() : undefined
    // dispose() may have run while the bootstrap was resolving; a worker started now would never be cancelled.
    if (shuttingDown || !LIVE_STATUSES.has(requireTrial(id).status)) return
    const workerStartedAt = Date.now()
    const generation = workerGeneration(record)
    const worker = workerFactory({
      trialId: id,
      conversationId: record.conversationId,
      operationId: record.operationId,
      scopeId: record.scopeId,
      scenario: scrubCredentials(record.scenario),
      variants: structuredClone(record.variants),
      budget: structuredClone(record.budget),
      usage: structuredClone(record.usage),
      allowTrustedTools: record.allowTrustedTools,
      workerGeneration: generation,
      ...(hostBootstrap ?? {}),
      snapshot,
      snapshots: Object.fromEntries(record.variants.map(item => [item.id, storage.readSnapshot(item.checkpointSnapshotId)])),
      getRunRecords,
      pluginRoot,
      workerCredentials,
      workerRoot: storage.workerRoot(id, generation),
      workerCheckpointRoot: storage.durableWorkerRoot,
      onProgress: event => handleProgress(id, event),
    })
    updateTrial(id, value => {
      value.activeWorkerStartedAt = workerStartedAt
      value.activeWorkerElapsedBaseMs = Number(value.usage?.elapsedMs ?? 0)
      value.activeWorkerElapsedReportedMs = 0
    })
    activeWorkers.set(id, worker)
    updateTrial(id, value => { value.status = 'running' })
    worker.done.then(
      async () => settleWorker(id, undefined),
      async error => settleWorker(id, error),
    ).finally(() => { if (activeWorkers.get(id) === worker) activeWorkers.delete(id) })
  }

  async function resolveTrialHostBootstrap() {
    const desktopHostUrl = process.env.ELECKOI_DESKTOP_HOST_MODULE_URL
    if (typeof desktopHostUrl !== 'string' || !desktopHostUrl.startsWith('file:')) {
      throw new Error('The official desktop-host did not provide its public ESM module URL to the plugin worker.')
    }
    const desktopHost = await import(desktopHostUrl)
    if (typeof desktopHost.resolveDshDesktopResources !== 'function') {
      throw new Error('The official desktop-host package does not expose its DSH resource resolver.')
    }
    const resources = desktopHost.resolveDshDesktopResources()
    if (resources.hostModuleUrl !== desktopHostUrl) throw new Error('The official desktop-host resource descriptor resolved a different public module URL.')
    return { desktopHostUrl: resources.hostModuleUrl, resources }
  }

  async function recoverUnknownTrialAttempts(selectedTrialId) {
    if (!recoveryWorkerFactory || shuttingDown) return
    const ids = selectedTrialId ? [selectedTrialId] : Object.keys(storage.read().trials)
    for (const id of ids) {
      let task = recoveryTasks.get(id)
      if (!task) {
        task = recoverUnknownTrialAttemptsForTrial(id)
        recoveryTasks.set(id, task)
      }
      try { await task }
      finally { if (recoveryTasks.get(id) === task) recoveryTasks.delete(id) }
    }
  }

  async function recoverUnknownTrialAttemptsForTrial(id) {
    let hostBootstrap
    const initial = storage.read().trials[id]
    if (!initial) return
    for (const initialVariant of initial.variants) {
      for (const initialAttempt of initialVariant.attempts ?? []) {
          const document = storage.read()
          const record = document.trials[id]
          const variant = record?.variants.find(item => item.id === initialVariant.id)
          const attempt = variant?.attempts?.find(item => item.attemptId === initialAttempt.attemptId)
          if (!record || !variant || !attempt || attempt.status !== 'needs_confirmation') continue
          reconcileDurableWorkerState(record, storage)
          reconcileIsolatedUsage(record, storage, { includeUnreportedElapsed: false })
          storage.write(document)
          const currentVariant = record.variants.find(item => item.id === initialVariant.id)
          const currentAttempt = currentVariant?.attempts?.find(item => item.attemptId === initialAttempt.attemptId)
          if (!currentVariant || currentAttempt?.status !== 'needs_confirmation'
            || !Number.isSafeInteger(currentAttempt.workerGeneration)
            || typeof currentAttempt.sessionId !== 'string' || typeof currentAttempt.conversationId !== 'string'
            || !Number.isSafeInteger(currentAttempt.afterSeq) || typeof currentAttempt.attemptId !== 'string') continue
          const snapshotId = currentVariant.checkpointSnapshotId ?? record.snapshotId
          const snapshot = storage.readSnapshot(snapshotId)
          if (!snapshot) continue
          if (recoveryWorkerFactory === runTrialWorkerProcess && !hostBootstrap) {
            try { hostBootstrap = await resolveTrialHostBootstrap() }
            catch { continue }
          }
          const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
          let worker
          try {
            worker = recoveryWorkerFactory({
              recoveryOnly: true,
              trialId: id,
              variant: structuredClone(currentVariant),
              attempt: structuredClone(currentAttempt),
              scenario: structuredClone(record.scenario),
              budget: structuredClone(record.budget),
              usage: structuredClone(record.usage),
              allowTrustedTools: record.allowTrustedTools === true,
              snapshot,
              workerRoot: storage.workerRoot(id, currentAttempt.workerGeneration),
              workerCheckpointRoot: storage.durableWorkerRoot,
              pluginRoot,
              workerCredentials: {},
              ...(hostBootstrap ?? {}),
            })
            await worker.done
          } catch {
            continue
          }
          updateTrial(id, current => {
            reconcileDurableWorkerState(current, storage)
            if (allVariantsComplete(current)) {
              current.status = 'complete'
              current.failure = undefined
              current.failureCode = undefined
              for (const item of current.variants) item.status = 'complete'
              clearWorkerClock(current)
            } else if (hasUnknownResult(current)) {
              current.status = 'interrupted'
              current.failureCode = 'RP_TEAM_TRIAL_RESULT_UNKNOWN'
              current.failure = 'A worker result has no committed checkpoint and needs confirmation before retry.'
            } else if (!LIVE_STATUSES.has(current.status)) {
              current.status = 'interrupted'
              current.failureCode = 'RP_TEAM_TRIAL_WORKER_INTERRUPTED'
              current.failure = 'The isolated worker stopped. Retry resumes from the last committed checkpoint.'
            }
            current.updatedAt = new Date().toISOString()
          })
      }
    }
  }

  function handleProgress(trialId, event) {
    updateTrial(trialId, record => {
      if (event.type === 'trial:started') record.status = 'running'
      else if (event.type === 'variant:started') {
        const variant = findVariant(record, event.variantId)
        variant.status = 'running'
        variant.nativeConversationId = event.conversationId
        variant.sessionId = event.sessionId
        if (Number.isSafeInteger(event.workerGeneration)) variant.workerGeneration = event.workerGeneration
        if (event.parameterResolution) variant.parameterResolution = scrubCredentials(event.parameterResolution)
      } else if (event.type === 'turn:attempt-started') {
        const variant = findVariant(record, event.variantId)
        const attempt = structuredClone(event.attempt)
        variant.attempts ??= []
        variant.attempts = variant.attempts.filter(item => item.attemptId !== attempt.attemptId)
        variant.attempts.push(attempt)
      } else if (event.type === 'turn:receipt-verified') {
        const variant = findVariant(record, event.variantId)
        const attempt = (variant.attempts ?? []).find(item => item.attemptId === event.attemptId)
        if (attempt && event.conversationId === attempt.conversationId && event.sessionId === attempt.sessionId
          && typeof event.runId === 'string' && event.runId) {
          attempt.runId = event.runId
          attempt.nativeTurn = event.nativeTurn
          attempt.commitIdentity = {
            conversationId: event.conversationId, rootSessionId: event.rootSessionId,
            runId: event.runId, turn: event.nativeTurn, inputMessageId: event.inputMessageId,
            productCommitStaged: true,
          }
        }
      } else if (event.type === 'turn:attempt-progress') {
        const variant = findVariant(record, event.variantId)
        const attempt = (variant.attempts ?? []).find(item => item.attemptId === event.attemptId)
        if (attempt) {
          attempt.sessionId = event.sessionId ?? attempt.sessionId
          attempt.conversationId = event.conversationId ?? attempt.conversationId
          attempt.runId = event.runId ?? attempt.runId
          attempt.afterSeq = event.afterSeq ?? attempt.afterSeq
          if (Array.isArray(event.nativeEvents)) attempt.nativeEvents = structuredClone(event.nativeEvents)
          if (event.trajectory) attempt.trajectory = structuredClone(event.trajectory)
        }
      } else if (event.type === 'turn:attempt-settled') {
        const variant = findVariant(record, event.variantId)
        variant.attempts ??= []
        const attempt = structuredClone(event.attempt)
        if (!['failed', 'cancelled'].includes(attempt.commitOutcome)) attempt.status = 'needs_confirmation'
        variant.attempts = variant.attempts.filter(item => item.attemptId !== attempt.attemptId)
        variant.attempts.push(attempt)
        if (event.taskUsage) applyTaskUsage(record, event.taskUsage)
      } else if (event.type === 'turn:completed') {
        const variant = findVariant(record, event.variantId)
        const ack = storage.readWorkerCheckpoints(trialId, event.variantId)
          .find(row => row.turn === event.turn?.turn)
        if (!ack || ack.invalid || !validDurableCheckpoint(ack.value, trialId, event.variantId)
          || ack.value.turn.turn !== event.turn.turn || ack.value.turn.runId !== event.turn.runId) {
          record.recoveryBlocked = 'A turn-completed acknowledgement did not match its durable committed checkpoint.'
          const attempt = (variant.attempts ?? []).find(item => item.attemptId === event.turn?.attemptId)
          if (attempt) attempt.status = 'needs_confirmation'
        } else {
          applyDurableCheckpoint(record, variant, ack.value, storage)
        }
      } else if (event.type === 'variant:completed') findVariant(record, event.variantId).status = 'complete'
      else if (event.type === 'trial:completed') {
        record.status = 'complete'
        if (event.taskUsage) applyTaskUsage(record, event.taskUsage)
        clearWorkerClock(record)
      }
      else if (event.type === 'trial:cancelled') {
        record.status = 'cancelled'
        if (event.taskUsage) applyTaskUsage(record, event.taskUsage)
        for (const variant of record.variants) if (LIVE_STATUSES.has(variant.status)) variant.status = 'cancelled'
        clearWorkerClock(record)
      }
      else if (event.type === 'trial:failed') {
        record.status = event.interrupted ? 'interrupted' : 'failed'
        record.failureCode = event.code
        record.failure = redactMessage(event.message)
        const variant = record.variants.find(item => item.id === event.variantId)
        if (variant) { variant.status = record.status; variant.failure = record.failure }
        if (event.taskUsage) applyTaskUsage(record, event.taskUsage)
        clearWorkerClock(record)
      }
      record.updatedAt = new Date().toISOString()
    })
  }

  async function settleWorker(trialId, error) {
    updateTrial(trialId, record => {
      reconcileDurableWorkerState(record, storage)
      reconcileIsolatedUsage(record, storage)
      if (error) record.workerExitDiagnostic = redactMessage(error.message ?? String(error)).slice(-4096)
      if (allVariantsComplete(record)) {
        record.status = 'complete'
        record.failure = undefined
        record.failureCode = undefined
        for (const variant of record.variants) variant.status = 'complete'
        clearWorkerClock(record)
      } else if (!TERMINAL_STATUSES.has(record.status)) {
        record.status = record.status === 'cancelling' && !hasUnknownResult(record) ? 'cancelled' : 'interrupted'
        record.failureCode = error ? 'RP_TEAM_TRIAL_WORKER_INTERRUPTED' : record.failureCode
        for (const variant of record.variants) {
          if (LIVE_STATUSES.has(variant.status)) variant.status = variant.turns.length >= record.scenario.steps.length ? 'complete' : record.status
        }
        for (const variant of record.variants) for (const attempt of variant.attempts ?? []) {
          if ((attempt.status === 'running' || attempt.status === 'interrupted')
            && !knownUncommittedOutcome(attempt.commitOutcome)) attempt.status = 'needs_confirmation'
        }
        if (error) record.failure = redactMessage(error.message ?? String(error))
        else record.failure ??= 'The worker exited without a terminal trial result.'
      }
      if (hasUnknownResult(record) && record.status !== 'complete') {
        record.failureCode = 'RP_TEAM_TRIAL_RESULT_UNKNOWN'
        record.failure = 'A worker result has no committed checkpoint and needs confirmation before retry.'
      }
      clearWorkerClock(record)
      record.updatedAt = new Date().toISOString()
    })
  }

  function updateTrial(trialId, update) {
    const document = storage.read()
    const record = document.trials[trialId]
    if (!record) return
    update(record)
    storage.write(document)
  }

  function requireTrial(trialId) {
    const trial = storage.read().trials[trialId]
    if (!trial) throw teamError('RP_TEAM_TRIAL_NOT_FOUND', `Unknown RP Team trial ${trialId}`)
    return trial
  }

  function dispose() {
    shuttingDown = true
    for (const [trialId] of launchingWorkers) updateTrial(trialId, record => {
      if (LIVE_STATUSES.has(record.status)) {
        record.status = 'interrupted'
        for (const variant of record.variants) for (const attempt of variant.attempts ?? []) {
          if (attempt.status === 'running') attempt.status = 'interrupted'
        }
      }
    })
    const workers = [...activeWorkers.entries()]
    for (const [trialId] of workers) updateTrial(trialId, record => { record.status = 'cancelling' })
    return Promise.all([...launchingWorkers.values(), ...workers.map(async ([, worker]) => {
      await worker.cancel('plugin shutdown')
      await worker.done.catch(() => undefined)
    })])
  }

  return {
    listTrialScenarios, getTrialScenario, saveTrialScenario, deleteTrialScenario,
    exportTrialScenario, importTrialScenario, freezeTrialSnapshot, startTrial,
    listTrials, getTrial, cancelTrial, retryTrial, getTrialTrajectory, compareTrial,
    dispose,
    // Internal to the isolated worker's Host plugin; never exported by the Remote service.
    restoreTrialStateSnapshot({ conversationId, snapshot }) {
      stateStore.restoreCommittedSnapshot({ conversationId, snapshot })
    },
    captureTrialStateSnapshot({ conversationId }) {
      return stateStore.committedSnapshot({ conversationId })
    },
  }

  function findVariant(record, id) {
    const variant = record.variants.find(item => item.id === id)
    if (!variant) throw new Error(`Worker reported unknown trial variant ${id}.`)
    return variant
  }
}

function normalizeScenario(value, overrideId) {
  if (!isRecord(value)) throw teamError('RP_TEAM_TRIAL_SCENARIO_INVALID', 'A scenario object is required.')
  const name = requiredText(value.name, 'scenario.name').slice(0, 120)
  if (!Array.isArray(value.steps) || value.steps.length < 1 || value.steps.length > 100) {
    throw teamError('RP_TEAM_TRIAL_SCENARIO_INVALID', 'A scenario must contain 1 to 100 steps.')
  }
  const steps = value.steps.map((step, index) => {
    if (!isRecord(step)) throw teamError('RP_TEAM_TRIAL_SCENARIO_INVALID', `Scenario step ${index + 1} must be an object.`)
    const inputText = requiredText(step.inputText, `steps[${index}].inputText`)
    const assertions = step.assertions === undefined ? [] : step.assertions.map(normalizeAssertion)
    return { id: requiredText(step.id ?? `step-${index + 1}`, `steps[${index}].id`), inputText, assertions }
  })
  const initialState = value.initialState === undefined ? [] : normalizeInitialState(value.initialState)
  return {
    id: requiredText(overrideId ?? value.id ?? `scenario-${randomUUID()}`, 'scenario.id'),
    name,
    steps,
    initialState,
    ...(value.snapshotId === undefined ? {} : { snapshotId: requiredText(value.snapshotId, 'snapshotId') }),
    ...(value.createdAt ? { createdAt: String(value.createdAt) } : {}),
    ...(value.updatedAt ? { updatedAt: String(value.updatedAt) } : {}),
  }
}

function normalizeAssertion(value) {
  if (!isRecord(value) || !['body_contains', 'body_not_contains', 'single_output', 'state_equals'].includes(value.type)) {
    throw teamError('RP_TEAM_TRIAL_ASSERTION_INVALID', 'Unsupported trial assertion.')
  }
  if (value.type === 'body_contains' || value.type === 'body_not_contains') {
    return { type: value.type, text: requiredText(value.text, 'assertion.text') }
  }
  if (value.type === 'state_equals') {
    if (typeof value.namespace !== 'string' || typeof value.path !== 'string' || !value.path.startsWith('/')) {
      throw teamError('RP_TEAM_TRIAL_ASSERTION_INVALID', 'state_equals requires a namespace and JSON pointer path.')
    }
    return { type: value.type, namespace: value.namespace, path: value.path, value: structuredClone(value.value) }
  }
  return { type: value.type }
}

function normalizeInitialState(value) {
  if (!Array.isArray(value)) throw teamError('RP_TEAM_TRIAL_SCENARIO_INVALID', 'initialState must be an array.')
  return value.map((entry, index) => {
    if (!isRecord(entry) || typeof entry.namespace !== 'string' || typeof entry.path !== 'string') {
      throw teamError('RP_TEAM_TRIAL_SCENARIO_INVALID', `Initial-state row ${index + 1} is invalid.`)
    }
    return { namespace: entry.namespace, path: entry.path, value: structuredClone(entry.value) }
  })
}

function normalizeVariants(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 2) {
    throw teamError('RP_TEAM_TRIAL_VARIANTS_INVALID', 'A trial requires one or two sequential variants.')
  }
  const ids = new Set()
  return value.map((item, index) => {
    if (!isRecord(item)) throw teamError('RP_TEAM_TRIAL_VARIANTS_INVALID', `Variant ${index + 1} must be an object.`)
    const id = requiredText(item.id ?? `variant-${index + 1}`, `variants[${index}].id`)
    if (ids.has(id)) throw teamError('RP_TEAM_TRIAL_VARIANTS_INVALID', `Duplicate trial variant id ${id}.`)
    ids.add(id)
    const config = normalizeTeamConfig(item.config)
    return {
      id,
      label: requiredText(item.label ?? id, `variants[${index}].label`).slice(0, 120),
      config,
      parameterValues: structuredClone(item.parameterValues ?? {}),
    }
  })
}

function normalizeBudget(value, turnBudget) {
  const task = positiveLimits(value, { maxRequests: 64, maxReportedTokens: 128000, maxElapsedMs: 600000 })
  const turn = positiveLimits(turnBudget, { maxRequests: 32, maxReportedTokens: 64000, maxElapsedMs: 180000 })
  return { task, turn }
}

function positiveLimits(value, defaults) {
  if (value === undefined) return { ...defaults }
  if (!isRecord(value)) throw teamError('RP_TEAM_TRIAL_BUDGET_INVALID', 'Trial budget must be an object.')
  const result = {}
  for (const key of Object.keys(defaults)) {
    const item = value[key] ?? defaults[key]
    if (!Number.isSafeInteger(item) || item <= 0) throw teamError('RP_TEAM_TRIAL_BUDGET_INVALID', `${key} must be a positive integer.`)
    result[key] = item
  }
  return result
}

function publicTrial(record) {
  const trial = {
    trialId: record.trialId,
    conversationId: record.conversationId,
    sourceConversationId: record.sourceConversationId ?? record.conversationId,
    operationId: record.operationId,
    status: record.status,
    scopeId: record.scopeId,
    scenario: scrubCredentials(record.scenario),
    variants: record.variants.map(variant => ({
      id: variant.id,
      label: variant.label,
      config: scrubCredentials(variant.config),
      parameterValues: scrubCredentials(variant.parameterValues),
      ...(variant.parameterResolution ? { parameterResolution: scrubCredentials(variant.parameterResolution) } : {}),
      status: variant.status,
      turns: variant.turns.map(publicTurn),
      attempts: (variant.attempts ?? []).map(publicAttempt),
      ...(variant.failure ? { failure: redactMessage(variant.failure) } : {}),
    })),
    budget: structuredClone(record.budget),
    usage: structuredClone(record.usage),
    ...(record.failure ? { failure: redactMessage(record.failure) } : {}),
    ...(record.failureCode ? { failureCode: record.failureCode } : {}),
    ...(record.workerExitDiagnostic ? { workerExitDiagnostic: redactMessage(record.workerExitDiagnostic) } : {}),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  }
  return { trial }
}

function publicAttempt(value) {
  return {
    attemptId: value.attemptId,
    turn: value.turn,
    ...(Number.isSafeInteger(value.nativeTurn) ? { nativeTurn: value.nativeTurn } : {}),
    inputText: scrubText(value.inputText ?? ''),
    status: value.status,
    ...(value.runId ? { runId: value.runId } : {}),
    ...(value.sessionId ? { sessionId: value.sessionId } : {}),
    ...(value.error ? { error: redactMessage(value.error) } : {}),
    elapsedMs: value.elapsedMs ?? 0,
    ...(Array.isArray(value.nativeEvents) ? { trajectory: { runId: value.runId ?? value.attemptId, available: true } } : {}),
  }
}

function applyTaskUsage(record, taskUsage) {
  if (!taskUsage) return
  record.usage ??= { requests: 0, reportedTokens: 0, elapsedMs: 0 }
  for (const key of ['requests', 'reportedTokens', 'elapsedMs']) {
    if (Number.isFinite(taskUsage[key])) record.usage[key] = Math.max(record.usage[key] ?? 0, taskUsage[key])
  }
  if (taskUsage.reportedTokensKnown === false) record.usage.reportedTokensKnown = false
  else if (record.usage.reportedTokensKnown === undefined) record.usage.reportedTokensKnown = true
  if (Number.isFinite(record.activeWorkerElapsedBaseMs)) {
    record.activeWorkerElapsedReportedMs = Math.max(record.activeWorkerElapsedReportedMs ?? 0,
      Math.max(0, (taskUsage.elapsedMs ?? 0) - record.activeWorkerElapsedBaseMs))
  }
}

function clearWorkerClock(record) {
  delete record.activeWorkerStartedAt
  delete record.activeWorkerElapsedBaseMs
  delete record.activeWorkerElapsedReportedMs
}

function reconcileIsolatedUsage(record, storage, { includeUnreportedElapsed = true } = {}) {
  const runsById = new Map()
  for (const variant of record.variants) {
    const evidence = [...variant.turns, ...(variant.attempts ?? [])]
    const conversations = new Set([variant.nativeConversationId, ...evidence.map(item => item.conversationId)].filter(Boolean))
    for (let generation = 0; generation <= workerGeneration(record); generation += 1) {
      const runtimeRoot = join(storage.workerRoot(record.trialId, generation), trialVariantStorageKey(variant.id), 'userdata', 'runtime')
      const traceRoot = join(runtimeRoot, 'home', 'plugins', 'rp-agent-team', 'traces')
      const sessionRoot = join(runtimeRoot, 'sessions')
      for (const conversationId of conversations) {
        for (const row of readRunRows(traceRoot, conversationId)) {
          const runId = row.status?.runId
          if (runId) runsById.set(runId, { row, traceRoot, sessionRoot })
        }
      }
    }
    for (const item of evidence) {
      if (item.sessionId) {
        const generation = Number.isSafeInteger(item.workerGeneration) ? item.workerGeneration
          : Number.isSafeInteger(variant.workerGeneration) ? variant.workerGeneration : 0
        const runtimeRoot = join(storage.workerRoot(record.trialId, generation), trialVariantStorageKey(variant.id), 'userdata', 'runtime')
        const events = readSessionEvents(join(runtimeRoot, 'sessions'), item.sessionId)
        if (events.length > (item.nativeEvents?.length ?? 0)) item.nativeEvents = events
      }
    }
    for (const attempt of variant.attempts ?? []) {
      if (!attempt.sessionId || !attempt.conversationId) continue
      const inputMessageId = attemptInputMessageId(attempt)
      const matched = [...runsById.values()].find(({ row }) => {
        const status = row.status ?? {}
        return status.rootSessionId === attempt.sessionId
          && (inputMessageId ? status.inputMessageId === inputMessageId
            : Number.isSafeInteger(attempt.nativeTurn) && status.turn === attempt.nativeTurn)
      })
      if (!matched) continue
      const { row, sessionRoot } = matched
      const trace = {
        ...row.status,
        ...traceAssociation(row),
        configuration: row.config,
        events: structuredClone(row.trace?.events ?? []),
      }
      attempt.runId = row.status.runId
      if (Number.isSafeInteger(row.status.turn)) attempt.nativeTurn = row.status.turn
      attempt.trajectory = { run: trace, executions: readExecutionEvents(row, sessionRoot) }
    }
  }
  let requests = 0
  let reportedTokens = 0
  let elapsedMs = 0
  let tokensKnown = record.usage?.reportedTokensKnown !== false
  for (const { row } of runsById.values()) {
    const budget = row.status?.budget ?? row.budget ?? {}
    requests += Number(budget.requestCount ?? 0)
    reportedTokens += Number(budget.reportedTokens ?? 0)
    elapsedMs += Number(budget.elapsedMs ?? 0)
    if (budget.reportedTokensKnown === false || budget.failure?.code === 'RP_TEAM_BUDGET_USAGE_UNAVAILABLE'
      || hasUnfinishedRequest(row.trace?.events ?? [])) {
      tokensKnown = false
    }
  }
  record.usage ??= { requests: 0, reportedTokens: 0, elapsedMs: 0 }
  record.usage.requests = Math.max(record.usage.requests ?? 0, requests)
  record.usage.reportedTokens = Math.max(record.usage.reportedTokens ?? 0, reportedTokens)
  record.usage.elapsedMs = Math.max(record.usage.elapsedMs ?? 0, elapsedMs)
  record.usage.reportedTokensKnown = tokensKnown
  if (includeUnreportedElapsed && Number.isFinite(record.activeWorkerStartedAt)) {
    const workerElapsed = Math.max(0, Date.now() - record.activeWorkerStartedAt)
    record.usage.elapsedMs = Math.max(record.usage.elapsedMs ?? 0,
      (record.activeWorkerElapsedBaseMs ?? 0) + workerElapsed)
  }
}

function hasUnfinishedRequest(events) {
  const reserved = new Set()
  const finished = new Set()
  for (const event of events) {
    if (event.type !== 'budget.request') continue
    const invocationId = event.data?.invocationId
    if (!invocationId) continue
    if (event.data.stage === 'reserved') reserved.add(invocationId)
    else if (event.data.stage === 'finished') finished.add(invocationId)
  }
  return [...reserved].some(invocationId => !finished.has(invocationId))
}

function readSessionEvents(sessionRoot, sessionId) {
  if (!existsSync(sessionRoot)) return []
  for (const cwd of readdirSync(sessionRoot, { withFileTypes: true })) {
    if (!cwd.isDirectory()) continue
    const path = join(sessionRoot, cwd.name, sessionId, 'session.v4.jsonl')
    if (!existsSync(path)) continue
    const events = []
    for (const line of readFileSync(path, 'utf8').split(/\r?\n/u)) {
      if (!line) continue
      try {
        const row = JSON.parse(line)
        if (Number.isSafeInteger(row.seq) && typeof row.type === 'string') events.push(row)
      } catch { break }
    }
    return events
  }
  return []
}

function readExecutionEvents(row, sessionRoot) {
  return (row.executionSessions ?? []).map(association => ({
    runId: row.status.runId,
    association,
    events: readSessionEvents(sessionRoot, association.sessionId),
    loading: false,
  }))
}

function publicTurn(value) {
  return {
    runId: value.runId,
    turn: value.turn,
    ...(Number.isSafeInteger(value.nativeTurn ?? value.commitReceipt?.turn)
      ? { nativeTurn: value.nativeTurn ?? value.commitReceipt.turn } : {}),
    inputText: scrubText(value.inputText ?? ''),
    body: scrubText(value.body ?? ''),
    assertions: scrubCredentials(value.assertions ?? []),
    state: scrubCredentials(value.state ?? {}),
    usage: structuredClone(value.usage ?? {}),
    elapsedMs: value.elapsedMs ?? 0,
    status: value.status ?? 'complete',
    ...(value.error ? { error: redactMessage(value.error) } : {}),
    ...(value.sessionId ? { sessionId: value.sessionId } : {}),
    ...(value.trajectory ? { trajectory: { runId: value.runId, available: true } } : {}),
  }
}

function validateTrialSnapshot(value) {
  if (!isRecord(value)) throw teamError('RP_TEAM_TRIAL_SNAPSHOT_INVALID', 'The trial snapshot is incomplete.')
  return validateFrozenTrialData(value)
}

function reconcileDurableWorkerState(record, storage) {
  let changed = false
  const recoveryIssues = []
  for (const variant of record.variants) {
    variant.turns ??= []
    variant.attempts ??= []
    const checkpointRows = storage.readWorkerCheckpoints(record.trialId, variant.id)
      .sort((left, right) => (left.turn ?? 0) - (right.turn ?? 0))
    const committedAttemptIds = new Set()
    for (const row of checkpointRows) {
      if (row.invalid || !validDurableCheckpoint(row.value, record.trialId, variant.id)) {
        recoveryIssues.push(`${variant.id}:invalid checkpoint ${row.name}`)
        continue
      }
      const uncertainAttempt = variant.attempts.find(attempt => attempt.turn === row.value.turn.turn
        && attempt.status === 'needs_confirmation')
      if (uncertainAttempt && !checkpointMatchesAttempt(row.value, uncertainAttempt)) {
        recoveryIssues.push(`${variant.id}:checkpoint identity conflicts with uncertain attempt ${uncertainAttempt.attemptId}`)
        continue
      }
      committedAttemptIds.add(row.value.turn.attemptId)
      try { changed = applyDurableCheckpoint(record, variant, row.value, storage) || changed }
      catch (error) { recoveryIssues.push(`${variant.id}:invalid checkpoint ${row.name} (${safeReason(error)})`) }
    }

    for (const row of storage.readWorkerAttempts(record.trialId, variant.id)) {
      if (row.invalid) {
        recoveryIssues.push(`${variant.id}:invalid attempt marker ${row.name}`)
        continue
      }
      const attempt = row.attempt
      if (!attempt || committedAttemptIds.has(attempt.attemptId)) continue
      const known = row.stage === 'settled' && knownUncommittedOutcome(attempt.commitOutcome)
      const recoveredAttempt = { ...structuredClone(attempt), status: known ? attempt.status : 'needs_confirmation' }
      const priorIndex = variant.attempts.findIndex(item => item.attemptId === attempt.attemptId)
      if (priorIndex < 0) variant.attempts.push(recoveredAttempt)
      else variant.attempts[priorIndex] = { ...variant.attempts[priorIndex], ...recoveredAttempt }
      changed = true
    }
    for (const attempt of variant.attempts) {
      if ((attempt.status === 'running' || attempt.status === 'interrupted')
        && !knownUncommittedOutcome(attempt.commitOutcome)) {
        attempt.status = 'needs_confirmation'
        changed = true
      }
    }
  }
  const issue = recoveryIssues.length ? recoveryIssues.join('; ') : undefined
  if (record.recoveryBlocked !== issue) {
    record.recoveryBlocked = issue
    changed = true
  }
  return changed
}

function validDurableCheckpoint(value, trialId, variantId) {
  const receipt = value?.receipt
  const turn = value?.turn
  return value?.format === 'rp-team.trial-worker-checkpoint' && value.version === 1
    && value.trialId === trialId && value.variantId === variantId
    && receipt?.outcome === 'committed' && receipt.active === true
    && typeof receipt.conversationId === 'string' && typeof receipt.sessionId === 'string'
    && typeof receipt.runId === 'string' && Number.isSafeInteger(receipt.turn)
    && turn?.runId === receipt.runId && Number.isSafeInteger(turn.turn) && turn.turn > 0
    && (turn.nativeTurn ?? turn.commitReceipt?.turn) === receipt.turn
    && turn.conversationId === receipt.conversationId && turn.sessionId === receipt.sessionId
    && turn.commitReceipt?.outcome === 'committed' && turn.commitReceipt.active === true
    && turn.commitReceipt.runId === receipt.runId && turn.commitReceipt.conversationId === receipt.conversationId
    && turn.commitReceipt.sessionId === receipt.sessionId && turn.commitReceipt.turn === receipt.turn
    && isRecord(value.checkpoint)
}

function checkpointMatchesAttempt(checkpoint, attempt) {
  const receipt = checkpoint.receipt
  const expectedInputMessageId = attemptInputMessageId(attempt)
  return checkpoint.turn.attemptId === attempt.attemptId
    && receipt.conversationId === attempt.conversationId
    && receipt.sessionId === attempt.sessionId
    && (!attempt.runId || receipt.runId === attempt.runId)
    && (!Number.isSafeInteger(attempt.nativeTurn) || receipt.turn === attempt.nativeTurn)
    && (!expectedInputMessageId || receipt.inputMessageId === expectedInputMessageId)
}

function applyDurableCheckpoint(record, variant, ack, storage) {
  if (!validDurableCheckpoint(ack, record.trialId, variant.id)) return false
  const turn = structuredClone(ack.turn)
  const prior = variant.turns.find(item => item.turn === turn.turn)
  if (prior) {
    if (prior.runId !== turn.runId) throw new Error(`turn ${turn.turn} already has a different committed run`)
    if (!prior.commitReceipt) { prior.commitReceipt = structuredClone(ack.receipt); return true }
    return false
  }
  const expectedTurn = variant.turns.length + 1
  if (turn.turn !== expectedTurn) throw new Error(`expected turn ${expectedTurn}, found ${turn.turn}`)
  const snapshot = validateTrialSnapshot(ack.checkpoint)
  delete snapshot.snapshotId
  const checkpointId = createSnapshotId(snapshot)
  snapshot.snapshotId = checkpointId
  storage.writeSnapshot(checkpointId, snapshot)
  variant.turns.push(turn)
  variant.turns.sort((left, right) => left.turn - right.turn)
  variant.checkpointSnapshotId = checkpointId
  if (turn.attemptId) variant.attempts = variant.attempts.filter(item => item.attemptId !== turn.attemptId)
  if (turn.taskUsage) applyTaskUsage(record, turn.taskUsage)
  else {
    record.usage.requests += Number(turn.usage?.requests ?? 0)
    record.usage.reportedTokens += Number(turn.usage?.reportedTokens ?? 0)
    record.usage.elapsedMs += Number(turn.elapsedMs ?? 0)
  }
  if (variant.turns.length >= record.scenario.steps.length) variant.status = 'complete'
  return true
}

function knownUncommittedOutcome(value) { return value === 'failed' || value === 'cancelled' }
function safeReason(error) { return String(error?.message ?? error).replace(/[\r\n]/gu, ' ') }
function allVariantsComplete(record) {
  return record.variants.length > 0 && record.variants.every(variant => variant.turns.length >= record.scenario.steps.length)
}
function hasUnknownResult(record) {
  return Boolean(record.recoveryBlocked) || record.variants.some(variant =>
    (variant.attempts ?? []).some(attempt => attempt.status === 'needs_confirmation'))
}
function workerGeneration(record) {
  return (record.retryOperationIds ?? (record.retryOperationId ? [record.retryOperationId] : [])).length
}

function createSnapshotId(snapshot) {
  const value = structuredClone(snapshot)
  delete value.snapshotId
  return `trial-snapshot-${hash(value).slice(0, 32)}`
}

function exportSnapshot(snapshot) {
  const source = structuredClone(snapshot)
  if (source.character) source.character = scrubJsonBase64Document(source.character)
  for (const preset of source.productPresets ?? []) {
    if (preset.document) preset.document = scrubJsonBase64Document(preset.document)
  }
  source.nativePresetDocuments = (source.nativePresetDocuments ?? []).map(preset => scrubCredentials(preset))
  return scrubCredentials(source)
}

function scrubJsonBase64Document(document) {
  if (document?.mimeType !== 'application/json' || typeof document.base64 !== 'string') return document
  const parsed = JSON.parse(Buffer.from(document.base64, 'base64').toString('utf8'))
  return { ...document, base64: Buffer.from(JSON.stringify(scrubCredentials(parsed))).toString('base64') }
}

async function resolveWorkerCredentials(ctx, snapshot) {
  const credentials = {}
  for (const route of snapshot?.modelProviders ?? []) {
    const value = route?.settingsValue
    const refs = new Set([
      route?.entry?.credentialRef,
      value?.apiKeyEnv,
      value?.providers?.[route?.provider]?.apiKeyEnv,
      value?.[route?.provider]?.apiKeyEnv,
    ].filter(ref => typeof ref === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/u.test(ref)))
    for (const ref of refs) {
      const credential = await ctx.credentials?.resolve?.(ref)
      if (typeof credential?.value === 'string' && credential.value.length > 0) credentials[ref] = credential.value
    }
  }
  return credentials
}

function scrubCredentials(value) {
  if (Array.isArray(value)) return value.map(scrubCredentials)
  if (!value || typeof value !== 'object') return typeof value === 'string' ? scrubText(value) : value
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !SECRET_KEYS.has(key.replace(/[^a-z0-9]/giu, '').toLowerCase()))
    .map(([key, child]) => [key, scrubCredentials(child)]))
}

function scrubText(value) {
  return value
    .replace(/\bsk-[A-Za-z0-9_-]{16,}\b/gu, '[credential omitted]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/giu, 'Bearer [credential omitted]')
    .replace(/([?&](?:api[_-]?key|token|secret)=)[^&#\s]*/giu, '$1[credential omitted]')
}

function redactMessage(value) { return scrubText(String(value)) }

function normalizeLimit(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 500) throw teamError('RP_TEAM_TRIAL_CURSOR_INVALID', 'Trajectory page limit must be 1 to 500.')
  return value
}

function trialEvidenceTurn(evidence) {
  const runTurn = evidence.trajectory?.run?.turn
  if (Number.isSafeInteger(runTurn)) return runTurn
  const nativeTurn = evidence.nativeTurn ?? evidence.commitReceipt?.turn ?? evidence.commitIdentity?.turn
  if (Number.isSafeInteger(nativeTurn)) return nativeTurn
  const afterSeq = Number.isSafeInteger(evidence.afterSeq) ? evidence.afterSeq : -1
  const boundary = evidence.nativeEvents?.find(event => event.seq > afterSeq && event.type === 'turn/start')
    ?? evidence.nativeEvents?.find(event => event.seq > afterSeq && event.type === 'turn/end')
  return Number.isSafeInteger(boundary?.data?.turn) ? boundary.data.turn : undefined
}

function attemptInputMessageId(attempt) {
  if (typeof attempt.commitIdentity?.inputMessageId === 'string' && attempt.commitIdentity.inputMessageId) {
    return attempt.commitIdentity.inputMessageId
  }
  if (!Array.isArray(attempt.nativeEvents)) return undefined
  const afterSeq = Number.isSafeInteger(attempt.afterSeq) ? attempt.afterSeq : -1
  const input = attempt.nativeEvents.find(event => event?.type === 'user/message'
    && Number.isSafeInteger(event.seq) && event.seq > afterSeq)
  const id = input?.data?.id ?? input?.data?.message?.id
  return typeof id === 'string' && id ? id : undefined
}

function isAtOrBeforeEvidence(candidate, selected, selectedTurn) {
  if (candidate === selected) return true
  if (Number.isSafeInteger(candidate.afterSeq) && Number.isSafeInteger(selected.afterSeq)) {
    return candidate.afterSeq < selected.afterSeq
  }
  const candidateTurn = trialEvidenceTurn(candidate)
  return Number.isSafeInteger(candidateTurn) && Number.isSafeInteger(selectedTurn) && candidateTurn <= selectedTurn
}

function encodeTrajectoryCursor(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url')
}

function decodeTrajectoryCursor(value) {
  if (value === undefined || value === null || value === '') return { eventOffset: 0, executionOffset: 0 }
  try {
    const decoded = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))
    if (!isRecord(decoded) || !Number.isSafeInteger(decoded.eventOffset) || decoded.eventOffset < 0
      || !Number.isSafeInteger(decoded.executionOffset) || decoded.executionOffset < 0) throw new Error()
    return decoded
  } catch {
    throw teamError('RP_TEAM_TRIAL_CURSOR_INVALID', 'The trajectory cursor is invalid.')
  }
}

function requiredText(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw teamError('RP_TEAM_TRIAL_INPUT_INVALID', `${name} is required.`)
  return value.trim()
}

function isRecord(value) { return Boolean(value) && typeof value === 'object' && !Array.isArray(value) }
function hash(value) { return createHash('sha256').update(stableJson(value)).digest('hex') }
function safeName(value) { return String(value).replace(/[^a-z0-9-]/giu, '_') }
