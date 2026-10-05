import { normalizeValueSchema, validateValueSchema } from './value-schema.mjs'
import { normalizeTeamConfig, teamError } from './schema.mjs'

const PARAMETER_TYPES = new Set(['text', 'number', 'boolean', 'choice', 'agent', 'model', 'state'])
const BINDING_MODES = new Set(['set', 'text'])
const SHA256_K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
]

/** Normalize declarations against the stable agent roster and declared state paths. */
export function normalizeAuthorParameters(value, agents, definitions) {
  if (!Array.isArray(value)) throw invalid('authorParameters must be an array')
  if (!Array.isArray(agents) || !Array.isArray(definitions)) throw invalid('Author parameter references require agents and state definitions')
  const agentIds = new Set(agents.map(agent => agent.id))
  const parameters = value.map((item, index) => normalizeParameter(item, index, agents, agentIds, definitions))
  const ids = new Set()
  for (const parameter of parameters) {
    if (ids.has(parameter.id)) throw invalid(`Duplicate author parameter id: ${parameter.id}`)
    ids.add(parameter.id)
  }
  return parameters
}

/** Validate supplied overrides, preserving the distinction between absent values and defaults. */
export function normalizeSuppliedParameterValues(config, values = {}) {
  const normalized = normalizeTeamConfig(config)
  return normalizeValuesFor(normalized.authorParameters ?? [], normalized.agents, normalized.state.definitions, values)
}

function normalizeValuesFor(parameters, agents, definitions, values = {}) {
  if (!isRecord(values)) throw invalid('parameterValues must be an object')
  const byId = new Map(parameters.map(parameter => [parameter.id, parameter]))
  const result = {}
  for (const [id, value] of Object.entries(values)) {
    const parameter = byId.get(id)
    if (!parameter) throw teamError('RP_TEAM_INVALID_PARAMETER_VALUE', `Unknown author parameter ${id}`)
    try {
      defineOwn(result, id, validateParameterValue(parameter, value, agents, definitions, `parameterValues.${id}`))
    } catch (error) {
      if (error?.code === 'RP_TEAM_INVALID_CONFIG') {
        throw teamError('RP_TEAM_INVALID_PARAMETER_VALUE', error.message)
      }
      throw error
    }
  }
  return result
}

/** Resolve defaults and overrides into one validated, immutable run configuration. */
export function resolveAuthorParameters(config, values = {}) {
  const source = normalizeTeamConfig(config)
  const supplied = normalizeValuesFor(source.authorParameters ?? [], source.agents, source.state.definitions, values)
  const effectiveValues = {}
  for (const parameter of source.authorParameters ?? []) {
    if (Object.hasOwn(supplied, parameter.id)) {
      defineOwn(effectiveValues, parameter.id, supplied[parameter.id])
    } else if (Object.hasOwn(parameter, 'default')) {
      defineOwn(effectiveValues, parameter.id, cloneJson(parameter.default))
    } else {
      throw teamError('RP_TEAM_PARAMETER_REQUIRED', `Author parameter ${parameter.id} requires a value`)
    }
  }

  const resolvedDraft = cloneJson(source)
  const changes = []
  for (const parameter of source.authorParameters ?? []) {
    const value = effectiveValues[parameter.id]
    for (const binding of parameter.bindings) {
      const target = resolveTarget(resolvedDraft, binding.target)
      if (binding.mode === 'text') {
        if (parameter.type !== 'text' || typeof target.value !== 'string') {
          throw invalid(`Text binding for ${parameter.id} must target an existing string field`)
        }
        const marker = `{{param:${parameter.id}}}`
        if (!target.value.includes(marker)) throw invalid(`Text binding for ${parameter.id} has no ${marker} token at its target`)
        const next = target.value.split(marker).join(value)
        if (next !== target.value) {
          changes.push(change(parameter.id, binding, target.value, next, false))
          target.set(next)
        }
        continue
      }
      const next = binding.valuePath === undefined ? cloneJson(value) : cloneJson(requirePointer(value, binding.valuePath, parameter.id))
      const before = target.value
      if (stableJson(before) !== stableJson(next) || target.missing) {
        changes.push(change(parameter.id, binding, before, next, target.missing || before === undefined))
        target.set(next)
      }
    }
  }

  const resolvedConfig = normalizeTeamConfig(resolvedDraft)
  const normalizedValues = cloneJson(effectiveValues)
  return {
    config: resolvedConfig,
    values: normalizedValues,
    changes,
    sourceHash: sha256(stableJson(source)),
    resolvedHash: sha256(stableJson({ config: resolvedConfig, values: normalizedValues }))
  }
}

