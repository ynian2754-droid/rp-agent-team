import { teamError } from '../shared/schema.mjs'

/** Run the existing handoffs without asking the model to repackage a single group's results. */
export async function finishSingleGroupClerk({
  source, member, args, request, latestSimulation, acceptSimulation, submit
}) {
  const selection = args.selection
  if (!source || !Array.isArray(selection?.group) || selection.slot !== 1 ||
      selection.repeat !== undefined || selection.mode !== undefined ||
      (selection.relay !== undefined && (!Array.isArray(selection.relay) || selection.relay.length !== 0)) ||
      selection.check_issues !== undefined ||
      !selection.group.length || new Set(selection.group).size !== selection.group.length ||
      selection.group.length !== source.present.length || !selection.group.every(person => source.present.includes(person))) {
    throw teamError('RP_TEAM_MATERIAL_PACK_INVALID', 'Use the single-group tool only when all present characters share one group without relay. Use the normal handoffs for multiple groups.')
  }
  const simulation = member.communication.handoffs?.find(rule =>
    rule.id === 'ask-sim-1' && rule.simulation && rule.materialPack && rule.terminal && rule.mode === 'await')
  const review = member.communication.handoffs?.find(rule =>
    rule.id === 'check-sim' && rule.compactReview === 'simulation' && rule.scopedReview && rule.terminal && rule.mode === 'await')
  if (!simulation) throw teamError('RP_TEAM_MATERIAL_PACK_INVALID', 'The first simulation handoff is required')
  if (latestSimulation()) {
    throw teamError('RP_TEAM_MATERIAL_PACK_INVALID', 'The single-group tool must be used before any simulation dispatch for this activation')
  }

  const choices = selection.group
  const summary = typeof args.summary === 'string' && args.summary.trim() || '调卷交回本拍材料'
  const simulate = async data => {
    const previous = latestSimulation()
    try {
      const result = await request({ to: simulation.to, handoffId: simulation.id, summary, data })
      return { ref: result.ref }
    } catch (error) {
      const failed = latestSimulation()
      // Input validation and cancellation did not produce a failed simulation to retry.
      if (!failed || failed.ref === previous?.ref || failed.status !== 'failed') throw error
      return { ref: failed.ref, failed: true }
    }
  }
  const check = async ref => {
    try {
      const result = await request({ to: review.to, handoffId: review.id, summary: '核验本组实际材料与回执', data: {
        packs: [{ $ref: ref, side: 'request' }], beats: [{ $ref: ref, pointer: '/beats' }]
      } })
      return result.data
    } catch (error) {
      if (error.code !== 'RP_TEAM_HANDOFF_TIMEOUT') throw error
      return undefined
    }
  }
  const empty = checkStatus => submit({ summary, data: {
    groups: [], relays: 0, untreated: choices, ...(checkStatus ? { check: checkStatus } : {})
  } })

  let turn = await simulate(selection)
  if (turn.failed) {
    turn = await simulate({ slot: 1, repeat: turn.ref })
    if (turn.failed) return empty(review ? '推演重试失败' : undefined)
  }

  if (review) {
    let verdict = await check(turn.ref)
    if (!verdict) return empty('核验超时')
    if (verdict.pass !== true) {
      turn = await simulate({ slot: 1, repeat: turn.ref, check_issues: verdict.issues })
      if (turn.failed) return empty('核验要求重推，重推失败')
      verdict = await check(turn.ref)
      if (!verdict) return empty('重推核验超时')
      if (verdict.pass !== true) return empty('重推未通过核验')
    }
  }

  const accepted = await acceptSimulation({ ref: turn.ref })
  return submit({ summary, data: {
    groups: [{ slot: 1, people: choices, beats: { $ref: turn.ref, pointer: '/beats' } }],
    relays: 0, untreated: [], ...(review ? { check: '已通过核验' } : {})
  } }, accepted)
}
