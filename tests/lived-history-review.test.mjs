import assert from 'node:assert/strict'
import test from 'node:test'
import { childPolicy, createChildContextData } from '../src/host/agent-context.mjs'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { enforceSimulationReview, prepareReviewData, projectDraftLaneMessage, scopedDraftLane, scopedDraftPremiseEvidence, scopedDraftSceneEvidence, scopedReviewEvidence, scopedReviewPrompt, simulationFindings, validateScopedReviewVerdict } from '../src/host/lived-history-review.mjs'
import { registerTeamTools } from '../src/host/team-tools.mjs'

const packet = {
  slot: 1, player: '用户', group: ['星凛'], now: '书房',
  stimulus: [{ event: 'present', content: '用户问她要不要留下。' }], relay: [],
  people: {
    星凛: {
      knows: [{ id: 'event-1', when: '周一', what: '她曾开口挽留' }],
      precedents: [{ id: 'event-2', when: '周日', what: '她在类似场景选择沉默' }],
      memories: [{ key: 'm1', event: 'event-1', storyTime: '周一' }, { key: 'm2', event: 'present' }],
      self: '不转交给核验的私密自述'
    }
  }
}
const beat = {
  who: '星凛', says: ['留下。'], does: '把碟子推过去。', withheld: '没有说为什么。',
  grounds: [{ ref: 'event-1' }, { ref: 'event-2' }], departs: '她这次开了口。', wrote: ['last']
}

test('simulation review groups retain observables and drop detailed evidence after mechanical validation', () => {
  const result = prepareReviewData('simulation', { packs: [packet], beats: [[beat]] })
  assert.deepEqual(result.precheck, [])
  assert.equal(result.packs[0].player, packet.player)
  assert.equal(result.packs[0].people, undefined)
  assert.equal(result.beats[0][0].grounds, undefined)
  assert.equal(result.beats[0][0].does, beat.does)
  assert.equal(result.beats[0][0].withheld, beat.withheld)
  assert.throws(() => prepareReviewData('simulation', { packs: [packet], beats: [] }), { code: 'RP_TEAM_HANDOFF_REQUEST_INVALID' })
})

test('precheck rejects copied evidence, hallucinated IDs and events of the current beat as past precedents', () => {
  const invalid = { ...beat, grounds: ['event-1', 'm1', 'm2', 'present', 'invented', '此刻场面'].map(ref => ({ ref })) }
  const findings = simulationFindings(packet, [invalid, { ...beat, who: packet.player }])
  assert.deepEqual(findings.map(issue => issue.kind), ['依据不在材料包', '背离缺依据', '替用户角色写'])
  const judgment = enforceSimulationReview({ pass: true, issues: [] }, findings)
  assert.deepEqual(judgment, { pass: false, issues: findings })
})

test('draft review retains exact manuscript and perceptible facts while omitting nested internal state', () => {
  const draft = '\n  留下。\r\n'
  const established = [{ event: 'event-3', content: beat.says[0] }]
  const attempts = [[{ slot: 1, people: packet.group, beats: [beat] }]]
  const result = prepareReviewData('draft', { draft, world_return: {
    established, attempts, surface: ['白瓷碟'], not_reveal: ['暗线'], internal: '不投影'
  } }, '你要我走还是留下？')
  assert.equal(result.draft, draft)
  assert.equal(result.current_input, '你要我走还是留下？')
  assert.deepEqual(result.world_return.established, established)
  assert.deepEqual(result.world_return.not_reveal, ['暗线'])
  assert.equal(result.world_return.internal, undefined)
  assert.equal(result.world_return.attempts[0].beats[0].grounds, undefined)
  assert.equal(result.world_return.attempts[0].beats[0].does, beat.does)
})