function normalizeParameter(value, index, agents, agentIds, definitions) {
  if (!isRecord(value)) throw invalid(`authorParameters[${index}] must be an object`)
  rejectUnknown(value, ['id', 'name', 'description', 'type', 'default', 'options', 'valueSchema', 'bindings'], `authorParameters[${index}]`)
  const id = identifier(value.id, `authorParameters[${index}].id`)
  const name = requiredText(value.name, `authorParameters[${index}].name`)
  if (!PARAMETER_TYPES.has(value.type)) throw invalid(`Author parameter ${id} has an unsupported type`)
  const parameter = { id, name, type: value.type }
  if (value.description !== undefined) parameter.description = textOrEmpty(value.description, `Author parameter ${id} description`)
  if (value.valueSchema !== undefined) parameter.valueSchema = normalizeValueSchema(value.valueSchema, `Author parameter ${id} valueSchema`)
  if (value.options !== undefined) {
    if (value.type !== 'choice' || !Array.isArray(value.options) || value.options.length === 0) {
      throw invalid(`Author parameter ${id} options are only valid as a non-empty choice list`)
    }
    const options = value.options.map((option, optionIndex) => {
      if (!isRecord(option)) throw invalid(`Author parameter ${id} option ${optionIndex} must be an object`)
      rejectUnknown(option, ['label', 'value'], `Author parameter ${id} option ${optionIndex}`)
      return { label: requiredText(option.label, `Author parameter ${id} option label`), value: cloneJson(option.value) }
    })
    if (new Set(options.map(option => stableJson(option.value))).size !== options.length) {
      throw invalid(`Author parameter ${id} options must have distinct values`)
    }
    parameter.options = options
  } else if (value.type === 'choice') {
    throw invalid(`Choice parameter ${id} requires options`)
  }
  if (Object.hasOwn(value, 'default')) {
    parameter.default = validateParameterValue({ ...parameter, options: parameter.options }, value.default, agents, definitions, `Author parameter ${id} default`)
  }
  if (!Array.isArray(value.bindings)) throw invalid(`Author parameter ${id} bindings must be an array`)
  parameter.bindings = value.bindings.map((binding, bindingIndex) => normalizeBinding(binding, id, value.type, agents, agentIds, definitions, bindingIndex))
  const bindingKeys = new Set()
  for (const binding of parameter.bindings) {
    const key = stableJson(binding.target)
    if (binding.mode === 'set' && bindingKeys.has(key)) throw invalid(`Author parameter ${id} binds the same target more than once`)
    if (binding.mode === 'set') bindingKeys.add(key)
  }
  return parameter
}

function normalizeBinding(value, parameterId, parameterType, agents, agentIds, definitions, index) {
  if (!isRecord(value)) throw invalid(`Author parameter ${parameterId} binding ${index} must be an object`)
  rejectUnknown(value, ['target', 'mode', 'valuePath'], `Author parameter ${parameterId} binding ${index}`)
  if (!BINDING_MODES.has(value.mode)) throw invalid(`Author parameter ${parameterId} binding ${index} has an unsupported mode`)
  if (value.mode === 'text' && parameterType !== 'text') throw invalid(`Text binding ${parameterId} requires a text parameter`)
  const target = normalizeTarget(value.target, parameterId, agents, agentIds, definitions)
  const result = { target, mode: value.mode }
  if (value.valuePath !== undefined) result.valuePath = jsonPointer(value.valuePath, `Author parameter ${parameterId} valuePath`)
  if (value.mode === 'text' && result.valuePath !== undefined) throw invalid(`Text binding ${parameterId} cannot use valuePath`)
  return result
}

