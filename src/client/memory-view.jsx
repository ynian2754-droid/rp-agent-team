import { React } from './react.js'
import { t } from './i18n.js'
import { Field, Check, More } from './fields.jsx'
import { TypedField } from './typed-field.jsx'
import { ValueView } from './author-pages.jsx'
import { stateKey } from './author-model.js'

const lines = text => text.split('\n').map(item => item.trim()).filter(Boolean)
export function MemoryView({ config, data, blocked, onSave, conversationId }) {
  const [filters, setFilters] = React.useState({ query: '', people: '', tags: '', source: '', since: '', until: '', archived: false, sort: 'newest', limit: 20 })
  const [edit, setEdit] = React.useState(null)
  const [invalid, setInvalid] = React.useState(false)
  const collections = config.memory?.collections || []
  const set = (key, value) => setFilters(current => ({ ...current, [key]: value }))
  return collections.length ? <section className="rp-team-block">
    <h3>{t('memory.title')}</h3><p className="rp-team-note">{t('memory.searchHelp')}</p>
    <Field label={t('memory.search')}><input type="search" value={filters.query} onChange={event => set('query', event.target.value)} /></Field>
    <More summary={t('memory.filters')}><div className="rp-team-grid">{['people', 'tags', 'source'].map(key => <Field key={key} label={t(`memory.${key}`)}><input value={filters[key]} onChange={event => set(key, event.target.value)} /></Field>)}{['since', 'until'].map(key => <Field key={key} label={t(`memory.${key}`)}><input type="datetime-local" value={filters[key]} onChange={event => set(key, event.target.value)} /></Field>)}<Field label={t('memory.sort')}><select value={filters.sort} onChange={event => set('sort', event.target.value)}><option value="newest">{t('memory.newest')}</option><option value="oldest">{t('memory.oldest')}</option></select></Field><Field label={t('memory.limit')}><input type="number" min="1" value={filters.limit} onChange={event => set('limit', Number(event.target.value))} /></Field></div></More>
    <Check label={t('memory.archived')} checked={filters.archived} onChange={value => set('archived', value)} />
    {collections.map(collection => {
      const row = data.values.find(value => stateKey(value) === stateKey(collection))
      const records = Array.isArray(row?.value) ? row.value : []
      const visible = records.filter(record => record && typeof record === 'object' && (filters.archived || record.active !== false)
        && (!filters.query || Object.values(record).some(value => JSON.stringify(value)?.toLowerCase().includes(filters.query.toLowerCase())))
        && (!filters.people || record.people?.some(value => value.includes(filters.people)))
        && (!filters.tags || record.tags?.some(value => value.includes(filters.tags)))
        && (!filters.source || record.source?.includes(filters.source))
        && (!filters.since || record.createdAt >= new Date(filters.since).toISOString())
        && (!filters.until || record.createdAt <= new Date(filters.until).toISOString()))
        .sort((left, right) => (filters.sort === 'newest' ? -1 : 1) * String(left.createdAt || '').localeCompare(String(right.createdAt || ''))).slice(0, Math.max(1, filters.limit))
      const begin = record => { setInvalid(false); setEdit({ collectionId: collection.id, record: structuredClone(record || { id: `memory-${crypto.randomUUID()}`, content: '', createdAt: new Date().toISOString(), active: true }), base: data, records: structuredClone(records), row: collection, isNew: !record }) }
      const saveRecord = record => onSave(data, collection, records.map(item => item.id === record.id ? record : item))
      return <details className="rp-team-author-card" key={collection.id} open><summary>{collection.name} <small>{collection.namespace} · {collection.path}</small></summary><div className="rp-team-author-card-body">
        {!row ? <p className="rp-team-note">{t('author.missingValue')}</p> : null}
        {visible.map(record => <article className="rp-team-memory-record" key={record.id}>
          <p className="rp-team-detail-text">{record.content || t('author.missingValue')}</p><small>{record.createdAt} · {record.perspective || record.source || ''}{record.active === false ? ` · ${t('memory.archive')}` : ''}</small>
          <More summary={t('trial.details')}><ValueView value={record} /></More>
          <div className="rp-team-button-row"><button type="button" className="rp-team-quiet" disabled={blocked} onClick={() => begin(record)}>{t('author.editValue')}</button><button type="button" className="rp-team-quiet" disabled={blocked} onClick={() => saveRecord({ ...record, active: record.active === false, updatedAt: new Date().toISOString() })}>{t(record.active === false ? 'memory.restore' : 'memory.archive')}</button></div>
        </article>)}
        {!visible.length ? <p className="rp-team-note">{t('memory.empty')}</p> : null}
        <button type="button" className="rp-team-quiet is-bordered" disabled={blocked} onClick={() => begin(null)}>{t('memory.add')}</button>
        {edit?.collectionId === collection.id ? <div className="rp-team-memory-form">
          {['content', 'people', 'tags', 'source', 'perspective'].map(key => <Field key={key} label={t(`memory.${key}`)}><textarea rows={key === 'content' ? 4 : 2} value={Array.isArray(edit.record[key]) ? edit.record[key].join('\n') : edit.record[key] || ''} onChange={event => setEdit({ ...edit, record: { ...edit.record, [key]: ['people', 'tags'].includes(key) ? lines(event.target.value) : event.target.value } })} /></Field>)}
          <Field label={t('memory.confidence')}><input type="number" min="0" max="1" step="0.1" value={edit.record.confidence ?? ''} onChange={event => setEdit({ ...edit, record: event.target.value === '' ? Object.fromEntries(Object.entries(edit.record).filter(([key]) => key !== 'confidence')) : { ...edit.record, confidence: Number(event.target.value) } })} /></Field>
          <More summary={t('memory.extra')}><TypedField chooseType={false} value={Object.fromEntries(Object.entries(edit.record).filter(([key]) => !['id', 'content', 'createdAt', 'updatedAt', 'active', 'people', 'tags', 'source', 'perspective', 'confidence'].includes(key)))} bufferKey={`${conversationId}/memory/${edit.record.id}`} onInvalid={setInvalid} onChange={fields => setEdit({ ...edit, record: { ...Object.fromEntries(Object.entries(edit.record).filter(([key]) => ['id', 'content', 'createdAt', 'updatedAt', 'active', 'people', 'tags', 'source', 'perspective', 'confidence'].includes(key))), ...Object.fromEntries(Object.entries(fields).filter(([key]) => !['id', 'content', 'createdAt', 'updatedAt', 'active', 'people', 'tags', 'source', 'perspective', 'confidence'].includes(key))) } })} /></More>
          {edit.base.revision !== data.revision || edit.base.worldHash !== data.worldHash ? <p className="rp-team-callout is-warn">{t('author.editStale')}</p> : null}
          <div className="rp-team-button-row"><button type="button" className="rp-team-primary" disabled={blocked || invalid || !edit.record.content.trim()} onClick={async () => { const record = { ...edit.record, updatedAt: new Date().toISOString() }; const result = await onSave(edit.base, edit.row, edit.isNew ? [...edit.records, record] : edit.records.map(item => item.id === record.id ? record : item)); if (result?.status === 'committed') setEdit(null) }}>{t('memory.save')}</button><button type="button" className="rp-team-quiet" onClick={() => setEdit(null)}>{t('discard')}</button></div>
        </div> : null}
      </div></details>
    })}
  </section> : null
}
