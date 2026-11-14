import assert from 'node:assert/strict'
import test from 'node:test'
import { buildLivedHistoryPack, createLivedHistoryPackSource, livedHistoryPackLog, primeLivedHistoryPackReaders } from '../src/host/lived-history-pack.mjs'
import { createLivedHistoryWorldFacts, focusedWorldStartParameters, focusedWorldStartParametersWithSceneCues } from '../src/host/lived-history-world.mjs'
import { childPolicy, createChildContextData } from '../src/host/agent-context.mjs'
import { prepareReviewData, validateSimulationEvidence } from '../src/host/lived-history-review.mjs'
import { restoreSimulationGroundRefs, simulationGroundChoiceIds } from '../src/host/lived-history-sim-evidence.mjs'

const namespace = 'shared'
const know = (who, how = '目击', what) => ({ who, how, ...(what ? { what } : {}) })
const event = (id, perceivers, options = {}) => ({ id, storyTime: '旧时', content: id + '原文', perceivers, ...options })
const stored = {
  '/canon/world': { now: { storyTime: '今日', place: '书房' } },
  '/canon/events': [
    event('e-shared', [know('甲'), know('乙')]),
    event('e-secret', [know('甲'), know('乙', '不知')]),
    event('e-different', [know('甲', '亲历'), know('乙', '听说', '不同版本')]),
    event('e-archived', [know('甲'), know('乙')], { active: false }),
    event('recent-observable', [know('甲'), know('乙')], { storyTime: '今日', people: ['甲', '乙'] }),
    event('stimulus', [know('甲'), know('乙', '不知')])
  ],
  '/canon/hidden': [
    { id: 'h1', content: '暗线原文', known_to: ['甲'], status: '隐' },
    { id: 'h2', content: '已揭示内容', known_to: ['甲', '乙'], status: '已揭示' }
  ],
  '/situations': { 甲: '刚进书房' },
  '/selves': {
    甲: {
      account: { now: { text: '自述原文' } },
      commitments: { k1: { text: '要把话说清楚。', since: '前日' } },
      toward: { 乙: { view: '看法原文' }, 丙: { view: '对不在场者的看法' } },
      carrying: { k1: { what: '隐私', private: true }, k2: { what: '旧事', done: '上轮' } }
    }
  },
  '/memories': {
    甲: { m1: { content: '共同记忆' }, m2: { content: '私人记忆', private: true }, m3: { archived: true } }
  },
  '/practices': { 甲: [{ doing: '反例原文', last: '前日' }] },
  '/story/packs': [{ seq: 2 }]
}
const input = {
  mode: '推演', player: '用户', present: ['用户', '甲', '乙'],
  stimulus: [{ event: 'stimulus', content: '刺激原文' }], midbeat: [{ content: '中途原文', when: '三秒后' }],
  material: [{ who: '甲', text: '甲的建档原文' }, { who: '乙', text: '乙的建档原文' }]
}

function source({ data = input, noRead = [] } = {}) {
  const paths = Object.keys(stored)
  const agent = { id: 'clerk', communication: { handoffs: [{ materialPack: true }] },
    statePermissions: paths.filter(path => !noRead.includes(path)).map(path => ({ namespace, path, access: 'read' })) }
  const run = { conversationId: 'conversation', runId: 'run',
    config: { state: { definitions: paths.map(path => ({ namespace, path })) } },
    communication: { getRequest: id => id === 'from-world' ? { to: agent.id, request: { data } } : undefined } }
  const stateStore = { read: ({ path, agentId }) => {
    assert.equal(agentId, agent.id)
    assert.ok(!noRead.includes(path))
    return { value: structuredClone(stored[path]), version: 5 }
  } }
  return createLivedHistoryPackSource({ run, agent, stateStore, activation: { requestId: 'from-world' } })
}

