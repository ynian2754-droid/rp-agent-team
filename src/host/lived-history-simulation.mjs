import { validateArgs } from '@deepseek-ai/dsh-tools'
import { teamError } from '../shared/schema.mjs'
import { versionForPath } from './state-store.mjs'

const wholeSelfFields = new Set(['account', 'last'])
const keyedSelfFields = new Set(['commitments', 'toward', 'carrying', 'wants'])
const isKey = value => typeof value === 'string' && value.trim().length > 0 && !/^\d+$/u.test(value)
const simulationSubmitTool = 'rp_team_submit_internal'
const text = { type: 'string' }
const requiredText = { ...text, required: true }
const array = items => ({ type: 'array', items })
const object = properties => ({ type: 'object', properties, additionalProperties: false })
const strings = array(text)

export const typedSimulationParameters = simulationParameters()

export function simulationParameters(groundChoices = []) {
  const groundRef = groundChoices.length ? { ...requiredText, enum: groundChoices } : requiredText
  return {
    summary: requiredText,
    data: { ...object({
      beats: { ...array(object({
        who: requiredText, says: { ...strings, required: true }, does: requiredText, withheld: text, if_then: strings,
        intent: text, options: array(object({ option: requiredText, why_not: requiredText })),
        grounds: { ...array(object({ ref: groundRef, note: requiredText })), required: true },
        departs: { oneOf: [text, { type: 'null' }, strings], description: 'A real departure as one sentence. Omit when absent.' },
        self_explanation: text
      })), required: true },
      stateOps: { ...array(object({ person: requiredText,
        area: { ...requiredText, enum: ['selves', 'memories'] }, path: { ...strings, required: true },
        value: { type: 'json', required: true }
      })), required: true }
    }), required: true }
  }
}

export function normalizeSimulationSubmission(data) {
  return { ...data, beats: data.beats.map(beat => {
    const { departs, ...fields } = beat
    if (departs === undefined || departs === null || (Array.isArray(departs) && departs.length === 0)) return fields
    if (typeof departs !== 'string') {
      throw teamError('RP_TEAM_SIMULATION_INVALID', 'departs must describe one departure as a string, or be omitted')
    }
    return beat
  }) }
}

/** Recover the observed provider suffix only after checking the complete otherwise-valid submission. */
export function repairSimulationToolArguments(raw, parameters = typedSimulationParameters) {
  if (typeof raw !== 'string') return raw
  const end = raw.trimEnd().length
  if (raw[end - 1] !== '}') return raw
  try { JSON.parse(raw); return raw } catch {}
  const repaired = raw.slice(0, end - 1) + raw.slice(end)
  try {
    const value = JSON.parse(repaired)
    if (!value || Object.keys(value).sort().join(',') !== 'data,summary' || validateArgs(parameters, value).length) return raw
    normalizeSimulationSubmission(value.data)
    return repaired
  } catch {
    return raw
  }
}

