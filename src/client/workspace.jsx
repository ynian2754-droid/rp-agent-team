import { React } from './react.js'
import { PreviewPage } from './author-pages.jsx'
import { StatePage } from './state-page.jsx'
import { LibraryPage } from './library-page.jsx'
import { typedBuffers } from './typed-field.jsx'
import { t } from './i18n.js'
import { normalizeTeamConfig } from '../shared/schema.mjs'
import { resolveAuthorParameters } from '../shared/author-parameters.mjs'
import { exportPayload, parseImport } from './privacy.js'
import { services, drafts, workspaceUi, PAGES, useConversation, useKeyed, useProductConversation } from './client-state.js'
import { createDraftState, invalidEntries, markSaved, replaceDraft, resolveConflict, sectionForField, syncRemote } from './draft-state.js'
import { isActivePhase } from './run-model.js'
import { ConfirmButton, Switch } from './fields.jsx'
import { MembersPage } from './members.jsx'
import { TeamPage } from './team-page.jsx'
import { TrialPage } from './trial-page.jsx'

const isConflict = cause => cause?.code === 'RP_TEAM_CONFIG_CONFLICT' || /revision|conflict/i.test(cause?.message || '')

/** Body of the official right-sidebar tab. The Session decides which conversation it edits. */
export function WorkspaceTab({ sessionId, useTabInfo }) {
  const { store } = services
  const conversationId = useProductConversation(sessionId)
  const { tab } = useTabInfo()
  const revision = tab?.navigation?.revision
  React.useEffect(() => {
    if (!conversationId) return
    const params = tab?.navigation?.params
    // Apply each navigation once, so a remounted body keeps the page the author moved to.
    if (params?.page === 'run') void services.conversations.openTrajectory(conversationId, { runId: params.runId || '' })
    if (params?.page && workspaceUi.get(conversationId).navRevision !== revision) {
      workspaceUi.update(conversationId, { page: PAGES.includes(params.page) ? params.page : 'config', runId: params.runId || '', navRevision: revision })
    }
    void store.refreshConfig(conversationId).catch(() => {})
    void store.refreshOptions(conversationId).catch(() => {})
    void store.listTraces(conversationId).catch(() => {})
    void store.refreshStatus(conversationId)
  }, [conversationId, revision])
  if (!conversationId) return <section className="rp-team-workspace"><p className="rp-team-placeholder">{t('loading')}</p></section>
  return <Workspace key={conversationId} conversationId={conversationId} />
}

function useEditorActions(conversationId) {
  const { store } = services
  const [busy, setBusy] = React.useState('')
  const [enableError, setEnableError] = React.useState('')
  const update = change => drafts.update(conversationId, change)
  const latest = () => store.getSnapshot(conversationId)
  const sync = () => update(state => syncRemote(state, latest()))
  const refreshAndSync = async () => {
    try { await store.refreshConfig(conversationId, true) } catch {}
    sync()
  }

  async function setEnabled(enabled) {
    const snapshot = latest()
    if (!snapshot.config || busy) return
    setBusy('enable')
    setEnableError('')
    try {
      await store.save(conversationId, enabled, snapshot.config, snapshot.revision)
      sync()
    } catch (cause) {
      setEnableError(cause.message || t('saveError'))
      if (isConflict(cause)) await refreshAndSync()
    } finally { setBusy('') }
  }

  async function attemptSave(state, retried) {
    try {
      const saved = await store.save(conversationId, latest().enabled, state.draft, state.baseRevision, state.parameterValues)
      update(current => markSaved(current, saved, state.draft, state.parameterValues))
    } catch (cause) {
      if (!isConflict(cause)) { update(current => ({ ...current, error: cause.message || t('saveError') })); return }
      await refreshAndSync()
      const after = drafts.get(conversationId)
      // Only the revision moved (for example the enable switch); the saved content is unchanged.
      if (!after.remote && !retried && after.draft === state.draft) return attemptSave(after, true)
      update(current => ({ ...current, error: current.remote ? '' : t('saveAgain') }))
    }
  }

  async function save() {
    const state = drafts.get(conversationId)
    if (!state?.dirty || busy || state.remote || invalidEntries(state).length) return
    try { resolveAuthorParameters(normalizeTeamConfig(state.draft), state.parameterValues) } catch (cause) { update(current => ({ ...current, error: cause.message })); return }
    setBusy('save')
    try { await attemptSave(state, false) } finally { setBusy('') }
  }

  function discard() {
    typedBuffers.removeWhere(key => key.startsWith(`${conversationId}/`))
    update(state => createDraftState(latest(), state || {}))
  }

  function resolve(choice) {
    if (choice === 'discard') typedBuffers.removeWhere(key => key.startsWith(`${conversationId}/`))
    update(state => resolveConflict(state, choice, latest()))
  }

  /** Parses and validates through the shared schema; returns null and reports on failure. */
  async function readImport(file) {
    try {
      return parseImport(JSON.parse(await file.text()))
    } catch (cause) {
      update(state => ({ ...state, error: `${t('errors.invalidImport')} ${cause.message || ''}`.trim() }))
      return null
    }
  }

  function applyConfig(config, notice, parameterValues) {
    typedBuffers.removeWhere(key => key.startsWith(`${conversationId}/`))
    update(state => replaceDraft({ ...state, view: 'roster' }, config, notice, parameterValues))
  }

  async function exportFile() {
    const state = drafts.get(conversationId)
    try {
      const payload = state?.dirty ? exportPayload(state.draft) : await store.exportConfig(conversationId)
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = `${payload.config?.id || 'rp-team'}.rp-team.json`
      anchor.click()
      setTimeout(() => URL.revokeObjectURL(url), 0)
      update(current => ({ ...current, error: '', notice: { code: current.dirty ? 'exportedDraft' : 'exported' } }))
    } catch (cause) {
      update(current => ({ ...current, error: `${t('exportFailed')}：${cause.message || ''}` }))
    }
  }

  return { busy, enableError, setEnabled, save, discard, resolve, readImport, applyConfig, exportFile }
}

