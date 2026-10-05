import { teamError } from './run-state.mjs'

const SOURCE_KEYS = Object.freeze({
  current_input: ['current_input', 'currentInput', 'currentUserMessage'],
  recent_history: ['recent_history', 'recentHistory'],
  full_history: ['full_history', 'fullHistory', 'history'],
  character_card: ['character_card', 'characterCard', 'character'],
  worldbook: ['worldbook', 'worldBook', 'worldbookEntries', 'settingSources'],
  long_memory: ['long_memory', 'longMemory'],
  scene_state: ['scene_state', 'sceneState'],
  agent_messages: ['agent_messages', 'agentMessages', 'messages'],
  drafts: ['drafts'],
  hidden_state: ['hidden_state', 'hiddenState']
})

/** Materializes only the context categories explicitly selected for one agent. */
export function buildAgentContext(agent, availableSources, { messages = [], drafts = [] } = {}) {
  const sources = {}
  const categories = []
  const projections = new Map()
  const seenSelections = new Map()
  const selectionCounts = new Map()
  for (const selection of agent.context.sources) {
    const category = selection.type
    const key = JSON.stringify(selection)
    const seen = seenSelections.get(category) ?? new Set()
    if (seen.has(key)) continue
    seen.add(key)
    seenSelections.set(category, seen)
    selectionCounts.set(category, (selectionCounts.get(category) ?? 0) + 1)
    const base = category === 'agent_messages' ? filterMessages(agent, messages, selection.agentIds)
      : category === 'drafts' ? filterDrafts(agent, drafts, selection.agentIds)
        : { value: readSource(availableSources, category), origin: readSource(availableSources, category) }
    let value = selection.selector !== undefined ? selectPointer(base.value, selection.selector) : base.value
    const selectorSegments = selection.selector ? pointerSegments(selection.selector) : []
    const sourceSegments = [...selectorSegments]
    if (base.sourceIndexes && sourceSegments.length && /^\d+$/u.test(sourceSegments[0])) {
      const sourceIndex = base.sourceIndexes[Number(sourceSegments[0])]
      if (sourceIndex !== undefined) sourceSegments[0] = String(sourceIndex)
    }
    let arrayIndexes
    if (Array.isArray(value) && (selection.limit !== undefined || (!selectorSegments.length && base.sourceIndexes))) {
      const start = selection.limit === undefined ? 0
        : category === 'recent_history' ? Math.max(0, value.length - selection.limit) : 0
      const end = selection.limit === undefined ? value.length : Math.min(value.length, start + selection.limit)
      const logicalIndexes = Array.from({ length: Math.max(0, end - start) }, (_unused, offset) => start + offset)
      arrayIndexes = !selectorSegments.length && base.sourceIndexes
        ? logicalIndexes.map(index => base.sourceIndexes[index])
        : logicalIndexes
    }
    if (selection.limit !== undefined) value = applyLimit(value, selection.limit, category)
    if (value === undefined) continue
    const selected = projections.get(category) ?? []
    selected.push({ selector: selection.selector ?? '', sourceSegments, value, origin: base.origin, arrayIndexes })
    projections.set(category, selected)
    if (!categories.includes(category)) categories.push(category)
  }
  for (const [category, selected] of projections) {
    sources[category] = selectionCounts.get(category) === 1
      ? structuredClone(selected[0].value)
      : mergeSelectedPaths(selected)
  }
  return { agentId: agent.id, sources, categories }
}

function mergeSelectedPaths(selected) {
  let result
  let initialized = false
  for (const { sourceSegments, value, arrayIndexes, origin } of selected) {
    const segments = sourceSegments
    const positionedValue = arrayIndexes ? preserveArrayIndexes(value, arrayIndexes) : value
    if (!initialized) {
      result = segments.length ? containerFor(origin, '') : structuredClone(positionedValue)
      initialized = true
    }
    result = insertProjection(result, segments, positionedValue, origin, '')
  }
  return result
}

function insertProjection(current, segments, value, origin, originPath) {
  if (!segments.length) return mergeProjection(current, value, origin, originPath)
  const [segment, ...rest] = segments
  const container = Array.isArray(current) || isRecord(current) ? current : containerFor(origin, originPath)
  const key = Array.isArray(container) ? arrayIndex(segment) : segment
  const childPath = `${originPath}/${escapePointer(segment)}`
  const child = Object.hasOwn(container, key) ? container[key] : containerFor(origin, childPath)
  const projected = insertProjection(child, rest, value, origin, childPath)
  Object.defineProperty(container, key, { value: projected, enumerable: true, configurable: true, writable: true })
  return container
}

function mergeProjection(previous, next, origin, originPath) {
  if (previous === undefined) return structuredClone(next)
  if (Array.isArray(previous) && Array.isArray(next)) {
    const result = new Array(Math.max(previous.length, next.length))
    for (let index = 0; index < result.length; index += 1) {
      const hasPrevious = Object.hasOwn(previous, index)
      const hasNext = Object.hasOwn(next, index)
      if (hasPrevious && hasNext) {
        result[index] = mergeProjection(previous[index], next[index], origin, `${originPath}/${index}`)
      } else if (hasPrevious) result[index] = structuredClone(previous[index])
      else if (hasNext) result[index] = structuredClone(next[index])
    }
    return result
  }
  if (isRecord(previous) && isRecord(next)) {
    const result = {}
    for (const key of new Set([...Object.keys(previous), ...Object.keys(next)])) {
      const hasPrevious = Object.hasOwn(previous, key)
      const hasNext = Object.hasOwn(next, key)
      const value = hasPrevious && hasNext
        ? mergeProjection(previous[key], next[key], origin, `${originPath}/${escapePointer(key)}`)
        : structuredClone(hasPrevious ? previous[key] : next[key])
      Object.defineProperty(result, key, { value, enumerable: true, configurable: true, writable: true })
    }
    return result
  }
  if (typeof previous === 'string' && typeof next === 'string'
    && (previous.startsWith(next) || next.startsWith(previous))) {
    return structuredClone(previous.length >= next.length ? previous : next)
  }
  return structuredClone(next)
}

