import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createTriggerTracker, committedTriggerCooldowns, latestCommittedStateCheckpoint, stateChangesFromCheckpoint
} from '../src/host/event-triggers.mjs'
import {
  assertBudgetedRunDispatchable, createRunBudget, isBudgetedTeamRequest,
  ORIGINAL_LLM_REQUEST, requestOrigin
} from '../src/host/run-budget.mjs'
import { buildAgentContext } from '../src/host/context-policy.mjs'
import { createScheduler } from '../src/host/scheduler.mjs'
import { createCommunication } from '../src/host/communication.mjs'
import { createRun, serializeRun, hydrateRun } from '../src/host/run-state.mjs'
import { defaultTeamConfig } from '../src/shared/schema.mjs'

function agent(id, triggers, overrides = {}) {
  return {
    id,
    triggers,
    context: { sources: [{ type: 'current_input' }] },
    communication: { sendTo: ['*'], receiveFrom: ['*'], requestTo: ['*'], requestFrom: ['*'] },
    execution: { after: [], onFailure: 'continue' },
    ...overrides
  }
}

function config(agents, overrides = {}) {
  return {
    id: 'preset-one', agents, output: { agentId: agents.at(-1)?.id },
    execution: { concurrency: 2, maxActivations: 16, maxPerAgent: 4, maxDepth: 4 },
    ...overrides
  }
}

test('trigger identities are preset-scoped and legacy identities survive unrelated edits', () => {
  const keyword = { type: 'keyword', keywords: ['go'] }
  const source = config([agent('actor', [keyword])])
  const same = config([agent('actor', [keyword], { systemPrompt: 'edited prompt' })])
  const first = createTriggerTracker({ config: source, configRevision: 'revision-a', currentInput: 'go' }).matchInput()[0]
  const edited = createTriggerTracker({ config: same, configRevision: 'revision-b', currentInput: 'go' }).matchInput()[0]
  const otherPreset = createTriggerTracker({ config: { ...source, id: 'preset-two' }, currentInput: 'go' }).matchInput()[0]
  assert.equal(first.triggerId, edited.triggerId)
  assert.notEqual(first.triggerId, otherPreset.triggerId)

  const explicit = { type: 'keyword', id: 'wake', keywords: ['go'] }
  const explicitA = createTriggerTracker({ config: config([agent('actor', [explicit])]), currentInput: 'go' }).matchInput()[0]
  const explicitB = createTriggerTracker({ config: config([agent('actor', [explicit])]), currentInput: 'go' }).matchInput()[0]
  assert.equal(explicitA.triggerId, explicitB.triggerId)
  const explicitOtherPreset = createTriggerTracker({ config: { ...config([agent('actor', [explicit])]), id: 'preset-two' }, currentInput: 'go' }).matchInput()[0]
  assert.notEqual(explicitA.triggerId, explicitOtherPreset.triggerId)

  const reorderedA = createTriggerTracker({ config: config([agent('actor', [keyword, { type: 'always' }])]), currentInput: 'go' }).matchInput()[0]
  const reorderedB = createTriggerTracker({ config: config([agent('actor', [{ type: 'always' }, keyword])]), currentInput: 'go' }).matchInput()[0]
  assert.notEqual(reorderedA.triggerId, reorderedB.triggerId)
})