function Workspace({ conversationId }) {
  const { store } = services
  const snapshot = useConversation(conversationId)
  const ui = useKeyed(workspaceUi, conversationId)
  const editor = useKeyed(drafts, conversationId)
  const actions = useEditorActions(conversationId)
  const tabsId = React.useId()
  React.useEffect(() => {
    if (snapshot.config) drafts.update(conversationId, state => syncRemote(state, snapshot))
  }, [conversationId, snapshot.config, snapshot.revision, snapshot.parameterValues])
  const run = snapshot.status?.run
  const page = PAGES.includes(ui.page) ? ui.page : 'config'
  const setPage = next => workspaceUi.update(conversationId, { page: next })
  const onTabKey = event => {
    const index = PAGES.indexOf(page)
    const next = { ArrowRight: index + 1, ArrowLeft: index - 1, Home: 0, End: PAGES.length - 1 }[event.key]
    if (next === undefined) return
    event.preventDefault()
    const target = PAGES[(next + PAGES.length) % PAGES.length]
    setPage(target)
    event.currentTarget.querySelector(`[data-page="${target}"]`)?.focus()
  }
  const runMark = isActivePhase(run?.phase) ? 'active' : run?.phase === 'failed' ? 'failed' : ''
  const config = editor?.draft || snapshot.config
  let body
  if (!editor?.draft) body = snapshot.configState === 'error'
    ? <div className="rp-team-placeholder" role="alert"><p>{t('errors.loadFailed')}</p><small>{snapshot.error}</small>
      <button type="button" className="rp-team-quiet" onClick={() => void store.refreshConfig(conversationId, true).catch(() => {})}>{t('reload')}</button></div>
    : <p className="rp-team-placeholder">{t('loading')}</p>
  else if (page === 'team') body = <TeamPage conversationId={conversationId} editor={editor} actions={actions} />
  else if (page === 'preview') body = <PreviewPage conversationId={conversationId} editor={editor} snapshot={snapshot} />
  else if (page === 'trial') body = <TrialPage conversationId={conversationId} editor={editor} actions={actions} />
  else if (page === 'state') body = <StatePage conversationId={conversationId} editor={editor} snapshot={snapshot} />
  else if (page === 'library') body = <LibraryPage conversationId={conversationId} editor={editor} actions={actions} />
  else body = <MembersPage conversationId={conversationId} editor={editor} snapshot={snapshot} />

  return <section className="rp-team-workspace" aria-label={t('team')}>
    <header className="rp-team-ws-head">
      <div className="rp-team-ws-title">
        <h2>{t('team')}</h2>
        <p>{config ? t('presetLine', { name: config.name, n: config.agents.length }) : t('loading')}</p>
      </div>
      <Switch checked={Boolean(snapshot.enabled)} label={t('teamEnabled')} busy={actions.busy === 'enable'}
        disabled={!snapshot.config} onChange={enabled => void actions.setEnabled(enabled)} />
    </header>
    {actions.enableError ? <p className="rp-team-banner is-error" role="alert">{actions.enableError}</p> : null}
    <div className="rp-team-tabs" role="tablist" aria-label={t('teamPages')} onKeyDown={onTabKey}>
      {PAGES.map(item => <button key={item} type="button" role="tab" data-page={item} id={`${tabsId}-${item}`}
        aria-selected={page === item} aria-controls={`${tabsId}-panel`} tabIndex={page === item ? 0 : -1} onClick={() => setPage(item)}>
        {t(`pages.${item}`)}{item === 'run' && runMark ? <span className={`rp-team-tab-mark is-${runMark}`} aria-label={t(`status.${run.phase}`)} /> : null}
      </button>)}
    </div>
    <div className="rp-team-ws-body" role="tabpanel" id={`${tabsId}-panel`} aria-labelledby={`${tabsId}-${page}`}>{body}</div>
    {editor?.draft ? <SaveBar conversationId={conversationId} editor={editor} actions={actions} /> : null}
  </section>
}

