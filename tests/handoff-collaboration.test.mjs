import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createCommunication, mergeDraftReviewIssues, parallelDraftReviewPeer } from '../src/host/communication.mjs'
import { interruptPersistedRequests, readRequestRecords } from '../src/host/request-persistence.mjs'
import { createScheduler } from '../src/host/scheduler.mjs'
import { defaultTeamConfig, exportPreset, normalizeTeamConfig } from '../src/shared/schema.mjs'
import { exportComponent } from '../src/shared/components.mjs'
import { portablePreset } from '../src/host/preset-library.mjs'

const responseSchema = {
  type: 'object', required: ['summary', 'data'], properties: {
    summary: { type: 'string' },
    data: { type: 'object', required: ['facts'], properties: { facts: { type: 'array', items: { type: 'string' } } } }
  }
}
const requestSchema = {
  type: 'object', required: ['summary', 'data'], properties: {
    summary: { type: 'string' },
    data: { type: 'object', required: ['query'], properties: { query: { type: 'string' } } }
  }
}

function handoffConfig(mode = 'await', { requestSelectors = ['/summary', '/data/query'], responseSelectors = ['/summary', '/data/facts'] } = {}) {
  return {
    execution: { maxDepth: 4, concurrency: 1, maxActivations: 8, maxPerAgent: 4 },
    agents: [
      {
        id: 'requester', triggers: [{ type: 'always' }, { type: 'requested_by_agent', from: ['target'] }], execution: { after: [] },
        communication: {
          sendTo: ['target'], receiveFrom: ['target'], requestTo: ['target'], requestFrom: [],
          handoffs: [{ id: 'lookup', to: 'target', mode, requestSchema, responseSchema,
            requestSelectors, responseSelectors, timeoutMs: 1000, onFailure: 'return_error' }]
        }
      },
      {
        id: 'target', triggers: [{ type: 'requested_by_agent', from: ['requester'] }], execution: { after: [] },
        communication: { sendTo: ['requester'], receiveFrom: ['requester'], requestTo: [], requestFrom: ['requester'] }
      }
    ]
  }
}

function deferred() {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}

function parallelHandoffConfig() {
  const config = handoffConfig()
  config.execution.concurrency = 2
  config.output = { agentId: 'requester' }
  const [requester, target] = config.agents
  const other = { ...structuredClone(target), id: 'other' }
  config.agents.push(other)
  for (const key of ['sendTo', 'receiveFrom', 'requestTo']) requester.communication[key].push(other.id)
  const [rule] = requester.communication.handoffs
  rule.parallel = true
  rule.references = true
  requester.communication.handoffs.push({ ...rule, id: 'lookup-other', to: other.id })
  return config
}

const parallelRequests = [
  { to: 'target', handoffId: 'lookup', summary: 'Find the clue', data: { query: 'where is the key' } },
  { to: 'other', handoffId: 'lookup-other', summary: 'Find another clue', data: { query: 'where is the lock' } }
]

test('draft review retains the exact forwarded world result binding only in the request record', async () => {
  const config = handoffConfig()
  const [writer, checker] = config.agents
  writer.communication.handoffs = [{ id: 'check-draft', to: checker.id, mode: 'await', references: true,
    scopedReview: true, compactReview: 'draft', timeoutMs: 1000 }]
  checker.execution = { after: [], livedHistoryDialoguePremises: true }
  const world = (requestId, ref, sourceExecutionId) => ({ requestId, ref, sourceExecutionId, handoffId: 'ask-world',
    status: 'completed', from: writer.id, result: { data: { established: [], surface: {} } } })
  const run = { handoffRequests: [world('old-world', 'ask-world#1', 'writer:0'),
    world('world-a', 'ask-world#2', 'writer:1'), world('world-b', 'ask-world#3', 'writer:1')] }
  const communication = createCommunication(config, { run, async onRequest({ requestId }) {
    await communication.bindTargetExecution(requestId, 'checker:1')
    await communication.completeTarget({ requestId, targetExecutionId: 'checker:1', result: { data: { pass: true, issues: [] } } })
  } })
  const request = async world_return => {
    await communication.request({ from: writer.id, to: checker.id, executionId: 'writer:1',
      handoffId: 'check-draft', data: { draft: '正文。', world_return } })
    return run.handoffRequests.at(-1)
  }
  const linked = await request({ $ref: 'ask-world#2' })
  assert.equal(linked.worldReviewRequestId, 'world-a')
  assert.ok(!Object.hasOwn(communication.allMessages().find(message => message.requestId === linked.requestId), 'worldReviewRequestId'))
  assert.equal((await request({ $ref: 'ask-world#1' })).worldReviewRequestId, undefined)
  assert.equal((await request({ $ref: 'ask-world#2', pointer: '/surface' })).worldReviewRequestId, undefined)
  assert.equal((await request({ established: [] })).worldReviewRequestId, undefined)
  checker.execution = { after: [] }
  assert.equal((await request({ $ref: 'ask-world#2' })).worldReviewRequestId, undefined)
})

test('parallel handoffs overlap under the scheduler and release and reacquire the requester slot once', async () => {
  const config = parallelHandoffConfig()
  const bothRunning = deferred()
  const secondFinished = deferred()
  const started = []
  const events = []
  let result
  let scheduler
  const communication = createCommunication(config, {
    onRequest: activation => scheduler.requestActivation(activation),
    onAwait: ({ from, requestId, promise }) => scheduler.waitForHandoff({ agentId: from, requestId, promise }),
    onTrace: event => events.push(event)
  })
  scheduler = createScheduler({
    config, onTrace: event => events.push(event),
    async onActivate({ agent, activation }) {
      if (agent.id === 'requester') {
        result = await communication.requestMany({ from: agent.id, executionId: 'requester:1', requests: parallelRequests })
        return
      }
      await communication.bindTargetExecution(activation.requestId, agent.id)
      started.push(agent.id)
      if (started.length === 2) bothRunning.resolve()
      await bothRunning.promise
      if (agent.id === 'other') throw Object.assign(new Error('Other target failed'), { code: 'TEST_FAILURE' })
      await secondFinished.promise
    },
    async onActivationTerminal({ agent, activation, status, error }) {
      if (!activation.requestId) return
      if (status === 'complete') {
        await communication.completeTarget({ requestId: activation.requestId, targetExecutionId: agent.id,
          result: { typed: true, summary: 'Key found', data: { facts: ['key'] } } })
      } else {
        await communication.failTarget({ requestId: activation.requestId, targetExecutionId: agent.id, error })
        secondFinished.resolve()
      }
    }
  })
  await scheduler.run()
  assert.deepEqual(started, ['target', 'other'])
  assert.deepEqual(result, { results: [
    { handoffId: 'lookup', status: 'completed', ref: 'lookup#1', summary: 'Key found', data: { facts: ['key'] } },
    { handoffId: 'lookup-other', status: 'failed', error: { code: 'TEST_FAILURE', message: 'Other target failed' } }
  ] })
  assert.deepEqual(events.filter(event => event.type === 'activation.slot_released' || event.type === 'activation.slot_reacquired')
    .map(event => [event.type, event.agentId]), [['activation.slot_released', 'requester'], ['activation.slot_reacquired', 'requester']])
  assert.deepEqual(events.filter(event => event.type === 'handoff.failed' || event.type === 'handoff.completed')
    .map(event => event.data.handoffId), ['lookup-other', 'lookup'])
})

