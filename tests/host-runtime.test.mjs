import assert from 'node:assert/strict'
import test from 'node:test'
import { createCommunication } from '../src/host/communication.mjs'
import { createScheduler } from '../src/host/scheduler.mjs'
import { isOwnedSettledNotice, matchesRunInputMessage, sumTokenSamplesForSessions } from '../src/host/session-event-policy.mjs'
import {
  agentForSession,
  bindAgentSession,
  cancelRun,
  commitRun,
  completeRun,
  createRun,
  runStatus,
  setRunPhase,
  stagePublication,
  unbindAgentSession
} from '../src/host/run-state.mjs'
import { createAgent, defaultTeamConfig, normalizeTeamConfig } from '../src/shared/schema.mjs'

function makeRun(config = defaultTeamConfig()) {
  return createRun({
    conversationId: 'conversation-1', rootSessionId: 'root-session-1',
    config, contextPacket: { currentInput: 'The character asks what happened.' },
    baseState: { world: { variables: { trust: 2 }, settings: {} } },
    baseHash: 'base-1', runId: 'run-1'
  })
}

function requestTeam() {
  const base = defaultTeamConfig()
  const source = createAgent({
    ...base.agents[0],
    id: 'scribe', name: 'Scribe', triggers: [{ type: 'always' }],
    communication: { sendTo: ['actor', 'memory'], receiveFrom: [], requestTo: ['memory'], requestFrom: [] },
    execution: { after: [], onFailure: 'continue', trustedTools: [] }
  })
  const memory = createAgent({
    id: 'memory', name: 'Memory', systemPrompt: 'Return relevant saved context.',
    triggers: [{ type: 'requested_by_agent', from: ['scribe'] }],
    communication: { sendTo: ['actor'], receiveFrom: ['scribe'], requestTo: [], requestFrom: ['scribe'] },
    execution: { after: ['scribe'], onFailure: 'continue', trustedTools: [] }
  })
  const actor = createAgent({
    ...base.agents[1],
    id: 'actor', name: 'Actor', triggers: [{ type: 'always' }],
    context: { sources: [{ type: 'current_input' }, { type: 'recent_history' }, { type: 'agent_messages', agentIds: ['scribe', 'memory'] }] },
    communication: { sendTo: [], receiveFrom: ['scribe', 'memory'], requestTo: [], requestFrom: [] },
    execution: { after: ['scribe', 'memory'], onFailure: 'continue', trustedTools: [] },
    outputAuthority: { internal: true, draft: true, state: true, user: true }
  })
  return normalizeTeamConfig({
    ...base, id: 'request-flow', name: 'Request flow', agents: [source, memory, actor],
    output: { agentId: 'actor' }
  })
}

test('run state keeps stable agent identities, enforces one active native session, and stages one authorized publication', () => {
  const config = defaultTeamConfig()
  const run = makeRun(config)

  assert.equal(config.agents[1].context.sources.find(source => source.type === 'recent_history').limit, 12)
  assert.equal(config.agents[1].context.sources.find(source => source.type === 'full_history'), undefined)
  assert.notStrictEqual(run.config, config)
  assert.equal(Object.keys(run.members).join(','), 'agent-1,agent-2')
  bindAgentSession(run, 'agent-1', 'observer-session', 1)
  bindAgentSession(run, 'agent-2', 'actor-session', 1)
  assert.equal(agentForSession(run, 'observer-session').id, 'agent-1')
  assert.throws(() => bindAgentSession(run, 'agent-1', 'overlapping-session', 2), { code: 'RP_TEAM_AGENT_OVERLAP' })
  assert.throws(() => bindAgentSession(run, 'agent-2', 'observer-session', 2), { code: 'RP_TEAM_SESSION_ALREADY_BOUND' })

  setRunPhase(run, 'working')
  assert.throws(() => stagePublication(run, 'agent-1', { body: 'Unauthorized response.' }), { code: 'RP_TEAM_OUTPUT_FORBIDDEN' })
  const publication = stagePublication(run, 'agent-2', { body: 'The scene continues.', operationCount: 1 })
  assert.equal(publication.body, 'The scene continues.')
  assert.throws(() => stagePublication(run, 'agent-2', { body: 'Second response.' }), { code: 'RP_TEAM_ALREADY_PUBLISHED' })
  assert.equal(completeRun(run), 'awaiting_commit')
  assert.equal(commitRun(run, 'committed', 'formal-message-9'), 'complete')
  assert.equal(runStatus(run).productMessageId, 'formal-message-9')
  assert.equal(runStatus(run).productCommitStaged, false)
  assert.throws(() => stagePublication(run, 'agent-2', { body: 'Late response.' }), { code: 'RP_TEAM_ALREADY_PUBLISHED' })
  assert.equal(unbindAgentSession(run, 'observer-session').agentId, 'agent-1')
})

