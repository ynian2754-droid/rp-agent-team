import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defaultTeamConfig, normalizeTeamConfig, exportPreset, parsePreset } from '../src/shared/schema.mjs'
import { StateStore } from '../src/host/state-store.mjs'
import { registerContextTools } from '../src/host/context-tools.mjs'
import { registerTeamTools } from '../src/host/team-tools.mjs'
import { childPolicy, childPrompt, createChildContextData, selectedAgentAttachments } from '../src/host/agent-context.mjs'
import { restrictMemberTools, HOST_PRODUCT_TOOLS } from '../src/host/native-policy.mjs'

function fixture(t, sources = [{ type: 'hidden_state', selector: '/variables' }]) {
  const home = mkdtempSync(join(tmpdir(), 'rp-team-context-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const config = defaultTeamConfig()
  const member = config.agents[0]
  member.context.sources = sources
  member.statePermissions = [
    { namespace: 'world', path: '/variables', access: 'readwrite' },
    { namespace: 'world', path: '/variables/hidden', access: 'none' },
    { namespace: 'shared', path: '/facts', access: 'readwrite' },
    { namespace: 'world', path: '/settings', access: 'readwrite' }
  ]
  member.communication.receiveFrom = ['agent-2']
  member.outputAuthority.state = true
  config.state.definitions = [
    { namespace: 'world', path: '/variables', type: 'object', default: { score: 1, hidden: 'SECRET_CANARY', list: [1], optional: 'remove me' } },
    { namespace: 'world', path: '/settings', type: 'object', default: { Story: 'story' } },
    { namespace: 'shared', path: '/facts', type: 'object', default: { note: 'before', optional: 'remove me' } }
  ]
  const store = new StateStore(home)
  const run = { conversationId: 'conversation', runId: 'run', config, outputAgentId: config.output.agentId,
    drafts: [
      { agentId: 'agent-2', draftId: 'visible', text: 'visible draft', visibleTo: [member.id] },
      { agentId: 'agent-2', draftId: 'private', text: 'SECRET_CANARY', visibleTo: [] }
    ],
    sources: {
      current_input: { text: 'Hello', attachments: [] },
      character_card: { persona: { name: 'Known', hidden: 'SECRET_CANARY' } },
      worldbook: { entries: [{ content: 'PUBLIC story', hidden: 'SECRET_CANARY' }, { content: 'SECRET_CANARY' }] },
      recent_history: [{ content: 'SECRET_CANARY' }, { content: 'latest' }]
    },
    attachments: [],
    communication: { allMessages: () => [
      { from: 'agent-2', to: member.id, type: 'message', body: 'visible message' },
      { from: 'agent-3', to: member.id, type: 'message', body: 'SECRET_CANARY' }
    ] }
  }
  store.begin({ ...run, config })
  const tools = new Map(), events = []
  let closed = false
  const args = {
    agentCtx: { tools: { register: tool => { tools.set(tool.name, tool); return () => tools.delete(tool.name) } } },
    defineTool: definition => definition, member, run, stateStore: store,
    assertActiveCaller: agent => {
      if (closed || agent.session.id !== 'member') throw new Error('inactive caller')
    },
    record: event => events.push(event), persistRun() {}, assertInternalAuthority() {},
    requestDepth: () => 0, saveDraft() {}, submitInternal() {}, publish() {},
    attachments: { async *readFileStream(ref, signal) { signal?.throwIfAborted(); yield ref.bytes } }
  }
  const stop = registerContextTools(args), stopState = registerTeamTools(args)
  const exec = { agent: { session: { id: 'member' } }, signal: new AbortController().signal }
  return { member, config, run, store, tools, events, exec, stop, stopState, args,
    close: () => { closed = true },
    call: (name, input, execution = exec) => tools.get(name).execute(input, execution) }
}

test('provenance chronicle sees only selected published assistant history and keeps opening material separate', t => {
  const { member, run, store } = fixture(t, [
    { type: 'current_input' }, { type: 'recent_history', limit: 2 }, { type: 'full_history' },
    { type: 'character_card', selector: '/persona/name' }
  ])
  member.execution.livedHistoryPhase = 'chronicleProvenance'
  run.currentInput = '本轮尚未转录的输入'
  run.sources.current_input.text = run.currentInput
  const history = [
    { role: 'assistant', content: '不在最近选择中的旧正文' },
    { role: 'user', content: '历史玩家输入' },
    { role: 'assistant', content: '已发布的正文，原样保留。\n\n她放下杯子。' }
  ]
  run.sources.recent_history = history
  run.sources.full_history = history
  run.attachments = [{ type: 'file', name: '本轮用户附件' }]
  const child = createChildContextData({ run, agent: member, stateStore: store })
  assert.deepEqual(child.chronicleSources, [{ id: 'published-1', text: history[2].content }])
  assert.deepEqual(child.agentContext.sources, { character_card: 'Known', chronicle_sources: child.chronicleSources })
  assert.deepEqual(child.agentContext.categories, ['character_card', 'chronicle_sources'])
  assert.deepEqual(child.attachments, [])

  run.currentInput = '【开卷】我的初步理解'
  run.sources.current_input.text = run.currentInput
  const opening = createChildContextData({ run, agent: member, stateStore: store })
  assert.equal(opening.agentContext.sources.current_input.text, run.currentInput)
  assert.equal(opening.agentContext.sources.chronicle_sources, undefined)
  assert.deepEqual(opening.chronicleSources, [])

  member.execution.livedHistoryPhase = 'chronicle'
  const legacy = createChildContextData({ run, agent: member, stateStore: store })
  assert.equal(legacy.agentContext.sources.current_input.text, run.currentInput)
  assert.deepEqual(legacy.agentContext.sources.recent_history, history.slice(-2))
  assert.equal(legacy.chronicleSources, undefined)
})

test('context reads and searches filter categories, state fields, messages and private drafts before querying', async t => {
  const f = fixture(t, [
    { type: 'hidden_state', selector: '/variables' },
    { type: 'worldbook', selector: '/entries/0/content' },
    { type: 'character_card', selector: '/persona/name' },
    { type: 'agent_messages' }, { type: 'drafts', agentIds: ['agent-2'] }
  ])
  assert.equal((await f.call('rp_team_read_context', { source: 'hidden_state', path: '/score' })).value, 1)
  assert.deepEqual(await f.call('rp_team_read_context', { source: 'hidden_state', path: '/hidden' }), { found: false })
  for (const source of ['hidden_state', 'worldbook', 'character_card', 'agent_messages', 'drafts']) {
    const read = await f.call('rp_team_read_context', { source })
    assert.equal(JSON.stringify(read).includes('SECRET_CANARY'), false)
    assert.deepEqual(await f.call('rp_team_search_context', { source, query: 'SECRET_CANARY' }), { matches: [] })
  }
  await assert.rejects(f.call('rp_team_read_context', { source: 'full_history' }), { code: 'RP_TEAM_CONTEXT_FORBIDDEN' })
  await assert.rejects(f.call('rp_team_search_context', { source: 'full_history', query: 'SECRET' }), { code: 'RP_TEAM_CONTEXT_FORBIDDEN' })
})

test('focused world keeps the previous beat verbatim and retrieves only authorized originals on demand', async t => {
  const f = fixture(t, [
    { type: 'agent_messages', agentIds: ['agent-2'] }, { type: 'current_input' }, { type: 'recent_history', limit: 2 },
    { type: 'character_card', selector: '/persona' }, { type: 'worldbook', selector: '/entries/0/content' }
  ])
  Object.assign(f.member.execution, { livedHistoryPhase: 'world', livedHistoryFocusedWorld: true })
  f.member.triggers = [{ type: 'requested_by_agent', from: ['agent-2'] }]
  f.member.systemPrompt = '[[world:focused]]当前裁定限定规则[[/world]]\n[[world:other]]开卷专用规则[[/world]]'
  const beat = '传输条停在最后一格，上传按钮仍灰着。\n\n她把茶杯挪了半寸。'
  f.run.sources.recent_history = [{ role: 'assistant', content: '更早的正文' }, { role: 'assistant', content: beat }, { role: 'user', content: '已经进入本轮交接' }]
  f.run.sources.character_card.persona.user_name = '甲'
  f.run.sources.character_card.persona.assistant_name = '乙'
  f.run.sources.worldbook.entries[0].content = '仅在堵住传输接口时上传才会失败。'
  let mode = '裁定'
  f.run.communication.getRequest = () => ({ to: f.member.id, handoffId: 'ask-world', request: { data: { mode } } })
  f.run.communication.allMessages = () => [{ to: f.member.id, from: 'agent-2', requestId: 'older', type: 'request', data: { input: '旧交接' } },
    { to: f.member.id, from: 'agent-2', requestId: 'current', type: 'request', handoffId: 'ask-world', body: '同义转述', summary: '同义转述', data: { mode, input: 'Hello' } }]
  f.run.communication.targetsFor = () => ({ sendTo: [], requestTo: [] })
  const getPacket = () => createChildContextData({ run: f.run, agent: f.member, stateStore: f.store, activation: { requestId: 'current' } })
  const packet = getPacket()
  const pending = new Map([['current', { ...packet, agentId: f.member.id, activationNo: 1 }]])
  assert.equal(packet.focusedWorld, true)
  assert.deepEqual(packet.agentContext.sources.world_last_beat, { text: beat, clipped: false })
  assert.deepEqual(packet.agentContext.sources.world_names, { user_name: '甲', assistant_name: '乙' })
  assert.deepEqual(packet.agentContext.sources.world_source_lookup, ['recent_history', 'character_card', 'worldbook'])
  assert.deepEqual(packet.agentContext.sources.agent_messages, [{ requestId: 'current', from: 'agent-2', handoffId: 'ask-world', data: { mode, input: 'Hello' } }])
  for (const key of ['current_input', 'recent_history', 'character_card', 'worldbook']) assert.equal(Object.hasOwn(packet.agentContext.sources, key), false)
  const text = childPrompt(f.member, f.run, packet.agentContext, 1, pending)[0].text
  assert.match(text, /当前裁定限定规则/)
  assert.match(text, /上传按钮仍灰着/)
  assert.doesNotMatch(text, /开卷专用规则|SECRET_CANARY|仅在堵住传输接口|更早的正文|同义转述/)
  assert.deepEqual(await f.call('rp_team_read_context', { source: 'character_card', path: '/user_name' }), { found: true, value: '甲' })
  const book = await f.call('rp_team_search_context', { source: 'worldbook', query: '传输接口' })
  assert.deepEqual(book.matches, [{ path: '', value: '仅在堵住传输接口时上传才会失败。' }])
  assert.deepEqual(await f.call('rp_team_search_context', { source: 'worldbook', query: 'SECRET_CANARY' }), { matches: [] })
  await assert.rejects(f.call('rp_team_read_context', { source: 'full_history' }), { code: 'RP_TEAM_CONTEXT_FORBIDDEN' })
  for (const other of ['开卷', '补充', '修订']) {
    mode = other
    const normal = getPacket()
    assert.equal(normal.focusedWorld, undefined)
    assert.equal(normal.agentContext.sources.worldbook, '仅在堵住传输接口时上传才会失败。')
    assert.deepEqual(normal.agentContext.sources.recent_history, f.run.sources.recent_history.slice(-2))
    const normalPending = new Map([['current', { ...normal, agentId: f.member.id, activationNo: 1 }]])
    assert.match(childPolicy(f.member, f.run, 1, normalPending), /开卷专用规则/)
  }
  const tick = createChildContextData({ run: f.run, agent: f.member, stateStore: f.store, activation: {} })
  assert.equal(tick.focusedWorld, undefined)
  assert.equal(tick.agentContext.sources.worldbook, '仅在堵住传输接口时上传才会失败。')
})

test('selectors, limits and escaped result paths stay within the filtered packet', async t => {
  const f = fixture(t, [{ type: 'recent_history', limit: 1 },
    { type: 'character_card', selector: '/persona/a~1b/~0' },
    { type: 'character_card', selector: '/persona/name' },
    { type: 'character_card', selector: '/persona/missing' }])
  f.run.sources.character_card.persona['a/b'] = { '~': 'PUBLIC value', hidden: 'SECRET_CANARY' }
  assert.deepEqual((await f.call('rp_team_read_context', { source: 'recent_history' })).value, [{ content: 'latest' }])
  assert.equal((await f.call('rp_team_read_context', { source: 'character_card', path: '/persona/a~1b/~0' })).value, 'PUBLIC value')
  assert.deepEqual(await f.call('rp_team_search_context', { source: 'character_card', query: 'public' }), { matches: [{ path: '/persona/a~1b/~0', value: 'PUBLIC value' }] })
  assert.deepEqual(await f.call('rp_team_read_context', { source: 'character_card', path: '/__proto__/constructor' }), { found: false })
  await assert.rejects(f.call('rp_team_read_context', { source: 'character_card', path: '/bad~9' }), { code: 'RP_TEAM_INVALID_REQUEST' })
  await assert.rejects(f.call('rp_team_search_context', { source: 'character_card', query: 'x', limit: 101 }), { code: 'RP_TEAM_INVALID_REQUEST' })
})

test('context tools see permitted staged writes and reject stale writes, wrong callers and closed attempts', async t => {
  const f = fixture(t)
  await f.call('rp_team_write_state', { namespace: 'world', path: '/variables/score', value: 2, expectedVersion: 0 })
  assert.equal((await f.call('rp_team_read_context', { source: 'hidden_state', path: '/score' })).value, 2)
  await assert.rejects(f.call('rp_team_write_state', { namespace: 'world', path: '/variables/score', value: 3, expectedVersion: 0 }), { code: 'RP_TEAM_STATE_CONFLICT' })
  await assert.rejects(f.call('rp_team_write_state', { namespace: 'world', path: '/variables/hidden', value: 'bad', expectedVersion: 0 }), { code: 'RP_TEAM_STATE_FORBIDDEN' })
  await assert.rejects(f.call('rp_team_read_context', { source: 'hidden_state' }, { ...f.exec, agent: { session: { id: 'other' } } }), /inactive caller/)
  f.close()
  await assert.rejects(f.call('rp_team_read_context', { source: 'hidden_state' }), /inactive caller/)
  f.stop(); f.stopState()
  assert.equal(f.tools.size, 0)
})

test('state removal uses CAS, records before values, rolls back and restores committed checkpoints', async t => {
  const f = fixture(t)
  const baseline = f.store.committedSnapshot({ conversationId: f.run.conversationId })
  await f.call('rp_team_write_state', { namespace: 'world', path: '/variables/score', value: 2, expectedVersion: 0 })
  await f.call('rp_team_remove_state', { namespace: 'world', path: '/variables/optional', expectedVersion: 0 })
  assert.deepEqual(await f.call('rp_team_read_context', { source: 'hidden_state', path: '/optional' }), { found: false })
  assert.equal(f.events.find(event => event.type === 'state.operation' && event.data.operation === 'remove').data.before, 'remove me')
  assert.equal(f.events.find(event => event.data.operation === 'remove').data.version, 2, 'Trace must record the actual staged version after unrelated writes')
  await assert.rejects(f.call('rp_team_remove_state', { namespace: 'world', path: '/settings/Story', expectedVersion: 0 }), { code: 'RP_TEAM_STATE_DELETE_UNSUPPORTED' })
  f.store.rollback({ ...f.run })
  f.store.begin({ conversationId: 'conversation', runId: 'second', config: f.config })
  assert.equal(f.store.read({ conversationId: 'conversation', runId: 'second', agentId: f.member.id, namespace: 'world', path: '/variables/optional' }).value, 'remove me')
  f.store.remove({ conversationId: 'conversation', runId: 'second', agentId: f.member.id, namespace: 'shared', path: '/facts/optional', expectedVersion: 0 })
  f.store.stage({ conversationId: 'conversation', runId: 'second' })
  f.store.commit({ conversationId: 'conversation', runId: 'second', receipt: { outcome: 'committed', productMessageId: 'body' } })
  assert.equal(f.store.committedSnapshot({ conversationId: 'conversation' }).namespaces.shared.facts.optional, undefined)
  f.store.restoreCommittedSnapshot({ conversationId: 'conversation', snapshot: baseline })
  f.member.outputAuthority.state = false
  await assert.rejects(f.call('rp_team_remove_state', { namespace: 'world', path: '/variables/score', expectedVersion: 0 }), { code: 'RP_TEAM_OUTPUT_FORBIDDEN' })
})

test('attachment metadata does not grant bytes; selected indexes, pagination, binary and cancellation work', async t => {
  const f = fixture(t, [{ type: 'current_input', selector: '/attachments/1/name' }])
  f.run.attachments = [
    { type: 'file', attachment: { bytes: Buffer.from('SECRET_CANARY') } },
    { type: 'file', attachment: { bytes: Buffer.from('a'.repeat(51200) + 'tail') } }
  ]
  assert.deepEqual(selectedAgentAttachments(f.member, f.run.attachments), [])
  await assert.rejects(f.call('rp_team_read_attachment', { index: 1 }), { code: 'RP_TEAM_CONTEXT_FORBIDDEN' })
  f.member.context.sources = [{ type: 'current_input', selector: '/attachments/1' }]
  await assert.rejects(f.call('rp_team_read_attachment', { index: 0 }), { code: 'RP_TEAM_CONTEXT_FORBIDDEN' })
  const first = await f.call('rp_team_read_attachment', { index: 1 })
  assert.equal(first.bytes, 51200); assert.equal(first.nextOffset, 51200)
  assert.equal((await f.call('rp_team_read_attachment', { index: 1, offset: first.nextOffset })).content, 'tail')
  assert.equal((await f.call('rp_team_read_attachment', { index: 1, offset: 999999 })).bytes, 0)
  f.run.attachments[1].attachment.bytes = Buffer.from([65, 0, 66])
  await assert.rejects(f.call('rp_team_read_attachment', { index: 1 }), /binary/)
  await assert.rejects(f.call('rp_team_read_attachment', { index: 1, offset: -1 }), { code: 'RP_TEAM_INVALID_REQUEST' })
  const controller = new AbortController(); controller.abort(new Error('cancelled fixture'))
  await assert.rejects(f.call('rp_team_read_attachment', { index: 1 }, { ...f.exec, signal: controller.signal }), /cancelled fixture/)
})

test('product declarations and guessed names are denied in scheduled and nested scopes', () => {
  for (const scheduled of [true, false]) {
    let guard, accepts, released = 0
    const ctx = { tools: {
      restrictDeclarations: fn => { accepts = fn; return () => released++ },
      guard: fn => { guard = fn; return () => released++ }
    } }
    const member = defaultTeamConfig().agents[0]
    member.capabilities = [{ id: 'native:preset', enabled: true }, { id: 'builtin:variables', enabled: true }]
    member.execution.trustedTools = ['native:preset']
    const stop = restrictMemberTools(ctx, { member, rootGroups: [], productDisabled: new Set(), scheduled })
    for (const name of [...HOST_PRODUCT_TOOLS, 'eleckoi_future_guessed_tool']) {
      assert.equal(accepts({ name }), false)
      assert.match(guard({ name }), /not authorized/)
    }
    assert.equal(accepts({ name: 'custom_preset_tool' }), true)
    assert.equal(guard({ name: 'custom_preset_tool' }), undefined)
    assert.equal(accepts({ name: 'rp_team_read_state' }), scheduled)
    assert.equal(guard({ name: 'rp_team_read_state' }) === undefined, scheduled)
    stop()
    assert.equal(released, 2)
  }
})

test('attachment pages preserve UTF-8 characters and stream cancellation releases the reader', async t => {
  const f = fixture(t, [{ type: 'current_input' }])
  const text = 'a'.repeat(51199) + '中🙂tail'
  f.run.attachments = [{ type: 'file', attachment: { bytes: Buffer.from(text) } }]
  const first = await f.call('rp_team_read_attachment', { index: 0 })
  assert.equal(first.nextOffset, 51199)
  const second = await f.call('rp_team_read_attachment', { index: 0, offset: first.nextOffset })
  assert.equal(first.content + second.content, text)
  await assert.rejects(f.call('rp_team_read_attachment', { index: 0, offset: 51200 }), { code: 'RP_TEAM_INVALID_REQUEST' })
  f.run.attachments[0].attachment.bytes = Buffer.from([255, 254, 65])
  await assert.rejects(f.call('rp_team_read_attachment', { index: 0 }), { code: 'RP_TEAM_INVALID_REQUEST' })
  f.stop()
  const controller = new AbortController()
  let released = false
  const stop = registerContextTools({ ...f.args, attachments: { async *readFileStream() {
    try { yield Buffer.from('first'); controller.abort(new Error('cancel while reading')); yield Buffer.from('second') }
    finally { released = true }
  } } })
  t.after(stop)
  await assert.rejects(f.call('rp_team_read_attachment', { index: 0 }, { ...f.exec, signal: controller.signal }), /cancel while reading/)
  assert.equal(released, true)
})

test('legacy capability selections survive configuration export without granting product tools', () => {
  const config = defaultTeamConfig()
  config.agents[0].capabilities = [{ id: 'builtin:variables', enabled: true }, { id: 'builtin:setting-library', enabled: true }]
  assert.deepEqual(parsePreset(exportPreset(normalizeTeamConfig(config))).agents[0].capabilities, config.agents[0].capabilities)
})
