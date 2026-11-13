import { React } from './react.js'
import { t } from './i18n.js'
import { drafts } from './client-state.js'
import { editConfig, editParameterValue } from './draft-state.js'
import { Field, More, Check } from './fields.jsx'
import { TypedField } from './typed-field.jsx'
import { ValueSchemaEditor } from './value-schema-editor.jsx'
import { ValueView } from './author-pages.jsx'
import { parameterInsertText, resolveAuthorParameters } from '../shared/author-parameters.mjs'
import { stateChoices, stateKey } from './author-model.js'

const TYPES = ['text', 'number', 'boolean', 'choice', 'agent', 'model', 'state']
const TEXT_TYPES = ['text', 'number', 'choice', 'boolean']
const insertsText = parameter => (parameter.bindings || []).some(binding => binding.mode === 'text')

/** Parameters in declaration order, gathered under their group in order of first appearance; ungrouped ones first. */
export function groupParameters(parameters) {
  const groups = new Map([['', []]])
  for (const parameter of parameters) {
    const group = typeof parameter.group === 'string' ? parameter.group.trim() : ''
    if (!groups.has(group)) groups.set(group, [])
    groups.get(group).push(parameter)
  }
  return [...groups].filter(([, items]) => items.length).map(([group, items]) => ({ group, items }))
}

/** A choice or switch bound into a prompt shows what its current setting inserts, like a preset entry's content. */
function InsertedText({ parameter, value }) {
  if (!insertsText(parameter) || !['choice', 'boolean'].includes(parameter.type)) return null
  let text
  try { text = parameterInsertText(parameter, value) } catch { return null }
  return <More summary={t('params.inserts')}><p className="rp-team-note rp-team-pre">{text || t('params.insertsEmpty')}</p></More>
}

/** Choosing "insert into prompt" gives every option and switch state a text slot, so the binding validates at once. */
function withInsertionTexts(parameter, bindings) {
  const change = { bindings }
  if (!bindings.some(binding => binding.mode === 'text')) return change
  if (parameter.type === 'choice') change.options = (parameter.options || []).map(option => option.text === undefined ? { ...option, text: '' } : option)
  if (parameter.type === 'boolean' && parameter.textOn === undefined && parameter.textOff === undefined) change.textOn = ''
  return change
}
const initial = type => ({ text: '', number: 0, boolean: false, choice: '', agent: '', model: 'inherit', state: { namespace: 'shared', path: '' } })[type]
const agentFields = ['/systemPrompt', '/description', '/presetId', '/modelRef', '/parameters/temperature', '/parameters/topP', '/parameters/maxTokens', '/parameters/reasoningEffort', '/triggers', '/context', '/communication', '/statePermissions', '/execution', '/outputAuthority']
const teamFields = ['/name', '/metadata/description', '/execution/concurrency', '/execution/maxActivations', '/execution/maxPerAgent', '/execution/maxDepth', '/execution/budget/maxRequests', '/execution/budget/maxReportedTokens', '/execution/budget/maxElapsedMs', '/output/agentId']

