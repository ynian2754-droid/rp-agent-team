import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { stringify as stringifyYaml } from 'yaml'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { classifyAttemptCommitOutcome, classifyNoStageOutcome, materializeTrialConfig, observeTrialPromptWork, prepareTrialPrompt, selectedPresetBundles, trialVariantStorageKey } from '../src/host/trial-worker.mjs'
import { runTrialWorkerProcess } from '../src/host/trial-worker-client.mjs'

test('variant worker directories remain distinct on case-insensitive Windows filesystems', () => {
  for (const [left, right] of [['A', 'a'], ['case/a', 'case_a'], ['space one', 'space_one']]) {
    assert.notEqual(trialVariantStorageKey(left).toLowerCase(), trialVariantStorageKey(right).toLowerCase())
  }
})

test('materialized trial parameters cannot restore trusted tools when the task did not allow them', () => {
  const template = {
    schemaVersion: 2, id: 'trial-template', name: 'Trial template', version: '1', metadata: {},
    agents: [{ id: 'actor', name: 'Actor', description: '', systemPrompt: '', modelRef: 'inherit', parameters: {},
      presetId: '', capabilities: [], compaction: {}, triggers: [{ type: 'always' }],
      context: { sources: [{ type: 'current_input' }] },
      communication: { sendTo: [], receiveFrom: [], requestTo: [], requestFrom: [] }, statePermissions: [],
      outputAuthority: { internal: true, draft: true, state: false, user: true },
      execution: { after: [], onFailure: 'continue', trustedTools: [] } }],
    state: { definitions: [] }, execution: {}, output: { agentId: 'actor' },
    authorParameters: [{ id: 'tool-policy', name: 'Tool policy', type: 'choice',
      options: [{ label: 'External tool', value: ['external:send'] }], default: ['external:send'],
      bindings: [{ target: { kind: 'agent', agentId: 'actor', path: '/execution/trustedTools' }, mode: 'set' }] }],
  }
  const limits = { maxRequests: 8, maxReportedTokens: 1024, maxElapsedMs: 30_000 }
  const restricted = materializeTrialConfig(template, {}, limits, limits)
  assert.deepEqual(restricted.config.agents[0].execution.trustedTools, [])
  assert.deepEqual(restricted.config.authorParameters[0].bindings, [])
  assert.deepEqual(template.agents[0].execution.trustedTools, [], 'Materialization must preserve the author template.')
  assert.equal(template.authorParameters[0].bindings.length, 1, 'Materialization must not erase the template binding.')

  const allowed = materializeTrialConfig(template, {}, limits, limits, { allowTrustedTools: true })
  assert.deepEqual(allowed.config.agents[0].execution.trustedTools, ['external:send'])
})

test('extension tool presets require a public owning-package association and load the named bundle', () => {
  const preset = { id: 'product-third-party-tools', toolGroups: [{ id: 'acme-tools', source: 'extension', included: true }] }
  const sourceBundles = ['@acme/dsh-tools', '@rp-team/dsh-roleplay-team']
  const baseBundles = new Set(['@eleckoi/dsh-core', '@deepseek-ai/dsh-agent-instructions'])

  assert.throws(() => selectedPresetBundles([
    { id: preset.id, preset },
  ], [], sourceBundles, baseBundles), /no owning DSH package association/u)

  const nativeDocument = { id: 'native-tools', content: stringifyYaml([
    { id: 'instructions', name: '@deepseek-ai/dsh-agent-instructions' },
    { id: 'host-tools', name: '@eleckoi/dsh-core/host/tools' },
    { id: 'acme-tools', name: '@acme/dsh-tools/entry' }
  ]) }
  assert.deepEqual(selectedPresetBundles([
    { id: preset.id, preset: { toolGroups: [{ id: 'builtin-tools', source: 'built_in', included: true }] } },
  ], [nativeDocument], sourceBundles, baseBundles), ['@acme/dsh-tools'])

  assert.throws(() => selectedPresetBundles([
    { id: preset.id, preset: { toolGroups: [] } },
  ], [nativeDocument], [], baseBundles), /profile does not include a required Agent preset bundle/u)

  preset.toolGroups[0].plugin = { id: 'bundle:@acme/dsh-tools', name: 'ACME' }
  assert.deepEqual(selectedPresetBundles([{ id: preset.id, preset }], [], sourceBundles, baseBundles), ['@acme/dsh-tools'])
})

