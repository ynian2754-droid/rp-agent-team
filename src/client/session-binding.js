// The workspace can retain bodies from other Sessions. Never use the current
// conversation ID for a body belonging to a different Session.
export function createSessionConversationIndex(conversations) {
  const ids = new Map()
  const capture = () => {
    const current = conversations.getDetailsSnapshot()
    const sessionId = current.runtimeSessionId || current.details?.runtimeSessionId
    if (current.id && sessionId) ids.set(sessionId, current.id)
    for (const item of conversations.getSnapshot().items || []) {
      if (item.id && item.runtimeSessionId) ids.set(item.runtimeSessionId, item.id)
    }
  }
  return {
    get(sessionId) { capture(); return ids.get(sessionId) || '' },
    subscribe(listener) {
      const changed = () => { capture(); listener() }
      const stopDetails = conversations.subscribeDetails(changed)
      const stopList = conversations.subscribe(changed)
      capture()
      return () => { stopDetails(); stopList() }
    },
    clear() { ids.clear() }
  }
}
