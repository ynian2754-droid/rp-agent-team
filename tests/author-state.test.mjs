import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createAuthorStateApi } from '../src/host/author-state.mjs'
import { StateStore, projectStateValueForAgent } from '../src/host/state-store.mjs'
import { defaultTeamConfig } from '../src/shared/schema.mjs'

test('author edits are idempotent, support plugin roots, and keep prototype-like keys as data', async () => {
  const fixture = createFixture()
  try {
    const before = await fixture.api.getState({ conversationId: 'conversation-1' })
    const rootEdit = {
      conversationId: 'conversation-1', operationId: 'edit-root',
      expectedRevision: before.revision, expectedWorldHash: before.worldHash, anchor: before.anchor,
      operations: [{ namespace: 'shared', path: '', operation: 'set', value: { chapter: 1 } }]
    }
    const first = await fixture.api.applyStateEdit(rootEdit)
    assert.equal(first.status, 'committed')
    assert.deepEqual(fixture.stateStore.committedSnapshot({ conversationId: 'conversation-1' }).namespaces.shared, { chapter: 1 })

    const secondState = await fixture.api.getState({ conversationId: 'conversation-1' })
    const specialKeyEdit = {
      conversationId: 'conversation-1', operationId: 'edit-special-key',
      expectedRevision: secondState.revision, expectedWorldHash: secondState.worldHash, anchor: secondState.anchor,
      operations: [{ namespace: 'private:agent-1', path: '/profile/__proto__/flag', operation: 'set', value: true }]
    }
    await fixture.api.applyStateEdit(specialKeyEdit)
    const privateState = fixture.stateStore.committedSnapshot({ conversationId: 'conversation-1' }).namespaces['private:agent-1']
    assert.equal(Object.hasOwn(privateState.profile, '__proto__'), true)
    assert.equal(privateState.profile.__proto__.flag, true)
    assert.equal(Object.getPrototypeOf(privateState.profile), Object.prototype)

    const retry = await fixture.api.applyStateEdit(rootEdit)
    assert.equal(retry.status, 'committed', 'an exact retry returns the original receipt after newer edits')
    assert.deepEqual(fixture.stateStore.committedSnapshot({ conversationId: 'conversation-1' }).namespaces.shared, { chapter: 1 })

    await assert.rejects(fixture.api.applyStateEdit({
      ...rootEdit,
      operationId: 'stale-edit',
      operations: [{ namespace: 'shared', path: '', operation: 'set', value: { chapter: 2 } }]
    }), { code: 'RP_TEAM_AUTHOR_EDIT_CONFLICT' })
  } finally {
    fixture.dispose()
  }
})

test('values checkpoint restore includes plugin namespace roots and excludes unsupported world roots', async () => {
  const fixture = createFixture()
  try {
    const initial = await fixture.api.getState({ conversationId: 'conversation-1' })
    await fixture.api.applyStateEdit({
      conversationId: 'conversation-1', operationId: 'first',
      expectedRevision: initial.revision, expectedWorldHash: initial.worldHash, anchor: initial.anchor,
      operations: [{ namespace: 'shared', path: '', operation: 'set', value: { chapter: 1 } }]
    })
    const afterFirst = await fixture.api.getState({ conversationId: 'conversation-1' })
    await fixture.api.applyStateEdit({
      conversationId: 'conversation-1', operationId: 'second',
      expectedRevision: afterFirst.revision, expectedWorldHash: afterFirst.worldHash, anchor: afterFirst.anchor,
      operations: [{ namespace: 'shared', path: '', operation: 'set', value: { chapter: 2 } }]
    })
    const current = await fixture.api.getState({ conversationId: 'conversation-1' })
    const restored = await fixture.api.restoreStateCheckpoint({
      conversationId: 'conversation-1', operationId: 'restore-first', checkpointId: 'author:first',
      mode: 'values', expectedRevision: current.revision, expectedWorldHash: current.worldHash,
      paths: [{ namespace: 'shared', path: '' }]
    })
    assert.equal(restored.status, 'committed')
    assert.deepEqual(restored.state.values.find(item => item.namespace === 'shared' && item.path === '').value, { chapter: 1 })
  } finally {
    fixture.dispose()
  }
})

