import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createTrialApi } from '../src/host/trials.mjs'
import { classifyAttemptCommitOutcome, trialVariantStorageKey } from '../src/host/trial-worker.mjs'
import { defaultTeamConfig } from '../src/shared/schema.mjs'
import { TrialStorage, writeDurableTrialAttempt, writeDurableTrialAttemptSettlement, writeDurableTrialCheckpoint } from '../src/host/trial-storage.mjs'
import { runFilePath } from '../src/host/run-persistence.mjs'
import { createTrialPublicHost } from './fixtures/trial-public-host.mjs'

test('cold restart recovers a committed worker checkpoint written before a lost IPC ack', async () => {
  const home = mkdtempSync(join(tmpdir(), 'rp-team-trial-durable-checkpoint-'))
  const workers = []
  const modelCalls = []
  const config = defaultTeamConfig()
  const teamState = { revision: 0, namespaces: {}, pathVersions: {} }
  const storage = new TrialStorage(join(home, 'config.json'))
  const { ctx } = createTrialPublicHost()
  const makeApi = () => createTrialApi({
    ctx,
    store: { path: join(home, 'config.json'), get: () => ({ config, enabled: true }) },
    stateStore: { committedSnapshot: () => teamState },
    workerFactory: plan => {
      let finish
      const done = new Promise((resolve, reject) => { finish = { resolve, reject } })
      const worker = {
        plan, done,
        cancel: async () => {
          plan.onProgress({ type: 'trial:cancelled', taskUsage: { requests: modelCalls.length, reportedTokens: 0, elapsedMs: 1 } })
          finish.resolve({ cancelled: true })
        },
      }
      workers.push(worker)
      assert.equal(plan.workerGeneration, workers.length - 1)
      assert.equal(plan.workerRoot, storage.workerRoot(plan.trialId, plan.workerGeneration))
      if (workers.length === 1) {
        const variantId = 'A'
        plan.onProgress({ type: 'variant:started', variantId, conversationId: 'native-A', sessionId: 'session-A',
          workerGeneration: plan.workerGeneration })
        writeSessionEvents(plan, variantId, 'session-A', [{ seq: 0, type: 'message', data: { marker: 'generation-0-A' } }])
        const attempt = { attemptId: 'attempt-A-1', turn: 1, inputText: 'one', conversationId: 'native-A',
          sessionId: 'session-A', afterSeq: -1, workerGeneration: plan.workerGeneration,
          status: 'running', startedAt: new Date().toISOString() }
        writeDurableTrialAttempt(plan.workerCheckpointRoot, plan.trialId, variantId, attempt)
        modelCalls.push({ variantId, turn: 1, inputText: 'one' })
        const receipt = { outcome: 'committed', conversationId: 'native-A', runId: 'run-A-1', sessionId: 'session-A', turn: 4, active: true }
        const turn = { ...attempt, workerGeneration: plan.workerGeneration, nativeTurn: 4, runId: receipt.runId, status: 'complete', body: 'committed A result',
          usage: { requests: 1, reportedTokens: 3 }, taskUsage: { requests: 1, reportedTokens: 3, elapsedMs: 5 },
          commitReceipt: receipt, nativeEvents: [], trajectory: { run: { runId: receipt.runId }, executions: [] } }
        const checkpoint = { ...plan.snapshot, teamState: { revision: 1, namespaces: { shared: { count: 1 } }, pathVersions: {} } }
        writeDurableTrialCheckpoint(plan.workerCheckpointRoot, plan.trialId, variantId, {
          format: 'rp-team.trial-worker-checkpoint', version: 1,
          trialId: plan.trialId, variantId, receipt, turn, checkpoint,
        })
        // Simulate hard worker termination after the Host commit and durable checkpoint,
        // but before the turn:completed IPC can reach the parent.
        setImmediate(() => finish.reject(new Error('simulated worker hard exit before IPC ack')))
      } else {
        assert.equal(plan.variants.find(variant => variant.id === 'A').workerGeneration, 0)
        plan.onProgress({ type: 'variant:started', variantId: 'B', conversationId: 'native-B', sessionId: 'session-B',
          workerGeneration: plan.workerGeneration })
        writeSessionEvents(plan, 'A', 'session-A', [
          { seq: 0, type: 'message', data: { marker: 'generation-1-A-decoy' } },
          { seq: 1, type: 'message', data: { marker: 'generation-1-A-decoy' } },
        ])
        writeSessionEvents(plan, 'B', 'session-B', [{ seq: 0, type: 'message', data: { marker: 'generation-1-B' } }])
        const attempt = { attemptId: 'attempt-B-retry', turn: 1, inputText: 'one', conversationId: 'native-B',
          sessionId: 'session-B', afterSeq: -1, workerGeneration: plan.workerGeneration,
          status: 'running', nativeEvents: [] }
        writeDurableTrialAttempt(plan.workerCheckpointRoot, plan.trialId, 'B', attempt)
        plan.onProgress({ type: 'turn:attempt-started', variantId: 'B', attempt })
        setImmediate(() => finish.reject(new Error('simulated retry worker exit')))
      }
      return worker
    },
  })
  let api = makeApi()

  try {
    const frozen = await api.freezeTrialSnapshot({ conversationId: 'source-chat' })
    const started = await api.startTrial({
      conversationId: 'owner-chat', operationId: 'durable-checkpoint-start',
      scenario: { name: 'A/B checkpoint recovery', snapshotId: frozen.snapshotId, steps: [{ inputText: 'one' }] },
      variants: ['A', 'B'].map(id => ({ id, config })),
    })
    await waitFor(async () => (await api.getTrial({ trialId: started.trialId })).trial.status === 'interrupted')
    await workers[0].done.catch(() => undefined)
    const firstState = (await api.getTrial({ trialId: started.trialId })).trial
    assert.equal(firstState.variants.find(item => item.id === 'A').turns[0].body, 'committed A result')
    assert.equal(storage.read().trials[started.trialId].variants.find(item => item.id === 'A').turns[0].commitReceipt.outcome, 'committed')
    assert.equal(storage.readWorkerCheckpoints(started.trialId, 'A')[0].turn, 1, 'Checkpoint filenames follow the trial step ordinal.')
    assert.equal(firstState.variants.find(item => item.id === 'A').turns[0].nativeTurn, 4, 'The native Session turn remains distinct from trial step 1.')
    assert.equal(storage.read().trials[started.trialId].variants.find(item => item.id === 'A').turns[0].commitReceipt.turn, 4)
    assert.equal(firstState.variants.find(item => item.id === 'B').turns.length, 0)

    await api.dispose()
    api = makeApi()
    const coldState = (await api.getTrial({ trialId: started.trialId })).trial
    assert.equal(coldState.variants.find(item => item.id === 'A').turns.length, 1)

    await api.retryTrial({ trialId: started.trialId, operationId: 'durable-checkpoint-retry' })
    await waitFor(async () => workers.length === 2)
    assert.equal(workers[1].plan.variants.find(item => item.id === 'A').turns.length, 1)
    assert.equal(workers[1].plan.variants.find(item => item.id === 'A').turns[0].body, 'committed A result')
    assert.equal(workers[1].plan.variants.find(item => item.id === 'A').turns[0].workerGeneration, 0)
    assert.equal(workers[1].plan.snapshots.A.teamState.revision, 1)
    assert.equal(workers[1].plan.variants.find(item => item.id === 'B').turns.length, 0)
    assert.deepEqual(modelCalls, [{ variantId: 'A', turn: 1, inputText: 'one' }],
      'The retry preserves completed A and records B before provider dispatch without claiming a model call.')
    assert.equal(modelCalls.filter(call => call.variantId === 'A' && call.turn === 1).length, 1)
    await waitFor(async () => (await api.getTrial({ trialId: started.trialId })).trial.status === 'interrupted')
    await workers[1].done.catch(() => undefined)
    let stored = storage.read().trials[started.trialId]
    assert.equal(stored.variants.find(item => item.id === 'A').workerGeneration, 0)
    assert.equal(stored.variants.find(item => item.id === 'B').workerGeneration, 1)
    assert.deepEqual(stored.variants.find(item => item.id === 'A').turns[0].nativeEvents.map(event => event.data.marker), ['generation-0-A'])
    assert.deepEqual(stored.variants.find(item => item.id === 'B').attempts[0].nativeEvents.map(event => event.data.marker), ['generation-1-B'])
    assert.equal(stored.variants.find(item => item.id === 'B').attempts[0].workerGeneration, 1)
    await api.dispose()
    api = makeApi()
    stored = storage.read().trials[started.trialId]
    assert.equal(stored.variants.find(item => item.id === 'A').turns[0].workerGeneration, 0,
      'Cold recovery preserves the completed A turn in its original worker generation.')
    assert.deepEqual(stored.variants.find(item => item.id === 'A').turns[0].nativeEvents.map(event => event.data.marker), ['generation-0-A'])
    assert.equal(stored.variants.find(item => item.id === 'B').attempts[0].workerGeneration, 1,
      'Cold recovery preserves the retry B attempt generation.')
  } finally {
    await api.dispose()
    rmSync(home, { recursive: true, force: true })
  }
})

