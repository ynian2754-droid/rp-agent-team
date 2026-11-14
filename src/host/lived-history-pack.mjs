import { teamError } from '../shared/schema.mjs'
import { describeStateToolAccess, versionForPath } from './state-store.mjs'
import { simulationGroundRefs } from './lived-history-sim-evidence.mjs'

const namespace = 'shared'
const logPath = '/story/packs'
const paths = {
  world: '/canon/world',
  events: '/canon/events',
  hidden: '/canon/hidden',
  situations: '/situations',
  selves: '/selves',
  memories: '/memories',
  practices: '/practices',
  log: logPath
}
const practiceNote = '这是你过去在类似处境里实际做过的事，不是你必须做的事；习惯的力量来自省力，不来自正确。'
const preparedByRun = new WeakMap()

const list = value => Array.isArray(value) ? value : []
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const own = (value, key) => value && Object.hasOwn(value, key) ? value[key] : undefined
const fields = (value, keys) => Object.fromEntries(keys.filter(key => Object.hasOwn(value, key)).map(key => [key, value[key]]))
const known = (event, person) => list(event.perceivers).find(row => row.who === person &&
  (['亲历', '目击', '听说'].includes(row.how) || (row.how === '可察觉' && typeof row.what === 'string' && row.what.length > 0)))

function invalid(message) {
  throw teamError('RP_TEAM_MATERIAL_PACK_INVALID', message)
}

/** Prepare the clerk's own ACL projections while the adjudicator prepares the current beat. */
export function primeLivedHistoryPackReaders({ run, agent, stateStore, versions }) {
  if (agent.execution?.livedHistoryPhase !== 'world') return
  const targets = new Set(agent.communication.handoffs?.filter(rule => rule.mode === 'await').map(rule => rule.to))
  for (const clerk of run.config.agents ?? []) {
    if (targets.has(clerk.id) && clerk.communication.handoffs?.some(rule => rule.materialPack)) {
      preparePackReads({ run, agent: clerk, stateStore, versions })
    }
  }
}

function preparePackReads({ run, agent, stateStore, versions }) {
  const authorized = new Set(describeStateToolAccess(agent, run.config.state.definitions)
    .filter(item => item.namespace === namespace && item.read).map(item => item.path))
  let prepared = preparedByRun.get(run)
  if (!prepared) {
    prepared = new Map()
    preparedByRun.set(run, prepared)
  }
  const previous = prepared.get(agent.id)
  const reads = Object.fromEntries(Object.entries(paths).map(([key, path]) => {
    if (!authorized.has(path)) return [key, {}]
    const prior = previous?.[key]
    if (prior && versions && prior.version === versionForPath(versions, namespace, path)) return [key, prior]
    const read = stateStore.read({ conversationId: run.conversationId, runId: run.runId, agentId: agent.id, namespace, path })
    if (key === 'events' || key === 'hidden') {
      const rows = activeRows(read.value, key)
      const byId = new Map(rows.map(row => [row.id, row]))
      const byPerson = new Map()
      for (const row of rows) {
        const names = new Set([...list(row.people), ...list(row.known_to), ...list(row.perceivers).map(item => item?.who)])
        for (const person of names) {
          if (!byPerson.has(person)) byPerson.set(person, [])
          byPerson.get(person).push(row)
        }
      }
      return [key, { ...read, rows, byId, byPerson }]
    }
    return [key, read]
  }))
  prepared.set(agent.id, reads)
  return reads
}

function activeRows(value, key) {
  return list(value).filter(row => record(row) && typeof row.id === 'string' && row.active !== false &&
    (key !== 'hidden' || row.status === '隐'))
}

