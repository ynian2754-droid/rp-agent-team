import React from '../react.js'
import { attemptBranch, nativeRequestGroupId } from './harness-groups.ts'
import { normalizeRequestContext } from './request-context.js'
import { Sigil } from '../fields.jsx'
/** Trajectory view: compact summary over a turn-aware event ledger. */

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from '../react.js'
import type {
  AssistantMessageNode, ConvViewProps, MessageImageLoader, RenderMessageImages,
  ToolCallBlock,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { InjectFace, PropsLocale, PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { JsonTreeProps } from '@deepseek-ai/dsh-client-ui-primitives'
import {
  TrajectoryTable,
  type TrajectoryRequestContextItem,
  type TrajectoryRequestNumber,
  type TrajectoryUsage,
} from './TrajectoryTable.tsx'
import { TrajectoryToolbar } from './native.ts'
import { TrajectoryTimeline } from './native.ts'
import {
  appendTrajectoryPartialLayout, deriveTrajectoryLayout, includeEmptyTrajectoryTurns,
  type TrajectoryTurnModel,
} from './layout.ts'
import {
  trajectoryTimelineFocusIndexes,
  type TrajectoryTimelineMode,
  type TrajectoryTimeRange,
} from './native.ts'
import { trajectoryRecordId } from './native.ts'
import { TrajectorySearchIndex } from './native.ts'
import type { TrajectorySnapshot } from './trajectory-contract.ts'
import { EMPTY_SOURCE_STORE, type SourceStore } from './source-registry.ts'
import { executionTitle, mergeTrajectorySources, sanitizeTrajectoryValue } from './source-layout.ts'
import css from './views.module.css'

const EMPTY_TURN_IDS: ReadonlySet<number> = new Set()
const EMPTY_RECORD_IDS: ReadonlySet<string> = new Set()
const SEARCH_INDEX_THROTTLE_MS = 3_000
const HISTORY_PAGE_NODES = 50

/** Members in team order, so each keeps the mark it has in the team panel. */
function ledgerMembers(runs: readonly any[]): [string, string][] {
  const names = new Map<string, string>(runs.flatMap(run => Object.entries(run.members ?? {}).map(([id, value]: [string, any]) => [id, value?.name || id] as [string, string])))
  const configured = runs.find(run => run.configuration?.agents?.length)?.configuration.agents ?? []
  const ordered: [string, string][] = configured.filter((agent: any) => names.has(agent.id)).map((agent: any) => [agent.id, names.get(agent.id)!])
  for (const [id, name] of names) if (!ordered.some(([known]) => known === id)) ordered.push([id, name])
  return ordered
}

function containsCall(calls: readonly ToolCallBlock[], callId: string): boolean {
  for (const call of calls) {
    if (call.callId === callId || containsCall(call.subCalls, callId)) return true
  }
  return false
}

function lastCellIndex(turns: readonly TrajectoryTurnModel[]): number {
  let last = 0
  for (const turn of turns) {
    for (const group of turn.groups) {
      for (const cell of group.cells) last = Math.max(last, cell.index)
    }
  }
  return last
}

/** Session-bound controls not already supplied by the conversation view slot. */
export interface TrajectoryViewInjected {
  /** Shared wrapping preference read by expansion handlers. */
  jsonStringWrapping?: Omit<NonNullable<JsonTreeProps['stringWrapping']>, 'label'>
  hooks: {
    duration: SnapshotStore<boolean>
  }
  contributions?: SourceStore
  sourceSessionId?: string
  navigation?: { runId: string; recordId?: string } | null
  loadOlder: () => Promise<boolean>
  loadImage: MessageImageLoader
  setActualDuration: (actualDuration: boolean) => void
}

interface UsageLike {
  inputTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  outputTokens?: number
  reasoningTokens?: number
}

interface RequestContextCarrier {
  readonly context?: readonly TrajectoryRequestContextItem[]
}

function requestContext(value: unknown): readonly TrajectoryRequestContextItem[] | undefined {
  const context = (value as RequestContextCarrier | undefined)?.context
  return normalizeRequestContext(context)
}

function requestUsage(value: unknown): TrajectoryUsage | undefined {
  const usage = value as UsageLike | undefined
  if (usage === undefined) return undefined
  return {
    ...(usage.inputTokens === undefined ? {} : { input: usage.inputTokens }),
    ...(usage.cacheReadTokens === undefined ? {} : { cacheRead: usage.cacheReadTokens }),
    ...(usage.cacheWriteTokens === undefined ? {} : { cacheWrite: usage.cacheWriteTokens }),
    ...(usage.outputTokens === undefined ? {} : { output: usage.outputTokens }),
    ...(usage.reasoningTokens === undefined ? {} : { reasoning: usage.reasoningTokens }),
  }
}

function addUsage(
  total: TrajectoryUsage | undefined,
  usage: TrajectoryUsage | undefined,
): TrajectoryUsage | undefined {
  if (usage === undefined) return total
  return {
    ...(total?.input === undefined && usage.input === undefined
      ? {}
      : { input: (total?.input ?? 0) + (usage.input ?? 0) }),
    ...(total?.cacheRead === undefined && usage.cacheRead === undefined
      ? {}
      : { cacheRead: (total?.cacheRead ?? 0) + (usage.cacheRead ?? 0) }),
    ...(total?.cacheWrite === undefined && usage.cacheWrite === undefined
      ? {}
      : { cacheWrite: (total?.cacheWrite ?? 0) + (usage.cacheWrite ?? 0) }),
    ...(total?.output === undefined && usage.output === undefined
      ? {}
      : { output: (total?.output ?? 0) + (usage.output ?? 0) }),
    ...(total?.reasoning === undefined && usage.reasoning === undefined
      ? {}
      : { reasoning: (total?.reasoning ?? 0) + (usage.reasoning ?? 0) }),
  }
}

function buildRequestNumbers(snapshot: TrajectorySnapshot, t: import('./locales.ts').TrajectoryTranslate): TrajectoryRequestNumber[] {
    const assistantsByStep = new Map<string, AssistantMessageNode>()
    for (const node of snapshot.eventNodes) {
      if (node.kind !== 'assistant' || node.step <= 0) continue
      assistantsByStep.set(`${node.turn}\u0000${node.step}`, node)
    }
    const requestsByStep = new Map(
      snapshot.requests
        .filter(request => request.purpose === 'assistant')
        .map(request => [
          `${request.turn}\u0000${request.step}`,
          request,
        ]),
    )
    const orderedRequests = [
      ...snapshot.requests.map(request => ({
        seq: request.startSeq,
        request,
        node: request.purpose === 'assistant'
          ? assistantsByStep.get(`${request.turn}\u0000${request.step}`)
          : undefined,
      })),
      ...[...assistantsByStep.entries()].flatMap(([key, node]) =>
        requestsByStep.has(key)
          ? []
          : [{
            seq: node.seq,
            request: undefined,
            node,
          }],
      ),
    ].sort((left, right) => left.seq - right.seq)
    const numbered: TrajectoryRequestNumber[] = []
    let cumulativeUsage: TrajectoryUsage | undefined
    for (const [index, entry] of orderedRequests.entries()) {
      const usage = requestUsage(entry.request?.usage ?? entry.node?.usage)
      cumulativeUsage = addUsage(cumulativeUsage, usage)
      if (entry.request?.purpose !== 'compaction') {
        const request = entry.request
        const node = entry.node
        const turn = request?.turn ?? node?.turn
        const step = request?.step ?? node?.step
        if (turn === undefined || step === undefined) continue
        const provider = request?.providerMetadata?.provider ?? node?.providerMetadata?.provider
        const model = request?.providerMetadata?.model ?? node?.providerMetadata?.model
        const requestConfig = request?.requestConfig ?? node?.requestConfig
        const location = node ? snapshot.eventLocations.get(node.seq) : undefined
        const startSeq = location?.kind === 'step' ? location.step.start?.seq : undefined
        const context = requestContext(request) ?? (startSeq === undefined ? undefined : normalizeRequestContext(snapshot.requestContexts?.[startSeq]))
        numbered.push({
          seq: entry.seq,
          turn,
          step,
          group: t('group.step', { step }),
          number: index + 1,
          ...(request?.status === undefined ? {} : { status: request.status }),
          ...((request?.startedAt ?? node?.timing?.stepStartTime) == null ? {} : { startedAt: (request?.startedAt ?? node?.timing?.stepStartTime)! }),
          ...((request?.completedAt ?? node?.timing?.completedTime) === undefined ? {} : { completedAt: (request?.completedAt ?? node?.timing?.completedTime)! }),
          ...(request?.error === undefined ? {} : { error: request.error }),
          ...(request?.errorCode === undefined ? {} : { errorCode: request.errorCode }),
          ...(request?.resultSeq === undefined ? {} : { resultSeq: request.resultSeq }),
          ...(request?.retry === undefined ? {} : { retry: request.retry }),
          ...(request?.maxRetries === undefined ? {} : { maxRetries: request.maxRetries }),
          ...(request?.retryDelayMs === undefined
            ? {}
            : { retryDelayMs: request.retryDelayMs }),
          ...(provider === undefined ? {} : { provider }),
          ...(model === undefined ? {} : { model }),
          ...(requestConfig === undefined ? {} : { requestConfig }),
          ...(usage === undefined ? {} : { usage }),
          ...(cumulativeUsage === undefined ? {} : { cumulativeUsage }),
          ...(context === undefined ? {} : { context }),
        })
        continue
      }
      const request = entry.request
      const context = requestContext(request)
      numbered.push({
        seq: request.startSeq,
        turn: request.turn,
        step: 0,
        group: t('group.compaction', { seq: request.startSeq }),
        number: index + 1,
        purpose: 'compaction',
        status: request.status,
        startedAt: request.startedAt,
        completedAt: request.completedAt,
        ...(request.error === undefined ? {} : { error: request.error }),
        ...(request.errorCode === undefined ? {} : { errorCode: request.errorCode }),
        resultSeq: request.startSeq,
        ...(request.providerMetadata?.provider === undefined
          ? {}
          : { provider: request.providerMetadata.provider }),
        ...(request.providerMetadata?.model === undefined
          ? {}
          : { model: request.providerMetadata.model }),
        ...(request.requestConfig === undefined ? {} : { requestConfig: request.requestConfig }),
        ...(usage === undefined ? {} : { usage }),
        ...(cumulativeUsage === undefined ? {} : { cumulativeUsage }),
        ...(context === undefined ? {} : { context }),
      })
    }

    return numbered
}

export function TrajectoryView({
  useSession, useTrajectory, useDuration, loadOlder, loadImage, setActualDuration,
  viewRequest, completeViewRequest, renderSlot, t, jsonStringWrapping,
  contributions = EMPTY_SOURCE_STORE, sourceSessionId = 'root', navigation,
}: ConvViewProps
  & PropsRenderSlots<'conversation.trajectory.images'>
  & InjectFace<TrajectoryViewInjected>
  & PropsLocale<'trajectory'>) {
  const sources = useSyncExternalStore(contributions.subscribe, contributions.getSnapshot, contributions.getSnapshot)
  const [scope, setScope] = useState('all')
  const [member, setMember] = useState('')
  const [category, setCategory] = useState('')
  const [collapsedTurns, setCollapsedTurns] = useState<ReadonlySet<number>>(EMPTY_TURN_IDS)
  const renderImages = useCallback<RenderMessageImages>(
    owner => renderSlot('conversation.trajectory.images', { ...owner, loadImage }),
    [loadImage, renderSlot],
  )
  const [collapsedAssistants, setCollapsedAssistants] =
    useState<ReadonlySet<string>>(EMPTY_RECORD_IDS)
  const [timelineSelection, setTimelineSelection] = useState<TrajectoryTimeRange | null>(null)
  const actualDuration = useDuration(value => value)
  const [actualTime, setActualTime] = useState(true)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchIndex] = useState(() => new TrajectorySearchIndex())
  const [searchIndexRevision, setSearchIndexRevision] = useState(0)
  const searchIndexTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const searchIndexInitialized = useRef(false)
  const [selectedTimelineIndex, setSelectedTimelineIndex] = useState<number | null>(null)
  const [timelineRecordSelection, setTimelineRecordSelection] = useState<{
    readonly index: number
  } | null>(null)
  const [timelineRecordFocus, setTimelineRecordFocus] = useState<{
    readonly index: number
  } | null>(null)
  const completeInspection = useTrajectory(snapshot => snapshot)
  const latestNodeSeq = completeInspection.eventNodes.at(-1)?.seq
  const [historyTailSeq, setHistoryTailSeq] = useState(latestNodeSeq)
  const [historyNodeLimit, setHistoryNodeLimit] = useState(HISTORY_PAGE_NODES)
  const fixedTailSeq = historyTailSeq ?? latestNodeSeq
  const historyTailIndex = fixedTailSeq === undefined
    ? -1
    : completeInspection.eventNodes.findLastIndex(node => node.seq <= fixedTailSeq)
  const historyEndIndex = historyTailIndex < 0 && latestNodeSeq !== undefined
    ? completeInspection.eventNodes.length
    : historyTailIndex + 1
  const historyStartIndex = Math.max(0, historyEndIndex - historyNodeLimit)
  useEffect(() => {
    if (latestNodeSeq !== undefined && (historyTailSeq === undefined || historyTailIndex < 0)) {
      setHistoryTailSeq(latestNodeSeq)
    }
  }, [historyTailIndex, historyTailSeq, latestNodeSeq])
  const inspection = useMemo<TrajectorySnapshot>(() => {
    if (historyStartIndex === 0) return completeInspection
    const eventNodes = completeInspection.eventNodes.slice(historyStartIndex)
    const firstSeq = eventNodes[0]?.seq ?? 0
    return {
      ...completeInspection,
      eventNodes,
      turnEvents: (completeInspection.turnEvents ?? []).filter(event => (event.endSeq ?? event.startSeq ?? 0) >= firstSeq),
      requests: completeInspection.requests.filter(request =>
        request.startSeq >= firstSeq || (request.resultSeq ?? -1) >= firstSeq),
    }
  }, [completeInspection, historyStartIndex])
  const historyLoading = useSession(snapshot => snapshot.openState === 'loading')
  const olderHistoryLoading = useSession(snapshot => snapshot.loadingOlder)
  const sessionHasOlderHistory = useSession(snapshot => snapshot.hasMore)
  const hasResidentOlderHistory = historyStartIndex > 0
  const hasOlderHistory = hasResidentOlderHistory
    || sessionHasOlderHistory || sources.hasMore || sources.executions.some(execution => execution.hasMore)
  const nodes = inspection.eventNodes
  const eventLocations = inspection.eventLocations
  const historyBaseSeq = nodes[0]?.seq ?? 0
  const partial = inspection.partial
  const runningCalls = inspection.runningCalls
  const requests = inspection.requests
  const callSchemas = inspection.callSchemas
  const inspectCallId = viewRequest?.view === 'trajectory' ? viewRequest.focus : null
  const inspectNodeIndex = useMemo(() => inspectCallId === null
    ? -1
    : completeInspection.eventNodes.findIndex(node => node.kind === 'assistant'
      ? node.blocks.some(block => block.kind === 'tool-call' && block.callId === inspectCallId)
      : node.kind === 'tool-result' && containsCall([node], inspectCallId)),
  [completeInspection.eventNodes, inspectCallId])
  useEffect(() => {
    if (inspectNodeIndex < 0 || inspectNodeIndex >= historyStartIndex) return
    setHistoryNodeLimit(limit => limit + historyStartIndex - inspectNodeIndex)
  }, [historyStartIndex, inspectNodeIndex])
  const requestNumbers = useMemo<readonly TrajectoryRequestNumber[]>(() => {
    const branchRoot = includeEmptyTrajectoryTurns(deriveTrajectoryLayout({ nodes: completeInspection.eventNodes,
      eventLocations: completeInspection.eventLocations, inputTurns: completeInspection.inputTurns, partial: null, runningCalls: [], requests: completeInspection.requests }, t), completeInspection.turnEvents ?? [], t)
    const currentRuns = sources.runs.filter(run => attemptBranch(run, branchRoot, sources.runs) === 'current')
    const deliverySeqs = new Set(currentRuns.flatMap(run => [run.localDeliveryRequestSeq, run.localDeliveryAssistantSeq]).filter(seq => seq !== undefined))
    // Native projection anchors request/starting; the durable local marker is request/header.
    const deliverySteps = new Set(currentRuns.flatMap(run => {
      if (run.localDeliveryRequestSeq === undefined && run.localDeliveryAssistantSeq === undefined) return []
      const node = completeInspection.eventNodes.find(node => node.kind === 'assistant' && node.seq === run.localDeliveryAssistantSeq)
      const request = completeInspection.requests.findLast(request => request.purpose === 'assistant'
        && request.turn === run.turn && request.startSeq <= run.localDeliveryRequestSeq!)
      const turn = node?.kind === 'assistant' ? node.turn : request?.turn
      const step = node?.kind === 'assistant' ? node.step : request?.step
      return turn === undefined || step === undefined ? [] : [`${turn}:${step}`]
    }))
    const rootNumbers = buildRequestNumbers(completeInspection, t).filter(request =>
      (request.seq === undefined || !deliverySeqs.has(request.seq))
      && (request.purpose === 'compaction' || !deliverySteps.has(`${request.turn}:${request.step}`)))
      .map(request => ({ ...request, sourceSessionId, requestGroupId: nativeRequestGroupId(sourceSessionId, request.turn, request.purpose === 'compaction' ? `compaction:${request.seq}` : request.step) }))
    const children = sources.executions.flatMap(execution => {
      const run = sources.runs.find(run => run.runId === execution.runId)
      if (!run || !execution.snapshot) return []
      if (run.members?.[execution.association.agentId]?.reusedFromRunId && execution.association.associationIncomplete) return []
      return buildRequestNumbers(sanitizeTrajectoryValue(execution.snapshot), t).map(request => ({ ...request,
        group: `${executionTitle(run, execution.association, t)} · ${request.group}`,
        requestGroupId: nativeRequestGroupId(execution.association.sessionId, request.turn, request.purpose === 'compaction' ? `compaction:${request.seq}` : request.step),
        turn: run.turn ?? null, _rewound: run.rewound,
        sourceSessionId: execution.association.sessionId, runId: run.runId,
        executionId: execution.association.executionId, localTurn: request.turn,
      }))
    })
    let cumulative: TrajectoryUsage | undefined
    return [...new Map([...rootNumbers, ...children].map(request => [request.requestGroupId, request])).values()]
      .sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0))
      .map((request, index) => {
        cumulative = addUsage(cumulative, request.usage)
        return { ...request, number: index + 1, ...(cumulative ? { cumulativeUsage: cumulative } : {}) }
      })
  }, [completeInspection, sources, sourceSessionId, t])
  const partialTurn = partial?.turn ?? null
  const partialStep = partial?.step ?? null
  const finalized = useMemo(() => {
    const turns = deriveTrajectoryLayout({
      nodes,
      eventLocations,
      partial: partialTurn === null || partialStep === null
        ? null
        : { turn: partialTurn, step: partialStep, blocks: [] },
      runningCalls,
      requests,
      systemPrompts: inspection.systemPrompts,
      inputTurns: inspection.inputTurns,
      callSchemas,
    }, t)
    return { turns, lastIndex: lastCellIndex(turns) }
  }, [
    nodes, eventLocations, partialTurn, partialStep,
    runningCalls, requests, inspection.systemPrompts, inspection.inputTurns, callSchemas, t,
  ])
  const mergedTurns = useMemo(() => mergeTrajectorySources(
    includeEmptyTrajectoryTurns(appendTrajectoryPartialLayout(finalized.turns, partial, finalized.lastIndex, t), inspection.turnEvents ?? [], t),
    sources, sourceSessionId, t, sources.runs.length ? { scope, member, category } : { scope: 'all', member: '', category: '' },
  ), [finalized, partial, inspection.turnEvents, sources, sourceSessionId, t, scope, member, category])
  const timelineTurns = mergedTurns
  const partialSearchTurns: readonly TrajectoryTurnModel[] = []
  const searchLayouts = useMemo(() => [mergedTurns] as const, [mergedTurns])
  const timelineMode: TrajectoryTimelineMode = actualDuration
    ? actualTime ? 'actual' : 'duration'
    : actualTime ? 'time' : 'sequence'
  const appliedNavigation = useRef<unknown>(null)
  useEffect(() => {
    if (!navigation || appliedNavigation.current === navigation) return
    const cells = mergedTurns.flatMap(turn => turn.groups.flatMap(group => group.cells))
    const target = cells.find(cell => navigation.recordId ? cell.recordId === navigation.recordId : cell.recordId === `${navigation.runId}:run`)
    if (!target) { setScope('all'); setMember(''); setCategory(''); return }
    appliedNavigation.current = navigation
    setCollapsedTurns(new Set())
    setTimelineSelection(null)
    // A specific record (a member's execution) opens its details; opening a whole run only scrolls to it,
    // so the full trajectory starts as a readable timeline instead of the run's raw record.
    if (navigation.recordId) setTimelineRecordSelection({ index: target.index })
    setTimelineRecordFocus({ index: target.index })
  }, [navigation, mergedTurns])
  const latestSearchLayouts = useRef(searchLayouts)
  latestSearchLayouts.current = searchLayouts
  useEffect(() => {
    if (!searchIndexInitialized.current) {
      searchIndexInitialized.current = true
      if (searchIndex.update(searchLayouts)) {
        setSearchIndexRevision(revision => revision + 1)
      }
      return
    }
    if (searchIndexTimer.current !== null) return
    searchIndexTimer.current = setTimeout(() => {
      searchIndexTimer.current = null
      if (searchIndex.update(latestSearchLayouts.current)) {
        setSearchIndexRevision(revision => revision + 1)
      }
    }, SEARCH_INDEX_THROTTLE_MS)
  }, [searchIndex, searchLayouts])
  useEffect(() => () => {
    if (searchIndexTimer.current !== null) clearTimeout(searchIndexTimer.current)
  }, [])
  const streamingCells = useMemo(
    () => partialSearchTurns.flatMap(turn =>
      turn.groups.flatMap(group => group.cells),
    ),
    [partialSearchTurns],
  )
  const searchMatchRecordIds = useMemo(
    () => searchIndex.search(searchQuery),
    [searchIndex, searchIndexRevision, searchQuery],
  )
  const searchMatchIndexes = useMemo(() => {
    if (searchMatchRecordIds === null) return null
    const indexes = new Set<number>()
    for (const turns of searchLayouts) {
      for (const turn of turns) {
        for (const group of turn.groups) {
          for (const cell of group.cells) {
            if (searchMatchRecordIds.has(trajectoryRecordId(cell))) indexes.add(cell.index)
          }
        }
      }
    }
    return indexes
  }, [searchLayouts, searchMatchRecordIds])
  const timelineRange = timelineSelection
  const timelineFocusIndexes = useMemo(
    () => timelineRange === null
      ? null
      : trajectoryTimelineFocusIndexes(timelineTurns, timelineRange, timelineMode),
    [timelineMode, timelineRange, timelineTurns],
  )
  const handleRecordSelect = useCallback((index: number) => {
    if (
      timelineFocusIndexes !== null
      && !timelineFocusIndexes.has(index)
    ) {
      setTimelineSelection(null)
    }
  }, [timelineFocusIndexes])
  const handleTimelineRangeChange = useCallback((range: TrajectoryTimeRange | null) => {
    setTimelineSelection(range)
  }, [])
  const handleTimelineRecordSelect = useCallback((index: number) => {
    setTimelineSelection(null)
    setTimelineRecordSelection({ index })
    setSelectedTimelineIndex(index)
  }, [])
  const handleTimelineRecordFocus = useCallback((index: number) => {
    setTimelineRecordFocus({ index })
  }, [])
  const collapsibleTurnIds = useMemo(
    () => timelineTurns
      .filter(turn =>
        turn.turn !== null
        &&
        turn.groups.reduce(
          (count, group) =>
            count + group.cells.filter(cell =>
              cell.requestOnly !== true && cell.kind !== 'system').length,
          0,
        ) > 1)
      .flatMap(turn => turn.turn === null ? [] : [turn.turn]),
    [timelineTurns],
  )
  const allTurnsCollapsed = collapsibleTurnIds.length > 0
    && collapsibleTurnIds.every(turn => collapsedTurns.has(turn))
  const collapsibleAssistantIds = useMemo(() => {
    const ids: string[] = []
    for (const turn of timelineTurns) {
      const cells = turn.groups.flatMap(group => group.cells)
      for (let i = 0; i < cells.length; i++) {
        const cell = cells[i]
        if (cell?.kind !== 'message') continue
        const next = cells[i + 1]
        if (next?.kind === 'tool' || next?.kind === 'subtool') {
          ids.push(trajectoryRecordId(cell))
        }
      }
    }
    return ids
  }, [timelineTurns])
  const allAssistantsCollapsed = collapsibleAssistantIds.length > 0
    && collapsibleAssistantIds.every(index => collapsedAssistants.has(index))

  const toggleTurn = (turn: number) => {
    setCollapsedTurns((current) => {
      const collapsed = new Set(current)
      if (collapsed.has(turn)) collapsed.delete(turn)
      else collapsed.add(turn)
      return collapsed
    })
  }

  const toggleAllTurns = () => {
    setCollapsedTurns((current) => {
      const collapsed = new Set(current)
      if (allTurnsCollapsed) {
        for (const turn of collapsibleTurnIds) collapsed.delete(turn)
      } else {
        for (const turn of collapsibleTurnIds) collapsed.add(turn)
      }
      return collapsed
    })
  }

  const toggleAssistant = (id: string) => {
    setCollapsedAssistants((current) => {
      const collapsed = new Set(current)
      if (collapsed.has(id)) collapsed.delete(id)
      else collapsed.add(id)
      return collapsed
    })
  }

  const toggleAllAssistants = () => {
    setCollapsedAssistants((current) => {
      const collapsed = new Set(current)
      if (allAssistantsCollapsed) {
        for (const index of collapsibleAssistantIds) collapsed.delete(index)
      } else {
        for (const index of collapsibleAssistantIds) collapsed.add(index)
      }
      return collapsed
    })
  }

  const loadEarlierHistory = useCallback(async () => {
    const sourceMore = await contributions.loadOlder()
    if (!hasResidentOlderHistory && !await loadOlder() && !sourceMore) return false
    setHistoryNodeLimit(limit => limit + HISTORY_PAGE_NODES)
    return true
  }, [hasResidentOlderHistory, loadOlder, contributions])

  return (
    <div className={css.root} data-conversation-composer-overlay="">
      {sources.runs.length > 0 ? <div className="rp-team-ledgerbar">
        <div className="rp-team-ledgerbar-scope" role="group" aria-label={t('ledger.sources')}>
          {(['all', 'main', 'team'] as const).map(id => [id, t(`ledger.scope.${id}`)]).map(([id, label]) => <button key={id} type="button" aria-pressed={scope === id}
            onClick={() => { setScope(id); if (id === 'main') setMember('') }}>{label}</button>)}
        </div>
        <div className="rp-team-ledgerbar-members" role="group" aria-label={t('ledger.members')}>
          {ledgerMembers(sources.runs).map(([id, name], index) => <button key={id} type="button" aria-pressed={member === id} title={name}
            onClick={() => { setMember(member === id ? '' : id); if (member !== id && scope === 'main') setScope('all') }}>
            <Sigil name={name} index={index} size="small" /><span>{name}</span></button>)}
        </div>
        <select aria-label={t('ledger.category')} value={category} onChange={event => setCategory(event.target.value)}>
          <option value="">{t('ledger.allEvents')}</option>
          {(['activation', 'model', 'tool', 'context', 'message', 'state', 'draft', 'publication', 'compaction'] as const)
            .map(id => <option key={id} value={id}>{t(`ledger.cat.${id}`)}</option>)}
        </select>
        {member || category || scope !== 'all' ? <button type="button" className="rp-team-ledgerbar-clear"
          onClick={() => { setScope('all'); setMember(''); setCategory('') }}>{t('ledger.clear')}</button> : null}
      </div> : null}
      <TrajectoryToolbar
        actualDuration={actualDuration}
        onActualDurationChange={(nextActualDuration) => {
          setActualDuration(nextActualDuration)
          setTimelineSelection(null)
        }}
        actualTime={actualTime}
        onActualTimeChange={(nextActualTime) => {
          setActualTime(nextActualTime)
          setTimelineSelection(null)
        }}
        allTurnsCollapsed={allTurnsCollapsed}
        onToggleAllTurns={toggleAllTurns}
        allAssistantsCollapsed={allAssistantsCollapsed}
        onToggleAllAssistants={toggleAllAssistants}
        searchQuery={searchQuery}
        onSearchQueryChange={setSearchQuery}
        t={t}
      />
      <TrajectoryTimeline
        t={t}
        turns={timelineTurns}
        mode={timelineMode}
        range={timelineRange}
        hasEarlierRecords={hasOlderHistory}
        onLoadEarlier={loadEarlierHistory}
        selectedIndex={selectedTimelineIndex}
        searchMatchIndexes={searchMatchIndexes}
        onRangeChange={handleTimelineRangeChange}
        onRecordSelect={handleTimelineRecordSelect}
        onRecordFocus={handleTimelineRecordFocus}
      />
      <div className={css.ledger}>
        <TrajectoryTable
          t={t}
          stringWrapping={jsonStringWrapping === undefined ? undefined : {
            ...jsonStringWrapping,
            label: t('record.wrapLines'),
          }}
          renderImages={renderImages}
          requestNumbers={requestNumbers}
          turns={timelineTurns}
          turnLabels={inspection.turnLabels}
          streamingCells={streamingCells}
          timelineFocusIndexes={timelineFocusIndexes}
          searchMatchIndexes={searchMatchIndexes}
          onSelectedIndexChange={setSelectedTimelineIndex}
          onRecordSelect={handleRecordSelect}
          recordSelection={timelineRecordSelection}
          recordFocus={timelineRecordFocus}
          historyLoading={historyLoading}
          olderHistoryLoading={olderHistoryLoading}
          historyStartSeq={historyBaseSeq}
          hasOlderRecords={hasOlderHistory}
          onLoadOlder={loadEarlierHistory}
          onClearSelection={() => { setTimelineSelection(null) }}
          collapsedTurns={collapsedTurns}
          onToggleTurn={toggleTurn}
          collapsedAssistants={collapsedAssistants}
          onToggleAssistant={toggleAssistant}
          inspectCallId={inspectCallId}
          onInspectApplied={completeViewRequest}
        />
      </div>
    </div>
  )
}