function normalizeTarget(value, parameterId, agents, agentIds, definitions) {
  if (!isRecord(value)) throw invalid(`Author parameter ${parameterId} target must be an object`)
  if (value.kind === 'agent') {
    rejectUnknown(value, ['kind', 'agentId', 'path'], `Author parameter ${parameterId} agent target`)
    if (typeof value.agentId !== 'string' || !agentIds.has(value.agentId)) throw invalid(`Author parameter ${parameterId} references an unknown stable agent id`)
    const path = editablePointer(value.path, `Author parameter ${parameterId} target path`)
    const agent = agents.find(item => item.id === value.agentId)
    if (!pointerCanBeTarget(agent, path)) throw invalid(`Author parameter ${parameterId} target ${value.agentId}${path} cannot be traversed`)
    return { kind: 'agent', agentId: value.agentId, path }
  }
  if (value.kind === 'team') {
    rejectUnknown(value, ['kind', 'path'], `Author parameter ${parameterId} team target`)
    const path = editablePointer(value.path, `Author parameter ${parameterId} target path`)
    const root = decodePointer(path)[0]
    if (!['name', 'version', 'metadata', 'execution', 'output'].includes(root)) {
      throw invalid(`Author parameter ${parameterId} cannot target Team field ${root}`)
    }
    return { kind: 'team', path }
  }
  if (value.kind === 'state_default') {
    rejectUnknown(value, ['kind', 'namespace', 'path'], `Author parameter ${parameterId} state default target`)
    const namespace = requiredText(value.namespace, `Author parameter ${parameterId} state namespace`)
    if (!(namespace === 'shared' || namespace === 'world' || namespace.startsWith('private:'))) {
      throw invalid(`Author parameter ${parameterId} has an invalid state namespace`)
    }
    const path = jsonPointer(value.path, `Author parameter ${parameterId} state path`)
    if (!definitions.some(item => item.namespace === namespace && item.path === path)) {
      throw invalid(`Author parameter ${parameterId} references an undefined state default ${namespace}${path}`)
    }
    return { kind: 'state_default', namespace, path }
  }
  throw invalid(`Author parameter ${parameterId} has an unsupported target kind`)
}

function validateParameterValue(parameter, value, agents, definitions, label) {
  let normalized
  switch (parameter.type) {
    case 'text':
      if (typeof value !== 'string') throw invalid(`${label} must be text`)
      normalized = value
      break
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) throw invalid(`${label} must be a finite number`)
      normalized = value
      break
    case 'boolean':
      if (typeof value !== 'boolean') throw invalid(`${label} must be a boolean`)
      normalized = value
      break
    case 'choice':
      if (!parameter.options?.some(option => stableJson(option.value) === stableJson(value))) {
        throw invalid(`${label} must match one of the declared choices`)
      }
      normalized = cloneJson(value)
      break
    case 'agent':
      if (typeof value !== 'string' || !agents.some(agent => agent.id === value)) throw invalid(`${label} must name an existing stable agent id`)
      normalized = value
      break
    case 'model':
      if (value === 'inherit') normalized = value
      else if (isRecord(value) && typeof value.provider === 'string' && value.provider.trim() && typeof value.model === 'string' && value.model.trim()
        && Object.keys(value).every(key => ['provider', 'model'].includes(key))) {
        normalized = { provider: value.provider, model: value.model }
      } else throw invalid(`${label} must be "inherit" or a provider/model object`)
      break
    case 'state':
      if (!isRecord(value) || Object.keys(value).some(key => !['namespace', 'path'].includes(key))
        || typeof value.namespace !== 'string' || typeof value.path !== 'string'
        || !definitions.some(item => item.namespace === value.namespace && item.path === value.path)) {
        throw invalid(`${label} must reference a declared state namespace and path`)
      }
      normalized = { namespace: value.namespace, path: value.path }
      break
    default:
      throw invalid(`${label} has an unsupported parameter type`)
  }
  const issues = validateValueSchema(normalized, parameter.valueSchema)
  if (issues.length) throw invalid(`${label}${issues[0].path || ''} ${issues[0].message}`)
  return normalized
}