test('worker attempt without a committed checkpoint blocks blind retry', async () => {
  const home = mkdtempSync(join(tmpdir(), 'rp-team-trial-unknown-result-'))
  const workers = []
  const modelCalls = []
  const config = defaultTeamConfig()
  const { ctx } = createTrialPublicHost()
  const storage = new TrialStorage(join(home, 'config.json'))
  let api = createTrialApi({
    ctx,
    store: { path: join(home, 'config.json'), get: () => ({ config, enabled: true }) },
    stateStore: { committedSnapshot: () => ({ revision: 0, namespaces: {}, pathVersions: {} }) },
    workerFactory: plan => {
      let reject
      const done = new Promise((_resolve, rejectDone) => { reject = rejectDone })
      const worker = { plan, done, cancel: async () => undefined }
      workers.push(worker)
      const attempt = {
        attemptId: 'unknown-attempt', turn: 1, inputText: 'one', conversationId: 'native-A',
        sessionId: 'session-A', afterSeq: 3, status: 'running',
      }
      writeDurableTrialAttempt(plan.workerCheckpointRoot, plan.trialId, 'A', attempt)
      const runtimeRoot = join(plan.workerRoot, trialVariantStorageKey('A'), 'userdata', 'runtime')
      const runPath = runFilePath(join(runtimeRoot, 'home', 'plugins', 'rp-agent-team', 'traces'), 'native-A', 'run-4')
      mkdirSync(dirname(runPath), { recursive: true })
      writeFileSync(runPath, `${JSON.stringify({
        status: { conversationId: 'native-A', runId: 'run-4', rootSessionId: 'session-A', turn: 4,
          inputMessageId: 'input-4', phase: 'failed', budget: { requestCount: 1, reportedTokens: 0, elapsedMs: 4 } },
        trace: { events: [] }, executionSessions: [],
      })}\n`)
      const sessionPath = join(runtimeRoot, 'sessions', 'cwd-1', 'session-A', 'session.v4.jsonl')
      mkdirSync(dirname(sessionPath), { recursive: true })
      writeFileSync(sessionPath, [
        { seq: 0, type: 'turn/end', data: { turn: 1 } },
        { seq: 1, type: 'turn/end', data: { turn: 2 } },
        { seq: 2, type: 'turn/end', data: { turn: 3 } },
        { seq: 4, type: 'user/message', data: { id: 'input-4', role: 'user' } },
        { seq: 5, type: 'turn/end', data: { turn: 4, reason: { kind: 'error' } } },
      ].map(event => JSON.stringify(event)).join('\n') + '\n')
      modelCalls.push('one')
      setImmediate(() => reject(new Error('The isolated trial worker exited (1).\nWorker stderr:\nAuthorization: Bearer smoke-worker-secret-123456')))
      return worker
    },
  })

  try {
    const frozen = await api.freezeTrialSnapshot({ conversationId: 'source-chat' })
    const started = await api.startTrial({
      conversationId: 'owner-chat', operationId: 'unknown-result-start',
      scenario: { name: 'Unknown result', snapshotId: frozen.snapshotId, steps: [{ inputText: 'one' }] },
      variants: [{ id: 'A', config }],
    })
    await waitFor(async () => (await api.getTrial({ trialId: started.trialId })).trial.status === 'interrupted')
    const trial = (await api.getTrial({ trialId: started.trialId })).trial
    assert.equal(trial.variants[0].attempts[0].status, 'needs_confirmation')
    assert.match(trial.failure, /needs confirmation before retry/u)
    assert.match(trial.workerExitDiagnostic, /isolated trial worker exited/u)
    assert.match(trial.workerExitDiagnostic, /Bearer \[credential omitted\]/u)
    assert.doesNotMatch(JSON.stringify(trial), /smoke-worker-secret-123456/u)
    assert.equal(trial.variants[0].attempts[0].turn, 1, 'The attempt turn is the scenario ordinal.')
    assert.equal(trial.variants[0].attempts[0].nativeTurn, 4)
    assert.match(storage.read().trials[started.trialId].workerExitDiagnostic, /Bearer \[credential omitted\]/u)
    assert.equal(storage.read().trials[started.trialId].variants[0].attempts[0].nativeTurn, 4,
      'Cold reconciliation must associate the persisted attempt with native Session turn 4 using its input ID.')
    assert.equal(trial.variants[0].attempts[0].runId, 'run-4')
    await api.dispose()
    api = createTrialApi({
      ctx,
      store: { path: join(home, 'config.json'), get: () => ({ config, enabled: true }) },
      stateStore: { committedSnapshot: () => ({ revision: 0, namespaces: {}, pathVersions: {} }) },
      workerFactory: () => { throw new Error('retry must be blocked for an unknown attempt') },
    })
    const coldTrial = (await api.getTrial({ trialId: started.trialId })).trial
    assert.equal(coldTrial.variants[0].attempts[0].turn, 1)
    assert.equal(storage.read().trials[started.trialId].variants[0].attempts[0].nativeTurn, 4)
    assert.equal(coldTrial.variants[0].attempts[0].runId, 'run-4')
    await assert.rejects(api.retryTrial({ trialId: started.trialId, operationId: 'unknown-result-retry' }), error =>
      error.code === 'RP_TEAM_TRIAL_RESULT_UNKNOWN')
    assert.equal(workers.length, 1)
    assert.deepEqual(modelCalls, ['one'])
  } finally {
    await api.dispose()
    rmSync(home, { recursive: true, force: true })
  }
})