export function ParameterValue({ parameter, value, config, options, onChange, bufferKey, onInvalid, ...controlProps }) {
  const type = parameter.type
  if (type === 'boolean') return <Check label={parameter.name} checked={Boolean(value)} onChange={onChange} />
  if (type === 'text') return <textarea {...controlProps} rows={2} value={value ?? ''} onChange={event => onChange(event.target.value)} />
  if (type === 'number') return <TypedField value={value ?? 0} chooseType={false} bufferKey={bufferKey} onChange={onChange} onInvalid={onInvalid} />
  if (type === 'agent' || type === 'choice' || type === 'state') {
    const items = type === 'agent' ? config.agents.map(agent => ({ label: agent.name, value: agent.id }))
      : type === 'state' ? stateChoices(config.state.definitions).map(row => ({ label: row.label, value: { namespace: row.namespace, path: row.path } })) : parameter.options || []
    const key = item => type === 'state' ? stateKey(item || {}) : JSON.stringify(item)
    const selected = key(value), missing = value !== undefined && !items.some(item => key(item.value) === selected)
    return <select {...controlProps} value={selected ?? ''} onChange={event => { const chosen = items.find(item => key(item.value) === event.target.value); if (chosen) onChange(chosen.value) }}>
      <option value="">{t('choose')}</option>{missing ? <option value={selected}>{t('originalReference', { id: typeof value === 'string' ? value : JSON.stringify(value) })}</option> : null}
      {items.map((item, index) => <option key={index} value={key(item.value)}>{item.label}</option>)}
    </select>
  }
  const route = value && value !== 'inherit' ? value : null
  const models = (options?.providers || []).flatMap(provider => provider.models.map(model => ({ label: `${provider.name} · ${model.name}`, value: { provider: provider.id, model: model.id } })))
  const selected = JSON.stringify(route || 'inherit')
  return <select {...controlProps} value={selected} onChange={event => onChange(JSON.parse(event.target.value))}>
    <option value={JSON.stringify('inherit')}>{t('inheritChatModel')}</option>
    {route && !models.some(item => JSON.stringify(item.value) === selected) ? <option value={selected}>{t('originalReference', { id: `${route.provider}/${route.model}` })}</option> : null}
    {models.map(item => <option key={JSON.stringify(item.value)} value={JSON.stringify(item.value)}>{item.label}</option>)}
  </select>
}