function resolveTarget(config, target) {
  if (target.kind === 'agent') {
    const agent = config.agents.find(item => item.id === target.agentId)
    if (!agent) throw invalid(`Author parameter target agent ${target.agentId} no longer exists`)
    return pointerTarget(agent, target.path)
  }
  if (target.kind === 'team') return pointerTarget(config, target.path)
  const definition = config.state.definitions.find(item => item.namespace === target.namespace && item.path === target.path)
  if (!definition) throw invalid(`Author parameter state default ${target.namespace}${target.path} no longer exists`)
  return {
    get value() { return definition.default },
    get missing() { return !Object.hasOwn(definition, 'default') },
    set(value) { defineOwn(definition, 'default', value) }
  }
}

function pointerTarget(root, pointer) {
  const segments = decodePointer(pointer)
  let parent = root
  for (const segment of segments.slice(0, -1)) {
    if (Array.isArray(parent)) {
      const index = arrayIndex(segment, parent.length)
      parent = parent[index]
    } else if (isRecord(parent) && Object.hasOwn(parent, segment)) parent = parent[segment]
    else if (isRecord(parent)) {
      const next = {}
      defineOwn(parent, segment, next)
      parent = next
    }
    else throw invalid(`Author parameter target ${pointer} does not exist`)
    if (parent === null || typeof parent !== 'object') throw invalid(`Author parameter target ${pointer} cannot be traversed`)
  }
  const key = segments.at(-1)
  if (!key) throw invalid('Author parameter targets must address a field')
  if (Array.isArray(parent)) {
    const index = arrayIndex(key, parent.length)
    return {
      get value() { return parent[index] },
      get missing() { return parent[index] === undefined },
      set(value) { parent[index] = cloneJson(value) }
    }
  }
  if (!isRecord(parent)) throw invalid(`Author parameter target ${pointer} is not an editable object field`)
  return {
    get value() { return Object.hasOwn(parent, key) ? parent[key] : undefined },
    get missing() { return !Object.hasOwn(parent, key) },
    set(value) { defineOwn(parent, key, cloneJson(value)) }
  }
}

function change(parameterId, binding, before, after, beforeMissing) {
  const authorityChanged = binding.target.kind === 'agent'
    && (binding.target.path === '/statePermissions' || binding.target.path.startsWith('/statePermissions/')
      || binding.target.path === '/outputAuthority' || binding.target.path.startsWith('/outputAuthority/'))
    && (beforeMissing || stableJson(before) !== stableJson(after))
  return {
    parameterId,
    target: cloneJson(binding.target),
    mode: binding.mode,
    ...(beforeMissing ? { beforeMissing: true } : { before: cloneJson(before) }),
    after: cloneJson(after),
    ...(authorityChanged ? { authorityChange: true } : {})
  }
}

function requirePointer(value, pointer, parameterId) {
  const result = lookupPointer(value, pointer)
  if (!result.exists) throw invalid(`Author parameter ${parameterId} value has no field at ${pointer || '/'}`)
  return result.value
}

function editablePointer(value, label) {
  const pointer = jsonPointer(value, label)
  const segments = decodePointer(pointer)
  const isIdField = segment => /^(?:id|schemaVersion|authorParameters|history|credential|credentials|password|secret|api[_-]?key|access[_-]?token|refresh[_-]?token)$/iu.test(segment)
  if (!segments.length || segments.some(isIdField)) {
    throw invalid(`${label} targets a protected or non-editable config field`)
  }
  return pointer
}

function pointerCanBeTarget(value, pointer) {
  const segments = decodePointer(pointer)
  if (!segments.length) return false
  let current = value
  for (const segment of segments.slice(0, -1)) {
    if (Array.isArray(current)) {
      try { current = current[arrayIndex(segment, current.length)] } catch { return false }
    } else if (isRecord(current) && Object.hasOwn(current, segment)) current = current[segment]
    else if (isRecord(current)) current = {}
    else return false
    if (current === null || typeof current !== 'object') return false
  }
  if (Array.isArray(current)) {
    try { arrayIndex(segments.at(-1), current.length); return true } catch { return false }
  }
  return isRecord(current)
}

