import { teamError } from '../shared/schema.mjs'
import { createMemoryRecord } from './memory-tools.mjs'
import { describeStateToolAccess, versionForPath } from './state-store.mjs'

const namespace = 'shared'
const eventPath = '/canon/events'
const paths = {
  events: eventPath, world: '/canon/world', hidden: '/canon/hidden',
  situations: '/situations', selves: '/selves', memories: '/memories', practices: '/practices',
  readings: '/readings', storyNotes: '/story/notes', direction: '/story/direction',
  packs: '/story/packs', settingsLog: '/story/settings-log'
}
const summaryKeys = new Set(['practices', 'readings', 'storyNotes'])
const noteKeys = new Set(['threads', 'clocks_near', 'rhythm', 'bridging', 'audit', 'style_patterns'])
const visibleStatuses = new Set(['已呈现', '仅痕迹'])
const recordSources = new Set(['正文', '正文越权', '摘要'])
const textList = { type: 'array', items: { type: 'string' } }
const requiredText = { type: 'string', required: true }
const stateObject = properties => ({ type: 'object', additionalProperties: false, properties })

export const chronicleProvenanceData = {
  ...stateObject({
    state: { ...stateObject({
      practices: { type: 'object', additionalProperties: true },
      readings: { type: 'object', additionalProperties: true },
      storyNotes: stateObject({
        threads: { type: 'array' }, clocks_near: textList, rhythm: { type: 'string' },
        bridging: { type: 'string' }, audit: { type: 'array' }, style_patterns: { type: 'array' }
      })
    }), required: true },
    events: { type: 'array', required: true, items: {
      ...stateObject({
        op: { ...requiredText, enum: ['add', 'shown', 'archive'] },
        key: { type: 'string' }, id: { type: 'string' },
        value: { type: 'string', enum: ['已呈现', '仅痕迹'] },
        sourceId: { type: 'string', description: 'For a transcript, the id of the published passage supplied by the host.' },
        quote: { type: 'string', description: 'For a transcript, a verbatim passage. It becomes the event content.' },
        record: stateObject({
          source: { ...requiredText, enum: [...recordSources] },
          content: { type: 'string', description: 'Only a summary writes its own content. A transcript uses quote.' },
          storyTime: requiredText, people: { ...textList, required: true }, tags: textList,
          perceivers: { type: 'array', required: true, items: stateObject({
            who: requiredText, how: requiredText, what: { type: 'string' }
          }) },
          weight: { ...requiredText, enum: ['寻常', '要紧', '转折'] }, because: textList,
          changed: { type: 'string' }, covers: textList
        })
      })
    } }
  }),
  required: true
}

