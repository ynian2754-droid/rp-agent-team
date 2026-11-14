import assert from 'node:assert/strict'
import test from 'node:test'
import { bindWriterPresentation, draftPassageChoices, publicationLedgerTargets, resolveDraftPassageProofs, scopedDraftOutcomes,
  validateDraftPresentation, worldPublicationOutcomes, writerPresentationCandidates } from '../src/host/lived-history-publication.mjs'

const namespace = 'shared'
const path = '/canon/events'
const final = '「留下。」她说。她把茶杯搁下。楼上没有声音。'
const rejected = '「两年前那张表，监护人那一栏是你签的字。」'
const original = final + rejected

function fixture({ body = final, status = 'completed', binding = 'world-request', pass = false } = {}) {
  const checker = { id: 'checker', execution: { livedHistoryReviewPresentation: true, livedHistoryDirectDraftReview: true },
    statePermissions: [{ namespace, path, access: 'read' }] }
  const ledger = [
    { id: 'old', source: '裁定', shown: '已呈现', content: '此前的事件。' },
    { id: 'new-input', source: '用户', shown: '已呈现', content: '你要我走吗？' },
    { id: 'mixed', source: '裁定', shown: '已呈现', content: '星凛要他留下，提到表上的签名。', because: ['new-input'] },
    { id: 'cup', source: '裁定', shown: '待呈现', content: '星凛把茶放到桌上。', because: ['mixed'] },
    { id: 'floor', source: '幕外', shown: '未呈现', content: '吴老师在准备明天的事。' },
    { id: 'signature', source: '裁定', shown: '已呈现', content: '她提到两年前他签过表。' },
    { id: 'unquoted', source: '裁定', shown: '已呈现', content: '她看了窗外。' },
    { id: 'trace', source: '裁定', shown: '仅痕迹', content: '窗外投进一束光。' },
    { id: 'literal', source: '裁定', shown: '待呈现', content: '楼上没有声音。' }
  ]
  const writes = ledger.slice(1).map((value, index) => ({ value, namespace, operation: 'memory.append', path: `${path}/${index + 1}` }))
  const world = { requestId: 'world-request', handoffId: 'ask-world', from: 'writer', to: 'world', sourceExecutionId: 'write1', status: 'completed',
    publicationReview: { outcomeIds: worldPublicationOutcomes(writes) } }
  const presentation = [{ event: 'mixed', coverage: 'full', quotes: ['「留下。」她说。', '那一栏是你签的字'] },
    { event: 'cup', coverage: 'full', quotes: ['她把茶杯搁下。'] },
    { event: 'signature', coverage: 'full', quotes: [rejected] }]
  const review = { requestId: 'review-request', handoffId: 'check-draft', compactReview: 'draft', from: 'writer', to: 'checker',
    sourceExecutionId: 'write1', worldReviewRequestId: binding, status,
    request: { data: { draft: original } }, result: { data: { pass, issues: pass ? [] : [{ quote: rejected }] } },
    publicationReview: { presentation } }
  const run = { conversationId: 'conversation', runId: 'run', handoffRequests: [world, review], config: {
    agents: [checker], state: { definitions: [{ namespace, path }] }
  }, publication: { agentId: 'writer', body } }
  const stateStore = { read: () => ({ value: ledger }), status: () => ({ writes }),
    snapshot: () => ({ shared: { canon: { events: ledger } } }), versionsSnapshot: () => ({ '["shared","/canon/events/2"]': 6 }) }
  const targets = () => publicationLedgerTargets({ run, stateStore, executionId: 'write1' })
  return { checker, ledger, review, run, stateStore, targets, world }
}

test('scoped checker mapping only uses active new world outcomes readable by this checker', () => {
  const { checker, review, run, stateStore } = fixture()
  const entries = scopedDraftOutcomes(run, checker, stateStore, review)
  assert.deepEqual(entries.map(entry => entry.event), ['mixed', 'cup', 'signature', 'unquoted', 'literal'])
  assert.ok(!Object.hasOwn(entries[0], 'because'))
  assert.deepEqual(validateDraftPresentation(entries, original, review.publicationReview.presentation), review.publicationReview)
  assert.deepEqual(validateDraftPresentation([], original, []), { presentation: [] })
  assert.throws(() => validateDraftPresentation(entries, original, [{ event: 'old', coverage: 'full', quotes: [rejected] }]),
    { code: 'RP_TEAM_HANDOFF_RESPONSE_INVALID' })
  assert.throws(() => validateDraftPresentation(entries, original, [{ event: 'mixed', coverage: 'full', quotes: ['改述签名'] }]),
    { code: 'RP_TEAM_HANDOFF_RESPONSE_INVALID' })
  assert.throws(() => validateDraftPresentation(entries, original, [{ event: 'mixed', coverage: 'full', quotes: [] }]),
    { code: 'RP_TEAM_HANDOFF_RESPONSE_INVALID' })
  assert.deepEqual(scopedDraftOutcomes(run, { ...checker, statePermissions: [] }, {
    read: () => assert.fail('No ledger reads without permission')
  }, review), [])
})

