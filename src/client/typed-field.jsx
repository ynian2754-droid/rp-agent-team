import { React } from './react.js'
import { createKeyedStore } from './keyed-store.js'
import { useKeyed } from './client-state.js'
import { StateValueEditor } from './state-value-editor.jsx'
import { formValue, valueError, valueForm } from './state-editor-model.js'
import { stableContent } from './author-model.js'

export const typedBuffers = createKeyedStore(() => null)
export function conditionValueInvalid(value, key) {
  if (value.op === 'all' || value.op === 'any') return value.conditions.some((child, index) => conditionValueInvalid(child, `${key}/${index}`))
  if (value.op === 'not') return conditionValueInvalid(value.condition, `${key}/not`)
  const buffered = typedBuffers.has(key) ? typedBuffers.get(key) : null
  return value.op === 'compare' && buffered?.content === stableContent(value.value) && Boolean(valueError(buffered.form))
}

export function TypedField({ value, onChange, bufferKey, onInvalid = () => {}, chooseType = true }) {
  const buffered = useKeyed(typedBuffers, bufferKey)
  const content = stableContent(value)
  const form = buffered?.content === content ? buffered.form : valueForm(value)
  const change = next => {
    const invalid = Boolean(valueError(next))
    const result = invalid ? value : formValue(next)
    typedBuffers.update(bufferKey, { form: next, content: stableContent(result) })
    onInvalid(invalid)
    if (!invalid) onChange(result)
  }
  return <StateValueEditor node={form} onChange={change} chooseType={chooseType} />
}