test('a clerk picks evidence IDs and the host keeps originals while enforcing shared perception and privacy', () => {
  const selected = { 甲: {
    knows: ['e-shared', 'e-secret', 'e-different', 'e-archived', 'h1', 'h2', 'invented'],
    precedents: ['e-shared'], memories: ['m1', 'm2', 'm3'], practices: [0] } }
  const pack = buildLivedHistoryPack(source(), { slot: 1, group: ['甲', '乙'], evidence: selected, now: 'model-draft' })
  assert.equal(pack.now, '今日，书房，甲，乙')
  assert.deepEqual(pack.stimulus, [])
  assert.deepEqual(pack.material, input.material)
  assert.deepEqual(pack.people.甲.knows.map(row => row.what), ['e-shared原文', 'recent-observable原文'])
  assert.deepEqual(pack.people.甲.memories, [{ key: 'm1', content: '共同记忆' }])
  assert.deepEqual(pack.people.甲.toward, { 乙: { view: '看法原文' } })
  assert.deepEqual(pack.people.甲.self.carrying, {})
  assert.deepEqual(pack.people.甲.practices, [{ key: 'practice:0', doing: '反例原文', last: '前日' }])
  assert.equal(pack.people.甲.omitted, 2)
  assert.equal(pack.people.乙.self, '此人尚无自述')
  assert.ok(!JSON.stringify(pack).includes('私人记忆'))

  const solo = buildLivedHistoryPack(source(), { slot: 1, group: ['甲'], evidence: selected, stimulus: [], midbeat: [0] })
  assert.deepEqual(solo.people.甲.knows.map(row => row.id), ['e-shared', 'e-secret', 'e-different', 'h1', 'recent-observable'])
  assert.equal(solo.people.甲.memories[1].content, '私人记忆')
  assert.deepEqual(solo.stimulus.map(row => row.content), ['刺激原文', '中途原文'])
  assert.deepEqual(solo.material, [input.material[0]])
})

test('current scene cues survive without a midpoint transition and only reach perceiving groups', () => {
  const progress = '压缩条在最后一格前，上传按钮仍灰着。'
  const ready = source({ data: { ...input, midbeat: [], sceneCues: [
    { content: progress, perceivers: ['甲'] },
    { content: '桌上的风扇仍在响。', perceivers: ['甲', '乙'] }
  ] } })
  const pick = group => buildLivedHistoryPack(ready, { slot: 1, group, midbeat: [] })
  const solo = pick(['甲'])
  assert.deepEqual(solo.stimulus.filter(row => row.timing), [
    { content: progress, timing: '现在' }, { content: '桌上的风扇仍在响。', timing: '现在' }
  ])
  assert.equal(solo.facing, '刺激原文')
  assert.deepEqual(pick(['甲', '乙']).stimulus, [{ content: '桌上的风扇仍在响。', timing: '现在' }])
  assert.deepEqual(pick(['乙']).stimulus, [{ content: '桌上的风扇仍在响。', timing: '现在' }])
  const review = prepareReviewData('simulation', { packs: [solo], beats: [[{ who: '甲' }]] })
  assert.deepEqual(review.packs[0].stimulus, solo.stimulus)
  assert.ok(!JSON.stringify(solo.stimulus).includes('上传按钮变亮'))
})

test('the focused startup schema only requires cue decisions from opted-in world members', () => {
  assert.equal(focusedWorldStartParameters.file.properties.sceneCues, undefined)
  const cues = focusedWorldStartParametersWithSceneCues.file.properties.sceneCues
  assert.equal(cues.required, true)
  assert.deepEqual(Object.keys(cues.items.properties), ['content', 'perceivers'])
  assert.equal(cues.items.properties.perceivers.required, true)
})

