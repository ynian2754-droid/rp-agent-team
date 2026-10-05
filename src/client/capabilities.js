export function isCapabilityEnabled(memberCapabilities, capability) {
  if (!Array.isArray(memberCapabilities) || memberCapabilities.length === 0) {
    return Boolean(capability.enabledByDefault)
  }
  return Boolean(memberCapabilities.find(item => item.id === capability.id)?.enabled)
}

export function updateCapabilitySelection(memberCapabilities, availableCapabilities, id, enabled) {
  const current = new Map((memberCapabilities || []).map(item => [item.id, item]))
  if (current.size === 0) {
    for (const capability of availableCapabilities) {
      current.set(capability.id, { id: capability.id, enabled: Boolean(capability.enabledByDefault) })
    }
  }
  current.set(id, { ...(current.get(id) || {}), id, enabled })
  return [...current.values()]
}
