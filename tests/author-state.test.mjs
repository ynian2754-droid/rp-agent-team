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

function createFixture(change = () => {}, parameterValues = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'rp-team-author-state-'))
  const config = defaultTeamConfig()
  config.state.definitions = [
    { namespace: 'shared', path: '', type: 'object', default: { chapter: 0 } },
    { namespace: 'private:agent-1', path: '/profile', type: 'object', default: {} }
  ]
  change(config)
  const stateStore = new StateStore(undefined, { filePath: join(directory, 'state.json') })
  const anchor = { sessionId: 'session-1' }
  const storyState = {
    async authorSnapshot() {
      return {
        rawWorld: { variables: {}, settings: {} },
        world: { variables: {}, settings: {} },
        initialWorld: { variables: {}, settings: {} },
        baseHash: 'native-world-hash', anchor, busy: false
      }
    },
    async beginConversationWork() { return { claimed: true } },
    endConversationWork() { return { released: true } },
    setAuthorEditPending() {},
    listAuthorWorldEdits() { return [] },
    async isAuthorAnchorAvailable() { return true }
  }
  const api = createAuthorStateApi({
    ctx: { eleckoiStoryState: storyState },
    store: { get: () => ({ config, parameterValues }) },
    stateStore
  })
  return {
    api,
    stateStore,
    dispose() { rmSync(directory, { recursive: true, force: true }) }
  }
}
