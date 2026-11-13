import { t } from './i18n.js'

/** Opaque focus requests use the official conversation view selector. */
export function createTrajectoryNavigation(sessionIndex) {
  const handlers = new Map(), listeners = new Set()
  let value = null
  return {
    bind(sessionId, openView) {
      handlers.set(sessionId, openView)
      return () => { if (handlers.get(sessionId) === openView) handlers.delete(sessionId) }
    },
    open(conversationId, {runId = '', recordId} = {}) {
      const sessionId = [...handlers.keys()].find(id => sessionIndex.get(id) === conversationId)
      if (!sessionId) throw new Error(t('run.openChatFirst'))
      value = {conversationId, sessionId, runId, recordId}
      for(const listener of listeners) listener()
      handlers.get(sessionId)('trajectory', `rp-team:${runId}`)
    },
    getTrajectoryNavigationSnapshot: () => value,
    subscribeTrajectoryNavigation(listener) {listeners.add(listener);return () => listeners.delete(listener)},
    clear() { handlers.clear();listeners.clear();value=null },
  }
}