test('durable explicit failed and cancelled receipts remain retryable after restart', async t => {
  for (const outcome of ['failed', 'cancelled']) {
    await t.test(outcome, async () => {
      const home = mkdtempSync(join(tmpdir(), `rp-team-trial-known-${outcome}-`))
      const workers = []
      const config = defaultTeamConfig()
      const storage = new TrialStorage(join(home, 'config.json'))
      const { ctx } = createTrialPublicHost()
      const makeApi = () => createTrialApi({
        ctx,
        store: { path: join(home, 'config.json'), get: () => ({ config, enabled: true }) },
        stateStore: { committedSnapshot: () => ({ revision: 0, namespaces: {}, pathVersions: {} }) },
        workerFactory: plan => {
          let finish
          const done = new Promise(resolve => { finish = resolve })
          const worker = {
            plan, done,
            cancel: async () => {
              plan.onProgress({ type: 'trial:cancelled', taskUsage: { requests: 1, reportedTokens: 0, elapsedMs: 2 } })
              finish({ cancelled: true })
            },
          }
          workers.push(worker)
          assert.equal(plan.workerGeneration, workers.length - 1)
          writeUsageTrace(plan, `run-usage-${outcome}-${workers.length}`)
          if (workers.length === 1) {
            plan.onProgress({ type: 'variant:started', variantId: 'A', conversationId: 'native-A', sessionId: 'session-A',
              workerGeneration: plan.workerGeneration })
            const runId = `run-${outcome}`
            const attemptBase = {
              attemptId: `attempt-${outcome}`, turn: 1, inputText: 'one', conversationId: 'native-A',
              sessionId: 'session-A', afterSeq: 4, workerGeneration: plan.workerGeneration,
              startedAt: new Date().toISOString(), runId,
              ...(outcome === 'failed' ? { nativeTurn: 4 } : {}),
            }
            const nativeEvents = outcome === 'failed' ? [
              { seq: 5, type: 'user/message', data: { id: 'input-failed', role: 'user' } },
              { seq: 6, type: 'turn/end', data: { turn: 4, reason: { kind: 'error' } } },
            ] : []
            const resolution = outcome === 'failed'
              ? classifyAttemptCommitOutcome({ outcome: 'unknown', conversationId: 'native-A', runId }, attemptBase, {
                runId,
                commitEvidence: { conversationId: 'native-A', rootSessionId: 'session-A', runId,
                  phase: 'failed', turn: 4, inputMessageId: 'input-failed', productCommitStaged: false },
                nativeEvents,
              })
              : classifyAttemptCommitOutcome({ outcome: 'cancelled', conversationId: 'native-A', runId }, attemptBase, { runId })
            const attempt = {
              ...attemptBase, status: outcome, commitOutcome: resolution.outcome,
              commitEvidence: resolution.evidence, nativeEvents,
              ...(outcome === 'failed' ? { commitIdentity: {
                conversationId: 'native-A', rootSessionId: 'session-A', runId,
                phase: 'failed', turn: 4, inputMessageId: 'input-failed', productCommitStaged: false,
              } } : {}),
            }
            writeDurableTrialAttempt(plan.workerCheckpointRoot, plan.trialId, 'A', { ...attempt, status: 'running' })
            writeDurableTrialAttemptSettlement(plan.workerCheckpointRoot, plan.trialId, 'A', attempt)
            setImmediate(() => {
              plan.onProgress({
                type: 'turn:attempt-settled', variantId: 'A', attempt,
                taskUsage: { requests: 1, reportedTokens: 0, elapsedMs: 2 },
              })
              plan.onProgress(outcome === 'failed'
                ? { type: 'trial:failed', variantId: 'A', message: 'Explicit product failure', taskUsage: { requests: 1, reportedTokens: 0, elapsedMs: 2 } }
                : { type: 'trial:cancelled', taskUsage: { requests: 1, reportedTokens: 0, elapsedMs: 2 } })
              finish(outcome === 'cancelled' ? { cancelled: true } : {})
            })
          }
          return worker
        },
      })
      let api = makeApi()

      try {
        const frozen = await api.freezeTrialSnapshot({ conversationId: 'source-chat' })
        const started = await api.startTrial({
          conversationId: 'owner-chat', operationId: `known-${outcome}-start`,
          scenario: { name: `Known ${outcome}`, snapshotId: frozen.snapshotId, steps: [{ inputText: 'one' }] },
          variants: [{ id: 'A', config }],
        })
        await waitFor(async () => (await api.getTrial({ trialId: started.trialId })).trial.status === outcome)
        const settled = (await api.getTrial({ trialId: started.trialId })).trial.variants[0].attempts[0]
        assert.equal(settled.status, outcome)
        const settledInternal = storage.read().trials[started.trialId].variants[0].attempts[0]
        assert.equal(settledInternal.commitOutcome, outcome)
        if (outcome === 'failed') {
          assert.equal(settledInternal.commitEvidence, 'session-no-stage')
          assert.equal(settledInternal.turn, 1, 'The persisted failed attempt keeps its scenario ordinal.')
          assert.equal(settledInternal.nativeTurn, 4, 'The persisted no-stage evidence records native Session turn 4.')
          assert.equal(settledInternal.commitIdentity.inputMessageId, 'input-failed')
          assert.equal(settledInternal.commitIdentity.productCommitStaged, false)
        }

        await api.dispose()
        api = makeApi()
        const recovered = (await api.getTrial({ trialId: started.trialId })).trial.variants[0].attempts[0]
        assert.equal(recovered.status, outcome)
        const recoveredInternal = storage.read().trials[started.trialId].variants[0].attempts[0]
        assert.equal(recoveredInternal.commitOutcome, outcome)
        assert.equal(recoveredInternal.workerGeneration, 0)
        if (outcome === 'failed') assert.equal(recoveredInternal.nativeTurn, 4)

        await api.retryTrial({ trialId: started.trialId, operationId: `known-${outcome}-retry` })
        await waitFor(async () => workers.length === 2)
        assert.equal(workers[1].plan.variants[0].turns.length, 0)
        assert.equal(workers[1].plan.variants[0].attempts[0].commitOutcome, outcome)
        assert.equal(workers[1].plan.workerGeneration, 1)
        assert.equal(workers[1].plan.workerRoot, storage.workerRoot(started.trialId, 1))
        assert.notEqual(workers[1].plan.workerRoot, workers[0].plan.workerRoot,
          'A retry imports the frozen archive into a fresh isolated worker profile.')
        await api.cancelTrial({ trialId: started.trialId })
        const retried = (await api.getTrial({ trialId: started.trialId })).trial
        assert.equal(retried.usage.requests, 2, 'Recovery sums trace usage from the original and retry profiles.')
        assert.equal(retried.usage.reportedTokens, 4)
      } finally {
        await api.dispose()
        rmSync(home, { recursive: true, force: true })
      }
    })
  }
})

