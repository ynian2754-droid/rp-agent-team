import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { prepareLivedHistoryWorldClose, prepareLivedHistoryWorldStart, prepareLivedHistoryWorldSubmission,
  validateLivedHistoryWorldBackground } from '../src/host/lived-history-world-turn.mjs'
import { StateStore } from '../src/host/state-store.mjs'
import { defaultTeamConfig } from '../src/shared/schema.mjs'

const namespace = 'shared'
const eventsPath = '/canon/events'
const hiddenPath = '/canon/hidden'
const worldPath = '/canon/world'
const situationsPath = '/situations'
const settingsPath = '/story/settings-log'
const event = (content, source = '裁定') => ({ content, source, storyTime: '22:47', shown: '待呈现' })
const file = { player: '甲', present: ['乙'] }

function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), 'rp-team-world-turn-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const config = defaultTeamConfig()
  const [chronicle, member] = config.agents
  member.outputAuthority.state = true
  member.statePermissions = [eventsPath, hiddenPath, worldPath, situationsPath, settingsPath].map(
    path => ({ namespace, path, access: 'readwrite' })
  )
  chronicle.statePermissions = [eventsPath, `${worldPath}/now/place`].map(path => ({ namespace, path, access: 'readwrite' }))
  config.memory = { collections: [
    { id: 'events', name: 'Events', namespace, path: eventsPath },
    { id: 'hidden', name: 'Hidden', namespace, path: hiddenPath }
  ] }
  config.state.definitions = [
    { namespace, path: eventsPath, type: 'array', default: [{ id: 'old', ...event('乙端来一杯水。') }] },
    { namespace, path: hiddenPath, type: 'array', default: [] },
    { namespace, path: worldPath, type: 'object', default: { now: '22:47' } },
    { namespace, path: situationsPath, type: 'object', default: { 丙: { location: '屋外' } } },
    { namespace, path: settingsPath, type: 'array', default: [] }
  ]
  const run = { conversationId: 'conversation', runId: 'run', config, currentInput: '我坐下来，说：「我在听。」' }
  const stateStore = new StateStore(home)
  stateStore.begin(run)
  const endpoint = { conversationId: run.conversationId, runId: run.runId, agentId: member.id }
  const deps = { run, member, stateStore }
  return {
    stateStore, endpoint, member,
    start: (args, priorStimulus) => prepareLivedHistoryWorldStart({ ...deps, args, priorStimulus }),
    prepare: background => prepareLivedHistoryWorldClose({ ...deps,
      background: validateLivedHistoryWorldBackground({ ...deps, background }) }),
    submit: (args, prepared) => prepareLivedHistoryWorldSubmission({ ...deps, args, prepared }),
    write: targets => stateStore.writeBatch({ ...endpoint, targets }),
    read: path => stateStore.read({ ...endpoint, namespace, path }),
    showOld: () => stateStore.write({ ...endpoint, agentId: chronicle.id, namespace,
      path: `${eventsPath}/0/shown`, value: '仅痕迹', expectedVersion: 0 }),
    appendClerkLog: () => stateStore.write({ ...endpoint, agentId: chronicle.id, namespace,
      path: `${eventsPath}/2`, value: { id: 'clerk-note', ...event('较早细节被补录。', '补充') }, expectedVersion: 0 }),
    movePlace: expectedVersion => stateStore.write({ ...endpoint, agentId: chronicle.id, namespace,
      path: `${worldPath}/now/place`, value: '门廊', expectedVersion })
  }
}

test('world start forwards verbatim user stimuli in order and isolates settings writes from material inputs', t => {
  const { start, write, read, showOld } = fixture(t)
  const stimuli = [
    { content: '我坐下来', record: event('甲坐下来。', '用户') },
    { content: '我在听。', record: event('甲说「我在听。」', '用户') }
  ]
  const result = start({ file, stimuli, settingsLog: { expectedVersion: 0, value: [{ realism: 'normal' }] } })
  assert.deepEqual(result.data, { ...file, mode: '推演', stimulus: [
    { event: result.eventIds[0], content: '我坐下来' },
    { event: result.eventIds[1], content: '我在听。' }
  ] })
  showOld()
  write(result.writes)
  assert.deepEqual(read(settingsPath).value, [])
  assert.deepEqual(read(eventsPath).value.map(row => row.id), ['old', ...result.eventIds])
  assert.equal(read(`${eventsPath}/0/shown`).value, '仅痕迹')
  write(result.independentWrites)
  assert.deepEqual(read(settingsPath).value, [{ realism: 'normal' }])
  assert.throws(() => start({ file, stimuli: [stimuli[1], stimuli[0]] }), /original order/)
  assert.throws(() => start({ file, stimuli: [stimuli[0], stimuli[0]] }), /distinct/)
  assert.throws(() => start({ file, stimuli: [{ content: '我没有听。', record: stimuli[1].record }] }), /verbatim input/)
})