test('ground refs use the visible actor record and the same rules at submission and review', () => {
  const ready = source()
  const pick = group => buildLivedHistoryPack(ready, {
    slot: 1, group, evidence: { 甲: { knows: ['e-shared'], memories: ['m1', 'm2'] } }
  }, [], { groundRefs: true })
  const shared = pick(['甲', '乙'])
  const selfRef = 'self.commitments.k1'
  const privateRef = 'self.carrying.k1'
  assert.ok(shared.people.甲.ground_refs.includes(selfRef))
  assert.ok(!shared.people.甲.ground_refs.includes(privateRef))
  assert.ok(!shared.people.甲.ground_refs.includes('m2'))
  assert.ok(!shared.people.乙.ground_refs.includes(selfRef))

  const solo = pick(['甲'])
  assert.ok(solo.people.甲.ground_refs.includes(privateRef))
  assert.ok(!solo.people.甲.ground_refs.includes('self.carrying.k2'))
  const ground = (who, ref) => [{ who, grounds: [{ ref, note: '当下相关。' }] }]
  const accepted = ground('甲', selfRef)
  assert.doesNotThrow(() => validateSimulationEvidence(shared, accepted))
  const review = prepareReviewData('simulation', { packs: [shared], beats: [accepted] })
  assert.deepEqual(review.precheck, [])
  assert.equal(review.packs[0].people, undefined)
  assert.equal(review.beats[0][0].grounds, undefined)
  for (const invalid of [ground('甲', 'k1'), ground('甲', privateRef), ground('乙', selfRef)]) {
    assert.throws(() => validateSimulationEvidence(shared, invalid), { code: 'RP_TEAM_SIMULATION_EVIDENCE_INVALID' })
    const report = prepareReviewData('simulation', { packs: [shared], beats: [invalid] }).precheck
    assert.deepEqual(report.map(item => item.kind), ['依据不在材料包'])
  }
})

test('parallel slots stay disjoint and a replay keeps original material and visible-only relay', () => {
  const ready = source()
  const first = buildLivedHistoryPack(ready, { slot: 1, group: ['甲'] })
  const one = { ref: 'ask-sim-1#1', status: 'completed', request: { data: first },
    result: { data: { beats: [{ who: '甲', says: ['可以', '悄悄说'], does: '抬手', withheld: '没有说出口', grounds: ['秘事'] }] } } }
  assert.throws(() => buildLivedHistoryPack(ready, { slot: 1, group: ['甲', '用户'] }), { code: 'RP_TEAM_MATERIAL_PACK_INVALID' })
  assert.throws(() => buildLivedHistoryPack(ready, { slot: 2, group: ['甲'] }, [one]), { code: 'RP_TEAM_MATERIAL_PACK_INVALID' })
  const second = buildLivedHistoryPack(ready, { slot: 2, group: ['乙'], relay: {
    ref: one.ref, speakers: [{ who: '甲', says: [0], does: true, withheld: '假造内容' }]
  } }, [one])
  assert.deepEqual(second.relay, [{ who: '甲', says: ['可以'], does: '抬手' }])
  const repeated = buildLivedHistoryPack(ready, { slot: 1, repeat: one.ref, check_issues: [{ note: '查动作' }] }, [one])
  assert.deepEqual(repeated, { ...first, check_issues: [{ note: '查动作' }] })
  const log = livedHistoryPackLog(ready, [one, { request: { data: second } }, { request: { data: repeated } }], 0)
  assert.equal(log.expectedVersion, 5)
  assert.deepEqual(log.value.at(-1), { seq: 3, storyTime: '今日', relays: 0,
    groups: [{ slot: 1, people: ['甲'], ids: ['recent-observable', 'stimulus'], omitted: {} },
      { slot: 2, people: ['乙'], ids: ['recent-observable'], omitted: {} }] })
})