test('cancellation while preparePrompt is pending drains without dispatching a native request', async () => {
  let releasePreparation
  let dispatched = 0
  const preparation = new Promise(resolve => { releasePreparation = resolve })
  const ctx = {
    eleckoiConversationsApi: { preparePrompt: () => preparation },
    sessionController: { prompt() { dispatched += 1; return Promise.resolve() } },
  }
  const controller = new AbortController()
  const pending = prepareTrialPrompt(ctx, {
    conversationId: 'trial-chat', sessionId: 'trial-session', requestId: 'request-1', inputText: 'fixture input',
  }, controller.signal)
  controller.abort(new Error('cancelled by test'))
  releasePreparation({ runtimeSessionId: 'trial-session' })
  await assert.rejects(pending, /cancelled by test/u)
  assert.equal(dispatched, 0)
})

test('prepared trial prompts wait for the public product generation lifecycle before returning', async () => {
  const calls = []
  const receipt = { accepted: true }
  const ctx = {
    eleckoiConversationsApi: {
      async preparePrompt(conversationId, inputText) {
        calls.push(['prepare', conversationId, inputText])
        return { runtimeSessionId: 'trial-session', operationId: 'operation-1' }
      },
      async waitForGeneration(conversationId, operationId) {
        calls.push(['wait', conversationId, operationId])
      },
    },
    sessionController: {
      async prompt(options) { calls.push(['prompt', options.sessionId, options.requestId]); return receipt },
      async resolveAgent(sessionId) {
        calls.push(['resolve', sessionId])
        return { agent: { async whenIdle() { calls.push(['idle', sessionId]) } } }
      },
    },
  }

  const result = await prepareTrialPrompt(ctx, {
    conversationId: 'trial-chat', sessionId: 'trial-session', requestId: 'request-1', inputText: 'fixture input',
  }, new AbortController().signal)

  assert.equal(result, receipt)
  assert.deepEqual(calls, [
    ['prepare', 'trial-chat', 'fixture input'],
    ['prompt', 'trial-session', 'request-1'],
    ['resolve', 'trial-session'],
    ['idle', 'trial-session'],
    ['wait', 'trial-chat', 'operation-1'],
  ])
})

test('early prompt rejection stays observed until the worker awaits the original promise', async () => {
  const moduleUrl = new URL('../src/host/trial-worker.mjs', import.meta.url).href
  const script = `
    import { observeTrialPromptWork } from ${JSON.stringify(moduleUrl)}
    const failure = new Error('deterministic prompt failure')
    const promptWork = observeTrialPromptWork(new Promise((_, reject) => setTimeout(() => reject(failure), 0)))
    await new Promise(resolve => setTimeout(resolve, 20)) // the native turn-end arrives after the prompt rejection
    try {
      await promptWork
      throw new Error('the original prompt rejection was swallowed')
    } catch (error) {
      if (error !== failure) throw error
      console.log('original prompt rejection reached the worker catch')
    }
  `
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' })
  assert.equal(child.status, 0, child.stderr)
  assert.equal(child.stdout.trim(), 'original prompt rejection reached the worker catch')
})

test('unknown receipt is retryable only for the exact failed root turn with no assistant output', () => {
  // Trial step 1 can be native Session turn 4 after importing a three-turn chat.
  const attempt = { conversationId: 'trial-chat', sessionId: 'root-session', turn: 1, afterSeq: 4 }
  const identity = {
    conversationId: 'trial-chat', rootSessionId: 'root-session', runId: 'run-2',
    phase: 'failed', turn: 4, inputMessageId: 'input-2', productCommitStaged: false,
  }
  const nativeEvents = [
    { seq: 5, type: 'user/message', data: { id: 'input-2', role: 'user', content: [{ type: 'text', text: 'request' }] } },
    { seq: 6, type: 'turn/end', data: { turn: 4, reason: { kind: 'error' } } },
  ]
  const evidence = { runId: 'run-2', commitEvidence: identity, nativeEvents }

  assert.equal(classifyNoStageOutcome(attempt, evidence), 'failed')
  assert.deepEqual(classifyAttemptCommitOutcome({ outcome: 'unknown', conversationId: 'trial-chat', runId: 'run-2' }, attempt, evidence), {
    outcome: 'failed', evidence: 'session-no-stage',
  })
  assert.equal(classifyNoStageOutcome(attempt, { ...evidence, commitEvidence: { ...identity, phase: 'cancelled' },
    nativeEvents: [{ ...nativeEvents[0] }, { seq: 6, type: 'turn/end', data: { turn: 4, reason: { kind: 'aborted' } } }] }), 'cancelled')
  assert.deepEqual(classifyAttemptCommitOutcome({ outcome: 'pending', conversationId: 'trial-chat', runId: 'run-2' }, attempt, evidence), {
    outcome: 'pending', evidence: 'unconfirmed',
  })
  assert.deepEqual(classifyAttemptCommitOutcome({ outcome: 'failed', conversationId: 'other-chat', runId: 'run-2' }, attempt, evidence), {
    outcome: 'unknown', evidence: 'unconfirmed',
  })
  assert.deepEqual(classifyAttemptCommitOutcome(undefined, attempt, evidence), {
    outcome: 'unknown', evidence: 'unconfirmed',
  })
  assert.equal(classifyNoStageOutcome(attempt, { ...evidence, commitEvidence: { ...identity, productCommitStaged: true } }), undefined)
  assert.equal(classifyNoStageOutcome(attempt, { ...evidence, commitEvidence: { ...identity, rootSessionId: 'other-session' } }), undefined)
  assert.equal(classifyNoStageOutcome(attempt, { ...evidence, commitEvidence: { ...identity, inputMessageId: 'other-input' } }), undefined)
  assert.equal(classifyNoStageOutcome(attempt, { ...evidence,
    nativeEvents: [...nativeEvents.slice(0, 1),
      { seq: 6, type: 'assistant/message', data: { turn: 4, message: { role: 'assistant', content: [{ type: 'text', text: 'candidate' }] } } },
      { seq: 7, type: 'turn/end', data: { turn: 4, reason: { kind: 'error' } } }],
  }), undefined)
  assert.equal(classifyNoStageOutcome(attempt, { ...evidence,
    nativeEvents: [{ ...nativeEvents[0] }, { seq: 6, type: 'turn/end', data: { turn: 4, reason: { kind: 'completed' } } }] }), undefined)
  assert.equal(classifyNoStageOutcome({ ...attempt, nativeTurn: 5 }, evidence), undefined)
})

