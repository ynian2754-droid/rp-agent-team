import test from 'node:test'
import assert from 'node:assert/strict'
import { examplePresets, normalizeTeamConfig, createAgent } from '../src/shared/schema.mjs'
import { createKeyedStore } from '../src/client/keyed-store.js'
import {
  createDraftState, editMember, editConfig, invalidEntries, markSaved, replaceDraft, resolveConflict,
  sectionForField, setRawJson, syncRemote
} from '../src/client/draft-state.js'
import {
  communicationGaps, manualMembers, setStateAccess, clearStateRule, toggleAllowlist, toggleSource, toggleTrigger,
  toggleTrustedTool, unsupportedParameters, updateSource, selectPublisher,
  addSource, removeSource, sourceRowKeys, incompleteSource
} from '../src/client/editor-model.js'
import { conditionProblem, memberIssues, modelInfo, stateCounts, triggerTypes } from '../src/client/summaries.js'
import { createConversationStore } from '../src/client/store.js'

const asymmetric = () => examplePresets()[1]
const generic = () => examplePresets()[0]
const dto = (config, revision) => ({ config, revision, enabled: true })

test('clearing mounted editor buffers notifies each original key once when subscribers recreate snapshots', () => {
  const buffers = createKeyedStore(() => null)
  buffers.update('A/field', { text: 'old' })
  let notices = 0
  buffers.subscribe('A/field', () => {
    assert.ok(++notices <= 1)
    assert.equal(buffers.get('A/field'), null)
  })
  buffers.removeWhere(key => key.startsWith('A/'))
  assert.equal(notices, 1)
})

test('drafts stay isolated per conversation and survive closing the workspace', () => {
  const drafts = createKeyedStore(() => null)
  drafts.update('A', () => createDraftState(dto(asymmetric(), 4)))
  drafts.update('B', () => createDraftState(dto(generic(), 9)))
  const memberA = drafts.get('A').draft.agents[0].id
  drafts.update('A', state => editMember(state, memberA, { name: 'Only in A' }))
  drafts.update('A', state => setRawJson(state, `${memberA}:parameters`, '{"temperature": ', true))

  // A retained or reopened body reads the same keyed state.
  const reopened = drafts.get('A')
  assert.equal(reopened.draft.agents[0].name, 'Only in A')
  assert.equal(reopened.rawJson[`${memberA}:parameters`], '{"temperature": ')
  assert.equal(reopened.baseRevision, 4)
  assert.equal(drafts.get('B').dirty, false)
  assert.equal(drafts.get('B').baseRevision, 9)
  assert.ok(drafts.get('B').draft.agents.every(agent => agent.name !== 'Only in A'))
})

test('saving a draft uses the revision it started from, not a later refreshed revision', async () => {
  const saves = []
  const store = createConversationStore({
    async getConfig() { return { enabled: true, revision: 7, config: asymmetric() } },
    async saveConfig(conversationId, expectedRevision, enabled, config) { saves.push(expectedRevision); return { enabled, revision: expectedRevision + 1, config } }
  })
  await store.refreshConfig('A')
  const draft = createDraftState(dto(asymmetric(), 5))
  await store.save('A', true, draft.draft, draft.baseRevision)
  assert.deepEqual(saves, [5])
})

test('remote updates replace clean drafts, rebase unchanged content and flag real conflicts', () => {
  const base = asymmetric()
  const clean = createDraftState(dto(base, 1))
  const renamed = { ...base, name: 'Renamed elsewhere' }
  assert.equal(syncRemote(clean, dto(renamed, 2)).draft.name, 'Renamed elsewhere')

  const dirty = editConfig(clean, { ...clean.draft, version: '9.9.9' })
  const rebased = syncRemote(dirty, dto(structuredClone(base), 2))
  assert.equal(rebased.baseRevision, 2)
  assert.equal(rebased.remote, null)
  assert.equal(rebased.draft.version, '9.9.9')

  const conflicted = syncRemote(dirty, dto(renamed, 3))
  assert.deepEqual(conflicted.remote, { revision: 3 })
  assert.equal(conflicted.draft.version, '9.9.9', 'the author draft is never dropped silently')
  assert.equal(conflicted.baseRevision, 1)

  const kept = resolveConflict(conflicted, 'keep', dto(renamed, 3))
  assert.equal(kept.baseRevision, 3)
  assert.equal(kept.dirty, true)
  assert.equal(kept.draft.version, '9.9.9')
  const discarded = resolveConflict(conflicted, 'discard', dto(renamed, 3))
  assert.equal(discarded.dirty, false)
  assert.equal(discarded.draft.name, 'Renamed elsewhere')
})

