function unpack(result, operation) {
  if (!result || typeof result !== 'object' || !('ok' in result)) return result
  if (!result.ok) {
    const error = new Error(result.error?.message || `${operation} failed`)
    error.code = result.error?.code
    error.details = result.error?.details
    throw error
  }
  return result.value
}

export function createClientApi(remote) {
  if (typeof remote?.getConfig !== 'function') {
    throw new Error('RP Team Remote is unavailable.')
  }
  const request = async (method, payload, signal) => unpack(
    await remote[method](payload, ...(signal ? [signal] : [])),
    method
  )
  return {
    author: (method, payload = {}) => request(method, payload),
    getConfig: conversationId => request('getConfig', { conversationId }),
    saveConfig: (conversationId, expectedRevision, enabled, config, parameterValues) => request('saveConfig', {
      conversationId,
      expectedRevision,
      enabled,
      config,
      ...(parameterValues === undefined ? {} : { parameterValues })
    }),
    getOptions: conversationId => request('getOptions', { conversationId }),
    getStatus: conversationId => request('getStatus', { conversationId }),
    cancel: (conversationId, runId) => request('cancel', { conversationId, runId }),
    retry: (conversationId, runId, memberIds, requestId) => request('retry', { conversationId, runId, memberIds, requestId }),
    discardRetry: (conversationId, runId, requestId) => request('discardRetry', { conversationId, runId, requestId }),
    exportConfig: conversationId => request('exportConfig', { conversationId }),
    setManualAgents: (conversationId, agentIds) => request('setManualAgents', { conversationId, agentIds }),
    listTraces: conversationId => request('listTraces', { conversationId }),
    getTrace: (conversationId, runId) => request('getTrace', { conversationId, runId }),
    importConfig: (conversationId, preset) => request('importConfig', { conversationId, preset })
  }
}
