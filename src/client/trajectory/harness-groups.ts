import type { TrajectoryTurnModel } from './layout.ts'
import type { TrajectoryRun } from './source-registry.ts'
import { trajectoryRecordId, type TrajectoryCellProps } from './native.ts'

export type AttemptBranch = 'current' | 'historical' | 'rewound' | 'unconfirmed'

/** Sequence numbers are positions in a branch, never branch identities. */
export function attemptBranch(run: TrajectoryRun, root: readonly TrajectoryTurnModel[], runs: readonly TrajectoryRun[]): AttemptBranch {
  if (run.rewound) return 'rewound'
  const turn = root.find(row => row.turn === run.turn)
  const outputs = turn?.groups.flatMap(group => group.cells).filter(cell => cell.kind === 'message') ?? []
  const saved = run.assistantMessageId && outputs.some(cell => cell.messageId === run.assistantMessageId)
  if (turn?.inputMessageId && run.inputMessageId && turn.inputMessageId !== run.inputMessageId) return 'historical'
  if (saved) return 'current'
  if (!turn?.inputMessageId || !run.inputMessageId) return 'unconfirmed'
  // Explicit retries can share an input. Only the latest attempt or the saved
  // publisher is current; all previous executions remain inspectable.
  const sameInput = runs.filter(row => !row.rewound && row.inputMessageId === run.inputMessageId && row.turn === run.turn)
  const publisher = sameInput.find(row => row.assistantMessageId && outputs.some(cell => cell.messageId === row.assistantMessageId))
  const latest = publisher ?? sameInput.toSorted((a, b) => a.startedAt.localeCompare(b.startedAt)).at(-1)
  return latest?.runId === run.runId ? 'current' : 'historical'
}

export function nativeRequestGroupId(sessionId: string, turn: number | null, step: number | string): string {
  return `${sessionId}:request:${typeof step === 'number' ? 'assistant:' : ''}${turn}:${step}`
}

/** Shared by list folding, search and cross-view navigation. */
export function visibleHarnessRecords<T extends { cell: TrajectoryCellProps }>(
  records: readonly T[], overrides: ReadonlyMap<string, boolean>, matches: ReadonlySet<number> | null,
): T[] {
  const headers = new Map(records.filter(row => row.cell.kind === 'group').map(row => [trajectoryRecordId(row.cell), row.cell]))
  if (matches !== null) {
    const visible = new Set<number>(matches)
    for (const row of records) if (matches.has(row.cell.index)) {
      for (const id of row.cell.parentGroupIds ?? []) {
        const header = headers.get(id)
        if (header) visible.add(header.index)
      }
    }
    return records.filter(row => visible.has(row.cell.index))
  }
  return records.filter(row => !(row.cell.parentGroupIds ?? []).some(id =>
    overrides.get(id) ?? headers.get(id)?.defaultCollapsed ?? false))
}

export function nativeUsage(cells: readonly TrajectoryCellProps[]) {
  const seen = new Set<string>()
  const seenTools = new Set<string>()
  let input = 0, output = 0, recorded = false, requests = 0, tools = 0
  for (const cell of cells) {
    if (cell.kind === 'tool' || cell.kind === 'subtool') {
      const id = trajectoryRecordId(cell)
      if (!seenTools.has(id)) { seenTools.add(id); tools++ }
    }
    if (cell.kind !== 'message' || cell.eventCategory === 'publication') continue
    const id = cell.requestGroupId ?? trajectoryRecordId(cell)
    if (seen.has(id)) continue
    seen.add(id); requests++
    if (cell.input !== undefined || cell.output !== undefined) recorded = true
    input += cell.input ?? 0; output += cell.output ?? 0
  }
  return { requests, tools, ...(recorded ? { input, output } : {}) }
}
