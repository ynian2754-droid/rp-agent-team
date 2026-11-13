import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTrialApi } from '../src/host/trials.mjs'
import { defaultTeamConfig } from '../src/shared/schema.mjs'
import { writeDurableTrialCheckpoint } from '../src/host/trial-storage.mjs'
import { createTrialPublicHost } from './fixtures/trial-public-host.mjs'

test('trajectory lookup returns all prior native runs and scopes projection to trial turns', async () => {
  const home = mkdtempSync(join(tmpdir(), 'rp-team-trial-trajectory-'))
  const workers = []
  const config = defaultTeamConfig()
  const teamState = { revision: 0, namespaces: {}, pathVersions: {} }
  const { ctx } = createTrialPublicHost()
  let snapshot
  const api = createTrialApi({
    ctx,
    store: { path: join(home, 'config.json'), get: () => ({ config, enabled: true }) },
    stateStore: { committedSnapshot: () => teamState },
    workerFactory: plan => {
      let finish
      const done = new Promise(resolve => { finish = resolve })
      const worker = { plan, done, finish, cancel: async () => {
        plan.onProgress({ type: 'trial:cancelled' })
        finish({ cancelled: true })
      } }
      workers.push(worker)
      return worker
    },
  })

  try {
    const frozen = await api.freezeTrialSnapshot({ conversationId: 'source-chat' })
    const started = await api.startTrial({
      conversationId: 'owner-chat', operationId: 'trajectory-start',
      scenario: { name: 'Two turns', snapshotId: frozen.snapshotId, steps: [{ inputText: 'one' }, { inputText: 'two' }] },
      variants: [{ id: 'A', config }],
    })
    for (let count = 0; count < 30 && workers.length === 0; count += 1) await new Promise(resolve => setImmediate(resolve))
    assert.equal(workers.length, 1)
    snapshot = workers[0].plan.snapshot
    const progress = workers[0].plan.onProgress
    const rootEvents = [
      { seq: 3, type: 'turn/start', data: { turn: 1 } },
      { seq: 4, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
      { seq: 5, type: 'turn/start', data: { turn: 2 } },
      { seq: 6, type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } },
    ]
    const run = (runId, turn) => ({ runId, turn, executionSessions: [{ sessionId: `child-${turn}`, agentId: 'A' }] })
    const execution = (runId, turn) => ({
      runId, association: { sessionId: `child-${turn}`, agentId: 'A' },
      events: [{ seq: turn, type: 'assistant/message', data: { turn } }],
    })
    const emitTurn = (turn, afterSeq, events) => {
      const commitReceipt = { outcome: 'committed', conversationId: 'native-chat', sessionId: 'root-session', runId: `run-${turn}`, turn, active: true }
      const durableTurn = { turn, runId: `run-${turn}`, attemptId: `attempt-${turn}`, sessionId: 'root-session', conversationId: 'native-chat', afterSeq,
        taskUsage: { requests: turn, reportedTokens: 0, elapsedMs: turn }, commitReceipt,
        nativeEvents: events, trajectory: { run: run(`run-${turn}`, turn), executions: [execution(`run-${turn}`, turn)] } }
      const checkpoint = { ...snapshot, teamState }
      writeDurableTrialCheckpoint(workers[0].plan.workerCheckpointRoot, started.trialId, 'A', {
        format: 'rp-team.trial-worker-checkpoint', version: 1, trialId: started.trialId, variantId: 'A',
        receipt: commitReceipt, turn: durableTurn, checkpoint,
      })
      progress({ type: 'turn:completed', variantId: 'A', turn: { turn, runId: `run-${turn}`, attemptId: `attempt-${turn}` } })
    }
    emitTurn(1, 2, rootEvents.slice(0, 2))
    emitTurn(2, 4, rootEvents)

    const firstRun = await api.getTrialTrajectory({ trialId: started.trialId, variantId: 'A', runId: 'run-1' })
    assert.deepEqual(firstRun.native.visibleTurns, [1])
    assert.deepEqual(firstRun.native.runs.map(item => item.runId), ['run-1'])

    const page1 = await api.getTrialTrajectory({ trialId: started.trialId, variantId: 'A', runId: 'run-2', limit: 2 })
    assert.deepEqual(page1.native.visibleTurns, [1, 2])
    assert.deepEqual(page1.native.runs.map(item => item.runId), ['run-1', 'run-2'])
    assert.deepEqual(page1.native.executions.map(item => item.runId), ['run-1', 'run-2'])
    assert.deepEqual(page1.native.events.map(item => item.seq), [3, 4])
    assert.equal(page1.hasMore, true)

    const page2 = await api.getTrialTrajectory({ trialId: started.trialId, variantId: 'A', runId: 'run-2', limit: 2, cursor: page1.cursor })
    assert.deepEqual(page2.native.events.map(item => item.seq), [3, 4, 5, 6])
    assert.equal(new Set(page2.native.events.map(item => item.seq)).size, page2.native.events.length)
    assert.equal(page2.hasMore, false)
  } finally {
    await api.dispose()
    rmSync(home, { recursive: true, force: true })
  }
})
