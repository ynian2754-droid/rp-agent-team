import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createRpAgentTeam } from '../src/host/runtime.mjs'
import { StateStore } from '../src/host/state-store.mjs'
import { completeRun, createRun, stagePublication } from '../src/host/run-state.mjs'
import { createTrace } from '../src/host/trace.mjs'
import { persistedRunValue, runFilePath, writeJsonAtomic } from '../src/host/run-persistence.mjs'
import { defaultTeamConfig, normalizeTeamConfig } from '../src/shared/schema.mjs'
import { resolveAuthorParameters } from '../src/shared/author-parameters.mjs'

const conversationId = 'recovery-conversation'
const runId = 'recovery-run'

/** Persist one run row and its state transaction as a previous process left them, then start a fresh runtime. */
async function restartWith({ phase, staged, stateStatus, receipt, revision, awaiting = false, stageRejected }) {
  const home = mkdtempSync(join(tmpdir(), 'rp-team-recovery-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const config = normalizeTeamConfig(defaultTeamConfig())
  const states = new StateStore()
  states.begin({ conversationId, runId, config, initialState: { world: { variables: {}, settings: {} } } })
  if (stateStatus === 'pending') states.stage({ conversationId, runId })
  const run = createRun({ conversationId, rootSessionId: 'root-session', config, runId })
  run.phase = 'working'
  run.members['agent-1'].status = 'complete'
  run.members['agent-2'].status = 'running'
  if (phase === 'publishing') stagePublication(run, config.output.agentId, { body: 'A reply.' })
  if (awaiting) completeRun(run)
  if (stageRejected !== undefined) run.productStageRejected = stageRejected
  run.productCommitStaged = staged
  run.inputEventSeq = 7
  if (revision !== undefined) {
    run.configStoreRevision = revision
    run.resolvedHash = resolveAuthorParameters(config, {}).resolvedHash
  }
  run.trace = createTrace(runId, run.startedAt)
  writeJsonAtomic(runFilePath(join(home, 'plugins', 'rp-agent-team', 'traces'), conversationId, runId), persistedRunValue(run))
  const ctx = {
    llm: { registerAdapter: () => () => {} },
    agents: { get: () => undefined },
    agentTeams: { interrupt() {}, listMembers: () => [] },
    eleckoiConversationsApi: {
      async turnCommitStatus() {
        return { outcome: receipt, conversationId, runId, assistantMessageId: 'assistant-1', assistantSeq: 9, active: true }
      }
    },
    agentPresets: { async list() { return [] } }
  }
  const team = createRpAgentTeam(ctx, { LlmAdapter: class {} })
  return {
    team, states,
    async dispose() {
      await team.dispose?.()
      rmSync(home, { recursive: true, force: true })
      if (previousHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previousHome
    }
  }
}

for (const receipt of ['failed', 'committed']) {
  test(`a run persisted as publishing recovers from a ${receipt} receipt without breaking the Team API`, async () => {
    const f = await restartWith({ phase: 'publishing', staged: true, stateStatus: 'pending', receipt })
    try {
      await f.team.authoring.recoveryReady
      const status = await f.team.api.getStatus({ conversationId })
      assert.equal(status.run.phase, receipt === 'committed' ? 'complete' : 'failed')
      assert.equal(f.states.status({ conversationId, runId }).status, receipt === 'committed' ? 'committed' : 'rolled_back')
    } finally {
      await f.dispose()
    }
  })
}

test('a run that stopped before staging is failed at startup, releases its state and can be retried', async () => {
  const f = await restartWith({ phase: 'working', staged: false, stateStatus: 'open', receipt: 'unknown', revision: 0 })
  try {
    await f.team.authoring.recoveryReady
    let status = await f.team.api.getStatus({ conversationId })
    assert.equal(status.run.phase, 'failed')
    assert.match(status.run.failure, /Interrupted/)
    assert.equal(status.run.members['agent-2'].status, 'failed')
    assert.equal(status.run.retryAvailable, false, 'the team is off in this chat')
    assert.equal(status.run.retryBlockedReason, 'disabled')

    // Switching the team on bumps the store revision but keeps the effective configuration: retry stays valid.
    const saved = await f.team.api.saveConfig({ conversationId, expectedRevision: 0, enabled: true, config: defaultTeamConfig() })
    assert.notEqual(saved.revision, 0)
    status = await f.team.api.getStatus({ conversationId })
    assert.equal(status.run.retryAvailable, true)
    assert.equal(status.run.retryBlockedReason, undefined)

    const changed = defaultTeamConfig()
    changed.agents[0].systemPrompt = 'A different prompt.'
    await f.team.api.saveConfig({ conversationId, expectedRevision: saved.revision, enabled: true, config: changed })
    status = await f.team.api.getStatus({ conversationId })
    assert.equal(status.run.retryAvailable, false)
    assert.equal(status.run.retryBlockedReason, 'config_changed')
    await assert.rejects(async () => f.team.api.retry({ conversationId, runId, requestId: 'retry-1' }), { code: 'RP_TEAM_RETRY_CONTEXT_CHANGED' })
    assert.equal(f.states.status({ conversationId, runId }).status, 'rolled_back')
    assert.equal(f.team.authoring.isConversationBusy(conversationId), false)
  } finally {
    await f.dispose()
  }
})

test('reconciling a long chat checks committed runs newest first and stops at the first active one', async () => {
  const home = mkdtempSync(join(tmpdir(), 'rp-team-reconcile-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const config = normalizeTeamConfig(defaultTeamConfig())
    const traces = join(home, 'plugins', 'rp-agent-team', 'traces')
    for (let index = 0; index < 50; index++) {
      const run = createRun({ conversationId, rootSessionId: 'root-session', config, runId: `run-${index}` })
      run.phase = 'complete'
      run.productCommitStaged = true
      run.inputEventSeq = index * 2 + 1
      run.trace = createTrace(run.runId, run.startedAt)
      writeJsonAtomic(runFilePath(traces, conversationId, run.runId), persistedRunValue(run))
    }
    const queried = []
    const ctx = {
      llm: { registerAdapter: () => () => {} },
      eleckoiConversationsApi: {
        async turnCommitStatus({ runId: id }) {
          queried.push(id)
          return { outcome: 'committed', conversationId, runId: id, active: true }
        }
      },
      agentPresets: { async list() { return [] } }
    }
    const team = createRpAgentTeam(ctx, { LlmAdapter: class {} })
    await team.authoring.recoveryReady
    const result = await team.authoring.reconcileBranch(conversationId)
    assert.equal(result.reconciled, false)
    assert.deepEqual(queried, ['run-49'], 'only the newest committed run is asked about when it is still active')
    await team.dispose?.()
  } finally {
    rmSync(home, { recursive: true, force: true })
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  }
})
test('after a restart, a staged run whose stage the Host rejected and has no row for is failed, not left blocking the chat', async () => {
  const f = await restartWith({ phase: 'publishing', staged: true, stateStatus: 'pending', receipt: 'unknown', awaiting: true, stageRejected: 'Host rejected the stage' })
  try {
    await f.team.authoring.recoveryReady
    const status = await f.team.api.getStatus({ conversationId })
    assert.equal(status.run.phase, 'failed')
    assert.equal(status.run.failure, 'Host rejected the stage')
    assert.equal(f.states.status({ conversationId, runId }).status, 'rolled_back')
  } finally {
    await f.dispose()
  }
})

test('cancelling a reloaded staged run the Host has no record of releases the chat', async () => {
  const f = await restartWith({ phase: 'publishing', staged: true, stateStatus: 'pending', receipt: 'unknown', awaiting: true })
  try {
    await f.team.authoring.recoveryReady
    assert.equal((await f.team.api.getStatus({ conversationId })).run.phase, 'awaiting_commit', 'without an explicit cancel it keeps waiting')
    const status = await f.team.api.cancel({ conversationId, runId })
    assert.equal(status.phase, 'cancelled')
    assert.equal(f.states.status({ conversationId, runId }).status, 'rolled_back')
    assert.equal(f.team.authoring.isConversationBusy(conversationId), false)
  } finally {
    await f.dispose()
  }
})