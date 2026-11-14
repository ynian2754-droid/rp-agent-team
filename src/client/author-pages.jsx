import { React } from './react.js'
import { t, tOr } from './i18n.js'
import { createKeyedStore } from './keyed-store.js'
import { services, useKeyed } from './client-state.js'
import { Field, Check, Icon, Section, Sigil, StatusTag } from './fields.jsx'
import { stableContent, previewIsStale } from './author-model.js'
import { forecast } from './explain.js'
import { manualMembers } from './editor-model.js'

export const authorViews = createKeyedStore(() => ({ inputText: '', manualAgentIds: [], preview: null, catalog: null, catalogError: false, state: null, checkpoints: [], stateEdits: {}, error: '', busy: '' }))

// Calls still in flight per chat, and the newest call per chat and method. `busy` stays set while any call runs,
// and a slower, older call of the same method does not overwrite what a newer one already showed.
const inflight = new Map()
const latestCall = new Map()
let callSeq = 0

export function authorCall(conversationId, method, payload, commit) {
  const seq = ++callSeq
  const callKey = `${conversationId}\u0000${method}`
  latestCall.set(callKey, seq)
  inflight.set(conversationId, [...(inflight.get(conversationId) || []), method])
  const settle = () => {
    const pending = [...(inflight.get(conversationId) || [])]
    pending.splice(pending.indexOf(method), 1)
    inflight.set(conversationId, pending)
    return { busy: pending.at(-1) || '', superseded: latestCall.get(callKey) !== seq }
  }
  authorViews.update(conversationId, { busy: method, error: '' })
  return services.api.author(method, payload).then(result => {
    const { busy, superseded } = settle()
    authorViews.update(conversationId, state => superseded ? { ...state, busy } : {
      ...state, ...commit?.(result, state), busy,
      error: result.status === 'failed' ? result.error?.message || result.error || t('author.operationFailed') : ''
    })
    return result
  }).catch(error => {
    const { busy, superseded } = settle()
    authorViews.update(conversationId, superseded ? { busy } : { busy, error: error.message || String(error) })
    throw error
  })
}
export function AuthorError({ view }) { return view.error ? <p className="rp-team-callout is-error" role="alert">{view.error}</p> : null }
export function ValueView({ value, missing = false }) {
  if (missing || value === undefined) return <span className="rp-team-note">{t('author.missingValue')}</span>
  if (value === null) return <span className="rp-team-note">{t('stateForm.nullValue')}</span>
  if (typeof value !== 'object') return <pre className="rp-team-detail-text">{String(value)}</pre>
  if (!Object.keys(value).length) return <span className="rp-team-note">{t('author.emptyValue')}</span>
  return <div className="rp-team-detail-tree">{Object.entries(value).map(([key, child]) => <details key={key}><summary>{Array.isArray(value) ? Number(key) + 1 : key || t('author.unnamedField')} <small>{child === null ? 'null' : Array.isArray(child) ? `${child.length} ${t('author.items')}` : typeof child === 'object' ? '' : typeof child === 'string' && child.length <= 48 ? child : typeof child !== 'string' ? String(child) : ''}</small></summary><ValueView value={child} /></details>)}</div>
}

const INSPECT = ['context', 'permissions', 'tools', 'dependencies', 'missingSelections', 'dynamic', 'issues']
const FORECAST_TONE = { run: 'next', request: 'idle', depends: 'queued', skip: 'idle', never: 'idle' }
const hasContent = value => Array.isArray(value) ? value.length > 0 : value && typeof value === 'object' ? Object.keys(value).length > 0 : value !== undefined && value !== null && value !== ''

