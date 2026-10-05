import { React } from './react.js'
import { t } from './i18n.js'
import {
  CONTEXT_SOURCES, MEMBER_SCOPED_SOURCES, STATE_BACKED_SOURCES,
  addSource, incompleteSource, omitKeys, removeSource, sourceRowKeys, toggleAllowlist, toggleSource, updateSource
} from './editor-model.js'
import { Check, Field, JsonField, More, Radio } from './fields.jsx'
import { authorViews } from './author-pages.jsx'
import { services, useKeyed } from './client-state.js'
import { pointerLabel } from './author-model.js'

export function ContextSection({ member, config, edit, json, conversationId }) {
  const view = useKeyed(authorViews, conversationId)
  React.useEffect(() => {
    let active = true
    services.api.author('getContextCatalog', { conversationId }).then(catalog => { if (active) authorViews.update(conversationId, { catalog }) }).catch(error => { if (active) authorViews.update(conversationId, { error: error.message }) })
    return () => { active = false }
  }, [conversationId])
  const sources = member.context.sources
  const rowState = React.useRef({ memberId: member.id, sources: [], keys: [], next: 0 })
  if (rowState.current.memberId !== member.id) rowState.current = { memberId: member.id, sources: [], keys: [], next: 0 }
  const keys = sourceRowKeys(rowState.current, sources, () => `source-${rowState.current.next++}`)
  rowState.current = { ...rowState.current, sources, keys }
  const compaction = member.compaction
  const contextJson = json('context', context => ({ context }))
  return <>
    <p className="rp-team-note">{t('contextHelp')}</p>
    <ul className="rp-team-source-list">
      {CONTEXT_SOURCES.map(type => {
        const rows = sources.flatMap((source, index) => source.type === type ? [{ source, index }] : [])
        const full = rows.some(({ source }) => source.selector === undefined || source.selector === '')
        return <li key={type} className={rows.length ? 'is-on' : ''}>
          <Check label={t(`sources.${type}`)} hint={t(`sourceHints.${type}`)} checked={Boolean(rows.length)}
            onChange={enabled => edit({ context: toggleSource(member, type, enabled) })} />
          {rows.length ? <div className="rp-team-nested">
            {STATE_BACKED_SOURCES.has(type) ? <p className="rp-team-note">{t('stateBackedHint')}</p> : null}
            {rows.length > 1 && full ? <p className="rp-team-callout is-warn">{t('fullSourceWarning')}</p> : null}
            {rows.map(({ source, index }, row) => <SourceSelection key={keys[index]} {...{ source, index, member, config, edit }} fields={view.catalog?.sources?.find(item => item.type === type)?.fields || []} number={row + 1} />)}
            <button type="button" className="rp-team-quiet is-bordered" onClick={() => edit({ context: addSource(member, type) })}>{t('addSourceField')}</button>
          </div> : null}
        </li>
      })}
    </ul>
    <fieldset className="rp-team-group">
      <legend>{t('compaction')}</legend>
      <Field label={t('historyCompactionInstructions')}>
        <textarea rows={3} value={compaction.historyCompactionInstructions || ''} onChange={event => edit({ compaction: event.target.value ? { ...compaction, historyCompactionInstructions: event.target.value } : omitKeys(compaction, ['historyCompactionInstructions']) })} />
      </Field>
      <Field label={t('autoCompactTokenLimit')} hint={t('compactionLimitHint')}>
        <input type="number" min="1" step="1" value={compaction.autoCompactTokenLimit ?? ''} onChange={event => edit({ compaction: event.target.value ? { ...compaction, autoCompactTokenLimit: Number(event.target.value) } : omitKeys(compaction, ['autoCompactTokenLimit']) })} />
      </Field>
    </fieldset>
    <More summary={t('advancedContext')} startOpen={contextJson.invalid}>
      <JsonField label={t('contextRules')} value={member.context} binding={contextJson} />
    </More>
  </>
}

function SourceSelection({ source, index, number, member, config, edit, fields }) {
  const field = Object.hasOwn(source, 'selector') && source.selector !== ''
  const invalid = incompleteSource(source)
  const set = changes => edit({ context: updateSource(member, index, changes) })
  return <fieldset className="rp-team-source-selection">
    <legend>{t('sourceSelection', { n: number })}</legend>
    <div className="rp-team-source-selection-head">
      <Field label={t('sourceScope')}>
        <select value={field ? 'field' : 'all'} onChange={event => set({ selector: event.target.value === 'all' ? undefined : null })}>
          <option value="all">{t('sourceAll')}</option>
          <option value="field">{t('sourceField')}</option>
        </select>
      </Field>
      <button type="button" className="rp-team-link" aria-label={t('removeSourceSelection', { n: number })}
        onClick={() => edit({ context: removeSource(member, index) })}>{t('remove')}</button>
    </div>
    {field ? <>
      <Field label={t('author.chooseField')} warn={invalid ? t('sourcePathRequired') : ''}>
        <select value={source.selector ?? ''} onChange={event => set({ selector: event.target.value || null })}>
          <option value="">{t('choose')}</option>
          {source.selector && !fields.some(item => item.path === source.selector) ? <option value={source.selector}>{pointerLabel(source.selector)} · {t('author.unlistedField')}</option> : null}
          {fields.map(item => <option key={item.path} value={item.path}>{item.label || pointerLabel(item.path)}</option>)}
        </select>
      </Field>
      <More summary={t('author.addressAdvanced')}><Field label={t('sourceSelector')} hint={t('selectorHelp')}>
        <input value={source.selector ?? ''} placeholder="/persona/name" spellCheck="false" aria-invalid={invalid || undefined} onChange={event => set({ selector: event.target.value || null })} />
      </Field></More>
    </> : null}
    <Field label={source.type === 'recent_history' ? t('historyLimit') : t('sourceLimit')} hint={t('sourceLimitHint')}>
      <input type="number" min="1" step="1" value={source.limit ?? ''}
        onChange={event => set({ limit: event.target.value === '' ? undefined : Number(event.target.value) })} />
    </Field>
    {MEMBER_SCOPED_SOURCES.has(source.type) ? <MemberScope {...{ member, config, source, set }} /> : null}
  </fieldset>
}

function MemberScope({ member, config, source, set }) {
  const name = React.useId()
  const limited = Array.isArray(source.agentIds)
  const others = config.agents.filter(agent => agent.id !== member.id)
  return <fieldset className="rp-team-peers">
    <legend>{t('visibleMembers')}</legend>
    {source.type === 'drafts' ? <p className="rp-team-note">{t('ownDraftHint')}</p> : null}
    <Radio name={name} label={t('scopeAllAllowed')} checked={!limited} onChange={() => set({ agentIds: undefined })} />
    <Radio name={name} label={t('scopeOnly')} checked={limited} onChange={() => set({ agentIds: [] })} />
    {limited ? <div className="rp-team-nested">
      {others.map(agent => <Check key={agent.id} label={agent.name} checked={source.agentIds.includes(agent.id)}
        onChange={enabled => set({ agentIds: toggleAllowlist(source.agentIds, agent.id, enabled) })} />)}
      {!source.agentIds.length ? <p className="rp-team-note">{t(source.type === 'drafts' ? 'scopeOwnDrafts' : 'scopeNone')}</p> : null}
    </div> : null}
  </fieldset>
}