function preserveArrayIndexes(value, indexes) {
  if (!Array.isArray(value)) return value
  const highest = indexes.reduce((current, index) => Math.max(current, index), -1)
  const result = new Array(highest + 1)
  for (let index = 0; index < indexes.length; index += 1) {
    if (Object.hasOwn(value, index)) result[indexes[index]] = structuredClone(value[index])
  }
  return result
}

function readSource(sources, category) {
  for (const key of SOURCE_KEYS[category] ?? [category]) {
    if (Object.hasOwn(sources ?? {}, key)) return sources[key]
  }
  return undefined
}

/** Report configured context selections that cannot be projected from the supplied snapshot. */
export function missingContextSelections(agent, availableSources) {
  const missing = []
  const seen = new Set()
  for (const selection of agent.context.sources) {
    const key = JSON.stringify(selection)
    if (seen.has(key)) continue
    seen.add(key)
    // Message and draft values are generated during a run, not part of the
    // captured author snapshot. Their absence is represented as a dynamic
    // preview limitation by the caller, not a missing-source error.
    if (selection.type === 'agent_messages' || selection.type === 'drafts') continue
    const source = readSource(availableSources, selection.type)
    const value = selection.selector === undefined ? source : selectPointer(source, selection.selector)
    if (value !== undefined) continue
    missing.push({
      type: selection.type,
      ...(selection.selector === undefined ? {} : { selector: selection.selector }),
      reason: source === undefined ? 'Source is not present in the current snapshot.' : 'Selected path is not present in the current source.'
    })
  }
  return missing
}

function filterMessages(agent, messages, selection) {
  const value = []
  const sourceIndexes = []
  messages.forEach((message, index) => {
    if (message.to !== agent.id) return false
    if (message.type === 'request') {
      if ((!selection || allows(selection, message.from)) && agent.triggers.some(trigger => trigger.type === 'requested_by_agent'
        && (!trigger.from?.length || allows(trigger.from, message.from)))) {
        value.push(message); sourceIndexes.push(index)
      }
      return
    }
    if (allows(selection ?? agent.communication.receiveFrom, message.from) && allows(agent.communication.receiveFrom, message.from)) {
      value.push(message); sourceIndexes.push(index)
    }
  })
  return { value, sourceIndexes, origin: messages }
}

export function draftVisibleTo(agentId, draft) {
  if (String(draft.agentId ?? '') === agentId) return true
  const sharedWith = Array.isArray(draft.visibleTo) ? draft.visibleTo : []
  return sharedWith.includes(agentId)
}

function filterDrafts(agent, drafts, selection) {
  const selectedAgents = selection ?? agent.communication.receiveFrom
  const value = []
  const sourceIndexes = []
  drafts.forEach((draft, index) => {
    const owner = String(draft.agentId ?? '')
    if (draftVisibleTo(agent.id, draft)
      && (owner === agent.id || (allows(selectedAgents, owner) && allows(agent.communication.receiveFrom, owner)))) {
      value.push(draft); sourceIndexes.push(index)
    }
  })
  return { value, sourceIndexes, origin: drafts }
}

function allows(configured, value) {
  return configured.includes('*') || configured.includes(value)
}

function selectPointer(value, pointer) {
  if (pointer === '') return value
  if (typeof pointer !== 'string' || !pointer.startsWith('/')) {
    throw teamError('RP_TEAM_INVALID_CONTEXT_SELECTOR', `Context selector must be a JSON Pointer: ${pointer}`)
  }
  let current = value
  for (const raw of pointer.slice(1).split('/')) {
    const segment = raw.replace(/~1/g, '/').replace(/~0/g, '~')
    if (current === null || typeof current !== 'object' || !Object.hasOwn(current, segment)) return undefined
    current = current[segment]
  }
  return current
}

function applyLimit(value, limit, category) {
  if (Array.isArray(value)) return category === 'recent_history' ? value.slice(-limit) : value.slice(0, limit)
  if (typeof value === 'string') return value.slice(0, limit)
  return value
}

function pointerSegments(pointer) {
  return pointer.slice(1).split('/').map(part => part.replace(/~1/g, '/').replace(/~0/g, '~'))
}

function containerFor(origin, pointer) {
  const value = pointer ? selectPointer(origin, pointer) : origin
  return Array.isArray(value) ? [] : {}
}
function arrayIndex(segment) { return /^\d+$/u.test(String(segment)) ? Number(segment) : segment }
function escapePointer(value) { return String(value).replace(/~/g, '~0').replace(/\//g, '~1') }
function isRecord(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) }

export const contextSourceTypes = Object.freeze(Object.keys(SOURCE_KEYS))