function writeSessionEvents(plan, variantId, sessionId, events) {
  const runtimeRoot = join(plan.workerRoot, trialVariantStorageKey(variantId), 'userdata', 'runtime')
  const sessionPath = join(runtimeRoot, 'sessions', 'cwd-1', sessionId, 'session.v4.jsonl')
  mkdirSync(dirname(sessionPath), { recursive: true })
  writeFileSync(sessionPath, `${events.map(event => JSON.stringify(event)).join('\n')}\n`)
}

function writeUsageTrace(plan, runId) {
  const runtimeRoot = join(plan.workerRoot, trialVariantStorageKey('A'), 'userdata', 'runtime')
  const traceRoot = join(runtimeRoot, 'home', 'plugins', 'rp-agent-team', 'traces')
  const runPath = runFilePath(traceRoot, 'native-A', runId)
  mkdirSync(dirname(runPath), { recursive: true })
  writeFileSync(runPath, `${JSON.stringify({
    status: { conversationId: 'native-A', runId, rootSessionId: 'session-A', turn: 4,
      budget: { requestCount: 1, reportedTokens: 2, elapsedMs: 3 } },
    trace: { events: [] }, executionSessions: [],
  })}\n`)
}

async function waitFor(predicate) {
  for (let index = 0; index < 100; index += 1) {
    if (await predicate()) return
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error('Timed out waiting for trial worker recovery.')
}
