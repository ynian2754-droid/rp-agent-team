import { React } from './react.js'
import { t, eventLabel, formatTime, tOr } from './i18n.js'
import { services, openTrajectory, workspaceUi, useKeyed } from './client-state.js'
import {
  activationCause, compactNumber, eventCategory, eventFields, formatElapsed, idleReasons, isActivePhase, memberActivity, memberModel,
  participants, phaseTone, runHistory, runMembers, runTotals, selectRunId, tokenParts
} from './run-model.js'
import { causeText, forecast, idleReasonText } from './explain.js'
import { nameList } from './format.js'
import { stableContent } from './author-model.js'
import { Empty, Icon, Section, Sigil, StatusTag } from './fields.jsx'
import { useRunOperations } from './run-actions.jsx'

const MEMBER_TONE = { running: 'active', queued: 'queued', complete: 'done', completed: 'done', failed: 'failed', cancelled: 'cancelled', skipped: 'idle', pending: 'idle' }
const HIDDEN_EVENTS = new Set(['model.input', 'session.scope_installed', 'activation.native_completed', 'activation.slot_released', 'activation.slot_reacquired', 'activation.preserved', 'budget.request'])

/** The round overview: what happened, who took part and why, before any ledger detail. */
export function RunPage({ conversationId, snapshot, editor, onEnable, enableBusy }) {
  const { store } = services
  const ui = useKeyed(workspaceUi, conversationId)
  const live = snapshot.status?.run || null
  const history = React.useMemo(() => runHistory(live, snapshot.traces), [live, snapshot.traces])
  const runId = selectRunId(ui.runId, '', live, history)
  const detail = snapshot.details[runId]
  const [loadError, setLoadError] = React.useState('')
  const [reloads, setReloads] = React.useState(0)
  const liveStamp = live?.runId === runId ? `${live.phase}:${live.updatedAt}` : ''
  React.useEffect(() => {
    if (!runId) return
    let current = true
    setLoadError('')
    store.loadTrace(conversationId, runId).catch(cause => { if (current) setLoadError(cause.message || t('traceLoadFailed')) })
    return () => { current = false }
  }, [conversationId, runId, liveStamp, reloads])
  React.useEffect(() => {
    if (isActivePhase(live?.phase)) return store.watchStatus(conversationId)
  }, [conversationId, live?.phase])

  const savedConfig = snapshot.config
  if (!runId) {
    return <div className="rp-team-scroll"><div className="rp-team-page rp-team-run">
      {!snapshot.enabled ? <DisabledCard config={savedConfig} onEnable={onEnable} busy={enableBusy} /> : <Empty title={t('noRun')}>{t('noRunEnabled')}</Empty>}
      {snapshot.enabled ? <NextRound conversationId={conversationId} snapshot={snapshot} dirty={editor?.dirty} /> : null}
    </div></div>
  }

  const run = live?.runId === runId ? { ...history.find(item => item.runId === runId), ...detail, ...live } : { ...history.find(item => item.runId === runId), ...detail }
  const config = detail?.configuration || savedConfig
  const index = history.findIndex(item => item.runId === runId)
  const select = id => workspaceUi.update(conversationId, { runId: id === history[0]?.runId ? '' : id })
  // A run missing from history (its list failed to load) is only the latest when it is the live run.
  const latest = index === 0 || (index < 0 && live?.runId === runId)

  return <div className="rp-team-scroll"><div className="rp-team-page rp-team-run">
    {!snapshot.enabled && !isActivePhase(live?.phase) ? <DisabledCard config={savedConfig} onEnable={onEnable} busy={enableBusy} compact /> : null}
    <nav className="rp-team-run-switch" aria-label={t('runHistory')}>
      <button type="button" className="rp-team-icon-button" disabled={index < 0 || index >= history.length - 1} aria-label={t('run.older')} title={t('run.older')} onClick={() => select(history[index + 1].runId)}><Icon name="back" /></button>
      <span className="rp-team-run-switch-label">
        <strong>{run.turn ? t('turnN', { n: run.turn }) : t('run.round')}</strong>
        <time>{formatTime(run.startedAt || run.createdAt, true)}</time>
        {latest ? <span className="rp-team-chip">{t('latest')}</span> : null}
        {run.rewound ? <span className="rp-team-chip is-muted">{t('run.rewound')}</span> : null}
      </span>
      <button type="button" className="rp-team-icon-button" disabled={index <= 0} aria-label={t('run.newer')} title={t('run.newer')} onClick={() => select(history[index - 1].runId)}><Icon name="chevron" /></button>
    </nav>
    {loadError && !detail ? <p className="rp-team-callout is-error" role="alert">{t('traceLoadFailed')} {loadError}{' '}
      <button type="button" className="rp-team-link" onClick={() => setReloads(value => value + 1)}>{t('run.reload')}</button></p> : null}
    <RunBody conversationId={conversationId} run={run} config={config} events={detail?.events || []} loading={!detail && !loadError} executions={detail?.executionSessions || []} latest={latest} />
    {latest && snapshot.enabled && !isActivePhase(run.phase) ? <NextRound conversationId={conversationId} snapshot={snapshot} dirty={editor?.dirty} /> : null}
  </div></div>
}