function lookupPointer(value, pointer) {
  if (pointer === '') return { exists: value !== undefined, value }
  let current = value
  for (const segment of decodePointer(pointer)) {
    if (current === null || typeof current !== 'object' || !Object.hasOwn(current, segment)) return { exists: false }
    current = current[segment]
  }
  return { exists: true, value: current }
}
function jsonPointer(value, label) {
  if (typeof value !== 'string' || (value !== '' && !value.startsWith('/'))
    || value.split('/').slice(1).some(segment => /~(?![01])/u.test(segment))) throw invalid(`${label} must be a JSON Pointer`)
  return value
}
function decodePointer(pointer) { return pointer === '' ? [] : pointer.slice(1).split('/').map(segment => segment.replace(/~1/g, '/').replace(/~0/g, '~')) }
function arrayIndex(value, length) {
  if (!/^\d+$/u.test(value)) throw invalid(`Author parameter array target ${value} is invalid`)
  const index = Number(value)
  if (!Number.isSafeInteger(index) || index >= length) throw invalid(`Author parameter array target ${value} is out of bounds`)
  return index
}
function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (isRecord(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`
  return JSON.stringify(value)
}
function sha256(value) {
  const source = new TextEncoder().encode(value)
  const paddedLength = Math.ceil((source.length + 9) / 64) * 64
  const bytes = new Uint8Array(paddedLength)
  bytes.set(source)
  bytes[source.length] = 0x80
  const bitLength = source.length * 8
  const view = new DataView(bytes.buffer)
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x100000000), false)
  view.setUint32(paddedLength - 4, bitLength >>> 0, false)

  const state = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]
  const words = new Uint32Array(64)
  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let index = 0; index < 16; index += 1) words[index] = view.getUint32(offset + index * 4, false)
    for (let index = 16; index < 64; index += 1) {
      const x = words[index - 15]
      const y = words[index - 2]
      const sigma0 = rotateRight(x, 7) ^ rotateRight(x, 18) ^ (x >>> 3)
      const sigma1 = rotateRight(y, 17) ^ rotateRight(y, 19) ^ (y >>> 10)
      words[index] = (words[index - 16] + sigma0 + words[index - 7] + sigma1) >>> 0
    }
    let [a, b, c, d, e, f, g, h] = state
    for (let index = 0; index < 64; index += 1) {
      const sum1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25)
      const choose = (e & f) ^ (~e & g)
      const first = (h + sum1 + choose + SHA256_K[index] + words[index]) >>> 0
      const sum0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22)
      const majority = (a & b) ^ (a & c) ^ (b & c)
      const second = (sum0 + majority) >>> 0
      h = g; g = f; f = e; e = (d + first) >>> 0
      d = c; c = b; b = a; a = (first + second) >>> 0
    }
    state[0] = (state[0] + a) >>> 0; state[1] = (state[1] + b) >>> 0
    state[2] = (state[2] + c) >>> 0; state[3] = (state[3] + d) >>> 0
    state[4] = (state[4] + e) >>> 0; state[5] = (state[5] + f) >>> 0
    state[6] = (state[6] + g) >>> 0; state[7] = (state[7] + h) >>> 0
  }
  return state.map(value => value.toString(16).padStart(8, '0')).join('')
}
function rotateRight(value, bits) { return (value >>> bits) | (value << (32 - bits)) }
function cloneJson(value) {
  const serialized = JSON.stringify(value)
  if (serialized === undefined) throw invalid('Author parameter values must be JSON serializable')
  return JSON.parse(serialized)
}
function requiredText(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw invalid(`${label} must not be empty`)
  return value.trim()
}
function textOrEmpty(value, label) {
  if (typeof value !== 'string') throw invalid(`${label} must be text`)
  return value
}
function identifier(value, label) {
  const result = requiredText(value, label)
  if (result.length > 128 || /[\u0000-\u001f\u007f]/u.test(result)) throw invalid(`${label} has an invalid format`)
  return result
}
function rejectUnknown(value, allowed, label) {
  const unknown = Object.keys(value).filter(key => !allowed.includes(key))
  if (unknown.length) throw invalid(`${label} has unsupported fields: ${unknown.join(', ')}`)
}
function defineOwn(object, key, value) { Object.defineProperty(object, key, { value, enumerable: true, configurable: true, writable: true }) }
function isRecord(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) }
function invalid(message) { return teamError('RP_TEAM_INVALID_CONFIG', message) }
