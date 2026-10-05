export function matchesRunInputMessage(run, message) {
  return Boolean((run.inputMessageId && message?.id === run.inputMessageId)
    || (run.requestId && String(message?.source?.rpcId ?? '') === run.requestId))
}

export function isOwnedSettledNotice(message, ownedChildSessionIds) {
  const senderSessionId = String(message?.source?.senderSessionId ?? '')
  return message?.role === 'user'
    && message.source?.kind === 'subagent-settled'
    && senderSessionId.length > 0
    && ownedChildSessionIds.has(senderSessionId)
}

export function sumTokenSamplesForSessions(tokenSamples, sessionIds) {
  const sessions = new Set([...sessionIds].map(String))
  const total = {}
  for (const sample of Object.values(tokenSamples ?? {})) {
    if (!sessions.has(String(sample?.sessionId ?? ''))) continue
    const usage = sample?.usage
    for (const [name, value] of Object.entries(usage ?? {})) {
      if (Number.isFinite(value)) total[name] = (total[name] ?? 0) + value
    }
  }
  return total
}
