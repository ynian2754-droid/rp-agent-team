import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createAgent, examplePresets, normalizeTeamConfig } from '../src/shared/schema.mjs'
import { setLocale } from '../src/client/i18n.js'
import { PAGES, resolvePage } from '../src/client/client-state.js'
import { activationCause, compactNumber, formatElapsed, idleReasons, memberActivity, participants, runTotals } from '../src/client/run-model.js'
import { causeText, forecast, idleReasonText, triggerSummary } from '../src/client/explain.js'
import { createDraftState, draftChanges, tabForSection, teamViewForField, sectionForField } from '../src/client/draft-state.js'
import { promptOutline, promptParameters } from '../src/client/prompt-outline.js'

const locales = Object.fromEntries(await Promise.all(['zh', 'en'].map(async name => [name, JSON.parse(await readFile(new URL(`../locale/${name}.json`, import.meta.url), 'utf8'))])))
setLocale(locales, 'zh-CN')

/** One voice every round, a keeper every second round, two helpers on request. */
function storyTeam() {
  return normalizeTeamConfig({
    schemaVersion: 2, id: 'story', name: 'Story', version: '1.0.0',
    agents: [
      createAgent({ id: 'performer', name: '角色本人', communication: { sendTo: [], receiveFrom: ['recall', 'keeper'], requestTo: ['recall'], requestFrom: [] }, outputAuthority: { internal: true, draft: true, state: false, user: true } }),
      createAgent({ id: 'keeper', name: '记录员', triggers: [{ type: 'periodic', every: 2, offset: 0 }], communication: { sendTo: ['performer'], receiveFrom: [], requestTo: [], requestFrom: [] }, execution: { after: ['performer'], onFailure: 'continue', trustedTools: [] } }),
      createAgent({ id: 'recall', name: '回忆', triggers: [{ type: 'requested_by_agent', from: ['performer'] }], communication: { sendTo: ['performer'], receiveFrom: [], requestTo: [], requestFrom: ['performer'] } })
    ],
    output: { agentId: 'performer' }
  })
}

test('page names from before the regrouping still open the matching page and sub-view', () => {
  assert.deepEqual(PAGES, ['run', 'team', 'presets', 'trial', 'state'])
  assert.deepEqual(resolvePage('team'), ['team', {}])
  assert.deepEqual(resolvePage('config'), ['team', { teamView: 'members' }])
  assert.deepEqual(resolvePage('preview'), ['trial', { trialView: 'check' }])
  assert.deepEqual(resolvePage('library'), ['presets', {}])
  assert.deepEqual(resolvePage('unknown'), ['run', {}])
})

test('a round counts the members that were activated, not the size of the team', () => {
  const run = { startedAt: '2026-10-04T09:00:00Z', updatedAt: '2026-10-04T09:00:12Z', members: {
    performer: { id: 'performer', status: 'complete', tokens: { inputTokens: 900, outputTokens: 100, totalTokens: 1000 } },
    keeper: { id: 'keeper', status: 'pending' }, recall: { id: 'recall', status: 'queued' }
  } }
  assert.deepEqual(participants(run).map(member => member.id), ['performer'])
  const totals = runTotals(run, [{ type: 'model.usage', agentId: 'performer' }, { type: 'activation.started', agentId: 'performer' }])
  assert.deepEqual(totals, { tokens: 1000, tokensKnown: true, requests: 1, elapsedMs: 12000 })
  assert.equal(runTotals({ members: { a: { status: 'failed' } } }).tokensKnown, false, 'a member without reported usage makes the total a lower bound')
  assert.equal(runTotals({ members: {} }).elapsedMs, null)
})

test('a member that stayed out is explained by its own trigger rules', () => {
  const config = storyTeam()
  const [, keeper, recall] = config.agents
  assert.deepEqual(idleReasons(keeper), [{ code: 'periodic', every: 2 }])
  assert.deepEqual(idleReasons(recall), [{ code: 'onRequest', from: ['performer'] }])
  assert.deepEqual(idleReasons({ triggers: [] }), [{ code: 'noTrigger' }])
  assert.equal(idleReasonText(idleReasons(keeper)[0], config), '每 2 轮运行一次，本轮不在周期上')
  assert.equal(idleReasonText(idleReasons(recall)[0], config), '只在 角色本人 调用时运行，本轮没有被调用')
  assert.equal(triggerSummary(keeper, config), '每 2 轮；等待 角色本人')
  assert.equal(triggerSummary(recall, config), '被 角色本人 调用时')
})