/** Reuse prepared projections only if that path is current, including fresh stimuli written by world. */
export function createLivedHistoryPackSource({ run, agent, stateStore, activation, versions }) {
  if (!agent.communication.handoffs?.some(rule => rule.materialPack) || !activation?.requestId || activation.resumeFromRequestId) return
  const row = run.communication.getRequest(activation.requestId)
  const input = row?.to === agent.id && row.request?.data
  if (!record(input) || !Array.isArray(input.present) || typeof input.player !== 'string') return
  const reads = preparePackReads({ run, agent, stateStore, versions })
  const world = reads.world.value ?? {}
  const present = [...new Set(input.present)].filter(person => typeof person === 'string' && person !== input.player)
  const events = reads.events.rows ?? []
  const selectionRows = read => {
    const relevant = new Set(present.flatMap(person => read.byPerson?.get(person) ?? []))
    return read.rows?.filter(row => relevant.has(row)) ?? []
  }
  const log = list(reads.log.value)
  const seq = (log.at(-1)?.seq ?? 0) + 1
  const state = Object.fromEntries(['situations', 'selves', 'memories', 'practices'].map(key => [key, reads[key].value ?? {}]))
  const selection = {
    present,
    world,
    ...(list(input.sceneCues).length ? { sceneCues: input.sceneCues } : {}),
    events: selectionRows(reads.events),
    hidden: selectionRows(reads.hidden),
    people: Object.fromEntries(present.map(person => [person, {
      situation: own(state.situations, person), last: own(state.selves, person)?.last,
      memories: Object.fromEntries(Object.entries(own(state.memories, person) ?? {})
        .filter(([, value]) => record(value) && !value.archived && !value.done)),
      practices: own(state.practices, person)
    }]))
  }
  return { input, originalInput: run.currentInput, world, present, events, eventById: reads.events.byId ?? new Map(),
    hiddenById: reads.hidden.byId ?? new Map(), state, seq, log, logVersion: reads.log.version, selection }
}

export function buildLivedHistoryPack(source, data, requests = [], { groundRefs = false, groundChoices = false } = {}) {
  if (!source || !record(data)) invalid('An active material-selection packet is required')
  if (![1, 2].includes(data.slot)) invalid('Select material for slot 1 or 2')
  if (data.repeat !== undefined) return repeatPack(source, data, requests)
  const group = list(data.group)
  if (!group.length || new Set(group).size !== group.length || group.some(person => !source.present.includes(person))) {
    invalid('Select a nonempty group of distinct characters in the world request, excluding the player')
  }
  if (requests.some(row => {
    const prior = row.request.data
    return prior.slot === data.slot ? !sameGroup(prior.group, group) : prior.group.some(person => group.includes(person))
  })) invalid('Keep the same group in each slot for this activation')

  const material = list(source.input.material).filter(row => group.includes(row.who)).map(row => fields(row, ['who', 'text']))
  const selected = data.evidence ?? {}
  if (!record(selected) || Object.keys(selected).some(person => !group.includes(person))) invalid('Select evidence only for people in this group')
  const stimulus = selectStimulus(source, group, data.stimulus, data.midbeat)
  let nextChoice = 1
  const people = Object.fromEntries(group.map(person => {
    const material = personMaterial(source, group, person, own(selected, person))
    if (groundRefs || groundChoices) material.ground_refs = simulationGroundRefs(material, stimulus)
    if (groundChoices) material.ground_choices = Object.fromEntries(material.ground_refs.map(ref => [`G${nextChoice++}`, ref]))
    return [person, material]
  }))
  const mode = source.input.mode
  return {
    seq: source.seq, slot: data.slot, mode, player: source.input.player, group,
    now: [source.world.now?.storyTime, source.world.now?.place, ...group].filter(Boolean).join('，'),
    stimulus, relay: selectRelay(data.relay, data.slot, requests), people,
    facing: mode === '建档' ? '写下你的第一版自述' : stimulus.filter(item => item.timing !== '现在')
      .map(item => item.content).join('\n'),
    ...(material.length ? { material } : {}),
    ...(list(source.input.notes).length && group.length === 1 && source.present.length === 1 ? { notes: source.input.notes } : {}),
    ...(Array.isArray(data.check_issues) ? { check_issues: data.check_issues } : {})
  }
}

function sameGroup(left, right) {
  return left.length === right.length && left.every(person => right.includes(person))
}