test('world author edits use the official CAS API, stable SettingLibrary IDs, and historical before/after values', async () => {
  const fixture = createFixture(config => {
    config.state.definitions.push(
      { namespace: 'world', path: '/variables/score', type: 'number', default: 0 },
      { namespace: 'world', path: '/settings/entry-1', type: 'string', default: 'before' }
    )
  }, {}, {
    currentVariableStateJson: '{"score":1}',
    settingLibrary: { groups: [], entries: [{ id: 'entry-1', title: 'Rules', content: 'before' }] }
  })
  try {
    const before = await fixture.api.getState({ conversationId: 'conversation-1' })
    const receipt = await fixture.api.applyStateEdit({
      conversationId: 'conversation-1', operationId: 'world-edit',
      expectedRevision: before.revision, expectedWorldHash: before.worldHash, anchor: before.anchor,
      operations: [
        { namespace: 'world', path: '/variables/score', operation: 'set', value: 2 },
        { namespace: 'world', path: '/settings/entry-1', operation: 'set', value: 'after' }
      ]
    })
    assert.equal(receipt.status, 'committed')
    assert.equal(fixture.nativeState.currentVariableStateJson, '{"score":2}')
    assert.equal(fixture.nativeState.editableSettingLibrary.entries[0].content, 'after')
    assert.equal(fixture.nativeCalls[0].expectedWorldHash, before.worldHash)
    assert.equal(fixture.nativeCalls[0].anchor.sessionId, 'session-1')
    const checkpointIds = (await fixture.api.listStateCheckpoints({ conversationId: 'conversation-1' })).checkpoints.map(item => item.id)
    assert.ok(checkpointIds.includes('author:world-edit:before'))
    assert.ok(checkpointIds.includes('author:world-edit'))
    const beforeCheckpoint = (await fixture.api.listStateCheckpoints({ conversationId: 'conversation-1' })).checkpoints
      .find(item => item.id === 'author:world-edit:before')
    assert.equal(beforeCheckpoint.values.find(item => item.path === '/variables/score').value, 1)
    assert.equal(beforeCheckpoint.values.find(item => item.path === '/settings/entry-1').value, 'before')
    assert.equal(fixture.nativeCalls[0].anchor.inputMessageId, 'user-1')
    const current = await fixture.api.getState({ conversationId: 'conversation-1' })
    const restored = await fixture.api.restoreStateCheckpoint({
      conversationId: 'conversation-1', operationId: 'restore-world-before', checkpointId: 'author:world-edit:before',
      mode: 'values', expectedRevision: current.revision, expectedWorldHash: current.worldHash,
      paths: [{ namespace: 'world', path: '/variables/score' }, { namespace: 'world', path: '/settings/entry-1' }]
    })
    assert.equal(restored.status, 'committed')
    assert.equal(fixture.nativeState.currentVariableStateJson, '{"score":1}')
    assert.equal(fixture.nativeState.editableSettingLibrary.entries[0].content, 'before')
  } finally { fixture.dispose() }
})

test('world edit CAS and writeback use the full raw editable SettingLibrary, not the macro-expanded runtime projection', async () => {
  const raw = {
    groups: [{ id: 'group-1', name: 'Rules', parentId: null, metadata: { source: 'author' } }],
    entries: [
      { id: 'entry-1', groupId: 'group-1', title: 'Rules', content: '{{scene.rule}}', macroSource: 'scene.rule' },
      { id: 'entry-2', groupId: 'group-1', title: 'Other', content: 'preserve me' }
    ]
  }
  const fixture = createFixture(config => config.state.definitions.push(
    { namespace: 'world', path: '/settings/entry-1', type: 'string', default: '' }
  ), {}, {
    editableSettingLibrary: raw,
    settingLibrary: { groups: [], entries: [{ id: 'entry-1', title: 'Rules', content: 'expanded runtime value' }] }
  })
  try {
    const before = await fixture.api.getState({ conversationId: 'conversation-1' })
    assert.equal(before.values.find(item => item.path === '/settings/entry-1').value, '{{scene.rule}}')
    const result = await fixture.api.applyStateEdit({
      conversationId: 'conversation-1', operationId: 'raw-setting-edit',
      expectedRevision: before.revision, expectedWorldHash: before.worldHash, anchor: before.anchor,
      operations: [{ namespace: 'world', path: '/settings/entry-1', operation: 'set', value: '{{scene.newRule}}' }]
    })
    assert.equal(result.status, 'committed')
    assert.deepEqual(fixture.nativeCalls[0].settingLibrary.groups, raw.groups)
    assert.deepEqual(fixture.nativeCalls[0].settingLibrary.entries[1], raw.entries[1])
    assert.equal(fixture.nativeCalls[0].settingLibrary.entries[0].macroSource, 'scene.rule')
    assert.equal(fixture.nativeCalls[0].settingLibrary.entries[0].content, '{{scene.newRule}}')
    assert.equal(fixture.nativeState.editableSettingLibrary.entries[0].content, '{{scene.newRule}}')
    assert.equal(fixture.nativeState.settingLibrary.entries[0].content, 'expanded runtime value')
  } finally { fixture.dispose() }
})

