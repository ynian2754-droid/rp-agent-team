import { React } from './react.js'
import { services, useKeyed, trialViews, workspaceUi, TRIAL_VIEWS } from './client-state.js'
import { t, tOr } from './i18n.js'
import { Field, Check, More, ConfirmButton, Icon, Section, Segmented, StatusTag } from './fields.jsx'
import { CheckPanel, ValueView } from './author-pages.jsx'
import { BudgetFields, TASK_BUDGET, TURN_BUDGET } from './resource-settings.jsx'
import { TypedField } from './typed-field.jsx'
import { stateChoices, stateKey } from './author-model.js'
import { resolveAuthorParameters } from '../shared/author-parameters.mjs'
import { ParameterValue } from './parameter-editor.jsx'

const ACTIVE = new Set(['preparing', 'queued', 'running', 'cancelling', 'working'])
const STATUS_TONE = { preparing: 'active', queued: 'queued', running: 'active', working: 'active', cancelling: 'active', complete: 'done', completed: 'done', committed: 'done', passed: 'done',
  failed: 'failed', interrupted: 'failed', cancelled: 'cancelled' }
const statusLabel = status => tOr(`trialStatus.${status}`, status || '')
const download = (value, name) => {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }))
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = name; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 0)
}
const newScenario = () => ({ name: t('trial.new'), steps: [{ id: crypto.randomUUID(), inputText: '', assertions: [] }] })

/** Trying a team out: a free check of who would run, then real runs in an isolated space. */
export function TrialPage({ conversationId, editor, snapshot, actions }) {
  const ui = useKeyed(workspaceUi, conversationId)
  const view = TRIAL_VIEWS.includes(ui.trialView) ? ui.trialView : 'check'
  const options = [
    { id: 'check', label: t('trialNav.check'), title: t('author.previewHelp') },
    { id: 'trial', label: t('trialNav.trial'), title: t('trial.help') }
  ]
  return <div className="rp-team-teampage" data-view={view}>
    <div className="rp-team-subnav">
      <Segmented className="rp-team-pill" label={t('nav.trial')} value={view} options={options} onChange={next => workspaceUi.update(conversationId, { trialView: next })} />
      <span className="rp-team-subnav-note">{t(view === 'check' ? 'trialNav.checkNote' : 'trialNav.trialNote')}</span>
    </div>
    <div className="rp-team-teampage-body">
      {view === 'check' ? <CheckPanel conversationId={conversationId} editor={editor} snapshot={snapshot} />
        : <TrialPanel conversationId={conversationId} editor={editor} snapshot={snapshot} actions={actions} />}
    </div>
  </div>
}

