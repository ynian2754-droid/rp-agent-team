import { teamError } from '../shared/schema.mjs'
import { createMemoryRecord } from './memory-tools.mjs'
import { versionForPath } from './state-store.mjs'

const namespace = 'shared'
const settingsPath = '/story/settings-log'
const collectionPaths = { events: '/canon/events', hidden: '/canon/hidden' }
const outcomeSources = new Set(['裁定', '用户指定', '幕外', '揭示', '补充', '找补', '更正'])
const backgroundFields = new Set(['clocks', 'agendas', 'offstage_until'])
const worldFields = new Set(['now', 'ties', 'situations', ...backgroundFields])

/** Register the user stimulus before the material packet for ask-file is created. */
export function prepareLivedHistoryWorldStart({ run, member, stateStore, args, priorStimulus = [] }) {
  const endpoint = stateEndpoint(run, member)
  if (!Array.isArray(args?.stimuli) || (args.file !== undefined && !isRecord(args.file))) {
    invalid('Provide a stimuli array and a file object when dispatching the clerk')
  }
  const { file, stimuli } = args
  if (file && (Object.hasOwn(file, 'stimulus') || Object.hasOwn(file, 'mode'))) {
    invalid('The host supplies file.mode and file.stimulus')
  }
  if (!file && !stimuli.length) invalid('Provide at least one stimulus when omitting file')
  const seen = new Set()
  let offset = 0
  const existing = stimuli.length ? readCollection(run, stateStore, endpoint, 'events') : undefined
  const append = existing && appendCollection(run, stateStore, endpoint, 'events', existing)
  const reused = member.execution?.livedHistoryFocusedWorld && priorStimulus.length && existing
    ? reusableUserStimuli(existing, priorStimulus) : new Map()
  const writes = []
  const stimulus = stimuli.map(entry => {
    const { content, record } = entry ?? {}
    const position = typeof content === 'string' ? run.currentInput?.indexOf(content, offset) ?? -1 : -1
    if (position < 0 || !content.trim() || seen.has(content)) {
      invalid('List distinct nonempty verbatim input passages in their original order as stimuli')
    }
    seen.add(content)
    offset = position + content.length
    if (!isRecord(record) || (record.source !== undefined && record.source !== '用户')) {
      invalid('Each stimulus needs a user event record, with source 用户')
    }
    const prior = reused.get(content)
    if (prior !== undefined) return { event: prior, content }
    const target = append({ ...record, source: '用户', content: record.content ?? content })
    writes.push(target)
    return { event: target.value.id, content }
  })
  const eventIds = stimulus.map(row => row.event)
  const independentWrites = args.settingsLog === undefined ? [] : [
    stateWrite(settingsPath, args.settingsLog?.value, args.settingsLog?.expectedVersion)
  ]
  return { writes, independentWrites, data: file ? { ...file, mode: '推演', stimulus } : undefined, eventIds, stimulus }
}

function reusableUserStimuli(events, priorStimulus) {
  const activeUserIds = new Set(events.filter(record => record?.active !== false && record?.source === '用户').map(record => record.id))
  const reused = new Map()
  for (const { event, content } of priorStimulus) {
    if (activeUserIds.has(event) && !reused.has(content)) reused.set(content, event)
  }
  return reused
}

/** Validate proposed independent outcomes before dispatch, without staging or reserving a ledger slot. */
export function validateLivedHistoryWorldBackground({ run, member, stateStore, background }) {
  if (background === undefined) return
  const endpoint = stateEndpoint(run, member)
  const versions = stateStore.versionsSnapshot(endpoint)
  if (!isRecord(background) || !Object.keys(background).every(key => key === 'events' || key === 'worldPatch')) {
    invalid('Background accepts only events and worldPatch')
  }
  const { events = [], worldPatch } = background
  if (!Array.isArray(events) || !events.every(entry => typeof entry?.key === 'string' && entry.key.trim()
    && ['幕外', '补充'].includes(entry.record?.source))) {
    invalid('Give each independent background event a unique key and source 幕外 or 补充')
  }
  const state = patchStateWrites(worldPatch, versions, backgroundFields)
  if (events.length || state.length) {
    const { writes } = prepareLivedHistoryWorldSubmission({ run, member, stateStore, args: { data: {}, events, state } })
    stateStore.writeBatch({ ...endpoint, targets: writes, validateOnly: true })
  }
  return { versions, events: structuredClone(events), state: structuredClone(state) }
}