test('scoped checker only receives its active draft and authorized evidence for that draft', () => {
  const agent = {
    id: 'checker', name: '核验',
    systemPrompt: 'Shared rules. [[review:simulation]]Simulation rules.[[/review]] [[review:draft]]Prose rules.[[/review]]',
    outputAuthority: { internal: true },
    context: { sources: [{ type: 'agent_messages', agentIds: ['clerk', 'writer'] }, { type: 'current_input' }] },
    triggers: [{ type: 'requested_by_agent', from: ['clerk', 'writer'] }],
    statePermissions: [{ namespace: 'shared', path: '/canon/events', access: 'read' }]
  }
  const eventPath = { namespace: 'shared', path: '/canon/events' }
  const previous = { requestId: 'old', from: 'clerk', to: agent.id, type: 'request', data: { beats: ['Old simulation'] } }
  const draft = { requestId: 'active', from: 'writer', to: agent.id, type: 'request', data: {
    draft: '请留下。', world_return: { established: [{ event: 'used', content: '有人开口。' }, { event: 'archived' }] }
  } }
  const run = {
    runId: 'run', conversationId: 'conv', sources: { current_input: 'Only the authorized handoff is included.' },
    config: { memory: { collections: [{ id: 'events', ...eventPath }] }, state: { definitions: [eventPath] } },
    communication: {
      getRequest: () => ({ to: agent.id, scopedReview: true, compactReview: 'draft' }),
      allMessages: () => [previous, draft]
    }
  }
  let reads = 0
  const stateStore = {
    snapshot: () => ({}), versionsSnapshot: () => ({}),
    read: ({ agentId, path }) => {
      assert.equal(agentId, agent.id)
      assert.equal(path, eventPath.path)
      reads++
      return { value: [
        { id: 'used', storyTime: '今日', perceivers: [{ who: '星凛', how: '亲历', what: 'Unreviewed private details' }] },
        { id: 'archived', active: false, storyTime: '昨天' },
        { id: 'unrelated', storyTime: 'Never dispatched' }
      ] }
    }
  }
  const activate = () => createChildContextData({ run, agent, stateStore, activation: { requestId: 'active' } })
  const packet = activate()
  assert.equal(packet.scopedReview, 'draft')
  assert.deepEqual(packet.stateToolAccess, [])
  assert.deepEqual(packet.agentContext.sources, {
    agent_messages: [draft],
    review_evidence: [{ id: 'used', storyTime: '今日', perceivers: [{ who: '星凛', how: '亲历' }] }]
  })
  const prompt = childPolicy(agent, run, 1, new Map([['active', { ...packet, agentId: agent.id, activationNo: 1 }]]))
  assert.match(prompt, /Prose rules/)
  assert.doesNotMatch(prompt, /Simulation rules|rp_team_read_state|rp_team_read_context/)
  agent.statePermissions = []
  assert.deepEqual(activate().agentContext.sources, { agent_messages: [draft] })
  agent.statePermissions = [{ namespace: 'shared', path: '/canon/events', access: 'read' }]
  agent.context.sources = [{ type: 'agent_messages', agentIds: ['clerk'] }]
  assert.deepEqual(activate().agentContext.sources, { agent_messages: [] })
  assert.equal(reads, 1)
})

test('scoped draft issues must quote the exact text and cannot route a flagged draft to automatic publication', () => {
  const draft = '她说了出口。隔壁密谈一直无外人知晓。用户决定留下。'
  const request = { compactReview: 'draft', request: { data: { draft } } }
  const issues = [
    { kind: '暗线越过表面', quote: '隔壁密谈一直无外人知晓。' },
    { kind: '替用户角色写', quote: '用户决定留下。' }
  ]
  assert.doesNotThrow(() => validateScopedReviewVerdict(request, { pass: false, issues }))
  assert.throws(() => validateScopedReviewVerdict(request, { pass: true, issues }), { code: 'RP_TEAM_HANDOFF_RESPONSE_INVALID' })
  assert.throws(() => validateScopedReviewVerdict(request, { pass: false, issues: [] }), { code: 'RP_TEAM_HANDOFF_RESPONSE_INVALID' })
  assert.throws(() => validateScopedReviewVerdict(request, { pass: false, issues: [{ ...issues[0], quote: '另一个版本' }] }),
    { code: 'RP_TEAM_HANDOFF_RESPONSE_INVALID' })
  assert.doesNotThrow(() => validateScopedReviewVerdict(request, { pass: true, issues: [] }))
})