test('focused world reuses same-turn stimuli already staged and appends only novel passages', t => {
  const { start, write, read, member } = fixture(t)
  member.execution.livedHistoryFocusedWorld = true
  const first = { content: '我坐下来', record: event('甲坐下来。', '用户') }
  const second = { content: '我在听。', record: event('甲说「我在听。」', '用户') }
  const started = start({ file, stimuli: [first] })
  write(started.writes)
  const retry = start({ file, stimuli: [{ ...first, record: event('甲落座。', '用户') }, second] }, [
    { ...started.stimulus[0], event: 'missing' },
    { ...started.stimulus[0], event: 'old' },
    ...started.stimulus
  ])
  assert.equal(retry.eventIds[0], started.eventIds[0])
  assert.deepEqual(retry.data.stimulus.map(row => row.event), retry.eventIds)
  assert.deepEqual(retry.writes.map(row => row.path), [`${eventsPath}/2`])
  write(retry.writes)
  const repeated = start({ file, stimuli: [first, second] }, retry.stimulus)
  assert.deepEqual(repeated.eventIds, retry.eventIds)
  assert.deepEqual(repeated.writes, [])
  assert.deepEqual(read(eventsPath).value.map(row => row.id), ['old', ...retry.eventIds])

  member.execution.livedHistoryFocusedWorld = false
  assert.equal(start({ file, stimuli: [first] }, retry.stimulus).writes.length, 1)
})

test('world start supports adjudication without a clerk and dispatch without explicit player stimulus', t => {
  const { start, write, read } = fixture(t)
  const solo = start({ stimuli: [{ content: '我坐下来', record: event('甲坐下。', '用户') }] })
  assert.equal(solo.data, undefined)
  assert.deepEqual(solo.stimulus, [{ event: solo.eventIds[0], content: '我坐下来' }])
  write(solo.writes)
  assert.deepEqual(read(eventsPath).value.map(row => row.id), ['old', solo.eventIds[0]])

  const noStimulus = start({ file, stimuli: [] })
  assert.deepEqual(noStimulus.writes, [])
  assert.deepEqual(noStimulus.data, { ...file, mode: '推演', stimulus: [] })
  assert.throws(() => start({ stimuli: [] }), /at least one stimulus/)
})

