import { teamError } from '../shared/schema.mjs'
import { MISSING, parsePointer, readPath } from './handoff-refs.mjs'
import { describeStateToolAccess, projectStateValueForAgent } from './state-store.mjs'
import { simulationEvidenceCatalog } from './lived-history-sim-evidence.mjs'
const actorFields = ['who', 'says', 'does', 'withheld', 'if_then']
const worldFields = ['tier', 'now', 'refusal', 'established', 'perceivable', 'surface', 'not_reveal', 'open']
const reviewSections = /\[\[review:(simulation|draft)\]\]\s*([\s\S]*?)\[\[\/review\]\]/gu
const directDraftSection = /\[\[review:draft-direct\]\]\s*([\s\S]*?)\[\[\/review\]\](?:\r?\n){0,2}/u
const choiceInstructions = /\[\[review-presentation:(quotes|passages)\]\]\s*([\s\S]*?)\[\[\/review-presentation\]\]/gu
const premiseInstructions = /\[\[review-premises:(legacy|independent)\]\]\s*([\s\S]*?)\[\[\/review-premises\]\]/gu
const draftLaneSections = /\[\[review-lane:(fact|presentation)\]\]\s*([\s\S]*?)\[\[\/review-lane\]\]/gu
const draftSettings = /\[\[review-setting:(shared|fact|presentation)\]\]\s*([\s\S]*?)\[\[\/review-setting\]\]/gu
const requiredText = { type: 'string', required: true }

export const directDraftReviewParameters = {
  pass: { type: 'boolean', required: true },
  issues: { type: 'array', required: true, items: {
    type: 'object', additionalProperties: false, properties: {
      kind: requiredText, quote: requiredText, note: requiredText
    }
  } }
}

export function scopedReviewPrompt(prompt, kind, { directDraftReview = false, passageChoices = false, independentPremises = false, draftLane } = {}) {
  const lane = kind === 'draft' && directDraftReview ? draftLane : undefined
  let lanePrompt
  const rules = prompt.replace(draftLaneSections, (_section, mode, body) => {
    if (mode === lane) lanePrompt = body.trim()
    return ''
  }).replace(draftSettings, (_section, mode, body) => !lane || mode === lane ? body.trim() : '')
  const authored = directDraftSection.exec(rules)
  const direct = lanePrompt ?? (kind === 'draft' && directDraftReview ? authored?.[1].trim()
    .replace(choiceInstructions, (_section, mode, body) =>
      !independentPremises && mode === (passageChoices ? 'passages' : 'quotes') ? body.trim() : '')
    .replace(premiseInstructions, (_section, mode, body) => mode === (independentPremises ? 'independent' : 'legacy') ? body.trim() : '') : undefined)
  return rules.replace(directDraftSection, '')
    .replace(reviewSections, (_section, sectionKind, body) => sectionKind === kind ? direct || body.trim() : '')
}

export function scopedDraftLane(request, agent) {
  if (request?.compactReview !== 'draft' || !agent.execution?.livedHistoryDirectDraftReview) return undefined
  if (request.handoffId === 'check-draft' && agent.execution.livedHistoryDraftFactLane) return 'fact'
  if (request.handoffId === 'check-draft-presentation' && agent.execution.livedHistoryDraftPresentationLane) return 'presentation'
}

export function projectDraftLaneMessage(message, lane) {
  if (!isRecord(message?.data) || !lane) return message
  const fields = lane === 'fact' ? ['draft', 'current_input'] : ['draft']
  const data = select(message.data, fields)
  const world = message.data.world_return
  if (isRecord(world)) {
    if (lane === 'fact') {
      data.world_return = select(world, ['now', 'refusal', 'established', 'perceivable', 'surface', 'open', 'attempts'])
      if (Array.isArray(world.attempts)) data.world_return.attempts = world.attempts.filter(isRecord).map(group => ({
        ...select(group, ['slot', 'people']),
        beats: Array.isArray(group.beats) ? group.beats.filter(isRecord).map(beat => select(beat, ['who', 'says', 'does', 'if_then'])) : []
      }))
    } else data.world_return = select(world, ['now', 'established', 'perceivable', 'surface', 'not_reveal'])
  }
  return { ...message, data }
}

export function prepareReviewData(kind, data, currentInput) {
  if (!isRecord(data)) return data
  if (kind === 'draft') {
    if (!isRecord(data.world_return)) return data
    const worldReturn = select(data.world_return, worldFields)
    if (Array.isArray(data.world_return.attempts)) {
      worldReturn.attempts = data.world_return.attempts.flat().filter(isRecord).map(group => ({
        ...select(group, ['slot', 'people']),
        beats: Array.isArray(group.beats) ? group.beats.filter(isRecord).map(beat => select(beat, actorFields)) : []
      }))
    }
    return { ...data, world_return: worldReturn, ...(typeof currentInput === 'string' ? { current_input: currentInput } : {}) }
  }

  const { packs, beats } = data
  if (!Array.isArray(packs) || !Array.isArray(beats)) return data
  if (packs.length !== beats.length || packs.some((pack, index) => !isRecord(pack) || !Array.isArray(beats[index]))) {
    throw teamError('RP_TEAM_HANDOFF_REQUEST_INVALID', 'Each simulation review pack needs the corresponding array of beats')
  }
  return {
    ...data,
    precheck: packs.flatMap((pack, index) => simulationFindings(pack, beats[index])),
    packs: packs.map(pack => select(pack, ['slot', 'player', 'group', 'now', 'stimulus', 'relay', 'facing'])),
    beats: beats.map(group => group.map(beat => isRecord(beat) ? select(beat, [...actorFields, 'self_explanation']) : beat))
  }
}