test('periodic requires a real ordinal while keyword runs independently; cooldown and retry rules apply per trigger', () => {
  const triggers = [
    { type: 'periodic', every: 2, offset: 1 },
    { type: 'keyword', keywords: ['launch'], cooldownTurns: 2 }
  ]
  const team = config([agent('actor', triggers)])
  const noOrdinal = createTriggerTracker({ config: team, currentInput: 'Launch' }).matchInput()
  assert.deepEqual(noOrdinal.map(item => item.triggerType), ['keyword'])

  const keywordId = noOrdinal[0].triggerId
  const cooling = createTriggerTracker({ config: team, currentInput: 'launch', userTurnOrdinal: 6,
    cooldownMarkers: [{ triggerId: keywordId, userTurnOrdinal: 5 }] }).matchInput()
  assert.deepEqual(cooling, [])
  const retried = createTriggerTracker({ config: team, currentInput: 'launch', userTurnOrdinal: 6,
    bypassCooldownAgentIds: ['actor'], cooldownMarkers: [{ triggerId: keywordId, userTurnOrdinal: 5 }] }).matchInput()
  assert.deepEqual(retried.map(item => item.triggerType), ['keyword'])

  const periodicAtOne = createTriggerTracker({ config: team, userTurnOrdinal: 1 }).matchInput()
  assert.deepEqual(periodicAtOne.map(item => item.triggerType), ['periodic'])
  const zeroCooldown = createTriggerTracker({
    config: config([agent('actor', [{ type: 'keyword', keywords: ['go'], cooldownTurns: 0 }])]),
    currentInput: 'go', userTurnOrdinal: 5,
    cooldownMarkers: [{ triggerId: createTriggerTracker({
      config: config([agent('actor', [{ type: 'keyword', keywords: ['go'], cooldownTurns: 0 }])]), currentInput: 'go'
    }).matchInput()[0].triggerId, userTurnOrdinal: 5 }]
  }).matchInput()
  assert.equal(zeroCooldown.length, 1)
})

test('keyword matching uses each member visible and limited current input projection', () => {
  const member = agent('actor', [{ type: 'keyword', keywords: ['HIDDEN'] }], {
    context: { sources: [{ type: 'current_input', selector: '/text', limit: 6 }] }
  })
  const team = config([member])
  const sources = { current_input: { text: 'public HIDDEN', attachments: [] } }
  const tracker = createTriggerTracker({ config: team, currentInput: 'public HIDDEN', currentInputForAgent: current =>
    buildAgentContext(current, sources).sources.current_input
  })
  assert.deepEqual(tracker.matchInput(), [])

  const visible = createTriggerTracker({ config: team, currentInput: 'public HIDDEN', currentInputForAgent: current =>
    buildAgentContext(current, { current_input: { text: 'HIDDEN tail', attachments: [] } }).sources.current_input
  })
  assert.equal(visible.matchInput().length, 1)
})

test('state and message triggers require known changes and ACL-visible matching messages', () => {
  const team = config([agent('actor', [
    { type: 'state_changed', id: 'state', namespace: 'shared', path: '/score' },
    { type: 'message_received', id: 'msg', from: ['writer'], messageTypes: ['message'], topic: 'plot' }
  ])])
  const stateTracker = () => createTriggerTracker({ config: team, userTurnOrdinal: 3 })
  const stateId = stateTracker().stateWatchTargets('shared', '/score/value')[0].triggerId
  assert.deepEqual(stateTracker().matchStateChanges([{ triggerId: stateId, namespace: 'shared', path: '/score',
    before: { known: true, present: true, value: 1 }, after: { known: true, present: true, value: 2 } }]).map(x => x.triggerType), ['state_changed'])
  assert.deepEqual(stateTracker().matchStateChanges([{ triggerId: stateId, namespace: 'shared', path: '/score',
    before: { known: false, present: false }, after: { known: true, present: true, value: 2 } }]), [])
  assert.deepEqual(stateTracker().matchStateChanges([{ triggerId: stateId, namespace: 'shared', path: '/score',
    before: { known: true, present: false }, after: { known: true, present: true, value: null } }]).map(x => x.triggerType), ['state_changed'])

  const message = { id: 'm1', sequence: 1, type: 'message', from: 'writer', to: 'actor', topic: 'plot' }
  const denied = createTriggerTracker({ config: team }).matchMessage(message, () => false)
  const allowed = createTriggerTracker({ config: team }).matchMessage(message, () => true)
  assert.deepEqual(denied, [])
  assert.deepEqual(allowed.map(x => x.triggerType), ['message_received'])
})

