import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { materializeTrialConfig, prepareTrialPrompt, trialVariantStorageKey } from '../src/host/trial-worker.mjs'
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

test('concurrent worker cancel callers share one IPC request and clear the watchdog after acknowledgement', async () => {
  class FakeChild extends EventEmitter {
    connected = true
    killed = false
    messages = []
    send(message) { this.messages.push(message) }
    kill() { this.killed = true }
  }
  const child = new FakeChild()
  const worker = runTrialWorkerProcess({
    hostRoot: 'C:/fixture-host', workerCredentials: {},
    forkProcess: (_entry, _args, _options) => child,
  })
  const done = worker.done.catch(() => undefined)
  const first = worker.cancel('user cancellation')
  const second = worker.cancel('plugin shutdown')
  assert.equal(child.messages.filter(message => message.type === 'cancel').length, 1)
  child.emit('message', { type: 'cancelled' })
  await Promise.all([first, second])
  assert.equal(child.killed, false)
  child.connected = false
  child.emit('exit', 0, null)
  await done
})