export function ParametersEditor({ conversationId, editor, options }) {
  const config = editor.draft, parameters = config.authorParameters || []
  const update = change => drafts.update(conversationId, change)
  const set = list => update(state => editConfig(state, { ...state.draft, authorParameters: list }))
  const edit = (id, change) => set(parameters.map(item => item.id === id ? { ...item, ...change } : item))
  const invalid = (key, value) => update(state => ({ ...state, invalid: { ...state.invalid, [`$team:${key}`]: value } }))
  const invalidSchema = (key, value) => update(state => ({ ...state,
    invalid: { ...Object.fromEntries(Object.entries(state.invalid).filter(([existing]) => value || !existing.startsWith(`$team:${key}`))), [`$team:${key}`]: value }
  }))
  let resolved, error = ''
  try { resolved = resolveAuthorParameters(config, editor.parameterValues) } catch (cause) { error = cause.message }
  return <section className="rp-team-block">
    <h3>{t('params.title')}</h3><p className="rp-team-note">{t('params.help')}</p>
    {groupParameters(parameters).map(({ group, items }) => {
      const rows = items.map(parameter => {
        const overridden = Object.hasOwn(editor.parameterValues || {}, parameter.id)
        const value = overridden ? editor.parameterValues[parameter.id] : parameter.default
        return <div key={parameter.id}><Field label={parameter.name} hint={parameter.description}>
          <ParameterValue parameter={parameter} value={value}
            config={config} options={options} bufferKey={`${conversationId}/parameter/${parameter.id}`} onInvalid={value => invalid(`param-${parameter.id}`, value)} onChange={value => update(state => editParameterValue(state, parameter.id, value))} />
        </Field><InsertedText parameter={parameter} value={value} />{overridden ? <button type="button" className="rp-team-link" onClick={() => update(state => editParameterValue(state, parameter.id, undefined))}>{t('params.useDefault')}</button> : null}</div>
      })
      return group ? <fieldset className="rp-team-group rp-team-param-group" key={`group:${group}`}><legend>{group}</legend>{rows}</fieldset> : <React.Fragment key="ungrouped">{rows}</React.Fragment>
    })}
    {!parameters.length ? <p className="rp-team-note">{t('params.empty')}</p> : null}
    {error ? <p className="rp-team-callout is-error">{error}</p> : resolved?.changes.length ? <More summary={t('params.changes')}><ValueView value={resolved.changes} /></More> : null}
    <More summary={t('params.author')}>
      <p className="rp-team-note">{t('params.authorHelp')}</p>
      {parameters.map(parameter => <details className="rp-team-author-card" key={parameter.id}>
        <summary>{parameter.group ? `${parameter.group} · ` : ''}{parameter.name} <small>{t(`params.types.${parameter.type}`)}</small></summary><div className="rp-team-author-card-body">
          <Field label={t('name')} hint={t('stableIdHint', { id: parameter.id })}><input value={parameter.name} onChange={event => edit(parameter.id, { name: event.target.value })} /></Field>
          <Field label={t('params.group')} hint={t('params.groupHint')}><input value={parameter.group || ''} onChange={event => edit(parameter.id, { group: event.target.value.trim() ? event.target.value : undefined })} /></Field>
          <Field label={t('description')}><textarea rows={2} value={parameter.description || ''} onChange={event => edit(parameter.id, { description: event.target.value })} /></Field>
          <Field label={t('params.type')}><select value={parameter.type} onChange={event => edit(parameter.id, { type: event.target.value, default: initial(event.target.value), options: event.target.value === 'choice' ? [] : undefined, textOn: undefined, textOff: undefined, valueSchema: undefined,
            bindings: TEXT_TYPES.includes(event.target.value) ? parameter.bindings : (parameter.bindings || []).filter(binding => binding.mode !== 'text') })}>{TYPES.map(type => <option key={type} value={type}>{t(`params.types.${type}`)}</option>)}</select></Field>
          {parameter.type === 'choice' ? <ChoiceOptions parameter={parameter} onChange={options => edit(parameter.id, { options })} bufferKey={`${conversationId}/param-options/${parameter.id}`} onInvalid={value => invalid(`param-options-${parameter.id}`, value)} /> : null}
          {parameter.type === 'boolean' ? <>
            <Field label={t('params.textOn')} hint={t('params.switchTextHint')}><textarea rows={2} value={parameter.textOn ?? ''} onChange={event => edit(parameter.id, { textOn: event.target.value })} /></Field>
            <Field label={t('params.textOff')} hint={t('params.switchTextHint')}><textarea rows={2} value={parameter.textOff ?? ''} onChange={event => edit(parameter.id, { textOff: event.target.value })} /></Field>
          </> : null}
          <Field label={t('params.default')}><ParameterValue parameter={parameter} value={parameter.default} config={config} options={options}
            bufferKey={`${conversationId}/param-default/${parameter.id}`} onInvalid={value => invalid(`param-default-${parameter.id}`, value)} onChange={value => edit(parameter.id, { default: value })} /></Field>
          <BindingEditor parameter={parameter} config={config} onChange={bindings => edit(parameter.id, withInsertionTexts(parameter, bindings))} />
          <More summary={t('params.constraints')}><ValueSchemaEditor value={parameter.valueSchema} bufferKey={`${conversationId}/param-schema/${parameter.id}`} onInvalid={invalidSchema} onChange={valueSchema => edit(parameter.id, { valueSchema })} /></More>
          <button type="button" className="rp-team-quiet is-danger" onClick={() => { set(parameters.filter(item => item.id !== parameter.id)); update(state => { const next = editParameterValue(state, parameter.id, undefined); return { ...next, invalid: Object.fromEntries(Object.entries(next.invalid).filter(([key]) => !key.endsWith(`-${parameter.id}`) && !key.startsWith(`$team:${conversationId}/param-schema/${parameter.id}/`))) } }) }}>{t('remove')}</button>
        </div>
      </details>)}
      <button type="button" className="rp-team-quiet is-bordered" onClick={() => set([...parameters, { id: `param-${crypto.randomUUID()}`, name: t('params.new'), type: 'text', default: '', bindings: [] }])}>{t('params.add')}</button>
    </More>
  </section>
}

function ChoiceOptions({ parameter, onChange, bufferKey, onInvalid }) {
  const options = parameter.options || []
  return <div>{options.map((item, index) => <div className="rp-team-author-card-body" key={index}>
    <Field label={t('params.optionName')}><input value={item.label} onChange={event => onChange(options.map((row, i) => i === index ? { ...row, label: event.target.value } : row))} /></Field>
    <TypedField value={item.value} bufferKey={`${bufferKey}/${index}`} onChange={value => onChange(options.map((row, i) => i === index ? { ...row, value } : row))} onInvalid={onInvalid} />
    <Field label={t('params.optionText')} hint={t('params.optionTextHint')}><textarea rows={2} value={item.text ?? ''} onChange={event => onChange(options.map((row, i) => i === index ? { ...row, text: event.target.value } : row))} /></Field>
    <button type="button" className="rp-team-quiet" onClick={() => onChange(options.filter((_, i) => i !== index))}>{t('remove')}</button>
  </div>)}<button type="button" className="rp-team-quiet" onClick={() => onChange([...options, { label: t('params.optionName'), value: '', ...(insertsText(parameter) ? { text: '' } : {}) }])}>{t('params.addOption')}</button></div>
}