test('concurrent worker cancel callers share one IPC request and clear the watchdog after acknowledgement', async () => {
  class FakeChild extends EventEmitter {
    connected = true
    killed = false
    messages = []
    send(message) { this.messages.push(message) }
    kill() { this.killed = true }
  }
  const child = new FakeChild()
  const home = mkdtempSync(join(tmpdir(), 'rp-team-trial-worker-client-'))
  let forkOptions
  try {
    const workerRoot = join(home, 'worker-root')
    const worker = runTrialWorkerProcess({
      workerRoot, workerCredentials: { RP_TRIAL_TEST_CREDENTIAL: 'secret-in-protected-worker-env' },
      forkProcess: (_entry, _args, options) => { forkOptions = options; return child },
    })
    assert.equal(forkOptions.cwd, workerRoot)
    assert.equal(forkOptions.env.DSH_HOME, undefined)
    assert.equal(forkOptions.env.ELECKOI_DATABASE_PATH, undefined)
    assert.equal(forkOptions.env.RP_TRIAL_TEST_CREDENTIAL, 'secret-in-protected-worker-env')
    const done = worker.done.catch(() => undefined)
    const runMessage = child.messages.find(message => message.type === 'run')
    assert.equal(Object.hasOwn(runMessage.plan, 'workerCredentials'), false, 'Credential values travel through protected worker environment, not serialized run snapshots.')
    const first = worker.cancel('user cancellation')
    const second = worker.cancel('plugin shutdown')
    assert.equal(child.messages.filter(message => message.type === 'cancel').length, 1)
    child.emit('message', { type: 'cancelled' })
    await Promise.all([first, second])
    assert.equal(child.killed, false)
    child.connected = false
    child.emit('exit', 0, null)
    await done
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('worker exit retains a bounded stderr tail and scrubs worker credentials', async () => {
  class FakeChild extends EventEmitter {
    connected = true
    stderr = new EventEmitter()
    send() {}
    kill() {}
  }
  const child = new FakeChild()
  const home = mkdtempSync(join(tmpdir(), 'rp-team-trial-worker-stderr-'))
  let forkOptions
  try {
    const worker = runTrialWorkerProcess({
      workerRoot: join(home, 'worker-root'),
      workerCredentials: { RP_TRIAL_TEST_CREDENTIAL: 'worker-secret-fixture' },
      forkProcess: (_entry, _args, options) => { forkOptions = options; return child },
    })
    const done = worker.done.catch(error => error)
    child.stderr.emit('data', Buffer.from(`Cannot resolve module; key=worker-secret-fixture\n`))
    child.emit('exit', 1, null)
    const error = await done
    assert.deepEqual(forkOptions.stdio, ['ignore', 'ignore', 'pipe', 'ipc'])
    assert.match(error.message, /Cannot resolve module/u)
    assert.match(error.message, /\[credential omitted\]/u)
    assert.doesNotMatch(error.message, /worker-secret-fixture/u)
  } finally { rmSync(home, { recursive: true, force: true }) }
})