test('terminal batch resolves earlier event keys and preserves atomic state and receipt', t => {
  const { start, submit, write, read, showOld, stateStore, endpoint } = fixture(t)
  const entered = start({ file, stimuli: [{ content: '我坐下来', record: event('甲坐下。', '用户') }] })
  write(entered.writes)
  showOld()
  const worldBefore = read(worldPath)
  const args = {
    data: { established: [{ event: 'reply', content: '乙点头。' }, { event: { $event: 'followup' }, content: '乙换了话题。' }], attempts: { $ref: 'ask-file#1', pointer: '/groups' } },
    events: [
      { key: 'reply', record: { ...event('乙点头。'), because: entered.eventIds } },
      { key: 'followup', record: { ...event('乙换了话题。'), because: ['reply', 'old'], covers: ['reply'], corrects: 'reply' } }
    ],
    hidden: [{ record: { content: '乙认出了她。', since: 'reply' } }],
    state: [{ path: worldPath, value: { now: '22:48' }, expectedVersion: worldBefore.version }]
  }
  const invalidState = submit({ ...args, state: [{ ...args.state[0], value: [] }] })
  assert.throws(() => write(invalidState.writes), /must be object/)
  assert.deepEqual(read(eventsPath).value.map(row => row.id), ['old', ...entered.eventIds])
  assert.deepEqual(read(hiddenPath).value, [])

  const terminal = submit(args)
  assert.deepEqual(terminal.writes.map(row => row.path), [`${eventsPath}/2`, `${eventsPath}/3`, `${hiddenPath}/0`, worldPath])
  const [reply, followup] = terminal.writes.map(row => row.value.id)
  assert.deepEqual(terminal.data.established.map(row => row.event), [reply, followup])
  assert.deepEqual(terminal.data.attempts, args.data.attempts)
  write(terminal.writes)
  assert.equal(stateStore.stage(endpoint).status, 'pending')
  const receipt = { outcome: 'committed', receiptKey: endpoint.runId, assistantMessageId: 'answer' }
  assert.equal(stateStore.commit({ ...endpoint, receipt }).status, 'committed')
  const { revision, namespaces } = stateStore.committedSnapshot(endpoint)
  assert.equal(revision, 1)
  assert.deepEqual(namespaces.shared.canon.events.map(row => row.id), ['old', ...entered.eventIds, reply, followup])
  assert.deepEqual(namespaces.shared.canon.events[3].because, [reply, 'old'])
  assert.deepEqual(namespaces.shared.canon.events[3].covers, [reply])
  assert.equal(namespaces.shared.canon.events[3].corrects, reply)
  assert.equal(namespaces.shared.canon.hidden[0].since, reply)
})

test('terminal batch rejects duplicate records and premature forward event keys before staging', t => {
  const { submit, read } = fixture(t)
  const eventRecord = event('乙点头。')
  assert.throws(() => submit({ data: {}, events: [{ record: eventRecord }, { record: eventRecord }] }), /Duplicate events record/)
  assert.throws(() => submit({ data: {}, events: [
    { record: { ...eventRecord, because: [{ $event: 'later' }] } },
    { key: 'later', record: event('乙换了话题。') }
  ] }), /previously declared/)
  assert.throws(() => submit({ data: {}, events: [
    { record: { ...eventRecord, because: ['later'] } },
    { key: 'later', record: event('乙换了话题。') }
  ] }), /previously declared/)
  assert.throws(() => submit({ data: {}, events: [{ record: event('我在听。', '用户') }] }), /start tool/)
  assert.equal(read(eventsPath).value.length, 1)
})

test('world receipt uses exact active event links and allows an observation without a recorded event', t => {
  const { submit, read, write } = fixture(t)
  write([{ namespace, path: `${eventsPath}/1`, value: { id: 'archived', ...event('旧记录。'), active: false }, expectedVersion: 0 }])
  const events = [{ key: 'xing_answers', record: event('星凛答「留下」。') }]
  const state = [{ path: worldPath, value: { now: '22:49' }, expectedVersion: 0 }]
  for (const invalid of ['星凛答话', 'archived', null]) {
    assert.throws(() => submit({ data: { established: [{ event: invalid }] }, events, state }),
      /established\[0\]\.event.*active event ID.*Available keys: xing_answers/u)
  }
  assert.equal(read(eventsPath).value.length, 2)
  assert.equal(read(worldPath).value.now, '22:47')
  const result = submit({ data: { established: [{ event: 'old' }, { event: 'xing_answers' },
    { event: { $event: 'xing_answers' } }, { content: '风扇仍在响。' }] }, events, state })
  assert.deepEqual(result.data.established, [
    { event: 'old' }, { event: result.writes[0].value.id }, { event: result.writes[0].value.id }, { content: '风扇仍在响。' }
  ])
  assert.throws(() => submit({ data: { established: [{ event: 'inactive' }] },
    events: [{ key: 'inactive', record: { ...event('停用。'), active: false } }] }), /active event ID/u)
})

