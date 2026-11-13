import { appendTrajectoryPartialLayout, deriveTrajectoryLayout, type TrajectoryTurnModel } from './layout.ts'
import { attemptBranch, nativeUsage, nativeRequestGroupId } from './harness-groups.ts'
import { trajectoryRecordId, type TrajectoryCellProps } from './native.ts'
import type { TrajectoryTranslate } from './locales.ts'
import type { SourceSnapshot, TrajectoryRun } from './source-registry.ts'

const PRIVATE_KEY = /^(?:apiKey|api_key|authorization|password|secret|accessToken|refreshToken|credentials)$/i
function cleanText(value: string): string {
  return value.replace(/\bBearer\s+[\w.+\/=:-]+/gi, 'Bearer [redacted]')
    .replace(/\bsk-[\w-]{12,}/g, '[redacted]')
    .replace(/([?&](?:api_key|key|token|access_token)=)[^&#\s]+/gi, '$1[redacted]')
}
/** Applied before native folding, searching or inspecting any Team record. */
export function sanitizeTrajectoryValue<T>(value: T): T {
  if (typeof value === 'string') {
    try { return JSON.stringify(sanitizeTrajectoryValue(JSON.parse(value))) as T } catch { return cleanText(value) as T }
  }
  if (value instanceof Map) return new Map([...value].map(([key, item]) => [key, sanitizeTrajectoryValue(item)])) as T
  if (Array.isArray(value)) return value.map(item => sanitizeTrajectoryValue(item)) as T
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !PRIVATE_KEY.test(key)).map(([key, item]) => [key, sanitizeTrajectoryValue(item)])) as T
  return value
}