function TrialPanel({ conversationId, editor, snapshot, actions }) {
  const view = useKeyed(trialViews, conversationId)
  const fileRef = React.useRef(null), request = React.useRef(0)
  const update = change => trialViews.update(conversationId, change)
  const scenario = view.scenario, job = view.job
  const busy = Boolean(view.busy), active = ACTIVE.has(job?.status)
  const call = async (method, payload, commit) => {
    update({ busy: method, error: '' })
    try { const result = await services.api.author(method, payload); update(current => ({ ...current, ...commit?.(result, current), busy: '' })); return result }
    catch (error) { update({ busy: '', error: error.message, ...(method === 'startTrial' && error.code?.startsWith('RP_TEAM_') ? { operationId: '', pendingStart: null } : {}) }); return null }
  }
  const refresh = async () => {
    const seq = ++request.current
    try {
      const [scenes, trials, library] = await Promise.all([
        services.api.author('listTrialScenarios', {}), services.api.author('listTrials', { conversationId }), services.api.author('listPresets', {})
      ])
      if (seq !== request.current) return
      update({ scenarios: scenes.scenarios || [], trials: trials.trials || [], presets: library.presets || [] })
      if (view.selectedId) { const selected = await services.api.author('getTrial', { trialId: view.selectedId }); if (seq === request.current) update({ job: selected.trial || selected }) }
    } catch (error) { if (seq === request.current) update({ error: error.message }) }
  }
  React.useEffect(() => { void refresh(); return () => { request.current++ } }, [conversationId, view.selectedId])
  React.useEffect(() => {
    if (!view.secondPresetId) return
    let mounted = true
    services.api.author('getPreset', { id: view.secondPresetId }).then(preset => {
      if (mounted) update({ secondConfig: preset.document?.config || preset.config || preset.preset?.config })
    }, error => { if (mounted) update({ error: error.message }) })
    return () => { mounted = false }
  }, [conversationId, view.secondPresetId])
  React.useEffect(() => {
    if (!view.selectedId || !active) return
    let mounted = true, timer
    const tick = async () => {
      try { const result = await services.api.author('getTrial', { trialId: view.selectedId }); if (mounted) update({ job: result.trial || result }) }
      catch (error) { if (mounted) update({ error: error.message }) }
      if (mounted) timer = setTimeout(tick, 1500)
    }
    timer = setTimeout(tick, 1500)
    return () => { mounted = false; clearTimeout(timer) }
  }, [conversationId, view.selectedId, active])
  const setScenario = change => update(current => ({ ...current, scenario: change(current.scenario) }))
  const step = (index, changes) => setScenario(scene => ({ ...scene, steps: scene.steps.map((item, i) => i === index ? { ...item, ...changes } : item) }))
  const start = async () => {
    if (view.operationId) return
    const operationId = crypto.randomUUID()
    try {
      resolveAuthorParameters(editor.draft, editor.parameterValues)
      let snapshotId = scenario.snapshotId
      if (!snapshotId) { const frozen = await call('freezeTrialSnapshot', { conversationId }); if (!frozen) return; snapshotId = frozen.snapshotId; setScenario(scene => ({ ...scene, snapshotId })) }
      const variants = [{ id: 'A', label: t('trial.draft'), config: editor.draft, parameterValues: editor.parameterValues || {} }]
      if (view.secondPresetId) {
        const config = view.secondConfig
        if (!config) throw new Error(t('trial.choose'))
        resolveAuthorParameters(config, view.secondParameterValues || {})
        variants.push({ id: 'B', label: config.name, config, parameterValues: view.secondParameterValues || {} })
      }
      const payload = { conversationId, operationId, scenario: { ...scenario, snapshotId }, variants, allowTrustedTools: view.trusted, budget: view.budget, turnBudget: view.turnBudget }; update({ operationId, pendingStart: payload })
      const result = await call('startTrial', payload, result => ({ selectedId: result.trialId, job: result.trial || result, operationId: '' }))
      if (result) { const full = await call('getTrial', { trialId: result.trialId }); if (full) update({ job: full.trial || full }); void refresh() }
      // A failed transport retains operationId; querying the task list resolves an unknown result.
    } catch (error) { update({ error: error.message }) }
  }
  const stateOptions = stateChoices(editor.draft.state.definitions)
  const setInvalid = (key, invalid) => update(current => ({ ...current, invalid: { ...current.invalid, [key]: invalid } }))
  const blockedReason = scenario.steps.some(item => !item.inputText.trim()) ? t('trial.needInput')
    : Object.values(editor.invalid).some(Boolean) ? t('author.fixDraft')
      : view.secondPresetId && !view.secondConfig ? t('trial.loadingB') : ''
  const cannotStart = busy || active || Boolean(view.operationId) || Boolean(blockedReason) || Object.values(view.invalid || {}).some(Boolean)
  const openTrajectory = (variantId, runId) => void call('getTrialTrajectory', { trialId: job.trialId, variantId, runId, limit: 50 }, result => ({ trajectory: result, trajectoryQuery: { trialId: job.trialId, variantId, runId } }))

  return <div className="rp-team-scroll"><div className="rp-team-page rp-team-trial">
    <Section title={<><span className="rp-team-step">1</span>{t('trial.scene')}</>}
      aside={<button type="button" className="rp-team-quiet is-bordered" onClick={() => fileRef.current?.click()}><Icon name="upload" />{t('trial.importScene')}</button>}>
      <input ref={fileRef} type="file" className="rp-team-file" accept=".json,application/json" onChange={async event => { const file = event.target.files[0]; event.target.value = ''; if (file) { try { await call('importTrialScenario', { export: JSON.parse(await file.text()) }, result => ({ scenario: result.scenario || result })); await refresh() } catch (error) { update({ error: error.message }) } } }} />
      <div className="rp-team-grid is-name">
        <Field label={t('trial.pick')}><select value={scenario.id || ''} onChange={event => { if (!event.target.value) update({ scenario: newScenario() }); else void call('getTrialScenario', { scenarioId: event.target.value }, result => ({ scenario: result.scenario || result })) }}><option value="">{t('trial.new')}</option>{view.scenarios.map(scene => <option key={scene.id} value={scene.id}>{scene.name}</option>)}</select></Field>
        <Field label={t('trial.name')}><input value={scenario.name} onChange={event => setScenario(scene => ({ ...scene, name: event.target.value }))} /></Field>
      </div>
      <ol className="rp-team-turns">
        {scenario.steps.map((item, index) => <li key={item.id || index}>
          <div className="rp-team-turn-head">
            <span className="rp-team-turn-no">{t('turnN', { n: index + 1 })}</span>
            <button type="button" className="rp-team-link" disabled={scenario.steps.length === 1} onClick={() => setScenario(scene => ({ ...scene, steps: scene.steps.filter((_, i) => i !== index) }))}>{t('remove')}</button>
          </div>
          <textarea rows={3} aria-label={`${t('turnN', { n: index + 1 })} ${t('trial.input')}`} placeholder={t('trial.input')} value={item.inputText} onChange={event => step(index, { inputText: event.target.value })} />
          <More summary={`${t('trial.checks')}${item.assertions?.length ? ` · ${item.assertions.length}` : ''}`} startOpen={Boolean(item.assertions?.length)}>
            <AssertionEditor assertions={item.assertions || []} stateOptions={stateOptions} onChange={assertions => step(index, { assertions })} bufferKey={`${conversationId}/trial/${item.id || index}`} onInvalid={setInvalid} />
          </More>
        </li>)}
      </ol>
      <div className="rp-team-button-row">
        <button type="button" className="rp-team-quiet is-bordered" onClick={() => setScenario(scene => ({ ...scene, steps: [...scene.steps, { id: crypto.randomUUID(), inputText: '', assertions: [] }] }))}><Icon name="plus" />{t('trial.addTurn')}</button>
        <button type="button" className="rp-team-quiet is-bordered" disabled={busy} onClick={() => void call('saveTrialScenario', { scenario }, result => ({ scenario: result.scenario || result })).then(refresh)}>{t('trial.saveScene')}</button>
      </div>
      <div className="rp-team-freeze">
        <button type="button" className="rp-team-quiet is-bordered" disabled={busy} onClick={() => void call('freezeTrialSnapshot', { conversationId }, (result, current) => ({ scenario: { ...current.scenario, snapshotId: result.snapshotId } }))}>{t('trial.freeze')}</button>
        {scenario.snapshotId ? <StatusTag tone="done">{t('trial.snapshotReady')}</StatusTag> : <span className="rp-team-note">{t('trial.freezeHelp')}</span>}
      </div>
      <More summary={t('trial.initial')}><InitialStateEditor scenario={scenario} choices={stateOptions} onChange={initialState => setScenario(scene => ({ ...scene, initialState }))} bufferKey={`${conversationId}/trial-initial`} onInvalid={setInvalid} /></More>
      <More summary={t('trial.sceneFile')}>
        <Check label={t('trial.includeSnapshot')} checked={view.includeSnapshot} onChange={includeSnapshot => update({ includeSnapshot })} />
        <div className="rp-team-button-row">
          <button type="button" className="rp-team-quiet is-bordered" disabled={busy || !scenario.id} onClick={() => void call('exportTrialScenario', { scenarioId: scenario.id, includeSnapshot: view.includeSnapshot }).then(result => { if (result) download(result.export || result, `${scenario.id}.rp-trial.json`) })}><Icon name="download" />{t('trial.exportScene')}</button>
          {scenario.id ? <ConfirmButton label={t('trial.deleteScene')} confirmLabel={t('trial.confirmDeleteScene')} disabled={busy} onConfirm={() => void call('deleteTrialScenario', { scenarioId: scenario.id }, () => ({ scenario: newScenario() })).then(refresh)} /> : <span className="rp-team-note">{t('trial.saveFirst')}</span>}
        </div>
      </More>
    </Section>

    <Section title={<><span className="rp-team-step">2</span>{t('trial.variants')}</>} hint={t('trial.scope')}>
      <div className="rp-team-variant-pick">
        <div className="rp-team-variant-slot"><span className="rp-team-variant-letter">A</span><div><strong>{editor.draft.name}</strong><span>{t('trial.draft')}{editor.dirty ? ` · ${t('shell.draft')}` : ''}</span></div></div>
        <div className="rp-team-variant-slot"><span className="rp-team-variant-letter is-b">B</span>
          <select aria-label={t('trial.second')} value={view.secondPresetId} onChange={event => update(current => ({ ...current, secondPresetId: event.target.value, secondConfig: null, secondParameterValues: {}, invalid: Object.fromEntries(Object.entries(current.invalid || {}).filter(([key]) => !key.startsWith('variant-B/'))) }))}>
            <option value="">{t('trial.noSecond')}</option>{view.presets.map(preset => <option key={preset.id} value={preset.id}>{preset.name}</option>)}</select>
        </div>
      </div>
      {!view.presets.length ? <p className="rp-team-note">{t('trial.secondHelp')}</p> : null}
      {view.secondConfig?.authorParameters?.length ? <More summary={`B · ${t('params.title')}`}>
        {view.secondConfig.authorParameters.map(parameter => <Field key={parameter.id} label={parameter.name} hint={parameter.description}>
          <ParameterValue parameter={parameter} value={Object.hasOwn(view.secondParameterValues || {}, parameter.id) ? view.secondParameterValues[parameter.id] : parameter.default}
            config={view.secondConfig} options={snapshot.options} bufferKey={`${conversationId}/variant-B/${view.secondPresetId}/${parameter.id}`}
            onInvalid={invalid => setInvalid(`variant-B/${parameter.id}`, invalid)}
            onChange={value => update(current => ({ ...current, secondParameterValues: { ...current.secondParameterValues, [parameter.id]: value } }))} />
        </Field>)}
      </More> : null}
      <More summary={t('trial.budgets')}>
        <BudgetFields title={t('budget.turn')} value={view.turnBudget} defaults={TURN_BUDGET} onChange={turnBudget => update({ turnBudget })} /><BudgetFields title={t('budget.task')} value={view.budget} defaults={TASK_BUDGET} onChange={budget => update({ budget })} />
        <Check label={t('trial.trust')} hint={t('trial.trustHelp')} checked={view.trusted} onChange={trusted => update({ trusted })} />
      </More>
      <div className="rp-team-launch">
        <button type="button" className="rp-team-primary is-large" disabled={cannotStart} onClick={() => void start()}>{t('trial.start')}</button>
        <p className="rp-team-note">{blockedReason || t('trial.range', { turns: scenario.steps.length, variants: view.secondPresetId ? 2 : 1, calls: view.budget.maxRequests || TASK_BUDGET.maxRequests, seconds: (view.budget.maxElapsedMs || TASK_BUDGET.maxElapsedMs) / 1000 })}</p>
      </div>
      {view.operationId ? <p className="rp-team-callout is-warn">{t('trial.pending')}<button type="button" className="rp-team-link" onClick={() => void call('listTrials', { conversationId }, result => { const found = result.trials.find(trial => trial.operationId === view.operationId); return found ? { selectedId: found.trialId, operationId: '', trials: result.trials } : { trials: result.trials } })}>{t('trial.refresh')}</button><button type="button" className="rp-team-link" disabled={busy} onClick={() => void call('startTrial', view.pendingStart, result => ({ selectedId: result.trialId, job: result.trial || result, operationId: '', pendingStart: null }))}>{t('trial.resubmit')}</button></p> : null}
    </Section>
    {view.error ? <p className="rp-team-callout is-error" role="alert">{view.error}</p> : null}

    <Section title={<><span className="rp-team-step">3</span>{t('trial.jobs')}</>} aside={<button type="button" className="rp-team-quiet" onClick={() => void refresh()}><Icon name="retry" />{t('trial.refresh')}</button>}>
      {!view.trials.length ? <p className="rp-team-note">{t('trial.noJobs')}</p>
        : <select aria-label={t('trial.jobs')} value={view.selectedId} onChange={event => update({ selectedId: event.target.value, trajectory: null, comparison: null })}><option value="">{t('trial.pickJob')}</option>{view.trials.map(trial => <option key={trial.trialId} value={trial.trialId}>{trial.scenarioName || trial.name || trial.scenario?.name || trial.trialId} · {statusLabel(trial.status)}</option>)}</select>}
      {job ? <>
        <div className="rp-team-job-head">
          <StatusTag tone={STATUS_TONE[job.status] || 'idle'}>{statusLabel(job.status)}</StatusTag>
          {job.failure ? <span className="rp-team-cast-error">{typeof job.failure === 'string' ? job.failure : job.failure.message}</span> : null}
          <span className="rp-team-button-row">
            {active ? <button type="button" className="rp-team-quiet is-danger is-bordered" disabled={busy} onClick={() => void call('cancelTrial', { trialId: job.trialId }, result => ({ job: result.trial || result }))}><Icon name="stop" />{t('trial.stop')}</button> : null}
            {['interrupted', 'failed', 'cancelled'].includes(job.status) ? <button type="button" className="rp-team-quiet is-bordered" disabled={busy} onClick={() => void call('retryTrial', { trialId: job.trialId, operationId: crypto.randomUUID() }, result => ({ job: result.trial || result }))}><Icon name="retry" />{t('trial.retry')}</button> : null}
            <button type="button" className="rp-team-quiet is-bordered" disabled={busy} onClick={() => void call('compareTrial', { trialId: job.trialId }, result => ({ comparison: result }))}>{t('trial.compare')}</button>
          </span>
        </div>
        {job.usage?.reportedTokensKnown === false ? <p className="rp-team-callout is-warn" role="status">{t('trial.usageUnknown')}</p> : null}
        <div className="rp-team-variants">
          {(job.variants || []).map((variant, order) => <article className="rp-team-variant" key={variant.id}>
            <header>
              <span className={`rp-team-variant-letter ${order ? 'is-b' : ''}`}>{variant.id}</span>
              <strong>{variant.label}</strong>
              {variant.status ? <StatusTag tone={STATUS_TONE[variant.status] || 'idle'}>{statusLabel(variant.status)}</StatusTag> : null}
            </header>
            {(variant.turns || []).map((turn, index) => <section className="rp-team-variant-turn" key={turn.runId || index}>
              <h5>{t('turnN', { n: index + 1 })}<StatusTag tone={STATUS_TONE[turn.status] || 'idle'}>{statusLabel(turn.status)}</StatusTag></h5>
              <ReplyText value={turn.body} />
              <div className="rp-team-button-row">
                <button type="button" className="rp-team-link" onClick={() => openTrajectory(variant.id, turn.runId)}>{t('trial.trajectory')}</button>
              </div>
              <More summary={t('trial.checks')}><ValueView value={turn.checks || turn.assertions} /></More>
              <More summary={t('trial.turnDetails')}><ValueView value={{ state: turn.state, usage: turn.usage, elapsedMs: turn.elapsedMs }} /></More>
            </section>)}
            {(variant.attempts || []).filter(attempt => !(variant.turns || []).some(turn => turn.runId === attempt.runId)).map(attempt => <section className="rp-team-variant-turn is-attempt" key={attempt.attemptId}>
              <h5>{t('turnN', { n: attempt.turn })}<StatusTag tone={STATUS_TONE[attempt.status] || 'idle'}>{statusLabel(attempt.status)}</StatusTag></h5>
              <p className="rp-team-note">{attempt.inputText}</p>{attempt.error ? <p className="rp-team-callout is-error">{attempt.error}</p> : null}
              <p className="rp-team-note">{t('trial.uncommitted')}</p>{attempt.trajectory?.available ? <button type="button" className="rp-team-link" onClick={() => openTrajectory(variant.id, attempt.trajectory.runId)}>{t('trial.trajectory')}</button> : null}
            </section>)}
            <footer>
              {/* Adopting replaces the draft; with unsaved edits it asks once more, like loading a preset. */}
              {editor.dirty ? <ConfirmButton className="is-bordered" label={t('trial.adopt')} confirmLabel={t('author.confirmLoad')} disabled={!variant.config}
                onConfirm={() => { actions.applyConfig(variant.config, '', variant.parameterValues); update({ error: '' }) }} />
                : <button type="button" className="rp-team-quiet is-bordered" disabled={!variant.config} onClick={() => { actions.applyConfig(variant.config, '', variant.parameterValues); update({ error: '' }) }}>{t('trial.adopt')}</button>}
              <span className="rp-team-note">{t('trial.adoptHelp')}</span>
            </footer>
          </article>)}
        </div>
        <p className="rp-team-note">{t('trial.source', { id: job.sourceConversationId || conversationId })}</p>
        <More summary={t('trial.details')}><ValueView value={job} /></More>
      </> : null}
      {view.comparison ? <Section title={t('trial.compare')} className="rp-team-comparison-section">
        <div className="rp-team-variants">{view.comparison.variants?.map((variant, order) => <article className="rp-team-variant" key={variant.variantId}>
          <header><span className={`rp-team-variant-letter ${order ? 'is-b' : ''}`}>{variant.variantId}</span><strong>{variant.label}</strong></header>
          {variant.turns.map(turn => <section className="rp-team-variant-turn" key={turn.turn}>
            <h5>{t('turnN', { n: turn.turn })}<StatusTag tone={STATUS_TONE[turn.status] || 'idle'}>{statusLabel(turn.status)}</StatusTag></h5><ReplyText value={turn.body} />
            <More summary={t('trial.turnDetails')}><ValueView value={{ state: turn.state, usage: turn.usage, elapsedMs: turn.elapsedMs, assertions: turn.assertions }} /></More>
          </section>)}
        </article>)}</div>
      </Section> : null}
    </Section>
    {view.trajectory?.snapshot || view.trajectory?.native ? <section className="rp-team-trial-trajectory">{services.trajectory.renderSnapshot({ ...view.trajectory, language: navigator.language, loadOlder: async () => { const result = await call('getTrialTrajectory', { ...view.trajectoryQuery, cursor: view.trajectory.cursor, limit: 50 }, result => ({ trajectory: result })); return Boolean(result?.hasMore) } })}</section> : null}
  </div></div>
}

