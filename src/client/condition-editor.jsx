import { React } from './react.js'
import { t } from './i18n.js'
import { Field } from './fields.jsx'
import { TypedField, typedBuffers } from './typed-field.jsx'
import { conditionNode, conditionBufferKey, stateChoices, stateKey, removedChildKey } from './author-model.js'

export function ConditionTree({ value, onChange, config, bufferKey, onInvalid }) {
  const group = value.op === 'all' || value.op === 'any'
  const choices = stateChoices(config.state.definitions)
  const seed = choices[0] || { namespace: 'shared', path: '/flag' }
  const leaf = () => ({ op: 'exists', namespace: seed.namespace, path: seed.path })
  return <fieldset className="rp-team-rule-node">
    <Field label={t('author.ruleKind')}><select value={group || value.op === 'not' ? value.op : 'leaf'} onChange={event => {
      const kind = event.target.value
      typedBuffers.remapKeys(key => conditionBufferKey(key, bufferKey, value, kind))
      onChange(conditionNode(kind, value))
    }}>
      {['leaf', 'all', 'any', 'not'].map(kind => <option key={kind} value={kind}>{t(`author.rule.${kind}`)}</option>)}
    </select></Field>
    {group ? <>
      {value.conditions.map((child, index) => <div className="rp-team-rule-child" key={index}>
        <ConditionTree value={child} config={config} bufferKey={`${bufferKey}/${index}`} onInvalid={onInvalid}
          onChange={next => onChange({ ...value, conditions: value.conditions.map((item, row) => row === index ? next : item) })} />
        <button type="button" className="rp-team-link is-danger" disabled={value.conditions.length === 1} onClick={() => { typedBuffers.remapKeys(key => removedChildKey(key, bufferKey, index)); onChange({ ...value, conditions: value.conditions.filter((_item, row) => row !== index) }) }}>{t('author.removeRule')}</button>
      </div>)}
      <button type="button" className="rp-team-quiet is-bordered" onClick={() => onChange({ ...value, conditions: [...value.conditions, leaf()] })}>{t('author.addRule')}</button>
    </> : value.op === 'not' ? <ConditionTree value={value.condition} config={config} bufferKey={`${bufferKey}/not`} onInvalid={onInvalid} onChange={condition => onChange({ ...value, condition })} /> : <>
      <Field label={t('author.whichState')}><select value={choices.some(choice => stateKey(choice) === stateKey(value)) ? stateKey(value) : ''} onChange={event => {
        const selected = choices.find(choice => stateKey(choice) === event.target.value)
        if (selected) onChange({ ...value, namespace: selected.namespace, path: selected.path })
      }}><option value="">{value.namespace} · {value.path}</option>{choices.map(choice => <option key={stateKey(choice)} value={stateKey(choice)}>{choice.label}</option>)}</select></Field>
      <Field label={t('conditionOperator')}><select value={value.op === 'exists' ? 'exists' : value.operator} onChange={event => onChange(event.target.value === 'exists'
        ? { op: 'exists', namespace: value.namespace, path: value.path }
        : { op: 'compare', namespace: value.namespace, path: value.path, operator: event.target.value, value: Object.hasOwn(value, 'value') ? value.value : '' })}>
        {['exists', 'eq', 'ne', 'gt', 'gte', 'lt', 'lte'].map(operator => <option key={operator} value={operator}>{t(`operators.${operator}`)}</option>)}
      </select></Field>
      {value.op === 'compare' ? <TypedField bufferKey={bufferKey} value={value.value} onInvalid={onInvalid} onChange={next => onChange({ ...value, value: next })} /> : null}
    </>}
  </fieldset>
}
