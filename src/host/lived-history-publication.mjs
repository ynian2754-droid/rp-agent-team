import { teamError } from '../shared/schema.mjs'
import { parsePointer, readPath } from './handoff-refs.mjs'
import { describeStateToolAccess, versionForPath } from './state-store.mjs'
import { mergedDraftVerdict } from './communication.mjs'

const namespace = 'shared'
const ledgerPath = '/canon/events'
const candidates = new Set(['待呈现', '已呈现'])

export function draftPresentationParameter(passages = false) {
  return {
    type: 'array', required: true, items: {
      type: 'object', additionalProperties: false, properties: {
        event: { type: 'string', required: true },
        coverage: { type: 'string', required: true, enum: ['full', 'partial'] },
        ...(passages ? { passages: { type: 'array', required: true, items: { type: 'integer' } } }
          : { quotes: { type: 'array', required: true, items: { type: 'string' } } })
      }
    }
  }
}

export function writerPresentationParameter() {
  const { required: _required, ...parameter } = draftPresentationParameter()
  return { ...parameter, description: 'Optional event coverage from presentationCandidates. Use one to three short exact quotes from the draft per event.' }
}

export function worldPublicationOutcomes(writes) {
  return writes.filter(write => write.namespace === namespace && write.operation === 'memory.append' &&
    /^\/canon\/events\/\d+$/u.test(write.path) && write.value?.source !== '用户' &&
    write.value?.active !== false && candidates.has(write.value?.shown)).map(write => write.value.id)
}

function worldForReview(run, request) {
  return run.handoffRequests.find(row => row.requestId === request.worldReviewRequestId && row.handoffId === 'ask-world' &&
    row.status === 'completed' && row.from === request.from && row.sourceExecutionId === request.sourceExecutionId)
}

export function scopedDraftOutcomes(run, agent, stateStore, request) {
  if (!(request?.compactReview === 'draft' && agent.execution?.livedHistoryReviewPresentation &&
    agent.execution.livedHistoryDirectDraftReview)) return []
  const ids = worldForReview(run, request)?.publicationReview?.outcomeIds
  if (!ids?.length || !describeStateToolAccess(agent, run.config.state.definitions)
    .some(access => access.namespace === namespace && access.path === ledgerPath && access.read)) return []
  const { value: ledger } = stateStore.read({ conversationId: run.conversationId, runId: run.runId,
    agentId: agent.id, namespace, path: ledgerPath })
  const allowed = new Set(ids)
  return (ledger ?? []).filter(row => allowed.has(row?.id) && row.active !== false && candidates.has(row.shown) &&
    typeof row.content === 'string').map(row => ({ event: row.id, content: row.content }))
}

/** Expose only draft-eligible outcome records from the writer's completed world handoff. */
export function writerPresentationCandidates(run, writer, stateStore, world) {
  const ids = world?.publicationReview?.outcomeIds
  if (!ids?.length || !writer.execution?.livedHistoryWriterPresentation || world.from !== writer.id ||
    world.handoffId !== 'ask-world' || world.status !== 'completed' || !describeStateToolAccess(writer, run.config.state.definitions)
      .some(access => access.namespace === namespace && access.path === ledgerPath && access.read)) return []
  const { value: ledger } = stateStore.read({ conversationId: run.conversationId, runId: run.runId,
    agentId: writer.id, namespace, path: ledgerPath })
  const allowed = new Set(ids)
  return (ledger ?? []).filter(row => allowed.has(row?.id) && row.active !== false && candidates.has(row.shown) &&
    !['用户', '幕外'].includes(row.source) && typeof row.content === 'string')
    .map(row => ({ event: row.id, content: row.content }))
}

/** Bind an exact occurrence per proof. Drop ambiguous mappings without delaying truth review. */
export function bindWriterPresentation(outcomes, draft, presentation = []) {
  const proof = new Map()
  if (typeof draft !== 'string') return []
  for (const { event, content } of outcomes) {
    if (uniqueOccurrence(draft, content)) {
      proof.set(event, { event, coverage: 'full', quotes: [content], starts: [draft.indexOf(content)], exact: true })
      continue
    }
    const matching = presentation.filter(entry => entry?.event === event)
    if (matching.length !== 1) continue
    const { coverage, quotes } = matching[0]
    if (!['full', 'partial'].includes(coverage) || !Array.isArray(quotes) || !quotes.length || quotes.length > 4 ||
      new Set(quotes).size !== quotes.length || quotes.some(quote => !uniqueOccurrence(draft, quote))) continue
    proof.set(event, { event, coverage, quotes, starts: quotes.map(quote => draft.indexOf(quote)) })
  }
  return [...proof.values()]
}

