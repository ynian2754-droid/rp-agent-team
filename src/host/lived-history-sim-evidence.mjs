const sceneRefs = ['此刻场面', '处境']
const evidenceSections = ['knows', 'precedents', 'memories', 'practices']
const personalSections = ['commitments', 'carrying', 'wants']

/** Catalog the refs available to one actor in their already-filtered material packet. */
export function simulationEvidenceCatalog(actor, { includeSelf = false, stimulus = [] } = {}) {
  const catalog = new Map()
  const ambiguous = new Set()
  function add(ref, source) {
    if (typeof ref !== 'string' || !ref || ambiguous.has(ref)) return
    const earlier = catalog.get(ref)
    if (earlier && (earlier.origin !== source.origin || earlier.personal !== source.personal)) {
      catalog.delete(ref)
      ambiguous.add(ref)
    } else if (!earlier || (earlier.historical && !source.historical) || (!earlier.time && source.time)) {
      catalog.set(ref, source)
    }
  }

  for (const section of evidenceSections) {
    for (const item of rows(actor?.[section])) {
      if (!isRecord(item)) continue
      const ref = item.id ?? item.key
      const origin = typeof item.event === 'string' && item.event ? item.event : ref
      add(ref, { origin, time: text(item.when ?? item.storyTime ?? item.last), historical: true })
    }
  }
  if (includeSelf && isRecord(actor?.self)) {
    for (const section of personalSections) {
      for (const [key, item] of entries(actor.self[section])) {
        if (!isRecord(item) || item.done || item.archived) continue
        const ref = `self.${section}.${key}`
        add(ref, { origin: ref, time: text(item.since ?? item.by), historical: false, personal: true })
      }
    }
    for (const [key, item] of entries(actor.self.account)) {
      if (!['now', 'before'].includes(key) || !isRecord(item) || !text(item.text)) continue
      const ref = `self.account.${key}`
      add(ref, { origin: ref, time: text(item.when), historical: false, personal: true })
    }
  }
  for (const item of Array.isArray(stimulus) ? stimulus : []) {
    const ref = item?.event
    add(ref, { origin: ref, time: text(item?.when), historical: false })
  }
  for (const ref of sceneRefs) catalog.set(ref, { origin: ref, historical: false })
  return catalog
}

export function simulationGroundRefs(actor, stimulus) {
  return [...simulationEvidenceCatalog(actor, { includeSelf: true, stimulus }).keys()]
}

export function simulationGroundChoiceIds(pack) {
  return Object.values(pack?.people ?? {}).flatMap(actor => Object.keys(actor?.ground_choices ?? {}))
}

/** The short option is local to this packet and must also belong to the beat's actor. */
export function restoreSimulationGroundRefs(pack, beats) {
  return beats.map(beat => {
    const choices = Object.hasOwn(pack.people, beat.who) ? pack.people[beat.who].ground_choices : undefined
    return { ...beat, grounds: beat.grounds.map(ground => {
      if (!choices || !Object.hasOwn(choices, ground.ref)) {
        throw teamError('RP_TEAM_SIMULATION_EVIDENCE_INVALID', `依据选项 ${ground.ref} 不在 ${beat.who} 的 ground_choices 中。请选择该人物自己的编号。`)
      }
      return { ...ground, ref: choices[ground.ref] }
    }) }
  })
}

function rows(value) {
  return Array.isArray(value) ? value : Object.values(isRecord(value) ? value : {})
}

function entries(value) {
  return Object.entries(isRecord(value) ? value : {})
}

function text(value) {
  return typeof value === 'string' && value.trim() ? value : undefined
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
import { teamError } from '../shared/schema.mjs'