/** A reply is prose to read and compare, so it gets a reading measure instead of a data tree. */
function ReplyText({ value }) {
  if (typeof value !== 'string') return <ValueView value={value} />
  return <div className="rp-team-reply">{value}</div>
}

function AssertionEditor({ assertions, stateOptions, onChange, bufferKey, onInvalid }) {
  const edit = (index, patch) => onChange(assertions.map((item, i) => i === index ? { ...item, ...patch } : item))
  return <div className="rp-team-assertions">{assertions.map((assertion, index) => <div className="rp-team-assertion" key={index}>
    <Field label={t('trial.checkType')}><select value={assertion.type} onChange={event => edit(index, { type: event.target.value })}>{['body_contains', 'body_not_contains', 'single_output', 'state_equals'].map(type => <option key={type} value={type}>{t(`trial.assertions.${type}`)}</option>)}</select></Field>
    {assertion.type.startsWith('body_') ? <Field label={t('trial.text')}><input value={assertion.text || ''} onChange={event => edit(index, { text: event.target.value })} /></Field> : assertion.type === 'state_equals' ? <><StateChoice value={assertion} choices={stateOptions} onChange={row => edit(index, row)} /><Field label={t('trial.expected')}><TypedField value={assertion.value ?? null} bufferKey={`${bufferKey}/assertion/${index}`} onChange={value => edit(index, { value })} onInvalid={invalid => onInvalid(`${bufferKey}/assertion/${index}`, invalid)} /></Field></> : null}
    <button type="button" className="rp-team-link" onClick={() => { onChange(assertions.filter((_, i) => i !== index)); onInvalid(`${bufferKey}/assertion/${index}`, false) }}>{t('remove')}</button>
  </div>)}<button type="button" className="rp-team-quiet is-bordered" onClick={() => onChange([...assertions, { type: 'single_output' }])}><Icon name="plus" />{t('trial.addCheck')}</button></div>
}
function StateChoice({ choices, value, onChange }) {
  return <Field label={t('memory.location')}><select value={stateKey(value)} onChange={event => { const row = choices.find(row => stateKey(row) === event.target.value); if (row) onChange({ namespace: row.namespace, path: row.path }) }}><option value="">{t('choose')}</option>{choices.map(row => <option key={stateKey(row)} value={stateKey(row)}>{row.label}</option>)}</select></Field>
}
function InitialStateEditor({ scenario, choices, onChange, bufferKey, onInvalid }) {
  const rows = scenario.initialState || []
  return <div className="rp-team-assertions">{rows.map((row, index) => <div className="rp-team-assertion" key={index}><StateChoice choices={choices} value={row} onChange={patch => onChange(rows.map((item, i) => i === index ? { ...item, ...patch } : item))} /><TypedField value={row.value} bufferKey={`${bufferKey}/${index}`} onInvalid={invalid => onInvalid(`${bufferKey}/${index}`, invalid)} onChange={value => onChange(rows.map((item, i) => i === index ? { ...item, value } : item))} /><button type="button" className="rp-team-link" onClick={() => { onChange(rows.filter((_, i) => i !== index)); onInvalid(`${bufferKey}/${index}`, false) }}>{t('remove')}</button></div>)}<button type="button" className="rp-team-quiet is-bordered" disabled={!choices.length} onClick={() => onChange([...rows, { namespace: choices[0].namespace, path: choices[0].path, value: null }])}><Icon name="plus" />{t('author.addPath')}</button></div>
}
