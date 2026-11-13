export async function readSessionEvents(ctx, sessionId, signal) {
  const observation = await ctx.sessionQuery.observeSession(sessionId, {
    ...(signal ? { signal } : {}), projectionMode: 'none'
  })
  try { return structuredClone([...observation.events]) }
  finally { observation[Symbol.dispose]() }
}

/** Whether an event still shows on the Session surface. Events without the field come from hosts older than 0.2.20. */
export function isAppendedSurfaceEvent(event) {
  return event?.surfaceOp === undefined || event.surfaceOp === 'append'
}

/** IDs of the real user inputs on the Session surface, plus the input this turn claims. */
export function activeUserInputIds(events, claimedInput) {
  const ids = new Set()
  for (const event of events ?? []) {
    if (event?.type !== 'user/message' || !isAppendedSurfaceEvent(event)) continue
    const message = event.data?.message ?? event.data
    if (message?.source?.kind === 'user' && typeof message.id === 'string' && message.id) ids.add(message.id)
  }
  if (claimedInput?.source?.kind === 'user' && typeof claimedInput.id === 'string' && claimedInput.id) ids.add(claimedInput.id)
  return [...ids]
}

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
