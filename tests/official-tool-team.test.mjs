import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { activePrivateState, openJournal, pickPaths } from '../examples/official-tool-team/journal.mjs'

test('installed example depends on public APIs and contains no product DB or lifecycle participant path', () => {
  const source = ['index.mjs', 'runtime.mjs', 'journal.mjs'].map(file => readFileSync(resolve(import.meta.dirname, '../examples/official-tool-team', file), 'utf8')).join('\n')
  assert.ok(!source.includes('eleckoiConversationLifecycle'))
  assert.ok(!source.includes('better-sqlite3'))
  assert.ok(!source.includes('eleckoiProductData'))
  assert.ok(source.includes('eleckoiConversationsApi.authorState'))
  assert.ok(source.includes('eleckoiConversationsApi.replaceVariableState'))
})

test('read permissions select actual fields and never enumerate hidden siblings', () => {
  assert.deepEqual(pickPaths({ score: 1, hidden: 'secret', nested: { known: 'yes', unknown: 'no' } }, ['/score', '/nested/known']), { '/score': 1, '/nested/known': 'yes' })
  assert.deepEqual(pickPaths({ hidden: 'secret' }, []), {})
})

test('field paths preserve escaped keys and reject prototype traversal', () => {
  assert.deepEqual(pickPaths({ 'a/b': { '~': 3 } }, ['/a~1b/~0']), { '/a~1b/~0': 3 })
  assert.throws(() => pickPaths({}, ['/__proto__/secret']))
})

test('private memory follows current native output identities after deletion and reroll', () => {
  const runs = [
    { conversationId: 'chat', status: 'committed', outputMessageId: 'old', privateDelta: { belief: 'old' } },
    { conversationId: 'chat', status: 'committed', outputMessageId: 'new', privateDelta: { belief: 'new' } },
  ]
  const event = id => ({ type: 'assistant/message', data: { message: { id } } })
  assert.deepEqual(activePrivateState(runs, 'chat', [event('new')]), { belief: 'new' })
  assert.deepEqual(activePrivateState(runs, 'chat', [event('old')]), { belief: 'old' })
  assert.deepEqual(activePrivateState(runs, 'chat', []), {})
})

test('failed, cancelled, unsettled and other-chat results never enter private memory', () => {
  const runs = ['failed', 'cancelled', 'unknown', 'product-save-failed'].map(status => ({ conversationId: 'chat', status, outputMessageId: 'same', privateDelta: { secret: status } }))
  runs.push({ conversationId: 'other', status: 'committed', outputMessageId: 'same', privateDelta: { secret: 'other' } })
  assert.deepEqual(activePrivateState(runs, 'chat', [{ type: 'assistant/message', data: { message: { id: 'same' } } }]), {})
})

test('plugin-owned journal survives reopening without touching product storage', () => {
  const root = mkdtempSync(join(tmpdir(), 'official-tool-journal-'))
  try {
    const path = join(root, 'plugin', 'journal.json')
    const store = openJournal(path)
    store.document.runs.push({ id: 'attempt-1', status: 'committed' })
    store.save()
    assert.deepEqual(openJournal(path).document, store.document)
    assert.equal(JSON.parse(readFileSync(path, 'utf8')).runs.length, 1)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
