/** Small per-key external store for useSyncExternalStore. Keys are product conversation IDs. */
export function createKeyedStore(initial) {
  const values = new Map()
  const listeners = new Map()
  const get = key => {
    if (!values.has(key)) values.set(key, initial(key))
    return values.get(key)
  }
  return {
    get,
    has: key => values.has(key),
    update(key, change) {
      const current = get(key)
      const next = typeof change === 'function' ? change(current) : { ...current, ...change }
      if (next === current) return current
      values.set(key, next)
      for (const listener of [...(listeners.get(key) || [])]) listener()
      return next
    },
    subscribe(key, listener) {
      let set = listeners.get(key)
      if (!set) listeners.set(key, set = new Set())
      set.add(listener)
      return () => {
        set.delete(listener)
        if (!set.size) listeners.delete(key)
      }
    },
    clear() {
      values.clear()
      listeners.clear()
    },
    removeWhere(predicate) {
      for (const key of [...values.keys()]) if (predicate(key)) {
        values.delete(key)
        for (const listener of [...(listeners.get(key) || [])]) listener()
      }
    },
    remapKeys(mapKey) {
      const entries = [...values.entries()]
      const changed = entries.filter(([key]) => mapKey(key) !== key)
      const notify = new Set()
      for (const [key] of changed) { values.delete(key); notify.add(key) }
      for (const [key, value] of changed) {
        const next = mapKey(key)
        if (next !== null) { values.set(next, value); notify.add(next) }
      }
      for (const key of notify) for (const listener of [...(listeners.get(key) || [])]) listener()
      return [...values.entries()]
    }
  }
}
