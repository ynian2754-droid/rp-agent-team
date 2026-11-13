import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createCommunication } from '../src/host/communication.mjs'
import { interruptPersistedRequests, readRequestRecords } from '../src/host/request-persistence.mjs'
import { createScheduler } from '../src/host/scheduler.mjs'
import { defaultTeamConfig, exportPreset, normalizeTeamConfig } from '../src/shared/schema.mjs'

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
    assert.deepEqual(result, { summary: 'Found the clue.', data: { facts: ['blue door'] } })
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
  const reused = communication.allMessages().find(message => message.type === 'handoff_result')
  assert.deepEqual({ summary: reused.summary, data: reused.data }, source.result)
  assert.equal(communication.pendingRequests().length, 0)
  assert.equal(row.reusedFromRunId, 'old-run')
  assert.equal(row.targetExecutionId, 'old-run:target:1')
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
})
