import { teamError } from './run-state.mjs'

// JSON Pointer helpers shared by handoff selectors and handoff references.
export const MISSING = Symbol('missing')

export function parsePointer(pointer) {
  if (pointer === '') return null
  if (typeof pointer !== 'string' || !pointer.startsWith('/')) throw teamError('RP_TEAM_HANDOFF_SELECTOR_INVALID', 'Handoff selectors must be JSON Pointer paths')
  return pointer.slice(1).split('/').map(segment => {
    if (/~(?:[^01]|$)/u.test(segment)) throw teamError('RP_TEAM_HANDOFF_SELECTOR_INVALID', `Invalid JSON Pointer escape in ${pointer}`)
    return segment.replace(/~1/g, '/').replace(/~0/g, '~')
  })
}

export function readPath(value, segments) {
  let current = value
  for (const segment of segments) {
    if (Array.isArray(current) && /^(?:0|[1-9]\d*)$/u.test(segment)) current = current[Number(segment)]
    else if (current && typeof current === 'object' && Object.hasOwn(current, segment)) current = current[segment]
    else return MISSING
  }
  return current
}

const REF_KEYS = new Set(['$ref', 'pointer', 'side'])

/** A handoff reference is an object with a string `$ref` and nothing but the optional `pointer` and `side`. */
export function isHandoffRef(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && typeof value.$ref === 'string' && Object.keys(value).every(key => REF_KEYS.has(key))
}

/** The reference a member uses for the nth request it sent through one handoff in this run. */
export function nextHandoffRef(rows, { from, handoffId }) {
  const count = rows.filter(row => row.from === from && row.handoffId === handoffId).length
  return `${handoffId}#${count + 1}`
}

/**
 * Replace every handoff reference in `value` with an exact copy of what it names, so a member can forward a
 * result it received (or a request it sent) without re-typing it. References resolve only against requests the
 * writer itself sent in this run; `side: "result"` (the default) needs a completed request.
 */
export function resolveHandoffRefs(value, { rows = [], writer }) {
  const refs = []
  const resolved = walk(value, '')
  return { value: resolved, refs }

  function walk(current, at) {
    if (Array.isArray(current)) return current.map((item, index) => walk(item, `${at}/${index}`))
    if (current === null || typeof current !== 'object') return current
    if (isHandoffRef(current)) return lookup(current, at)
    const result = {}
    for (const [key, item] of Object.entries(current)) {
      Object.defineProperty(result, key, {
        value: walk(item, `${at}/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`),
        enumerable: true, configurable: true, writable: true
      })
    }
    return result
  }

  function lookup(reference, at) {
    const side = reference.side ?? 'result'
    const pointer = reference.pointer ?? ''
    const where = at || '/'
    if (side !== 'result' && side !== 'request') fail(`Handoff reference at ${where} has side ${JSON.stringify(side)}; use "result" or "request"`)
    const row = rows.find(item => item.from === writer && item.ref === reference.$ref)
    if (!row) fail(`Handoff reference ${reference.$ref} at ${where} does not name a request you sent in this run`)
    if (side === 'result' && row.status !== 'completed') fail(`Handoff reference ${reference.$ref} at ${where} has no result: that request ${row.status}`)
    const base = side === 'request' ? row.request?.data : row.result?.data
    let segments
    try { segments = parsePointer(pointer) } catch { fail(`Handoff reference ${reference.$ref} at ${where} has an invalid pointer ${JSON.stringify(pointer)}`) }
    const found = segments === null ? base : readPath(base, segments)
    if (found === undefined || found === MISSING) {
      fail(`Handoff reference ${reference.$ref} at ${where} finds nothing at ${side} data${pointer || ' (whole data)'}`)
    }
    refs.push({ ref: reference.$ref, side, ...(pointer ? { pointer } : {}), at: where })
    return structuredClone(found)
  }

  function fail(message) {
    throw teamError('RP_TEAM_HANDOFF_REF_INVALID', `${message}. ${availableRefs(rows, writer)}`)
  }
}

function availableRefs(rows, writer) {
  const own = rows.filter(row => row.from === writer && typeof row.ref === 'string')
  if (!own.length) return 'You have sent no handoff requests in this run, so there is nothing to reference.'
  return `References you can use: ${own.map(row => `${row.ref} (${row.status === 'completed' ? 'result and request' : `request only; ${row.status}`})`).join(', ')}.`
}

/**
 * The failure text a requester sees. The full upstream error stays in the request row and the trace; a
 * requester gets no raw model output, so it cannot mistake a broken answer for a usable one.
 */
export function requesterFacingError(error, row) {
  const code = String(error?.code ?? 'RP_TEAM_HANDOFF_FAILED')
  let message = String(error?.message ?? error ?? 'Handoff failed')
  const dump = message.indexOf('\n\nReceived arguments:')
  const malformed = /^Tool call "([^"]+)": /u.exec(message)
  if (malformed && dump !== -1) {
    message = `Target ${row?.to ?? 'agent'} failed: its model produced malformed arguments for tool ${malformed[1]}; nothing from that output was returned.`
  } else {
    if (dump !== -1) message = message.slice(0, dump)
    if (message.length > 400) message = `${message.slice(0, 400)}…`
  }
  return { code, message }
}
