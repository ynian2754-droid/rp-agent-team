import { React } from './react.js'
import { t } from './i18n.js'
import { Field } from './fields.jsx'
import { VALUE_TYPES, addValueEntry, emptyValue, moveValueEntry, valueError, valueForm } from './state-editor-model.js'

export function StateValueEditor({ node, onChange, chooseType = false }) {
  const patch = changes => onChange({ ...node, ...changes })
  const changeEntry = (id, changes) => patch({ entries: node.entries.map(entry => entry.id === id ? { ...entry, ...changes } : entry) })
  return <div className="rp-team-value-editor">
    {chooseType ? <Field label={t('stateForm.valueType')}><select value={node.type} onChange={event => onChange({ ...valueForm(emptyValue(event.target.value)), id: node.id })}>
      {VALUE_TYPES.map(type => <option key={type} value={type}>{t(`stateForm.types.${type}`)}</option>)}
    </select></Field> : null}
    {node.type === 'string' ? <Field label={t('stateForm.textValue')}><textarea rows={2} value={node.text} onChange={event => patch({ text: event.target.value })} /></Field>
      : node.type === 'number' ? <Field label={t('stateForm.numberValue')} error={valueError(node) ? t('stateForm.errors.number') : ''}>
        <input type="text" inputMode="decimal" value={node.text} onChange={event => patch({ text: event.target.value })} />
      </Field>
        : node.type === 'boolean' ? <Field label={t('stateForm.booleanValue')}><select value={String(node.checked)} onChange={event => patch({ checked: event.target.value === 'true' })}>
          <option value="false">{t('stateForm.no')}</option><option value="true">{t('stateForm.yes')}</option>
        </select></Field>
          : node.type === 'null' ? <p className="rp-team-note">{t('stateForm.nullValue')}</p> : <>
            {!node.entries.length ? <p className="rp-team-note">{t(node.type === 'object' ? 'stateForm.emptyObject' : 'stateForm.emptyList')}</p> : null}
            {node.type === 'object' && valueError(node) === 'duplicateField' ? <p className="rp-team-field-error" role="alert">{t('stateForm.errors.duplicateField')}</p> : null}
            {node.entries.map((entry, index) => <fieldset className="rp-team-value-entry" key={entry.id}>
              <legend>{t(node.type === 'object' ? 'stateForm.fieldNumber' : 'stateForm.itemNumber', { n: index + 1 })}</legend>
              <div className="rp-team-value-actions">
                {node.type === 'array' ? <>
                  <button type="button" className="rp-team-quiet" disabled={index === 0} aria-label={t('stateForm.moveUp', { n: index + 1 })} onClick={() => onChange(moveValueEntry(node, index, -1))}>↑</button>
                  <button type="button" className="rp-team-quiet" disabled={index === node.entries.length - 1} aria-label={t('stateForm.moveDown', { n: index + 1 })} onClick={() => onChange(moveValueEntry(node, index, 1))}>↓</button>
                </> : null}
                <button type="button" className="rp-team-quiet is-danger" aria-label={t('stateForm.removeValue', { n: index + 1 })} onClick={() => patch({ entries: node.entries.filter(item => item.id !== entry.id) })}>{t('remove')}</button>
              </div>
              {node.type === 'object' ? <Field label={t('stateForm.fieldName')}><input value={entry.name} onChange={event => changeEntry(entry.id, { name: event.target.value })} /></Field> : null}
              <StateValueEditor node={entry.node} chooseType onChange={child => changeEntry(entry.id, { node: child })} />
            </fieldset>)}
            <button type="button" className="rp-team-quiet is-bordered" onClick={() => onChange(addValueEntry(node, t('stateForm.newField')))}>{t(node.type === 'object' ? 'stateForm.addField' : 'stateForm.addItem')}</button>
          </>}
  </div>
}
