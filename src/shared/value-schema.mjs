const VALUE_TYPES = new Set(['any', 'string', 'number', 'boolean', 'object', 'array', 'null'])
const SCHEMA_KEYS = new Set(['type', 'properties', 'required', 'items', 'enum', 'minimum', 'maximum'])

/** Normalize the deliberately small, data-only value schema supported by RP Team. */
export function normalizeValueSchema(schema, label = 'valueSchema') {
  if (!isRecord(schema)) throw schemaError(`${label} must be an object`)
  for (const key of Object.keys(schema)) {
    if (!SCHEMA_KEYS.has(key)) throw schemaError(`${label} has unsupported key ${key}`)
  }

  const result = {}
  if (schema.type !== undefined) {
    if (!VALUE_TYPES.has(schema.type)) throw schemaError(`${label}.type must be a supported value type`)
    result.type = schema.type
  }
  if (schema.properties !== undefined) {
    if (!isRecord(schema.properties)) throw schemaError(`${label}.properties must be an object`)
    if (result.type !== undefined && result.type !== 'object' && result.type !== 'any') {
      throw schemaError(`${label}.properties requires type object or any`)
    }
    result.properties = Object.fromEntries(Object.entries(schema.properties).map(([key, value]) => [
      key, normalizeValueSchema(value, `${label}.properties.${key}`)
    ]))
  }
  if (schema.required !== undefined) {
    if (!Array.isArray(schema.required) || schema.required.some(key => typeof key !== 'string')) {
      throw schemaError(`${label}.required must be an array of property names`)
    }
    if (new Set(schema.required).size !== schema.required.length) throw schemaError(`${label}.required cannot contain duplicates`)
    result.required = [...schema.required]
  }
  if (schema.items !== undefined) {
    if (result.type !== undefined && result.type !== 'array' && result.type !== 'any') {
      throw schemaError(`${label}.items requires type array or any`)
    }
    result.items = normalizeValueSchema(schema.items, `${label}.items`)
  }
  if (schema.enum !== undefined) {
    if (!Array.isArray(schema.enum)) throw schemaError(`${label}.enum must be an array of JSON values`)
    result.enum = schema.enum.map((value, index) => cloneJson(value, `${label}.enum[${index}]`))
  }
  if (schema.minimum !== undefined) {
    if (!Number.isFinite(schema.minimum)) throw schemaError(`${label}.minimum must be a finite number`)
    result.minimum = schema.minimum
  }
  if (schema.maximum !== undefined) {
    if (!Number.isFinite(schema.maximum)) throw schemaError(`${label}.maximum must be a finite number`)
    result.maximum = schema.maximum
  }
  if (result.minimum !== undefined && result.maximum !== undefined && result.minimum > result.maximum) {
    throw schemaError(`${label}.minimum cannot exceed maximum`)
  }
  if ((result.minimum !== undefined || result.maximum !== undefined)
    && result.type !== undefined && result.type !== 'number' && result.type !== 'any') {
    throw schemaError(`${label}.minimum and maximum require type number or any`)
  }
  return result
}

/** Return validation issues with JSON-Pointer paths relative to the supplied value. */
export function validateValueSchema(value, schema) {
  if (schema === undefined) return []
  const normalized = normalizeValueSchema(schema)
  const issues = []
  validate(value, normalized, '', issues)
  return issues
}

/** Resolve a nested schema for a value addressed by a JSON Pointer. */
export function valueSchemaAtPath(schema, segments) {
  let current = schema
  for (const segment of segments) {
    if (!current) return undefined
    if (current.properties && Object.hasOwn(current.properties, segment)) {
      current = current.properties[segment]
    } else if (current.items && /^\d+$/u.test(segment)) {
      current = current.items
    } else {
      return undefined
    }
  }
  return current
}

function validate(value, schema, path, issues) {
  if (schema.type && !matchesType(value, schema.type)) {
    issues.push({ path, message: `must be ${schema.type}` })
    return
  }
  if (schema.enum && !schema.enum.some(candidate => jsonEqual(candidate, value))) {
    issues.push({ path, message: 'must match one of the allowed values' })
  }
  if (schema.minimum !== undefined || schema.maximum !== undefined) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      issues.push({ path, message: 'must be a finite number' })
    } else {
      if (schema.minimum !== undefined && value < schema.minimum) issues.push({ path, message: `must be at least ${schema.minimum}` })
      if (schema.maximum !== undefined && value > schema.maximum) issues.push({ path, message: `must be at most ${schema.maximum}` })
    }
  }
  if (schema.required?.length || schema.properties) {
    if (!isRecord(value)) {
      issues.push({ path, message: 'must be an object' })
    } else {
      for (const key of schema.required ?? []) {
        if (!Object.hasOwn(value, key)) issues.push({ path: joinPointer(path, key), message: 'is required' })
      }
      for (const [key, childSchema] of Object.entries(schema.properties ?? {})) {
        if (Object.hasOwn(value, key)) validate(value[key], childSchema, joinPointer(path, key), issues)
      }
    }
  }
  if (schema.items) {
    if (!Array.isArray(value)) {
      issues.push({ path, message: 'must be an array' })
    } else {
      value.forEach((item, index) => validate(item, schema.items, joinPointer(path, String(index)), issues))
    }
  }
}

function matchesType(value, type) {
  if (type === 'any') return true
  if (type === 'null') return value === null
  if (type === 'object') return isRecord(value)
  if (type === 'array') return Array.isArray(value)
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value)
  return typeof value === type
}

function cloneJson(value, label) {
  if (!isJsonValue(value)) throw schemaError(`${label} must be a JSON value`)
  return JSON.parse(JSON.stringify(value))
}

function isJsonValue(value, seen = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (typeof value !== 'object' || seen.has(value)) return false
  seen.add(value)
  const valid = Array.isArray(value)
    ? value.every(item => isJsonValue(item, seen))
    : isRecord(value) && Object.values(value).every(item => isJsonValue(item, seen))
  seen.delete(value)
  return valid
}

function jsonEqual(left, right) { return stableJson(left) === stableJson(right) }
function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (isRecord(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`
  return JSON.stringify(value)
}
function joinPointer(parent, segment) { return `${parent}/${segment.replace(/~/g, '~0').replace(/\//g, '~1')}` }
function isRecord(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) }
function schemaError(message) { return Object.assign(new Error(message), { code: 'RP_TEAM_INVALID_CONFIG' }) }
