// Offline UI fixtures. No model is called; every run, token count and event below is
// hand-written sample data shaped like the Remote DTOs in src/host/remote-types.ts.
import { createAgent, examplePresets, normalizeTeamConfig } from '../shared/schema.mjs'

export const OPTIONS = {
  revision: 1,
  providers: [
    { id: 'local-fixture', name: 'Local fixture', models: [
      { id: 'observer', name: 'Fixture observer', reasoning: { efforts: [] }, parameters: { temperature: true, topP: true, maxTokens: true, reasoningEffort: false } },
      { id: 'actor', name: 'Fixture actor', reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }], defaultEffort: 'low' }, parameters: { temperature: true, topP: true, maxTokens: true, reasoningEffort: true } }
    ] }
  ],
  presets: [{ id: 'preset-narrator', name: '叙事者预设' }, { id: 'preset-broken', name: '损坏的预设', broken: 'missing manifest' }],
  capabilities: [
    { id: 'builtin:variables', label: 'Variables', groupId: 'builtin:variables', enabledByDefault: false, requiresTrust: false },
    { id: 'builtin:setting-library', label: 'Setting library', groupId: 'builtin:setting-library', enabledByDefault: false, requiresTrust: false },
    { id: 'builtin:roleplay-workflow', label: 'Roleplay workflow', groupId: 'builtin:roleplay-workflow', enabledByDefault: false, requiresTrust: false },
    { id: 'builtin:web', label: 'Web', groupId: 'builtin:web', enabledByDefault: false, requiresTrust: true },
    { id: 'builtin:workspace', label: 'Workspace', groupId: 'builtin:workspace', enabledByDefault: false, requiresTrust: true },
    { id: 'mcp:archive', label: 'MCP archive', groupId: 'mcp:archive', enabledByDefault: false, requiresTrust: true }
  ]
}

/** A second, non-linear topology: parallel senses, a manual member, a conditional member and broken references. */
export function sensesPreset() {
  return normalizeTeamConfig({
    schemaVersion: 2, id: 'parallel-senses', name: '并行感官', version: '0.3.0', metadata: { author: 'fixture' },
    agents: [
      createAgent({
        id: 'sight', name: '视觉', description: '只描述角色此刻能看到的东西。',
        systemPrompt: '列出角色视野中的可见细节，不推测动机。',
        modelRef: { provider: 'local-fixture', model: 'observer' }, parameters: { temperature: 0.4 },
        context: { sources: [{ type: 'current_input' }, { type: 'scene_state', selector: '/scene/visible' }] },
        communication: { sendTo: ['voice'], receiveFrom: [], requestTo: [], requestFrom: [] },
        statePermissions: [{ namespace: 'world', path: '/scene', access: 'read' }],
        capabilities: [{ id: 'builtin:variables', enabled: true }, { id: 'plugin:legacy-lens', enabled: true }]
      }),
      createAgent({
        id: 'hearing', name: '听觉', description: '捕捉声音和语气。',
        modelRef: { provider: 'retired-cloud', model: 'ear-2' },
        context: { sources: [{ type: 'current_input' }, { type: 'recent_history', limit: 6 }] },
        communication: { sendTo: ['voice'], receiveFrom: [], requestTo: [], requestFrom: [] }
      }),
      createAgent({
        id: 'dread', name: '不安感', description: '玩家手动叫入时，放大角色的不安。',
        triggers: [{ type: 'manual' }, { type: 'condition', condition: { op: 'compare', namespace: 'world', path: '/scene/tension', operator: 'gte', value: 3 } }],
        presetId: 'preset-missing',
        statePermissions: [{ namespace: 'world', path: '/scene', access: 'read' }, { namespace: 'shared', path: '/mood', access: 'readwrite' }],
        communication: { sendTo: ['voice'], receiveFrom: [], requestTo: [], requestFrom: ['voice'] },
        outputAuthority: { internal: true, draft: false, state: true, user: false },
        execution: { after: [], onFailure: 'continue', trustedTools: ['mcp:archive'] }
      }),
      createAgent({
        id: 'voice', name: '角色之声', description: '把感官汇总成角色的回复。',
        modelRef: { provider: 'local-fixture', model: 'actor' }, parameters: { reasoningEffort: 'high', maxTokens: 1200 },
        context: { sources: [{ type: 'current_input' }, { type: 'recent_history', limit: 12 }, { type: 'character_card' }, { type: 'agent_messages', agentIds: ['sight', 'hearing'] }] },
        communication: { sendTo: [], receiveFrom: ['sight', 'hearing', 'dread'], requestTo: ['dread'], requestFrom: [] },
        statePermissions: [{ namespace: 'shared', path: '/mood', access: 'read' }],
        execution: { after: ['sight', 'hearing'], onFailure: 'stop', trustedTools: [] },
        outputAuthority: { internal: true, draft: true, state: false, user: true }
      })
    ],
    state: { definitions: [
      { namespace: 'world', path: '/scene', type: 'object', default: { visible: [], tension: 1 }, description: '当前场景' },
      { namespace: 'world', path: '/scene/tension', type: 'number', default: 1, description: '紧张度' },
      { namespace: 'shared', path: '/mood', type: 'string', default: 'calm', description: '团队共享情绪' }
    ] },
    execution: { concurrency: 3, maxActivations: 24, maxPerAgent: 2, maxDepth: 3 },
    output: { agentId: 'voice' }
  })
}