function BindingEditor({ parameter, config, onChange }) {
  const bindings = parameter.bindings || [], states = stateChoices(config.state.definitions)
  const edit = (index, patch) => onChange(bindings.map((binding, i) => i === index ? { ...binding, ...patch } : binding))
  return <fieldset className="rp-team-group"><legend>{t('params.bindings')}</legend>
    {bindings.map((binding, index) => <div className="rp-team-author-card-body" key={index}>
      <Field label={t('params.target')}><select value={binding.target.kind} onChange={event => edit(index, { target: event.target.value === 'agent' ? { kind: 'agent', agentId: config.agents[0].id, path: '/systemPrompt' } : event.target.value === 'team' ? { kind: 'team', path: '/execution/concurrency' } : { kind: 'state_default', namespace: states[0]?.namespace || 'shared', path: states[0]?.path || '' } })}><option value="agent">{t('member')}</option><option value="team">{t('pages.team')}</option><option value="state_default">{t('params.stateInitial')}</option></select></Field>
      {binding.target.kind === 'agent' ? <Field label={t('member')}><select value={binding.target.agentId} onChange={event => edit(index, { target: { ...binding.target, agentId: event.target.value } })}>{!config.agents.some(agent => agent.id === binding.target.agentId) ? <option value={binding.target.agentId}>{binding.target.agentId}</option> : null}{config.agents.map(agent => <option key={agent.id} value={agent.id}>{agent.name}</option>)}</select></Field> : null}
      {binding.target.kind === 'state_default' ? <Field label={t('params.stateInitial')}><select value={stateKey(binding.target)} onChange={event => { const row = states.find(row => stateKey(row) === event.target.value); if (row) edit(index, { target: { kind: 'state_default', namespace: row.namespace, path: row.path } }) }}>{!states.some(row => stateKey(row) === stateKey(binding.target)) ? <option value={stateKey(binding.target)}>{binding.target.namespace} · {binding.target.path}</option> : null}{states.map(row => <option key={stateKey(row)} value={stateKey(row)}>{row.label}</option>)}</select></Field>
        : <Field label={t('params.field')} hint={t('params.fieldHelp')}><input list={`binding-${parameter.id}-${index}`} value={binding.target.path} onChange={event => edit(index, { target: { ...binding.target, path: event.target.value } })} /><datalist id={`binding-${parameter.id}-${index}`}>{(binding.target.kind === 'agent' ? agentFields : teamFields).map(path => <option key={path} value={path} />)}</datalist></Field>}
      <Field label={t('params.mode')} hint={binding.mode === 'text' ? `{{param:${parameter.id}}}` : t('params.permissionHelp')}><select value={binding.mode} onChange={event => edit(index, { mode: event.target.value })}><option value="set">{t('params.set')}</option>{TEXT_TYPES.includes(parameter.type) ? <option value="text">{t('params.text')}</option> : null}</select></Field>
      <More summary={t('params.valuePart')}><Field label={t('params.valuePath')}><input value={binding.valuePath || ''} onChange={event => edit(index, { valuePath: event.target.value || undefined })} /></Field></More>
      <button type="button" className="rp-team-quiet" onClick={() => onChange(bindings.filter((_, i) => i !== index))}>{t('remove')}</button>
    </div>)}
    <button type="button" className="rp-team-quiet is-bordered" onClick={() => onChange([...bindings, { target: { kind: 'agent', agentId: config.agents[0].id, path: '/systemPrompt' }, mode: 'set' }])}>{t('params.addBinding')}</button>
  </fieldset>
}