test('a save does not erase edits typed while the request was in flight', () => {
  const state = createDraftState(dto(asymmetric(), 1))
  const submitted = editConfig(state, { ...state.draft, name: 'Submitted' })
  const typedMore = editConfig(submitted, { ...submitted.draft, name: 'Submitted and more' })
  const saved = markSaved(typedMore, dto(submitted.draft, 2), submitted.draft)
  assert.equal(saved.dirty, true)
  assert.equal(saved.baseRevision, 2)
  assert.equal(saved.draft.name, 'Submitted and more')
  assert.equal(markSaved(submitted, dto(submitted.draft, 2), submitted.draft).dirty, false)
})

test('raw JSON buffers stay until a structured edit replaces the same field', () => {
  let state = createDraftState(dto(asymmetric(), 1))
  const id = state.draft.agents[0].id
  state = setRawJson(state, `${id}:context`, '{"sources": [', true)
  state = setRawJson(state, `${id}:parameters`, '{}', false)
  state = editMember(state, id, { name: 'Unrelated edit' })
  assert.equal(state.invalid[`${id}:context`], true)
  assert.deepEqual(invalidEntries(state).map(entry => [entry.scope, entry.field, sectionForField(entry.field)]), [[id, 'context', 'context']])
  state = editMember(state, id, { parameters: { temperature: 1 } }, { keepRaw: `${id}:parameters` })
  assert.equal(state.rawJson[`${id}:parameters`], '{}')
  state = editMember(state, id, { context: { sources: [{ type: 'current_input' }] } })
  assert.equal(state.invalid[`${id}:context`], undefined)
  assert.equal(state.rawJson[`${id}:context`], undefined)
  assert.equal(sectionForField('condition-0-value'), 'trigger')
})

test('editing one field keeps every other V2 member field intact', () => {
  const original = asymmetric()
  let state = createDraftState(dto(original, 1))
  const memory = original.agents.find(agent => agent.triggers.some(trigger => trigger.type === 'requested_by_agent'))
  state = editMember(state, memory.id, { name: 'Recollection' })
  const saved = normalizeTeamConfig(state.draft)
  const expected = structuredClone(original)
  expected.agents.find(agent => agent.id === memory.id).name = 'Recollection'
  assert.deepEqual(saved, expected)
  assert.deepEqual(saved.agents.find(agent => agent.id === memory.id).triggers, memory.triggers)
})

test('state, communication, tool and context toggles never widen unrelated grants', () => {
  const member = asymmetric().agents[0]
  const permissions = setStateAccess(member, 'world', '/variables/truth', 'none')
  assert.equal(permissions.length, member.statePermissions.length)
  assert.deepEqual(permissions.find(rule => rule.path === '/variables/truth'), { namespace: 'world', path: '/variables/truth', access: 'none' })
  assert.deepEqual(permissions.filter(rule => rule.path !== '/variables/truth'), member.statePermissions.filter(rule => rule.path !== '/variables/truth'))
  assert.equal(clearStateRule({ statePermissions: permissions }, 'world', '/variables/truth').some(rule => rule.path === '/variables/truth'), false)

  assert.deepEqual(toggleAllowlist(['agent-2'], 'agent-3', true), ['agent-2', 'agent-3'])
  assert.deepEqual(toggleAllowlist(['*'], 'agent-3', false), ['*'], 'individual toggles cannot punch holes in *')
  assert.deepEqual(toggleAllowlist(['agent-2'], '*', true), ['*'])
  assert.deepEqual(toggleAllowlist(['*'], '*', false), [])

  const trusted = toggleTrustedTool({ execution: { after: ['x'], onFailure: 'stop', trustedTools: ['mcp:a'] } }, 'mcp:b', true)
  assert.deepEqual(trusted, { after: ['x'], onFailure: 'stop', trustedTools: ['mcp:a', 'mcp:b'] })

  const withDrafts = { ...member, context: toggleSource(member, 'drafts', true) }
  assert.deepEqual(withDrafts.context.sources.at(-1), { type: 'drafts' })
  const draftIndex = withDrafts.context.sources.length - 1
  const none = updateSource(withDrafts, draftIndex, { agentIds: [] })
  assert.deepEqual(none.sources.at(-1), { type: 'drafts', agentIds: [] })
  const all = updateSource({ ...withDrafts, context: none }, draftIndex, { agentIds: undefined })
  assert.equal(Object.hasOwn(all.sources.at(-1), 'agentIds'), false)
  assert.deepEqual(toggleSource(member, 'recent_history', true), member.context, 'already enabled sources are untouched')
})

