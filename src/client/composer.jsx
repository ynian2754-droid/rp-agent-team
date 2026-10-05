import { React } from './react.js'
import { t } from './i18n.js'
import { services, openWorkspace, useConversation, useProductConversation } from './client-state.js'
import { manualMembers } from './editor-model.js'
import { composerStatus, findMessageRun, isActivePhase, runMembers } from './run-model.js'
import { Check, Icon } from './fields.jsx'

/** Composer entry: one quiet button, plus the next-turn picker when manual members exist. */
export function TeamToggle({ sessionId, useSessionStatus }) {
  const { store } = services
  const conversationId = useProductConversation(sessionId)
  const isSending = useSessionStatus(value => value.get(sessionId)?.running === true)
  const snapshot = useConversation(conversationId)
  React.useEffect(() => {
    if (conversationId) void store.refreshConfig(conversationId).catch(() => {})
  }, [conversationId])
  React.useEffect(() => {
    if (!conversationId || !snapshot.enabled || !isSending) return
    return store.watchStatus(conversationId, { persistent: true })
  }, [conversationId, snapshot.enabled, isSending])
  if (!conversationId) return null
  const failed = snapshot.configState === 'error'
  const state = failed ? t('configUnavailable') : snapshot.enabled ? t('enabled') : t('disabled')
  const manual = snapshot.enabled ? manualMembers(snapshot.config) : []
  return <div className="rp-team-control">
    <button type="button" className={`rp-team-toggle ${snapshot.enabled ? 'is-enabled' : ''} ${failed ? 'is-error' : ''}`}
      aria-label={`${t('openTeam')}（${state}）`} title={failed ? snapshot.error : `${t('openTeam')}（${state}）`}
      onClick={() => openWorkspace(sessionId, conversationId)}>
      <span className="rp-team-toggle-icon"><Icon name="team" /><span className="rp-team-dot" /></span>
      <span>{t('team')}</span>
    </button>
    {manual.length > 0 ? <ManualPicker conversationId={conversationId} members={manual} selectedIds={snapshot.status?.manualAgentIds || []} /> : null}
  </div>
}

function ManualPicker({ conversationId, members, selectedIds }) {
  const { store } = services
  const [open, setOpen] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState('')
  const rootRef = React.useRef(null)
  const buttonRef = React.useRef(null)
  const popoverId = React.useId()
  const [optimistic, setOptimistic] = React.useState(null)
  const selected = (optimistic || selectedIds).filter(id => members.some(agent => agent.id === id))
  React.useEffect(() => {
    if (!open) return
    rootRef.current?.querySelector('.rp-team-popover input')?.focus()
    const onPointer = event => { if (!rootRef.current?.contains(event.target)) setOpen(false) }
    const onKey = event => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      setOpen(false)
      buttonRef.current?.focus()
    }
    document.addEventListener('pointerdown', onPointer, true)
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('pointerdown', onPointer, true)
      document.removeEventListener('keydown', onKey, true)
    }
  }, [open])
  const toggle = async (id, enabled) => {
    if (busy) return
    const next = enabled ? [...selected, id] : selected.filter(value => value !== id)
    setBusy(true)
    setError('')
    setOptimistic(next)
    try { await store.setManualAgents(conversationId, next) } catch (cause) { setError(cause.message || t('manualFailed')) } finally { setOptimistic(null); setBusy(false) }
  }
  return <div className="rp-team-manual" ref={rootRef}>
    <button ref={buttonRef} type="button" className={`rp-team-manual-button ${selected.length ? 'has-selection' : ''}`}
      aria-expanded={open} aria-haspopup="dialog" aria-controls={open ? popoverId : undefined}
      aria-label={t('manualButtonLabel', { n: selected.length })} onClick={() => setOpen(value => !value)}>
      {t('manualNextTurn')}{selected.length ? <span className="rp-team-count">{selected.length}</span> : null}
    </button>
    {open ? <div className="rp-team-popover" role="dialog" id={popoverId} aria-label={t('manualNextTurn')}>
      <p className="rp-team-popover-title">{t('manualTitle')}</p>
      <p className="rp-team-note">{t('manualHelp')}</p>
      <div className="rp-team-popover-list" aria-busy={busy || undefined}>
        {members.map(agent => <Check key={agent.id} label={agent.name} hint={agent.description} checked={selected.includes(agent.id)}
          onChange={enabled => void toggle(agent.id, enabled)} />)}
      </div>
      {error ? <p className="rp-team-error" role="alert">{error}</p> : null}
    </div> : null}
  </div>
}

