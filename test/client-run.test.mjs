import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { canRetry, composerStatus, eventFields, memberProgress, phaseTone, runHistory, selectRunId, tokenParts } from '../src/client/run-model.js'
import { createConversationStore } from '../src/client/store.js'
import { lookup } from '../src/client/i18n.js'

const run = (runId, phase, extra = {}) => ({ runId, phase, startedAt: `2026-10-04T10:0${runId.slice(-1)}:00Z`, members: {}, ...extra })

test('composer only surfaces failures, active runs and neutral cancellation', () => {
  const base = { statusState: 'ready', enabled: true }
  assert.equal(composerStatus({ ...base, status: { run: null } }), null)
  assert.deepEqual(composerStatus({ ...base, statusState: 'error', status: null }), { tone: 'unavailable' })
  assert.equal(composerStatus({ ...base, enabled: false, status: { run: run('r1', 'failed') } }), null, 'a disabled team leaves no stale noise')
  assert.equal(composerStatus({ ...base, enabled: false, status: { run: run('r1', 'working') } }).tone, 'active', 'an active run stays visible after disabling')
  assert.equal(composerStatus({ ...base, status: { run: run('r1', 'cancelled', { failure: 'Cancelled from RP Team controls' }) } }).tone, 'cancelled')
  assert.equal(composerStatus({ ...base, status: { run: run('r1', 'failed') } }).tone, 'failed')
  assert.equal(phaseTone('awaiting_commit'), 'pending', 'waiting for persistence is not complete')
  assert.equal(phaseTone('complete'), 'done')
})

test('member progress counts only members that actually started', () => {
  const members = { a: { status: 'complete' }, b: { status: 'running' }, c: { status: 'pending' }, d: { status: 'failed' } }
  assert.deepEqual(memberProgress({ members }), { done: 2, total: 3 })
  assert.equal(memberProgress({ members: { a: { status: 'pending' } } }), null)
})

test('run history merges the live run, keeps newest first and honours explicit selection', () => {
  const traces = [run('r1', 'complete'), run('r2', 'failed')]
  const live = run('r3', 'working', { updatedAt: 'x' })
  const history = runHistory(live, traces)
  assert.deepEqual(history.map(item => item.runId), ['r3', 'r2', 'r1'])
  const merged = runHistory({ ...traces[1], members: { a: { status: 'failed' } } }, traces)
  assert.equal(merged.length, 2)
  assert.deepEqual(Object.keys(merged.find(item => item.runId === 'r2').members), ['a'])
  assert.equal(selectRunId('r1', '', live, history), 'r1', 'a message entry opens its own run')
  assert.equal(selectRunId('', '', live, history), 'r3')
  assert.equal(selectRunId('', '', null, history.slice(1)), 'r2')
})

test('retry is offered only for the latest run when the host allows it', () => {
  const live = run('r2', 'failed', { retryAvailable: true })
  assert.equal(canRetry(live, live), true)
  assert.equal(canRetry(run('r1', 'failed', { retryAvailable: true }), live), false)
  assert.equal(canRetry(live, { ...live, retryAvailable: false }), false)
})

test('trace rows show recorded values only', () => {
  assert.deepEqual(tokenParts({ inputTokens: 10, outputTokens: 4 }), [{ key: 'input', value: 10 }, { key: 'output', value: 4 }])
  assert.deepEqual(tokenParts(undefined), [])
  const fields = eventFields({ type: 'message.sent', data: { from: 'a', to: ['b', '*'], reason: { type: 'requested', detail: 'needs memory' }, categories: ['current_input'], tokens: {}, empty: '' } },
    { nameOf: id => id.toUpperCase(), sourceLabel: type => `label:${type}` })
  assert.deepEqual(fields, [
    { key: 'from', value: 'A' },
    { key: 'to', value: 'B, *' },
    { key: 'reason', value: 'requested: needs memory' },
    { key: 'categories', value: 'label:current_input' },
    { key: 'tokens', parts: [] }
  ])
})

test('a run ending refreshes the trace list once for message entries', async () => {
  let phase = 'working'
  let traceCalls = 0
  const store = createConversationStore({
    async getStatus() { return { run: { runId: 'r1', phase } } },
    async listTraces() { traceCalls++; return [] }
  })
  await store.refreshStatus('c')
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(traceCalls, 1, 'a new run id loads traces')
  await store.refreshStatus('c')
  assert.equal(traceCalls, 1)
  phase = 'complete'
  await store.refreshStatus('c')
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(traceCalls, 2)
})

test('persistent watchers keep polling while the chat sends; others stop when idle', async () => {
  const nativeSetTimeout = globalThis.setTimeout
  const timers = []
  globalThis.setTimeout = (callback, delay) => { timers.push({ callback, delay }); return timers.length }
  try {
    const store = createConversationStore({ async getStatus() { return { run: { runId: 'r', phase: 'complete' } } }, async listTraces() { return [] } })
    const stopIdle = store.watchStatus('c')
    await new Promise(resolve => nativeSetTimeout(resolve, 0))
    assert.equal(timers.length, 0, 'idle runs are not polled')
    const stopSending = store.watchStatus('c', { persistent: true })
    await new Promise(resolve => nativeSetTimeout(resolve, 0))
    assert.equal(timers.length, 1)
    stopSending()
    stopIdle()
    store.dispose()
  } finally {
    globalThis.setTimeout = nativeSetTimeout
  }
})

test('every literal translation key exists in both locales', async () => {
  const root = new URL('../', import.meta.url)
  const [zh, en] = await Promise.all(['zh', 'en'].map(async name => JSON.parse(await readFile(new URL(`locale/${name}.json`, root), 'utf8'))))
  const flatten = (value, prefix = '') => Object.entries(value).flatMap(([key, item]) => item && typeof item === 'object' ? flatten(item, `${prefix}${key}.`) : [`${prefix}${key}`])
  assert.deepEqual(flatten(zh).sort(), flatten(en).sort(), 'zh and en expose the same keys')
  const files = (await readdir(new URL('src/client/', root))).filter(name => /\.jsx?$/.test(name))
  const missing = []
  for (const file of files) {
    const source = await readFile(new URL(`src/client/${file}`, root), 'utf8')
    for (const match of source.matchAll(/\bt\('([^'$]+)'/g)) {
      for (const [name, table] of [['zh', zh], ['en', en]]) if (typeof lookup(table, match[1]) !== 'string') missing.push(`${name}:${match[1]} (${file})`)
    }
    for (const match of source.matchAll(/\bt\(`([a-zA-Z]+)\.\$\{/g)) {
      for (const [name, table] of [['zh', zh], ['en', en]]) if (!table[match[1]] || typeof table[match[1]] !== 'object') missing.push(`${name}:${match[1]}.* (${file})`)
    }
  }
  assert.deepEqual(missing, [])
})
