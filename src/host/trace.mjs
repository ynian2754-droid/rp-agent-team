export function createTrace(runId, startedAt = new Date().toISOString()) {
  return { runId: String(runId), startedAt, nextSeq: 1, events: [] }
}

/** Stores useful runtime evidence while excluding prompts and model reasoning. */
export function recordTrace(trace, { type, agentId, at = new Date().toISOString(), data = {} }) {
  const event = {
    seq: trace.nextSeq++,
    type: String(type),
    ...(agentId ? { agentId: String(agentId) } : {}),
    at,
    data: projectTraceData(type, data)
  }
  trace.events.push(event)
  return structuredClone(event)
}

export function serializeTrace(trace) {
  return structuredClone({ runId: trace.runId, startedAt: trace.startedAt, nextSeq: trace.nextSeq, events: trace.events })
}

export function traceDetail(trace) {
  return { runId: trace.runId, startedAt: trace.startedAt, events: structuredClone(trace.events) }
}

export function traceSummary(trace, run = {}) {
  return {
    runId: trace.runId,
    phase: run.phase,
    rootSessionId: run.rootSessionId, turn: run.turn, inputEventSeq: run.inputEventSeq, rewound: run.rewound,
    inputMessageId: run.inputMessageId,
    retrySourceRunId: run.retrySourceRunId,
    startedAt: trace.startedAt,
    productMessageId: run.productMessageId,
    assistantMessageId: run.assistantMessageId,
    assistantSeq: run.assistantSeq,
    outputAgentId: run.outputAgentId,
    ...(run.productCommitStaged === undefined ? {} : { productCommitStaged: run.productCommitStaged === true })
  }
}

/** Reads only actual usage reported by the provider event; estimates are not emitted. */
export function actualTokenUsage(event) {
  const data = event?.data ?? {}
  const usage = data.chunk?.usage ?? data.usage ?? data.tokenUsage ?? data.response?.usage ?? data.message?.usage
  if (!usage || typeof usage !== 'object') return undefined
  const inputTokens = numeric(usage.inputTokens ?? usage.promptTokens ?? usage.input_tokens ?? usage.prompt_tokens)
  const outputTokens = numeric(usage.outputTokens ?? usage.completionTokens ?? usage.output_tokens ?? usage.completion_tokens)
  const totalTokens = numeric(usage.totalTokens ?? usage.total_tokens) ?? (inputTokens === undefined || outputTokens === undefined ? undefined : inputTokens + outputTokens)
  const cacheReadTokens = numeric(usage.cacheReadTokens ?? usage.cachedInputTokens ?? usage.cache_read_input_tokens)
  const cacheWriteTokens = numeric(usage.cacheWriteTokens ?? usage.cache_creation_input_tokens)
  const uncachedInputTokens = numeric(usage.uncachedInputTokens ?? usage.uncached_input_tokens)
  if ([inputTokens, outputTokens, totalTokens, cacheReadTokens, cacheWriteTokens, uncachedInputTokens].every(value => value === undefined)) return undefined
  return {
    ...(inputTokens === undefined ? {} : { inputTokens }), ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(totalTokens === undefined ? {} : { totalTokens }), ...(cacheReadTokens === undefined ? {} : { cacheReadTokens }),
    ...(cacheWriteTokens === undefined ? {} : { cacheWriteTokens }), ...(uncachedInputTokens === undefined ? {} : { uncachedInputTokens })
  }
}

function projectTraceData(type, data) {
  switch (type) {
    case 'budget.request':
      return pick(data, ['sessionId', 'provider', 'model', 'purpose', 'requestId', 'turn', 'step', 'stage', 'invocationId', 'requestCount', 'errorCode', 'cancelled'])
    case 'budget.exceeded':
      return pick(data, ['kind', 'code', 'message', 'limit', 'observed'])
    case 'activation.skipped':
    case 'activation.blocked':
      return pick(data, ['reason', 'dependencies', 'limit', 'depth'])
    case 'activation.queued':
      return pick(data, ['reason', 'depth', 'requestedBy'])
    case 'activation.started':
      return pick(data, ['reason', 'depth', 'activation', 'parallel', 'model'])
    case 'activation.completed':
    case 'activation.failed':
      return pick(data, ['activation', 'parallel', 'error', 'tokens'])
    case 'activation.reused':
      return pick(data, ['sourceRunId', 'reason'])
    case 'context.selected':
      return { categories: strings(data.categories) }
    case 'message.sent':
    case 'message.requested':
      return pick(data, ['id', 'sequence', 'from', 'to', 'body', 'depth', 'reason'])
    case 'model.usage':
      return pick(data, ['provider', 'model', 'requestSequence', 'inputTokens', 'outputTokens', 'totalTokens', 'cacheReadTokens', 'cacheWriteTokens', 'uncachedInputTokens'])
    case 'state.operation':
      return pick(data, ['namespace', 'path', 'operation', 'version', 'before', 'after', 'beforeMissing', 'afterMissing', 'valuesRecorded'])
    case 'draft.created':
    case 'draft.updated':
    case 'draft.selected':
      return pick(data, ['draftId', 'status', 'characters', 'revision'])
    case 'publication.staged':
    case 'publication.committed':
    case 'publication.rolled_back':
      return pick(data, ['status', 'selectedProposalCount', 'operationCount', 'bodyCharacters', 'productMessageId', 'receipt', 'reason', 'assistantSeq', 'assistantMessageId'])
    case 'publication.candidate':
      return pick(data, ['status', 'activation', 'bodyCharacters'])
    case 'publication.delivered':
      return pick(data, ['bodyCharacters', 'sessionId', 'turn'])
    case 'publication.assistant_appended':
    case 'publication.commit_failed':
      return pick(data, ['status', 'reason', 'sessionId', 'turn', 'assistantSeq', 'assistantMessageId', 'bodyCharacters'])
    case 'publication.rewound':
      return pick(data, ['targetEventSeq', 'targetTurn', 'sessionId'])
    default:
      return pick(data, ['reason', 'status', 'parallel', 'model', 'tokens', 'error', 'version', 'categories', 'activation', 'seq', 'sessionId'])
  }
}

function pick(source, keys) {
  const result = {}
  for (const key of keys) {
    if (source[key] === undefined) continue
    if (key === 'reason' && typeof source[key] === 'object') {
      result.reason = pick(source[key], ['type', 'detail', 'triggers'])
    } else if (key === 'model' && typeof source[key] === 'object') {
      result.model = pick(source[key], ['provider', 'model'])
    } else {
      result[key] = structuredClone(source[key])
    }
  }
  return result
}

function strings(value) {
  return Array.isArray(value) ? value.filter(item => typeof item === 'string') : []
}

function numeric(value) {
  return Number.isFinite(value) && value >= 0 ? value : undefined
}