function DisabledCard({ config, onEnable, busy, compact }) {
  return <div className={`rp-team-offcard ${compact ? 'is-compact' : ''}`}>
    <div>
      <h3>{t('shell.offTitle')}</h3>
      <p>{config ? t('shell.offHelp', { name: config.name, n: config.agents.length }) : t('loading')}</p>
    </div>
    <button type="button" className="rp-team-primary" disabled={!config || busy} aria-busy={busy || undefined} onClick={() => onEnable(true)}>{t('shell.enable')}</button>
  </div>
}

function RunBody({ conversationId, run, config, events, loading, executions, latest }) {
  const operations = useRunOperations(conversationId, run.runId, () => workspaceUi.update(conversationId, { runId: '' }))
  const [jumpError, setJumpError] = React.useState('')
  const tone = phaseTone(run.phase)
  const members = orderedMembers(run, config)
  const ran = participants(run)
  const totals = runTotals(run, events)
  const budgetFailure = run.budget?.failure
  const headline = run.phase ? (run.phase === 'failed' && budgetFailure
    ? t(budgetFailure.kind === 'usage_unavailable' ? 'budget.usageUnavailable' : 'budget.exhausted') : t(`status.${run.phase}`)) : t('phaseUnknown')
  const jump = recordId => {
    setJumpError('')
    try { openTrajectory(conversationId, run.runId, recordId) } catch (cause) { setJumpError(cause.message || t('run.jumpFailed')) }
  }
  // A history summary has no member records; until the run's detail loads, do not claim nobody took part.
  const membersKnown = Object.keys(run.members || {}).length > 0
  const facts = [
    members.length && membersKnown ? t('run.took', { n: ran.length, total: members.length }) : '',
    totals.requests ? t('run.requests', { n: totals.requests }) : '',
    totals.tokens ? `${compactNumber(totals.tokens)}${totals.tokensKnown ? '' : '+'} tok` : '',
    !isActivePhase(run.phase) && totals.elapsedMs !== null ? formatElapsed(totals.elapsedMs) : ''
  ].filter(Boolean)
  const stopped = run.phase === 'failed' || run.phase === 'cancelled'

  return <>
    <header className={`rp-team-run-head tone-${tone}`}>
      <div className="rp-team-run-title">
        <StatusTag tone={tone}>{headline}</StatusTag>
        <span className="rp-team-run-facts">{facts.map((fact, i) => <span key={i}>{fact}</span>)}</span>
      </div>
      {run.phase && t(`phaseHelp.${run.phase}`) && !stopped ? <p className="rp-team-run-explain">{t(`phaseHelp.${run.phase}`)}</p> : null}
      {stopped && run.failure ? <div className="rp-team-run-failure" role={run.phase === 'failed' ? 'alert' : undefined}>
        <span className="rp-team-eyebrow">{t(run.phase === 'failed' ? 'failureReason' : 'cancelDetails')}</span>
        <p>{run.failure}</p>
      </div> : null}
      {operations.canCancel || operations.targets.length || operations.error ? <div className="rp-team-run-actions">
        {operations.canCancel ? <button type="button" className="rp-team-quiet is-bordered" disabled={Boolean(operations.busy)} onClick={() => void operations.cancel()}>
          <Icon name="stop" />{operations.busy === 'cancel' ? t('cancelling') : t('cancel')}</button> : null}
        {operations.targets.length ? <button type="button" className="rp-team-primary" disabled={Boolean(operations.busy)} aria-busy={operations.busy === 'retry' || undefined}
          onClick={() => void operations.retry(operations.targets.map(member => member.id))}>
          <Icon name="retry" />{operations.busy === 'retry' ? t('retrying') : t(run.phase === 'cancelled' ? 'run.rerunMembers' : 'retryMembers', { n: operations.targets.length })}</button> : null}
        {operations.targets.length ? <p className="rp-team-note">{t(run.phase === 'cancelled' ? 'run.rerunHelp' : 'retryHelp')}</p> : null}
        {operations.error ? <p className="rp-team-error" role="alert">{operations.error}</p> : null}
      </div> : stopped && !run.rewound && (run.retryAvailable === false || !latest) ? <p className="rp-team-note">{
        run.retryBlockedReason ? tOr(`run.retryBlocked.${run.retryBlockedReason}`, t('retryUnavailable'))
          : t(run.retryAvailable === false ? 'retryUnavailable' : 'retryLatestOnly')}</p> : null}
    </header>

    <Section title={t('run.cast')} aside={loading ? <span className="rp-team-note">{t('loadingTrace')}</span> : null}>
      {!membersKnown && !isActivePhase(run.phase) ? <p className="rp-team-note">{t(loading ? 'loadingTrace' : 'run.membersUnavailable')}</p> : <ol className="rp-team-cast">
        {members.map(({ member, agent, index }) => <CastRow key={member.id} member={member} agent={agent} index={index} run={run} config={config} events={events}
          execution={executions.filter(item => item.agentId === member.id).at(-1)} retryable={operations.targets.some(target => target.id === member.id)}
          busy={Boolean(operations.busy)} onRetry={() => void operations.retry([member.id])} onJump={jump} />)}
      </ol>}
    </Section>

    {run.publication?.body ? <Publication run={run} config={config} /> : null}

    <div className="rp-team-run-foot">
      <button type="button" className="rp-team-quiet is-bordered" onClick={() => jump()}><Icon name="trace" />{t('run.openLedger')}</button>
      <span className="rp-team-note">{t('run.ledgerHelp')}</span>
      {jumpError ? <p className="rp-team-error" role="alert">{jumpError}</p> : null}
    </div>
  </>
}