function SaveBar({ conversationId, editor, actions }) {
  const invalid = invalidEntries(editor)
  const validation = React.useMemo(() => {
    if (!editor.dirty) return ''
    try { resolveAuthorParameters(normalizeTeamConfig(editor.draft), editor.parameterValues); return '' } catch (cause) { return cause.message }
  }, [editor.draft, editor.parameterValues, editor.dirty])
  const nameOf = id => id === '$team' ? t('pages.team') : editor.draft.agents.find(agent => agent.id === id)?.name || id
  const jump = entry => {
    if (entry.scope === '$team') { workspaceUi.update(conversationId, { page: 'team' }); return }
    workspaceUi.update(conversationId, { page: 'config' })
    drafts.update(conversationId, state => ({ ...state, selectedId: entry.scope, view: 'member', open: { ...state.open, [sectionForField(entry.field)]: true } }))
  }
  const notice = typeof editor.notice === 'string' ? { code: editor.notice } : editor.notice || {}
  const blocked = Boolean(invalid.length || validation || editor.remote)
  let status
  if (editor.remote) status = <span className="rp-team-save-state is-warn">{t('conflictShort')}</span>
  else if (invalid.length) status = <span className="rp-team-save-state is-error">{t(editor.stateForms && invalid.some(entry => entry.field === 'definitions') ? 'stateForm.invalidSave' : 'invalidCount', { n: invalid.length })}
    {invalid.map(entry => <button key={entry.key} type="button" className="rp-team-link" onClick={() => jump(entry)}>{nameOf(entry.scope)} · {t(`jsonField.${/condition/.test(entry.field) ? 'condition' : entry.field.startsWith('handoff-') ? 'communication' : entry.field.startsWith('definitions') ? 'definitions' : entry.field}`)}</button>)}</span>
  else if (editor.error) status = <span className="rp-team-save-state is-error" role="alert">{editor.error}</span>
  else if (validation) status = <span className="rp-team-save-state is-error">{t('cannotSave')}{validation}</span>
  else if (editor.dirty) status = <span className="rp-team-save-state is-dirty">{notice.code === 'imported' || notice.code === 'example' ? t(`notice.${notice.code}`, { name: notice.name }) : notice.code === 'exportedDraft' ? t('notice.exportedDraft') : t('unsaved')}</span>
  else status = <span className="rp-team-save-state">{notice.code === 'saved' ? t('notice.saved') : notice.code === 'exported' ? t('notice.exported') : t('savedNextTurn')}</span>
  return <footer className="rp-team-savebar">
    {editor.remote ? <div className="rp-team-conflict" role="alert">
      <p>{t('conflictHelp')}</p>
      <div>
        <button type="button" className="rp-team-quiet" onClick={() => actions.resolve('keep')}>{t('conflictKeep')}</button>
        <ConfirmButton label={t('conflictDiscard')} confirmLabel={t('confirmDiscard')} onConfirm={() => actions.resolve('discard')} />
      </div>
    </div> : null}
    <div className="rp-team-savebar-row">
      <div className="rp-team-savebar-status" aria-live="polite">{status}</div>
      <div className="rp-team-savebar-actions">
        {editor.dirty ? <ConfirmButton label={t('discard')} confirmLabel={t('confirmDiscard')} onConfirm={actions.discard} disabled={actions.busy === 'save'} /> : null}
        <button type="button" className="rp-team-primary" disabled={!editor.dirty || blocked || Boolean(actions.busy)} aria-busy={actions.busy === 'save' || undefined}
          onClick={() => void actions.save()}>{actions.busy === 'save' ? t('saving') : t('save')}</button>
      </div>
    </div>
  </footer>
}
