import { React } from './react.js'
import { t } from './i18n.js'
import { Field, More } from './fields.jsx'
import { ValueSchemaEditor } from './value-schema-editor.jsx'
import { PathPicker } from './path-picker.jsx'

export function HandoffEditor({ member, config, edit, conversationId, setInvalid }) {
  const handoffs = member.communication.handoffs || []
  const change = next => edit({ communication: { ...member.communication, handoffs: next } })
  const update = (id, patch) => change(handoffs.map(item => item.id === id ? { ...item, ...patch } : item))
  const fields = schema => {
    const result = [{ path: '/summary', label: t('author.summary') }, { path: '/data', label: t('author.payload') }]
    const walk = (item, path) => { for (const [name, child] of Object.entries(item?.properties || {})) { const next = `${path}/${name.replace(/~/g, '~0').replace(/\//g, '~1')}`; result.push({ path: next, label: next }); walk(child, next) } }
    walk(schema, ''); return result
  }
  return <section className="rp-team-block">
    <div className="rp-team-state-section-head"><h3>{t('author.handoffs')}</h3><button type="button" className="rp-team-quiet is-bordered" disabled={!config.agents.length} onClick={() => change([...handoffs, {
      id: `handoff-${crypto.randomUUID()}`, to: config.agents.find(agent => agent.id !== member.id)?.id || member.id, mode: 'notify', timeoutMs: 300000, onFailure: 'return_error'
    }])}>{t('author.addHandoff')}</button></div>
    <p className="rp-team-note">{t('author.handoffHelp')}</p>
    {handoffs.map((item, index) => <details className="rp-team-author-card" key={item.id} open>
      <summary>{t('author.handoffNumber', { n: index + 1 })} · {config.agents.find(agent => agent.id === item.to)?.name || item.to}</summary>
      <div className="rp-team-author-card-body">
        <Field label={t('author.handoffTarget')}><select value={item.to} onChange={event => update(item.id, { to: event.target.value })}>{config.agents.map(agent => <option key={agent.id} value={agent.id}>{agent.name}</option>)}</select></Field>
        <Field label={t('author.continueMode')}><select value={item.mode} onChange={event => update(item.id, { mode: event.target.value })}>{['notify', 'await', 'resume'].map(mode => <option key={mode} value={mode}>{t(`author.mode.${mode}`)}</option>)}</select></Field>
        <p className="rp-team-note">{t(`author.modeHint.${item.mode}`)}</p>
        {item.mode !== 'notify' ? <Field label={t('author.waitSeconds')}><input type="number" min="1" value={(item.timeoutMs || 300000) / 1000} onChange={event => update(item.id, { timeoutMs: Number(event.target.value) * 1000 })} /></Field> : null}
        <Field label={t('author.handoffFailure')}><select value={item.onFailure || 'return_error'} onChange={event => update(item.id, { onFailure: event.target.value })}><option value="return_error">{t('author.returnError')}</option><option value="stop">{t('author.stopRun')}</option></select></Field>
        {(item.mode === 'notify' ? ['request'] : ['request', 'response']).map(direction => <More key={direction} summary={t(`author.${direction}Rules`)}>
          <ValueSchemaEditor value={item[`${direction}Schema`] || { type: 'any' }} bufferKey={`${conversationId}/${member.id}/${item.id}/${direction}`} onChange={schema => update(item.id, { [`${direction}Schema`]: schema })}
            onInvalid={(key, invalid) => setInvalid?.(`handoff-${item.id}-${key}`, invalid)} />
          <PathPicker fields={fields(item[`${direction}Schema`])} label={t('author.deliverFields')} value={item[`${direction}Selectors`]} onChange={selectors => update(item.id, { [`${direction}Selectors`]: selectors })} />
        </More>)}
        <button type="button" className="rp-team-link is-danger" onClick={() => change(handoffs.filter(other => other.id !== item.id))}>{t('author.removeHandoff')}</button>
      </div>
    </details>)}
  </section>
}
