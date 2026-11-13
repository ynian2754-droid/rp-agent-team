import {associateTrajectory} from './identities.js'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ReactNode } from 'react'
import type { UiConversation } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ISessions, SessionBinding, SessionReference } from '@deepseek-ai/dsh-api-session-controller/client'
import type { TrajectorySnapshot } from './trajectory-contract.ts'

export interface ExecutionAssociation {
  executionId: string
  agentId: string
  activation: number | null
  sessionId: string
  parentSessionId?: string
  depth?: number
  scheduled: boolean
  startedAt?: string
  endedAt?: string
  status: string
  associationIncomplete?: boolean
}
export interface TrajectoryRun {
  runId: string
  rootSessionId?: string
  turn?: number
  inputEventSeq?: number
  inputMessageId?: string
  assistantMessageId?: string
  localDeliveryAssistantSeq?: number
  localDeliveryRequestSeq?: number
  startedAt: string
  phase?: string
  rewound?: boolean
  retrySourceRunId?: string
  members?: Record<string, { name: string; model?: { provider?: string; model?: string }; reusedFromRunId?: string }>
  executionSessions?: ExecutionAssociation[]
  events?: Array<{ seq: number; type: string; agentId?: string; at: string; data: unknown }>
  configuration?: unknown
  loading?: boolean
  error?: string | undefined
}
export interface TrajectorySource {
  id: string
  getSnapshot(rootSessionId: string): readonly TrajectoryRun[]
  subscribe(rootSessionId: string, listener: () => void): () => void
  hasMore?(rootSessionId: string): boolean
  loadOlder(rootSessionId: string): Promise<boolean>
  renderActions?(runId: string): ReactNode
}
export interface NativeExecution {
  runId: string
  association: ExecutionAssociation
  snapshot?: TrajectorySnapshot | undefined
  hasMore?: boolean | undefined
  loading: boolean
  error?: string | undefined
}
export interface SourceSnapshot {
  runs: readonly TrajectoryRun[]
  hasMore?: boolean | undefined
  executions: readonly NativeExecution[]
  renderActions: (runId: string) => ReactNode
}
export interface SourceStore {
  getSnapshot(): SourceSnapshot
  subscribe(listener: () => void): () => void
  loadOlder(): Promise<boolean>
}
export const EMPTY_SOURCES: SourceSnapshot = { runs: [], executions: [], renderActions: () => null }
export const EMPTY_SOURCE_STORE: SourceStore = {
  getSnapshot: () => EMPTY_SOURCES, subscribe: () => () => {}, loadOlder: async () => false,
}

/** Each mounted ledger owns its references; providers only supply durable metadata. */
export function createTrajectorySourceRegistry(ctx: { sessions: ISessions; uiConversation: UiConversation }) {
  const sources = new Map<string, TrajectorySource>()
  const registryListeners = new Set<() => void>()
  const changed = () => { for (const listener of registryListeners) listener() }
  return {
    registerSource(source: TrajectorySource) {
      if (sources.has(source.id)) throw new Error(`Trajectory source already registered: ${source.id}`)
      sources.set(source.id, source)
      changed()
      return () => { if (sources.get(source.id) === source) { sources.delete(source.id); changed() } }
    },
    forSession(rootSessionId: string): SourceStore {
      let snapshot = EMPTY_SOURCES
      const listeners = new Set<() => void>()
      const sourceStops = new Map<TrajectorySource, () => void>()
      const native = new Map<string, { reference: SessionReference; binding?: SessionBinding; stop?: () => void; error?: string | undefined }>()
      let mounted = false
      let reconciling = false
      const publish = () => {
        if (!mounted || reconciling) return
        reconciling = true
        try {
          for (const [source, stop] of sourceStops) if (sources.get(source.id) !== source) { stop(); sourceStops.delete(source) }
          for (const source of sources.values()) if (!sourceStops.has(source)) {
            sourceStops.set(source, source.subscribe(rootSessionId, publish))
          }
          const runs = [...sources.values()].flatMap(source => [...source.getSnapshot(rootSessionId)])
            .filter(run => !run.rootSessionId || run.rootSessionId === rootSessionId)
          const entries = runs.flatMap(run => (run.executionSessions ?? []).map(association => ({ runId: run.runId, association })))
          const wanted = new Set(entries.map(entry => entry.association.sessionId))
          for (const [id, row] of native) if (!wanted.has(id)) { row.stop?.(); row.reference.release(); native.delete(id) }
          for (const id of wanted) if (!native.has(id)) {
            const row: { reference: SessionReference; binding?: SessionBinding; stop?: () => void; error?: string | undefined } = {
              reference: ctx.sessions.retain(entries.find(entry => entry.association.sessionId === id)?.association.parentSessionId
                ? { parentSessionId: entries.find(entry => entry.association.sessionId === id)!.association.parentSessionId as SessionId, childSessionId: id as SessionId, mode: 'unknown' }
                : id as SessionId, { source: 'mainView' }),
            }
            native.set(id, row)
            void row.reference.ready.then(binding => {
              if (!mounted || native.get(id) !== row) return
              row.binding = binding
              const target = ctx.uiConversation.binding(binding).target('trajectory')
              const stopTarget = target.subscribe(publish)
              const stopSession = binding.session.subscribe(publish)
              row.stop = () => { stopTarget(); stopSession() }
              publish()
            }, error => { if (native.get(id) === row) { row.error = String(error?.message ?? error); publish() } })
          }
          snapshot = {
            runs, hasMore: [...sources.values()].some(source => source.hasMore?.(rootSessionId)),
            executions: entries.map(entry => {
              const row = native.get(entry.association.sessionId)!
              const raw = row.binding && ctx.uiConversation.binding(row.binding).target('trajectory').getSnapshot()
              const projected = raw && associateTrajectory(raw, undefined, runs.find(run => run.runId === entry.runId), entry.association.sessionId)
              return { ...entry, snapshot: projected, loading: !raw && !row.error, error: row.error,
                hasMore: row.binding?.eventSource.getSnapshot().hasMore }
            }),
            renderActions: runId => [...sources.values()].find(source => source.getSnapshot(rootSessionId).some(run => run.runId === runId))?.renderActions?.(runId) ?? null,
          }
        } finally { reconciling = false }
        for (const listener of listeners) listener()
      }
      const release = () => {
        mounted = false
        registryListeners.delete(publish)
        for (const stop of sourceStops.values()) stop()
        sourceStops.clear()
        for (const row of native.values()) { row.stop?.(); row.reference.release() }
        native.clear()
        snapshot = EMPTY_SOURCES
      }
      return {
        getSnapshot: () => snapshot,
        subscribe(listener) {
          listeners.add(listener)
          if (!mounted) { mounted = true; registryListeners.add(publish); publish() }
          return () => { listeners.delete(listener); if (!listeners.size) release() }
        },
        async loadOlder() {
          const results = await Promise.all([
            ...[...sources.values()].map(source => source.loadOlder(rootSessionId)),
            ...[...native.values()].filter(row => row.binding?.eventSource.getSnapshot().hasMore)
              .map(async row => { await row.binding!.session.loadOlder(); return true }),
          ])
          publish()
          return results.some(Boolean)
        },
      }
    },
  }
}