test('committed cooldown markers follow active branch inputs and ignore rewound or incomplete runs', () => {
  const rows = [
    { status: { phase: 'complete', inputMessageId: 'active' }, triggerCooldownMarkers: [{ triggerId: 't', userTurnOrdinal: 4 }] },
    { status: { phase: 'complete', inputMessageId: 'inactive' }, triggerCooldownMarkers: [{ triggerId: 'u', userTurnOrdinal: 5 }] },
    { status: { phase: 'working', inputMessageId: 'active' }, triggerCooldownMarkers: [{ triggerId: 'v', userTurnOrdinal: 6 }] },
    { status: { phase: 'complete', inputMessageId: 'active' }, trace: { events: [{ type: 'publication.rewound' }] },
      triggerCooldownMarkers: [{ triggerId: 'w', userTurnOrdinal: 7 }] }
  ]
  assert.deepEqual(committedTriggerCooldowns(rows, ['active']).map(marker => marker.triggerId), ['t'])
})

test('author-edited state triggers on the next run; rollback and cold start have no guessed change', () => {
  const watch = agent('watcher', [{ type: 'state_changed', id: 'chapter', namespace: 'shared', path: '/chapter' }], {
    statePermissions: [{ namespace: 'shared', path: '/chapter', access: 'read' }]
  })
  const team = config([watch])
  team.state = { definitions: [{ namespace: 'shared', path: '/chapter', type: 'number' }] }
  const tracker = createTriggerTracker({ config: team })
  const targets = tracker.stateWatchTargets()
  const rows = [
    { status: { runId: 'committed-run', phase: 'complete', inputMessageId: 'active-input', inputEventSeq: 10 } },
    { status: { runId: 'rewound-run', phase: 'complete', inputMessageId: 'active-input', inputEventSeq: 20 },
      trace: { events: [{ type: 'publication.rewound' }] } }
  ]
  const transactions = {
    'committed-run': { status: 'committed', config: team },
    'rewound-run': { status: 'committed', config: team }
  }
  const selected = latestCommittedStateCheckpoint(rows, ['active-input'], transactions)
  assert.equal(selected.runId, 'committed-run')
  const checkpoint = { config: selected.transaction.config, state: { shared: { chapter: 1 } } }
  const matchCurrent = current => {
    const changes = stateChangesFromCheckpoint({ checkpoint, targets,
      currentValues: new Map([[targets[0].triggerId, { known: true, present: true, value: current }]]) })
    return createTriggerTracker({ config: team }).matchStateChanges(changes)
  }

  assert.deepEqual(matchCurrent(2).map(item => item.triggerType), ['state_changed'], 'an author edit is detected on the next run')
  assert.deepEqual(matchCurrent(1), [], 'a rollback to the committed checkpoint is not a new change')
  assert.deepEqual(stateChangesFromCheckpoint({ targets, checkpoint: undefined,
    currentValues: new Map([[targets[0].triggerId, { known: true, present: true, value: 2 }]]) }), [],
  'cold start without a committed checkpoint stays unknown')

  const undeclaredCheckpoint = { config: config([watch]), state: { shared: {} } }
  const unknown = stateChangesFromCheckpoint({ checkpoint: undeclaredCheckpoint, targets,
    currentValues: new Map([[targets[0].triggerId, { known: true, present: true, value: 2 }]]) })
  assert.deepEqual(createTriggerTracker({ config: team }).matchStateChanges(unknown), [],
    'missing historical paths are unknown when the old config did not declare them')
})

