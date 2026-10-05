import { ACTIVE_PHASES } from './run-model.js'

const POLL_INTERVAL = 1500

function emptySnapshot() {
  return {
    configState: 'idle',
    statusState: 'idle',
    optionsState: 'idle',
    enabled: false,
    revision: 0,
    config: null,
    parameterValues: {},
    options: null,
    status: null,
    traces: [],
    tracesState: 'idle',
    tracesError: '',
    details: {},
    error: '',
    optionsError: '',
    statusError: ''
  }
}

const message = error => error?.message || String(error)

export function createConversationStore(api, conversations) {
  const snapshots = new Map()
  const listeners = new Map()
  const configLoads = new Map()
  const optionsLoads = new Map()
  const statusLoads = new Map()
  const traceLoads = new Map()
  const detailLoads = new Map()
  const watchers = new Map()
  let disposed = false

  const snapshotFor = conversationId => {
    if (!snapshots.has(conversationId)) snapshots.set(conversationId, emptySnapshot())
    return snapshots.get(conversationId)
  }
  const publish = (conversationId, update) => {
    if (disposed) return
    const next = { ...snapshotFor(conversationId), ...update }
    snapshots.set(conversationId, next)
    for (const listener of [...(listeners.get(conversationId) || [])]) listener()
  }
  const dedupe = (loads, key, start) => {
    if (loads.has(key)) return loads.get(key)
    const promise = start().finally(() => loads.delete(key))
    loads.set(key, promise)
    return promise
  }

  async function refreshConfig(conversationId, force = false) {
    if (!conversationId) return
    if (force) configLoads.delete(conversationId)
    if (snapshotFor(conversationId).configState === 'idle') publish(conversationId, { configState: 'loading' })
    return dedupe(configLoads, conversationId, () => api.getConfig(conversationId).then(value => {
      publish(conversationId, { configState: 'ready', enabled: Boolean(value.enabled), revision: value.revision, config: value.config, parameterValues: value.parameterValues || {}, error: '' })
      return value
    }, error => {
      publish(conversationId, { configState: 'error', error: message(error) })
      throw error
    }))
  }

  async function refreshOptions(conversationId, force = false) {
    if (!conversationId) return
    const current = snapshotFor(conversationId)
    if (!force && current.optionsState === 'ready') return current.options
    if (force) optionsLoads.delete(conversationId)
    return dedupe(optionsLoads, conversationId, () => {
      publish(conversationId, { optionsState: 'loading' })
      return api.getOptions(conversationId).then(options => {
        publish(conversationId, { optionsState: 'ready', options, optionsError: '' })
        return options
      }, error => {
        publish(conversationId, { optionsState: 'error', optionsError: message(error) })
        throw error
      })
    })
  }

  async function refreshStatus(conversationId) {
    if (!conversationId) return null
    return dedupe(statusLoads, conversationId, () => api.getStatus(conversationId).then(status => {
      const previous = snapshotFor(conversationId).status?.run
      publish(conversationId, { statusState: 'ready', status, statusError: '' })
      const run = status?.run
      if (run && (previous?.runId !== run.runId || (ACTIVE_PHASES.has(previous?.phase) && !ACTIVE_PHASES.has(run.phase)))) {
        void listTraces(conversationId).catch(() => {})
      }
      return status
    }, error => {
      publish(conversationId, { statusState: 'error', statusError: message(error) })
      return null
    }))
  }

  /**
   * Ref-counted status polling. Polling continues while any persistent watcher is
   * held (for example, while the chat is sending) or while the latest run is active.
   */
  function watchStatus(conversationId, { persistent = false } = {}) {
    if (!conversationId) return () => {}
    let watcher = watchers.get(conversationId)
    if (!watcher) watchers.set(conversationId, watcher = { holders: 0, persistent: 0, timer: undefined, running: false })
    watcher.holders++
    if (persistent) watcher.persistent++
    const tick = async () => {
      watcher.timer = undefined
      watcher.running = true
      await refreshStatus(conversationId)
      watcher.running = false
      if (watchers.get(conversationId) !== watcher || disposed) return
      if (watcher.persistent > 0 || ACTIVE_PHASES.has(snapshotFor(conversationId).status?.run?.phase)) {
        watcher.timer = setTimeout(tick, POLL_INTERVAL)
      }
    }
    if (!watcher.running && watcher.timer === undefined) void tick()
    let released = false
    return () => {
      if (released) return
      released = true
      watcher.holders--
      if (persistent) watcher.persistent--
      if (watcher.holders > 0) return
      clearTimeout(watcher.timer)
      watcher.timer = undefined
      watchers.delete(conversationId)
    }
  }

  async function save(conversationId, enabled, config, expectedRevision = snapshotFor(conversationId).revision, parameterValues) {
    const saved = await api.saveConfig(conversationId, expectedRevision, enabled, config, parameterValues)
    publish(conversationId, { configState: 'ready', enabled: Boolean(saved.enabled), revision: saved.revision, config: saved.config, parameterValues: saved.parameterValues || {}, error: '' })
    return saved
  }

  async function setManualAgents(conversationId, agentIds) {
    const result = await api.setManualAgents(conversationId, agentIds)
    const status = snapshotFor(conversationId).status
    publish(conversationId, { status: { ...(status || { conversationId, binding: null, run: null }), manualAgentIds: result?.manualAgentIds ?? agentIds } })
    return result
  }

  async function cancel(conversationId, runId) {
    const result = await api.cancel(conversationId, runId)
    await refreshStatus(conversationId)
    return result
  }

  async function retry(conversationId, runId, memberIds) {
    const requestId = globalThis.crypto.randomUUID()
    const intent = await api.retry(conversationId, runId, memberIds, requestId)
    try {
      if (intent?.accepted !== true || intent.requestId !== requestId || !Number.isSafeInteger(intent.targetEventSeq)) {
        throw new Error('The host did not accept the member retry request.')
      }
      return await conversations.regenerate({
        conversationId,
        requestId,
        eventSeq: intent.targetEventSeq
      })
    } catch (error) {
      try {
        await api.discardRetry(conversationId, runId, requestId)
      } catch (discardError) {
        error.discardError = discardError
      }
      throw error
    }
  }

  async function listTraces(conversationId) {
    if (!conversationId) return []
    return dedupe(traceLoads, conversationId, () => {
      if (snapshotFor(conversationId).tracesState === 'idle') publish(conversationId, { tracesState: 'loading' })
      return api.listTraces(conversationId).then(value => {
        const traces = Array.isArray(value) ? value : value?.traces || []
        publish(conversationId, { traces, tracesState: 'ready', tracesError: '' })
        return traces
      }, error => {
        publish(conversationId, { tracesState: 'error', tracesError: message(error) })
        throw error
      })
    })
  }

  async function loadTrace(conversationId, runId) {
    if (!conversationId || !runId) return null
    return dedupe(detailLoads, `${conversationId}\u0000${runId}`, () => api.getTrace(conversationId, runId).then(detail => {
      publish(conversationId, { details: { ...snapshotFor(conversationId).details, [runId]: detail } })
      return detail
    }))
  }

  function dispose() {
    disposed = true
    for (const watcher of watchers.values()) clearTimeout(watcher.timer)
    watchers.clear()
    listeners.clear()
    snapshots.clear()
  }

  return {
    getSnapshot: snapshotFor,
    subscribe(conversationId, listener) {
      let set = listeners.get(conversationId)
      if (!set) listeners.set(conversationId, set = new Set())
      set.add(listener)
      return () => {
        set.delete(listener)
        if (!set.size) listeners.delete(conversationId)
      }
    },
    refreshConfig,
    refreshOptions,
    refreshStatus,
    watchStatus,
    dispose,
    save,
    cancel,
    retry,
    exportConfig: conversationId => api.exportConfig(conversationId),
    setManualAgents,
    listTraces,
    loadTrace,
    getTrace: (conversationId, runId) => api.getTrace(conversationId, runId)
  }
}

export function hasActiveRun(status) {
  return ACTIVE_PHASES.has(status?.run?.phase)
}
