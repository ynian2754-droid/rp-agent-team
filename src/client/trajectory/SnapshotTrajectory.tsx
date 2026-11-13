import React, { createElement, useMemo, useState } from '../react.js'
import type { ComponentProps } from 'react'
import { TrajectoryView } from './TrajectoryView.tsx'
import type { TrajectorySnapshot } from './trajectory-contract.ts'
import type { SourceSnapshot } from './source-registry.ts'
import { zh, en } from './locales.ts'
import { projectOfflineTrajectory, scopeOfflineTrajectory } from './offline-trajectory.ts'
import {associateTrajectory} from './identities.js'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import type * as ConversationRuntime from '@deepseek-ai/dsh-client-ui-conversation/client'

interface SnapshotProps {
  conversationRuntime: Pick<typeof ConversationRuntime, 'ConversationNodeAssembler' | 'UiConversation'>
  snapshot?: TrajectorySnapshot
  native?: { visibleTurns?: number[]; events: SessionEvent[]; runs: SourceSnapshot['runs']; executions: Array<{ runId: string; association: SourceSnapshot['executions'][number]['association']; events: SessionEvent[] }> }
  sources?: SourceSnapshot
  sourceSessionId: string
  hasMore?: boolean
  loading?: boolean
  language?: string
  loadOlder?: () => Promise<boolean>
}

function hydrate(value: TrajectorySnapshot): TrajectorySnapshot {
  return { ...value,
    eventLocations: new Map(value.eventLocations as unknown as Iterable<[number, never]>),
    callSchemas: new Map(value.callSchemas as unknown as Iterable<[string, never]>) }
}

/** Isolated trial snapshots use the ordinary ledger, search, timeline and inspectors. */
export function SnapshotTrajectory({ snapshot, native, sources, sourceSessionId, conversationRuntime, hasMore = false, loading = false, language = 'zh', loadOlder }: SnapshotProps) {
  const [duration, setDuration] = useState(true)
  const inspection = useMemo(() => native ? scopeOfflineTrajectory(projectOfflineTrajectory(native.events, conversationRuntime), native.visibleTurns) : hydrate(snapshot!), [snapshot, native, conversationRuntime])
  const contributions = useMemo(() => {
    const input = native ? { runs: native.runs, executions: native.executions.map(execution => ({ ...execution, loading: false,
      snapshot: associateTrajectory(projectOfflineTrajectory(execution.events, conversationRuntime), undefined,
        native.runs.find(run => run.runId === execution.runId), execution.association.sessionId) })) } : sources
    const view = { runs: input?.runs || [], executions: (input?.executions || []).map(execution => ({ ...execution,
      ...(execution.snapshot ? { snapshot: hydrate(execution.snapshot) } : {}) })), renderActions: () => null, hasMore }
    return { getSnapshot: () => view, subscribe: () => () => {}, loadOlder: loadOlder || (async () => false) }
  }, [sources, native, hasMore, loadOlder, conversationRuntime])
  const dictionary = /^zh/i.test(language) ? zh : en
  const props = {
    sourceSessionId, contributions,
    useSession: (select: (value: unknown) => unknown) => select({ openState: loading ? 'loading' : 'ready', loadingOlder: loading, hasMore }),
    useTrajectory: (select: (value: TrajectorySnapshot) => unknown) => select(inspection),
    useDuration: (select: (value: boolean) => unknown) => select(duration),
    loadOlder: loadOlder || (async () => false),
    loadImage: async () => { throw new Error(dictionary['team.trialAttachment']) },
    renderSlot: () => null, setActualDuration: setDuration,
    viewRequest: null, completeViewRequest: () => {},
    t: (key: keyof typeof zh, values?: Record<string, unknown>) => dictionary[key].replace(/\{(\w+)\}/g, (_, name) => String(values?.[name] ?? '')),
  } as unknown as ComponentProps<typeof TrajectoryView>
  return createElement(TrajectoryView, props)
}