test('draft checker receives only the referenced world result’s file cues with original perceivers', () => {
  const agent = { id: 'checker', context: { sources: [{ type: 'agent_messages', agentIds: ['writer'] }] },
    execution: { livedHistoryDialoguePremises: true }, statePermissions: [],
    triggers: [{ type: 'requested_by_agent', from: ['writer'] }] }
  const draft = { requestId: 'active', from: 'writer', to: agent.id, type: 'request', data: { draft: '按钮灰着。' } }
  const request = { requestId: 'active', from: 'writer', to: agent.id, sourceExecutionId: 'writer:1',
    scopedReview: true, compactReview: 'draft', worldReviewRequestId: 'chosen-world' }
  const world = { requestId: 'chosen-world', handoffId: 'ask-world', status: 'completed', from: 'writer', to: 'world',
    sourceExecutionId: 'writer:1', targetExecutionId: 'world:2' }
  const file = (requestId, sourceExecutionId, sceneCues) => ({ requestId, sourceExecutionId, handoffId: 'ask-file',
    status: 'completed', from: 'world', request: { data: { sceneCues, stimulus: ['不可转交的档案'] } } })
  const cues = [{ content: '按钮灰着。', perceivers: ['O4'] }, { content: '尾巴绕到膝盖。', perceivers: ['O4', '星凛'] }]
  const current = file('current-file', 'world:2', cues.map(cue => ({ ...cue, note: '不可转交的附注' })))
  const other = file('other-file', 'world:3', [{ content: '不相关', perceivers: ['星凛'] }])
  const run = { config: { state: { definitions: [] } }, handoffRequests: [world, current, other],
    communication: { getRequest: () => request, allMessages: () => [draft] } }
  const stateStore = { snapshot: () => ({}), versionsSnapshot: () => ({}) }
  const activate = () => createChildContextData({ run, agent, stateStore, activation: { requestId: 'active' } }).agentContext
  assert.deepEqual(activate().sources, { agent_messages: [draft], review_scene_cues: cues })
  assert.ok(activate().categories.includes('review_scene_cues'))
  assert.deepEqual(scopedDraftSceneEvidence({ ...request, sourceExecutionId: 'writer:2' }, run), [])
  assert.deepEqual(scopedDraftSceneEvidence({ ...request, worldReviewRequestId: undefined }, run), [])
  assert.deepEqual(scopedDraftSceneEvidence({ ...request, compactReview: 'simulation' }, run), [])
  current.sourceExecutionId = 'world:1'
  assert.deepEqual(scopedDraftSceneEvidence(request, run), [])
  world.worldReviewFileRequestId = current.requestId
  assert.deepEqual(scopedDraftSceneEvidence(request, run), cues)
  agent.execution = {}
  assert.deepEqual(activate().sources, { agent_messages: [draft] })
  agent.execution = { livedHistoryDialoguePremises: true }
  agent.context.sources[0].agentIds = ['clerk']
  assert.deepEqual(activate().sources, { agent_messages: [] })
})