test('legacy world receipts remain archived with their native anchor and cannot restore an invented empty SettingLibrary', async () => {
  const fixture = createFixture()
  try {
    const anchor = {
      sessionId: 'session-1', turn: 1, inputMessageId: 'user-1', inputEventSeq: 1,
      assistantMessageId: 'assistant-1', assistantSeq: 2
    }
    const before = '{"variables":{"scene":{"chapter":1}},"settings":"legacy setting source"}'
    const after = '{"variables":{"scene":{"chapter":2}},"settings":"changed legacy setting source"}'
    fixture.nativeEdits.push({
      operationId: 'legacy-world-edit', outcome: 'committed', revision: 4, anchor,
      active: false, legacyStateUnavailable: true,
      legacyWorldBeforeJson: before, legacyWorldAfterJson: after,
      before: { variableStateJson: '{}', settingLibrary: null }, after: null
    })
    const current = await fixture.api.getState({ conversationId: 'conversation-1' })
    const listed = await fixture.api.listStateCheckpoints({ conversationId: 'conversation-1' })
    const checkpoint = listed.checkpoints.find(item => item.id === 'author:legacy-world-edit')
    assert.ok(checkpoint)
    assert.equal(checkpoint.branchStatus, 'archived')
    assert.equal(checkpoint.canRewind, false)
    assert.equal(checkpoint.legacyStateUnavailable, true)
    assert.deepEqual(checkpoint.anchor, anchor)
    assert.equal(checkpoint.legacyWorldBeforeJson, before)
    assert.equal(checkpoint.legacyWorldAfterJson, after)
    assert.ok(checkpoint.values.every(item => item.unknown && !Object.hasOwn(item, 'value') && !Object.hasOwn(item, 'initial')))
    await assert.rejects(fixture.api.restoreStateCheckpoint({
      conversationId: 'conversation-1', operationId: 'restore-legacy-world', checkpointId: checkpoint.id,
      mode: 'values', expectedRevision: current.revision, expectedWorldHash: current.worldHash
    }), { code: 'RP_TEAM_CHECKPOINT_VALUES_UNAVAILABLE' })
  } finally { fixture.dispose() }
})

test('pure author projection keeps nested ACL behavior and prototype-like keys', () => {
  const agent = defaultTeamConfig().agents[0]
  agent.statePermissions = [
    { namespace: 'world', path: '/profile', access: 'read' },
    { namespace: 'world', path: '/profile/secret', access: 'none' },
    { namespace: 'world', path: '/profile/branch', access: 'none' },
    { namespace: 'world', path: '/profile/branch/public', access: 'read' }
  ]
  const profile = JSON.parse('{"public":"visible","secret":"hidden","branch":{"public":"nested","private":"hidden"},"__proto__":{"data":"kept"}}')
  const projected = projectStateValueForAgent(agent, 'world', '/profile', profile)
  assert.deepEqual(projected.public, 'visible')
  assert.deepEqual(projected.branch, { public: 'nested' })
  assert.equal(Object.hasOwn(projected, 'secret'), false)
  assert.equal(Object.hasOwn(projected, '__proto__'), true)
  assert.equal(projectStateValueForAgent(agent, 'world', '/profile/secret', 'hidden'), undefined)
})