test('request activation merges its request and received-message trigger matches into one activation', async () => {
  const team = config([
    agent('source', [{ type: 'always' }]),
    agent('target', [
      { type: 'requested_by_agent', from: ['source'] },
      { type: 'message_received', messageTypes: ['request'], from: ['source'], topic: 'handoff' }
    ])
  ])
  const tracker = createTriggerTracker({ config: team })
  let scheduler
  let targetActivations = 0
  scheduler = createScheduler({
    config: team, triggerTracker: tracker, canReceiveMessage: (id, message) => message.to === id,
    onActivate: async ({ agent: current, activation }) => {
      if (current.id === 'source') scheduler.requestActivation({
        from: 'source', to: 'target', reason: 'test', message: { id: 'r1', sequence: 1, type: 'request', from: 'source', to: 'target', topic: 'handoff' }
      })
      if (current.id === 'target') {
        targetActivations += 1
        assert.deepEqual(activation.triggerMatches.map(match => match.triggerType).sort(), ['message_received', 'requested_by_agent'])
      }
    }
  })
  await scheduler.run()
  assert.equal(targetActivations, 1)
})

test('ordinary received-message scheduling checks ACL before enqueueing', async () => {
  const team = config([
    agent('source', [{ type: 'always' }]),
    agent('target', [{ type: 'message_received', from: ['source'] }])
  ])
  let scheduler
  let targetActivations = 0
  scheduler = createScheduler({
    config: team, triggerTracker: createTriggerTracker({ config: team }),
    canReceiveMessage: (id, message) => id === 'target' && message.to === id && message.allowed === true,
    onActivate: async ({ agent: current }) => {
      if (current.id === 'source') await scheduler.notifyMessage({ id: 'blocked', sequence: 1, type: 'message', from: 'source', to: 'target' })
      if (current.id === 'target') targetActivations += 1
    }
  })
  await scheduler.run()
  assert.equal(targetActivations, 0)

  let allowedScheduler
  allowedScheduler = createScheduler({
    config: team, triggerTracker: createTriggerTracker({ config: team }),
    canReceiveMessage: (id, message) => id === 'target' && message.to === id && message.allowed === true,
    onActivate: async ({ agent: current }) => {
      if (current.id === 'source') await allowedScheduler.notifyMessage({ id: 'allowed', sequence: 2, type: 'message', from: 'source', to: 'target', allowed: true })
      if (current.id === 'target') targetActivations += 1
    }
  })
  await allowedScheduler.run()
  assert.equal(targetActivations, 1)
})

test('startup state changes activate only known committed differences and merge with input triggers', async () => {
  const team = config([agent('actor', [
    { type: 'always' }, { type: 'state_changed', id: 'state', namespace: 'shared', path: '/chapter' }
  ])])
  const tracker = createTriggerTracker({ config: team })
  const target = tracker.stateWatchTargets()[0]
  let activations = 0
  let matches
  const changed = createScheduler({
    config: team, triggerTracker: tracker,
    initialStateChanges: [{ ...target, before: { known: true, present: true, value: 1 }, after: { known: true, present: true, value: 2 } }],
    onActivate: async ({ activation }) => { activations += 1; matches = activation.triggerMatches }
  })
  await changed.run()
  assert.equal(activations, 1)
  assert.deepEqual(matches.map(item => item.triggerType).sort(), ['always', 'state_changed'])

  for (const initialStateChanges of [
    [],
    [{ ...target, before: { known: false, present: false }, after: { known: true, present: true, value: 2 } }],
    [{ ...target, before: { known: true, present: true, value: 2 }, after: { known: true, present: true, value: 2 } }]
  ]) {
    const onlyState = config([agent('actor', [{ type: 'state_changed', id: 'state', namespace: 'shared', path: '/chapter' }])])
    const onlyTracker = createTriggerTracker({ config: onlyState })
    let count = 0
    await createScheduler({ config: onlyState, triggerTracker: onlyTracker, initialStateChanges,
      onActivate: async () => { count += 1 } }).run()
    assert.equal(count, 0)
  }
})

test('communication preserves a message topic through recipient context and trigger notification', async () => {
  const team = config([
    agent('source', [{ type: 'always' }]),
    agent('target', [{ type: 'message_received', topic: 'scene' }, { type: 'requested_by_agent', from: ['source'] }])
  ])
  let received
  let requested
  const communication = createCommunication(team, {
    onMessage: message => { received = message },
    onRequest: activation => { requested = activation; return { queued: true } }
  })
  await communication.send({ from: 'source', to: 'target', body: 'Advance the scene.', topic: 'scene' })
  assert.equal(received.topic, 'scene')
  assert.equal(communication.messagesFor('target')[0].topic, 'scene')
  await communication.request({ from: 'source', to: 'target', body: 'Handle the scene.', topic: 'scene' })
  assert.equal(requested.message.topic, 'scene')
  assert.equal(communication.messagesFor('target').at(-1).topic, 'scene')
})