const PERFORMER_PROMPT = `# 你是谁
你就是角色本人。你不是旁白，也不是在“扮演”一个设定；此刻发生的一切都由你亲身经历。称呼对方时使用“{{param:address}}”。

# 你怎样说话
- 用角色自己的口吻回应，句子可以短，可以停顿，可以答非所问。
- 不解释自己的心理活动，除非角色此刻确实会把它说出口。
- 动作、环境和语气写在同一段里，不另起“旁白”。

【生活感】
角色有自己的日程、身体状态和没做完的事。回应之前先想：现在几点、我在哪、手上正拿着什么、刚才在忙什么。这些细节不必全部写出，但回应不能与它们矛盾。

【什么时候去问别人】
一、想不起一件过去的事，而它会影响这次怎么回答：调用“回忆”。
二、对方发来一段长文字、一张图或一个文件，需要先读懂：调用“阅读”。
三、其余情况不要调用任何成员，直接回应。

# 不要做的事
1. 不要替对方说话或决定对方的行动。
2. 不要总结这一轮发生了什么。
3. 不要在正文里提到团队、成员、状态或任何后台机制。

# 输出
只输出角色的回应正文。长度跟随场合：闲聊两三句，认真的话题可以多写，但不超过四段。

# 文风
{{param:style}}
{{param:fixups}}`