/** Split at distinct clauses without repeating draft text in the review context. */
export function draftPassageChoices(draft, outcomes) {
  const choices = []
  for (const match of draft.matchAll(/[^\r\n]+/gu)) {
    const line = match[0]
    let start = 0
    for (const boundary of line.matchAll(/[。！？!?；;]+[」』”’）》】]*|(?<=[\p{L}\p{N}])，|[」』”](?=\s*(?:[^」』”\s。！？!?；;，、：:]|$))/gu)) {
      const end = boundary.index + boundary[0].length
      add(start, end)
      start = end
    }
    add(start, line.length)

    function add(from, to) {
      const slice = line.slice(from, to)
      const text = slice.trim()
      if (!text) return
      const offset = match.index + from + slice.indexOf(text)
      choices.push({ id: choices.length + 1, start: offset, text })
    }
  }
  const exact = new Map()
  for (const { event, content } of outcomes) {
    const start = draft.indexOf(content)
    if (start < 0 || draft.indexOf(content, start + 1) !== -1) continue
    const end = start + content.length
    const parts = choices.filter(choice => choice.start >= start && choice.start + choice.text.length <= end)
    if (parts[0]?.start === start && parts.at(-1).start + parts.at(-1).text.length === end) {
      exact.set(event, parts)
    }
  }
  return { choices, exact, outcomes: outcomes.filter(row => !exact.has(row.event)) }
}

export function validateDraftPresentation(outcomes, draft, presentation) {
  function invalid(message) { throw teamError('RP_TEAM_HANDOFF_RESPONSE_INVALID', message) }
  if (!Array.isArray(presentation)) invalid('Return presentation as an array alongside pass and issues')
  const remaining = new Set((outcomes ?? []).map(row => row.event))
  for (const entry of presentation) {
    if (!remaining.delete(entry.event)) invalid('Each presentation event must uniquely identify one supplied review_outcomes row')
    if (!entry.quotes.length || entry.quotes.some(quote => !quote.trim() || !draft.includes(quote))) {
      invalid('Every presentation quote must be an exact passage from the current draft')
    }
  }
  return { presentation }
}

export function resolveDraftPassageProofs(packet, presentation) {
  const fail = message => { throw teamError('RP_TEAM_HANDOFF_RESPONSE_INVALID', message) }
  if (!Array.isArray(presentation)) fail('Return presentation as an array alongside pass and issues')
  if (!packet && !presentation.length) return { presentation: [] }
  if (!packet) fail('This review has no numbered draft passages')
  const events = new Set(packet.outcomes.map(row => row.event))
  const choices = new Map(packet.choices.map(choice => [choice.id, choice]))
  const proof = presentation.map(({ event, coverage, passages }) => {
    if (!events.delete(event)) fail('Each presentation event must uniquely identify a supplied review_outcomes row')
    if (!passages.length || new Set(passages).size !== passages.length || passages.some(id => !choices.has(id))) {
      fail('Use only distinct passage numbers from this draft’s review_passages')
    }
    return evidence(event, coverage, passages.map(id => choices.get(id)))
  })
  for (const [event, parts] of packet.exact) proof.push(evidence(event, 'full', parts))
  return { presentation: proof }

  function evidence(event, coverage, parts) {
    return { event, coverage, quotes: parts.map(part => part.text), starts: parts.map(part => part.start) }
  }
}