function repeatPack(source, data, requests) {
  const previous = requests.find(row => row.ref === data.repeat)?.request?.data
  if (!previous || previous.seq !== source.seq || previous.slot !== data.slot) {
    invalid('Repeat must identify a previous material request to this same slot')
  }
  if (data.group !== undefined && !sameGroup(previous.group, list(data.group))) invalid('A repeat cannot change the group')
  if (data.mode !== undefined && data.mode !== '接力') invalid('A repeat may only override its mode for a relay')
  return {
    ...previous,
    ...(data.mode ? { mode: data.mode } : {}),
    ...(data.relay !== undefined ? { relay: selectRelay(data.relay, data.slot, requests) } : {}),
    ...(Array.isArray(data.check_issues) ? { check_issues: data.check_issues } : {})
  }
}

function indexed(items, indexes, title) {
  if (indexes === undefined) return []
  if (!Array.isArray(indexes) || indexes.some(index => !Number.isSafeInteger(index) || !Object.hasOwn(items, index))) {
    invalid(`Supply existing zero-based ${title} indices`)
  }
  return [...new Set(indexes)].map(index => items[index])
}

function selectStimulus(source, group, indexes, midbeat) {
  const inputs = list(source.input.stimulus)
  const selected = indexes === undefined ? new Set() : new Set(indexed(inputs, indexes, 'stimulus'))
  const candidates = inputs.flatMap(item => {
    const event = item.event && source.eventById.get(item.event)
    if (item.event && (!event || !group.every(person => known(event, person)))) return []
    if (!item.event && !selected.has(item) && !sameGroup(group, source.present)) return []
    if (event) {
      const audience = group.map(person => known(event, person))
      const view = firsthandSpeech(item.content, source.originalInput, event, audience)
      const views = view ? [view] : [...new Set(audience.map(row => row.what ?? item.content))]
      if (views.length !== 1) return []
      return [{ event: item.event, content: views[0], when: event.storyTime,
        perceivers: audience.map(row => fields(row, ['who', 'how'])) }]
    }
    return [{ content: item.content }]
  })
  for (const cue of list(source.input.sceneCues)) {
    if (typeof cue?.content === 'string' && cue.content.trim() && group.every(person => list(cue.perceivers).includes(person))) {
      candidates.push({ content: cue.content, timing: '现在' })
    }
  }
  for (const item of indexed(list(source.input.midbeat), midbeat, 'midbeat')) {
    candidates.push({ content: item.content, when: item.when, timing: '稍后' })
  }
  return candidates
}

function firsthandSpeech(content, originalInput, event, audience) {
  if (event.source !== '用户' || !originalInput || audience.some(row => !['亲历', '目击'].includes(row.how))) return
  const quotes = [...content.matchAll(/“([^”]+)”|「([^」]+)」/gu)].map(match => match[1] ?? match[2])
  if (quotes.length && quotes.every(quote => originalInput.includes(quote)
      && audience.every(row => row.what === undefined || row.what.includes(quote)))) return content
}

function selectRelay(spec, slot, requests) {
  if (spec === undefined || (Array.isArray(spec) && !spec.length)) return []
  if (!record(spec) || !Array.isArray(spec.speakers)) invalid('Select relay actions using a previous peer result ref and speakers')
  const peer = requests.find(row => row.ref === spec.ref && row.status === 'completed' && row.request.data.slot !== slot)
  if (!peer) invalid('Relay ref must name a completed material handoff to the other slot')
  const beats = list(peer.result?.data?.beats)
  return spec.speakers.map(selection => {
    const beat = record(selection) && beats.find(row => row.who === selection.who)
    if (!beat) invalid('Select a speaker from the peer result')
    return {
      who: beat.who,
      says: indexed(list(beat.says), selection.says, 'spoken-line'),
      ...(selection.does === true ? { does: beat.does } : {})
    }
  })
}