/** Shaped like a long-form preset in real use: one voice every round, one keeper on a cycle, two helpers on request. */
export function storyTeam() {
  return normalizeTeamConfig({
    schemaVersion: 2, id: 'situated-sample', name: '有生活感的角色（夹具样例，名称故意写得很长用来检查截断）', version: '1.4.0',
    metadata: { author: 'fixture', description: '一名成员每轮回应，记录员隔轮整理，另外两名只在被调用时出场。' },
    authorParameters: [
      { id: 'address', name: '对用户的称呼', type: 'text', default: '你', bindings: [{ target: { kind: 'agent', agentId: 'performer', path: '/systemPrompt' }, mode: 'text' }] },
      { id: 'style', name: '文风', group: '呈现', type: 'choice', default: 'plain', description: '选中的一档会把对应文字放进角色本人的提示词。', options: [
        { label: '白描短句', value: 'plain', text: '白描为主，句子短，多写动作、物件和原话。' },
        { label: '细描', value: 'detailed', text: '可以写得细一些：环境、动作、物件多写几笔，但不抒情。' }
      ], bindings: [{ target: { kind: 'agent', agentId: 'performer', path: '/systemPrompt' }, mode: 'text' }] },
      { id: 'fixups', name: '为用户的要求找补', group: '裁定', type: 'boolean', default: false,
        textOn: '用户写下做不到的结果时，可以补一个现实可行的条件让它成立。', textOff: '用户写下做不到的结果时，按现实呈现失败或受阻，不找补。',
        bindings: [{ target: { kind: 'agent', agentId: 'performer', path: '/systemPrompt' }, mode: 'text' }] }
    ],
    agents: [
      createAgent({
        id: 'performer', name: '角色本人', description: '每一轮都由它写下角色的回应；需要时去问“回忆”和“阅读”。',
        systemPrompt: PERFORMER_PROMPT,
        modelRef: { provider: 'local-fixture', model: 'actor' }, parameters: { temperature: 0.9, maxTokens: 1600 },
        context: { sources: [{ type: 'current_input' }, { type: 'recent_history', limit: 20 }, { type: 'character_card' }, { type: 'scene_state' }, { type: 'agent_messages', agentIds: ['recall', 'reading'] }] },
        communication: { sendTo: [], receiveFrom: ['recall', 'reading', 'keeper'], requestTo: ['recall', 'reading'], requestFrom: [] },
        statePermissions: [{ namespace: 'shared', path: '/life', access: 'read' }],
        outputAuthority: { internal: true, draft: true, state: false, user: true }
      }),
      createAgent({
        id: 'keeper', name: '生活记录员', description: '每隔一轮整理角色的日程、身体状态和未完成的事。',
        systemPrompt: '# 任务\n读最近的对话，更新角色的生活状态。只写确实发生了变化的字段。\n\n# 不要做的事\n不要写正文，不要评价对话。',
        triggers: [{ type: 'periodic', every: 2, offset: 0 }],
        modelRef: { provider: 'local-fixture', model: 'observer' }, parameters: { temperature: 0.2 },
        context: { sources: [{ type: 'recent_history', limit: 8 }, { type: 'scene_state' }] },
        communication: { sendTo: ['performer'], receiveFrom: [], requestTo: [], requestFrom: [] },
        statePermissions: [{ namespace: 'shared', path: '/life', access: 'readwrite' }],
        outputAuthority: { internal: true, draft: false, state: true, user: false },
        execution: { after: ['performer'], onFailure: 'continue', trustedTools: [] }
      }),
      createAgent({
        id: 'reading', name: '阅读', description: '角色本人需要读懂长文字、图片或文件时调用。',
        systemPrompt: '把收到的材料读完，用三句话以内告诉角色本人：它说了什么、哪里值得注意。',
        triggers: [{ type: 'requested_by_agent', from: ['performer'] }],
        modelRef: { provider: 'local-fixture', model: 'observer' },
        context: { sources: [{ type: 'current_input' }] },
        communication: { sendTo: ['performer'], receiveFrom: [], requestTo: [], requestFrom: ['performer'] },
        outputAuthority: { internal: true, draft: false, state: false, user: false }
      }),
      createAgent({
        id: 'recall', name: '回忆', description: '角色本人想不起过去的事时调用。',
        systemPrompt: '在长期记忆里找与问题有关的片段，原样带回，不要补写没有发生过的事。',
        triggers: [{ type: 'requested_by_agent', from: ['performer'] }],
        context: { sources: [{ type: 'long_memory' }, { type: 'full_history' }] },
        communication: { sendTo: ['performer'], receiveFrom: [], requestTo: [], requestFrom: ['performer'] },
        outputAuthority: { internal: true, draft: false, state: false, user: false }
      })
    ],
    state: { definitions: [
      { namespace: 'shared', path: '/life', type: 'object', default: { place: '家里', doing: '收拾桌子', unfinished: [] }, description: '生活状态：角色此刻在哪、在做什么、还有什么没做完' }
    ] },
    execution: { concurrency: 2, maxActivations: 12, maxPerAgent: 2, maxDepth: 2 },
    output: { agentId: 'performer' }
  })
}

/** `turn` is the number of the latest user message; history holds the rounds before it. */
export function initialConversations() {
  return {
    'preview-c-1': { enabled: true, revision: 3, config: examplePresets()[1], manualAgentIds: [], turn: 3 },
    'preview-c-2': { enabled: true, revision: 8, config: sensesPreset(), manualAgentIds: ['dread'], turn: 3 },
    'preview-c-3': { enabled: true, revision: 5, config: storyTeam(), parameterValues: {}, manualAgentIds: [], turn: 2 }
  }
}

const at = (minute, second = 0) => `2026-10-04T09:${String(minute).padStart(2, '0')}:${String(second).padStart(2, '0')}.000Z`
const tokens = (input, output) => ({ inputTokens: input, outputTokens: output, totalTokens: input + output })
const modelOf = agent => ({ provider: 'local-fixture', model: agent.modelRef === 'inherit' ? 'actor' : agent.modelRef.model })

/**
 * Who starts in a round, mirroring the host rules the UI explains: `always` and a matching
 * `periodic` trigger start a member; from the second round on, the first starter calls one
 * member that accepts its requests, as a sample of a mid-round request.
 */
