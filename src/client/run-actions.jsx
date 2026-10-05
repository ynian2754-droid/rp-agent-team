import { React } from './react.js'
import { services, useConversation } from './client-state.js'
import { canRetry, isActivePhase, retryTargets } from './run-model.js'
import { t } from './i18n.js'

/** All mutations retain the existing retry intent / regenerate / discard protocol. */
export function RunActions({ conversationId, runId }) {
  const snapshot = useConversation(conversationId)
  const live = snapshot.status?.run
  const run = live?.runId === runId ? { ...snapshot.details[runId], ...live } : snapshot.details[runId]
  const [busy, setBusy] = React.useState('')
  const [error, setError] = React.useState('')
  const operate = async (kind, memberIds) => {
    setBusy(kind); setError('')
    try {
      if (kind === 'cancel') await services.store.cancel(conversationId, runId)
      else {
        await services.store.retry(conversationId, runId, memberIds)
        const status = await services.store.refreshStatus(conversationId)
        if (status?.run) await services.conversations.openTrajectory(conversationId, { runId: status.run.runId })
      }
    } catch (cause) { setError(`${cause.message}${cause.discardError ? ` ${t('retryDiscardFailed')}` : ''}`) }
    finally { setBusy('') }
  }
  if (!run || run.rewound) return null
  const targets = canRetry(run, live) ? retryTargets(run) : []
  return <span className="rp-team-trajectory-actions">
    {live?.runId === runId && isActivePhase(run.phase) ? <button type="button" disabled={Boolean(busy)} onClick={() => void operate('cancel')}>{t('cancel')}</button> : null}
    {targets.length ? <>
      <button type="button" disabled={Boolean(busy)} onClick={() => void operate('retry', targets.map(member => member.id))}>{t('retryMembers', { n: targets.length })}</button>
      <select aria-label="重试指定成员" value="" disabled={Boolean(busy)} onChange={event => { if (event.target.value) void operate('retry', [event.target.value]) }}>
        <option value="">重试成员…</option>{targets.map(member => <option key={member.id} value={member.id}>{member.name || member.id}</option>)}
      </select>
    </> : null}
    {error ? <span role="alert" title={error}>{error}</span> : null}
  </span>
}
