import { React } from './react.js'
import { t } from './i18n.js'
import { useKeyed, services } from './client-state.js'
import { authorViews, authorCall, AuthorError, ValueView } from './author-pages.jsx'
import { Field, Check, ConfirmButton } from './fields.jsx'
import { comparePresets, stateChoices, stateKey, stableContent } from './author-model.js'
import { statePath } from './state-editor-model.js'

export function downloadPreset(value, name) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }))
  const link = document.createElement('a'); link.href = url; link.download = name; link.click()
  setTimeout(() => URL.revokeObjectURL(url), 0)
}

export function LibraryPage({ conversationId, editor, actions }) {
  const view = useKeyed(authorViews, conversationId)
  const file = React.useRef(null), componentFile = React.useRef(null)
  const prepareSeq = React.useRef(0)
  const update = changes => authorViews.update(conversationId, changes)
  const refresh = () => authorCall(conversationId, 'listPresets', {}, result => ({ library: result.presets })).catch(() => {})
  React.useEffect(() => { void refresh() }, [conversationId])
  const load = (id, version) => void authorCall(conversationId, 'getPreset', { id, ...(version ? { version } : {}) }, result => ({ librarySelected: result })).catch(() => {})
  const selected = view.librarySelected
  const versions = (view.library || []).find(item => item.id === selected?.id)?.versions || []
  const config = editor.draft
  const invalid = Object.values(editor.invalid).some(Boolean)
  const savingConfig = { ...config, name: view.libraryName ?? config.name, version: view.libraryVersion ?? config.version }
  const componentAgents = view.componentAgents || []
  const prepare = async (component, bindings = view.componentBindings || {}, freshId) => {
    const importId = freshId || view.componentImportId || crypto.randomUUID()
    const source = stableContent(editor.draft), seq = ++prepareSeq.current
    update({ component, componentImportId: importId, componentBindings: bindings })
    try { await authorCall(conversationId, 'prepareComponentImport', { config: editor.draft, component, importId, bindings }, result => seq === prepareSeq.current ? { componentPlan: result, componentSource: source } : {}) } catch {}
  }
  const componentStale = view.componentSource !== stableContent(config)
  const connectionAgents = [...config.agents, ...(view.component?.agents || []).flatMap(agent => view.componentPlan?.agentIdMap?.[agent.id] ? [{ ...agent, id: view.componentPlan.agentIdMap[agent.id] }] : [])]
  return <div className="rp-team-scroll"><div className="rp-team-page rp-team-author-page">
    <section className="rp-team-block"><h3>{t('author.libraryTitle')}</h3><p className="rp-team-note">{t('author.libraryHelp')}</p>
      <div className="rp-team-grid"><Field label={t('presetName')}><input value={savingConfig.name} onChange={event => update({ libraryName: event.target.value })} /></Field><Field label={t('author.newVersion')}><input value={savingConfig.version} onChange={event => update({ libraryVersion: event.target.value })} /></Field></div>
      <div className="rp-team-button-row"><button type="button" className="rp-team-primary" disabled={Boolean(view.busy) || invalid} onClick={() => void authorCall(conversationId, 'savePreset', { config: savingConfig }, result => ({ librarySelected: result })).then(refresh).catch(() => {})}>{t('author.saveToLibrary')}</button>
        <button type="button" className="rp-team-quiet is-bordered" onClick={() => file.current.click()}>{t('author.importToLibrary')}</button></div>
      <input type="file" ref={file} className="rp-team-file" accept=".json,application/json" onChange={async event => {
        const input = event.target.files?.[0]; event.target.value = ''
        if (!input) return
        try { const preset = JSON.parse(await input.text()); await authorCall(conversationId, 'importPreset', { preset }, result => ({ librarySelected: result })); await refresh() } catch (error) { update({ error: error.message }) }
      }} />
    </section><AuthorError view={view} />
    <section className="rp-team-block"><Field label={t('author.savedPresets')}><select value={selected?.id || ''} onChange={event => event.target.value && load(event.target.value)}><option value="">{t('choose')}</option>{(view.library || []).map(item => <option key={item.id} value={item.id}>{item.name} · {item.version}</option>)}</select></Field>
      {selected ? <>
        <p className="rp-team-note">{t('author.dependencyHelp')}</p>
        <Field label={t('author.savedVersion')}><select value={selected.version} onChange={event => load(selected.id, event.target.value)}>{versions.map(item => <option key={item.version} value={item.version}>{item.version}</option>)}</select></Field>
        <div className="rp-team-button-row"><ConfirmButton label={t('author.loadDraft')} confirmLabel={t('author.confirmLoad')} onConfirm={() => actions.applyConfig(selected.config, { code: 'imported', name: selected.config.name })} />
          <button type="button" className="rp-team-quiet is-bordered" disabled={Boolean(view.busy)} onClick={() => void authorCall(conversationId, 'copyPreset', { id: selected.id, version: selected.version }, result => ({ librarySelected: result })).then(refresh).catch(() => {})}>{t('author.copyPreset')}</button>
          <button type="button" className="rp-team-quiet" onClick={() => void authorCall(conversationId, 'exportPreset', { id: selected.id, version: selected.version }, () => ({})).then(result => downloadPreset(result.preset, `${selected.id}.rp-team.json`)).catch(() => {})}>{t('export')}</button>
          <ConfirmButton label={t('author.deleteLibrary')} confirmLabel={t('author.confirmDeleteLibrary')} onConfirm={() => void authorCall(conversationId, 'deletePreset', { id: selected.id }, () => ({ librarySelected: null })).then(refresh).catch(() => {})} />
        </div>
        <details className="rp-team-author-card"><summary>{t('author.compareDraft')}</summary><div className="rp-team-author-card-body">
          {comparePresets(selected.config, editor.draft).map((change, index) => <details key={index}><summary>{change.name} · {t(`author.change.${change.field}`)}</summary><Field label={t('author.savedValue')}><ValueView value={change.before} /></Field><Field label={t('author.draftValue')}><ValueView value={change.after} /></Field></details>)}
        </div></details>
      </> : null}
    </section>
    <section className="rp-team-block"><h3>{t('author.components')}</h3><p className="rp-team-note">{t('author.componentsHelp')}</p>
      <Field label={t('author.componentName')}><input value={view.componentName || ''} onChange={event => update({ componentName: event.target.value })} /></Field>
      {config.agents.map(agent => <Check key={agent.id} label={agent.name} checked={componentAgents.includes(agent.id)} onChange={enabled => update({ componentAgents: enabled ? [...componentAgents, agent.id] : componentAgents.filter(id => id !== agent.id) })} />)}
      <div className="rp-team-button-row"><button type="button" className="rp-team-quiet is-bordered" disabled={!componentAgents.length || invalid || Boolean(view.busy)} onClick={() => void authorCall(conversationId, 'exportComponent', { config, agentIds: componentAgents, name: view.componentName || config.name }, () => ({})).then(result => downloadPreset(result.component, 'rp-team.component.json')).catch(() => {})}>{t('author.exportComponent')}</button>
        <button type="button" className="rp-team-quiet is-bordered" onClick={() => componentFile.current.click()}>{t('author.importComponent')}</button></div>
      <input type="file" ref={componentFile} className="rp-team-file" accept=".json,application/json" onChange={async event => {
        const input = event.target.files?.[0]; event.target.value = ''
        if (!input) return
        try { const value = JSON.parse(await input.text()); await prepare(value.component || value, {}, crypto.randomUUID()) } catch (error) { update({ error: error.message }) }
      }} />
      {view.componentPlan ? <div className="rp-team-component-plan">
        <h4>{t('author.connectComponent')}</h4>
        {componentStale ? <p className="rp-team-callout is-warn">{t('author.componentStale')}</p> : null}
        <button type="button" className="rp-team-quiet is-bordered" disabled={Boolean(view.busy)} onClick={() => void prepare(view.component)}>{t('author.recheckComponent')}</button>
        {view.componentPlan.ports.map(port => <Field key={port.id} label={port.label || port.id} hint={port.kind}>
          <select disabled={Boolean(view.busy)} value={port.kind === 'state' ? (view.componentBindings?.states?.[port.id] === null ? '__none' : view.componentBindings?.states?.[port.id] ? stateKey(view.componentBindings.states[port.id]) : '') : view.componentBindings?.agents?.[port.id] === null ? '__none' : view.componentBindings?.agents?.[port.id] ?? ''} onChange={event => {
            if (!event.target.value) return
            const group = port.kind === 'state' ? 'states' : 'agents'
            const value = event.target.value === '__none' ? null : group === 'states' ? stateChoices(config.state.definitions).find(choice => stateKey(choice) === event.target.value) : event.target.value
            const bindings = { ...view.componentBindings, [group]: { ...view.componentBindings?.[group], [port.id]: value === null ? null : group === 'states' ? { namespace: value.namespace, path: value.path } : value } }
            void prepare(view.component, bindings)
          }}><option value="">{t('author.chooseConnection')}</option><option value="__none">{t('author.disconnect')}</option>
            {port.kind === 'state' ? stateChoices(config.state.definitions).map(choice => <option key={stateKey(choice)} value={stateKey(choice)}>{choice.label}</option>) : connectionAgents.filter(agent => port.kind !== 'publisher' || agent.outputAuthority.user).map(agent => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
            {port.kind === 'state' && view.componentBindings?.states?.[port.id] && !stateChoices(config.state.definitions).some(choice => stateKey(choice) === stateKey(view.componentBindings.states[port.id])) ? <option value={stateKey(view.componentBindings.states[port.id])}>{view.componentBindings.states[port.id].namespace} · {view.componentBindings.states[port.id].path}</option> : null}
          </select>
          {port.kind === 'state' ? <NewStateBinding {...{ port, view, update, prepare }} agents={connectionAgents} /> : null}
        </Field>)}
        <details open><summary>{t('author.mergeChanges')}</summary><ValueView value={view.componentPlan.changes} /></details>
        {[...(view.componentPlan.conflicts || []), ...(view.componentPlan.issues || [])].map((issue, index) => <p className="rp-team-callout is-warn" key={index}>{issue.message || issue.reason || stableContent(issue)}</p>)}
        <ConfirmButton label={t('author.mergeDraft')} confirmLabel={t('author.confirmMerge')} disabled={Boolean(view.busy) || invalid || componentStale || !view.componentPlan.config || Boolean(view.componentPlan.issues?.some(issue => issue.severity === 'error') || view.componentPlan.conflicts?.length)} onConfirm={() => { actions.applyConfig(view.componentPlan.config, { code: 'imported', name: view.component?.name || '' }); update({ componentPlan: null }) }} />
      </div> : null}
    </section>
  </div></div>
}

function NewStateBinding({ port, view, update, prepare, agents }) {
  const draft = view.componentNewStates?.[port.id] || { namespace: 'shared', name: '' }
  const change = changes => update({ componentNewStates: { ...view.componentNewStates, [port.id]: { ...draft, ...changes } } })
  const path = draft.path ?? (draft.name ? statePath(draft.namespace === 'world' ? ['variables', draft.name] : [draft.name]) : '')
  return <details><summary>{t('author.newStateLocation')}</summary>
    <Field label={t('stateForm.scope')}><select value={draft.namespace} onChange={event => change({ namespace: event.target.value, path: undefined })}>
      <option value="shared">{t('stateForm.shared')}</option><option value="world">{t('stateForm.world')}</option>
      {agents.map(agent => <option key={agent.id} value={`private:${agent.id}`}>{t('stateForm.private')} · {agent.name}</option>)}
    </select></Field>
    <Field label={t('stateForm.name')}><input value={draft.name || ''} onChange={event => change({ name: event.target.value, path: undefined })} /></Field>
    <details><summary>{t('author.addressAdvanced')}</summary><Field label={t('author.stateLocation')}><input value={path} onChange={event => change({ path: event.target.value })} /></Field></details>
    <button type="button" className="rp-team-quiet" disabled={!path || Boolean(view.busy)} onClick={() => void prepare(view.component, { ...view.componentBindings, states: { ...view.componentBindings?.states, [port.id]: { namespace: draft.namespace, path } } })}>{t('author.addPath')}</button>
  </details>
}