export function castFor(config, turn) {
  const cast = []
  for (const agent of config.agents) {
    const types = agent.triggers.filter(trigger => trigger.type === 'always'
      || trigger.type === 'periodic' && turn >= (trigger.offset ?? 0) && (turn - (trigger.offset ?? 0)) % trigger.every === 0).map(trigger => trigger.type)
    if (types.length) cast.push({ agent, reason: { type: 'initial', triggers: [...new Set(types)] } })
  }
  const caller = cast[0]?.agent
  const callee = caller && turn > 1 ? config.agents.find(agent => !cast.some(item => item.agent === agent)
    && agent.triggers.some(trigger => trigger.type === 'requested_by_agent' && (!trigger.from?.length || trigger.from.includes(caller.id)))) : null
  if (callee) cast.splice(1, 0, { agent: callee, reason: { type: 'requested_by_agent' }, requestedBy: caller.id })
  return cast
}

const FAILURE = 'Fixture provider returned HTTP 503 (local sample, no request sent).'

function statusesFor(cast, scenario) {
  const ids = cast.map(item => item.agent.id)
  const second = ids.length > 1 ? 1 : 0
  const upTo = (index, last) => Object.fromEntries(ids.map((id, position) => [id, position < index ? 'complete' : position === index ? last : 'pending']))
  if (scenario === 'working') return { ...upTo(second, 'running'), ...Object.fromEntries(ids.slice(second + 1).map(id => [id, 'queued'])) }
  if (scenario === 'failed') return upTo(second, 'failed')
  if (scenario === 'cancelled') return upTo(second, 'cancelled')
  return Object.fromEntries(ids.map(id => [id, 'complete']))
}

function membersFor(config, statuses) {
  return Object.fromEntries(config.agents.map(agent => {
    const status = statuses[agent.id] || 'pending'
    const ran = !['pending', 'queued'].includes(status)
    return [agent.id, {
      id: agent.id, name: agent.name, status, result: status === 'complete' ? { summary: `${agent.name}：已交付一条内部结果。` } : null,
      ...(status === 'failed' ? { error: FAILURE } : {}),
      ...(ran && status !== 'cancelled' ? { model: modelOf(agent), activations: 1 } : {}),
      ...(status === 'complete' ? { tokens: tokens(820 + agent.id.length * 13, 140 + agent.id.length * 7) } : {})
    }]
  }))
}

function eventsFor(config, cast, statuses, phase, turn) {
  const publisher = config.output.agentId
  const events = [{ type: 'run.started', at: at(1, 0), data: { status: 'working', turn } }]
  let second = 1
  for (const [position, { agent, reason, requestedBy }] of cast.entries()) {
    const status = statuses[agent.id]
    if (!status || status === 'pending') continue
    const tick = () => at(1, second++)
    if (requestedBy) events.push({ type: 'message.requested', agentId: requestedBy, at: tick(), data: { id: `q-${agent.id}`, from: requestedBy, to: agent.id, body: '上次说到那封信，是谁送来的？' } })
    events.push({ type: 'activation.queued', agentId: agent.id, at: tick(), data: { reason, depth: requestedBy ? 1 : 0, ...(requestedBy ? { requestedBy } : {}) } })
    if (status === 'queued') continue
    events.push(
      { type: 'activation.started', agentId: agent.id, at: tick(), data: { reason, depth: requestedBy ? 1 : 0, activation: 1, model: modelOf(agent) } },
      { type: 'context.selected', agentId: agent.id, at: tick(), data: { categories: agent.context.sources.map(source => source.type) } }
    )
    if (status === 'failed') { events.push({ type: 'activation.failed', agentId: agent.id, at: tick(), data: { activation: 1, error: FAILURE } }); continue }
    if (status !== 'complete') continue
    const receiver = requestedBy || agent.communication.sendTo[0]
    if (receiver) events.push({ type: 'message.sent', agentId: agent.id, at: tick(), data: { id: `m-${position}`, from: agent.id, to: receiver, body: '门口那人的伞还在滴水，鞋上却没有泥。' } })
    if (agent.statePermissions.some(rule => /write/.test(rule.access)) && ['awaiting_commit', 'complete'].includes(phase)) {
      events.push({ type: 'state.operation', agentId: agent.id, at: tick(), data: { namespace: 'shared', path: agent.statePermissions.find(rule => /write/.test(rule.access)).path, operation: 'set', version: 2 } })
    }
    events.push(
      { type: 'model.usage', agentId: agent.id, at: tick(), data: { ...modelOf(agent), inputTokens: 820 + agent.id.length * 13, outputTokens: 140 + agent.id.length * 7, totalTokens: 960 + agent.id.length * 20 } },
      { type: 'activation.completed', agentId: agent.id, at: tick(), data: { activation: 1 } }
    )
  }
  if (phase === 'cancelled') events.push({ type: 'run.cancelled', at: at(1, second++), data: { reason: 'Cancelled from RP Team controls' } })
  if (['awaiting_commit', 'complete'].includes(phase)) {
    events.push(
      { type: 'publication.candidate', agentId: publisher, at: at(1, second++), data: { status: 'candidate', bodyCharacters: 96 } },
      { type: 'publication.awaiting_commit', at: at(1, second++), data: { status: 'awaiting_commit' } }
    )
  }
  if (phase === 'complete') events.push({ type: 'publication.committed', at: at(1, second++), data: { status: 'committed', operationCount: 1, productMessageId: 'msg-assistant-1' } })
  return events.map((event, index) => ({ seq: index + 1, ...event }))
}

