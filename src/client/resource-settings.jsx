import { React } from './react.js'
import { t } from './i18n.js'
import { Field } from './fields.jsx'
import { drafts } from './client-state.js'
import { editConfig } from './draft-state.js'
import { stateChoices, stateKey } from './author-model.js'

export const TURN_BUDGET = { maxRequests: 32, maxReportedTokens: 64000, maxElapsedMs: 180000 }
export const TASK_BUDGET = { maxRequests: 64, maxReportedTokens: 128000, maxElapsedMs: 600000 }
export function BudgetFields({ value = {}, onChange, defaults, title }) {
  const set = (key, text) => {
    const next = { ...value }
    if (text === '') delete next[key]
    else next[key] = Number(text) * (key === 'maxElapsedMs' ? 1000 : 1)
    onChange(next)
  }
  return <fieldset className="rp-team-group"><legend>{title || t('budget.title')}</legend><p className="rp-team-note">{t('budget.help')}</p>
    <div className="rp-team-grid">{['maxRequests', 'maxReportedTokens', 'maxElapsedMs'].map(key => <Field key={key} label={t(`budget.${key}`)} hint={defaults ? t('defaultValue', { n: defaults[key] / (key === 'maxElapsedMs' ? 1000 : 1) }) : t('budget.disabled')}>
      <input type="number" min="1" step="1" value={value[key] === undefined ? '' : value[key] / (key === 'maxElapsedMs' ? 1000 : 1)} onChange={event => set(key, event.target.value)} />
    </Field>)}</div>
  </fieldset>
}

export function MemoryDefinitions({ conversationId, editor }) {
  const collections = editor.draft.memory?.collections || []
  const states = stateChoices(editor.draft.state.definitions).filter(row => row.type === 'array')
  const set = list => drafts.update(conversationId, state => editConfig(state, { ...state.draft, memory: { collections: list } }))
  const edit = (id, changes) => set(collections.map(row => row.id === id ? { ...row, ...changes } : row))
  return <section className="rp-team-block"><h3>{t('memory.definitions')}</h3><p className="rp-team-note">{t('memory.defineHelp')}</p>
    {collections.map(collection => <details className="rp-team-author-card" key={collection.id}><summary>{collection.name} <small>{collection.namespace} · {collection.path}</small></summary><div className="rp-team-author-card-body">
      <Field label={t('name')} hint={t('stableIdHint', { id: collection.id })}><input value={collection.name} onChange={event => edit(collection.id, { name: event.target.value })} /></Field>
      <Field label={t('description')}><textarea rows={2} value={collection.description || ''} onChange={event => edit(collection.id, { description: event.target.value })} /></Field>
      <Field label={t('memory.location')}><select value={stateKey(collection)} onChange={event => { const row = states.find(row => stateKey(row) === event.target.value); if (row) edit(collection.id, { namespace: row.namespace, path: row.path }) }}>
        {!states.some(row => stateKey(row) === stateKey(collection)) ? <option value={stateKey(collection)}>{collection.namespace} · {collection.path}</option> : null}
        {states.map(row => <option key={stateKey(row)} value={stateKey(row)}>{row.label}</option>)}
      </select></Field>
      <button type="button" className="rp-team-quiet is-danger" onClick={() => set(collections.filter(row => row.id !== collection.id))}>{t('remove')}</button>
    </div></details>)}
    <button type="button" className="rp-team-quiet is-bordered" disabled={!states.length} onClick={() => set([...collections, { id: `memory-${crypto.randomUUID()}`, name: t('memory.new'), namespace: states[0].namespace, path: states[0].path }])}>{t('memory.addCollection')}</button>
    {!states.length ? <p className="rp-team-note">{t('memory.needArray')}</p> : null}
  </section>
}