/** A free dry run: who would start on a given message and what each of them could see. No model is called. */
export function CheckPanel({ conversationId, editor, snapshot }) {
  const view = useKeyed(authorViews, conversationId)
  const runKey = `${snapshot.status?.run?.runId || ''}:${snapshot.status?.run?.phase || ''}`
  // The chat, world or state can change without a Team run (the team may be off), so the catalog version is
  // re-read on open, after every check and whenever the window regains focus. The views store is per chat,
  // so a late answer only updates the chat it belongs to.
  const catalogSeq = React.useRef(0)
  const refreshCatalog = React.useCallback(() => {
    const seq = ++catalogSeq.current
    return services.api.author('getContextCatalog', { conversationId }).then(
      catalog => { if (seq === catalogSeq.current) authorViews.update(conversationId, { catalog, catalogError: false }) },
      () => { if (seq === catalogSeq.current) authorViews.update(conversationId, { catalogError: true }) }
    )
  }, [conversationId])
  React.useEffect(() => {
    void refreshCatalog()
    const onFocus = () => { void refreshCatalog() }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [refreshCatalog, runKey])
  const invalid = Object.values(editor.invalid).some(Boolean)
  let manual = []
  try { manual = manualMembers(editor.draft, editor.parameterValues) } catch { /* The preview surfaces invalid draft details. */ }
  const manualAgentIds = view.manualAgentIds.filter(id => manual.some(agent => agent.id === id))
  const stale = previewIsStale(view.preview, editor.draft, view.catalog?.version, view.inputText, manualAgentIds) || Boolean(view.preview && view.preview.parameterContent !== stableContent(editor.parameterValues))
  const check = () => {
    const config = editor.draft
    const { inputText } = view
    const parameterValues = editor.parameterValues
    void authorCall(conversationId, 'previewConfig', { conversationId, config, parameterValues, inputText, manualAgentIds }, result => ({ preview: { ...result, draftContent: stableContent(config), parameterContent: stableContent(parameterValues), inputText, manualAgentIds } }))
      .then(() => refreshCatalog(), () => {})
  }
  const preview = view.preview
  return <div className="rp-team-scroll"><div className="rp-team-page rp-team-checkpage">
    <Section title={t('author.previewTitle')} hint={t('author.previewHelp')}>
      <Field label={t('author.testInput')}><textarea rows={3} value={view.inputText} onChange={event => authorViews.update(conversationId, { inputText: event.target.value })} /></Field>
      {manual.length ? <fieldset className="rp-team-group"><legend>{t('author.manualSelection')}</legend>
        <div className="rp-team-checks">{manual.map(agent => <Check key={agent.id} label={agent.name} checked={view.manualAgentIds.includes(agent.id)} onChange={enabled => authorViews.update(conversationId, { manualAgentIds: enabled ? [...view.manualAgentIds, agent.id] : view.manualAgentIds.filter(id => id !== agent.id) })} />)}</div>
      </fieldset> : null}
      <div className="rp-team-launch">
        <button type="button" className="rp-team-primary is-large" disabled={Boolean(view.busy) || invalid} onClick={check}>{view.busy === 'previewConfig' ? t('author.checking') : t('author.checkNow')}</button>
        <p className="rp-team-note">{invalid ? t('author.fixDraft') : editor.dirty ? t('check.usesDraft') : t('check.usesSaved')}</p>
      </div>
    </Section>
    <AuthorError view={view} />
    {preview ? <Section title={preview.nextUserTurn ? t('check.resultTurn', { n: preview.nextUserTurn }) : t('check.result')}
      aside={<span className="rp-team-note">{t('check.willRun', { n: preview.members.filter(member => member.triggered).length, total: preview.members.length })}</span>}>
      {stale ? <p className="rp-team-callout is-warn">{t('author.previewStale')}</p>
        : view.catalogError ? <p className="rp-team-note">{t('check.staleUnknown')}</p> : null}
      {(preview.issues || []).map((issue, index) => <p className="rp-team-callout is-warn" key={index}>{typeof issue === 'string' ? issue : issue.message || issue.reason || stableContent(issue)}</p>)}
      <ol className={`rp-team-cast ${stale ? 'is-stale' : ''}`}>
        {preview.members.map((member, index) => <CheckRow key={member.id} member={member} index={index} config={editor.draft} />)}
      </ol>
    </Section> : <p className="rp-team-placeholder is-inline">{t('author.noPreview')}</p>}
  </div></div>
}

function CheckRow({ member, index, config }) {
  const [open, setOpen] = React.useState(false)
  const bodyId = React.useId()
  const result = member.triggerChecks ? forecast(member, config) : { kind: member.triggered ? 'run' : 'skip', lines: member.reasons || [] }
  const kind = member.triggered ? 'run' : result.kind === 'run' ? 'skip' : result.kind
  const problems = (member.issues || []).length + (member.missingSelections || []).length
  const sources = Object.keys(member.context || {})
  return <li className={`rp-team-cast-row tone-${FORECAST_TONE[kind]} ${member.triggered ? 'is-in' : 'is-out'} ${open ? 'is-open' : ''}`}>
    <button type="button" className="rp-team-cast-head" aria-expanded={open} aria-controls={open ? bodyId : undefined} onClick={() => setOpen(value => !value)}>
      <Sigil name={member.name} index={index} muted={!member.triggered} />
      <span className="rp-team-cast-name">{member.name}</span>
      <StatusTag tone={FORECAST_TONE[kind]}>{member.triggered ? t('author.willRun') : t(`nextKind.${kind}`)}</StatusTag>
      <span className="rp-team-cast-line">{result.lines.join(t('clauseSep')) || t('author.noTrigger')}</span>
      {problems ? <span className="rp-team-cast-error">{t('check.problems', { n: problems })}</span> : null}
      <Icon name="chevron" className="rp-team-cast-chevron" />
    </button>
    {open ? <div className="rp-team-cast-body" id={bodyId}>
      {sources.length ? <div className="rp-team-chips">{sources.map(type => <span className="rp-team-chip" key={type}>{tOr(`sourceShort.${type}`, type)}</span>)}</div> : <p className="rp-team-note">{t('summary.noContext')}</p>}
      {INSPECT.filter(kind => hasContent(member[kind])).map(kind => <details className="rp-team-inspect" key={kind} open={kind === 'missingSelections' || kind === 'issues'}>
        <summary>{t(`author.inspect.${kind}`)}</summary>
        {Array.isArray(member[kind]) && member[kind].every(item => typeof item === 'string')
          ? <ul className="rp-team-plain-list is-text">{member[kind].map((item, i) => <li key={i}>{kind === 'dependencies' ? config.agents.find(agent => agent.id === item)?.name || item : item}</li>)}</ul>
          : <ValueView value={member[kind]} />}
      </details>)}
    </div> : null}
  </li>
}