/** One native execution session per started member, as the host reports them for the ledger. */
function executionsFor(runId, events) {
  const sessions = new Map()
  for (const event of events) {
    if (event.type === 'activation.started') sessions.set(event.agentId, { executionId: `${runId}:${event.agentId}:1`, agentId: event.agentId, activation: 1, sessionId: `exec-${runId}-${event.agentId}`, scheduled: true, startedAt: event.at, status: 'running' })
    const session = sessions.get(event.agentId)
    if (session && /^activation\.(completed|failed)$/.test(event.type)) Object.assign(session, { endedAt: event.at, status: event.type.endsWith('failed') ? 'failed' : 'complete', endEventSeq: event.seq })
  }
  return [...sessions.values()]
}

const BODY = '她没有立刻开门。雨声里，门外那人的呼吸很轻，像是在数她的脚步。\n\n“信在柜子里，”她说，“但你得先告诉我，是谁让你来的。”'

/** Builds the run of one round for a scenario. Returns null for the idle scenario. */
export function scenarioRun(conversationId, config, scenario, runId = `${conversationId}-run-live`, turn = 3) {
  if (!scenario || scenario === 'none') return null
  const cast = castFor(config, turn)
  const statuses = statusesFor(cast, scenario)
  const publisher = config.output.agentId
  const stopper = cast.find(item => ['failed', 'cancelled'].includes(statuses[item.agent.id]))?.agent
  const events = eventsFor(config, cast, statuses, scenario, turn)
  const run = {
    runId, conversationId, phase: scenario, turn, startedAt: at(1), createdAt: at(1), updatedAt: at(1, 30),
    outputAgentId: publisher, members: membersFor(config, statuses),
    publication: ['awaiting_commit', 'complete'].includes(scenario)
      ? { runId, agentId: publisher, body: BODY, status: scenario === 'complete' ? 'committed' : 'awaiting_commit', operationCount: 1, selectedDraftIds: [], stagedAt: at(1, 20) }
      : null,
    productCommitStaged: scenario === 'complete',
    retryAvailable: scenario === 'failed' || scenario === 'cancelled',
    ...(scenario === 'complete' ? { productMessageId: 'msg-assistant-1' } : {}),
    ...(scenario === 'awaiting_commit' ? { assistantMessageId: 'native-assistant-1' } : {}),
    ...(scenario === 'failed' ? { failure: `${stopper.name} failed and its failure policy stopped the turn: Fixture provider returned HTTP 503.` } : {}),
    ...(scenario === 'cancelled' ? { failure: 'Cancelled from RP Team controls' } : {})
  }
  return { run, events, configuration: config, executionSessions: executionsFor(runId, events) }
}

/** The rounds before the live one. With three rounds the middle one was cancelled. */
export function historicalRuns(conversationId, config, turn = 3) {
  // Every timestamp of a sample run sits in minute 09:01; earlier rounds move to the evening before.
  const moved = (sample, minute) => JSON.parse(JSON.stringify(sample).replaceAll('2026-10-04T09:01:', `2026-10-03T21:${minute}:`))
  const first = moved(scenarioRun(conversationId, config, 'complete', `${conversationId}-run-older`, 1), 14)
  first.run.productMessageId = 'msg-assistant-0'
  if (turn < 3) return [first]
  const cancelled = moved(scenarioRun(conversationId, config, 'cancelled', `${conversationId}-run-cancelled`, 2), 30)
  cancelled.run.retryAvailable = true
  return [first, cancelled]
}