test('dialogue review can verify directly cited published causes without revealing unpublished details', () => {
  const ledger = { namespace: 'shared', path: '/canon/events' }
  const events = [
    { id: 'visible', shown: '已呈现', source: '正文', content: 'O4 把茶杯搁回托盘。', because: ['earlier'] },
    { id: 'earlier', shown: '已呈现', content: '已公开但没有直接引用' },
    { id: 'archived', active: false, shown: '已呈现', content: '已归档事实' },
    { id: 'private', shown: '未呈现', content: '未公开发生的秘密' },
    { id: 'hint', shown: '仅痕迹', content: '仅留痕迹的暗线' },
    { id: 'unrelated', shown: '已呈现', content: '无关事实' },
    { id: 'line', source: '裁定', content: '她提到他刚才把茶杯放下。', because: ['visible', 'archived', 'private', 'hint'],
      perceivers: [{ who: 'O4', how: '亲历', what: '不额外投递的说法' }] }
  ]
  const message = { data: { world_return: { established: [{ event: 'line' }] } } }
  const baseline = [{ id: 'line', source: '裁定', perceivers: [{ who: 'O4', how: '亲历' }] }]
  const agent = { id: 'checker', execution: { livedHistoryDialoguePremises: true }, statePermissions: [{ ...ledger, access: 'read' }] }
  const run = { config: { memory: { collections: [{ id: 'events', ...ledger }] }, state: { definitions: [ledger] } } }
  const stateStore = { read: () => ({ value: events }) }
  const evidence = scopedReviewEvidence('draft', message, { run, agent, stateStore })
  assert.deepEqual(evidence, [...baseline, { id: 'visible', shown: '已呈现', source: '正文', relation: 'cause', content: 'O4 把茶杯搁回托盘。' }])
  assert.deepEqual(scopedReviewEvidence('simulation', { data: { packs: [{ stimulus: [{ event: 'line' }] }] } }, { run, agent, stateStore }), baseline)
  assert.deepEqual(scopedReviewEvidence('draft', message, { run, agent: { ...agent, execution: {} }, stateStore }), baseline)
  assert.deepEqual(scopedReviewEvidence('draft', message, { run, agent: { ...agent, statePermissions: [] },
    stateStore: { read: () => assert.fail('Must not read outside authorization') } }), [])
})

test('direct draft review swaps only its own rules and preserves legacy and simulation prompts', () => {
  const base = 'Shared rules.\n\n[[review:simulation]]Simulation rules.[[/review]]\n\n[[review:draft]]Prose rules.[[/review]]\n\nShared settings.'
  const next = base.replace('Shared settings.', '[[review:draft-direct]]One full scan.[[/review]]\n\nShared settings.')
  assert.equal(scopedReviewPrompt(next, 'draft'), scopedReviewPrompt(base, 'draft'))
  assert.equal(scopedReviewPrompt(next, 'simulation', { directDraftReview: true }), scopedReviewPrompt(base, 'simulation'))
  assert.match(scopedReviewPrompt(next, 'draft', { directDraftReview: true }), /One full scan/)
  assert.doesNotMatch(scopedReviewPrompt(next, 'draft', { directDraftReview: true }), /Prose rules|Simulation rules/)
})