/** One line beside the native turn/step counter. Cancellation stays neutral; failure links to its reason. */
export function TeamStatusLine({ sessionId }) {
  const { store } = services
  const conversationId = useProductConversation(sessionId)
  const snapshot = useConversation(conversationId)
  const active = isActivePhase(snapshot.status?.run?.phase)
  React.useEffect(() => {
    if (!conversationId) return
    if (active) return store.watchStatus(conversationId)
    void store.refreshStatus(conversationId)
  }, [conversationId, active])
  const status = conversationId ? composerStatus(snapshot) : null
  if (!status) return null
  if (status.tone === 'unavailable') {
    return <div className="rp-team-status tone-unavailable">
      <button type="button" className="rp-team-status-button" title={snapshot.statusError} onClick={() => openWorkspace(sessionId, conversationId, 'run')}>
        <span className="rp-team-status-dot" aria-hidden="true" /><span className="rp-team-status-text">{t('statusUnavailable')}</span>
      </button>
    </div>
  }
  const budgetFailure = snapshot.status?.run?.budget?.failure
  const phase = status.phase === 'failed' && budgetFailure
    ? t(budgetFailure.kind === 'usage_unavailable' ? 'budget.usageUnavailable' : 'budget.exhausted')
    : t(`status.${status.phase}`)
  return <div className={`rp-team-status tone-${status.tone}`} aria-live="polite">
    <button type="button" className="rp-team-status-button" aria-label={`${t('viewRun')}：${phase}`}
      onClick={() => openWorkspace(sessionId, conversationId, 'run', status.runId)}>
      <span className="rp-team-status-dot" aria-hidden="true" />
      <span className="rp-team-status-text">{t('team')}<span className="rp-team-sep" aria-hidden="true">·</span>{phase}
        {status.progress ? <span className="rp-team-status-progress" aria-hidden="true">{status.progress.done}/{status.progress.total}</span> : null}
      </span>
      {status.tone === 'failed' ? <span className="rp-team-status-link">{t('viewReason')}</span> : null}
    </button>
  </div>
}

/** Entry after an assistant reply, matched by product or native message id. */
export function MessageTraceLink({ sessionId, conversationId, productMessageId, messageId, role }) {
  const { store } = services
  const snapshot = useConversation(conversationId)
  const relevant = role === 'assistant' && Boolean(conversationId)
  React.useEffect(() => {
    if (!relevant) return
    if (snapshot.statusState === 'idle') void store.refreshStatus(conversationId)
    if (snapshot.tracesState === 'idle') void store.listTraces(conversationId).catch(() => {})
  }, [relevant, conversationId, snapshot.statusState, snapshot.tracesState])
  const run = relevant ? findMessageRun([snapshot.status?.run, ...snapshot.traces], productMessageId, messageId) : null
  if (!run) return null
  const count = runMembers(run).length
  return <button type="button" className="rp-team-message-result" onClick={() => openWorkspace(sessionId, conversationId, 'run', run.runId)}>
    <Icon name="trace" />
    <span>{t('viewCollaboration')}</span>
    {run.phase === 'awaiting_commit' ? <span className="rp-team-result-meta">{t('status.awaiting_commit')}</span> : null}
    {count > 0 ? <span className="rp-team-result-meta">{t('memberCount', { n: count })}</span> : null}
  </button>
}