/** Snapshot the exact state versions for compact closing writes alongside the clerk wait. */
export function prepareLivedHistoryWorldClose({ run, member, stateStore, background }) {
  const { versions = stateStore.versionsSnapshot(stateEndpoint(run, member)), events = [], state = [] } = background ?? {}
  return { versions, events, state,
    summary: { eventKeys: events.map(entry => entry.key), statePaths: state.map(entry => entry.path) } }
}

function patchStateWrites(patch, versions, fields) {
  if (patch === undefined) return []
  if (!isRecord(patch) || !Object.keys(patch).every(key => fields.has(key))) {
    invalid(`worldPatch accepts only ${[...fields].join(', ')}`)
  }
  const targets = []
  function add(path, value) {
    targets.push({ path, value, expectedVersion: versionForPath(versions, namespace, path) })
  }
  for (const [key, value] of Object.entries(patch)) {
    if (key === 'now' || key === 'situations') {
      if (!isRecord(value)) invalid(`worldPatch.${key} must be an object`)
      if (key === 'now' && !Object.keys(value).every(field => ['storyTime', 'place', 'present', 'doing'].includes(field))) {
        invalid('worldPatch.now accepts only storyTime, place, present, doing')
      }
      for (const [field, item] of Object.entries(value)) {
        if (!field.trim()) invalid(`worldPatch.${key} requires nonempty keys`)
        const path = key === 'now' ? '/canon/world/now' : '/situations'
        add(`${path}/${field.replaceAll('~', '~0').replaceAll('/', '~1')}`, item)
      }
    } else {
      add(`/canon/world/${key}`, value)
    }
  }
  return targets
}

/** Prepare all disjoint state mutations before validating and staging the terminal handoff. */
export function prepareLivedHistoryWorldSubmission({ run, member, stateStore, args, prepared }) {
  const endpoint = stateEndpoint(run, member)
  if (!isRecord(args?.data)) invalid('Provide the world handoff result in data')
  const { events: finalEvents = [], hidden = [], state: finalState = [], worldPatch } = args
  if (![finalEvents, hidden, finalState].every(Array.isArray)) invalid('Events, hidden records and state changes must be arrays')
  if (worldPatch !== undefined && !prepared) invalid('Use the start tool before submitting a worldPatch')
  const events = [...(prepared?.events ?? []), ...finalEvents]
  const state = [...(prepared?.state ?? []), ...patchStateWrites(worldPatch, prepared?.versions, worldFields), ...finalState]
  const established = Array.isArray(args.data.established) ? args.data.established : []
  const hasEstablishedEvent = established.some(entry => isRecord(entry) && Object.hasOwn(entry, 'event'))
  const existingEvents = events.length || hasEstablishedEvent ? readCollection(run, stateStore, endpoint, 'events') : []
  const activeEventIds = new Set(hasEstablishedEvent ? existingEvents.filter(record => record?.active !== false).map(record => record?.id) : [])
  const localIds = new Map()
  const localKeys = new Set(events.map(entry => entry?.key).filter(key => typeof key === 'string'))
  const eventRef = value => {
    if (typeof value === 'string' && localKeys.has(value)) return expandLocalRefs({ $event: value }, localIds)
    return expandLocalRefs(value, localIds)
  }
  const writes = []
  if (events.length) {
    const append = appendCollection(run, stateStore, endpoint, 'events', existingEvents)
    for (const [index, entry] of events.entries()) {
      const { key, record } = entry ?? {}
      if (!isRecord(record) || !outcomeSources.has(record.source)) {
        invalid(`events[${index}] needs an adjudicated event record. Use the start tool for the current input.`)
      }
      if (key !== undefined && (typeof key !== 'string' || !key.trim() || localIds.has(key))) {
        invalid(`events[${index}] needs a unique nonempty local key`)
      }
      const value = expandLocalRefs(record, localIds)
      for (const field of ['because', 'covers']) {
        if (Array.isArray(record[field])) value[field] = record[field].map(eventRef)
      }
      if (Object.hasOwn(record, 'corrects')) value.corrects = eventRef(record.corrects)
      const target = append(value)
      if (key !== undefined) localIds.set(key, target.value.id)
      if (target.value.active !== false) activeEventIds.add(target.value.id)
      writes.push(target)
    }
  }
  if (hidden.length) {
    const append = appendCollection(run, stateStore, endpoint, 'hidden')
    for (const entry of hidden) {
      const value = expandLocalRefs(entry?.record, localIds)
      if (isRecord(value) && Object.hasOwn(value, 'since')) value.since = eventRef(entry.record.since)
      writes.push(append(value))
    }
  }
  for (const entry of state) {
    const { path, value, expectedVersion } = entry ?? {}
    if (typeof path !== 'string' || !/^\/(?:canon\/world|situations|story\/settings-log)(?:\/|$)/u.test(path)) {
      invalid('State changes must be under /canon/world, /situations, or /story/settings-log')
    }
    writes.push(stateWrite(path, expandLocalRefs(value, localIds), expectedVersion))
  }
  const data = expandLocalRefs(args.data, localIds)
  if (hasEstablishedEvent) {
    for (const [index, entry] of established.entries()) {
      if (!isRecord(entry) || !Object.hasOwn(entry, 'event')) continue
      const id = eventRef(entry.event)
      if (typeof id !== 'string' || !activeEventIds.has(id)) {
        const keys = [...localIds.keys()]
        invalid(`established[${index}].event must reference an active event ID or an exact prepared or submitted key.${keys.length ? ` Available keys: ${keys.join(', ')}.` : ''}`)
      }
      data.established[index].event = id
    }
  }
  return { writes, data }
}