test('independent dialogue premises come only from the authorized frozen base of the current turn', () => {
  const namespace = 'shared'
  const path = '/canon/events'
  const agent = { id: 'checker', execution: { livedHistoryDialoguePremises: true, livedHistoryIndependentPremises: true },
    statePermissions: [{ namespace, path, access: 'read' }, { namespace, path: `${path}/2/content`, access: 'none' }] }
  const run = { conversationId: 'c', runId: 'r', config: { memory: { collections: [{ id: 'events', namespace, path }] },
    state: { definitions: [{ namespace, path }] } } }
  const known = { id: 'guardian', source: '开卷', shown: '未呈现', content: '他是她的法定监护人。',
    perceivers: [{ who: '星凛', how: '亲历' }] }
  const caseRows = [known,
    { id: 'review-form', source: '裁定', shown: '已呈现', content: '表上体检报告一栏空着。', because: ['guardian', 'redacted', 'secret'] },
    { id: 'redacted', source: '裁定', shown: '已呈现', content: '不可读' },
    { id: 'secret', source: '幕外', shown: '未呈现', content: '隐藏的名字。' },
    { id: 'irrelevant', source: '开卷', shown: '已呈现', content: '别处发生的事。' },
    { id: 'archive', source: '裁定', shown: '已呈现', content: '已撤销的边缘证据。', active: false },
    { id: 'trace', source: '裁定', shown: '仅痕迹', content: '完整暗线。' },
    { id: 'prewritten', source: '开卷', shown: '未呈现', content: '角色只听说的消息。', perceivers: [{ who: '星凛', how: '听说' }] },
    { id: 'reported-overreach', source: '正文越权', shown: '已呈现', content: '此前的正文越权仍没有确立事实。' },
    { id: 'summary', source: '摘要', shown: '已呈现', content: '摘要只整合记载，不能确立新事。' }
  ]
  const loop = { id: 'current-generated', source: '裁定', shown: '已呈现', content: '监护人栏印着他的名字。', because: ['redacted', 'secret'] }
  const message = { data: { current_input: '我要你说真话。', world_return: {
    established: ['review-form', 'current-generated', 'archive', 'trace', 'prewritten', 'reported-overreach', 'summary'].map(event => ({ event })),
    perceivable: [{ who: 'O4', what: '她说那一格有他的名字。' }], attempts: [{ beats: [{ says: ['名字已经印在表上。'] }] }]
  } } }
  const stateStore = { status: endpoint => {
    assert.deepEqual(endpoint, { conversationId: 'c', runId: 'r' })
    return { state: { shared: { canon: { events: caseRows } } } }
  }, read: () => ({ value: [...caseRows, loop] }) }
  const projected = scopedDraftPremiseEvidence(message, { run, agent, stateStore })
  assert.deepEqual(projected.map(({ id, content }) => [id, content]), [
    ['guardian', '他是她的法定监护人。'], ['review-form', '表上体检报告一栏空着。']
  ])
  assert.deepEqual(projected[0].perceivers, [{ who: '星凛', how: '亲历' }])
  assert.ok(!scopedReviewEvidence('draft', message, { run, agent, stateStore }).some(row => row.content !== undefined))
  assert.deepEqual(scopedDraftPremiseEvidence(message, { run, agent: { ...agent, statePermissions: [] },
    stateStore: { status: () => assert.fail('Must not read unauthorized ledger') } }), [])
})

test('independent premise prompt is scoped to the flagged direct draft checker', () => {
  const base = '[[review:simulation]]Sim rules.[[/review]][[review:draft]]Base.[[/review]]' +
    '[[review:draft-direct]][[review-premises:legacy]]Legacy premise.[[/review-premises]]' +
    '[[review-premises:independent]]Independent premise.[[/review-premises]]' +
    '[[review-presentation:quotes]]Legacy presentation.[[/review-presentation]]' +
    '[[review-presentation:passages]]Numbered presentation.[[/review-presentation]][[/review]]'
  assert.equal(scopedReviewPrompt(base, 'simulation', { directDraftReview: true, independentPremises: true }), 'Sim rules.')
  assert.match(scopedReviewPrompt(base, 'draft', { directDraftReview: true }), /Legacy premise/)
  assert.doesNotMatch(scopedReviewPrompt(base, 'draft', { directDraftReview: true }), /Independent premise/)
  assert.match(scopedReviewPrompt(base, 'draft', { directDraftReview: true, independentPremises: true }), /Independent premise/)
  assert.doesNotMatch(scopedReviewPrompt(base, 'draft', { directDraftReview: true, independentPremises: true }), /Legacy premise|presentation/)
})