test('an activated member reports whether a trigger or another member brought it in', () => {
  const config = storyTeam()
  const events = [
    { type: 'activation.queued', agentId: 'performer', data: { reason: { type: 'initial', triggers: ['always'] }, depth: 0 } },
    { type: 'activation.queued', agentId: 'keeper', data: { reason: { type: 'initial', triggers: ['periodic'] }, depth: 0 } },
    { type: 'message.requested', agentId: 'performer', data: { to: 'recall' } },
    { type: 'activation.queued', agentId: 'recall', data: { reason: { type: 'requested_by_agent' }, depth: 1, requestedBy: 'performer' } },
    { type: 'model.usage', agentId: 'recall', data: {} },
    { type: 'message.sent', agentId: 'recall', data: { to: ['performer'] } },
    { type: 'state.operation', agentId: 'keeper', data: { operation: 'set' } },
    { type: 'state.operation', agentId: 'keeper', data: { operation: 'read' } }
  ]
  assert.deepEqual(activationCause(events, 'performer'), { type: 'trigger', triggers: ['always'] })
  assert.deepEqual(activationCause(events, 'recall'), { type: 'request', by: 'performer' })
  assert.equal(activationCause(events, 'nobody'), null)
  assert.equal(causeText(activationCause(events, 'keeper'), config, config.agents[1]), '每 2 轮', 'the cadence is worded like the member list')
  assert.equal(causeText(activationCause(events, 'recall'), config, config.agents[2]), '由 角色本人 调用')
  assert.deepEqual(memberActivity(events, 'performer'), { requests: 0, asked: ['recall'], told: [], writes: 0, failures: [] })
  assert.deepEqual(memberActivity(events, 'recall'), { requests: 1, asked: [], told: ['performer'], writes: 0, failures: [] })
  assert.equal(memberActivity(events, 'keeper').writes, 1, 'reads are not counted as writes')
})

test('the forecast folds host trigger checks into one answer per member', () => {
  const config = storyTeam()
  const run = forecast({ triggered: true, triggerChecks: [{ type: 'periodic', outcome: 'run', every: 2, offset: 0, ordinal: 2 }] }, config)
  assert.deepEqual(run, { kind: 'run', lines: ['每 2 轮一次，第 2 轮正好轮到'] })
  const skip = forecast({ triggered: false, triggerChecks: [{ type: 'periodic', outcome: 'skip', every: 2, offset: 0, ordinal: 3 }] }, config)
  assert.deepEqual(skip, { kind: 'skip', lines: ['每 2 轮一次，第 3 轮不在周期上'] })
  const request = forecast({ triggered: false, triggerChecks: [{ type: 'requested_by_agent', outcome: 'on_request', from: ['performer'] }] }, config)
  assert.deepEqual(request, { kind: 'request', lines: ['角色本人 调用它时才运行'] })
  assert.equal(forecast({ triggered: false, triggerChecks: [{ type: 'keyword', outcome: 'skip' }] }, config).kind, 'depends', 'a keyword depends on the message that has not been written yet')
  assert.equal(forecast({ triggered: false, triggerChecks: [{ type: 'condition', outcome: 'unknown' }, { type: 'manual', outcome: 'skip' }] }, config).kind, 'depends')
  assert.equal(forecast({ triggered: true, triggerChecks: [{ type: 'manual', outcome: 'skip' }, { type: 'always', outcome: 'run' }] }, config).kind, 'run')
  assert.deepEqual(forecast({ triggered: false, triggerChecks: [] }, config), { kind: 'never', lines: [] })
})

test('draft changes are grouped by member, team settings and parameters', () => {
  const saved = { config: examplePresets()[1], parameterValues: {}, revision: 1, enabled: true }
  const state = createDraftState(saved, {})
  assert.deepEqual(draftChanges(state, saved), { members: [], removed: [], team: false, params: false, count: 0 })
  const [first, second, ...others] = saved.config.agents
  const added = createAgent({ id: 'extra', name: 'Extra' })
  const draft = { ...saved.config, name: 'Renamed', agents: [{ ...first, name: 'Changed' }, ...others, added] }
  const changes = draftChanges({ ...state, draft, dirty: true, parameterValues: { tone: 'calm' } }, saved)
  assert.deepEqual(changes.members, [{ id: first.id, name: 'Changed', kind: 'changed' }, { id: 'extra', name: 'Extra', kind: 'added' }])
  assert.deepEqual(changes.removed, [second.name])
  assert.equal(changes.team, true)
  assert.equal(changes.params, true)
  assert.equal(changes.count, 5)
  const onlyParameters = draftChanges({ ...state, dirty: true, draft: { ...saved.config, authorParameters: [{ id: 'tone', name: 'Tone', type: 'text', bindings: [] }] } }, saved)
  assert.deepEqual([onlyParameters.team, onlyParameters.params, onlyParameters.count], [false, true, 1], 'parameter definitions belong to the parameter page')
})

