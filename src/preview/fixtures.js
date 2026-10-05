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

export function initialConversations() {
  return {
    'preview-c-1': { enabled: true, revision: 3, config: examplePresets()[1], manualAgentIds: [] },
    'preview-c-2': { enabled: true, revision: 8, config: sensesPreset(), manualAgentIds: ['dread'] }
  }
}

const at = (minute, second = 0) => `2026-10-04T09:${String(minute).padStart(2, '0')}:${String(second).padStart(2, '0')}.000Z`
const tokens = (input, output) => ({ inputTokens: input, outputTokens: output, totalTokens: input + output })

function membersFor(config, statuses) {
  return Object.fromEntries(config.agents.map(agent => {
    const status = statuses[agent.id] || 'pending'
    const ran = !['pending', 'queued'].includes(status)
    return [agent.id, {
      id: agent.id, name: agent.name, status, result: status === 'complete' ? { summary: `${agent.name}：已交付一条内部结果。` } : null,
      ...(status === 'failed' ? { error: 'Fixture provider returned HTTP 503 (local sample, no request sent).' } : {}),
      ...(ran && status !== 'cancelled' ? { model: { provider: 'local-fixture', model: agent.modelRef === 'inherit' ? 'actor' : agent.modelRef.model }, activations: 1 } : {}),
      ...(status === 'complete' ? { tokens: tokens(820 + agent.id.length * 13, 140 + agent.id.length * 7) } : {})
    }]
  }))
}

function eventsFor(config, phase) {
  const [first, second] = config.agents
  const publisher = config.output.agentId
  const events = [
    { type: 'run.started', at: at(1, 0), data: { status: 'working' } },
    { type: 'activation.queued', agentId: first.id, at: at(1, 1), data: { reason: { type: 'always', detail: 'every turn' }, depth: 0 } },
    { type: 'activation.started', agentId: first.id, at: at(1, 2), data: { reason: { type: 'always' }, depth: 0, activation: 1, model: { provider: 'local-fixture', model: 'observer' } } },
    { type: 'context.selected', agentId: first.id, at: at(1, 2), data: { categories: first.context.sources.map(source => source.type) } },
    { type: 'message.sent', agentId: first.id, at: at(1, 9), data: { id: 'm-1', from: first.id, to: second.id, body: '门口那人的伞还在滴水，鞋上却没有泥。' } },
    { type: 'model.usage', agentId: first.id, at: at(1, 10), data: { provider: 'local-fixture', model: 'observer', inputTokens: 844, outputTokens: 172, totalTokens: 1016 } },
    { type: 'activation.completed', agentId: first.id, at: at(1, 10), data: { activation: 1 } }
  ]
  if (phase === 'failed') {
    events.push({ type: 'activation.failed', agentId: second.id, at: at(1, 14), data: { activation: 1, error: 'Fixture provider returned HTTP 503 (local sample, no request sent).' } })
  }
  if (phase === 'cancelled') events.push({ type: 'run.cancelled', at: at(1, 12), data: { reason: 'Cancelled from RP Team controls' } })
  if (['awaiting_commit', 'complete'].includes(phase)) {
    events.push(
      { type: 'state.operation', agentId: first.id, at: at(1, 11), data: { namespace: 'shared', path: '/observations/agent-1', operation: 'set', version: 2 } },
      { type: 'publication.candidate', agentId: publisher, at: at(1, 20), data: { status: 'candidate', bodyCharacters: 96 } },
      { type: 'publication.awaiting_commit', at: at(1, 21), data: { status: 'awaiting_commit' } }
    )
  }
  if (phase === 'complete') events.push({ type: 'publication.committed', at: at(1, 22), data: { status: 'committed', operationCount: 1, productMessageId: 'msg-assistant-1' } })
  return events.map((event, index) => ({ seq: index + 1, ...event }))
}

const BODY = '她没有立刻开门。雨声里，门外那人的呼吸很轻，像是在数她的脚步。\n\n“信在柜子里，”她说，“但你得先告诉我，是谁让你来的。”'

/** Builds the current run for a scenario. Returns null for the idle scenario. */
export function scenarioRun(conversationId, config, scenario, runId = `${conversationId}-run-live`) {
  if (!scenario || scenario === 'none') return null
  const [a, b, ...rest] = config.agents.map(agent => agent.id)
  const publisher = config.output.agentId
  const statuses = {
    working: { [a]: 'complete', [b]: 'running' },
    awaiting_commit: Object.fromEntries(config.agents.map(agent => [agent.id, 'complete'])),
    complete: Object.fromEntries(config.agents.map(agent => [agent.id, 'complete'])),
    failed: { [a]: 'complete', [b]: 'failed' },
    cancelled: { [a]: 'complete', [b]: 'cancelled' }
  }[scenario]
  if (scenario === 'awaiting_commit' || scenario === 'complete') for (const id of rest) if (!config.agents.find(agent => agent.id === id).triggers.some(trigger => trigger.type === 'always')) statuses[id] = 'pending'
  const run = {
    runId, conversationId, phase: scenario, startedAt: at(1), createdAt: at(1), updatedAt: at(1, 30),
    outputAgentId: publisher, members: membersFor(config, statuses),
    publication: ['awaiting_commit', 'complete'].includes(scenario)
      ? { runId, agentId: publisher, body: BODY, status: scenario === 'complete' ? 'committed' : 'awaiting_commit', operationCount: 1, selectedDraftIds: [], stagedAt: at(1, 20) }
      : null,
    productCommitStaged: scenario === 'complete',
    retryAvailable: scenario === 'failed' || scenario === 'cancelled',
    ...(scenario === 'complete' ? { productMessageId: 'msg-assistant-1' } : {}),
    ...(scenario === 'awaiting_commit' ? { assistantMessageId: 'native-assistant-1' } : {}),
    ...(scenario === 'failed' ? { failure: `${config.agents[1].name} failed and its failure policy stopped the turn: Fixture provider returned HTTP 503.` } : {}),
    ...(scenario === 'cancelled' ? { failure: 'Cancelled from RP Team controls' } : {})
  }
  return { run, events: eventsFor(config, scenario) }
}

export function historicalRuns(conversationId, config) {
  const older = scenarioRun(conversationId, config, 'complete', `${conversationId}-run-older`)
  older.run.startedAt = older.run.createdAt = '2026-10-03T21:14:00.000Z'
  older.run.productMessageId = 'msg-assistant-0'
  const cancelled = scenarioRun(conversationId, config, 'cancelled', `${conversationId}-run-cancelled`)
  cancelled.run.startedAt = cancelled.run.createdAt = '2026-10-03T21:30:00.000Z'
  cancelled.run.retryAvailable = true
  return [older, cancelled]
}