test('parallel handoff preflight rejects the whole batch before dispatch for invalid, dependent, or unconfigured entries', async () => {
  const config = parallelHandoffConfig()
  const seen = []
  const communication = createCommunication(config, { onRequest: activation => seen.push(activation) })
  const run = (requests, depth) => communication.requestMany({ from: 'requester', requests, depth })
  const [first, other] = parallelRequests
  await assert.rejects(run([first, { ...other, data: {} }]), { code: 'RP_TEAM_HANDOFF_REQUEST_INVALID' })
  await assert.rejects(run([first, { ...other, to: 'requester' }]), { code: 'RP_TEAM_REQUEST_NOT_ALLOWED' })
  await assert.rejects(run([first, first]), { code: 'RP_TEAM_HANDOFF_BATCH_INVALID' })
  await assert.rejects(run([first, other], 4), { code: 'RP_TEAM_ACTIVATION_DEPTH' })
  config.agents[2].execution.after.push('target')
  await assert.rejects(run([first, other]), { code: 'RP_TEAM_HANDOFF_BATCH_INVALID' })
  config.agents[2].execution.after.pop()
  config.agents[0].communication.handoffs[1].parallel = false
  await assert.rejects(run([first, other]), { code: 'RP_TEAM_HANDOFF_BATCH_INVALID' })
  assert.deepEqual(seen, [])
  assert.deepEqual(communication.allMessages(), [])
  assert.deepEqual(communication.pendingRequests(), [])
})

test('cancelling a batch before its activations dispatch settles both branches without starting those activations', async () => {
  const dispatchReady = deferred()
  const releaseDispatch = deferred()
  const seen = []
  let changes = 0
  const communication = createCommunication(parallelHandoffConfig(), {
    onRequest: activation => seen.push(activation),
    onChange: () => {
      changes++
      if (changes === 2) dispatchReady.resolve()
      if (changes <= 2) return releaseDispatch.promise
    }
  })
  const outcome = communication.requestMany({ from: 'requester', requests: parallelRequests })
  await dispatchReady.promise
  await communication.cancelAll('Stopped')
  releaseDispatch.resolve()
  assert.deepEqual(await outcome, { results: parallelRequests.map(({ handoffId }) => ({
    handoffId, status: 'failed', error: { code: 'RP_TEAM_CANCELLED', message: 'Stopped' }
  })) })
  assert.deepEqual(seen, [])
  assert.deepEqual(communication.pendingRequests(), [])
})

function scheduleConfig({ maxActivations = 8, maxPerAgent = 4 } = {}) {
  return {
    execution: { concurrency: 1, maxActivations, maxPerAgent, maxDepth: 4 },
    output: { agentId: 'requester' },
    agents: [
      { id: 'requester', triggers: [{ type: 'always' }, { type: 'requested_by_agent', from: ['target'] }], execution: { after: [] } },
      { id: 'target', triggers: [{ type: 'requested_by_agent', from: ['requester'] }], execution: { after: [] } }
    ]
  }
}

test('await releases the only scheduler slot, resumes the same activation after reacquisition, and serializes same-agent work', async () => {
  const events = []
  const result = deferred()
  let scheduler
  scheduler = createScheduler({
    config: scheduleConfig(),
    onTrace: event => events.push(event),
    onActivate: async ({ agent, activation, activationNo, waitForHandoff }) => {
      if (agent.id === 'requester' && activationNo === 1) {
        scheduler.requestActivation({ from: 'requester', to: 'target', depth: 0, requestId: 'await-1' })
        await waitForHandoff({ agentId: 'requester', requestId: 'await-1', promise: result.promise })
        events.push({ type: 'test.requester_resumed' })
      } else if (agent.id === 'target') {
        scheduler.requestActivation({ from: 'target', to: 'requester', depth: 1 })
        result.resolve({ summary: 'ready' })
      } else {
        events.push({ type: 'test.requester_revision' })
      }
    }
  })
  await scheduler.run()
  const types = events.map(event => event.type)
  const released = types.indexOf('activation.slot_released')
  const targetStarted = types.indexOf('activation.started', released)
  const targetCompleted = types.indexOf('activation.completed', targetStarted)
  const reacquired = types.indexOf('activation.slot_reacquired', targetCompleted)
  const resumed = types.indexOf('test.requester_resumed', reacquired)
  const revision = types.indexOf('test.requester_revision', resumed)
  assert.ok(released >= 0 && released < targetStarted && targetStarted < targetCompleted)
  assert.ok(targetCompleted < reacquired && reacquired < resumed && resumed < revision, types.join(', '))
  assert.equal(types.filter(type => type === 'test.requester_revision').length, 1)
})

test('resume reserves the source activation and queues it only after source and target finish', async () => {
  const activations = []
  const schedulerTrace = []
  let scheduler
  scheduler = createScheduler({
    config: scheduleConfig({ maxActivations: 3, maxPerAgent: 2 }),
    onTrace: event => schedulerTrace.push(event),
    onActivate: async ({ agent, activation, activationNo }) => {
      activations.push(`${agent.id}:${activationNo}`)
      if (agent.id === 'requester' && activationNo === 1) {
        const result = scheduler.requestActivation({ from: 'requester', to: 'target', depth: 0,
          requestId: 'resume-1', reserveResume: true })
        assert.equal(result.queued, true)
        assert.equal(scheduler.getStatus().reserved, 1)
      }
    },
    onActivationTerminal: async ({ agent, activation, status }) => {
      if (activation.requestId !== 'resume-1' && agent.id === 'requester' && status === 'complete') {
        scheduler.settleResumeReservation('resume-1', 'source', true)
      }
      if (activation.requestId === 'resume-1' && status === 'complete') {
        scheduler.settleResumeReservation('resume-1', 'target', true)
      }
    }
  })
  await scheduler.run()
  assert.deepEqual(activations, ['requester:1', 'target:1', 'requester:2'], schedulerTrace.map(event => `${event.type}:${event.agentId}:${event.data?.requestId ?? ''}`).join(', '))
  assert.equal(scheduler.getStatus().reserved, 0)
  assert.equal(schedulerTrace.filter(event => event.type === 'activation.queued' && event.data.resumeFromRequestId === 'resume-1').length, 1)
})