test('trigger toggles add one structured trigger and keep request allowlists editable', () => {
  const member = createAgent({ id: 'a', name: 'A', triggers: [{ type: 'always' }] })
  const requested = toggleTrigger(member, 'requested_by_agent', true)
  assert.deepEqual(requested, [{ type: 'always' }, { type: 'requested_by_agent', from: [] }])
  assert.equal(toggleTrigger({ ...member, triggers: requested }, 'requested_by_agent', true), requested)
  assert.deepEqual(toggleTrigger({ ...member, triggers: requested }, 'always', false), [{ type: 'requested_by_agent', from: [] }])
})

test('repeated context selections edit and delete only the selected row', () => {
  const member = createAgent({ id: 'a', context: { sources: [
    { type: 'character_card', selector: '/persona/name' },
    { type: 'drafts', agentIds: ['b'], limit: 2 },
    { type: 'character_card', selector: '/persona/age', limit: 5 }
  ] } })
  const context = updateSource(member, 2, { selector: '/persona/speech', limit: undefined })
  assert.deepEqual(context.sources, [member.context.sources[0], member.context.sources[1], { type: 'character_card', selector: '/persona/speech' }])
  assert.equal(context.sources[0], member.context.sources[0])
  assert.equal(context.sources[1], member.context.sources[1])
  const removed = removeSource({ ...member, context }, 0)
  assert.deepEqual(removed.sources, [context.sources[1], context.sources[2]])
  assert.deepEqual(toggleSource({ ...member, context }, 'character_card', false).sources, [context.sources[1]])
})

test('an added partial selection stays invalid until its path is completed', () => {
  const config = generic()
  const member = config.agents[0]
  const context = addSource(member, 'character_card')
  const pending = { ...member, context }
  assert.equal(context.sources.at(-1).selector, null)
  assert.equal(incompleteSource(context.sources.at(-1)), true)
  assert.ok(memberIssues(pending, config, {}).some(issue => issue.code === 'incompleteSource'))
  assert.throws(() => normalizeTeamConfig({ ...config, agents: [pending, ...config.agents.slice(1)] }))
  assert.equal(incompleteSource({ type: 'character_card', selector: '/persona/a~1b' }), false)
  assert.equal(incompleteSource({ type: 'character_card', selector: '/persona/~2' }), true)
  const complete = updateSource(pending, context.sources.length - 1, { selector: '/persona/name' })
  assert.equal(incompleteSource(complete.sources.at(-1)), false)
  const whole = updateSource(pending, context.sources.length - 1, { selector: undefined })
  assert.equal(incompleteSource(whole.sources.at(-1)), false)
})

test('context row identity survives typing, inserting and deleting sibling selections', () => {
  const first = { type: 'character_card', selector: '/persona/name' }
  const second = { type: 'character_card', selector: '/persona/age' }
  let next = 0
  const allocate = () => `row-${next++}`
  let previous = { sources: [first, second], keys: ['name', 'age'] }
  const edited = { ...second, selector: '/persona/speech' }
  assert.deepEqual(sourceRowKeys(previous, [first, edited], allocate), ['name', 'age'])
  previous = { sources: [first, edited], keys: ['name', 'age'] }
  const added = { type: 'character_card', selector: null }
  assert.deepEqual(sourceRowKeys(previous, [first, edited, added], allocate), ['name', 'age', 'row-0'])
  previous = { sources: [first, edited, added], keys: ['name', 'age', 'row-0'] }
  assert.deepEqual(sourceRowKeys(previous, [edited, added], allocate), ['age', 'row-0'])
})