function personMaterial(source, group, person, evidence) {
  if (evidence !== undefined && !record(evidence)) invalid('Each person needs an evidence object')
  const { state, events, eventById, hiddenById } = source
  const multi = group.length > 1
  const count = { private: 0 }
  const rawSelf = own(state.selves, person)
  const self = filterPersonal(rawSelf, multi, count)
  const rawMemories = own(state.memories, person)
  const visibleMemories = filterPersonal(rawMemories, multi, count)
  const practiceRows = list(own(state.practices, person))
  const collect = ids => [...new Set(list(ids))].flatMap(id => {
    const event = eventById.get(id)
    if (event && group.every(name => known(event, name))) {
      const view = known(event, person)
      const descriptions = new Set(group.map(name => known(event, name).what ?? event.content))
      if (descriptions.size === 1) return [{ id, what: view.what ?? event.content, how: view.how, when: event.storyTime }]
      return []
    }
    const secret = hiddenById.get(id)
    return secret && group.every(name => list(secret.known_to).includes(name))
      ? [{ id, what: secret.content, ...(secret.since ? { event: secret.since } : {}) }] : []
  })
  const stimulusIds = new Set(list(source.input.stimulus).map(item => item.event))
  const recent = events.filter(event => !stimulusIds.has(event.id) &&
    list(event.people).includes(person) &&
    event.storyTime === source.world.now?.storyTime && group.every(name => known(event, name)))
    .slice(-2).map(event => event.id)
  const knows = collect([...list(evidence?.knows), ...recent])
  const precedents = collect(evidence?.precedents)
  const memories = [...new Set(list(evidence?.memories))].flatMap(key => {
    const memory = own(visibleMemories, key)
    return record(memory) && !memory.archived ? [{ ...memory, key }] : []
  })
  const practices = [...new Set(list(evidence?.practices))].flatMap(key => {
    const practice = Number.isSafeInteger(key) && practiceRows[key]
    return record(practice) ? [{ ...practice, key: `practice:${key}` }] : []
  })
  const visiblePeople = new Set([...group, source.input.player])
  const toward = Object.fromEntries(Object.entries(self?.toward ?? {}).filter(([other]) => visiblePeople.has(other)))
  if (record(self)) delete self.toward
  return {
    knows, situation: own(state.situations, person) ?? '',
    self: self ?? '此人尚无自述', toward, memories, practices, precedents,
    ...(practices.length ? { practices_note: practiceNote } : {}),
    ...(count.private ? { omitted: count.private } : {})
  }
}

function filterPersonal(value, multi, count) {
  if (Array.isArray(value)) return value.map(item => filterPersonal(item, multi, count)).filter(item => item !== undefined)
  if (!record(value)) return value
  if (multi && value.private === true) {
    count.private++
    return undefined
  }
  if (value.done) return undefined
  return Object.fromEntries(Object.entries(value).flatMap(([key, child]) => {
    const visible = filterPersonal(child, multi, count)
    return visible === undefined ? [] : [[key, visible]]
  }))
}

export function livedHistoryPackLog(source, requests, relayCount) {
  if (!source || source.logVersion === undefined || !requests.length) return
  const groups = new Map()
  for (const row of requests) {
    const pack = row.request.data
    const slot = groups.get(pack.slot) ?? { slot: pack.slot, people: pack.group, ids: [], omitted: {} }
    for (const [person, data] of Object.entries(pack.people)) {
      for (const evidence of [...data.knows, ...data.precedents]) slot.ids.push(evidence.id)
      if (data.omitted) Object.defineProperty(slot.omitted, person, {
        enumerable: true, configurable: true, value: Math.max(own(slot.omitted, person) ?? 0, data.omitted)
      })
    }
    for (const item of pack.stimulus) if (item.event) slot.ids.push(item.event)
    groups.set(pack.slot, slot)
  }
  const entry = { seq: source.seq, storyTime: source.world.now?.storyTime ?? '', relays: relayCount, groups:
    [...groups.values()].map(group => ({ ...group, ids: [...new Set(group.ids)] })) }
  return { namespace, path: logPath, expectedVersion: source.logVersion, value: [...source.log, entry].slice(-10) }
}
