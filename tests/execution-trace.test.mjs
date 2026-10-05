import assert from 'node:assert/strict'
import test from 'node:test'
import { registerExecutionSession, finishExecutionSession, traceAssociation, observeStatePath } from '../src/host/execution-trace.mjs'
import { createRun, bindAgentSession, unbindAgentSession, serializeRun, hydrateRun } from '../src/host/run-state.mjs'
import { defaultTeamConfig } from '../src/shared/schema.mjs'
import { createTrace, recordTrace } from '../src/host/trace.mjs'
import { traceSummary } from '../src/host/trace.mjs'
import { createScheduler } from '../src/host/scheduler.mjs'

test('parallel, revised and nested Session associations survive binding cleanup and cold restore', () => {
  const run = createRun({ conversationId: 'c', rootSessionId: 'root', runId: 'run', config: defaultTeamConfig() })
  for (const [agentId, activation, sessionId, parentSessionId, scheduled] of [
    ['agent-1', 1, 'one', 'root', true], ['agent-2', 1, 'two', 'root', true],
    ['agent-1', 1, 'nested', 'one', false], ['agent-1', 2, 'revision', 'root', true],
  ]) registerExecutionSession(run, { agentId, activation, sessionId, parentSessionId, scheduled, depth: scheduled ? 1 : 2 })
  assert.equal(registerExecutionSession(run, { agentId: 'agent-1', activation: 1, sessionId: 'one' }), run.executionSessions[0])
  bindAgentSession(run, 'agent-1', 'one', 1)
  finishExecutionSession(run, 'one', 'complete', 20)
  unbindAgentSession(run, 'one')
  run.turn = 5; run.inputEventSeq = 8
  const restored = hydrateRun(JSON.parse(JSON.stringify(serializeRun(run))))
  assert.deepEqual(restored.executionSessions, run.executionSessions)
  assert.equal(restored.executionSessions[2].parentSessionId, 'one')
  assert.equal(restored.executionSessions[3].executionId, 'run:agent-1:2')
  assert.equal(restored.turn, 5)
  assert.equal(restored.sessionBindings.size, 0)
})

test('legacy membership is retained without invented activation, turn or parent IDs', () => {
  const association = traceAssociation({ status: { runId: 'old' }, rootSessionId: 'root',
    members: { actor: { id: 'actor', sessions: ['child'] } } })
  assert.equal(association.turn, undefined)
  assert.equal(association.executionSessions[0].activation, null)
  assert.equal(association.executionSessions[0].associationIncomplete, true)
})

test('state evidence snapshots touched values and distinguishes missing from null', () => {
  const state = { shared: { 'a/b': { value: null } } }
  const store = { snapshot: () => state }
  assert.deepEqual(observeStatePath(store, {}, 'shared', '/a~1b/value'), { before: null })
  assert.deepEqual(observeStatePath(store, {}, 'shared', '/absent'), { beforeMissing: true })
  const trace = createTrace('run')
  recordTrace(trace, { type: 'state.operation', data: { namespace: 'shared', path: '/a~1b',
    ...observeStatePath(store, {}, 'shared', '/a~1b'), after: { value: 2 }, valuesRecorded: true } })
  state.shared['a/b'].value = 10
  assert.deepEqual(trace.events[0].data.before, { value: null })
  assert.deepEqual(trace.events[0].data.after, { value: 2 })
})

test('unselected and limit-blocked members emit explicit scheduling evidence', async () => {
  const config = defaultTeamConfig()
  config.agents[0].triggers = [{ type: 'manual' }]
  config.execution.maxDepth = 0
  const events = []
  const scheduler = createScheduler({ config, onActivate: async () => {}, onTrace: event => events.push(event) })
  await scheduler.run()
  assert.ok(events.some(event => event.type === 'activation.skipped' && event.agentId === 'agent-1' && event.data.reason === 'not_triggered'))
  assert.throws(() => scheduler.requestActivation({ from: 'agent-1', to: 'agent-2', depth: 1 }))
})

test('legacy publication preserves its exact native body event without guessing a request header', () => {
 const result = traceAssociation({rootSessionId:'root', assistantSeq:21,status:{runId:'old',turn:5},members:{}});
 assert.equal(result.localDeliveryAssistantSeq,21);assert.equal(result.localDeliveryRequestSeq,undefined);assert.equal(result.turn,5);
});

test('trace DTO preserves input and body message identities across regeneration with reused event sequences', () => {
  const rows = ['first-input', 'regenerated-input'].map(inputMessageId => ({
    rootSessionId: 'root', inputEventSeq: 53, inputMessageId, assistantMessageId: 'body', assistantSeq: 67,
    status: { runId: inputMessageId, turn: 4 }, members: {},
  }))
  const dtos = rows.map(row => traceAssociation(row))
  assert.deepEqual(dtos.map(dto => dto.inputEventSeq), [53, 53])
  assert.deepEqual(dtos.map(dto => dto.inputMessageId), ['first-input', 'regenerated-input'])
  assert.equal(dtos[1].assistantMessageId, 'body')
  assert.equal(traceSummary(createTrace('run'), { ...rows[1].status, ...dtos[1] }).inputMessageId, 'regenerated-input')
})
