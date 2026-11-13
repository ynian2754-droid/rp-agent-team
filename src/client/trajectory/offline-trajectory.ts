import {projectOfflineTrajectory} from './native.ts'
import type {TrajectorySnapshot} from './trajectory-contract.ts'
export {projectOfflineTrajectory}
/** Frozen source history remains in request inspectors, not in the trial execution ledger. */
export function scopeOfflineTrajectory(snapshot: TrajectorySnapshot, visibleTurns?: readonly number[]): TrajectorySnapshot {
  if (!visibleTurns) return snapshot
  const allowed = new Set(visibleTurns)
  const turnAt = (seq: number) => {
    const location = snapshot.eventLocations.get(seq)
    return location && 'turn' in location ? location.turn.turn : undefined
  }
  return { ...snapshot,
    ...(snapshot.turnEvents ? { turnEvents: snapshot.turnEvents.filter(event => allowed.has(event.turn)) } : {}),
    eventNodes: snapshot.eventNodes.filter(node => {
      const turn = 'turn' in node && typeof node.turn === 'number' ? node.turn : turnAt(node.seq)
      return turn !== undefined && allowed.has(turn)
    }),
    requests: snapshot.requests.filter(request => {
      const turn = request.purpose === 'assistant' ? request.turn : turnAt(request.startSeq)
      return turn !== undefined && allowed.has(turn)
    }),
  }
}
