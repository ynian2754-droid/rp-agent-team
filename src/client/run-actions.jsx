import { React } from './react.js'
import { services, useConversation, workspaceUi } from './client-state.js'
import { canRetry, isActivePhase, retryTargets } from './run-model.js'
import { Icon } from './fields.jsx'
import { t, tOr } from './i18n.js'

/**
 * Cancel and retry for one run. All mutations keep the existing retry intent /
 * regenerate / discard protocol; `onRetried` receives the run that replaced it.
 */
export function useRunOperations(conversationId, runId, onRetried) {
  const snapshot = useConversation(conversationId)
  const live = snapshot.status?.run
  const run = live?.runId === runId ? { ...snapshot.details[runId], ...live } : snapshot.details[runId]
  const [busy, setBusy] = React.useState('')
  const [error, setError] = React.useState('')
  const operate = async (kind, memberIds) => {
    if (busy) return
    setBusy(kind); setError('')
    try {
      if (kind === 'cancel') await services.store.cancel(conversationId, runId)
      else {
        await services.store.retry(conversationId, runId, memberIds)
        const status = await services.store.refreshStatus(conversationId)
        if (status?.run) await onRetried?.(status.run)
      }
    } catch (cause) {
      const detail = cause.code ? tOr(`run.retryError.${cause.code}`, cause.message) : cause.message
      setError(`${t(kind === 'cancel' ? 'cancelFailed' : 'retryFailed')}${t('colon')}${detail}${cause.discardError ? ` ${t('retryDiscardFailed')}` : ''}`)
    } finally { setBusy('') }
  }
  const usable = Boolean(run) && !run.rewound
  return {
    run, live, busy, error,
    canCancel: usable && live?.runId === runId && isActivePhase(run.phase),
    targets: usable && canRetry(run, live) ? retryTargets(run) : [],
    cancel: () => operate('cancel'),
    retry: memberIds => operate('retry', memberIds)
  }
}

/** Actions on a run's group heading inside the native ledger. */
export function RunActions({ conversationId, runId }) {
  const operations = useRunOperations(conversationId, runId, async run => {
    workspaceUi.update(conversationId, { runId: '' })
    await services.trajectoryNavigation.open(conversationId, { runId: run.runId })
  })
  const { targets, busy, error } = operations
  if (!operations.canCancel && !targets.length && !error) return null
  return <span className="rp-team-trajectory-actions">
    {operations.canCancel ? <button type="button" disabled={Boolean(busy)} onClick={() => void operations.cancel()}><Icon name="stop" />{busy === 'cancel' ? t('cancelling') : t('cancel')}</button> : null}
    {targets.length ? <>
      <button type="button" className="is-primary" disabled={Boolean(busy)} onClick={() => void operations.retry(targets.map(member => member.id))}>
        <Icon name="retry" />{busy === 'retry' ? t('retrying') : t(operations.run?.phase === 'cancelled' ? 'run.rerunMembers' : 'retryMembers', { n: targets.length })}
      </button>
      {targets.length > 1 ? <select aria-label={t('run.retryOne')} value="" disabled={Boolean(busy)} onChange={event => { if (event.target.value) void operations.retry([event.target.value]) }}>
        <option value="">{t('run.retryOne')}</option>{targets.map(member => <option key={member.id} value={member.id}>{member.name || member.id}</option>)}
      </select> : null}
    </> : null}
    {error ? <span role="alert" title={error}>{error}</span> : null}
  </span>
}