function readCollection(run, stateStore, endpoint, id) {
  const path = collectionPaths[id]
  const collection = run.config.memory?.collections?.find(row => row.id === id && row.path === path && row.namespace === namespace)
  if (!collection) invalid(`No configured ${id} collection is available`)
  const { value } = stateStore.read({ ...endpoint, namespace, path })
  if (!Array.isArray(value)) invalid(`The ${id} collection must be initialized`)
  return value
}

function appendCollection(run, stateStore, endpoint, id, value = readCollection(run, stateStore, endpoint, id)) {
  const path = collectionPaths[id]
  let tail = value.length
  const versions = stateStore.versionsSnapshot(endpoint)
  const seen = new Set()
  return record => {
    const item = createMemoryRecord(record)
    const identity = JSON.stringify([item.storyTime, item.content])
    if (seen.has(identity)) invalid(`Duplicate ${id} record in this batch`)
    seen.add(identity)
    const target = `${path}/${tail++}`
    return { namespace, path: target, value: item, expectedVersion: versionForPath(versions, namespace, target), operation: 'memory.append' }
  }
}

function stateWrite(path, value, expectedVersion) {
  if (value === undefined || !Number.isSafeInteger(expectedVersion) || expectedVersion < 0) {
    invalid(`Provide a value and the version read for ${path}`)
  }
  return { namespace, path, value, expectedVersion, operation: 'write' }
}

function expandLocalRefs(value, ids) {
  if (Array.isArray(value)) return value.map(item => expandLocalRefs(item, ids))
  if (!isRecord(value)) return value
  if (Object.hasOwn(value, '$event')) {
    if (Object.keys(value).length !== 1 || !ids.has(value.$event)) invalid('Use a previously declared local event key in $event')
    return ids.get(value.$event)
  }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, expandLocalRefs(item, ids)]))
}

function stateEndpoint(run, member) {
  if (!member.outputAuthority?.state) throw teamError('RP_TEAM_OUTPUT_FORBIDDEN', 'World adjudication requires state authority')
  return { conversationId: run.conversationId, runId: run.runId, agentId: member.id }
}

function invalid(message) { throw teamError('RP_TEAM_WORLD_TURN_INVALID', message) }
function isRecord(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) }
