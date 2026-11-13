export function setPointerValue(value, pointer, next) {
  const parts = pointerSegments(pointer)
  if (!parts.length) return structuredClone(next)
  const result = structuredClone(value ?? {})
  let current = result
  for (let index = 0; index < parts.length - 1; index += 1) {
    const part = parts[index]
    if (!Object.hasOwn(current, part) || current[part] === null || typeof current[part] !== 'object') {
      Object.defineProperty(current, part, {
        value: /^\d+$/u.test(parts[index + 1]) ? [] : {}, enumerable: true, configurable: true, writable: true
      })
    }
    current = current[part]
  }
  Object.defineProperty(current, parts.at(-1), {
    value: structuredClone(next), enumerable: true, configurable: true, writable: true
  })
  return result
}

export function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (isRecord(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`
  return JSON.stringify(value)
}

export function escapePointer(value) { return String(value).replace(/~/gu, '~0').replace(/\//gu, '~1') }
export function decodePointerSegment(value) { return value.replace(/~1/gu, '/').replace(/~0/gu, '~') }
function pointerSegments(pointer) { return pointer === '' ? [] : pointer.slice(1).split('/').map(decodePointerSegment) }
function isRecord(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) }