/** Attach metadata for the exact facts under review, plus direct authorized causes for dialogue checks. */
export function scopedReviewEvidence(kind, message, { run, agent, stateStore }) {
  if (!isRecord(message?.data)) return []
  const facts = kind === 'draft' ? message.data.world_return?.established :
    (Array.isArray(message.data.packs) ? message.data.packs.flatMap(pack => Array.isArray(pack?.stimulus) ? pack.stimulus : []) : [])
  const ids = new Set((Array.isArray(facts) ? facts : []).map(fact => fact?.event).filter(id => typeof id === 'string' && id))
  if (!ids.size) return []
  const namespace = 'shared'
  const path = run.config.memory?.collections?.find(collection => collection.id === 'events' && collection.namespace === namespace)?.path
  if (!describeStateToolAccess(agent, run.config.state.definitions).some(access =>
    access.namespace === namespace && access.path === path && access.read)) return []
  const { value } = stateStore.read({ conversationId: run.conversationId, runId: run.runId, agentId: agent.id, namespace, path })
  const events = Array.isArray(value) ? value : []
  const matches = events.filter(event => event?.active !== false && ids.has(event?.id))
  const evidence = matches.map(event => ({
    ...select(event, ['id', 'storyTime', 'source', 'shown']),
    ...(Array.isArray(event.perceivers) ? { perceivers: event.perceivers.filter(isRecord)
      .map(perceiver => select(perceiver, ['who', 'how'])) } : {})
  }))
  if (kind !== 'draft' || !agent.execution?.livedHistoryDialoguePremises || agent.execution.livedHistoryIndependentPremises) return evidence
  const causalRefs = new Set(matches.flatMap(event => Array.isArray(event.because) ? event.because : []))
  for (const event of events) {
    if (event?.active === false || !causalRefs.has(event?.id) || ids.has(event.id) ||
      event.shown !== '已呈现' || typeof event.content !== 'string') continue
    evidence.push({ ...select(event, ['id', 'storyTime', 'source', 'shown', 'content']), relation: 'cause',
      ...(Array.isArray(event.perceivers) ? { perceivers: event.perceivers.filter(isRecord)
        .map(perceiver => select(perceiver, ['who', 'how'])) } : {}) })
  }
  return evidence
}

/** Facts from the ledger before this turn, confined to current references and their direct causes. */
export function scopedDraftPremiseEvidence(message, { run, agent, stateStore }) {
  if (!agent.execution?.livedHistoryIndependentPremises) return []
  const rows = message?.data?.world_return?.established
  const ids = new Set((Array.isArray(rows) ? rows : []).map(fact => fact?.event).filter(id => typeof id === 'string' && id))
  if (!ids.size) return []
  const namespace = 'shared'
  const path = run.config.memory?.collections?.find(collection => collection.id === 'events' && collection.namespace === namespace)?.path
  if (!path || !describeStateToolAccess(agent, run.config.state.definitions).some(access =>
    access.namespace === namespace && access.path === path && access.read)) return []
  const { state } = stateStore.status({ conversationId: run.conversationId, runId: run.runId })
  const baseValue = readPath(state?.[namespace], parsePointer(path) ?? [])
  if (baseValue === MISSING) return []
  const ledger = projectStateValueForAgent(agent, namespace, path, baseValue)
  if (!Array.isArray(ledger)) return []
  const eligible = event => isRecord(event) && event.active !== false && typeof event.content === 'string' &&
    !['正文越权', '摘要'].includes(event.source) &&
    (event.shown === '已呈现' || (event.source === '开卷' && event.shown === '未呈现' &&
      event.perceivers?.some(person => person?.how === '亲历' || person?.how === '目击')))
  const causes = new Set(ledger.filter(event => ids.has(event?.id) && eligible(event))
    .flatMap(event => Array.isArray(event.because) ? event.because : []))
  return ledger.filter(event => (ids.has(event?.id) || causes.has(event?.id)) && eligible(event)).map(event => ({
    ...select(event, ['id', 'storyTime', 'source', 'content', 'shown']),
    ...(Array.isArray(event.perceivers) ? { perceivers: event.perceivers.filter(isRecord)
      .map(perceiver => select(perceiver, ['who', 'how', 'what'])) } : {})
  }))
}