/** Team order first, so a member keeps its place and mark; anything only the run knows about follows. */
function orderedMembers(run, config) {
  const byId = new Map(runMembers(run).map(member => [member.id, member]))
  const agents = config?.agents || []
  const rows = agents.map((agent, index) => ({ agent, index, member: byId.get(agent.id) || { id: agent.id, name: agent.name, status: 'pending' } }))
  for (const member of byId.values()) if (!agents.some(agent => agent.id === member.id)) rows.push({ agent: null, index: rows.length, member })
  return rows
}

function CastRow({ member, agent, index, run, config, events, execution, retryable, busy, onRetry, onJump }) {
  // The run record marks a member stopped by a cancel as failed; its execution session says it was cancelled.
  const status = member.status === 'failed' && execution?.status === 'cancelled' ? 'cancelled' : member.status || 'pending'
  const [open, setOpen] = React.useState(status === 'failed')
  const bodyId = React.useId()
  const tone = MEMBER_TONE[status] || 'idle'
  const ran = !['pending', 'skipped', 'queued'].includes(status)
  const settled = !isActivePhase(run.phase)
  const cause = ran || status === 'queued' ? activationCause(events, member.id) : null
  const activity = memberActivity(events, member.id)
  const model = memberModel(member)
  const total = member.tokens?.totalTokens
  const names = ids => nameList(config, ids, 2)
  const publisher = (run.outputAgentId || config?.output?.agentId) === member.id
  let line
  if (member.reusedFromRunId) line = [t('reusedResult')]
  else if (ran) line = [causeText(cause, config, agent), model, Number.isFinite(total) ? `${compactNumber(total)} tok` : '', activity.requests ? t('run.requests', { n: activity.requests }) : ''].filter(Boolean)
  else if (status === 'queued') line = [causeText(cause, config, agent), t('run.waiting')].filter(Boolean)
  else if (status === 'skipped') {
    // The scheduler records why it skipped a member; only "not triggered" is explained from the member's own triggers.
    const skipped = [...events].reverse().find(event => event.agentId === member.id && event.type === 'activation.skipped')
    const reason = skipped?.data?.reason
    line = [reason && reason !== 'not_triggered' ? tOr(`run.skip.${reason}`, t('run.skipped'))
      : agent ? idleReasons(agent).map(item => idleReasonText(item, config)).join(t('clauseSep')) || t('run.skipped') : t('run.skipped')]
  }
  // Still pending after a completed round (older records): it was not triggered, so explain it from its triggers.
  // Still pending after a failed or cancelled round: the round ended before the scheduler reached it.
  else if (settled && run.phase === 'complete') line = [agent ? idleReasons(agent).map(item => idleReasonText(item, config)).join(t('clauseSep')) : '']
  else line = [settled ? t('run.endedBeforeSchedule') : agent ? t('run.notYet') : '']
  const own = events.filter(event => event.agentId === member.id && !HIDDEN_EVENTS.has(event.type))
  const expandable = ran || own.length > 0 || Boolean(member.error)

  return <li className={`rp-team-cast-row tone-${tone} ${ran ? 'is-in' : 'is-out'} ${open ? 'is-open' : ''}`}>
    <button type="button" className="rp-team-cast-head" aria-expanded={expandable ? open : undefined} aria-controls={open ? bodyId : undefined}
      disabled={!expandable} onClick={() => setOpen(value => !value)}>
      <Sigil name={member.name} index={index} muted={!ran && status !== 'queued'} />
      <span className="rp-team-cast-name">{member.name || member.id}{publisher ? <span className="rp-team-tag">{t('roster.publisher')}</span> : null}</span>
      <StatusTag tone={tone}>{status === 'pending' && settled && run.phase !== 'complete' ? t('run.notReached') : t(`memberStatus.${status}`)}</StatusTag>
      <span className="rp-team-cast-line">{line.filter(Boolean).join(' · ')}</span>
      {status === 'failed' && member.error ? <span className="rp-team-cast-error">{member.error}</span> : null}
      {expandable ? <Icon name="chevron" className="rp-team-cast-chevron" /> : null}
    </button>
    {open ? <div className="rp-team-cast-body" id={bodyId}>
      {activity.asked.length || activity.told.length || activity.writes ? <div className="rp-team-chips">
        {activity.asked.length ? <span className="rp-team-chip">{t('run.asked', { names: names(activity.asked) })}</span> : null}
        {activity.told.length ? <span className="rp-team-chip">{t('run.told', { names: names(activity.told) })}</span> : null}
        {activity.writes ? <span className="rp-team-chip">{t('run.wrote', { n: activity.writes })}</span> : null}
      </div> : null}
      {member.result?.summary ? <p className="rp-team-cast-result">{member.result.summary}</p> : null}
      <dl className="rp-team-facts">
        {model ? <><dt>{t('modelUsed')}</dt><dd>{model}</dd></> : null}
        {tokenParts(member.tokens).length ? <><dt>{t('tokens')}</dt><dd>{tokenParts(member.tokens).map(part => `${t(`tokenKind.${part.key}`)} ${part.value}`).join(' · ')}</dd></> : null}
        {member.activations > 1 ? <><dt>{t('activations')}</dt><dd>{member.activations}</dd></> : null}
        {execution?.startedAt && execution?.endedAt ? <><dt>{t('run.elapsed')}</dt><dd>{formatElapsed(Date.parse(execution.endedAt) - Date.parse(execution.startedAt))}</dd></> : null}
      </dl>
      {own.length ? <details className="rp-team-events">
        <summary>{t('run.events', { n: own.length })}</summary>
        <ol>{own.map(event => <EventRow key={event.seq} event={event} config={config} />)}</ol>
      </details> : null}
      <div className="rp-team-button-row">
        {execution?.sessionId ? <button type="button" className="rp-team-quiet is-bordered" onClick={() => onJump(`${execution.sessionId}:execution`)}><Icon name="trace" />{t('run.openRequests')}</button> : null}
        {retryable ? <button type="button" className="rp-team-quiet is-bordered" disabled={busy} onClick={onRetry}><Icon name="retry" />{t(run.phase === 'cancelled' ? 'run.rerunThis' : 'retryThis')}</button> : null}
      </div>
    </div> : null}
  </li>
}