function invalid(message) { throw teamError('RP_TEAM_CHRONICLE_INVALID', message) }
function isRecord(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) }
function escapeSegment(value) { return value.replace(/~/gu, '~0').replace(/\//gu, '~1') }
function hasId(row) { return isRecord(row) && typeof row.id === 'string' && row.id.length > 0 }

function stateArgs({ run, agent }) {
  return { conversationId: run.conversationId, runId: run.runId, agentId: agent.id, namespace }
}

/** Attach the ACL-filtered view once, leaving underlying event positions and versions out of the prompt. */
export function createChronicleSource({ run, agent, stateStore }) {
  const readable = new Set(describeStateToolAccess(agent, run.config.state.definitions)
    .filter(row => row.namespace === namespace && row.read).map(row => row.path))
  const target = stateArgs({ run, agent })
  const context = {}
  for (const [key, path] of Object.entries(paths)) {
    if (!readable.has(path)) continue
    const { value } = stateStore.read({ ...target, path })
    if (value !== undefined) context[key] = value
  }
  const events = context.events ?? []
  if (Array.isArray(context.events)) {
    const active = events.filter(row => hasId(row) && row.active !== false)
    context.events = active
  }
  return { context, events, versions: stateStore.versionsSnapshot(target) }
}

/** Turn the chronologist's one submission into disjoint, CAS-checked journal writes. */
export function chronicleTargets({ source, data, run, agent, stateStore }) {
  if (!source || !isRecord(data) || !isRecord(data.state) || !Array.isArray(data.events)) {
    invalid('Submit data with a state object and an events array')
  }
  if (data.events.length > 8) invalid('Submit at most eight event operations')
  if (Object.keys(data.state).some(key => !summaryKeys.has(key))) invalid('State may contain only practices, readings and storyNotes')
  const writes = []
  const target = stateArgs({ run, agent })
  const write = (path, value, versions = source.versions) => writes.push({
    namespace, path, value, expectedVersion: versionForPath(versions, namespace, path)
  })
  const newIds = new Map()
  const created = new Map()
  const shown = new Map()
  const archives = new Set()
  const issues = []
  const clocks = data.state.storyNotes?.clocks_near
  if (clocks !== undefined && (!Array.isArray(clocks) || clocks.some(value => typeof value !== 'string'))) {
    issues.push('state.storyNotes.clocks_near must be an array of strings')
  }
  for (const [index, op] of data.events.entries()) {
    if (op?.op !== 'add') continue
    const row = op.record
    if (!isRecord(row) || !recordSources.has(row.source) || Object.hasOwn(row, 'active') ||
        (source.publishedSources === undefined && !visibleStatuses.has(row.shown))) {
      issues.push(`events[${index}].record must be a presented transcript or summary with host-managed identity and activity`)
    }
    if (source.publishedSources !== undefined && isRecord(row) && ['正文', '正文越权'].includes(row.source)) {
      const passage = source.publishedSources.find(entry => entry.id === op.sourceId)
      if (!passage || typeof op.quote !== 'string' || !op.quote.trim() || !passage.text.includes(op.quote)) {
        issues.push(`events[${index}] must cite sourceId and quote an exact passage from its published assistant text`)
      }
    }
  }
  if (issues.length) invalid(issues.join('; '))
  if (data.events.length) {
    if (!Array.isArray(source.context.events)) invalid('No readable events collection is available')
    for (const [index, op] of data.events.entries()) {
      if (!isRecord(op) || !['add', 'shown', 'archive'].includes(op.op)) invalid(`events[${index}] must be add, shown, or archive`)
      if (op.op === 'add') {
        const row = op.record
        const record = source.publishedSources === undefined ? row : {
          ...row,
          ...(row.source !== '摘要' ? { content: op.quote } : {}),
          shown: '已呈现'
        }
        const item = createMemoryRecord(record)
        if (op.key !== undefined) {
          if (typeof op.key !== 'string' || !op.key.trim() || newIds.has(op.key)) invalid(`events[${index}] needs a unique nonempty key`)
          newIds.set(op.key, item.id)
        }
        created.set(index, item)
      } else if (op.op === 'shown') {
        if (!visibleStatuses.has(op.value) || shown.has(op.id)) invalid(`events[${index}] needs one presented/trace status for an event`)
        shown.set(op.id, op.value)
      } else {
        if (archives.has(op.id)) invalid(`events[${index}] repeats an archive`)
        archives.add(op.id)
      }
    }
    const latest = stateStore.read({ ...target, path: eventPath }).value
    if (!Array.isArray(latest)) invalid('The events collection is unavailable')
    const currentVersions = stateStore.versionsSnapshot(target)
    const locate = id => {
      const matches = source.events.flatMap((row, index) => hasId(row) && row.id === id && row.active !== false ? [index] : [])
      if (matches.length !== 1 || latest[matches[0]]?.id !== id || latest[matches[0]]?.active === false) {
        invalid('Use the ID of an active event from this activation')
      }
      return matches[0]
    }
    const summaries = new Set(source.events.filter(row => hasId(row) && row.active !== false && row.source === '摘要' &&
        !archives.has(row.id) && latest.some(item => item?.id === row.id && item.active !== false && item.source === '摘要' &&
          JSON.stringify(item.covers) === JSON.stringify(row.covers)))
      .flatMap(row => Array.isArray(row.covers) ? row.covers : []))
    let append = latest.length
    const transcriptKey = ({ storyTime, content }) => JSON.stringify([storyTime, content])
    const recordedText = new Set(latest.filter(row => hasId(row) && row.active !== false).map(transcriptKey))
    for (const item of created.values()) {
      const value = expandEventRefs(item, newIds)
      if (value.source === '摘要') {
        if (!Array.isArray(value.covers) || !value.covers.length || new Set(value.covers).size !== value.covers.length ||
            typeof value.content !== 'string' || [...value.content].length > 200) invalid('A summary needs distinct active event IDs and at most 200 characters')
        for (const id of value.covers) {
          locate(id)
          summaries.add(id)
        }
      } else {
        if (Object.hasOwn(value, 'covers')) invalid('Only summaries may cover earlier events')
        if (source.publishedSources !== undefined && recordedText.has(transcriptKey(value))) {
          invalid('This exact transcript is already in the event ledger; reuse its existing ID')
        }
        recordedText.add(transcriptKey(value))
      }
      write(`${eventPath}/${append++}`, value, currentVersions)
    }
    for (const [id, value] of shown) {
      const index = locate(id)
      if (latest[index].shown !== value) write(`${eventPath}/${index}/shown`, value)
    }
    for (const id of archives) {
      const index = locate(id)
      const row = latest[index]
      if (row.weight === '转折' || !visibleStatuses.has(shown.get(id) ?? row.shown) || !summaries.has(id)) {
        invalid('Archive only a presented non-turning event covered by an active summary')
      }
      write(`${eventPath}/${index}/active`, false)
    }
  }
  for (const [kind, changes] of Object.entries(data.state)) {
    if (!isRecord(changes) || !Object.hasOwn(source.context, kind)) invalid(`Provide accessible named changes for ${kind}`)
    for (const [key, value] of Object.entries(changes)) {
      if (!key.trim() || /^\d+$/u.test(key) || (kind === 'storyNotes' && !noteKeys.has(key)) ||
          (kind === 'practices' && !Array.isArray(value)) || (kind === 'readings' && !isRecord(value))) {
        invalid(`Invalid ${kind} change for ${key}`)
      }
      write(`${paths[kind]}/${escapeSegment(key)}`, expandEventRefs(value, newIds))
    }
  }
  return writes
}

function expandEventRefs(value, ids) {
  if (Array.isArray(value)) return value.map(item => expandEventRefs(item, ids))
  if (!isRecord(value)) return value
  if (Object.keys(value).length === 1 && Object.hasOwn(value, '$event')) {
    if (!ids.has(value.$event)) invalid('Use a declared local event key in $event')
    return ids.get(value.$event)
  }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, expandEventRefs(item, ids)]))
}