const PHASES = new Set(['complete', 'failed', 'cancelled', 'working', 'preparing', 'composing', 'publishing', 'awaiting_commit'])
function phaseLabel(phase: string | undefined, t: TrajectoryTranslate) {
  return phase && PHASES.has(phase) ? t(`team.phase.${phase}` as Parameters<TrajectoryTranslate>[0]) : phase ?? ''
}
export function executionTitle(run: TrajectoryRun, association: import('./source-registry.ts').ExecutionAssociation, t: TrajectoryTranslate) {
  return `${run.members?.[association.agentId]?.name ?? association.agentId} · ${association.activation === null ? t('team.activationUnknown') : t('team.activationN', { n: association.activation })}${association.scheduled ? '' : ` · ${t('team.nested')}`}`
}
function json(value: unknown) { return JSON.stringify(sanitizeTrajectoryValue(value), null, 2) }
function usageLabel(cells: readonly TrajectoryCellProps[], t: TrajectoryTranslate) {
  const usage = nativeUsage(cells)
  return `${t('team.usage', { requests: usage.requests, tools: usage.tools })}${usage.input === undefined ? '' : ` · ${t('team.tokens', { input: usage.input.toLocaleString(), output: usage.output!.toLocaleString() })}`}`
}
/** Matches the native assistant identity, independent of translated headings. */
function requestId(sessionId: string, turn: number | null, cells: readonly TrajectoryCellProps[]) {
  const assistant = cells.find(cell => cell.kind === 'message')?.recordId?.split('\u0000')
  if (assistant?.[0] === 'assistant') return nativeRequestGroupId(sessionId, Number(assistant[1]), Number(assistant[2]))
  const compacted = cells.find(cell => cell.kind === 'compacted' || cell.requestOnly)
  return compacted ? nativeRequestGroupId(sessionId, turn, `compaction:${compacted.sourceSeq}`) : undefined
}
function requestInput(snapshot: import('./trajectory-contract.ts').TrajectorySnapshot, cells: readonly TrajectoryCellProps[]) {
  for (const cell of cells) {
    const location = cell.sourceSeq === undefined ? undefined : snapshot.eventLocations.get(cell.sourceSeq)
    const seq = location?.kind === 'step' ? location.step.start?.seq : undefined
    if (seq !== undefined && snapshot.requestContexts?.[seq]) return snapshot.requestContexts[seq]
  }
  const seqs = new Set(cells.map(cell => cell.sourceSeq))
  return (snapshot.requests.find(request => seqs.has(request.resultSeq) || seqs.has(request.startSeq)) as { context?: unknown } | undefined)?.context
}
/** Fold each Session independently, then construct each product turn once. */
export function mergeTrajectorySources(
  root: readonly TrajectoryTurnModel[], sources: SourceSnapshot, rootSessionId: string,
  t: TrajectoryTranslate, filter: { scope: string; member: string; category: string },
): TrajectoryTurnModel[] {
  const turns: TrajectoryTurnModel[] = root.map(turn => ({ ...turn, groups: turn.groups.map(group => {
    const groupId = requestId(rootSessionId, turn.turn, group.cells)
    return { ...group, cells: group.cells.map(cell => ({ ...cell, requestGroupId: groupId,
      recordId: `${rootSessionId}:${trajectoryRecordId(cell)}`, sourceSessionId: rootSessionId, sourceType: 'main' as const })) }
  }) }))
  const runsByTurn = new Map<number | null, TrajectoryRun[]>()
  for (const run of sources.runs) {
    // A persisted native turn is a location; message identities decide branch ownership.
    const anchor = run.turn ?? root.find(turn => run.inputMessageId && turn.inputMessageId === run.inputMessageId)?.turn ?? null
    const runs = runsByTurn.get(anchor) ?? []; runs.push(run); runsByTurn.set(anchor, runs)
  }
  for (const [anchor, runs] of runsByTurn) {
    let turn = turns.find(row => row.turn === anchor)
    if (!turn) { turn = { turn: anchor, groups: [] }; turns.push(turn) }
    const attempts: import('./layout.ts').TrajectoryGroupModel[] = []
    const original = [...turn.groups]
    const current = runs.find(run => attemptBranch(run, root, sources.runs) === 'current')
    const delivery = current ? original.filter(group => group.cells.some(cell => cell.kind === 'message'
      && (current.assistantMessageId ? cell.messageId === current.assistantMessageId : cell.sourceSeq === current.localDeliveryAssistantSeq))) : []
    const ordered = runs.toSorted((a, b) => a.startedAt.localeCompare(b.startedAt))
    const allCost: TrajectoryCellProps[] = []
    for (const [attempt, run] of ordered.entries()) {
      const branch = attemptBranch(run, root, sources.runs)
      const runHeaderId = `${run.runId}:run`
      const groups: import('./layout.ts').TrajectoryGroupModel[] = []
      const branchLabel = branch === 'current' ? t('team.branch.current') : branch === 'rewound' ? t('team.branch.rewound') : branch === 'historical' ? t('team.branch.historical') : `${anchor === null ? `${t('team.branch.unanchored')} · ` : ''}${t('team.branch.unconfirmed')}`
      const ownEvents = (run.events ?? []).filter(event => event.type !== 'model.usage').map(event => event.type === 'state.operation' && !(event.data as { valuesRecorded?: boolean })?.valuesRecorded
        ? { ...event, data: { ...(event.data as object), historyNote: t('team.historyNote') } } : event)
      const eventsByExecution = new Map<string, typeof ownEvents>()
      const activations = new Map<string, number>()
      for (const event of ownEvents) {
        if (event.agentId && event.type === 'activation.queued') activations.delete(event.agentId)
        const activation = (event.data as { activation?: number })?.activation
        if (event.agentId && activation !== undefined) activations.set(event.agentId, activation)
        const key = event.agentId && activations.has(event.agentId) ? `${run.runId}:${event.agentId}:${activations.get(event.agentId)}` : undefined
        if (key) { const events = eventsByExecution.get(key) ?? []; events.push(event); eventsByExecution.set(key, events) }
        if (event.agentId && ['activation.completed', 'activation.failed'].includes(event.type)) activations.delete(event.agentId)
      }
      const runCells: TrajectoryCellProps[] = []
      const executions = sources.executions.filter(entry => entry.runId === run.runId)
        .filter(entry => !(run.members?.[entry.association.agentId]?.reusedFromRunId && entry.association.associationIncomplete))
        .toSorted((a, b) => (a.association.startedAt ?? '').localeCompare(b.association.startedAt ?? ''))
      for (const execution of executions) {
        const association = execution.association
        const title = executionTitle(run, association, t)
        const headerId = `${association.sessionId}:execution`
        const parents = [runHeaderId, headerId]
        const nativeGroups: import('./layout.ts').TrajectoryGroupModel[] = []
        if (execution.snapshot) {
          const snapshot = sanitizeTrajectoryValue(execution.snapshot)
          const laid = deriveTrajectoryLayout({ nodes: snapshot.eventNodes, eventLocations: snapshot.eventLocations,
            requests: snapshot.requests, systemPrompts: snapshot.systemPrompts, callSchemas: snapshot.callSchemas,
            partial: snapshot.partial ? { ...snapshot.partial, blocks: [] } : null, runningCalls: snapshot.runningCalls }, t)
          const last = Math.max(0, ...laid.flatMap(turn => turn.groups.flatMap(group => group.cells.map(cell => cell.index))))
          for (const local of appendTrajectoryPartialLayout(laid, snapshot.partial, last, t)) for (const group of local.groups) {
            const groupId = requestId(association.sessionId, local.turn, group.cells)
            const input = requestInput(snapshot, group.cells)
            // Boot prompts and runtime injections are request inputs, not execution steps.
            const cells = group.cells.filter(cell => !['system', 'user', 'context'].includes(cell.kind)).map(cell => ({ ...cell,
              recordId: `${association.sessionId}:${trajectoryRecordId(cell)}`, requestGroupId: groupId,
              ...(cell.kind === 'message' && input ? { inputDetail: json(input) } : {}),
              ...(cell.callId ? { callId: `${association.sessionId}:${cell.callId}` } : {}),
              sourceSessionId: association.sessionId, runId: run.runId, executionId: association.executionId,
              agentId: association.agentId, sourceType: 'team' as const, parentGroupIds: parents,
              localTurn: local.turn, localGroup: group.title,
              ...(cell.sourceBlocks ? { sourceBlocks: cell.sourceBlocks.map(block => ({ ...block, ...(block.callId ? { callId: `${association.sessionId}:${block.callId}` } : {}) })) } : {}),
              ...(cell.outputBlocks ? { outputBlocks: cell.outputBlocks.map(block => ({ ...block, ...(block.callId ? { callId: `${association.sessionId}:${block.callId}` } : {}) })) } : {}),
              eventCategory: cell.kind === 'tool' || cell.kind === 'subtool' ? 'tool' : cell.kind === 'compacted' ? 'compaction' : 'model',
            }))
            if (cells.length) nativeGroups.push({ title: `${title} · ${group.title}`, cells })
          }
        }
        const nativeCells = nativeGroups.flatMap(group => group.cells)
        runCells.push(...nativeCells)
        const model = run.members?.[association.agentId]?.model?.model
        const activationEvents = association.scheduled ? eventsByExecution.get(association.executionId) ?? [] : []
        const detail = { ...association, model: run.members?.[association.agentId]?.model,
          reusedFromRunId: run.members?.[association.agentId]?.reusedFromRunId, events: activationEvents,
          usage: nativeUsage(nativeCells), loading: execution.loading, hasMore: execution.hasMore, error: execution.error }
        groups.push({ title, cells: [{ index: 0, kind: 'group', headerType: 'execution', recordId: headerId,
          parentGroupIds: [runHeaderId], text: title, subtitle: `${association.status}${model ? ` · ${model}` : ''} · ${usageLabel(nativeCells, t)}${execution.loading ? ` · ${t('team.loading')}` : ''}${execution.hasMore ? ` · ${t('team.olderPending')}` : ''}${execution.error ? ` · ${t('team.loadFailed')}` : ''}`,
          inputDetail: json(detail), sourceType: 'team', sourceSessionId: association.sessionId, runId: run.runId,
          executionId: association.executionId, agentId: association.agentId, eventCategory: 'activation',
          startedAt: association.startedAt ? Date.parse(association.startedAt) : null,
          timeSeconds: association.endedAt && association.startedAt ? (Date.parse(association.endedAt) - Date.parse(association.startedAt)) / 1000 : null,
        }] }, ...nativeGroups)
      }
      // A reused member has provenance, not another fake model execution.
      for (const [agentId, member] of Object.entries(run.members ?? {})) if (member.reusedFromRunId && !executions.some(row => row.association.agentId === agentId)) {
        groups.push({ title: member.name, cells: [{ index: 0, kind: 'group', headerType: 'execution',
          recordId: `${run.runId}:${agentId}:reuse`, parentGroupIds: [runHeaderId], text: `${member.name} · ${t('team.reused')}`,
          subtitle: t('team.reusedDetail'), inputDetail: json({ agentId, sourceRunId: member.reusedFromRunId }),
          sourceType: 'team', runId: run.runId, agentId, timeSeconds: null }] })
      }
      if (branch === 'current' && delivery.length) groups.push(...delivery.map(group => ({ title: t('team.delivery'), cells: group.cells
        .filter(cell => cell.kind === 'message').map(cell => {
          const { input, output, think, cacheRead, cacheWrite, ...rest } = cell
          return { ...rest, requestGroupId: undefined, parentGroupIds: [runHeaderId], runId: run.runId,
            text: t('team.deliverySaved'), eventCategory: 'publication' }
        }) })))
      allCost.push(...runCells)
      attempts.push({ title: t('team.attempt', { n: attempt + 1 }), cells: [{ index: 0, recordId: runHeaderId, kind: 'group', headerType: 'run',
        runId: run.runId, sourceType: 'team', eventCategory: 'run', defaultCollapsed: branch !== 'current',
        text: `${t('team.attempt', { n: attempt + 1 })} · ${branchLabel} · ${phaseLabel(run.phase, t)}`,
        subtitle: `${usageLabel(runCells, t)}${run.loading ? ` · ${t('team.loading')}` : ''}${run.error ? ` · ${t('team.loadFailed')}` : ''}`,
        startedAt: Date.parse(run.startedAt), timeSeconds: null, actions: branch === 'current' ? sources.renderActions(run.runId) : null,
        inputDetail: json({ ...run, branch, events: ownEvents, usage: nativeUsage(runCells) }),
      }] }, ...groups)
    }
    // Total actual cost includes previous attempts; each attempt owns its own usage.
    const firstHeader = attempts.find(group => group.cells[0]?.runId === current?.runId)?.cells[0] ?? attempts[0]?.cells[0]
    if (firstHeader) firstHeader.subtitle += ` · ${t('team.allAttempts', { usage: usageLabel(allCost, t) })}`
    const remaining = original.filter(group => !delivery.includes(group))
    const userEnd = remaining.findLastIndex(group => group.cells.some(cell => cell.kind === 'user')) + 1
    turn.groups = [...remaining.slice(0, userEnd), ...attempts, ...remaining.slice(userEnd)]
  }
  let index = 0
  return turns.map(turn => ({ ...turn, groups: turn.groups.map(group => ({ ...group, cells: group.cells.filter(cell =>
    (filter.scope === 'all' || cell.sourceType === filter.scope)
    && ((!filter.member && !filter.category) || (cell.kind === 'group' && (cell.headerType === 'run' || !filter.member || cell.agentId === filter.member)) || ((!filter.member || cell.agentId === filter.member)
      && (!filter.category || cell.eventCategory === filter.category || cell.kind === filter.category))))
    .map(cell => ({ ...cell, index: ++index })) })).filter(group => group.cells.length) })).filter(turn => turn.groups.length)
}