function chainConfig(ids, maxDepth) {
  return {
    execution: { concurrency: 1, maxActivations: 8, maxPerAgent: 2, maxDepth },
    output: { agentId: ids[0] },
    agents: ids.map((id, index) => ({
      id,
      triggers: index ? [{ type: 'requested_by_agent', from: [ids[index - 1]] }] : [{ type: 'always' }],
      execution: { after: [] },
      communication: {
        sendTo: [], receiveFrom: [],
        requestTo: ids[index + 1] ? [ids[index + 1]] : [], requestFrom: index ? [ids[index - 1]] : []
      }
    }))
  }
}

test('each request hop adds one depth level, so maxDepth 3 runs a three-hop chain and blocks the fourth hop', async () => {
  const ids = ['narrator', 'world', 'clerk', 'sim', 'extra']
  const config = chainConfig(ids, 3)
  const depths = {}
  const failures = []
  let scheduler
  const communication = createCommunication(config, { onRequest: activation => scheduler.requestActivation(activation) })
  scheduler = createScheduler({
    config,
    onActivate: async ({ agent, activation }) => {
      depths[agent.id] = activation.depth
      const next = ids[ids.indexOf(agent.id) + 1]
      try { await communication.request({ from: agent.id, to: next, body: 'next hop', depth: activation.depth }) }
      catch (error) { failures.push([agent.id, error.code]) }
    }
  })
  await scheduler.run()
  assert.deepEqual(depths, { narrator: 0, world: 1, clerk: 2, sim: 3 })
  assert.deepEqual(failures, [['sim', 'RP_TEAM_ACTIVATION_DEPTH']])
  assert.deepEqual(communication.allMessages().filter(message => message.type === 'request').map(message => [message.to, message.depth]),
    [['world', 1], ['clerk', 2], ['sim', 3]])
})

test('a resumed requester runs again at its own depth, not one level deeper', async () => {
  const config = { ...handoffConfig('resume'), output: { agentId: 'requester' } }
  const seen = []
  let requestId
  let scheduler
  const communication = createCommunication(config, {
    onRequest: activation => scheduler.requestActivation(activation), setTimer: () => 1, clearTimer() {}
  })
  scheduler = createScheduler({
    config,
    onActivate: async ({ agent, activation, activationNo }) => {
      seen.push(`${agent.id}:${activationNo}@${activation.depth}`)
      if (agent.id === 'requester' && activationNo === 1) {
        const result = await communication.request({ from: 'requester', to: 'target', handoffId: 'lookup',
          summary: 'Find the clue', data: { query: 'where is the key' }, depth: activation.depth, executionId: 'run:requester:1' })
        requestId = result.id
      }
    },
    onActivationTerminal: async ({ agent, activation, status }) => {
      if (status !== 'complete') return
      if (agent.id === 'requester' && !activation.resumeFromRequestId) scheduler.settleResumeReservation(requestId, 'source', true)
      if (agent.id === 'target' && activation.requestId === requestId) scheduler.settleResumeReservation(requestId, 'target', true)
    }
  })
  await scheduler.run()
  assert.deepEqual(seen, ['requester:1@0', 'target:1@1', 'requester:2@0'])
})

test('a target submission is checked against the response contract when it is made, listing every problem', async () => {
  let requestId
  const communication = createCommunication(handoffConfig(), {
    onRequest: activation => { requestId = activation.requestId; return { queued: true, requestId } },
    onAwait: async () => ({ summary: 'stub', data: { facts: [] } }), setTimer: () => 1, clearTimer() {}
  })
  await communication.request({ from: 'requester', to: 'target', handoffId: 'lookup',
    summary: 'Find the clue', data: { query: 'where is the key' }, executionId: 'run:requester:1' })
  await assert.rejects(async () => communication.checkTargetResult({ requestId, agentId: 'target', result: { summary: 'x', data: { facts: [1, 'blue door', 2] } } }),
    { code: 'RP_TEAM_HANDOFF_RESPONSE_INVALID', message: 'Handoff response /data/facts/0 must be string; /data/facts/2 must be string' })
  await assert.rejects(async () => communication.checkTargetResult({ requestId, agentId: 'target', result: { summary: 'x' } }),
    { message: 'Handoff response /data is required' })
  assert.equal(communication.checkTargetResult({ requestId, agentId: 'target', result: { summary: 'Found it.', data: { facts: ['blue door'] } } }), true)
  assert.equal(communication.checkTargetResult({ requestId, agentId: 'requester', result: { summary: 'not the target' } }), false,
    'only the target of the request is held to its response contract')

  const notify = handoffConfig('notify')
  delete notify.agents[0].communication.handoffs[0].responseSchema
  assert.equal(createCommunication(notify).checkTargetResult({ requestId: 'missing', agentId: 'target', result: {} }), false)
})

test('validation messages list every problem with paths and name the allowed values', async () => {
  const { describeValueSchema, formatValueIssues } = await import('../src/shared/value-schema.mjs')
  const issues = Array.from({ length: 10 }, (_, index) => ({ path: `/items/${index}`, message: 'is required' }))
  assert.equal(formatValueIssues(issues.slice(0, 2), { prefix: 'shared/list' }), 'shared/list/items/0 is required; shared/list/items/1 is required')
  assert.match(formatValueIssues(issues), /\/items\/7 is required; and 2 more problems$/u)
  assert.equal(formatValueIssues([{ path: '', message: 'must be an object' }], { emptyPath: '/' }), '/ must be an object')
  assert.equal(describeValueSchema({
    type: 'object', required: ['who', 'how'], properties: {
      who: { type: 'string' }, how: { enum: ['saw', 'heard'] }, tags: { type: 'array', items: { type: 'string' } },
      confidence: { type: 'number', minimum: 0, maximum: 1 }, notes: { type: 'object' }
    }
  }), '{who*: string, how*: "saw" | "heard", tags: [string], confidence: number 0..1, notes: object}')
})