/** Only project cues from the file request used by the exact world result forwarded to this draft review. */
export function scopedDraftSceneEvidence(request, run) {
  if (request?.compactReview !== 'draft' || !request.worldReviewRequestId) return []
  const rows = run.handoffRequests ?? []
  const world = rows.find(row => row.requestId === request.worldReviewRequestId && row.handoffId === 'ask-world' &&
    row.status === 'completed' && row.from === request.from && row.sourceExecutionId === request.sourceExecutionId)
  if (!world?.targetExecutionId) return []
  const files = rows.filter(row => row.handoffId === 'ask-file' && row.status === 'completed' && row.from === world.to &&
    (world.worldReviewFileRequestId ? row.requestId === world.worldReviewFileRequestId : row.sourceExecutionId === world.targetExecutionId))
  if (files.length !== 1) return []
  const cues = files[0].request?.data?.sceneCues
  if (!Array.isArray(cues)) return []
  return cues.filter(cue => typeof cue?.content === 'string' && Array.isArray(cue.perceivers))
    .map(cue => ({ content: cue.content, perceivers: [...cue.perceivers] }))
}

/** A scoped negative verdict must identify a real problem and refer to the original draft. */
export function validateScopedReviewVerdict(request, verdict) {
  if (typeof verdict?.pass !== 'boolean' || !Array.isArray(verdict.issues)) {
    throw teamError('RP_TEAM_HANDOFF_RESPONSE_INVALID', 'Review must return pass and issues')
  }
  if (verdict.pass !== (verdict.issues.length === 0)) {
    throw teamError('RP_TEAM_HANDOFF_RESPONSE_INVALID', 'Review pass must be true exactly when issues is empty')
  }
  if (request.compactReview !== 'draft') return
  const draft = request.request?.data?.draft
  for (const issue of verdict.issues) {
    if (typeof issue?.quote !== 'string' || !issue.quote.trim() || typeof draft !== 'string' || !draft.includes(issue.quote)) {
      throw teamError('RP_TEAM_HANDOFF_RESPONSE_INVALID', 'Quote the exact words from the reviewed draft for each issue')
    }
  }
}

export function simulationFindings(pack, beats) {
  if (!isRecord(pack) || !Array.isArray(beats)) return []
  return beats.filter(isRecord).flatMap(beat => {
    const who = beat.who
    const report = (kind, note) => ({ who, kind, note })
    if (typeof who === 'string' && who === pack.player) {
      return [report('替用户角色写', '回执把用户角色列成了推演行动者。')]
    }
    if (typeof who !== 'string' || !Array.isArray(beat.grounds)) return []
    const actor = isRecord(pack.people) && Object.hasOwn(pack.people, who) ? pack.people[who] : {}
    const stimulus = new Set((Array.isArray(pack.stimulus) ? pack.stimulus : [])
      .filter(isRecord).map(item => item.event).filter(event => typeof event === 'string'))
    const sources = simulationEvidenceCatalog(actor, { includeSelf: Array.isArray(actor.ground_refs), stimulus: pack.stimulus })
    const refs = [...new Set(beat.grounds.map(ground => ground?.ref).filter(ref => typeof ref === 'string'))]
    const missing = refs.filter(ref => !sources.has(ref))
    const findings = missing.map(ref => report('依据不在材料包', `依据 ${ref} 不在 ${who} 的授权材料里。`))
    if (typeof beat.departs === 'string' && beat.departs.trim()) {
      const past = new Map()
      for (const ref of refs) {
        const source = sources.get(ref)
        if (!source?.historical || stimulus.has(source.origin)) continue
        const older = past.get(source.origin)
        if (!older || !older.time) past.set(source.origin, source)
      }
      const dated = new Set([...past.values()].map(source => source.time).filter(Boolean))
      const undated = [...past.values()].filter(source => !source.time).length
      if (dated.size + undated < 2) findings.push(report('背离缺依据', '背离需要来自至少两个时期的在先记录，本轮刺激不能充作先例。'))
    }
    return findings
  })
}

export function validateSimulationEvidence(pack, beats) {
  const findings = simulationFindings(pack, beats)
  if (findings.length) {
    throw teamError('RP_TEAM_SIMULATION_EVIDENCE_INVALID',
      `${findings.map(item => item.note).join(' ')} 只改 grounds 和依赖无效依据的部分，使用该人物材料包中的 ground_refs。`)
  }
}

export function enforceSimulationReview(data, findings) {
  if (!isRecord(data) || typeof data.pass !== 'boolean' || !Array.isArray(data.issues) || !findings?.length) return data
  const fixes = [...findings]
  for (const issue of data.issues) {
    if (!findings.some(item => issue?.kind === item.kind && issue?.who === item.who)) fixes.push(issue)
  }
  return { ...data, pass: false, issues: fixes }
}

function select(record, fields) {
  return Object.fromEntries(fields.filter(field => Object.hasOwn(record, field)).map(field => [field, record[field]]))
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
