import { React } from './react.js'
import { StatePage } from './state-page.jsx'
import { PresetsPage } from './presets-page.jsx'
import { RunPage } from './run-page.jsx'
import { typedBuffers } from './typed-field.jsx'
import { t, tOr } from './i18n.js'
import { normalizeTeamConfig } from '../shared/schema.mjs'
import { resolveAuthorParameters } from '../shared/author-parameters.mjs'
import { exportPayload, parseImport } from './privacy.js'
import { services, drafts, workspaceUi, PAGES, resolvePage, useConversation, useKeyed, useProductConversation } from './client-state.js'
import { createDraftState, draftChanges, invalidEntries, markSaved, replaceDraft, resolveConflict, sectionForField, syncRemote, tabForSection, teamViewForField } from './draft-state.js'
import { isActivePhase } from './run-model.js'
import { ConfirmButton, Icon, Segmented, Switch } from './fields.jsx'
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
    if (params?.page && workspaceUi.get(conversationId).navRevision !== revision) {
      const [page, extra] = resolvePage(params.page)
      workspaceUi.update(conversationId, { page, ...extra, ...(page === 'run' ? { runId: params.runId || '' } : {}), navRevision: revision })
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
      try {
        await store.save(conversationId, enabled, snapshot.config, snapshot.revision)
      } catch (cause) {
        if (!isConflict(cause)) throw cause
        // Only the revision was stale (another save or switch landed first): flip the switch on the current config once.
        await refreshAndSync()
        const fresh = latest()
        if (fresh.enabled !== enabled) await store.save(conversationId, enabled, fresh.config, fresh.revision)
      }
      sync()
    } catch (cause) {
      setEnableError(cause.code ? tOr(`shell.enableError.${cause.code}`, cause.message) : cause.message || t('saveError'))
      if (isConflict(cause)) await refreshAndSync()
    } finally { setBusy('') }
  }

  async function attemptSave(state, retried) {
    try {
      const saved = await store.save(conversationId, latest().enabled, state.draft, state.baseRevision, state.parameterValues)
      update(current => markSaved(current, saved, state.draft, state.parameterValues))
      setEnableError('')
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
    // A replaced draft is reviewed from the member list, whichever page asked for it.
    workspaceUi.update(conversationId, { page: 'team', teamView: 'members' })
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

  return { busy, enableError, clearEnableError: () => setEnableError(''), setEnabled, save, discard, resolve, readImport, applyConfig, exportFile }
}

function Workspace({ conversationId }) {
  const { store } = services
  const snapshot = useConversation(conversationId)
  const ui = useKeyed(workspaceUi, conversationId)
  const editor = useKeyed(drafts, conversationId)
  const actions = useEditorActions(conversationId)
  const panelId = React.useId()
  React.useEffect(() => {
    if (snapshot.config) drafts.update(conversationId, state => syncRemote(state, snapshot))
  }, [conversationId, snapshot.config, snapshot.revision, snapshot.parameterValues])
  const run = snapshot.status?.run
  const page = PAGES.includes(ui.page) ? ui.page : 'run'
  const setPage = next => workspaceUi.update(conversationId, { page: next })
  const config = editor?.draft || snapshot.config
  const changes = React.useMemo(() => draftChanges(editor, snapshot), [editor?.draft, editor?.parameterValues, editor?.dirty, snapshot.config, snapshot.parameterValues])
  const invalid = invalidEntries(editor)
  const runMark = isActivePhase(run?.phase) ? 'active' : run?.phase === 'failed' ? 'failed' : ''
  const teamMark = invalid.length ? 'failed' : editor?.dirty ? 'dirty' : ''
  const options = PAGES.map(item => ({
    id: item, label: t(`nav.${item}`), title: t(`navHint.${item}`),
    ...(item === 'run' && runMark ? { mark: runMark, markLabel: t(`status.${run.phase}`) } : {}),
    ...(item === 'team' && teamMark ? { mark: teamMark, markLabel: t(teamMark === 'failed' ? 'shell.needsFix' : 'shell.draft') } : {})
  }))
  let body
  if (!editor?.draft) body = snapshot.configState === 'error'
    ? <div className="rp-team-placeholder" role="alert"><p>{t('errors.loadFailed')}</p><small>{snapshot.error}</small>
      <button type="button" className="rp-team-quiet is-bordered" onClick={() => void store.refreshConfig(conversationId, true).catch(() => {})}>{t('reload')}</button></div>
    : <p className="rp-team-placeholder">{t('loading')}</p>
  else if (page === 'team') body = <TeamPage conversationId={conversationId} editor={editor} snapshot={snapshot} changes={changes} />
  else if (page === 'presets') body = <PresetsPage conversationId={conversationId} editor={editor} snapshot={snapshot} actions={actions} />
  else if (page === 'trial') body = <TrialPage conversationId={conversationId} editor={editor} snapshot={snapshot} actions={actions} />
  else if (page === 'state') body = <StatePage conversationId={conversationId} editor={editor} snapshot={snapshot} />
  else body = <RunPage conversationId={conversationId} snapshot={snapshot} editor={editor} onEnable={enabled => void actions.setEnabled(enabled)} enableBusy={actions.busy === 'enable'} />
  const saved = snapshot.config
  const swapped = Boolean(config && saved && editor?.dirty && config.id !== saved.id)

  return <section className="rp-team-workspace" aria-label={t('team')} data-page={page}>
    <header className="rp-team-bar">
      <div className="rp-team-bar-id">
        <h2 title={config?.name}>{config ? config.name : t('team')}</h2>
        <p>{config ? <>
          <span>{t('shell.versionLine', { version: config.version, n: config.agents.length })}</span>
          {editor?.dirty ? <span className="rp-team-chip is-draft">{t('shell.draft')}</span> : null}
          {swapped ? <span className="rp-team-bar-live" title={saved.name}>{t('shell.liveIs', { name: saved.name })}</span> : null}
        </> : t('loading')}</p>
      </div>
      <Switch checked={Boolean(snapshot.enabled)} label={t('teamEnabled')} busy={actions.busy === 'enable'} title={t('shell.enableHint')}
        disabled={!snapshot.config || actions.busy === 'save'} onChange={enabled => void actions.setEnabled(enabled)} />
    </header>
    {actions.enableError ? <div className="rp-team-banner is-error" role="alert">
      <p><strong>{t('shell.enableFailed')}</strong> <span className="rp-team-banner-detail">{actions.enableError}</span></p>
      <button type="button" className="rp-team-icon-button" aria-label={t('shell.dismiss')} title={t('shell.dismiss')} onClick={actions.clearEnableError}><Icon name="cross" /></button>
    </div> : null}
    <Segmented className="rp-team-nav" label={t('teamPages')} value={page} options={options} onChange={setPage} />
    <div className="rp-team-ws-body" role="tabpanel" id={panelId} aria-label={t(`nav.${page}`)}>{body}</div>
    {editor?.draft ? <SaveBar conversationId={conversationId} editor={editor} actions={actions} changes={changes} invalid={invalid} /> : null}
  </section>
}

function SaveBar({ conversationId, editor, actions, changes, invalid }) {
  const validation = React.useMemo(() => {
    if (!editor.dirty) return ''
    try { resolveAuthorParameters(normalizeTeamConfig(editor.draft), editor.parameterValues); return '' } catch (cause) { return cause.message }
  }, [editor.draft, editor.parameterValues, editor.dirty])
  const nameOf = id => id === '$team' ? t('shell.teamSettings') : editor.draft.agents.find(agent => agent.id === id)?.name || id
  const openMember = (id, tab) => {
    workspaceUi.update(conversationId, { page: 'team', teamView: 'members', ...(tab ? { memberTab: tab } : {}) })
    drafts.update(conversationId, state => ({ ...state, selectedId: id, view: 'member' }))
  }
  const jump = entry => {
    if (entry.scope === '$team') { workspaceUi.update(conversationId, { page: 'team', teamView: teamViewForField(entry.field) }); return }
    openMember(entry.scope, tabForSection(sectionForField(entry.field)))
  }
  const fieldLabel = field => /condition/.test(field) ? t('jsonField.condition') : field.startsWith('handoff-') ? t('jsonField.communication')
    : field.startsWith('definitions') ? t('jsonField.definitions') : field.startsWith('param') ? t('params.title')
      : ['parameters', 'context', 'statePermissions', 'capabilities', 'trustedTools', 'metadata'].includes(field) ? t(`jsonField.${field}`) : t('shell.field')
  const notice = typeof editor.notice === 'string' ? { code: editor.notice } : editor.notice || {}
  const blocked = Boolean(invalid.length || validation || editor.remote)
  const quiet = !editor.dirty && !editor.remote && !editor.error && !invalid.length
  // Nothing to decide: the bar steps aside, apart from a one-line confirmation of the last action.
  if (quiet && !['saved', 'exported'].includes(notice.code)) return null
  let status
  if (editor.remote) status = <span className="rp-team-save-state is-warn">{t('conflictShort')}</span>
  else if (invalid.length) status = <span className="rp-team-save-state is-error">
    <span className="rp-team-save-lead">{t(editor.stateForms && invalid.some(entry => entry.field === 'definitions') ? 'stateForm.invalidSave' : 'invalidCount', { n: invalid.length })}</span>
    <span className="rp-team-save-list">{invalid.map(entry => <button key={entry.key} type="button" className="rp-team-link" onClick={() => jump(entry)}>{nameOf(entry.scope)} · {fieldLabel(entry.field)}</button>)}</span>
  </span>
  else if (editor.error) status = <span className="rp-team-save-state is-error" role="alert">{editor.error}</span>
  else if (validation) status = <span className="rp-team-save-state is-error">{t('cannotSave')}{validation}</span>
  else if (editor.dirty) status = <span className="rp-team-save-state is-dirty">
    <span className="rp-team-save-lead">{notice.code === 'imported' || notice.code === 'example' ? t(`notice.${notice.code}`, { name: notice.name }) : notice.code === 'exportedDraft' ? t('notice.exportedDraft') : t('shell.unsaved')}</span>
    {changes.count ? <span className="rp-team-save-list">
      {changes.members.map(member => <button key={member.id} type="button" className="rp-team-link" onClick={() => openMember(member.id)}>{member.name}{member.kind === 'added' ? t('shell.addedMark') : ''}</button>)}
      {changes.removed.map(name => <span key={name} className="is-removed">{name}</span>)}
      {changes.params ? <button type="button" className="rp-team-link" onClick={() => workspaceUi.update(conversationId, { page: 'team', teamView: 'params' })}>{t('params.title')}</button> : null}
      {changes.team ? <button type="button" className="rp-team-link" onClick={() => workspaceUi.update(conversationId, { page: 'team', teamView: 'settings' })}>{t('shell.teamSettings')}</button> : null}
    </span> : null}
  </span>
  else status = <span className="rp-team-save-state is-done">{notice.code === 'saved' ? t('notice.saved') : t('notice.exported')}</span>
  return <footer className={`rp-team-savebar ${quiet ? 'is-quiet' : ''}`}>
    {editor.remote ? <div className="rp-team-conflict" role="alert">
      <p>{t('conflictHelp')}</p>
      <div>
        <button type="button" className="rp-team-quiet is-bordered" onClick={() => actions.resolve('keep')}>{t('conflictKeep')}</button>
        <ConfirmButton label={t('conflictDiscard')} confirmLabel={t('confirmDiscard')} onConfirm={() => actions.resolve('discard')} />
      </div>
    </div> : null}
    <div className="rp-team-savebar-row">
      <div className="rp-team-savebar-status" aria-live="polite">{status}</div>
      {quiet ? null : <div className="rp-team-savebar-actions">
        {editor.dirty ? <ConfirmButton label={t('discard')} confirmLabel={t('confirmDiscard')} onConfirm={actions.discard} disabled={actions.busy === 'save'} /> : null}
        <button type="button" className="rp-team-primary" disabled={!editor.dirty || blocked || Boolean(actions.busy)} aria-busy={actions.busy === 'save' || undefined}
          onClick={() => void actions.save()}>{actions.busy === 'save' ? t('saving') : t('save')}</button>
      </div>}
    </div>
  </footer>
}