/** Preserve the stream protocol and buffer only the selected tool block until its arguments are complete. */
export async function* normalizeSimulationSubmitStream(source, { signal, onRepair, parameters } = {}) {
  const pending = new Map()
  const tools = new Set()
  function flush(chunks, blockEnd, allowRepair, parserFailure) {
    const raw = blockEnd?.block.arguments ?? chunks.map(chunk => chunk.argumentsDelta).join('')
    if (parserFailure && !matchesSimulationParserFailure(parserFailure, raw)) return chunks
    const repaired = allowRepair ? repairSimulationToolArguments(raw, parameters) : raw
    if (repaired === raw) return blockEnd ? [...chunks, blockEnd] : chunks
    onRepair?.({ toolName: simulationSubmitTool, removedTrailingBrace: true })
    if (blockEnd) {
      const first = chunks[0]
      return [
        ...(first ? [{ ...first, argumentsDelta: repaired }] : []),
        { ...blockEnd, block: { ...blockEnd.block, arguments: repaired } }
      ]
    }
    return [{ ...chunks[0], argumentsDelta: repaired }]
  }
  for await (const chunk of await source) {
    signal?.throwIfAborted()
    if (chunk.type === 'tool-call-delta' || (chunk.type === 'block-start' && chunk.blockType === 'tool-call') ||
        (chunk.type === 'block-end' && chunk.block.type === 'tool-call')) tools.add(chunk.index)
    if (chunk.type === 'tool-call-delta' && (chunk.name === simulationSubmitTool || pending.has(chunk.index))) {
      const chunks = pending.get(chunk.index) ?? []
      chunks.push(chunk)
      pending.set(chunk.index, chunks)
    } else if (chunk.type === 'block-end' && chunk.block.type === 'tool-call' && chunk.block.name === simulationSubmitTool) {
      yield* flush(pending.get(chunk.index) ?? [], chunk, true)
      pending.delete(chunk.index)
    } else {
      if (chunk.type === 'finish') {
        const failure = chunk.reason?.kind === 'error' && chunk.reason.failure
        if (failure && tools.size === 1 && pending.size === 1) {
          const chunks = pending.values().next().value
          const repaired = flush(chunks, undefined, true, failure)
          if (repaired !== chunks) {
            pending.clear()
            yield* repaired
            yield { type: 'finish', reason: { kind: 'tool-calls' } }
            continue
          }
        }
        for (const chunks of pending.values()) yield* flush(chunks, undefined, ['tool-calls', 'stop'].includes(chunk.reason?.kind))
        pending.clear()
      }
      yield chunk
    }
  }
  for (const chunks of pending.values()) yield* chunks
}

function matchesSimulationParserFailure(failure, raw) {
  if (failure.code !== 'MALFORMED_RESPONSE' || typeof failure.message !== 'string') return false
  const prefix = `Tool call "${simulationSubmitTool}": Unexpected non-whitespace character after JSON at position `
  const marker = '\n\nReceived arguments:\n'
  const locationEnd = failure.message.indexOf(marker, prefix.length)
  return failure.message.startsWith(prefix) && locationEnd >= 0 && failure.message.slice(locationEnd + marker.length) === raw
}

export function simulationTargets(pack, { beats, stateOps } = {}, versions) {
  if (!Array.isArray(pack?.group) || !Array.isArray(beats) || !Array.isArray(stateOps)) {
    throw teamError('RP_TEAM_SIMULATION_INVALID', 'Submit data with beats and stateOps arrays for the assigned group')
  }
  const group = new Set(pack.group.filter(person => person !== pack.player))
  const acted = new Set()
  for (const beat of beats) {
    if (!group.has(beat?.who) || acted.has(beat.who)) {
      throw teamError('RP_TEAM_SIMULATION_FORBIDDEN', 'Each beat must belong to a distinct assigned person other than the player')
    }
    acted.add(beat.who)
  }
  return stateOps.map((operation, index) => {
    const { person, area, path, value } = operation ?? {}
    if (!group.has(person)) {
      throw teamError('RP_TEAM_SIMULATION_FORBIDDEN', `stateOps[${index}] may write only assigned people other than the player`)
    }
    if (!Array.isArray(path) || !path.every(isKey) || !validField(area, path, value)) {
      throw teamError('RP_TEAM_SIMULATION_INVALID', `stateOps[${index}] must name one supported record or field and provide its value`)
    }
    const namespace = 'shared'
    const pointer = '/' + [area, person, ...path].map(part => part.replace(/~/g, '~0').replace(/\//g, '~1')).join('/')
    return { namespace, person, path: pointer, value, expectedVersion: versionForPath(versions, namespace, pointer) }
  })
}

function validField(area, path, value) {
  if (area === 'memories' && path.length === 2 && path[1] === 'archived') return value === true
  if (!value || Array.isArray(value) || typeof value !== 'object') return false
  if (area === 'memories') return path.length === 1
  if (area !== 'selves') return false
  return (wholeSelfFields.has(path[0]) && path.length === 1) ||
    (keyedSelfFields.has(path[0]) && path.length === 2)
}