function EventRow({ event, config }) {
  const nameOf = id => config?.agents.find(agent => agent.id === id)?.name || id
  const fields = eventFields(event, { nameOf, sourceLabel: type => tOr(`sourceShort.${type}`, type) })
  const failed = /failed|blocked|cancelled/.test(event.type)
  return <li className={`is-${eventCategory(event.type)} ${failed ? 'is-failed' : ''}`}>
    <details>
      <summary><time>{formatTime(event.at)}</time><span>{eventLabel(event.type)}</span></summary>
      {fields.length ? <dl className="rp-team-facts">{fields.map(field => <React.Fragment key={field.key}>
        <dt>{tOr(`eventField.${field.key}`, field.key)}</dt>
        <dd className={field.code ? 'is-code' : field.long ? 'is-long' : ''}>{field.parts ? field.parts.map(part => `${t(`tokenKind.${part.key}`)} ${part.value}`).join(' · ') : field.value}</dd>
      </React.Fragment>)}</dl> : <p className="rp-team-note">{t('noEventData')}</p>}
    </details>
  </li>
}

function Publication({ run, config }) {
  const [open, setOpen] = React.useState(false)
  const body = run.publication.body
  const long = body.length > 260 || body.split('\n').length > 6
  const status = run.publication.status
  const label = status === 'committed' ? t('publishedReply') : status === 'rolled_back' ? t('rolledBackReply') : t('candidateReply')
  const author = config?.agents.find(agent => agent.id === run.publication.agentId)?.name
  return <Section title={label} aside={author ? <span className="rp-team-note">{t('publishedBy', { name: author })}</span> : null} className="rp-team-publication">
    <div className={`rp-team-publication-body ${long && !open ? 'is-clamped' : ''}`}>{body}</div>
    {long ? <button type="button" className="rp-team-link" onClick={() => setOpen(value => !value)}>{open ? t('collapse') : t('expand')}</button> : null}
  </Section>
}

