import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTrialApi } from '../src/host/trials.mjs'
import { reconcileTrialAttemptFromHost, restoreTrialNativePresetDocuments } from '../src/host/trial-worker.mjs'
import { TrialStorage, writeDurableTrialAttempt, writeDurableTrialAttemptSettlement } from '../src/host/trial-storage.mjs'
import { defaultTeamConfig } from '../src/shared/schema.mjs'
import { createTrialPublicHost, sourceArchive } from './fixtures/trial-public-host.mjs'

function fixture(outcome = 'committed', options = {}) {
  const { includeTurnEnd = true } = options
  const conversationId = 'source-chat'
  const sessionId = 'source-session'
  const binding = Object.hasOwn(options, 'binding') ? options.binding : { rootSessionId: sessionId }
  const detailsRuntimeSessionId = options.detailsRuntimeSessionId ?? sessionId
  const runId = 'committed-run-42'
  const inputMessageId = 'trial-input-42'
  const assistantMessageId = 'trial-assistant-42'
  const inputText = 'Continue with one short detail.'
  const nativeTurn = 4
  const events = [
    { seq: 8, type: 'user/message', data: { id: inputMessageId, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: inputText }] } },
    ...(outcome === 'committed' ? [{ seq: 9, type: 'assistant/message', data: { turn: nativeTurn, message: { id: assistantMessageId, role: 'assistant', content: [{ type: 'text', text: 'Recovered native answer.' }] } } }] : []),
    ...(includeTurnEnd ? [{ seq: 10, type: 'turn/end', data: { turn: nativeTurn, reason: { kind: outcome === 'committed' ? 'completed' : 'error' } } }] : []),
  ]
  const archive = structuredClone(sourceArchive)
  archive.sessionLogs = [{ ...archive.sessionLogs[0], header: { ...archive.sessionLogs[0].header, id: sessionId }, events }]
  const host = createTrialPublicHost()
  host.ctx.eleckoiConversationsApi.details = async id => ({
    conversation: { id, title: 'Receipt recovery fixture', characterId: 'source-character' },
    runtimeSessionId: detailsRuntimeSessionId, messages: [],
  })
  host.ctx.eleckoiConversationsApi.exportArchive = async () => JSON.stringify(archive)
  host.ctx.eleckoiConversationsApi.turnCommitStatus = async ({ conversationId: id, runId: requestedRunId }) => {
    assert.equal(id, conversationId)
    assert.equal(requestedRunId, runId)
    return { outcome, active: Object.hasOwn(options, 'active') ? options.active : outcome === 'committed', conversationId, runId, sessionId,
      turn: nativeTurn, inputMessageId, assistantMessageId, assistantSeq: 9 }
  }
  const apiCalls = { preparePrompt: 0, prompt: 0 }
  host.ctx.eleckoiConversationsApi.preparePrompt = async () => { apiCalls.preparePrompt += 1; throw new Error('recovery must not prepare a prompt') }
  host.ctx.sessionQuery.observeSession = async id => {
    assert.equal(id, sessionId)
    return { events, [Symbol.dispose]() {} }
  }
  host.ctx.sessionController.prompt = async () => { apiCalls.prompt += 1; throw new Error('recovery must not dispatch a prompt') }
  const state = { revision: 7, worldHash: 'world-7', values: [] }
  host.ctx.rpAgentTeam = {
    getStatus: async () => ({ binding, run: {
      runId, conversationId, phase: outcome === 'committed' ? 'complete' : 'failed', turn: nativeTurn,
      inputMessageId, inputEventSeq: 8, productCommitStaged: outcome === 'committed',
      publication: { body: 'Recovered native answer.' }, budget: { requestCount: 2, reportedTokens: 12, elapsedMs: 90 },
    } }),
    getConfig: async () => ({ enabled: true, revision: 2, config: { agents: options.configAgents ?? [] } }),
    getState: async () => state,
    getTrace: async () => ({ runId, executionSessions: [] }),
    captureTrialStateSnapshot: () => ({ revision: 7, namespaces: { world: { mood: 'steady' } }, pathVersions: {} }),
  }
  const attempt = { attemptId: 'attempt-42', turn: 1, inputText, sessionId, conversationId, afterSeq: 7,
    workerGeneration: 0, status: 'needs_confirmation' }
  const plan = {
    trialId: 'trial-recovery-fixture', variant: { id: 'single', parameterValues: {} }, attempt,
    scenario: { steps: [{ inputText, assertions: [{ type: 'body_contains', text: 'Recovered' }] }] },
    snapshot: { modelProviders: [], productPresets: [], nativePresetDocuments: [], rootNativePresetId: 'native-root' },
    usage: { requests: 0, reportedTokens: 0, elapsedMs: 0 },
  }
  return { ctx: host.ctx, plan, apiCalls, runId, conversationId, sessionId, inputMessageId, assistantMessageId, nativeTurn }
}