test('a mixed outcome becomes a trace and a rejected-only outcome becomes unseen in the actual edited publication', () => {
  const { ledger, targets } = fixture()
  const changes = targets()
  assert.deepEqual(changes.map(({ agentId, event, shown }) => [agentId, event, shown]), [
    ['world', 'mixed', '仅痕迹'], ['world', 'cup', '已呈现'], ['world', 'signature', '未呈现'],
    ['world', 'unquoted', '未呈现'], ['world', 'literal', '已呈现']
  ])
  assert.deepEqual(changes[0].target, { namespace, path: `${path}/2/shown`, value: '仅痕迹', expectedVersion: 6 })
  assert.deepEqual(ledger[2].because, ['new-input'])
  assert.equal(ledger[2].content, '星凛要他留下，提到表上的签名。')
  assert.ok(changes.every(change => change.target.path.endsWith('/shown')))
})

test('approved paraphrases and exact matches can prove full coverage; partial proof stays a trace', () => {
  const { review, targets } = fixture({ body: original, pass: true })
  review.publicationReview.presentation[1].coverage = 'partial'
  assert.deepEqual(targets().map(({ event, shown }) => [event, shown]), [
    ['cup', '仅痕迹'], ['unquoted', '未呈现'], ['literal', '已呈现']
  ])
})

test('no reference or failed review prevents promotion of ledger rows even with incidental exact matches', () => {
  for (const opts of [{ binding: 'unrelated' }, { status: 'failed' }]) {
    assert.deepEqual(fixture(opts).targets().map(({ event, shown }) => [event, shown]), [
      ['mixed', '未呈现'], ['signature', '未呈现'], ['unquoted', '未呈现']
    ])
  }
  const { checker, targets } = fixture()
  checker.execution.livedHistoryReviewPresentation = false
  assert.deepEqual(targets(), [])
})

test('a rejected quote cannot be marked as shown by reposting it in the final body', () => {
  const { targets } = fixture({ body: original })
  assert.deepEqual(targets().filter(change => ['mixed', 'signature'].includes(change.event)).map(({ event, shown }) => [event, shown]), [
    ['mixed', '仅痕迹'], ['signature', '未呈现']
  ])
})

test('numbered passages preserve exact excerpts, isolate distinct clauses, and never prebind ambiguous or paraphrased outcomes', () => {
  const draft = '星凛说「留下」。\r\n\r\n她把茶杯搁下。 她说两年前你签过字，推来碟子。\n\n走廊安静。走廊安静。'
  const outcomes = [
    { event: 'exact', content: '她把茶杯搁下。' },
    { event: 'ambiguous', content: '走廊安静。' },
    { event: 'paraphrase', content: '星凛把点心递到面前。' }
  ]
  const packet = draftPassageChoices(draft, outcomes)
  assert.deepEqual(packet.choices.map(({ text }) => text), ['星凛说「留下」。', '她把茶杯搁下。', '她说两年前你签过字，',
    '推来碟子。', '走廊安静。', '走廊安静。'])
  for (const { start, text } of packet.choices) assert.equal(draft.slice(start, start + text.length), text)
  assert.deepEqual(packet.outcomes.map(({ event }) => event), ['ambiguous', 'paraphrase'])
  assert.deepEqual(resolveDraftPassageProofs(packet, [{ event: 'paraphrase', coverage: 'partial', passages: [4] }]).presentation
    .map(({ event, coverage, quotes }) => [event, coverage, quotes]), [
    ['paraphrase', 'partial', ['推来碟子。']], ['exact', 'full', ['她把茶杯搁下。']]
  ])
  for (const entry of [{ event: 'paraphrase', passages: [99] }, { event: 'paraphrase', passages: [5, 5] },
    { event: 'unrelated', passages: [5] }, { event: 'exact', passages: [3] }, { event: 'paraphrase', passages: [] }]) {
    assert.throws(() => resolveDraftPassageProofs(packet, [{ ...entry, coverage: 'full' }]), { code: 'RP_TEAM_HANDOFF_RESPONSE_INVALID' })
  }
})