const FORECAST_TONE = { run: 'next', request: 'idle', depends: 'queued', skip: 'idle', never: 'idle' }

/** Which members the saved configuration would start on the next message, and why the others wait. */
function NextRound({ conversationId, snapshot, dirty }) {
  const [state, setState] = React.useState({ preview: null, error: '' })
  const config = snapshot.config
  const manual = snapshot.status?.manualAgentIds || []
  const key = `${snapshot.revision}:${stableContent(manual)}:${snapshot.status?.run?.runId || ''}:${snapshot.status?.run?.phase || ''}`
  React.useEffect(() => {
    if (!config) return
    let current = true
    services.api.author('previewConfig', { conversationId, config, parameterValues: snapshot.parameterValues || {}, inputText: '', manualAgentIds: manual })
      .then(preview => { if (current) setState({ preview, error: '' }) }, cause => { if (current) setState({ preview: null, error: cause.message || String(cause) }) })
    return () => { current = false }
  }, [conversationId, key])
  if (!config) return null
  const preview = state.preview
  return <Section title={preview?.nextUserTurn ? t('next.titleTurn', { n: preview.nextUserTurn }) : t('next.title')} className="rp-team-next"
    hint={dirty ? t('next.basedOnSaved') : ''}>
    {state.error ? <p className="rp-team-note">{t('next.failed')}</p> : !preview ? <p className="rp-team-note">{t('next.loading')}</p>
      : <ul className="rp-team-forecast">
        {preview.members.map((member, index) => {
          const result = forecast(member, config)
          return <li key={member.id} className={`is-${result.kind}`}>
            <Sigil name={member.name} index={index} size="small" muted={result.kind !== 'run'} />
            <span className="rp-team-forecast-name">{member.name}</span>
            <StatusTag tone={FORECAST_TONE[result.kind]}>{t(`nextKind.${result.kind}`)}</StatusTag>
            <span className="rp-team-forecast-why">{result.lines.join(t('clauseSep')) || t('summary.neverRuns')}</span>
          </li>
        })}
      </ul>}
  </Section>
}