test('draft lanes receive the same manuscript and only the evidence needed for their duties', () => {
  const draft = '显示器还暗着。她把托盘推到一旁。'
  const original = { requestId: 'active', from: 'writer', to: 'checker', type: 'request', data: {
    draft, current_input: '我停手。', world_return: {
      established: [{ event: 'form', content: '她让托盘挪开。' }],
      perceivable: [{ who: 'user', what: '显示器是暗的。' }],
      not_reveal: ['放在她心里的决定'], attempts: [{ slot: 1, people: ['星凛'], beats: [{ who: '星凛', does: '推托盘', withheld: '心事' }] }],
      hidden: ['不应投影字段']
    }, presentation: ['私有账本匹配']
  } }
  const project = lane => projectDraftLaneMessage(original, lane).data
  assert.deepEqual(project('fact'), { draft, current_input: original.data.current_input, world_return: {
    established: original.data.world_return.established, perceivable: original.data.world_return.perceivable,
    attempts: [{ slot: 1, people: ['星凛'], beats: [{ who: '星凛', does: '推托盘' }] }]
  } })
  assert.deepEqual(project('presentation'), { draft, world_return: {
    established: original.data.world_return.established, perceivable: original.data.world_return.perceivable,
    not_reveal: original.data.world_return.not_reveal
  } })
  const agent = { id: 'checker', context: { sources: [{ type: 'agent_messages', agentIds: ['writer'] }] },
    execution: { livedHistoryDirectDraftReview: true, livedHistoryDraftFactLane: true, livedHistoryDraftPresentationLane: true,
      livedHistoryIndependentPremises: true, livedHistoryReviewPresentation: true, livedHistoryPassageChoices: true },
    statePermissions: [], triggers: [{ type: 'requested_by_agent', from: ['writer'] }] }
  const request = { handoffId: 'check-draft', to: agent.id, scopedReview: true, compactReview: 'draft' }
  const run = { config: { state: { definitions: [] } }, handoffRequests: [], communication: {
    getRequest: () => request, allMessages: () => [original]
  } }
  const stateStore = { snapshot: () => ({}), versionsSnapshot: () => ({}) }
  const activate = () => createChildContextData({ run, agent, stateStore, activation: { requestId: 'active' } })
  assert.deepEqual(activate().agentContext.sources, { agent_messages: [projectDraftLaneMessage(original, 'fact')], review_independent_facts: [] })
  assert.equal(activate().draftLane, 'fact')
  request.handoffId = 'check-draft-presentation'
  assert.deepEqual(activate().agentContext.sources, { agent_messages: [projectDraftLaneMessage(original, 'presentation')] })
  assert.equal(activate().draftLane, 'presentation')
  assert.equal(scopedDraftLane({ ...request, handoffId: 'check-sim', compactReview: 'simulation' }, agent), undefined)
  assert.equal(scopedDraftLane(request, { ...agent, execution: { livedHistoryDraftPresentationLane: true } }), undefined)
})

test('lane prompts select only their rubric and settings and leave simulation, ordinary draft and legacy intact', () => {
  const authored = '[[review:simulation]]Sim rules.[[/review]][[review:draft]]Base.[[/review]]' +
    '[[review:draft-direct]]Legacy direct.[[/review]]' +
    '[[review-lane:fact]]Fact only.[[/review-lane]][[review-lane:presentation]]Present only.[[/review-lane]]' +
    '[[review-setting:shared]]Shared invariants.[[/review-setting]]' +
    '[[review-setting:fact]]Fact setting.[[/review-setting]][[review-setting:presentation]]Present setting.[[/review-setting]]'
  const fact = scopedReviewPrompt(authored, 'draft', { directDraftReview: true, draftLane: 'fact' })
  const presentation = scopedReviewPrompt(authored, 'draft', { directDraftReview: true, draftLane: 'presentation' })
  assert.match(fact, /Fact only\.Fact setting\./)
  assert.doesNotMatch(fact, /Present|Legacy|Sim|review-|Shared invariants/)
  assert.match(presentation, /Present only\.Present setting\./)
  assert.doesNotMatch(presentation, /Fact|Legacy|Sim|review-|Shared invariants/)
  const simulation = scopedReviewPrompt(authored, 'simulation', { directDraftReview: true, draftLane: 'fact' })
  assert.match(simulation, /Sim rules/)
  assert.match(simulation, /Shared invariants/)
  assert.doesNotMatch(simulation, /Fact only|Present only|Legacy direct/)
  assert.match(scopedReviewPrompt(authored, 'draft', { directDraftReview: true }), /Legacy direct/)
  assert.match(scopedReviewPrompt(authored, 'draft'), /Base/)
})