test('numbered confirmation uses actual final body and excludes only passages overlapping rejection', () => {
  const { checker, review, run, targets } = fixture()
  checker.execution.livedHistoryPassageChoices = true
  review.request.data.draft = '她说「你签过字。」她说「留下。」她又说「留下」。'
  run.publication.body = '她说「留下。」她又说「留下」。'
  review.result.data.issues = [{ quote: '「你签过字。」' }]
  const packet = draftPassageChoices(review.request.data.draft, [{ event: 'mixed', content: '星凛要他留下，提到表上的签名。' }])
  const selected = packet.choices.filter(({ text }) => text.includes('你签过字') || text.includes('留下。')).map(({ id }) => id)
  review.publicationReview = resolveDraftPassageProofs(packet, [{ event: 'mixed', coverage: 'full', passages: selected }])
  assert.equal(targets().find(({ event }) => event === 'mixed').shown, '仅痕迹')
  run.publication.body = '她又说「留下」。'
  assert.equal(targets().find(({ event }) => event === 'mixed').shown, '未呈现')
})

function writerFixture(options) {
  const { ledger, review, run, stateStore, world, targets } = fixture(options)
  const writer = { id: 'writer', execution: { livedHistoryWriterPresentation: true },
    statePermissions: [{ namespace, path, access: 'read' }] }
  run.config.agents.push(writer)
  const outcomes = writerPresentationCandidates(run, writer, stateStore, world)
  review.writerPresentation = bindWriterPresentation(outcomes, original, review.publicationReview.presentation)
  delete review.publicationReview
  return { ledger, review, run, stateStore, world, targets, writer, outcomes }
}

test('writer receives exact cited outcomes only, with once-bound quotes and no old or secret material', () => {
  const { outcomes, run, world, stateStore, writer } = writerFixture()
  assert.deepEqual(outcomes.map(row => row.event), ['mixed', 'cup', 'signature', 'unquoted', 'literal'])
  assert.deepEqual(writerPresentationCandidates(run, writer, stateStore, { ...world, from: 'other' }), [])
  assert.deepEqual(writerPresentationCandidates(run, { ...writer, statePermissions: [] }, {
    read: () => assert.fail('No ledger read without permission')
  }, world), [])
  const malformed = [{ event: 'old', coverage: 'full', quotes: ['她把茶杯搁下。'] },
    { event: 'cup', coverage: 'full', quotes: ['不是原文'] },
    { event: 'mixed', coverage: 'full', quotes: ['留下', '留下'] }]
  assert.deepEqual(bindWriterPresentation(outcomes, original, malformed).map(({ event, exact }) => [event, exact]), [['literal', true]])
  assert.deepEqual(bindWriterPresentation(outcomes, original + '楼上没有声音。留下', malformed), [])
})

test('writer proof survives approval and unrelated style edits; missing and overlapping proof degrade conservatively', () => {
  const approved = writerFixture({ body: original, pass: true })
  assert.deepEqual(approved.targets().map(({ event, shown }) => [event, shown]), [
    ['cup', '已呈现'], ['unquoted', '未呈现'], ['literal', '已呈现']
  ])
  const edited = writerFixture()
  assert.deepEqual(edited.targets().map(({ event, shown }) => [event, shown]), [
    ['mixed', '仅痕迹'], ['cup', '已呈现'], ['signature', '未呈现'], ['unquoted', '未呈现'], ['literal', '已呈现']
  ])
  edited.review.writerPresentation[0] = { event: 'mixed', coverage: 'full', quotes: ['「留下。」她说。'], starts: [0] }
  edited.review.result.data.issues[0].kind = '未确立的事'
  assert.equal(edited.targets().find(({ event }) => event === 'mixed').shown, '仅痕迹')
  assert.equal(edited.targets().find(({ event }) => event === 'literal').shown, '已呈现')
  edited.run.publication.body = '她把茶杯搁下。'
  assert.equal(edited.targets().find(({ event }) => event === 'mixed').shown, '未呈现')
})

test('writer fallback leaves pending outcomes pending and review proof cannot escape its assigned review', () => {
  const { review, targets, run } = writerFixture({ status: 'failed' })
  assert.deepEqual(targets().map(({ event, shown }) => [event, shown]), [
    ['mixed', '未呈现'], ['signature', '未呈现'], ['unquoted', '未呈现']
  ])
  review.status = 'completed'
  review.ref = 'check-draft#1'
  run.publication.reviewRef = 'check-draft#2'
  assert.deepEqual(targets().map(({ event, shown }) => [event, shown]), [
    ['mixed', '未呈现'], ['signature', '未呈现'], ['unquoted', '未呈现']
  ])
})

test('writer ledger applies the complete merged report even when the primary lane passed', () => {
  const { review, targets } = writerFixture({ pass: true })
  review.mergedDraftReview = { verdict: { pass: false, issues: [{ kind: '未确立的事', quote: rejected }] }, incomplete: false }
  assert.equal(targets().find(({ event }) => event === 'mixed').shown, '仅痕迹')
  assert.equal(targets().find(({ event }) => event === 'signature').shown, '未呈现')
  review.mergedDraftReview.incomplete = true
  assert.ok(!targets().some(({ event }) => event === 'cup'))
})