/** Narrow update of new outcome presentation status using proof from the actual publication. */
export function publicationLedgerTargets({ run, stateStore, executionId }) {
  const publisher = run.publication.agentId
  const writerMode = run.config.agents.find(agent => agent.id === publisher)?.execution?.livedHistoryWriterPresentation
  const reviews = run.handoffRequests.filter(row => row.handoffId === 'check-draft' && row.compactReview === 'draft' &&
    row.from === publisher && row.sourceExecutionId === executionId && (writerMode ? row.writerPresentation !== undefined &&
      (run.publication.reviewRef === undefined || row.ref === run.publication.reviewRef) : run.config.agents.some(agent => agent.id === row.to &&
      agent.execution?.livedHistoryReviewPresentation && agent.execution.livedHistoryDirectDraftReview)))
  const review = reviews.at(-1)
  if (!review && !writerMode) return []
  const worlds = run.handoffRequests.filter(row => row.handoffId === 'ask-world' && row.from === publisher &&
    row.sourceExecutionId === executionId && row.status === 'completed' && row.publicationReview?.outcomeIds?.length)
  if (!worlds.length) return []

  const scopedWorld = worlds.find(row => row.requestId === review?.worldReviewRequestId)
  const reviewed = (review?.mergedDraftReview ? !review.mergedDraftReview.incomplete : review?.status === 'completed') && scopedWorld
  const numbered = run.config.agents.find(agent => agent.id === review?.to)?.execution?.livedHistoryPassageChoices
  const proof = new Map((reviewed ? (writerMode ? review.writerPresentation : review.publicationReview?.presentation) ?? [] : [])
    .map(entry => [entry.event, entry]))
  const verdict = mergedDraftVerdict(review)
  const rejected = verdict?.pass === false ? verdict.issues : []
  const draft = review?.request?.data?.draft
  const body = run.publication.body
  const ledgerSegments = parsePointer(ledgerPath)
  const input = { conversationId: run.conversationId, runId: run.runId }
  const { writes } = stateStore.status(input)
  const ledger = readPath(stateStore.snapshot(input)[namespace], ledgerSegments)
  if (!Array.isArray(ledger)) return []
  const versions = stateStore.versionsSnapshot(input)
  const fresh = new Set(writes.filter(write => write.namespace === namespace && /^\/canon\/events\/\d+$/u.test(write.path))
    .map(write => write.value?.id))
  const byId = new Map(ledger.map((row, index) => [row?.id, { row, index }]))
  const rejectedText = rejected.map(issue => issue.quote)
  const ungroundedClaimRejected = writerMode && rejected.some(issue => issue.kind === '未确立的事')
  const targets = []
  for (const world of (scopedWorld ? [scopedWorld, ...worlds.filter(row => row !== scopedWorld)] : worlds)) {
    for (const event of world.publicationReview.outcomeIds) {
      const current = byId.get(event)
      if (!fresh.delete(event) || !current || current.row.active === false || !candidates.has(current.row.shown)) continue
      const { row, index } = current
      const entry = world === scopedWorld ? proof.get(event) : undefined
      const quotes = entry?.quotes ?? (!writerMode && !numbered && reviewed && world === scopedWorld && typeof row.content === 'string' &&
        draft.includes(row.content) ? [row.content] : [])
      const retained = quotes.filter((quote, index) => {
        const start = entry?.starts?.[index]
        return body.includes(quote) && (start === undefined || countOccurrences(body, quote) >= countOccurrences(draft, quote)) &&
          !rejectedText.some(text => draftSpansOverlap(draft, start ?? draft.indexOf(quote), quote.length, text))
      }).length
      let shown = retained === 0 && !(reviewed && world === scopedWorld) && row.shown === '待呈现' ? '待呈现' : '未呈现'
      const exactFinal = writerMode && reviewed && world === scopedWorld && row.source !== '幕外' &&
        uniqueOccurrence(body, row.content) && !rejectedText.some(quote => row.content.includes(quote) || quote.includes(row.content))
      if (exactFinal) shown = '已呈现'
      else if (retained) {
        const full = retained === quotes.length && entry?.coverage !== 'partial' && (!ungroundedClaimRejected || entry?.exact)
        shown = full ? '已呈现' : '仅痕迹'
      }
      if (shown !== row.shown) {
        const path = `${ledgerPath}/${index}/shown`
        targets.push({ agentId: world.to, event, from: row.shown, shown, target: {
          namespace, path, value: shown, expectedVersion: versionForPath(versions, namespace, path)
        } })
      }
    }
  }
  return targets
}

function uniqueOccurrence(body, quote) {
  return typeof quote === 'string' && Boolean(quote.trim()) && countOccurrences(body, quote) === 1
}

function countOccurrences(body, text) {
  let count = 0
  for (let offset = body.indexOf(text); offset !== -1; offset = body.indexOf(text, offset + 1)) count++
  return count
}

function draftSpansOverlap(draft, start, length, rejected) {
  for (let offset = draft.indexOf(rejected); offset !== -1; offset = draft.indexOf(rejected, offset + 1)) {
    if (start < offset + rejected.length && offset < start + length) return true
  }
  return false
}