test('a field that needs fixing leads to the tab that holds it', () => {
  assert.equal(tabForSection(sectionForField('parameters')), 'model')
  assert.equal(tabForSection(sectionForField('condition-0')), 'trigger')
  assert.equal(tabForSection(sectionForField('handoff-1-requestSchema')), 'links')
  assert.equal(tabForSection(sectionForField('statePermissions')), 'access')
  assert.equal(tabForSection(sectionForField('capabilities')), 'access')
  assert.equal(tabForSection('something-else'), 'prompt')
  assert.equal(teamViewForField('param-values'), 'params')
  assert.equal(teamViewForField('definitions'), 'settings')
})

test('the prompt outline reads the headings an author already wrote', () => {
  const text = '# 你是谁\n正文一行。\n\n【生活感】\n一、想不起来的时候：调用回忆。\n这一行不是标题，虽然它提到了 # 号。\n## 输出：'
  assert.deepEqual(promptOutline(text), [
    { offset: 0, label: '你是谁' },
    { offset: text.indexOf('【生活感】'), label: '【生活感】' },
    { offset: text.indexOf('一、'), label: '一、想不起来的时候：调用回忆。' },
    { offset: text.indexOf('## 输出'), label: '输出' }
  ])
  assert.deepEqual(promptOutline(''), [])
  assert.equal(promptOutline(Array.from({ length: 30 }, (_, index) => `# 第 ${index} 节`).join('\n')).length, 14)
  assert.deepEqual(promptParameters('称呼 {{param:address}}，语气 {{param:tone}}，再次 {{param:address}}'), ['address', 'tone'])
})

test('durations and token counts stay exact when small and compact when large', () => {
  assert.equal(compactNumber(980), '980')
  assert.equal(compactNumber(1140), '1.1k')
  assert.equal(compactNumber(4000), '4k')
  assert.equal(compactNumber(128000), '128k')
  assert.equal(compactNumber(undefined), '')
  assert.equal(formatElapsed(420), '420ms')
  assert.equal(formatElapsed(2000), '2.0s')
  assert.equal(formatElapsed(30000), '30s')
  assert.equal(formatElapsed(95000), '1m35s')
})

test('cause text names condition and retry starts instead of showing raw keys', () => {
  const config = storyTeam()
  const member = { ...config.agents[0], triggers: [{ type: 'always' }, { type: 'condition', condition: { op: 'exists', namespace: 'shared', path: '/x' } }] }
  const condition = causeText({ type: 'trigger', triggers: ['condition:1'] }, config, member)
  const retry = causeText({ type: 'trigger', triggers: ['retry'] }, config, member)
  for (const text of [condition, retry]) assert.doesNotMatch(text, /triggerShort\.|cause\.|condition:/)
  assert.equal(retry, '重试时重新运行')
  assert.equal(causeText({ type: 'trigger', triggers: ['condition:0'] }, config, { ...member, triggers: [] }), '满足条件时',
    'without the member a known type still reads as its short label')
})

test('removing the only allowed sender drops a request trigger instead of opening it to every member', async () => {
  const { removeAgent } = await import('../src/client/editor-model.js')
  const base = storyTeam()
  const [first, second] = base.agents
  const config = { ...base, agents: base.agents.map(agent => agent.id === second.id
    ? { ...agent, triggers: [{ type: 'requested_by_agent', from: [first.id] }, { type: 'periodic', every: 2, offset: 0 }] } : agent) }
  const next = removeAgent(config, first.id)
  const kept = next.agents.find(agent => agent.id === second.id)
  assert.deepEqual(kept.triggers.map(trigger => trigger.type), ['periodic'])
  assert.ok(!kept.triggers.some(trigger => Array.isArray(trigger.from) && trigger.from.length === 0))
})
test('a member cooling down is forecast as skipped with the turn it can return', () => {
  const result = forecast({ triggered: false, triggerChecks: [{ type: 'always', outcome: 'cooldown', availableAt: 5 }] }, storyTeam())
  assert.equal(result.kind, 'skip')
  assert.deepEqual(result.lines, ['冷却中，第 5 轮起才会再次触发'])
})