test('resolved author parameters and cooldown markers survive a run DTO round trip', () => {
  const template = defaultTeamConfig()
  const run = createRun({ conversationId: 'c', rootSessionId: 'root', config: template,
    templateConfig: template, parameterValues: { style: 'brief' }, resolvedHash: 'resolved-hash', runId: 'run' })
  run.branchId = 'branch-a'
  run.userTurnOrdinal = 8
  run.triggerStarts = [{ triggerId: 'trigger', agentId: 'actor', userTurnOrdinal: 8 }]
  const restored = hydrateRun(JSON.parse(JSON.stringify(serializeRun(run))))
  assert.deepEqual(restored.parameterValues, { style: 'brief' })
  assert.equal(restored.resolvedHash, 'resolved-hash')
  assert.equal(restored.branchId, 'branch-a')
  assert.deepEqual(restored.triggerStarts, run.triggerStarts)
})

test('request budget allows the Nth dispatch, rejects N+1, and token cutoff includes exact threshold', () => {
  const requestBudget = createRunBudget({ runId: 'requests', limits: { maxRequests: 2 } })
  const first = requestBudget.reserve({ sessionId: 'child', purpose: 'agent' })
  const second = requestBudget.reserve({ sessionId: 'child', purpose: 'compaction' })
  assert.equal(first.allowed, true)
  assert.equal(second.allowed, true)
  assert.equal(requestBudget.reserve({ sessionId: 'child' }).allowed, false)
  assert.equal(requestBudget.snapshot().requestCount, 2)

  const tokenBudget = createRunBudget({ runId: 'tokens', limits: { maxReportedTokens: 10 } })
  const tokenRequest = tokenBudget.reserve({ sessionId: 'child', purpose: 'agent' })
  assert.equal(tokenBudget.reportUsage(tokenRequest.invocationId, { inputTokens: 4, outputTokens: 6 }), true)
  assert.equal(tokenBudget.reportUsage(tokenRequest.invocationId, { inputTokens: 4, outputTokens: 6 }), false)
  assert.equal(tokenBudget.snapshot().reportedTokens, 10)
  assert.equal(tokenBudget.failure.code, 'RP_TEAM_BUDGET_EXCEEDED')
  assert.equal(tokenBudget.failure.budget.kind, 'maxReportedTokens')
})

test('Host llm/stream reroutes share one reservation while a later same-session request remains distinct', () => {
  const budget = createRunBudget({ runId: 'reroutes', limits: { maxRequests: 2 } })
  const original = { sessionId: 'child', provider: 'fixture', model: 'one-request' }
  const rerouted = { ...original, [ORIGINAL_LLM_REQUEST]: original, messages: [] }
  const secondReroute = { ...rerouted, [ORIGINAL_LLM_REQUEST]: requestOrigin(rerouted), messages: [{ role: 'user' }] }
  const reservationsByOrigin = new WeakMap()
  const first = budget.reserve({ sessionId: original.sessionId })
  reservationsByOrigin.set(requestOrigin(original), first)

  assert.equal(requestOrigin(rerouted), original)
  assert.equal(requestOrigin(secondReroute), original)
  assert.equal(reservationsByOrigin.get(requestOrigin(secondReroute)), first)
  assert.equal(JSON.stringify(rerouted).includes('originalRequest'), false, 'the Host symbol stays out of JSON')

  const later = { ...original }
  assert.equal(requestOrigin(later), later)
  assert.notEqual(requestOrigin(later), original, 'same session/provider/model does not collapse a later invocation')
  assert.equal(budget.reserve({ sessionId: later.sessionId }).requestCount, 2)
})

