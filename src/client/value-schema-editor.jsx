import { React } from './react.js'
import { t } from './i18n.js'
import { Field, Check } from './fields.jsx'
import { TypedField, typedBuffers } from './typed-field.jsx'
import { useKeyed } from './client-state.js'
import { removedChildKey } from './author-model.js'
import { valueError } from './state-editor-model.js'

export function ValueSchemaEditor({ value = {}, onChange, bufferKey, onInvalid = () => {} }) {
  const type = value.type || 'any'
  const patch = changes => onChange({ ...value, ...changes })
  const remove = key => onChange(Object.fromEntries(Object.entries(value).filter(([field]) => field !== key)))
  const properties = Object.entries(value.properties || {})
  const rename = (old, name) => {
    if (name !== old && Object.hasOwn(value.properties || {}, name)) return false
    patch({ properties: Object.fromEntries(properties.map(([key, schema]) => [key === old ? name : key, schema])),
      ...(value.required ? { required: value.required.map(key => key === old ? name : key) } : {}) })
    return true
  }
  return <div className="rp-team-schema-editor">
    <Field label={t('author.allowedType')}><select value={type} onChange={event => {
      const next = event.target.value
      typedBuffers.removeWhere(key => key.startsWith(`${bufferKey}/`))
      onInvalid(`${bufferKey}/`, false)
      onChange({ type: next })
    }}>{['any', 'string', 'number', 'boolean', 'object', 'array', 'null'].map(item => <option key={item} value={item}>{t(`stateForm.types.${item}`)}</option>)}</select></Field>
    {type === 'number' ? <div className="rp-team-grid">{['minimum', 'maximum'].map(key => <Field key={key} label={t(`author.${key}`)}>
      <input type="text" inputMode="decimal" value={value[key] ?? ''} onChange={event => {
        const text = event.target.value
        if (!text) remove(key)
        else patch({ [key]: text.trim() && Number.isFinite(Number(text)) ? Number(text) : text })
      }} />
    </Field>)}</div> : null}
    {type === 'object' ? <>
      {properties.map(([name, schema], index) => <SchemaProperty key={index} name={name} value={schema} required={(value.required || []).includes(name)}
        onRename={next => rename(name, next)} bufferKey={`${bufferKey}/field-${index}`} onInvalid={onInvalid}
        onChange={next => patch({ properties: { ...value.properties, [name]: next } })}
        onRequired={enabled => patch({ required: enabled ? [...new Set([...(value.required || []), name])] : (value.required || []).filter(key => key !== name) })}
        onRemove={() => {
          const buffers = typedBuffers.remapKeys(key => removedChildKey(key, bufferKey, index, 'field-'))
          onInvalid(`${bufferKey}/`, false)
          for (const [key, draft] of buffers) if (key.startsWith(`${bufferKey}/`) && (draft?.form && valueError(draft.form) || draft?.input !== undefined && draft.input !== draft.name)) onInvalid(key, true)
          patch({ properties: Object.fromEntries(properties.filter(([key]) => key !== name)), required: (value.required || []).filter(key => key !== name) })
        }} />)}
      <button type="button" className="rp-team-quiet is-bordered" onClick={() => {
        let index = 1; while (Object.hasOwn(value.properties || {}, `${t('stateForm.newField')} ${index}`)) index++
        patch({ properties: { ...value.properties, [`${t('stateForm.newField')} ${index}`]: { type: 'string' } } })
      }}>{t('author.addFieldRule')}</button>
    </> : null}
    {type === 'array' ? <fieldset className="rp-team-rule-node"><legend>{t('author.itemRule')}</legend>
      <ValueSchemaEditor value={value.items || { type: 'any' }} onChange={items => patch({ items })} bufferKey={`${bufferKey}/items`} onInvalid={onInvalid} />
    </fieldset> : null}
    <Check label={t('author.limitChoices')} checked={Boolean(value.enum)} onChange={enabled => { onInvalid(`${bufferKey}/enum`, false); typedBuffers.removeWhere(key => key === `${bufferKey}/enum`); enabled ? patch({ enum: [] }) : remove('enum') }} />
    {value.enum ? <TypedField value={value.enum} chooseType={false} bufferKey={`${bufferKey}/enum`} onChange={enumValues => patch({ enum: enumValues })} onInvalid={invalid => onInvalid(`${bufferKey}/enum`, invalid)} /> : null}
  </div>
}

function SchemaProperty({ name, value, required, onRename, onChange, onRequired, onRemove, bufferKey, onInvalid }) {
  const buffered = useKeyed(typedBuffers, `${bufferKey}/name`)
  const input = buffered?.name === name ? buffered.input : name
  const invalid = input !== name
  return <fieldset className="rp-team-rule-node"><legend>{name || t('author.unnamedField')}</legend>
    <Field label={t('stateForm.fieldName')} error={invalid ? t('stateForm.errors.duplicateField') : ''}><input value={input} onChange={event => {
      const next = event.target.value
      const accepted = onRename(next)
      typedBuffers.update(`${bufferKey}/name`, { name: accepted ? next : name, input: next })
      onInvalid(`${bufferKey}/name`, !accepted)
    }} /></Field>
    <Check label={t('author.required')} checked={required} onChange={onRequired} />
    <ValueSchemaEditor value={value} onChange={onChange} bufferKey={bufferKey} onInvalid={onInvalid} />
    <button type="button" className="rp-team-link is-danger" onClick={() => { onInvalid(`${bufferKey}/name`, false); onRemove() }}>{t('remove')}</button>
  </fieldset>
}
