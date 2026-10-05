import { React } from './react.js'
import { t } from './i18n.js'
import { createKeyedStore } from './keyed-store.js'
import { services, useKeyed } from './client-state.js'
import { Field, Check } from './fields.jsx'
import { stableContent, previewIsStale } from './author-model.js'

export const authorViews = createKeyedStore(() => ({ inputText: '', manualAgentIds: [], preview: null, catalog: null, state: null, checkpoints: [], stateEdits: {}, error: '', busy: '' }))
export function authorCall(conversationId, method, payload, commit) {
  authorViews.update(conversationId, { busy: method, error: '' })
  return services.api.author(method, payload).then(result => {
    authorViews.update(conversationId, state => ({ ...state, ...commit?.(result), busy: '', error: result.status === 'failed' ? result.error?.message || result.error || t('author.operationFailed') : '' })); return result
  }).catch(error => { authorViews.update(conversationId, { busy: '', error: error.message || String(error) }); throw error })
}
export function AuthorError({ view }) { return view.error ? <p className="rp-team-callout is-error" role="alert">{view.error}</p> : null }
export function ValueView({ value, missing = false }) {
  if (missing || value === undefined) return <span className="rp-team-note">{t('author.missingValue')}</span>
  if (value === null) return <span className="rp-team-note">{t('stateForm.nullValue')}</span>
  if (typeof value !== 'object') return <pre className="rp-team-detail-text">{String(value)}</pre>
  return <div className="rp-team-detail-tree">{Object.entries(value).map(([key, child]) => <details key={key}><summary>{Array.isArray(value) ? Number(key) + 1 : key || t('author.unnamedField')} <small>{child === null ? 'null' : Array.isArray(child) ? `${child.length} ${t('author.items')}` : typeof child}</small></summary><ValueView value={child} /></details>)}</div>
}

export function PreviewPage({ conversationId, editor, snapshot }) {
  const view = useKeyed(authorViews, conversationId)
  const runKey = `${snapshot.status?.run?.runId || ''}:${snapshot.status?.run?.phase || ''}`
  React.useEffect(() => {
    let mounted = true
    services.api.author('getContextCatalog', { conversationId }).then(catalog => { if (mounted) authorViews.update(conversationId, { catalog }) }).catch(error => { if (mounted) authorViews.update(conversationId, { error: error.message }) })
    return () => { mounted = false }
  }, [conversationId, runKey])
  const invalid = Object.values(editor.invalid).some(Boolean)
  const stale = previewIsStale(view.preview, editor.draft, view.catalog?.version, view.inputText, view.manualAgentIds) || Boolean(view.preview && view.preview.parameterContent !== stableContent(editor.parameterValues))
  const check = () => {
    const config = editor.draft
    const { inputText, manualAgentIds } = view
    const parameterValues = editor.parameterValues
    void authorCall(conversationId, 'previewConfig', { conversationId, config, parameterValues, inputText, manualAgentIds }, result => ({ preview: { ...result, draftContent: stableContent(config), parameterContent: stableContent(parameterValues), inputText, manualAgentIds } })).catch(() => {})
  }
  return <div className="rp-team-scroll"><div className="rp-team-page rp-team-author-page">
    <section className="rp-team-block"><h3>{t('author.previewTitle')}</h3><p className="rp-team-note">{t('author.previewHelp')}</p>
      <Field label={t('author.testInput')}><textarea rows={3} value={view.inputText} onChange={event => authorViews.update(conversationId, { inputText: event.target.value })} /></Field>
      <details><summary>{t('author.manualSelection')}</summary>{editor.draft.agents.map(agent => <Check key={agent.id} label={agent.name} checked={view.manualAgentIds.includes(agent.id)} onChange={enabled => authorViews.update(conversationId, { manualAgentIds: enabled ? [...view.manualAgentIds, agent.id] : view.manualAgentIds.filter(id => id !== agent.id) })} />)}</details>
      <button type="button" className="rp-team-primary" disabled={Boolean(view.busy) || invalid} onClick={check}>{view.busy ? t('author.checking') : t('author.checkNow')}</button>
      {invalid ? <p className="rp-team-field-error">{t('author.fixDraft')}</p> : null}
    </section>
    <AuthorError view={view} />
    {stale ? <p className="rp-team-callout is-warn">{t('author.previewStale')}</p> : null}
    {view.preview ? <>
      {(view.preview.issues || []).map((issue, index) => <p className="rp-team-callout is-warn" key={index}>{typeof issue === 'string' ? issue : issue.message || issue.reason || stableContent(issue)}</p>)}
      {view.preview.members.map(member => <details className="rp-team-author-card" key={member.id} open>
        <summary><span>{member.name}</span><span className={`rp-team-author-badge ${member.triggered ? 'is-on' : ''}`}>{t(member.triggered ? 'author.willRun' : 'author.willSkip')}</span></summary>
        <div className="rp-team-author-card-body">
          <p className="rp-team-note">{member.reasons.join(' · ') || t('author.noTrigger')}</p>
          {['context', 'permissions', 'tools', 'dependencies', 'missingSelections', 'dynamic', 'issues'].map(kind => <details key={kind} open={kind === 'missingSelections' && Boolean(member[kind]?.length)}><summary>{t(`author.inspect.${kind}`)}</summary><ValueView value={member[kind]} /></details>)}
        </div>
      </details>)}
    </> : <p className="rp-team-placeholder">{t('author.noPreview')}</p>}
  </div></div>
}