test('await handoff projects both envelopes, rejects unrelated target executions, and persists exact correlation', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'rp-team-handoff-'))
  const trace = []
  let communication
  const config = handoffConfig()
  communication = createCommunication(config, {
    run: { runId: 'run-new', conversationId: 'conversation' }, requestTraceRoot: directory,
    onTrace: event => trace.push(event), onRequest: ({ requestId }) => {
      queueMicrotask(async () => {
        await communication.bindTargetExecution(requestId, 'run-new:target:1')
        await assert.rejects(communication.completeTarget({ requestId, targetExecutionId: 'other-run:target:1',
          result: { typed: true, summary: 'stolen', data: { facts: ['wrong'] } } }), { code: 'RP_TEAM_HANDOFF_TARGET_MISMATCH' })
        await communication.completeTarget({ requestId, targetExecutionId: 'run-new:target:1', result: {
          typed: true, summary: 'Found the clue.', data: { facts: ['blue door'], private: 'strip me' }
        } })
      })
      return { queued: true, requestId }
    }
  })
  try {
    const result = await communication.request({ from: 'requester', to: 'target', handoffId: 'lookup',
      summary: 'Find the clue', data: { query: 'where is the key', secret: 'strip me' }, executionId: 'run-new:requester:1' })
    assert.deepEqual(result, { summary: 'Found the clue.', data: { facts: ['blue door'] } },
      'a team without references keeps the plain projected result')
    const request = communication.messagesFor('target').find(message => message.type === 'request')
    assert.deepEqual({ summary: request.summary, data: request.data }, {
      summary: 'Find the clue', data: { query: 'where is the key' }
    })
    const row = communication.getRequest(request.requestId)
    assert.equal(row.status, 'completed')
    assert.equal(row.targetExecutionId, 'run-new:target:1')
    assert.equal(row.sourceExecutionId, 'run-new:requester:1')
    assert.equal(row.result.data.private, undefined)
    assert.ok(trace.some(event => event.type === 'handoff.result_delivered'))
    assert.deepEqual(readRequestRecords(directory, 'conversation', 'run-new'), [row])
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('declared handoffs cannot be omitted or bypassed by a broadcast; empty selectors project no fields', async () => {
  const config = handoffConfig('notify', { requestSelectors: [], responseSelectors: [] })
  delete config.agents[0].communication.handoffs[0].requestSchema
  const communication = createCommunication(config)
  await assert.rejects(communication.request({ from: 'requester', to: 'target', summary: 'bypass' }), { code: 'RP_TEAM_HANDOFF_REQUIRED' })
  await assert.rejects(communication.send({ from: 'requester', to: '*', summary: 'broadcast bypass' }), { code: 'RP_TEAM_HANDOFF_REQUIRED' })
  await communication.send({ from: 'requester', to: 'target', handoffId: 'lookup', summary: 'secret', data: { secret: true } })
  const message = communication.messagesFor('target').find(item => item.type === 'message')
  assert.equal(message.summary, '')
  assert.equal(message.body, '')
  assert.equal(Object.hasOwn(message, 'data'), false)
})

test('notify handoffs never schedule a target and JSON Pointer projection keeps magic keys as own data', async () => {
  const config = handoffConfig('notify', {
    requestSelectors: ['/data', '/data/__proto__/value', '/data/constructor/prototype/value'], responseSelectors: []
  })
  delete config.agents[0].communication.handoffs[0].requestSchema
  let activationCalls = 0
  const communication = createCommunication(config, { onRequest: () => { activationCalls++; return {} } })
  const data = JSON.parse('{"__proto__":{"value":"own"},"constructor":{"prototype":{"value":"safe"}}}')
  await assert.rejects(communication.request({ from: 'requester', to: 'target', handoffId: 'lookup', summary: 'Inspect', data, executionId: 'run:requester:1' }), { code: 'RP_TEAM_HANDOFF_MESSAGE_REQUIRED' })
  await communication.send({ from: 'requester', to: 'target', handoffId: 'lookup', summary: 'Inspect', data })
  const request = communication.allMessages().find(message => message.type === 'message')
  assert.equal(request.data.__proto__.value, 'own')
  assert.equal(request.data.constructor.prototype.value, 'safe')
  assert.equal(Object.getPrototypeOf(request.data), Object.prototype)
  assert.equal(Object.prototype.value, undefined)
  assert.equal(activationCalls, 0)
  assert.equal(communication.pendingRequests().length, 0)
  assert.equal(communication.allMessages().some(message => message.type === 'handoff_result'), false)

  const overlapping = handoffConfig('notify', { requestSelectors: ['/data/value', '/data/value/x'], responseSelectors: [] })
  delete overlapping.agents[0].communication.handoffs[0].requestSchema
  const overlapCommunication = createCommunication(overlapping)
  await overlapCommunication.send({ from: 'requester', to: 'target', handoffId: 'lookup', data: { value: 'already selected' } })
  assert.deepEqual(overlapCommunication.messagesFor('target')[0].data, { value: 'already selected' })
})

test('a successful completed target is reused only for an explicit matching retry', async () => {
  const source = {
    requestId: 'old-request', sourceRunId: 'old-run', targetExecutionId: 'old-run:target:1',
    status: 'completed', mode: 'await', handoffId: 'lookup', from: 'requester', to: 'target',
    request: { summary: 'Find the clue', data: { query: 'where is the key' } },
    responseSchema, responseSelectors: ['/summary', '/data/facts'],
    result: { summary: 'Found it.', data: { facts: ['under the cup'] } }
  }
  let activationCalls = 0
  const communication = createCommunication(handoffConfig(), {
    reusableRequests: [source], onRequest: () => { activationCalls += 1; throw new Error('must not run a model') }
  })
  const result = await communication.request({ from: 'requester', to: 'target', handoffId: 'lookup',
    summary: 'Find the clue', data: { query: 'where is the key' }, executionId: 'new-run:requester:1' })
  assert.deepEqual(result, source.result)
  assert.equal(activationCalls, 0)
  const request = communication.allMessages().find(message => message.type === 'request')
  const row = communication.getRequest(request.requestId)
  assert.equal(row.ref, 'lookup#1', 'a reused request is numbered in the new run')
  const reused = communication.allMessages().find(message => message.type === 'handoff_result')
  assert.deepEqual({ summary: reused.summary, data: reused.data }, source.result)
  assert.equal(Object.hasOwn(reused, 'ref'), false, 'members that cannot write references never see one')
  assert.equal(communication.pendingRequests().length, 0)
  assert.equal(row.reusedFromRunId, 'old-run')
  assert.equal(row.targetExecutionId, 'old-run:target:1')
})

// A requester with one plain await handoff (lookup) and one that allows references (forward). Each request is
// answered from `answers` in order; `fail` answers with an error instead.
function referenceHarness({ answers = [], fail } = {}) {
  const config = handoffConfig()
  config.agents[0].communication.handoffs.push({ id: 'forward', to: 'target', mode: 'await', references: true, timeoutMs: 1000, onFailure: 'return_error',
    requestSchema: { type: 'object', required: ['data'], properties: { data: { type: 'object', required: ['first'], properties: { first: { type: 'array', items: { type: 'string' } } } } } } })
  const trace = []
  const queue = [...answers]
  let communication
  communication = createCommunication(config, {
    run: { runId: 'run', conversationId: 'conversation' }, onTrace: event => trace.push(event), setTimer: () => 1, clearTimer() {},
    onRequest: ({ requestId }) => {
      queueMicrotask(async () => {
        await communication.bindTargetExecution(requestId, `run:target:${requestId}`)
        if (fail) await communication.failTarget({ requestId, targetExecutionId: `run:target:${requestId}`, error: fail })
        else await communication.completeTarget({ requestId, targetExecutionId: `run:target:${requestId}`, result: { typed: true, ...queue.shift() } })
      })
      return { queued: true, requestId }
    }
  })
  return { communication, trace }
}

test('handoff references forward an earlier result or request verbatim, numbered per sender and handoff', async () => {
  const { communication, trace } = referenceHarness({ answers: [
    { summary: 'First.', data: { facts: ['blue door', 'under "the" cup'] } },
    { summary: 'Second.', data: { facts: ['red key'] } },
    { summary: 'Forwarded.' }
  ] })
  const ask = query => communication.request({ from: 'requester', to: 'target', handoffId: 'lookup', summary: 'Find', data: { query }, executionId: 'run:requester:1' })
  assert.deepEqual(await ask('where is the key'), { ref: 'lookup#1', summary: 'First.', data: { facts: ['blue door', 'under "the" cup'] } },
    'a member that can write references receives each result with the ref that names it')
  assert.equal((await ask('where is the door')).ref, 'lookup#2')
  assert.equal(communication.allMessages().find(message => message.type === 'handoff_result').ref, 'lookup#1')

  await communication.request({ from: 'requester', to: 'target', handoffId: 'forward', summary: 'Both answers', executionId: 'run:requester:1', data: {
    first: { $ref: 'lookup#1', pointer: '/facts' },
    second: { $ref: 'lookup#2' },
    asked: [{ $ref: 'lookup#1', side: 'request' }],
    literal: { $ref: 'lookup#1', note: 'extra keys make this ordinary data' }
  } })
  const forwarded = communication.messagesFor('target').filter(message => message.type === 'request').at(-1)
  assert.deepEqual(forwarded.data, {
    first: ['blue door', 'under "the" cup'],
    second: { facts: ['red key'] },
    asked: [{ query: 'where is the key' }],
    literal: { $ref: 'lookup#1', note: 'extra keys make this ordinary data' }
  })
  assert.equal(communication.getRequest(forwarded.requestId).ref, 'forward#1')
  assert.deepEqual(trace.find(event => event.type === 'handoff.refs_resolved'), {
    type: 'handoff.refs_resolved', agentId: 'requester', data: { handoffId: 'forward', direction: 'request', refs: [
      { ref: 'lookup#1', side: 'result', pointer: '/facts', at: '/first' },
      { ref: 'lookup#2', side: 'result', at: '/second' },
      { ref: 'lookup#1', side: 'request', at: '/asked/0' }
    ] }
  })

  // Answers that forward by reference resolve against what the answering member itself sent.
  const answer = communication.resolveRefs({ writer: 'requester', data: { attempts: { $ref: 'lookup#2', pointer: '/facts' } }, handoffId: 'forward' })
  assert.deepEqual(answer.data, { attempts: ['red key'] })
  answer.trace()
  assert.equal(trace.filter(event => event.type === 'handoff.refs_resolved').at(-1).data.direction, 'response')
  assert.throws(() => communication.resolveRefs({ writer: 'target', data: { x: { $ref: 'lookup#1' } } }),
    { code: 'RP_TEAM_HANDOFF_REF_INVALID', message: /does not name a request you sent.*You have sent no handoff requests/su },
    'a member cannot reference another member’s requests')

  // The answering side resolves only for a handoff that allows references, and only for its target.
  const plain = communication.getRequest(communication.allMessages().find(message => message.handoffId === 'lookup').requestId)
  const reference = { x: { $ref: 'lookup#1' } }
  assert.deepEqual(communication.resolveAnswerRefs({ requestId: plain.requestId, agentId: 'target', data: reference }).data, reference)
  assert.deepEqual(communication.resolveAnswerRefs({ requestId: forwarded.requestId, agentId: 'requester', data: reference }).data, reference,
    'only the target answers a request')
  assert.throws(() => communication.resolveAnswerRefs({ requestId: forwarded.requestId, agentId: 'target', data: reference }),
    { code: 'RP_TEAM_HANDOFF_REF_INVALID', message: /You have sent no handoff requests/u },
    'the target’s answer resolves against requests the target sent')
  assert.equal(communication.resolveAnswerRefs({ requestId: forwarded.requestId, agentId: 'target' }).data, undefined)
})

test('a bad handoff reference is returned to the writer with the references it can use; plain handoffs never resolve', async () => {
  const { communication } = referenceHarness({ answers: [{ summary: 'First.', data: { facts: ['blue door'] } }] })
  await communication.request({ from: 'requester', to: 'target', handoffId: 'lookup', summary: 'Find', data: { query: 'key' }, executionId: 'run:requester:1' })
  const forward = data => communication.request({ from: 'requester', to: 'target', handoffId: 'forward', summary: 'x', data, executionId: 'run:requester:1' })
  await assert.rejects(forward({ first: { $ref: 'lookup#3' } }),
    { code: 'RP_TEAM_HANDOFF_REF_INVALID', message: /lookup#3 at \/first does not name a request you sent in this run\. References you can use: lookup#1 \(result and request\)\./u })
  await assert.rejects(forward({ first: { $ref: 'lookup#1', pointer: '/missing' } }),
    { code: 'RP_TEAM_HANDOFF_REF_INVALID', message: /finds nothing at result data\/missing/u })
  await assert.rejects(forward({ first: { $ref: 'lookup#1', side: 'answer' } }), { code: 'RP_TEAM_HANDOFF_REF_INVALID' })
  await assert.rejects(forward({ first: { $ref: 'lookup#1' } }), { code: 'RP_TEAM_HANDOFF_REQUEST_INVALID' },
    'the expanded original is still checked against the request schema')
  await assert.rejects(communication.request({ from: 'requester', to: 'target', handoffId: 'lookup', summary: 'x',
    data: { query: { $ref: 'lookup#1' } }, executionId: 'run:requester:1' }), { code: 'RP_TEAM_HANDOFF_REQUEST_INVALID' },
  'a handoff without references keeps $ref objects as ordinary data')
})

test('a failed target reaches the requester without the raw model output; the request row keeps the full text', async () => {
  const upstream = 'Tool call "rp_team_submit_internal": Expected \',\' or \']\' after array element in JSON at position 2898\n\nReceived arguments:\n{"attempts": [{"beats": [}]}'
  const { communication } = referenceHarness({ fail: new Error(upstream) })
  await assert.rejects(communication.request({ from: 'requester', to: 'target', handoffId: 'lookup', summary: 'Find', data: { query: 'key' }, executionId: 'run:requester:1' }),
    error => {
      assert.equal(error.code, 'RP_TEAM_HANDOFF_FAILED')
      assert.equal(error.message, 'Target target failed: its model produced malformed arguments for tool rp_team_submit_internal; nothing from that output was returned.')
      return true
    })
  const delivered = communication.allMessages().find(message => message.type === 'handoff_result')
  assert.equal(delivered.status, 'failed')
  assert.equal(JSON.stringify(delivered).includes('Received arguments'), false)
  assert.equal(communication.getRequest(delivered.requestId).error.message, upstream, 'the row and the trace keep the full upstream text')

  const long = referenceHarness({ fail: new Error(`${'x'.repeat(600)}\n\nReceived arguments:\n{}`) })
  await assert.rejects(long.communication.request({ from: 'requester', to: 'target', handoffId: 'lookup', summary: 'Find', data: { query: 'key' }, executionId: 'run:requester:1' }),
    error => error.message === `${'x'.repeat(400)}…`)
})

test('resume retry reuse reserves only the new source activation and queues it after that activation completes', async () => {
  const old = {
    requestId: 'old-resume', sourceRunId: 'old-run', targetExecutionId: 'old-run:target:1',
    status: 'completed', mode: 'resume', handoffId: 'lookup', from: 'requester', to: 'target',
    request: { summary: 'Find the clue', data: { query: 'where is the key' } },
    responseSchema, responseSelectors: ['/summary', '/data/facts'],
    result: { summary: 'Found it.', data: { facts: ['under the cup'] } }
  }
  let handoffActivation
  const resumed = []
  const communication = createCommunication(handoffConfig('resume'), {
    reusableRequests: [old], onRequest: activation => { handoffActivation = activation; return { queued: false, reused: true } },
    onResume: details => resumed.push(details)
  })
  const result = await communication.request({ from: 'requester', to: 'target', handoffId: 'lookup',
    summary: 'Find the clue', data: { query: 'where is the key' }, executionId: 'new-run:requester:1' })
  assert.deepEqual(result, { id: communication.allMessages().find(message => message.type === 'request').id,
    activation: { queued: false, reused: true }, handoffId: 'lookup', mode: 'resume' })
  assert.equal(handoffActivation.reuseTarget, true)
  assert.equal(handoffActivation.reserveResume, true)
  await communication.activationFinished({ agentId: 'requester', executionId: 'new-run:requester:1', status: 'complete' })
  assert.equal(resumed.length, 1)
  assert.equal(resumed[0].succeeded, true)
  assert.equal(resumed[0].targetExecutionId, 'old-run:target:1')
})

test('wait cycles fail clearly and crashed in-flight requests become interrupted without model restart', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'rp-team-interrupted-'))
  const config = handoffConfig()
  config.agents.find(agent => agent.id === 'target').execution.after = ['requester']
  const communication = createCommunication(config, {
    run: { runId: 'run-orphan', conversationId: 'conversation' }, requestTraceRoot: directory,
    onRequest: () => ({ queued: true }), setTimer: () => 1, clearTimer() {}
  })
  try {
    await assert.rejects(communication.request({ from: 'requester', to: 'target', handoffId: 'lookup',
      summary: 'Find the clue', data: { query: 'where is the key' }, executionId: 'run-orphan:requester:1' }),
    { code: 'RP_TEAM_HANDOFF_CYCLE' })
    config.agents.find(agent => agent.id === 'target').execution.after = []
    config.agents[0].communication.handoffs[0].mode = 'resume'
    const open = createCommunication(config, {
      run: { runId: 'run-orphan', conversationId: 'conversation' }, requestTraceRoot: directory,
      onRequest: () => ({ queued: true }), setTimer: () => 1, clearTimer() {}
    })
    await open.request({ from: 'requester', to: 'target', handoffId: 'lookup',
      summary: 'Find the clue', data: { query: 'where is the key' }, executionId: 'run-orphan:requester:1' })
    const recovered = interruptPersistedRequests(directory, 'conversation', 'run-orphan')
    assert.equal(recovered[0].status, 'interrupted')
    assert.equal(recovered[0].error.code, 'RP_TEAM_HANDOFF_INTERRUPTED')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('handoff schemas normalize selectors, defaults, uniqueness, target references, and minimum plugin version', () => {
  const legacy = defaultTeamConfig()
  assert.equal(Object.hasOwn(legacy.agents[0].communication, 'handoffs'), false)
  assert.equal(Object.hasOwn(exportPreset(legacy).dependencies, 'minimumPluginVersion'), false)

  const withRule = structuredClone(legacy)
  withRule.agents[0].communication.handoffs = [{
    id: 'lookup', to: 'agent-2', mode: 'await',
    requestSelectors: ['/summary', '/data/a~1b', '/summary'], responseSelectors: ['']
  }]
  const normalized = normalizeTeamConfig(withRule)
  assert.deepEqual(normalized.agents[0].communication.handoffs[0], {
    id: 'lookup', to: 'agent-2', mode: 'await', timeoutMs: 300000, onFailure: 'return_error',
    requestSelectors: ['/summary', '/data/a~1b'], responseSelectors: ['']
  })
  assert.deepEqual(normalized.agents[0].communication.sendTo, legacy.agents[0].communication.sendTo)
  assert.equal(exportPreset(normalized).dependencies.minimumPluginVersion, '0.3.0')

  const duplicate = structuredClone(withRule)
  duplicate.agents[0].communication.handoffs.push({ id: 'lookup', to: 'agent-2', mode: 'notify' })
  assert.throws(() => normalizeTeamConfig(duplicate), /Duplicate handoff id/u)
  const invalidSelector = structuredClone(withRule)
  invalidSelector.agents[0].communication.handoffs[0].requestSelectors = ['/data/~2']
  assert.throws(() => normalizeTeamConfig(invalidSelector), /Invalid JSON Pointer/u)
  const invalidTarget = structuredClone(withRule)
  invalidTarget.agents[0].communication.handoffs[0].to = 'missing-agent'
  assert.throws(() => normalizeTeamConfig(invalidTarget), /unknown agent/u)

  const withReferences = structuredClone(withRule)
  withReferences.agents[0].communication.handoffs[0].references = true
  assert.equal(normalizeTeamConfig(withReferences).agents[0].communication.handoffs[0].references, true)
  assert.equal(exportPreset(withReferences).dependencies.minimumPluginVersion, '0.7.4', 'references need plugin 0.7.4')
  withReferences.agents[0].communication.handoffs[0].references = false
  assert.equal(Object.hasOwn(normalizeTeamConfig(withReferences).agents[0].communication.handoffs[0], 'references'), false)
  withReferences.agents[0].communication.handoffs[0].references = 'yes'
  assert.throws(() => normalizeTeamConfig(withReferences), /Handoff references must be true or false/u)
})

test('terminal handoffs require typed responses and export the 0.7.5 requirement', () => {
  const config = defaultTeamConfig()
  const handoff = { id: 'lookup', to: 'agent-2', mode: 'await', responseSchema, references: true, terminal: true }
  config.agents[0].communication.handoffs = [handoff]
  assert.equal(normalizeTeamConfig(config).agents[0].communication.handoffs[0].terminal, true)
  assert.equal(exportPreset(config).dependencies.minimumPluginVersion, '0.7.5')
  assert.equal(portablePreset(config).dependencies.minimumPluginVersion, '0.7.5')
  assert.equal(exportComponent(config, ['agent-1'], 'Terminal requester').dependencies.minimumPluginVersion, '0.7.5')
  handoff.mode = 'resume'
  assert.equal(normalizeTeamConfig(config).agents[0].communication.handoffs[0].terminal, true)
  handoff.mode = 'notify'
  assert.throws(() => normalizeTeamConfig(config), /A terminal handoff must await or resume and have a responseSchema/u)
  handoff.mode = 'await'
  delete handoff.responseSchema
  assert.throws(() => normalizeTeamConfig(config), /A terminal handoff must await or resume and have a responseSchema/u)
  handoff.terminal = false
  assert.equal(Object.hasOwn(normalizeTeamConfig(config).agents[0].communication.handoffs[0], 'terminal'), false)
})

test('parallel handoffs are await-only and survive exports with the 0.7.6 requirement', () => {
  const config = defaultTeamConfig()
  const handoff = { id: 'lookup', to: 'agent-2', mode: 'await', parallel: true }
  config.agents[0].communication.handoffs = [handoff]
  const preset = exportPreset(config)
  assert.equal(preset.config.agents[0].communication.handoffs[0].parallel, true)
  assert.equal(preset.dependencies.minimumPluginVersion, '0.7.6')
  assert.equal(portablePreset(config).dependencies.minimumPluginVersion, '0.7.6')
  assert.equal(exportComponent(config, ['agent-1'], 'Parallel requester').dependencies.minimumPluginVersion, '0.7.6')
  handoff.mode = 'resume'
  assert.throws(() => normalizeTeamConfig(config), /Only await handoffs/u)
  handoff.parallel = 'yes'
  assert.throws(() => normalizeTeamConfig(config), /Handoff parallel must be true or false/u)
})

test('an approved draft reference only resolves the requesting writer’s passed request text', async () => {
  const config = handoffConfig('await', { requestSelectors: undefined, responseSelectors: undefined })
  const rule = config.agents[0].communication.handoffs[0]
  delete rule.requestSchema
  delete rule.requestSelectors
  delete rule.responseSelectors
  rule.responseSchema = { type: 'object', required: ['data'], properties: {
    data: { type: 'object', required: ['pass'], properties: { pass: { type: 'boolean' } } }
  } }
  rule.references = true
  rule.terminal = true
  const draft = '\n  这一份原稿。\r\n'
  const responseTrace = []
  let pass = false
  const communication = createCommunication(config, {
    onTrace: event => responseTrace.push(event),
    onRequest: async ({ requestId }) => {
      await communication.bindTargetExecution(requestId, 'check-execution')
      await communication.completeTarget({ requestId, targetExecutionId: 'check-execution', result: { summary: 'Check complete', data: { pass }, typed: true } })
    }
  })
  const request = () => communication.request({ from: 'requester', to: 'target', handoffId: 'lookup', data: { draft, unrelated: 'other field' } })
  const reference = $ref => ({ $ref, side: 'request', pointer: '/draft' })
  const rejected = await request()
  assert.throws(() => communication.resolveApprovedBody({ writer: 'requester', bodyRef: reference(rejected.ref) }), { code: 'RP_TEAM_HANDOFF_REF_INVALID' })
  pass = true
  const approved = await request()
  assert.throws(() => communication.resolveApprovedBody({ writer: 'target', bodyRef: reference(approved.ref) }), { code: 'RP_TEAM_HANDOFF_REF_INVALID' })
  assert.throws(() => communication.resolveApprovedBody({ writer: 'requester', bodyRef: { ...reference(approved.ref), pointer: '/unrelated' } }), { code: 'RP_TEAM_HANDOFF_REF_INVALID' })
  const result = communication.resolveApprovedBody({ writer: 'requester', bodyRef: reference(approved.ref) })
  assert.equal(result.data, draft)
  result.trace()
  assert.ok(responseTrace.some(event => event.type === 'handoff.refs_resolved' && event.data.direction === 'publication'))
})

test('parallel draft review merges exact ordered issues and preserves individual receipts', async t => {
  const config = parallelHandoffConfig()
  const writer = config.agents[0]
  writer.execution.livedHistoryParallelDraftReview = true
  writer.execution.livedHistoryWriterPresentation = true
  const [fact, presentation] = writer.communication.handoffs
  const verdictSchema = { type: 'object', required: ['data'], properties: { data: {
    type: 'object', required: ['pass', 'issues'], properties: { pass: { type: 'boolean' }, issues: { type: 'array' } }
  } } }
  for (const [index, rule] of [fact, presentation].entries()) {
    Object.assign(rule, { id: index ? 'check-draft-presentation' : 'check-draft', compactReview: 'draft',
      scopedReview: true, terminal: true, autoPublish: !index, responseSchema: verdictSchema })
    delete rule.requestSchema
    delete rule.requestSelectors
    delete rule.responseSelectors
  }
  const draft = '灰色的按钮。黑笔迹。看见暗屏通知。'
  const left = { kind: '未确立的事', quote: '黑笔迹。', note: '无该事实。' }
  const right = { kind: '知情越界', quote: '看见暗屏通知。', note: '暗屏不可知。' }
  const pass = { pass: true, issues: [] }
  const fail = (...issues) => ({ pass: false, issues })
  let verdicts = [fail(right, left), fail({ ...right, note: '没有可见来源。' })]
  const run = { conversationId: 'conversation', runId: 'parallel-review' }
  const traceRoot = mkdtempSync(join(tmpdir(), 'rp-team-paired-review-'))
  t.after(() => rmSync(traceRoot, { recursive: true, force: true }))
  const arrivals = []
  const writerProof = [{ event: 'world-event', coverage: 'full', quotes: ['灰色的按钮。'] }]
  const communication = createCommunication(config, { run, requestTraceRoot: traceRoot, onWriterPresentation: () => writerProof,
    async onRequest(activation) {
    arrivals.push(activation)
    const lane = activation.handoffId === fact.id ? 0 : 1
    const targetExecutionId = `checker:${activation.requestId}`
    await communication.bindTargetExecution(activation.requestId, targetExecutionId)
    const data = verdicts[lane]
    if (data) await communication.completeTarget({ requestId: activation.requestId, targetExecutionId, result: { data, typed: true } })
    else await communication.failTarget({ requestId: activation.requestId, targetExecutionId, error: { code: 'RP_TEAM_HANDOFF_TIMEOUT', message: 'late' } })
  } })
  const make = (rule, text = draft) => ({ to: rule.to, handoffId: rule.id, data: { draft: text, world_return: {} } })
  const request = (secondDraft = draft) => communication.requestMany({ from: writer.id, executionId: 'writer:1',
    draftReview: true, requests: [make(fact), make(presentation, secondDraft)] })
  const bodyFrom = $ref => communication.resolveApprovedBody({ writer: writer.id, bodyRef: { $ref, side: 'request', pointer: '/draft' } })
  assert.equal(parallelDraftReviewPeer(writer), presentation)
  await assert.rejects(request('另一份稿。'), { code: 'RP_TEAM_HANDOFF_BATCH_INVALID' })
  assert.equal(arrivals.length, 0)
  const first = await request()
  assert.deepEqual(first.review, { ref: 'check-draft#1', data: fail(left, { ...right, note: '暗屏不可知。\n没有可见来源。' }), incomplete: false })
  assert.throws(() => bodyFrom(first.review.ref), { code: 'RP_TEAM_HANDOFF_REF_INVALID' })
  const pair = readRequestRecords(traceRoot, run.conversationId, run.runId)
  assert.deepEqual(pair.map(row => row.result.data), verdicts)
  assert.equal(pair[0].draftReviewBatchId, pair[1].draftReviewBatchId)
  assert.deepEqual(pair[0].mergedDraftReview.verdict, first.review.data)
  assert.deepEqual(pair[0].writerPresentation, writerProof)
  assert.deepEqual(pair[1].writerPresentation, [])
  assert.ok(communication.allMessages().every(message => !Object.hasOwn(message, 'writerPresentation')))

  verdicts = [pass, undefined]
  const timeout = await request()
  assert.deepEqual(timeout.review, { ref: 'check-draft#2', data: fail(), incomplete: true })
  assert.throws(() => bodyFrom(timeout.review.ref), { code: 'RP_TEAM_HANDOFF_REF_INVALID' })
  verdicts = [undefined, fail(right)]
  const partial = await request()
  assert.deepEqual(partial.review, { ref: 'check-draft#3', data: fail(right), incomplete: true })
  assert.throws(() => bodyFrom(partial.review.ref), { code: 'RP_TEAM_HANDOFF_REF_INVALID' })

  verdicts = [pass, pass]
  const approved = await request()
  assert.deepEqual(approved.review, { ref: 'check-draft#4', data: pass, incomplete: false })
  assert.equal(bodyFrom(approved.review.ref).data, draft)
  assert.throws(() => bodyFrom(approved.results[1].ref), { code: 'RP_TEAM_HANDOFF_REF_INVALID' })
  const lone = await communication.request({ from: writer.id, executionId: 'writer:1', ...make(fact) })
  assert.throws(() => bodyFrom(lone.ref), { code: 'RP_TEAM_HANDOFF_REF_INVALID' })
  assert.deepEqual(mergeDraftReviewIssues(draft, [pass, fail({ ...right, quote: '改述。' })]),
    { verdict: fail(), incomplete: true })

  writer.communication.handoffs.pop()
  assert.equal(parallelDraftReviewPeer(writer), undefined)
  const legacy = await communication.request({ from: writer.id, executionId: 'writer:1', ...make(fact) })
  assert.equal(bodyFrom(legacy.ref).data, draft)
})

test('a sealed terminal response clears the timeout while native completion still controls delivery', async () => {
  const config = handoffConfig()
  config.agents[0].communication.handoffs[0].terminal = true
  const ready = deferred()
  const timer = {}
  const cleared = []
  const communication = createCommunication(config, {
    setTimer: () => timer,
    clearTimer: value => cleared.push(value),
    onRequest: async ({ requestId }) => {
      await communication.bindTargetExecution(requestId, 'exec')
      ready.resolve(requestId)
    }
  })
  const result = communication.request({ from: 'requester', to: 'target', handoffId: 'lookup', summary: 'Find', data: { query: 'item' } })
  const id = await ready.promise
  const answer = { summary: 'Done', data: { facts: ['found'] }, typed: true }
  assert.equal(communication.checkTargetResult({ requestId: id, agentId: 'target', result: answer }), true)
  communication.sealTargetResult(id)
  assert.deepEqual(cleared, [timer])
  assert.equal(communication.getRequest(id).status, 'running')
  assert.equal(await communication.completeTarget({ requestId: id, targetExecutionId: 'exec', result: answer }), true)
  assert.deepEqual(await result, { summary: 'Done', data: { facts: ['found'] } })
})