test('short ground options come from the authorized actor packet and remain stable on a repeated request', () => {
  const ready = source()
  const selection = { slot: 1, group: ['甲', '乙'], evidence: { 甲: { memories: ['m1', 'm2'] } } }
  const pack = buildLivedHistoryPack(ready, selection, [], { groundChoices: true })
  assert.deepEqual(pack, buildLivedHistoryPack(ready, selection, [], { groundChoices: true }))
  const { 甲: first, 乙: second } = pack.people
  const ids = simulationGroundChoiceIds(pack)
  assert.ok(ids.length > 0)
  assert.equal(ids.length, new Set(ids).size)
  assert.deepEqual(Object.values(first.ground_choices), first.ground_refs)
  assert.ok(!first.ground_refs.includes('m2'))
  const option = ref => Object.keys(first.ground_choices).find(id => first.ground_choices[id] === ref)
  const foreignOption = Object.keys(second.ground_choices)[0]
  const beat = (who, ref) => ({ who, grounds: [{ ref, note: '当前看见。' }] })
  const original = beat('甲', option('此刻场面'))
  const restored = restoreSimulationGroundRefs(pack, [original])
  assert.deepEqual(restored, [beat('甲', '此刻场面')])
  assert.notEqual(original.grounds[0].ref, restored[0].grounds[0].ref)
  assert.doesNotThrow(() => validateSimulationEvidence(pack, restored))
  for (const ref of ['时刻场面', '此刻场面', 'G9000', foreignOption]) {
    assert.throws(() => restoreSimulationGroundRefs(pack, [beat('甲', ref)]), { code: 'RP_TEAM_SIMULATION_EVIDENCE_INVALID' })
  }
  const previous = { ref: 'ask-sim-1#1', status: 'completed', request: { data: pack } }
  const repeated = buildLivedHistoryPack(ready, { slot: 1, repeat: previous.ref }, [previous], { groundChoices: true })
  assert.deepEqual(repeated.people, pack.people)
  assert.deepEqual(simulationGroundChoiceIds(buildLivedHistoryPack(ready, selection, [], { groundRefs: true })), [])
})

test('simulation sees the active choices without an earlier packet or duplicate raw refs', () => {
  const agent = { id: 'sim-1', context: { sources: [{ type: 'agent_messages' }] },
    triggers: [{ type: 'requested_by_agent', from: ['clerk'] }], statePermissions: [],
    communication: { receiveFrom: ['clerk'] }, execution: { livedHistoryGroundChoices: true } }
  const message = (requestId, ref) => ({ type: 'request', to: agent.id, from: 'clerk', requestId,
    data: { people: { 甲: { ground_refs: [ref], ground_choices: { G1: ref } } } } })
  const previous = message('previous', 'm1')
  const current = message('current', '此刻场面')
  const run = { config: { state: { definitions: [] } }, sources: {}, drafts: [],
    communication: { allMessages: () => [previous, current], getRequest: id => id === 'current'
      ? { to: agent.id, simulation: true, request: { data: current.data } } : undefined } }
  const stateStore = { snapshot: () => ({}), versionsSnapshot: () => ({}) }
  const activate = () => createChildContextData({ run, agent, stateStore, activation: { requestId: 'current' } }).agentContext.sources.agent_messages
  assert.deepEqual(activate(), [{ ...current, data: { people: { 甲: { ground_choices: { G1: '此刻场面' } } } } }])
  assert.deepEqual(current.data.people.甲.ground_refs, ['此刻场面'])
  agent.execution.livedHistoryGroundChoices = false
  assert.deepEqual(activate(), [previous, current])
})

test('prefetch respects state ACL, omits archived records, and leaves an empty cast alone', () => {
  const light = source({ noRead: ['/canon/hidden'], data: { ...input, present: ['用户'] } })
  assert.deepEqual(light.selection.present, [])
  assert.deepEqual(light.selection.hidden, [])
  assert.equal(livedHistoryPackLog(light, [], 0), undefined)
  const ready = source()
  assert.ok(!ready.selection.events.some(row => row.id === 'e-archived'))
  assert.ok(!Object.hasOwn(ready.selection.people.甲.memories, 'm3'))
})

test('the clerk sees the compact material request contract instead of canonical packet field requirements', () => {
  const agent = { id: 'clerk', name: '调卷', outputAuthority: { internal: true } }
  const material = { id: 'ask-sim-1', to: 'sim-1', mode: 'await', materialPack: true,
    requestSchema: { type: 'object', required: ['canonical_packet_fields'] }, responseSchema: { type: 'object' } }
  const run = { runId: 'run', communication: { targetsFor: () => ({ sendTo: [], requestTo: ['sim-1'], handoffs: [material] }) } }
  const policy = childPolicy(agent, run, 1)
  assert.match(policy, /material-selection sheet/)
  assert.doesNotMatch(policy, /canonical_packet_fields/)
})