test('missing model and preset references are reported without being replaced', () => {
  const options = { providers: [{ id: 'local', name: 'Local', models: [{ id: 'm1', name: 'M1', reasoning: { efforts: [{ id: 'low' }] }, parameters: { temperature: true, topP: true, maxTokens: true, reasoningEffort: true } }] }], presets: [{ id: 'p1', name: 'P1' }], capabilities: [] }
  const member = createAgent({ id: 'a', name: 'A', modelRef: { provider: 'gone', model: 'x' }, presetId: 'missing-preset', parameters: { reasoningEffort: 'high' } })
  const snapshot = structuredClone(member)
  assert.equal(modelInfo(member, options).missingProvider, true)
  const codes = memberIssues(member, { agents: [member], state: { definitions: [] } }, options).map(issue => issue.code)
  assert.ok(codes.includes('missingProvider'))
  assert.ok(codes.includes('missingPreset'))
  assert.deepEqual(member, snapshot)
  assert.deepEqual(unsupportedParameters({ reasoningEffort: 'high', temperature: 1 }, options.providers[0].models[0]), ['reasoningEffort'])
  assert.deepEqual(unsupportedParameters({ reasoningEffort: 'high' }, null), [], 'unknown models are not second-guessed')
  assert.equal(modelInfo({ modelRef: { provider: '', model: '' } }, options).kind, 'incomplete')
})

test('conditions must point at declared state the member can read', () => {
  const config = asymmetric()
  const observer = config.agents[0]
  assert.equal(conditionProblem({ op: 'exists', namespace: 'world', path: '/variables/truth' }, config, observer), null)
  assert.equal(conditionProblem({ op: 'exists', namespace: 'shared', path: '/perceptions/agent-3' }, config, observer), 'unreadable')
  assert.equal(conditionProblem({ op: 'exists', namespace: 'shared', path: '/nowhere' }, config, observer), 'undeclared')
  assert.equal(conditionProblem({ op: 'all', conditions: [{ op: 'exists', namespace: 'world', path: '/variables/truth' }, { op: 'exists', namespace: 'shared', path: '/nowhere' }] }, config, observer), 'undeclared')
})

test('summaries follow configured topology instead of member names', () => {
  const custom = normalizeTeamConfig({
    schemaVersion: 2, id: 'parallel', name: 'Parallel senses', version: '1', metadata: {},
    agents: [
      createAgent({ id: 'eyes', name: 'Writer', triggers: [{ type: 'manual' }], outputAuthority: { internal: true, draft: true, state: false, user: false } }),
      createAgent({ id: 'voice', name: 'Checker', execution: { after: ['eyes'], onFailure: 'continue', trustedTools: [] }, outputAuthority: { internal: true, draft: true, state: false, user: true } })
    ],
    state: { definitions: [] }, execution: {}, output: { agentId: 'voice' }
  })
  assert.deepEqual(manualMembers(custom).map(agent => agent.id), ['eyes'])
  assert.deepEqual(triggerTypes(custom.agents[0]), ['manual'])
  assert.equal(custom.output.agentId, 'voice')
  const switched = selectPublisher(custom, 'eyes')
  assert.equal(switched.agents.filter(agent => agent.outputAuthority.user).length, 1)
  assert.equal(switched.agents.find(agent => agent.id === 'eyes').outputAuthority.user, true)

  const config = asymmetric()
  assert.deepEqual(stateCounts(config, config.agents[2]), { read: 2, write: 0, readwrite: 1, extra: 0 })
  assert.deepEqual(communicationGaps(config, config.agents[0]), { sendTo: [], receiveFrom: [], requestTo: [], requestFrom: [] })
  assert.deepEqual(communicationGaps(config, config.agents[3]).receiveFrom, ['agent-2'], 'agent-2 never sends to the scene actor')
})

test('imported presets replace the draft content but keep the saved base for conflict checks', () => {
  const state = createDraftState(dto(asymmetric(), 3))
  const next = replaceDraft(state, generic(), { code: 'imported', name: 'Generic' })
  assert.equal(next.dirty, true)
  assert.equal(next.baseRevision, 3)
  assert.equal(next.selectedId, generic().agents[0].id)
  assert.deepEqual(next.invalid, {})
})

test('manual member selection updates only the target conversation snapshot', async () => {
  const store = createConversationStore({ async setManualAgents(conversationId, agentIds) { return { conversationId, manualAgentIds: agentIds } } })
  await store.setManualAgents('A', ['eyes'])
  assert.deepEqual(store.getSnapshot('A').status.manualAgentIds, ['eyes'])
  assert.equal(store.getSnapshot('B').status, null)
})
