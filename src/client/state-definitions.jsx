import { React } from './react.js'
import { t } from './i18n.js'
import { drafts } from './client-state.js'
import { Field, Check, More, ConfirmButton } from './fields.jsx'
import { STATE_ACCESS, effectiveStateAccess, effectiveStateRule } from './editor-model.js'
import { VALUE_TYPES, applyDefinitionForms, changeDefinitionAccess, changeDefinitionType, definitionError, definitionForms, newDefinition, statePath } from './state-editor-model.js'
import { StateValueEditor } from './state-value-editor.jsx'
import { ValueSchemaEditor } from './value-schema-editor.jsx'
import { typedBuffers } from './typed-field.jsx'

export function StateDefinitions({ conversationId, editor }) {
  const config = editor.draft
  const forms = React.useMemo(() => editor.stateForms ?? definitionForms(config.state.definitions), [editor.stateForms, config.state.definitions])
  const update = change => drafts.update(conversationId, change)
  const setForms = next => update(state => applyDefinitionForms(state, next))
  const changeForm = (id, changes) => setForms(forms.map(form => form.id === id ? { ...form, ...changes } : form))
  const clearSchema = id => {
    const prefix = `${conversationId}/definition-${id}`
    typedBuffers.removeWhere(key => key.startsWith(prefix))
    update(state => ({ ...state, invalid: Object.fromEntries(Object.entries(state.invalid).filter(([key]) => !key.startsWith(`$team:definitions-${prefix}`))) }))
  }
  const ownerName = namespace => namespace === 'shared' ? t('stateForm.shared') : namespace === 'world' ? t('stateForm.world')
    : t('stateForm.privateFor', { name: config.agents.find(agent => namespace === `private:${agent.id}`)?.name || namespace.slice(8) })
  return <section className="rp-team-block rp-team-state-definitions" aria-label={t('stateDefinitions')}>
    <div className="rp-team-state-section-head"><h3>{t('stateDefinitions')}</h3><button type="button" className="rp-team-quiet is-bordered" onClick={() => setForms([...forms, newDefinition(forms, t('stateForm.newState'))])}>{t('stateForm.add')}</button></div>
    <p className="rp-team-note">{t('stateDefinitionHelp')}</p>
    {!forms.length ? <div className="rp-team-state-empty"><p>{t('stateForm.empty')}</p><small>{t('stateForm.emptyHint')}</small></div> : null}
    {forms.map(form => {
      const path = statePath(form.parts)
      const title = form.parts.length ? form.parts.at(-1) || t('stateForm.unnamed') : t('stateForm.root')
      const error = definitionError(form, forms)
      const scope = form.namespace.startsWith('private:') ? 'private' : form.namespace
      return <details key={form.id} className="rp-team-state-definition" open={form.open}
        onToggle={event => { if (event.target !== event.currentTarget) return; const open = event.currentTarget.open; if (open !== form.open) update(state => ({ ...state, stateForms: forms.map(item => item.id === form.id ? { ...item, open } : item) })) }}>
        <summary><span className="rp-team-state-summary"><strong>{title}</strong><small>{ownerName(form.namespace)} · {t(`stateForm.types.${form.type}`)}</small></span>{error ? <span className="rp-team-state-error-mark">{t('stateForm.needsAttention')}</span> : null}</summary>
        <div className="rp-team-state-definition-body">
          <Field label={t('stateForm.scope')}><select value={scope} onChange={event => changeForm(form.id, { namespace: event.target.value === 'private' ? `private:${config.agents[0].id}` : event.target.value })}>
            <option value="shared">{t('stateForm.shared')}</option><option value="world">{t('stateForm.world')}</option><option value="private">{t('stateForm.private')}</option>
          </select></Field>
          {scope === 'private' ? <Field label={t('stateForm.owner')}><select value={form.namespace.slice(8)} onChange={event => changeForm(form.id, { namespace: `private:${event.target.value}` })}>
            {config.agents.map(agent => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
          </select></Field> : null}
          {form.parts.length ? <>
            <Field label={t('stateForm.name')} hint={t('stateForm.nameHint')}><input value={form.parts.at(-1)} onChange={event => changeForm(form.id, { parts: [...form.parts.slice(0, -1), event.target.value] })} /></Field>
            <More summary={form.parts.length > 1 ? t('stateForm.groupedIn', { name: form.parts.slice(0, -1).join(' / ') }) : t('stateForm.grouping')} startOpen={form.parts.length > 1}>
              {form.parts.slice(0, -1).map((part, index) => <div className="rp-team-state-path-part" key={index}>
                <Field label={t('stateForm.groupNumber', { n: index + 1 })}><input value={part} onChange={event => changeForm(form.id, { parts: form.parts.map((value, i) => i === index ? event.target.value : value) })} /></Field>
                <button type="button" className="rp-team-quiet" aria-label={t('stateForm.removeGroup', { n: index + 1 })} onClick={() => changeForm(form.id, { parts: form.parts.filter((_part, i) => i !== index) })}>{t('remove')}</button>
              </div>)}
              <button type="button" className="rp-team-quiet is-bordered" onClick={() => changeForm(form.id, { parts: [...form.parts.slice(0, -1), t('stateForm.newGroup'), form.parts.at(-1)] })}>{t('stateForm.addGroup')}</button>
            </More>
          </> : null}
          <Field label={t('stateForm.description')}><input value={form.description} placeholder={t('stateForm.descriptionPlaceholder')} onChange={event => changeForm(form.id, { description: event.target.value })} /></Field>
          <Field label={t('stateForm.type')} hint={t('stateForm.typeHint')}><select value={form.type} onChange={event => setForms(forms.map(item => item.id === form.id ? changeDefinitionType(item, event.target.value) : item))}>
            {[...VALUE_TYPES, 'any'].map(type => <option key={type} value={type}>{t(`stateForm.types.${type}`)}</option>)}
          </select></Field>
          <div className="rp-team-state-default">
            <Check label={t('stateForm.useDefault')} hint={t('stateForm.defaultHint')} checked={form.hasDefault} onChange={hasDefault => changeForm(form.id, { hasDefault })} />
            {form.hasDefault ? <StateValueEditor node={form.value} chooseType={form.type === 'any'} onChange={value => changeForm(form.id, { value })} /> : null}
          </div>
          {error === 'duplicateState' ? <p className="rp-team-field-error" role="alert">{t('stateForm.errors.duplicateState')}</p> : null}
          <More summary={t('author.valueRules')}>
            <Check label={t('author.enableValueRules')} checked={Boolean(form.valueSchema)} onChange={enabled => { clearSchema(form.id); changeForm(form.id, { valueSchema: enabled ? { type: form.type } : undefined }) }} />
            {form.valueSchema ? <ValueSchemaEditor value={form.valueSchema} bufferKey={`${conversationId}/definition-${form.id}`} onChange={valueSchema => changeForm(form.id, { valueSchema })}
              onInvalid={(key, invalid) => update(state => { const next = { ...state.invalid }; if (invalid) next[`$team:definitions-${key}`] = true; else for (const field of Object.keys(next)) if (field.startsWith(`$team:definitions-${key}`)) delete next[field]; return { ...state, invalid: next } })} /> : null}
          </More>
          <More summary={t('stateForm.permissions')}>
            <p className="rp-team-note">{t('stateForm.permissionsHint')}</p>
            {config.agents.map(agent => {
              const rule = effectiveStateRule(agent, form.namespace, path)
              return <Field key={agent.id} label={agent.name} hint={rule && rule.path !== path ? t('stateForm.inherited') : ''}>
                <select value={effectiveStateAccess(agent, form.namespace, path)} onChange={event => update(state => changeDefinitionAccess(state, form, agent.id, event.target.value))}>
                  {STATE_ACCESS.map(access => <option key={access} value={access}>{t(`access.${access}`)}</option>)}
                </select>
              </Field>
            })}
          </More>
          <More summary={t('stateForm.address')}>
            <p className="rp-team-note">{t('stateForm.addressHint')}</p><code>{form.namespace}{path || '/'}</code>
            <Check label={t('stateForm.wholeStore')} hint={t('stateForm.wholeStoreHint')} checked={!form.parts.length} onChange={whole => changeForm(form.id, { parts: whole ? [] : [t('stateForm.newState')] })} />
          </More>
          <ConfirmButton label={t('stateForm.delete')} confirmLabel={t('stateForm.confirmDelete')} className="is-danger" onConfirm={() => { clearSchema(form.id); setForms(forms.filter(item => item.id !== form.id)) }} />
        </div>
      </details>
    })}
  </section>
}