test('prepared close keeps cues, folds background once after a retry and preserves FIFO and compact state', t => {
  const { start, prepare, submit, write, read, appendClerkLog, member } = fixture(t)
  member.execution.livedHistoryFocusedWorld = true
  write([{ namespace, path: worldPath, value: {
    now: { storyTime: '22:47', place: '门厅', present: ['甲', '乙'], doing: '等候' },
    clocks: [{ what: '隔壁根据声响敲墙', due: '22:50', known_to: [] }],
    agendas: [], ties: [{ between: '甲乙', kind: '熟人' }], offstage_until: '22:47'
  }, expectedVersion: 0 }])
  const input = {
    file: { ...file, sceneCues: [{ content: '灰色上传条已逼近末端。', perceivers: ['乙'] }], midbeat: [] },
    stimuli: [{ content: '我坐下来', record: event('甲坐下。', '用户') }]
  }
  const independent = { events: [{ key: 'away', record: event('楼下门卫例行交班。', '幕外') }],
    worldPatch: { offstage_until: '22:48' } }
  assert.throws(() => prepare({ worldPatch: { now: { storyTime: '22:50' } } }), /only clocks/)
  assert.throws(() => prepare({ events: [{ key: 'invalid', record: event('乙抬手。') }] }), /source 幕外 or 补充/)
  assert.throws(() => prepare({ events: [...independent.events, ...independent.events] }), /unique nonempty local key/)
  const first = start(input)
  write(first.writes)
  const abandoned = prepare(independent)
  assert.deepEqual(abandoned.summary, { eventKeys: ['away'], statePaths: [`${worldPath}/offstage_until`] })
  assert.equal(read(worldPath).value.offstage_until, '22:47')
  assert.deepEqual(read(eventsPath).value.map(row => row.id), ['old', ...first.eventIds])

  appendClerkLog()
  const retry = start(input, first.stimulus)
  assert.deepEqual(retry.data, first.data)
  assert.deepEqual(retry.writes, [])
  const prepared = prepare(independent)
  const outcome = { key: 'reaction', record: { ...event('乙看着进度条按住了桌边。'), because: ['away', ...retry.eventIds] } }
  const final = submit({ data: { established: [{ event: 'reaction' }] }, events: [outcome],
    worldPatch: { now: { storyTime: '22:48', doing: '乙按住桌边' }, situations: { '乙/别称~': { location: '桌旁' } } } }, prepared)
  const [backgroundWrite, actorWrite] = final.writes
  assert.equal(backgroundWrite.path, `${eventsPath}/3`)
  assert.equal(actorWrite.path, `${eventsPath}/4`)
  assert.deepEqual(actorWrite.value.because, [backgroundWrite.value.id, ...first.eventIds])
  assert.equal(final.data.established[0].event, actorWrite.value.id)
  assert.throws(() => submit({ data: {}, events: independent.events }, prepared), /unique nonempty local key/)
  write(final.writes)
  assert.deepEqual(read(eventsPath).value.map(row => row.id), ['old', ...first.eventIds, 'clerk-note', backgroundWrite.value.id, actorWrite.value.id])
  assert.deepEqual(read(worldPath).value, {
    now: { storyTime: '22:48', place: '门厅', present: ['甲', '乙'], doing: '乙按住桌边' },
    clocks: [{ what: '隔壁根据声响敲墙', due: '22:50', known_to: [] }],
    agendas: [], ties: [{ between: '甲乙', kind: '熟人' }], offstage_until: '22:48'
  })
  assert.deepEqual(read(situationsPath).value, { 丙: { location: '屋外' }, '乙/别称~': { location: '桌旁' } })
})

test('compact close pins leaf versions and leaves the ledger intact on CAS failure', t => {
  const { prepare, submit, write, read, movePlace } = fixture(t)
  write([{ namespace, path: worldPath, value: { now: { place: '门厅', storyTime: '22:47' } }, expectedVersion: 0 }])
  const prepared = prepare()
  movePlace(read(`${worldPath}/now/place`).version)
  const outcome = { key: 'reaction', record: event('乙站起。') }
  const overlap = submit({ data: {}, events: [outcome], worldPatch: { now: { place: '内屋' } } }, prepared)
  assert.throws(() => write(overlap.writes), error => error.code === 'RP_TEAM_STATE_CONFLICT')
  assert.equal(read(eventsPath).value.length, 1)
  const independent = submit({ data: {}, events: [outcome], worldPatch: { now: { storyTime: '22:48' } } }, prepared)
  write(independent.writes)
  assert.deepEqual(read(`${worldPath}/now`).value, { place: '门廊', storyTime: '22:48' })
})
