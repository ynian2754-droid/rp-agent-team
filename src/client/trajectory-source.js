/** Metadata subscription uses the existing ref-counted status poll, not per-member polls. */
export function createTrajectorySource({ store, sessionIndex, conversations, renderActions }) {
  const snapshots = new Map()
  const limits = new Map()
  const errors = new Map()
  const loading = new Set()
  const loadedVersions = new Map()
  const revisions = new Map()
  const conversationFor = sessionId => sessionIndex.get(sessionId)
  const refresh = async (sessionId, listener) => {
    const conversationId = conversationFor(sessionId)
    if (!conversationId) return
    const revision = (revisions.get(sessionId) ?? 0) + 1
    revisions.set(sessionId, revision)
    const snapshot = store.getSnapshot(conversationId)
    const live = snapshot.status?.run
    const navigation = conversations.getTrajectoryNavigationSnapshot?.()
    const selectedId = navigation?.conversationId === conversationId ? navigation.runId : ''
    const byId = new Map(snapshot.traces.map(run => [run.runId, run]))
    if (live) byId.set(live.runId, { ...byId.get(live.runId), ...live })
    if (selectedId && !byId.has(selectedId)) byId.set(selectedId, { runId: selectedId, startedAt: '' })
    const selected = [...byId.values()].sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)))
      .filter((run, index) => index < (limits.get(sessionId) ?? 5) || run.runId === selectedId || run.runId === live?.runId)
    snapshots.set(sessionId, selected.map(run => ({ ...run, ...snapshot.details[run.runId],
      loading: !snapshot.details[run.runId] && !errors.has(run.runId), error: errors.get(run.runId) })))
    listener()
    for (const run of selected) {
      const version = run.runId === live?.runId ? live.updatedAt : 'history'
      if (loading.has(run.runId) || loadedVersions.get(run.runId) === version) continue
      loading.add(run.runId)
      loadedVersions.set(run.runId, version)
      try { await store.loadTrace(conversationId, run.runId); errors.delete(run.runId) }
      catch (error) { errors.set(run.runId, error.message || String(error)) }
      finally { loading.delete(run.runId) }
    }
    // Publish errors without starting another network request.
    if (revisions.get(sessionId) !== revision) return
    const current = store.getSnapshot(conversationId)
    snapshots.set(sessionId, selected.map(run => ({ ...run, ...current.details[run.runId],
      loading: !current.details[run.runId] && !errors.has(run.runId), error: errors.get(run.runId) })))
    listener()
  }
  return {
    id: 'rp-agent-team',
    getSnapshot: sessionId => snapshots.get(sessionId) ?? [],
    subscribe(sessionId, listener) {
      const conversationId = conversationFor(sessionId)
      if (!conversationId) return () => {}
      let active = true
      const notify = () => { if (active) listener() }
      const changed = () => { if (active) void refresh(sessionId, notify) }
      const stop = store.subscribe(conversationId, changed)
      const stopNav = conversations.subscribeTrajectoryNavigation?.(changed)
      const stopPoll = store.watchStatus(conversationId)
      void store.listTraces(conversationId).catch(error => {
        snapshots.set(sessionId, [{ runId: 'unavailable', startedAt: '', error: error.message || String(error) }]); notify()
      })
      changed()
      return () => { active = false; revisions.set(sessionId, (revisions.get(sessionId) ?? 0) + 1); stop(); stopNav?.(); stopPoll(); snapshots.delete(sessionId) }
    },
    hasMore(sessionId) { return store.getSnapshot(conversationFor(sessionId)).traces.length > (limits.get(sessionId) ?? 5) },
    async loadOlder(sessionId) {
      const conversationId = conversationFor(sessionId)
      if (!conversationId) return false
      const limit = limits.get(sessionId) ?? 5
      if (store.getSnapshot(conversationId).traces.length <= limit) return false
      limits.set(sessionId, limit + 5)
      // loadTrace publishes through the existing subscription.
      await refresh(sessionId, () => {})
      return true
    },
    renderActions(runId) {
      const [sessionId] = [...snapshots].find(([, runs]) => runs.some(run => run.runId === runId)) ?? []
      return sessionId ? renderActions(conversationFor(sessionId), runId) : null
    },
  }
}
