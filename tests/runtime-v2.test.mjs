import assert from 'node:assert/strict'
import test from 'node:test'
import { assertSupportedJsonSchema, defineTool, validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { buildAgentContext } from '../src/host/context-policy.mjs'
import { childPolicy } from '../src/host/agent-context.mjs'
import { createCommunication } from '../src/host/communication.mjs'
import { createScheduler } from '../src/host/scheduler.mjs'
import { describeStateToolAccess } from '../src/host/state-store.mjs'
import { actualTokenUsage, createTrace, recordTrace, traceDetail, traceSummary } from '../src/host/trace.mjs'
import { makeSettingBranch, makeVariableBranch, projectConversationContext } from '../src/host/context-world-adapter.mjs'
import { registerTeamTools } from '../src/host/team-tools.mjs'

function agent(id, overrides = {}) {
  return {
    id,
    name: id,
    description: `${id} roleplay agent`,
    systemPrompt: '',
    modelRef: 'inherit',
    parameters: {},
    presetId: 'native:preset',
    capabilities: [],
    compaction: {},
    triggers: [{ type: 'always' }],
    context: { sources: [] },
    communication: { sendTo: ['*'], receiveFrom: ['*'], requestTo: ['*'], requestFrom: ['*'] },
    statePermissions: [],
    outputAuthority: { internal: true, draft: true, state: true, user: false },
    execution: { after: [], onFailure: 'continue', trustedTools: [] },
    ...overrides
  }
}

function config(agents, overrides = {}) {
  return {
    schemaVersion: 2,
    id: 'team-1',
    name: 'Test team',
    version: 1,
    metadata: {},
    agents,
    state: { definitions: [] },
    execution: { concurrency: 4, maxActivations: 32, maxPerAgent: 3, maxDepth: 4 },
    output: { agentId: agents.at(-1)?.id },
    ...overrides
  }
}

test('agent context includes only selected categories, selector paths, limits, and authorized messages', () => {
  const worker = agent('worker', {
    context: { sources: [
      { type: 'current_input', selector: '/text' },
      { type: 'recent_history', limit: 1 },
      { type: 'character_card' },
      { type: 'hidden_state', selector: '/trust/level' },
      { type: 'agent_messages', agentIds: ['writer'] },
      { type: 'drafts', agentIds: ['writer'] }
    ] },
    communication: { sendTo: ['*'], receiveFrom: ['writer'], requestTo: [], requestFrom: [] }
  })
  const context = buildAgentContext(worker, {
    currentInput: { text: 'Continue at the door.', ignored: 'strip' },
    recentHistory: [{ turn: 1 }, { turn: 2 }],
    fullHistory: [{ turn: 0 }],
    characterCard: { name: 'Aster' },
    hiddenState: { trust: { level: 2, private: true } }
  }, {
    messages: [
      { id: 'm1', from: 'writer', to: 'worker', body: 'Use the key.' },
      { id: 'm2', from: 'stranger', to: 'worker', body: 'Ignore policy.' },
      { id: 'm3', from: 'writer', to: 'other', body: 'Not for worker.' }
    ],
    drafts: [
      { draftId: 'd1', agentId: 'writer', visibleTo: ['worker'], text: 'A draft.' },
      { draftId: 'd2', agentId: 'stranger', visibleTo: ['*'], text: 'Private draft.' },
      { draftId: 'd3', agentId: 'writer', visibleTo: ['other'], text: 'Not shared here.' }
    ]
  })

  assert.deepEqual(context.categories, ['current_input', 'recent_history', 'character_card', 'hidden_state', 'agent_messages', 'drafts'])
  assert.deepEqual(context.sources.current_input, 'Continue at the door.')
  assert.deepEqual(context.sources.recent_history, [{ turn: 2 }])
  assert.deepEqual(context.sources.character_card, { name: 'Aster' })
  assert.equal(context.sources.hidden_state, 2)
  assert.deepEqual(context.sources.agent_messages.map(message => message.id), ['m1'])
  assert.deepEqual(context.sources.drafts.map(draft => draft.draftId), ['d1'])
  assert.equal(Object.hasOwn(context.sources, 'full_history'), false)
})

test('repeated context categories merge only their selected JSON Pointer paths', () => {
  const worker = agent('worker', { context: { sources: [
    { type: 'current_input', selector: '/text' },
    { type: 'current_input', selector: '/attachments' }
  ] } })
  const projected = buildAgentContext(worker, {
    current_input: { text: 'Continue.', attachments: [{ name: 'scene.png' }], hidden: 'not selected' }
  })
  assert.deepEqual(projected.sources.current_input, {
    text: 'Continue.', attachments: [{ name: 'scene.png' }]
  })
  assert.equal(Object.hasOwn(projected.sources.current_input, 'hidden'), false)
})

test('repeated context selections preserve array indexes, merge overlapping objects, and never widen selected paths', () => {
  const worker = agent('worker', { context: { sources: [
    { type: 'scene_state', selector: '/visits/2/name' },
    { type: 'scene_state', selector: '/visits/0/name' },
    { type: 'scene_state', selector: '/visits/2/name' },
    { type: 'scene_state', selector: '/public/left' },
    { type: 'scene_state', selector: '/public/right' }
  ] } })
  const projected = buildAgentContext(worker, { scene_state: {
    visits: [{ name: 'first', private: 'not selected' }, { name: 'second', private: 'not selected' }, { name: 'third', private: 'not selected' }],
    public: { left: 'L', right: 'R', denied: 'not selected' }
  } }).sources.scene_state

  assert.deepEqual(projected.public, { left: 'L', right: 'R' })
  assert.equal(projected.visits.length, 3)
  assert.deepEqual(projected.visits[0], { name: 'first' })
  assert.equal(Object.hasOwn(projected.visits, 1), false, 'unselected array positions remain holes')
  assert.deepEqual(projected.visits[2], { name: 'third' })
  assert.equal(JSON.stringify(projected).includes('private'), false)
  assert.equal(Object.hasOwn(projected.public, 'denied'), false)
})

test('a missing sibling selection does not collapse the surviving path to the legacy scalar shape', () => {
  const worker = agent('worker', { context: { sources: [
    { type: 'character_card', selector: '/persona/name' },
    { type: 'character_card', selector: '/persona/missing' }
  ] } })
  const projected = buildAgentContext(worker, {
    character_card: { persona: { name: 'Aster', privateNote: 'not selected' } }
  })
  assert.deepEqual(projected.sources.character_card, { persona: { name: 'Aster' } })
  assert.deepEqual(projectConversationContext({}, projected).persona, { name: 'Aster' })
})

test('repeated message selections union authorized rows once and retain mailbox order', () => {
  const worker = agent('worker', {
    context: { sources: [
      { type: 'agent_messages', agentIds: ['first'] },
      { type: 'agent_messages', agentIds: ['second'] },
      { type: 'agent_messages', agentIds: ['first'] }
    ] },
    communication: { sendTo: [], receiveFrom: ['first', 'second'], requestTo: [], requestFrom: [] }
  })
  const messages = [
    { id: 'm1', type: 'message', from: 'first', to: 'worker', body: 'one' },
    { id: 'm2', type: 'message', from: 'second', to: 'worker', body: 'two' }
  ]
  const projected = buildAgentContext(worker, {}, { messages }).sources.agent_messages
  assert.deepEqual(projected.map(message => message.id), ['m1', 'm2'])
})

test('limited history and overlapping original-index selectors retain both source positions', () => {
  const worker = agent('worker', { context: { sources: [
    { type: 'recent_history', limit: 1 },
    { type: 'recent_history', selector: '/0' }
  ] } })
  const history = [
    { role: 'user', content: 'first' },
    { role: 'assistant', content: 'last' }
  ]
  const projected = buildAgentContext(worker, { recent_history: history }).sources.recent_history
  assert.deepEqual(projected, history)

  const partialAndWhole = agent('worker', { context: { sources: [
    { type: 'recent_history', selector: '/0/role' },
    { type: 'recent_history', limit: 1 }
  ] } })
  const oneEntry = [{ role: 'user', content: 'A' }]
  assert.deepEqual(buildAgentContext(partialAndWhole, { recent_history: oneEntry }).sources.recent_history, oneEntry,
    'a partial and complete projection of one source index merge at that index instead of duplicating it')

  const messageReader = agent('reader', {
    context: { sources: [
      { type: 'agent_messages', agentIds: ['first'] },
      { type: 'agent_messages', agentIds: ['second'] }
    ] },
    communication: { sendTo: [], receiveFrom: ['first', 'second'], requestTo: [], requestFrom: [] }
  })
  const messages = [
    { id: 'hidden-0', from: 'outsider', to: 'reader', body: 'private' },
    { id: 'm1', from: 'first', to: 'reader', body: 'one' },
    { id: 'hidden-2', from: 'outsider', to: 'reader', body: 'private' },
    { id: 'm2', from: 'second', to: 'reader', body: 'two' }
  ]
  const projectedMessages = buildAgentContext(messageReader, {}, { messages }).sources.agent_messages
  assert.equal(projectedMessages.length, 4)
  assert.equal(Object.hasOwn(projectedMessages, 0), false)
  assert.equal(projectedMessages[1].id, 'm1')
  assert.equal(Object.hasOwn(projectedMessages, 2), false)
  assert.equal(projectedMessages[3].id, 'm2')
})

test('multiple limited strings merge the longest prefix without losing authorized text', () => {
  const worker = agent('worker', { context: { sources: [
    { type: 'long_memory', limit: 10 },
    { type: 'long_memory', limit: 2 }
  ] } })
  assert.equal(buildAgentContext(worker, { long_memory: 'abcdefghijk' }).sources.long_memory, 'abcdefghij')
})

test('draft context keeps private owner drafts visible and filters peers by sharing and source ACL', () => {
  const owner = agent('owner', { context: { sources: [{ type: 'drafts', agentIds: [] }] } })
  const reader = agent('reader', {
    context: { sources: [{ type: 'drafts', agentIds: ['owner'] }] },
    communication: { sendTo: [], receiveFrom: ['owner'], requestTo: [], requestFrom: [] }
  })
  const drafts = [
    { draftId: 'private', agentId: 'owner', visibleTo: [], text: 'owner only' },
    { draftId: 'legacy-private', agentId: 'owner', text: 'legacy owner only' },
    { draftId: 'unshared', agentId: 'other', visibleTo: [], text: 'not shared' },
    { draftId: 'shared', agentId: 'owner', visibleTo: ['reader'], text: 'shared with owner' }
  ]
  assert.deepEqual(buildAgentContext(owner, {}, { drafts }).sources.drafts.map(draft => draft.draftId), ['private', 'legacy-private', 'shared'])
  assert.deepEqual(buildAgentContext(reader, {}, { drafts }).sources.drafts.map(draft => draft.draftId), ['shared'])
  const blockedPeerSource = agent('reader', {
    context: { sources: [{ type: 'drafts', agentIds: [] }] },
    communication: { sendTo: [], receiveFrom: ['owner'], requestTo: [], requestFrom: [] }
  })
  assert.deepEqual(buildAgentContext(blockedPeerSource, {}, { drafts }).sources.drafts, [])
})

test('history projection preserves attachments only from selected history entries', () => {
  const owner = agent('actor', {
    context: { sources: [{ type: 'recent_history', selector: '/0' }] }
  })
  const fullHistory = [{ role: 'user', content: 'See these files', attachments: [
    { type: 'file', attachment: { id: 'authorized-file' } },
    { type: 'file', attachment: { id: 'unselected-file' } }
  ] }, { role: 'assistant', content: 'Old answer', attachments: [
    { type: 'file', attachment: { id: 'hidden-history-file' } }
  ] }]
  const context = buildAgentContext(owner, { recent_history: fullHistory })
  const projected = projectConversationContext({}, context)
  assert.deepEqual(projected.history, [{ role: 'user', content: 'See these files', attachments: [
    { type: 'file', attachment: { id: 'authorized-file' } },
    { type: 'file', attachment: { id: 'unselected-file' } }
  ] }])
  assert.equal(JSON.stringify(projected.history).includes('hidden-history-file'), false)
})

test('native tool bridge branches replace root history, frozen library, variable state, and cached resolutions', () => {
  const permittedLibrary = { groups: [], entries: [
    { id: 'visible', title: 'Visible', content: 'AUTHORIZED SETTING CANARY' },
    { id: 'hidden', title: 'Hidden', content: 'ROOT SETTING CANARY' }
  ] }
  const settingBridge = {
    enabled: true,
    library: permittedLibrary,
    frozenLibrary: { groups: [], entries: [{ id: 'hidden', title: 'Hidden', content: 'ROOT FROZEN CANARY' }] },
    history: [{ role: 'user', content: 'ROOT HISTORY CANARY' }],
    variableState: { privateValue: 'ROOT VARIABLE CANARY' },
    runtimeResolution: { version: 1, renderedContents: { hidden: 'ROOT RESOLUTION CANARY' } }
  }
  const selectedHistory = [{ role: 'user', content: 'AUTHORIZED HISTORY CANARY' }]
  const settingBranch = makeSettingBranch(
    agent('reader'), { Visible: 'STAGED SETTING CANARY' }, settingBridge, () => true,
    selectedHistory, { progress: 'AUTHORIZED VARIABLE CANARY' }, ['/Visible']
  )
  const variableBranch = makeVariableBranch(agent('reader'), { progress: 1 }, {
    enabled: true, config: { initialState: {}, schemaCode: '' }, history: settingBridge.history,
    state: { privateValue: 'ROOT VARIABLE CANARY' }, runtimeResolution: { version: 1 }
  }, () => true, selectedHistory, [''])
  const branches = JSON.stringify({ settingBranch, variableBranch })

  for (const canary of ['ROOT HISTORY CANARY', 'ROOT SETTING CANARY', 'ROOT FROZEN CANARY', 'ROOT VARIABLE CANARY', 'ROOT RESOLUTION CANARY']) {
    assert.equal(branches.includes(canary), false, `${canary} is removed from the child tool bridge`)
  }
  assert.match(branches, /AUTHORIZED HISTORY CANARY/u)
  assert.match(branches, /STAGED SETTING CANARY/u)
  assert.match(branches, /AUTHORIZED VARIABLE CANARY/u)
  assert.deepEqual(settingBranch.frozenLibrary, settingBranch.library)
  assert.equal(settingBranch.library.entries[0].content, 'STAGED SETTING CANARY')
  assert.equal(settingBranch.frozenLibrary.entries[0].content, 'STAGED SETTING CANARY')
  assert.equal(Object.hasOwn(settingBranch, 'runtimeResolution'), false)
  assert.deepEqual(variableBranch.state, { progress: 1 })
  assert.equal(settingBranch.writeEnabled, true)
  assert.deepEqual(settingBranch.writePaths, ['/Visible'])
  assert.equal(variableBranch.writeEnabled, true)
  assert.deepEqual(variableBranch.writePaths, [''])
})

test('agents without internal-output authority can read authorized incoming messages but cannot send', async () => {
  const reader = agent('reader', {
    outputAuthority: { internal: false, draft: false, state: true, user: false },
    context: { sources: [{ type: 'agent_messages', agentIds: ['writer'], selector: '/0/body', limit: 5 }] },
    communication: { sendTo: [], receiveFrom: ['writer'], requestTo: [], requestFrom: [] }
  })
  const calls = new Map()
  const messages = [
    { id: 'm1', from: 'writer', to: 'reader', type: 'message', body: 'Authorized note.' },
    { id: 'm2', from: 'other', to: 'reader', type: 'message', body: 'Filtered sender.' }
  ]
  registerTeamTools({
    agentCtx: { tools: { register: tool => { calls.set(tool.name, tool); return () => {} } } },
    defineTool,
    member: reader,
    run: { outputAgentId: 'publisher', communication: { messagesFor: (id, from) => id === 'reader'
      ? messages.filter(message => (!from || from.includes(message.from)) && reader.communication.receiveFrom.includes(message.from)) : [],
      send: () => { throw new Error('mailbox should reject send') } } },
    stateStore: {},
    assertActiveCaller: () => {},
    assertInternalAuthority: () => { throw Object.assign(new Error('No internal-output authority'), { code: 'RP_TEAM_OUTPUT_FORBIDDEN' }) },
    requestDepth: () => 0,
    record: () => {}, persistRun: () => {}, saveDraft: () => {}, submitInternal: () => {}, publish: () => {}
  })

  const exec = { agent: { session: { id: 'session-reader' } } }
  const messageResult = await calls.get('rp_team_read_messages').execute({}, exec)
  assert.equal(messageResult.messages, 'Autho', 'message reads apply source, selector, and limit policy')
  assert.deepEqual(calls.get('rp_team_read_messages').output.schema, {
    type: 'object', additionalProperties: true
  }, 'message tool declares the projected data inside an object accepted by native DSH')
  assertSupportedJsonSchema(calls.get('rp_team_read_messages').output.schema)
  for (const value of [messageResult, { messages: [{ from: 'writer', body: 'a note' }] }, { messages: { from: 'writer' } }]) {
    assert.deepEqual(validateJsonSchemaValue(calls.get('rp_team_read_messages').output.schema, value), [])
  }
  await assert.rejects(calls.get('rp_team_send').execute({ to: 'writer', body: 'Cannot send.' }, exec), { code: 'RP_TEAM_OUTPUT_FORBIDDEN' })
})

test('mailbox applies send, receive, request, and requested-trigger ACLs without native wake calls', async () => {
  const writer = agent('writer', { communication: { sendTo: ['reviewer'], receiveFrom: [], requestTo: ['reviewer'], requestFrom: [] } })
  const reviewer = agent('reviewer', {
    triggers: [{ type: 'requested_by_agent', from: ['writer'] }],
    communication: { sendTo: [], receiveFrom: ['writer'], requestTo: [], requestFrom: ['writer'] }
  })
  const traces = []
  const activations = []
  const mailbox = createCommunication(config([writer, reviewer]), {
    onTrace: event => traces.push(event),
    onRequest: async activation => { activations.push(activation); return { queued: true, agentId: activation.to } }
  })

  const sent = await mailbox.send({ from: 'writer', to: 'reviewer', body: 'Check the name in the note.' })
  const requested = await mailbox.request({ from: 'writer', to: 'reviewer', body: 'Please verify the clue.', depth: 1 })
  assert.deepEqual(sent.recipients, ['reviewer'])
  assert.deepEqual(mailbox.messagesFor('reviewer').map(message => message.type), ['message', 'request'])
  assert.equal(mailbox.messagesFor('writer').length, 0)
  assert.equal(requested.activation.queued, true)
  assert.equal(activations[0].depth, 2)
  assert.equal(traces.length, 2)
  assert.deepEqual(mailbox.targetsFor('writer'), { sendTo: ['reviewer'], requestTo: ['reviewer'] })
  await assert.rejects(mailbox.send({ from: 'reviewer', to: 'writer', body: 'Not authorized.' }), { code: 'RP_TEAM_MESSAGE_NOT_ALLOWED' })
  await assert.rejects(mailbox.request({ from: 'reviewer', to: 'writer', body: 'Not authorized.' }), { code: 'RP_TEAM_REQUEST_NOT_ALLOWED' })
  await assert.rejects(mailbox.request({ from: 'reviewer', to: 'reviewer', body: 'Wrong sender fixture.' }), { code: 'RP_TEAM_REQUEST_NOT_ALLOWED' })
})

test('child tool guidance mirrors communication and state ACLs without exposing denied paths or values', () => {
  const self = agent('self', {
    systemPrompt: 'PRIVATE OWN PROMPT',
    triggers: [{ type: 'always' }, { type: 'requested_by_agent', from: ['self', 'peer'] }],
    communication: { sendTo: ['peer'], receiveFrom: [], requestTo: ['self', 'peer'], requestFrom: ['self', 'peer'] },
    statePermissions: [
      { namespace: 'shared', path: '', access: 'readwrite' },
      { namespace: 'shared', path: '/settings', access: 'readwrite' },
      { namespace: 'shared', path: '/settings/private', access: 'none' }
    ]
  })
  const peer = agent('peer', {
    triggers: [{ type: 'requested_by_agent', from: ['self'] }],
    communication: { sendTo: [], receiveFrom: ['self'], requestTo: [], requestFrom: ['self'] },
    systemPrompt: 'PRIVATE PEER PROMPT'
  })
  const mailbox = createCommunication(config([self, peer]))
  const stateDefinitions = [
    { namespace: 'shared', path: '', type: 'object' },
    { namespace: 'shared', path: '/settings', type: 'object' },
    { namespace: 'shared', path: '/settings/public', type: 'string' },
    { namespace: 'shared', path: '/settings/private', type: 'string' }
  ]
  const access = describeStateToolAccess(self, stateDefinitions)
  assert.equal(access.find(item => item.namespace === 'shared' && item.path === '').write, false,
    'namespace replacement is never advertised as a permitted write')
  assert.equal(access.find(item => item.namespace === 'shared' && item.path === '').version, true)
  assert.equal(access.find(item => item.path === '/settings').write, false,
    'parent replacement is blocked when it would overwrite a denied child')
  assert.equal(access.find(item => item.path === '/settings/public').write, true)
  assert.equal(access.some(item => item.path === '/settings/private'), false)

  const policy = childPolicy(self, { runId: 'run-1', outputAgentId: 'publisher', communication: mailbox }, 2, new Map([
    ['activation', { agentId: 'self', activationNo: 2, agentContext: { categories: ['drafts'], sources: { drafts: [] } }, stateToolAccess: access }]
  ]))
  assert.match(policy, /id self/u)
  assert.match(policy, /rp_team_send only to: peer/u)
  assert.match(policy, /rp_team_request only to: self, peer/u, 'self-request authority is included when both ACLs and a trigger allow it')
  assert.match(policy, /do not wait or poll for its result in this activation/u)
  assert.match(policy, /finish this activation so the scheduler can run/iu)
  assert.match(policy, /rp_team_save_draft\(\{ text: "\.\.\." \}\)/u)
  assert.match(policy, /drafts source: you can read your own drafts/u)
  assert.match(policy, /visibleTo: \["peer"\]/u)
  assert.match(policy, /"namespace":"shared","path":"\/settings\/public"/u)
  assert.doesNotMatch(policy, /settings\/private|PRIVATE PEER PROMPT|secret value/u)
  assert.match(policy, /Only configured output agent publisher may publish/u)
})

test('internal result submission rejects a missing summary before saving it', async () => {
  const tools = new Map()
  let submissions = 0
  const member = agent('worker')
  registerTeamTools({
    agentCtx: { tools: { register: tool => { tools.set(tool.name, tool); return () => {} } } },
    defineTool,
    member,
    run: { outputAgentId: 'publisher', communication: { messagesFor: () => [], send: async () => ({}), request: async () => ({}) } },
    stateStore: {},
    assertActiveCaller: () => {},
    assertInternalAuthority: () => {},
    requestDepth: () => 0,
    record: () => {}, persistRun: () => {}, saveDraft: () => {},
    submitInternal: () => { submissions += 1 }, publish: () => {}
  })
  const submit = tools.get('rp_team_submit_internal')
  const exec = { agent: { session: { id: 'worker-session' } } }
  await assert.rejects(submit.execute({}, exec), { code: 'INVALID_ARGS' },
    'the registered tool schema rejects a missing required summary')
  await assert.rejects(submit.execute({ summary: '   ' }, exec), { code: 'RP_TEAM_INVALID_REQUEST' },
    'the tool implementation also rejects an empty summary')
  assert.equal(submissions, 0)
})

test('an authorized activation request is visible to its target without ordinary message receive permission', async () => {
  const writer = agent('writer', { communication: { sendTo: [], receiveFrom: [], requestTo: ['target'], requestFrom: [] } })
  const target = agent('target', {
    triggers: [{ type: 'requested_by_agent', from: ['writer'] }],
    communication: { sendTo: [], receiveFrom: [], requestTo: [], requestFrom: ['writer'] }
  })
  const mailbox = createCommunication(config([writer, target]))
  await mailbox.request({ from: 'writer', to: 'target', body: 'Check this point.' })
  const context = buildAgentContext({
    ...target,
    context: { sources: [{ type: 'agent_messages', agentIds: ['writer'] }] }
  }, {}, { messages: mailbox.allMessages() })
  assert.equal(context.sources.agent_messages[0].type, 'request')
  assert.equal(context.sources.agent_messages[0].body, 'Check this point.')
})

test('scheduler runs generic always/manual/condition agents and only starts requested agents through the mailbox scheduler', async () => {
  const agents = [
    agent('starter'),
    agent('manual', { triggers: [{ type: 'manual' }] }),
    agent('unselected', { triggers: [{ type: 'manual' }] }),
    agent('conditional', { triggers: [{ type: 'condition', condition: { op: 'exists', namespace: 'shared', path: '/canRun' } }] }),
    agent('requested', { triggers: [{ type: 'requested_by_agent' }] })
  ]
  let scheduler
  const starts = []
  scheduler = createScheduler({
    config: config(agents),
    manualAgentIds: ['manual'],
    readState: async agentId => ({ canRun: agentId === 'conditional' }),
    evaluateCondition: (state, condition) => condition.op === 'exists' && state.canRun,
    onActivate: async ({ agent: current }) => {
      starts.push(current.id)
      if (current.id === 'starter') scheduler.requestActivation({ from: 'starter', to: 'requested', reason: 'verify a detail' })
    }
  })

  const status = await scheduler.run()
  assert.deepEqual(new Set(starts), new Set(['starter', 'manual', 'conditional', 'requested']))
  assert.equal(starts.includes('unselected'), false)
  assert.equal(status.agents.requested.status, 'complete')
  assert.equal(status.agents.unselected.status, 'skipped')
})

test('scheduler respects after dependencies, caps concurrency, and serializes revisions for one agent', async () => {
  const agents = [
    agent('alpha', { triggers: [{ type: 'always' }, { type: 'requested_by_agent' }] }),
    agent('beta'),
    agent('after-alpha', { execution: { after: ['alpha'], onFailure: 'continue', trustedTools: [] } })
  ]
  let scheduler
  let active = 0
  let maxActive = 0
  const perAgentActive = new Map()
  const starts = []
  let alphaRuns = 0
  scheduler = createScheduler({
    config: config(agents, { execution: { concurrency: 2, maxActivations: 32, maxPerAgent: 3, maxDepth: 4 } }),
    onActivate: async ({ agent: current }) => {
      active += 1
      maxActive = Math.max(maxActive, active)
      perAgentActive.set(current.id, (perAgentActive.get(current.id) ?? 0) + 1)
      assert.equal(perAgentActive.get(current.id), 1, `${current.id} overlapped its own activation`)
      const runNumber = current.id === 'alpha' ? ++alphaRuns : 1
      starts.push(`start:${current.id}:${runNumber}`)
      if (current.id === 'alpha' && runNumber === 1) scheduler.requestActivation({ from: 'alpha', to: 'alpha', reason: 'revise' })
      await new Promise(resolve => setTimeout(resolve, 5))
      starts.push(`end:${current.id}:${runNumber}`)
      active -= 1
      perAgentActive.set(current.id, 0)
    }
  })

  const status = await scheduler.run()
  assert.equal(maxActive, 2)
  assert.equal(alphaRuns, 2)
  assert.equal(status.agents.alpha.activations, 2)
  assert.ok(starts.indexOf('end:alpha:1') < starts.indexOf('start:after-alpha:1'))
  assert.ok(starts.indexOf('end:alpha:1') < starts.indexOf('start:alpha:2'))
})

test('optional memory settles before perception when requested, but skipped or failed memory does not block it', async () => {
  for (const concurrency of [1, 4]) {
    for (const scenario of ['requested', 'skipped', 'failed']) {
      const starts = []
      let scheduler
      const agents = [
        agent('observer'),
        agent('memory', { triggers: [{ type: 'requested_by_agent', from: ['observer'] }] }),
        agent('perception', { execution: { after: ['observer', 'memory'], onFailure: 'continue', trustedTools: [] } })
      ]
      scheduler = createScheduler({
        config: config(agents, { execution: { concurrency, maxActivations: 16, maxPerAgent: 3, maxDepth: 4 } }),
        onActivate: async ({ agent: current }) => {
          starts.push(`start:${current.id}`)
          if (current.id === 'observer') {
            if (scenario !== 'skipped') scheduler.requestActivation({ from: 'observer', to: 'memory', reason: 'optional memory lookup' })
            starts.push('finish:observer')
          } else if (current.id === 'memory') {
            starts.push(scenario === 'failed' ? 'finish:memory-failed' : 'finish:memory-sent-to-perception')
            if (scenario === 'failed') throw new Error('memory lookup failed')
          }
        }
      })
      const status = await scheduler.run()
      assert.ok(starts.indexOf('finish:observer') < starts.indexOf('start:perception'), `${concurrency}/${scenario}: observer settles before perception`)
      if (scenario === 'requested') {
        assert.ok(starts.indexOf('finish:memory-sent-to-perception') < starts.indexOf('start:perception'), `${concurrency}: requested memory settles before perception`)
        assert.equal(status.agents.memory.status, 'complete')
      } else if (scenario === 'skipped') {
        assert.equal(status.agents.memory.status, 'skipped')
        assert.equal(starts.includes('start:memory'), false)
        assert.ok(starts.includes('start:perception'), `${concurrency}: skipped optional memory does not block perception`)
      } else {
        assert.ok(starts.indexOf('finish:memory-failed') < starts.indexOf('start:perception'), `${concurrency}: failed memory settles before perception`)
        assert.equal(status.agents.memory.status, 'failed')
      }
      assert.equal(status.agents.perception.status, 'complete')
    }
  }
})

test('an unselected manual prerequisite settles before its always-triggered successor is scheduled', async () => {
  const starts = []
  const status = await createScheduler({
    config: config([
      agent('manual-prerequisite', { triggers: [{ type: 'manual' }] }),
      agent('successor', { execution: { after: ['manual-prerequisite'], onFailure: 'continue', trustedTools: [] } })
    ]),
    onActivate: async ({ agent: current }) => { starts.push(current.id) }
  }).run()
  assert.deepEqual(starts, ['successor'])
  assert.equal(status.agents['manual-prerequisite'].status, 'skipped')
  assert.equal(status.agents.successor.status, 'complete')
})

test('scheduler applies the per-agent and depth limits and makes a failed output agent stop the run', async () => {
  const optional = agent('optional', { triggers: [{ type: 'always' }, { type: 'requested_by_agent' }] })
  const publisher = agent('publisher', { outputAuthority: { internal: true, draft: true, state: false, user: true } })
  let scheduler
  let optionalRuns = 0
  const schedulerWithCaps = createScheduler({
    config: config([optional], { output: { agentId: 'optional' } }),
    onActivate: async ({ agent: current }) => {
      optionalRuns += 1
      if (optionalRuns < 4) scheduler.requestActivation({ from: current.id, to: current.id })
    }
  })
  scheduler = schedulerWithCaps
  const bounded = await scheduler.run()
  assert.equal(optionalRuns, 3)
  assert.equal(bounded.agents.optional.activations, 3)
  assert.throws(() => scheduler.requestActivation({ from: 'optional', to: 'optional', depth: 5 }), { code: 'RP_TEAM_ACTIVATION_DEPTH' })

  const stopped = createScheduler({
    config: config([agent('early'), publisher], { output: { agentId: 'publisher' } }),
    onActivate: async ({ agent: current }) => { if (current.id === 'publisher') throw new Error('publisher unavailable') }
  })
  const stoppedStatus = await stopped.run()
  assert.equal(stoppedStatus.stopped, true)
  assert.equal(stoppedStatus.agents.publisher.status, 'failed')
})

test('trace keeps ordered evidence and actual token counts without prompts, response bodies, or reasoning', () => {
  const trace = createTrace('run-1', '2026-10-03T00:00:00.000Z')
  recordTrace(trace, {
    type: 'activation.started',
    agentId: 'writer',
    data: {
      reason: { type: 'initial', triggers: ['always', 'manual'] }, depth: 0, activation: 1, parallel: 2,
      model: { provider: 'local', model: 'fixture' }, prompt: 'private prompt', reasoning: 'hidden chain'
    }
  })
  recordTrace(trace, {
    type: 'context.selected', agentId: 'writer', data: { categories: ['current_input', 'character_card'], fullHistory: ['private'] }
  })
  recordTrace(trace, {
    type: 'publication.staged', agentId: 'writer', data: { status: 'staged', body: 'Final user text', bodyCharacters: 16, operationCount: 1 }
  })

  assert.deepEqual(trace.events.map(event => event.seq), [1, 2, 3])
  assert.deepEqual(trace.events[0].data, {
    reason: { type: 'initial', triggers: ['always', 'manual'] }, depth: 0, activation: 1,
    parallel: 2, model: { provider: 'local', model: 'fixture' }
  })
  assert.deepEqual(trace.events[1].data.categories, ['current_input', 'character_card'])
  assert.equal(Object.hasOwn(trace.events[2].data, 'body'), false)
  assert.deepEqual(actualTokenUsage({ data: { usage: { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 } } }), {
    inputTokens: 120, outputTokens: 30, totalTokens: 150
  })
  assert.deepEqual(actualTokenUsage({ data: { estimatedTokens: 100 } }), undefined)
  assert.equal(traceDetail(trace).events.length, 3)
  const failedDeliverySummary = traceSummary(trace, {
    phase: 'awaiting_commit', assistantMessageId: 'real-assistant-event', assistantSeq: 17, productCommitStaged: true
  })
  assert.equal(failedDeliverySummary.assistantMessageId, 'real-assistant-event')
  assert.equal(failedDeliverySummary.assistantSeq, 17,
    'a durable but uncommitted assistant body can still locate its run trace')
  assert.equal(failedDeliverySummary.productCommitStaged, true)
})