test('member state inspector applies saved parameter permissions rather than template grants', async () => {
  const fixture = createFixture(config => {
    config.agents[0].statePermissions = [{ namespace: 'shared', path: '', access: 'read' }]
    config.authorParameters = [{ id: 'visibility', name: 'Visibility', type: 'choice', default: 'read', options: [
      { label: 'Visible', value: 'read' }, { label: 'Hidden', value: 'none' }
    ], bindings: [{ mode: 'set', target: { kind: 'agent', agentId: 'agent-1', path: '/statePermissions/0/access' } }] }]
  }, { visibility: 'none' })
  try {
    const member = await fixture.api.getState({ conversationId: 'conversation-1', agentId: 'agent-1' })
    assert.equal(member.values.some(row => row.namespace === 'shared'), false)
    const author = await fixture.api.getState({ conversationId: 'conversation-1' })
    assert.equal(author.definitions.some(row => row.namespace === 'shared'), true)
  } finally { fixture.dispose() }
})

function createFixture(change = () => {}, parameterValues = {}, initialNativeState = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'rp-team-author-state-'))
  const config = defaultTeamConfig()
  config.state.definitions = [
    { namespace: 'shared', path: '', type: 'object', default: { chapter: 0 } },
    { namespace: 'private:agent-1', path: '/profile', type: 'object', default: {} }
  ]
  change(config)
  const stateStore = new StateStore(undefined, { filePath: join(directory, 'state.json') })
  const nativeState = {
    currentVariableStateJson: initialNativeState.currentVariableStateJson ?? '{}',
    initialVariableStateJson: '{}',
    settingLibrary: structuredClone(initialNativeState.settingLibrary ?? initialNativeState.editableSettingLibrary ?? { groups: [], entries: [] }),
    editableSettingLibrary: structuredClone(initialNativeState.editableSettingLibrary ?? initialNativeState.settingLibrary ?? { groups: [], entries: [] })
  }
  const sessionEvents = [
    { type: 'user/message', seq: 1, data: { turn: 1, id: 'user-1', role: 'user' } },
    { type: 'assistant/message', seq: 2, data: { turn: 1, message: { id: 'assistant-1', role: 'assistant' } } },
    { type: 'turn/end', seq: 3, data: { turn: 1 } }
  ]
  const nativeCalls = []
  const nativeEdits = []
  const nativeStatus = new Map()
  let nativeRevision = 0
  const conversations = {
    async details() { return { runtimeSessionId: 'session-1' } },
    async authorState() { return structuredClone(nativeState) },
    async listStateEdits() { return { edits: structuredClone(nativeEdits) } },
    async stateEditStatus({ operationId }) { return nativeStatus.get(operationId) ?? { conversationId: 'conversation-1', operationId, outcome: 'unknown' } },
    async editCurrentState(input) {
      nativeCalls.push(structuredClone(input))
      const before = structuredClone({ variableStateJson: nativeState.currentVariableStateJson, settingLibrary: nativeState.editableSettingLibrary })
      if (input.variableStateJson !== undefined) nativeState.currentVariableStateJson = input.variableStateJson
      if (input.settingLibrary !== undefined) nativeState.editableSettingLibrary = structuredClone(input.settingLibrary)
      const receipt = {
        conversationId: input.conversationId, operationId: input.operationId, outcome: 'committed',
        baseHash: input.expectedWorldHash, revision: ++nativeRevision, anchor: input.anchor, active: true
      }
      const edit = { ...receipt, before, after: structuredClone({ variableStateJson: nativeState.currentVariableStateJson, settingLibrary: nativeState.editableSettingLibrary }) }
      nativeEdits.push(edit)
      nativeStatus.set(input.operationId, receipt)
      return receipt
    }
  }
  const api = createAuthorStateApi({
    ctx: { eleckoiConversationsApi: conversations, sessionQuery: { async observeSession() {
      return { events: sessionEvents, [Symbol.dispose]() {} }
    } } },
    store: { get: () => ({ config, parameterValues }) },
    stateStore
  })
  return {
    api,
    stateStore,
    nativeState,
    nativeCalls,
    nativeEdits,
    dispose() { rmSync(directory, { recursive: true, force: true }) }
  }
}