test('official committed receipt restores the exact turn checkpoint without model dispatch', async () => {
  const home = mkdtempSync(join(tmpdir(), 'rp-team-receipt-recovery-'))
  try {
    const storage = new TrialStorage(join(home, 'config.json'))
    const { ctx, plan, apiCalls, runId, conversationId, sessionId, inputMessageId, assistantMessageId, nativeTurn } = fixture()
    plan.workerCheckpointRoot = storage.durableWorkerRoot
    const result = await reconcileTrialAttemptFromHost(ctx, plan)
    assert.deepEqual(result, { outcome: 'committed', runId, turn: 1 })
    assert.deepEqual(apiCalls, { preparePrompt: 0, prompt: 0 })
    const rows = storage.readWorkerCheckpoints(plan.trialId, plan.variant.id)
    assert.equal(rows.length, 1)
    assert.equal(rows[0].invalid, undefined)
    const { receipt, turn, checkpoint } = rows[0].value
    assert.equal(receipt.outcome, 'committed')
    assert.equal(receipt.runId, runId)
    assert.equal(receipt.conversationId, conversationId)
    assert.equal(receipt.sessionId, sessionId)
    assert.equal(receipt.turn, nativeTurn)
    assert.equal(receipt.inputMessageId, inputMessageId)
    assert.equal(receipt.assistantMessageId, assistantMessageId)
    assert.equal(turn.attemptId, plan.attempt.attemptId)
    assert.equal(turn.workerGeneration, 0)
    assert.equal(turn.body, 'Recovered native answer.')
    assert.deepEqual(checkpoint.teamState, { revision: 7, namespaces: { world: { mood: 'steady' } }, pathVersions: {} })
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('cold receipt recovery uses official conversation details when the runtime binding is absent', async () => {
  const home = mkdtempSync(join(tmpdir(), 'rp-team-receipt-cold-binding-'))
  try {
    const storage = new TrialStorage(join(home, 'config.json'))
    const { ctx, plan, apiCalls, runId, sessionId } = fixture('committed', { binding: null, configAgents: [{ presetId: 'native-member' }] })
    const document = await ctx.agentPresets.readDocument('native-member')
    plan.snapshot.nativePresetDocuments = [{ id: document.agentPreset, name: document.name,
      description: document.description, content: document.content }]
    plan.workerCheckpointRoot = storage.durableWorkerRoot
    assert.deepEqual(await reconcileTrialAttemptFromHost(ctx, plan), { outcome: 'committed', runId, turn: 1 })
    assert.deepEqual(apiCalls, { preparePrompt: 0, prompt: 0 })
    const checkpoint = storage.readWorkerCheckpoints(plan.trialId, plan.variant.id)[0].value
    assert.equal(checkpoint.turn.sessionId, sessionId)
    assert.ok(checkpoint.checkpoint.nativePresetDocuments.some(item => item.id === 'native-member'),
      'The committed checkpoint must retain the exact captured preset document without requiring a process-local registry entry.')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('a present runtime binding that conflicts with official conversation details stays unknown', async () => {
  const home = mkdtempSync(join(tmpdir(), 'rp-team-receipt-binding-conflict-'))
  try {
    const storage = new TrialStorage(join(home, 'config.json'))
    const { ctx, plan, apiCalls } = fixture('committed', { binding: { rootSessionId: 'other-session' } })
    plan.workerCheckpointRoot = storage.durableWorkerRoot
    assert.deepEqual(await reconcileTrialAttemptFromHost(ctx, plan), { outcome: 'unknown' })
    assert.deepEqual(apiCalls, { preparePrompt: 0, prompt: 0 })
    assert.deepEqual(storage.readWorkerCheckpoints(plan.trialId, plan.variant.id), [])
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('cold recovery restores a missing captured native preset through the official registry', async () => {
  const { ctx } = createTrialPublicHost()
  const document = await ctx.agentPresets.readDocument('native-member')
  const originalList = ctx.agentPresets.list
  ctx.agentPresets.list = async () => (await originalList()).filter(({ id }) => id !== 'native-member')
  await restoreTrialNativePresetDocuments(ctx, [{ id: document.agentPreset, name: document.name,
    description: document.description, content: document.content }])
  ctx.agentPresets.list = originalList
  assert.deepEqual(await ctx.agentPresets.readDocument('native-member'), document)
})

test('cold recovery rejects a same-ID native preset with different plugin content', async () => {
  const { ctx } = createTrialPublicHost()
  const document = await ctx.agentPresets.readDocument('native-member')
  await assert.rejects(restoreTrialNativePresetDocuments(ctx, [{ id: document.agentPreset, ...document, content: '[]' }]),
    /different native Agent preset/u)
})

test('cold recovery propagates a read error for a listed preset without registering over it', async () => {
  const { ctx } = createTrialPublicHost()
  const document = await ctx.agentPresets.readDocument('native-member')
  let registerCalls = 0
  const originalRead = ctx.agentPresets.readDocument
  const originalRegister = ctx.agentPresets.register
  ctx.agentPresets.readDocument = async id => {
    if (id === 'native-member') throw new Error('Existing native preset document is unreadable.')
    return originalRead(id)
  }
  ctx.agentPresets.register = async definition => { registerCalls += 1; return originalRegister(definition) }
  await assert.rejects(restoreTrialNativePresetDocuments(ctx, [{ id: document.agentPreset, ...document }]),
    /Existing native preset document is unreadable/u)
  assert.equal(registerCalls, 0)
})

test('an official failed receipt settles the attempt without requiring a completed turn event', async () => {
  const home = mkdtempSync(join(tmpdir(), 'rp-team-receipt-failed-'))
  try {
    const storage = new TrialStorage(join(home, 'config.json'))
    const { ctx, plan, apiCalls, runId } = fixture('failed', { includeTurnEnd: false })
    plan.workerCheckpointRoot = storage.durableWorkerRoot
    assert.deepEqual(await reconcileTrialAttemptFromHost(ctx, plan), { outcome: 'failed', runId })
    assert.deepEqual(apiCalls, { preparePrompt: 0, prompt: 0 })
    assert.deepEqual(storage.readWorkerCheckpoints(plan.trialId, plan.variant.id), [])
    const attempts = storage.readWorkerAttempts(plan.trialId, plan.variant.id)
    assert.equal(attempts.length, 1)
    assert.equal(attempts[0].stage, 'settled')
    assert.equal(attempts[0].attempt.status, 'failed')
    assert.equal(attempts[0].attempt.commitEvidence, 'host-receipt')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('unknown receipt leaves the attempt unresolved and does not create a checkpoint', async () => {
  const home = mkdtempSync(join(tmpdir(), 'rp-team-receipt-unknown-'))
  try {
    const storage = new TrialStorage(join(home, 'config.json'))
    const { ctx, plan, apiCalls } = fixture('unknown')
    plan.workerCheckpointRoot = storage.durableWorkerRoot
    assert.deepEqual(await reconcileTrialAttemptFromHost(ctx, plan), { outcome: 'unknown' })
    assert.deepEqual(apiCalls, { preparePrompt: 0, prompt: 0 })
    assert.deepEqual(storage.readWorkerCheckpoints(plan.trialId, plan.variant.id), [])
    assert.deepEqual(storage.readWorkerAttempts(plan.trialId, plan.variant.id), [])
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('committed receipt with missing active-branch status remains unknown', async () => {
  const home = mkdtempSync(join(tmpdir(), 'rp-team-receipt-active-unknown-'))
  try {
    const storage = new TrialStorage(join(home, 'config.json'))
    const { ctx, plan, apiCalls } = fixture('committed', { active: undefined })
    plan.workerCheckpointRoot = storage.durableWorkerRoot
    assert.deepEqual(await reconcileTrialAttemptFromHost(ctx, plan), { outcome: 'unknown' })
    assert.deepEqual(apiCalls, { preparePrompt: 0, prompt: 0 })
    assert.deepEqual(storage.readWorkerCheckpoints(plan.trialId, plan.variant.id), [])
    assert.deepEqual(storage.readWorkerAttempts(plan.trialId, plan.variant.id), [])
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('receipt recovery requires the official run to identify the exact Session input sequence', async () => {
  const home = mkdtempSync(join(tmpdir(), 'rp-team-receipt-input-seq-'))
  try {
    const storage = new TrialStorage(join(home, 'config.json'))
    const { ctx, plan, apiCalls } = fixture()
    const getStatus = ctx.rpAgentTeam.getStatus
    ctx.rpAgentTeam.getStatus = async args => {
      const status = await getStatus(args)
      status.run.inputEventSeq += 1
      return status
    }
    plan.workerCheckpointRoot = storage.durableWorkerRoot
    assert.deepEqual(await reconcileTrialAttemptFromHost(ctx, plan), { outcome: 'unknown' })
    assert.deepEqual(apiCalls, { preparePrompt: 0, prompt: 0 })
    assert.deepEqual(storage.readWorkerCheckpoints(plan.trialId, plan.variant.id), [])
    assert.deepEqual(storage.readWorkerAttempts(plan.trialId, plan.variant.id), [])
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('concurrent same-operation retries share one receipt-recovery worker', async () => {
  const home = mkdtempSync(join(tmpdir(), 'rp-team-receipt-dedup-'))
  const config = defaultTeamConfig()
  const { ctx } = createTrialPublicHost()
  const storage = new TrialStorage(join(home, 'config.json'))
  let normalStarts = 0
  let recoveryStarts = 0
  let releaseRecovery
  const recoveryGate = new Promise(resolve => { releaseRecovery = resolve })
  let releaseRetry
  const retryGate = new Promise(resolve => { releaseRetry = resolve })
  const api = createTrialApi({
    ctx,
    store: { path: join(home, 'config.json'), get: () => ({ config, enabled: true }) },
    stateStore: { committedSnapshot: () => ({ revision: 0, namespaces: {}, pathVersions: {} }) },
    workerFactory: plan => {
      normalStarts += 1
      if (normalStarts === 1) {
        const attempt = { attemptId: 'unknown-attempt', turn: 1, inputText: 'one', conversationId: 'native-A',
          sessionId: 'session-A', afterSeq: 0, workerGeneration: 0, status: 'running' }
        writeDurableTrialAttempt(plan.workerCheckpointRoot, plan.trialId, 'A', attempt)
        return { done: Promise.reject(new Error('worker exited after unknown dispatch')), cancel: async () => undefined }
      }
      return { done: retryGate, cancel: async () => releaseRetry({ cancelled: true }) }
    },
    recoveryFactory: plan => {
      recoveryStarts += 1
      const settled = { ...plan.attempt, status: 'failed', commitOutcome: 'failed', commitEvidence: 'host-receipt' }
      writeDurableTrialAttemptSettlement(plan.workerCheckpointRoot, plan.trialId, plan.variant.id, settled)
      return { done: recoveryGate }
    },
  })
  try {
    await api.listTrials()
    const frozen = await api.freezeTrialSnapshot({ conversationId: 'source-chat' })
    const started = await api.startTrial({ conversationId: 'source-chat', operationId: 'dedupe-retry-start',
      scenario: { name: 'Retry lock', snapshotId: frozen.snapshotId, steps: [{ inputText: 'one' }] },
      variants: [{ id: 'A', config }] })
    await waitFor(async () => (await api.getTrial({ trialId: started.trialId })).trial.status === 'interrupted')
    const first = api.retryTrial({ trialId: started.trialId, operationId: 'same-retry-operation' })
    await waitFor(() => recoveryStarts === 1)
    const second = api.retryTrial({ trialId: started.trialId, operationId: 'same-retry-operation' })
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(recoveryStarts, 1, 'Only one worker may open the original generation profile for one trial.')
    releaseRecovery()
    const results = await Promise.all([first, second])
    assert.equal(recoveryStarts, 1)
    assert.equal(normalStarts, 2, 'A duplicate same-operation retry must launch only one resumed worker.')
    assert.ok(results.every(result => result.trialId === started.trialId))
    assert.equal((await api.getTrial({ trialId: started.trialId })).trial.variants[0].attempts[0].status, 'failed')
  } finally {
    releaseRecovery()
    await api.dispose()
    rmSync(home, { recursive: true, force: true })
  }
})

async function waitFor(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('Timed out waiting for receipt recovery fixture state.')
}