test('cancelled run stays terminal and cannot publish or claim a product commit', () => {
  const run = makeRun()
  bindAgentSession(run, 'agent-1', 'observer-session', 1)
  setRunPhase(run, 'working')
  cancelRun(run, 'user cancelled')

  assert.equal(run.phase, 'cancelled')
  assert.equal(runStatus(run).members['agent-1'].status, 'cancelled')
  assert.throws(() => stagePublication(run, 'agent-2', { body: 'Too late.' }), { code: 'RP_TEAM_INVALID_PHASE' })
  assert.throws(() => commitRun(run, 'committed', 'not-created'), { code: 'RP_TEAM_INVALID_PHASE' })
})

test('Session event policy captures the appended input, consumes only owned settlement notices, and totals every member Session once', () => {
  const run = { inputMessageId: 'input-1', requestId: 'rpc-1' }
  assert.equal(matchesRunInputMessage(run, { id: 'input-1', source: { kind: 'user' } }), true)
  assert.equal(matchesRunInputMessage(run, { id: 'other', source: { kind: 'user', rpcId: 'rpc-1' } }), true)
  assert.equal(matchesRunInputMessage(run, { id: 'other', source: { kind: 'user', rpcId: 'rpc-other' } }), false)

  const owned = { role: 'user', source: { kind: 'subagent-settled', senderSessionId: 'team-child-1' } }
  const foreign = { role: 'user', source: { kind: 'subagent-settled', senderSessionId: 'ordinary-child' } }
  const ownedSessions = new Set(['team-child-1'])
  assert.equal(isOwnedSettledNotice(owned, ownedSessions), true)
  assert.equal(isOwnedSettledNotice(foreign, ownedSessions), false)
  assert.equal([owned, foreign].every(message => isOwnedSettledNotice(message, ownedSessions)), false)

  const samples = {
    first: { sessionId: 'team-child-1', usage: { inputTokens: 10, outputTokens: 2 } },
    second: { sessionId: 'team-child-2', usage: { inputTokens: 5, outputTokens: 3 } },
    nested: { sessionId: 'nested-child', usage: { inputTokens: 4, outputTokens: 1 } },
    other: { sessionId: 'other-agent', usage: { inputTokens: 100, outputTokens: 100 } }
  }
  assert.deepEqual(sumTokenSamplesForSessions(samples, ['team-child-1', 'team-child-2', 'nested-child']), {
    inputTokens: 19, outputTokens: 6
  })
})

test('scheduler runs declared dependencies and a dynamically requested agent without fixed lead/member semantics', async () => {
  const config = requestTeam()
  let scheduler
  const communication = createCommunication(config, {
    onRequest: activation => scheduler.requestActivation(activation)
  })
  const observed = []
  scheduler = createScheduler({
    config,
    onActivate: async ({ agent, activation }) => {
      observed.push({ id: agent.id, reason: activation.reason?.type })
      if (agent.id === 'scribe') {
        await communication.send({ from: 'scribe', to: 'actor', body: 'The hallway smells of rain.' })
        await communication.request({ from: 'scribe', to: 'memory', body: 'Was the brass key mentioned before?' })
      } else if (agent.id === 'memory') {
        const request = communication.messagesFor('memory').find(message => message.type === 'request')
        assert.match(request.body, /brass key/u)
        await communication.send({ from: 'memory', to: 'actor', body: 'An earlier note mentions a brass key.' })
      } else if (agent.id === 'actor') {
        const messages = communication.messagesFor('actor')
        assert.deepEqual(messages.map(item => item.from), ['scribe', 'memory'])
        assert.match(messages[0].body, /rain/u)
        assert.match(messages[1].body, /brass key/u)
      }
    }
  })

  const status = await scheduler.run()
  assert.equal(status.agents.scribe.status, 'complete')
  assert.equal(status.agents.memory.status, 'complete')
  assert.equal(status.agents.actor.status, 'complete')
  assert.deepEqual(observed.map(item => item.id), ['scribe', 'memory', 'actor'])
  await assert.rejects(communication.send({ from: 'actor', to: 'scribe', body: 'Not allowed by sendTo.' }), { code: 'RP_TEAM_MESSAGE_NOT_ALLOWED' })
  await assert.rejects(communication.request({ from: 'memory', to: 'scribe', body: 'Not requestable.' }), { code: 'RP_TEAM_REQUEST_NOT_ALLOWED' })
})