test('numbered review exposes one draft copy and selects its matching instructions', () => {
  const agent = { id: 'checker', context: { sources: [{ type: 'agent_messages', agentIds: ['writer'] }] },
    execution: { livedHistoryDirectDraftReview: true, livedHistoryReviewPresentation: true, livedHistoryPassageChoices: true },
    statePermissions: [], triggers: [{ type: 'requested_by_agent', from: ['writer'] }],
    systemPrompt: '[[review:draft]]Legacy.[[/review]] [[review:draft-direct]]Review. [[review-presentation:quotes]]Use quotes.[[/review-presentation]] ' +
      '[[review-presentation:passages]]Use passages.[[/review-presentation]][[/review]]' }
  const draft = '准确正文独有句子。\n\n继续。'
  const original = { requestId: 'active', from: 'writer', to: agent.id, type: 'request',
    data: { draft, current_input: '原话', world_return: {} } }
  const run = { config: { state: { definitions: [] } }, handoffRequests: [], communication: {
    getRequest: () => ({ to: agent.id, scopedReview: true, compactReview: 'draft' }), allMessages: () => [original]
  } }
  const stateStore = { snapshot: () => ({}), versionsSnapshot: () => ({}) }
  const activated = () => createChildContextData({ run, agent, stateStore, activation: { requestId: 'active' } })
  const packet = activated()
  assert.deepEqual(packet.agentContext.sources, { agent_messages: [{ ...original, data: { current_input: '原话', world_return: {} } }],
    review_passages: [[1, '准确正文独有句子。'], [2, '继续。']], review_outcomes: [] })
  assert.equal(original.data.draft, draft)
  const prompt = options => scopedReviewPrompt(agent.systemPrompt, 'draft', { directDraftReview: true, ...options })
  assert.match(prompt({ passageChoices: true }), /Use passages/)
  assert.doesNotMatch(prompt({ passageChoices: true }), /Use quotes|review-presentation/)
  agent.execution.livedHistoryPassageChoices = false
  assert.deepEqual(activated().agentContext.sources, { agent_messages: [original], review_outcomes: [] })
  assert.match(prompt({}), /Use quotes/)
  assert.doesNotMatch(prompt({}), /Use passages|review-presentation/)
})

test('direct draft reviewer declares pass and issues and keeps exact-quote enforcement', async () => {
  const request = { compactReview: 'draft', request: { data: { draft: '杯壁上的水汽淌到桌上。林澄忽然想起了小陈的门禁密码。' } } }
  const results = []
  const registered = []
  const register = scopedReview => registerTeamTools({
    agentCtx: { tools: { register: tool => { registered.push(tool); return () => {} } } },
    defineTool, scopedReview, member: { execution: { livedHistoryDirectDraftReview: true } },
    assertActiveCaller: () => {},
    submitInternal: args => {
      validateScopedReviewVerdict(request, args.data)
      results.push(args)
      return { status: 'accepted' }
    }
  })
  const closeDraft = register('draft')
  const [tool] = registered
  assert.equal(registered.length, 1)
  assert.deepEqual(Object.keys(tool.parameters.properties).sort(), ['issues', 'pass'])
  const exec = { agent: {} }
  const issue = { kind: '知情越界', quote: '林澄忽然想起了小陈的门禁密码。', note: '她不知道这个密码。' }
  await tool.execute({ pass: true, issues: [] }, exec)
  await tool.execute({ pass: false, issues: [issue] }, exec)
  await assert.rejects(() => tool.execute({ pass: false, issues: [{ ...issue, quote: '别的句子。' }] }, exec),
    { code: 'RP_TEAM_HANDOFF_RESPONSE_INVALID' })
  assert.deepEqual(results.map(item => item.data), [{ pass: true, issues: [] }, { pass: false, issues: [issue] }])
  closeDraft()
  const closeSim = register('simulation')
  assert.deepEqual(Object.keys(registered[1].parameters.properties).sort(), ['data', 'summary'])
  closeSim()
})