test('a firsthand quote needs authoritative input and the scope of every known perception', () => {
  const ready = source()
  ready.originalInput = '我看着她问：“你想留下吗？”'
  ready.input = { ...ready.input, stimulus: [{ event: 'stimulus', content: ready.originalInput }] }
  const row = ready.events.find(event => event.id === 'stimulus')
  row.source = '用户'
  row.perceivers = [know('甲', '亲历', '对方问：你想留下吗？')]
  const send = () => buildLivedHistoryPack(ready, { slot: 1, group: ['甲'], stimulus: [] }).stimulus[0].content
  assert.equal(send(), ready.originalInput)
  row.perceivers[0].what = '只听见对方在问一个问题'
  assert.equal(send(), '只听见对方在问一个问题')
})

test('world separates authorized objective preparation from adjudication', () => {
  const agent = {
    id: 'world',
    execution: { livedHistoryPhase: 'world' },
    statePermissions: ['/canon/world', '/canon/events', '/memories'].map(path => ({ namespace, path, access: 'read' }))
  }
  const run = { conversationId: 'conversation', runId: 'run',
    config: { state: { definitions: Object.keys(stored).map(path => ({ namespace, path })) } } }
  const actual = []
  const stateStore = { read: entry => {
    actual.push([entry.agentId, entry.path])
    return { value: stored[entry.path], version: 5 }
  } }
  const facts = createLivedHistoryWorldFacts({ run, agent, stateStore })
  assert.deepEqual(actual, [['world', '/canon/world'], ['world', '/canon/events']])
  assert.deepEqual(facts.world, { value: stored['/canon/world'], version: 5 })
  assert.equal(facts.events.version, 5)
  assert.ok(!facts.events.value.some(event => event.active === false))
  assert.equal(createLivedHistoryWorldFacts({ run, agent: { ...agent, execution: {} }, stateStore }), undefined)
})

test('clerk reuses authorized prefetched paths and refreshes a staged stimulus', () => {
  const world = { id: 'world', execution: { livedHistoryPhase: 'world' }, communication: {
    handoffs: [{ to: 'clerk', mode: 'await' }]
  } }
  const mutable = structuredClone(stored)
  mutable['/canon/events'] = mutable['/canon/events'].filter(row => row.id !== 'stimulus')
  const clerk = { id: 'clerk', communication: { handoffs: [{ materialPack: true }] },
    statePermissions: Object.keys(mutable).filter(path => path !== '/canon/hidden')
      .map(path => ({ namespace, path, access: 'read' })) }
  const run = { conversationId: 'conversation', runId: 'run',
    config: { agents: [world, clerk], state: { definitions: Object.keys(mutable).map(path => ({ namespace, path })) } },
    communication: { getRequest: () => ({ to: clerk.id, request: { data: input } }) } }
  const versionKey = path => JSON.stringify([namespace, path])
  const versions = Object.fromEntries(Object.keys(mutable).map(path => [versionKey(path), 5]))
  const readPaths = []
  const stateStore = { read: ({ agentId, path }) => {
    assert.equal(agentId, clerk.id)
    readPaths.push(path)
    return { value: structuredClone(mutable[path]), version: versions[versionKey(path)] }
  } }
  primeLivedHistoryPackReaders({ run, agent: world, stateStore, versions })
  assert.equal(readPaths.length, Object.keys(mutable).length - 1)
  assert.ok(!readPaths.includes('/canon/hidden'))
  readPaths.length = 0

  mutable['/canon/events'].push(stored['/canon/events'].at(-1))
  versions[versionKey('/canon/events')] = 6
  const ready = createLivedHistoryPackSource({ run, agent: clerk, stateStore, activation: { requestId: 'from-world' }, versions })
  assert.deepEqual(readPaths, ['/canon/events'])
  assert.equal(ready.selection.events.at(-1).id, 'stimulus')
  assert.equal(buildLivedHistoryPack(ready, { slot: 1, group: ['甲'] }).stimulus[0].event, 'stimulus')
  assert.deepEqual(buildLivedHistoryPack(ready, { slot: 2, group: ['乙'] }).stimulus, [])
})