test('token limits fail closed without actual usage and elapsed limits expire at the deadline', () => {
  const missing = createRunBudget({ runId: 'missing', limits: { maxReportedTokens: 50 } })
  const request = missing.reserve()
  assert.equal(missing.finish(request.invocationId).code, 'RP_TEAM_BUDGET_USAGE_UNAVAILABLE')
  assert.equal(missing.reserve().allowed, false)

  let now = 100
  const timed = createRunBudget({ runId: 'timed', limits: { maxElapsedMs: 25 }, startedAt: 100, now: () => now })
  now = 125
  assert.equal(timed.reserve().allowed, false)
  assert.equal(timed.failure.budget.kind, 'maxElapsedMs')
})

test('a failed or aborted budgeted owner rejects late nested dispatch before downstream work', () => {
  const budget = createRunBudget({ runId: 'late', limits: { maxRequests: 1 } })
  budget.reserve()
  budget.reserve()
  const run = { budget, phase: 'failed' }
  let dispatched = false
  assert.throws(() => {
    assertBudgetedRunDispatchable(run)
    dispatched = true
  }, error => error === budget.failure)
  assert.equal(dispatched, false)

  const workingBudget = createRunBudget({ runId: 'aborted', limits: { maxRequests: 1 } })
  assert.throws(() => assertBudgetedRunDispatchable({ budget: workingBudget, phase: 'working' }, { aborted: true }),
    error => error.code === 'RP_TEAM_RUN_NOT_ACTIVE')
  assert.doesNotThrow(() => assertBudgetedRunDispatchable({ phase: 'failed' }))
})

test('cancelled requests retain whether actual token usage was reported for task recovery', () => {
  const missing = createRunBudget({ runId: 'cancelled-missing', limits: { maxReportedTokens: 50 } })
  const pending = missing.reserve()
  assert.equal(missing.snapshot().reportedTokensKnown, false)
  assert.equal(missing.finish(pending.invocationId, { cancelled: true }), undefined)
  assert.equal(missing.snapshot().reportedTokensKnown, false)
  const known = createRunBudget({ runId: 'cancelled-known', limits: { maxReportedTokens: 50 } })
  const request = known.reserve()
  known.reportUsage(request.invocationId, { inputTokens: 2, outputTokens: 1 })
  known.finish(request.invocationId, { cancelled: true })
  assert.equal(known.snapshot().reportedTokensKnown, true)
  assert.equal(known.snapshot().reportedTokens, 3)
})

test('progressive provider usage adds only the reported increase for the same request', () => {
  const budget = createRunBudget({ runId: 'progressive', limits: { maxReportedTokens: 10 } })
  const request = budget.reserve()
  assert.equal(budget.reportUsage(request.invocationId, { totalTokens: 3 }), true)
  assert.equal(budget.reportUsage(request.invocationId, { totalTokens: 3 }), false)
  assert.equal(budget.reportUsage(request.invocationId, { totalTokens: 10 }), true)
  assert.equal(budget.snapshot().reportedTokens, 10)
  assert.equal(budget.failure.budget.kind, 'maxReportedTokens')
})

test('budget dispatch excludes local root delivery and title requests but counts compaction and member calls', () => {
  const run = { rootSessionId: 'root' }
  assert.equal(isBudgetedTeamRequest(run, { provider: 'rp-team-local', sessionId: 'root' }), false)
  assert.equal(isBudgetedTeamRequest(run, { provider: 'fixture', sessionId: 'root' }), false)
  assert.equal(isBudgetedTeamRequest(run, { provider: 'fixture', sessionId: 'root', purpose: 'compaction' }), true)
  assert.equal(isBudgetedTeamRequest(run, { provider: 'fixture', sessionId: 'child' }), true)
  assert.equal(isBudgetedTeamRequest(run, { provider: 'fixture', sessionId: 'child', purpose: 'session-title' }), false)
})
