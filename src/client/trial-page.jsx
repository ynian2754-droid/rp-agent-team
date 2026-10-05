import { React } from './react.js'
import { services, useKeyed, trialViews, useConversation } from './client-state.js'
import { t } from './i18n.js'
import { Field, Check, More, ConfirmButton } from './fields.jsx'
import { ValueView } from './author-pages.jsx'
import { BudgetFields, TASK_BUDGET, TURN_BUDGET } from './resource-settings.jsx'
import { TypedField } from './typed-field.jsx'
import { stateChoices, stateKey } from './author-model.js'
import { resolveAuthorParameters } from '../shared/author-parameters.mjs'
import { ParameterValue } from './parameter-editor.jsx'

const ACTIVE = new Set(['preparing', 'queued', 'running', 'cancelling', 'working'])
const download = (value, name) => {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }))
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = name; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 0)
}

export function TrialPage({ conversationId, editor, actions }) {
  const view = useKeyed(trialViews, conversationId)
  const conversation = useConversation(conversationId)
  const fileRef = React.useRef(null), request = React.useRef(0)
  const update = change => trialViews.update(conversationId, change)
  const scenario = view.scenario, job = view.job
  const busy = Boolean(view.busy), active = ACTIVE.has(job?.status)
  const call = async (method, payload, commit) => {
    update({ busy: method, error: '' })
    try { const result = await services.api.author(method, payload); update(current => ({ ...current, ...commit?.(result), busy: '' })); return result }
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
  return <div className="rp-team-scroll"><div className="rp-team-page rp-team-author-page">
    <section className="rp-team-block"><h3>{t('trial.title')}</h3><p className="rp-team-note">{t('trial.help')}</p>
      <Field label={t('trial.scene')}><select value={scenario.id || ''} onChange={event => { if (!event.target.value) update({ scenario: { name: t('trial.new'), steps: [{ id: crypto.randomUUID(), inputText: '', assertions: [] }] } }); else void call('getTrialScenario', { scenarioId: event.target.value }, result => ({ scenario: result.scenario || result })) }}><option value="">{t('trial.new')}</option>{view.scenarios.map(scene => <option key={scene.id} value={scene.id}>{scene.name}</option>)}</select></Field>
      <Field label={t('trial.name')}><input value={scenario.name} onChange={event => setScenario(scene => ({ ...scene, name: event.target.value }))} /></Field>
      {scenario.steps.map((item, index) => <details className="rp-team-author-card" key={item.id || index} open>
        <summary>{t('turnN', { n: index + 1 })}</summary><div className="rp-team-author-card-body">
          <Field label={t('trial.input')}><textarea rows={3} value={item.inputText} onChange={event => step(index, { inputText: event.target.value })} /></Field>
          <AssertionEditor assertions={item.assertions || []} stateOptions={stateOptions} onChange={assertions => step(index, { assertions })} bufferKey={`${conversationId}/trial/${item.id || index}`} onInvalid={(key, invalid) => update(current => ({ ...current, invalid: { ...current.invalid, [key]: invalid } }))} />
          <button type="button" className="rp-team-quiet" disabled={scenario.steps.length === 1} onClick={() => setScenario(scene => ({ ...scene, steps: scene.steps.filter((_, i) => i !== index) }))}>{t('remove')}</button>
        </div>
      </details>)}
      <button type="button" className="rp-team-quiet is-bordered" onClick={() => setScenario(scene => ({ ...scene, steps: [...scene.steps, { id: crypto.randomUUID(), inputText: '', assertions: [] }] }))}>{t('trial.addTurn')}</button>
      <More summary={t('trial.initial')}><InitialStateEditor scenario={scenario} choices={stateOptions} onChange={initialState => setScenario(scene => ({ ...scene, initialState }))} bufferKey={`${conversationId}/trial-initial`} onInvalid={(key, invalid) => update(current => ({ ...current, invalid: { ...current.invalid, [key]: invalid } }))} /></More>
      <div className="rp-team-button-row"><button type="button" className="rp-team-quiet is-bordered" disabled={busy} onClick={() => void call('freezeTrialSnapshot', { conversationId }, result => ({ scenario: { ...scenario, snapshotId: result.snapshotId } }))}>{t('trial.freeze')}</button><button type="button" className="rp-team-quiet is-bordered" disabled={busy} onClick={() => void call('saveTrialScenario', { scenario }, result => ({ scenario: result.scenario || result })).then(refresh)}>{t('trial.saveScene')}</button></div>
      {scenario.snapshotId ? <p className="rp-team-note">{t('trial.snapshotReady')}</p> : null}
      <More summary={t('presetFiles')}><Check label={t('trial.includeSnapshot')} checked={view.includeSnapshot} onChange={includeSnapshot => update({ includeSnapshot })} /><div className="rp-team-button-row"><button type="button" className="rp-team-quiet" disabled={busy || !scenario.id} onClick={() => void call('exportTrialScenario', { scenarioId: scenario.id, includeSnapshot: view.includeSnapshot }).then(result => { if (result) download(result.export || result, `${scenario.id}.rp-trial.json`) })}>{t('trial.exportScene')}</button><button type="button" className="rp-team-quiet" onClick={() => fileRef.current?.click()}>{t('trial.importScene')}</button>{scenario.id ? <ConfirmButton label={t('trial.deleteScene')} confirmLabel={t('trial.confirmDeleteScene')} disabled={busy} onConfirm={() => void call('deleteTrialScenario', { scenarioId: scenario.id }, () => ({ scenario: { name: t('trial.new'), steps: [{ id: crypto.randomUUID(), inputText: '', assertions: [] }] } })).then(refresh)} /> : null}</div><input ref={fileRef} type="file" className="rp-team-file" accept=".json,application/json" onChange={async event => { const file = event.target.files[0]; event.target.value = ''; if (file) { try { await call('importTrialScenario', { export: JSON.parse(await file.text()) }, result => ({ scenario: result.scenario || result })); await refresh() } catch (error) { update({ error: error.message }) } } }} /></More>
    </section>
    <section className="rp-team-block"><h3>{t('trial.variants')}</h3><p className="rp-team-note">{t('trial.scope')}</p><p>{editor.draft.name} · {t('trial.draft')}</p>
      <Field label={t('trial.second')}><select value={view.secondPresetId} onChange={event => update(current => ({ ...current, secondPresetId: event.target.value, secondConfig: null, secondParameterValues: {}, invalid: Object.fromEntries(Object.entries(current.invalid || {}).filter(([key]) => !key.startsWith('variant-B/'))) }))}><option value="">{t('none')}</option>{view.presets.map(preset => <option key={preset.id} value={preset.id}>{preset.name}</option>)}</select></Field>
      {view.secondConfig?.authorParameters?.length ? <fieldset className="rp-team-group"><legend>B · {t('params.title')}</legend>
        {view.secondConfig.authorParameters.map(parameter => <Field key={parameter.id} label={parameter.name} hint={parameter.description}>
          <ParameterValue parameter={parameter} value={Object.hasOwn(view.secondParameterValues || {}, parameter.id) ? view.secondParameterValues[parameter.id] : parameter.default}
            config={view.secondConfig} options={conversation.options} bufferKey={`${conversationId}/variant-B/${view.secondPresetId}/${parameter.id}`}
            onInvalid={invalid => update(current => ({ ...current, invalid: { ...current.invalid, [`variant-B/${parameter.id}`]: invalid } }))}
            onChange={value => update(current => ({ ...current, secondParameterValues: { ...current.secondParameterValues, [parameter.id]: value } }))} />
        </Field>)}
      </fieldset> : null}
      <BudgetFields title={t('budget.turn')} value={view.turnBudget} defaults={TURN_BUDGET} onChange={turnBudget => update({ turnBudget })} /><BudgetFields title={t('budget.task')} value={view.budget} defaults={TASK_BUDGET} onChange={budget => update({ budget })} />
      <Check label={t('trial.trust')} hint={t('trial.trustHelp')} checked={view.trusted} onChange={trusted => update({ trusted })} />
      <p className="rp-team-note">{t('trial.range', { turns: scenario.steps.length, variants: view.secondPresetId ? 2 : 1, calls: view.budget.maxRequests || TASK_BUDGET.maxRequests, seconds: (view.budget.maxElapsedMs || TASK_BUDGET.maxElapsedMs) / 1000 })}</p>
      <button type="button" className="rp-team-primary" disabled={busy || active || Boolean(view.operationId) || Boolean(view.secondPresetId && !view.secondConfig) || Object.values(editor.invalid).some(Boolean) || Object.values(view.invalid || {}).some(Boolean) || scenario.steps.some(step => !step.inputText.trim())} onClick={() => void start()}>{t('trial.start')}</button>
      {view.operationId ? <p className="rp-team-callout is-warn">{t('trial.pending')}<button type="button" className="rp-team-link" onClick={() => void call('listTrials', { conversationId }, result => { const found = result.trials.find(trial => trial.operationId === view.operationId); return found ? { selectedId: found.trialId, operationId: '', trials: result.trials } : { trials: result.trials } })}>{t('trial.refresh')}</button><button type="button" className="rp-team-link" disabled={busy} onClick={() => void call('startTrial', view.pendingStart, result => ({ selectedId: result.trialId, job: result.trial || result, operationId: '', pendingStart: null }))}>{t('trial.resubmit')}</button></p> : null}
    </section>
    {view.error ? <p className="rp-team-callout is-error" role="alert">{view.error}</p> : null}
    <section className="rp-team-block"><div className="rp-team-state-section-head"><h3>{t('trial.jobs')}</h3><button type="button" className="rp-team-quiet" onClick={() => void refresh()}>{t('trial.refresh')}</button></div>
      <Field label={t('trial.jobs')}><select value={view.selectedId} onChange={event => update({ selectedId: event.target.value, trajectory: null })}><option value="">{t('choose')}</option>{view.trials.map(trial => <option key={trial.trialId} value={trial.trialId}>{trial.scenarioName || trial.name || trial.scenario?.name || trial.trialId} · {trial.status}</option>)}</select></Field>
      {!view.trials.length ? <p className="rp-team-note">{t('trial.noJobs')}</p> : null}
      {job ? <><p className="rp-team-note">{t('trial.source', { id: job.sourceConversationId || conversationId })}</p><p role="status">{job.status}{job.failure ? ` · ${typeof job.failure === 'string' ? job.failure : job.failure.message}` : ''}</p>{job.usage?.reportedTokensKnown === false ? <p className="rp-team-callout is-warn" role="status">{t('trial.usageUnknown')}</p> : null}<div className="rp-team-button-row">
        {active ? <button type="button" className="rp-team-quiet is-danger" disabled={busy} onClick={() => void call('cancelTrial', { trialId: job.trialId }, result => ({ job: result.trial || result }))}>{t('trial.stop')}</button> : null}
        {['interrupted', 'failed', 'cancelled'].includes(job.status) ? <button type="button" className="rp-team-quiet is-bordered" disabled={busy} onClick={() => void call('retryTrial', { trialId: job.trialId, operationId: crypto.randomUUID() }, result => ({ job: result.trial || result }))}>{t('trial.retry')}</button> : null}
        <button type="button" className="rp-team-quiet is-bordered" disabled={busy} onClick={() => void call('compareTrial', { trialId: job.trialId }, result => ({ comparison: result }))}>{t('trial.compare')}</button>
      </div>
      {(job.variants || []).map(variant => <details className="rp-team-author-card" key={variant.id} open><summary>{variant.label} · {variant.status || ''}</summary><div className="rp-team-author-card-body">
        <p className="rp-team-note">{t('trial.adoptHelp')}</p><button type="button" className="rp-team-quiet is-bordered" disabled={!variant.config} onClick={() => { actions.applyConfig(variant.config, '', variant.parameterValues); update({ error: '' }) }}>{t('trial.adopt')}</button>
        {(variant.turns || []).map((turn, index) => <details key={turn.runId || index} open><summary>{t('turnN', { n: index + 1 })} · {turn.status}</summary><ValueView value={turn.body} /><More summary={t('trial.checks')}><ValueView value={turn.checks || turn.assertions} /></More><More summary={t('trial.details')}><ValueView value={{ state: turn.state, usage: turn.usage, elapsedMs: turn.elapsedMs }} /></More><button type="button" className="rp-team-link" onClick={() => void call('getTrialTrajectory', { trialId: job.trialId, variantId: variant.id, runId: turn.runId, limit: 50 }, result => ({ trajectory: result, trajectoryQuery: { trialId: job.trialId, variantId: variant.id, runId: turn.runId } }))}>{t('trial.trajectory')}</button></details>)}
        {(variant.attempts || []).filter(attempt => !(variant.turns || []).some(turn => turn.runId === attempt.runId)).map(attempt => <details key={attempt.attemptId} open><summary>{t('turnN', { n: attempt.turn })} · {attempt.status}</summary>
          <p className="rp-team-note">{attempt.inputText}</p>{attempt.error ? <p className="rp-team-callout is-error">{attempt.error}</p> : null}
          <p className="rp-team-note">{t('trial.uncommitted')}</p>{attempt.trajectory?.available ? <button type="button" className="rp-team-link" onClick={() => void call('getTrialTrajectory', { trialId: job.trialId, variantId: variant.id, runId: attempt.trajectory.runId, limit: 50 }, result => ({ trajectory: result, trajectoryQuery: { trialId: job.trialId, variantId: variant.id, runId: attempt.trajectory.runId } }))}>{t('trial.trajectory')}</button> : null}
        </details>)}
      </div></details>)}<More summary={t('trial.details')}><ValueView value={job} /></More></> : null}
      {view.comparison ? <section className="rp-team-block"><h3>{t('trial.compare')}</h3>
        <div className="rp-team-comparison">{view.comparison.variants?.map(variant => <article key={variant.variantId}>
          <h4>{variant.label}</h4>{variant.turns.map(turn => <section key={turn.turn}>
            <h5>{t('turnN', { n: turn.turn })} · {turn.status}</h5><ValueView value={turn.body} />
            <More summary={t('trial.details')}><ValueView value={{ state: turn.state, usage: turn.usage, elapsedMs: turn.elapsedMs, assertions: turn.assertions }} /></More>
          </section>)}
        </article>)}</div>
      </section> : null}
    </section>
    {view.trajectory?.snapshot || view.trajectory?.native ? <section className="rp-team-trial-trajectory">{services.trajectory.renderSnapshot({ ...view.trajectory, language: navigator.language, loadOlder: async () => { const result = await call('getTrialTrajectory', { ...view.trajectoryQuery, cursor: view.trajectory.cursor, limit: 50 }, result => ({ trajectory: result })); return Boolean(result?.hasMore) } })}</section> : null}
  </div></div>
}

function AssertionEditor({ assertions, stateOptions, onChange, bufferKey, onInvalid }) {
  const edit = (index, patch) => onChange(assertions.map((item, i) => i === index ? { ...item, ...patch } : item))
  return <fieldset className="rp-team-group"><legend>{t('trial.checks')}</legend>{assertions.map((assertion, index) => <div className="rp-team-author-card-body" key={index}>
    <Field label={t('trial.checkType')}><select value={assertion.type} onChange={event => edit(index, { type: event.target.value })}>{['body_contains', 'body_not_contains', 'single_output', 'state_equals'].map(type => <option key={type} value={type}>{t(`trial.assertions.${type}`)}</option>)}</select></Field>
    {assertion.type.startsWith('body_') ? <Field label={t('trial.text')}><input value={assertion.text || ''} onChange={event => edit(index, { text: event.target.value })} /></Field> : assertion.type === 'state_equals' ? <><StateChoice value={assertion} choices={stateOptions} onChange={row => edit(index, row)} /><Field label={t('trial.expected')}><TypedField value={assertion.value ?? null} bufferKey={`${bufferKey}/assertion/${index}`} onChange={value => edit(index, { value })} onInvalid={invalid => onInvalid(`${bufferKey}/assertion/${index}`, invalid)} /></Field></> : null}
    <button type="button" className="rp-team-quiet" onClick={() => { onChange(assertions.filter((_, i) => i !== index)); onInvalid(`${bufferKey}/assertion/${index}`, false) }}>{t('remove')}</button>
  </div>)}<button type="button" className="rp-team-quiet" onClick={() => onChange([...assertions, { type: 'single_output' }])}>{t('trial.addCheck')}</button></fieldset>
}
function StateChoice({ choices, value, onChange }) {
  return <Field label={t('memory.location')}><select value={stateKey(value)} onChange={event => { const row = choices.find(row => stateKey(row) === event.target.value); if (row) onChange({ namespace: row.namespace, path: row.path }) }}><option value="">{t('choose')}</option>{choices.map(row => <option key={stateKey(row)} value={stateKey(row)}>{row.label}</option>)}</select></Field>
}
function InitialStateEditor({ scenario, choices, onChange, bufferKey, onInvalid }) {
  const rows = scenario.initialState || []
  return <>{rows.map((row, index) => <div className="rp-team-author-card-body" key={index}><StateChoice choices={choices} value={row} onChange={patch => onChange(rows.map((item, i) => i === index ? { ...item, ...patch } : item))} /><TypedField value={row.value} bufferKey={`${bufferKey}/${index}`} onInvalid={invalid => onInvalid(`${bufferKey}/${index}`, invalid)} onChange={value => onChange(rows.map((item, i) => i === index ? { ...item, value } : item))} /><button type="button" className="rp-team-quiet" onClick={() => { onChange(rows.filter((_, i) => i !== index)); onInvalid(`${bufferKey}/${index}`, false) }}>{t('remove')}</button></div>)}<button type="button" className="rp-team-quiet" disabled={!choices.length} onClick={() => onChange([...rows, { namespace: choices[0].namespace, path: choices[0].path, value: null }])}>{t('author.addPath')}</button></>
}

