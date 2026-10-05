/** Durable observation only: active scheduling bindings remain separate. */
export function registerExecutionSession(run, { agentId, activation, sessionId, parentSessionId, depth = 0, scheduled = true }) {
  run.executionSessions ??= []
  const existing = run.executionSessions.find(item => item.sessionId === String(sessionId))
  if (existing) return existing
  const execution = Number.isSafeInteger(Number(activation)) ? Number(activation) : null
  const row = {
    executionId: execution === null ? `${run.runId}:session:${sessionId}` : `${run.runId}:${agentId}:${execution}`,
    agentId, activation: execution, sessionId: String(sessionId),
    parentSessionId: String(parentSessionId || run.rootSessionId), depth, scheduled,
    startedAt: new Date().toISOString(), status: 'running'
  }
  run.executionSessions.push(row)
  return row
}

export function finishExecutionSession(run, sessionId, status, eventSeq) {
  const row = run.executionSessions?.find(item => item.sessionId === String(sessionId))
  if (!row) return
  Object.assign(row, { status, endedAt: new Date().toISOString(), endEventSeq: eventSeq })
}

export function traceAssociation(row) {
  const status = row.status ?? row
  const sessions = row.executionSessions ?? []
  // Legacy sessions have known membership but unknown activation/parentage.
  // Retain them explicitly without assigning guessed activation numbers.
  const known = new Set(sessions.map(item => item.sessionId))
  const legacy = Object.values(row.members ?? {}).flatMap(member => (member.sessions ?? [])
    .filter(sessionId => !known.has(sessionId))
    .map(sessionId => ({ executionId: `${status.runId}:session:${sessionId}`, agentId: member.id,
      activation: null, sessionId, scheduled: false, status: 'historical', associationIncomplete: true })))
  return {
    rootSessionId: row.rootSessionId ?? status.rootSessionId,
    localDeliveryRequestSeq: row.localDeliveryRequestSeq,
    localDeliveryAssistantSeq: row.assistantSeq,
    turn: row.turn ?? status.turn,
    inputEventSeq: row.inputEventSeq ?? status.inputEventSeq,
    inputMessageId: row.inputMessageId ?? status.inputMessageId,
    assistantMessageId: row.assistantMessageId ?? status.assistantMessageId,
    executionSessions: structuredClone([...sessions, ...legacy]),
    rewound: row.trace?.events?.some(event => event.type === 'publication.rewound') === true
  }
}

export function observeStatePath(store, run, namespace, path) {
  let value = store.snapshot({ conversationId: run.conversationId, runId: run.runId })[namespace]
  for (const part of path.split('/').slice(1)) value = value?.[part.replace(/~1/g, '/').replace(/~0/g, '~')]
  return value === undefined ? { beforeMissing: true } : { before: structuredClone(value) }
}
