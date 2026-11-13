import { React } from './react.js'
import { t } from './i18n.js'
import { examplePresets } from '../shared/schema.mjs'
import { authoringExamples } from '../shared/author-examples.mjs'
import { useKeyed } from './client-state.js'
import { authorViews, authorCall, AuthorError, ValueView } from './author-pages.jsx'
import { Field, Check, ConfirmButton, Icon, More, Section } from './fields.jsx'
import { comparePresets, stateChoices, stateKey, stableContent } from './author-model.js'
import { statePath } from './state-editor-model.js'

export function downloadPreset(value, name) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }))
  const link = document.createElement('a'); link.href = url; link.download = name; link.click()
  setTimeout(() => URL.revokeObjectURL(url), 0)
}

/** Everything that brings a team in or takes it out: files, examples, the local library and member components. */
export function PresetsPage({ conversationId, editor, snapshot, actions }) {
  const view = useKeyed(authorViews, conversationId)
  const draftFile = React.useRef(null), libraryFile = React.useRef(null)
  const [pending, setPending] = React.useState(null)
  const update = changes => authorViews.update(conversationId, changes)
  const refresh = () => authorCall(conversationId, 'listPresets', {}, result => ({ library: result.presets })).catch(() => {})
  React.useEffect(() => { void refresh() }, [conversationId])
  const load = (id, version) => void authorCall(conversationId, 'getPreset', { id, ...(version ? { version } : {}) }, result => ({ librarySelected: result })).catch(() => {})
  const selected = view.librarySelected
  const library = view.library || []
  const config = editor.draft
  const invalid = Object.values(editor.invalid).some(Boolean)
  const savingConfig = { ...config, name: view.libraryName ?? config.name, version: view.libraryVersion ?? config.version }
  const examples = React.useMemo(() => [...examplePresets(), ...authoringExamples()], [])
  // Replacing an edited draft asks first; an unedited draft can always be restored from the saved copy.
  const offer = (next, notice) => editor.dirty ? setPending({ config: next, notice }) : actions.applyConfig(next, notice)
  const inUse = snapshot.config

  return <div className="rp-team-scroll"><div className="rp-team-page rp-team-presets">
    <Section title={t('presets.current')} hint={t('presetFilesHelp')}>
      <div className="rp-team-card rp-team-preset-current">
        <div className="rp-team-preset-id">
          <strong>{config.name}</strong>
          <span>{t('shell.versionLine', { version: config.version, n: config.agents.length })}{editor.dirty ? ` · ${t('shell.draft')}` : ''}</span>
          {inUse && editor.dirty && inUse.id !== config.id ? <span>{t('shell.liveIs', { name: inUse.name })}</span> : null}
        </div>
        <div className="rp-team-button-row">
          <button type="button" className="rp-team-quiet is-bordered" onClick={() => void actions.exportFile()}><Icon name="download" />{editor.dirty ? t('exportDraft') : t('export')}</button>
          <button type="button" className="rp-team-quiet is-bordered" disabled={Boolean(view.busy) || invalid}
            onClick={() => void authorCall(conversationId, 'savePreset', { config: savingConfig }, result => ({ librarySelected: result })).then(refresh).catch(() => {})}>{t('author.saveToLibrary')}</button>
        </div>
        <More summary={t('presets.saveAs')}>
          <div className="rp-team-grid is-name">
            <Field label={t('presetName')}><input value={savingConfig.name} onChange={event => update({ libraryName: event.target.value })} /></Field>
            <Field label={t('author.newVersion')}><input value={savingConfig.version} onChange={event => update({ libraryVersion: event.target.value })} /></Field>
          </div>
          <p className="rp-team-note">{t('author.libraryHelp')}</p>
        </More>
      </div>
    </Section>

    <Section title={t('presets.replace')} hint={t('presets.replaceHelp')}>
      <div className="rp-team-button-row">
        <button type="button" className="rp-team-primary" onClick={() => draftFile.current?.click()}><Icon name="upload" />{t('import')}</button>
        <select className="rp-team-inline-select" aria-label={t('loadExample')} value="" onChange={event => {
          const example = examples.find(item => item.id === event.target.value)
          if (example) offer(example, { code: 'example', name: example.name })
        }}>
          <option value="">{t('loadExample')}…</option>
          {examples.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select>
        <input ref={draftFile} className="rp-team-file" type="file" accept="application/json,.json" tabIndex={-1} aria-hidden="true"
          onChange={async event => {
            const file = event.target.files?.[0]
            event.target.value = ''
            const imported = file ? await actions.readImport(file) : null
            if (imported) offer(imported, { code: 'imported', name: imported.name })
          }} />
      </div>
      {editor.error && !editor.dirty ? <p className="rp-team-callout is-error" role="alert">{editor.error}</p> : null}
      {pending ? <div className="rp-team-callout is-warn" role="alert">
        <p>{t('replaceDraftPrompt', { name: pending.config.name })}</p>
        <div className="rp-team-button-row">
          <button type="button" className="rp-team-quiet is-danger is-bordered" onClick={() => { actions.applyConfig(pending.config, pending.notice); setPending(null) }}>{t('replaceDraft')}</button>
          <button type="button" className="rp-team-quiet" onClick={() => setPending(null)}>{t('keep')}</button>
        </div>
      </div> : null}
    </Section>

    <Section title={t('author.libraryTitle')} hint={t('presets.libraryHelp')}
      aside={<button type="button" className="rp-team-quiet is-bordered" onClick={() => libraryFile.current.click()}><Icon name="upload" />{t('author.importToLibrary')}</button>}>
      <input type="file" ref={libraryFile} className="rp-team-file" accept=".json,application/json" onChange={async event => {
        const input = event.target.files?.[0]; event.target.value = ''
        if (!input) return
        try { const preset = JSON.parse(await input.text()); await authorCall(conversationId, 'importPreset', { preset }, result => ({ librarySelected: result })); await refresh() } catch (error) { update({ error: error.message }) }
      }} />
      <AuthorError view={view} />
      {library.length ? <ul className="rp-team-library">
        {library.map(item => {
          const open = selected?.id === item.id
          return <li key={item.id} className={open ? 'is-open' : ''}>
            <button type="button" className="rp-team-library-head" aria-expanded={open} onClick={() => open ? update({ librarySelected: null }) : load(item.id)}>
              <span className="rp-team-library-name">{item.name}</span>
              <span className="rp-team-library-meta">{item.version}{item.versions?.length > 1 ? ` · ${t('presets.versions', { n: item.versions.length })}` : ''}</span>
              <Icon name="chevron" className="rp-team-roster-chevron" />
            </button>
            {open ? <LibraryEntry conversationId={conversationId} selected={selected} versions={item.versions || []} editor={editor} view={view} load={load} refresh={refresh} actions={actions} /> : null}
          </li>
        })}
      </ul> : <p className="rp-team-note">{t('presets.libraryEmpty')}</p>}
    </Section>

    <ComponentSection conversationId={conversationId} editor={editor} view={view} update={update} actions={actions} invalid={invalid} />
  </div></div>
}

function LibraryEntry({ conversationId, selected, versions, editor, view, load, refresh, actions }) {
  const differences = React.useMemo(() => comparePresets(selected.config, editor.draft), [selected.config, editor.draft])
  return <div className="rp-team-library-body">
    <p className="rp-team-note">{t('shell.versionLine', { version: selected.version, n: selected.config.agents.length })} · {selected.config.agents.map(agent => agent.name).join(t('listSep'))}</p>
    {versions.length > 1 ? <Field label={t('author.savedVersion')}><select value={selected.version} onChange={event => load(selected.id, event.target.value)}>{versions.map(item => <option key={item.version} value={item.version}>{item.version}</option>)}</select></Field> : null}
    <div className="rp-team-button-row">
      {editor.dirty ? <ConfirmButton className="is-bordered" label={t('author.loadDraft')} confirmLabel={t('author.confirmLoad')} onConfirm={() => actions.applyConfig(selected.config, { code: 'imported', name: selected.config.name })} />
        : <button type="button" className="rp-team-primary" onClick={() => actions.applyConfig(selected.config, { code: 'imported', name: selected.config.name })}>{t('author.loadDraft')}</button>}
      <button type="button" className="rp-team-quiet is-bordered" disabled={Boolean(view.busy)} onClick={() => void authorCall(conversationId, 'copyPreset', { id: selected.id, version: selected.version }, result => ({ librarySelected: result })).then(refresh).catch(() => {})}>{t('author.copyPreset')}</button>
      <button type="button" className="rp-team-quiet is-bordered" onClick={() => void authorCall(conversationId, 'exportPreset', { id: selected.id, version: selected.version }, () => ({})).then(result => downloadPreset(result.preset, `${selected.id}.rp-team.json`)).catch(() => {})}><Icon name="download" />{t('export')}</button>
      <ConfirmButton label={t('author.deleteLibrary')} confirmLabel={t('author.confirmDeleteLibrary')} onConfirm={() => void authorCall(conversationId, 'deletePreset', { id: selected.id }, () => ({ librarySelected: null })).then(refresh).catch(() => {})} />
    </div>
    <p className="rp-team-note">{t('author.dependencyHelp')}</p>
    <details className="rp-team-author-card"><summary>{t('author.compareDraft')}<span className="rp-team-author-badge">{differences.length ? t('presets.differences', { n: differences.length }) : t('presets.same')}</span></summary><div className="rp-team-author-card-body">
      {differences.map((change, index) => <details key={index}><summary>{change.name} · {t(`author.change.${change.field}`)}</summary>
        <div className="rp-team-compare"><Field label={t('author.savedValue')}><ValueView value={change.before} /></Field><Field label={t('author.draftValue')}><ValueView value={change.after} /></Field></div></details>)}
      {!differences.length ? <p className="rp-team-note">{t('presets.same')}</p> : null}
    </div></details>
  </div>
}

function ComponentSection({ conversationId, editor, view, update, actions, invalid }) {
  const componentFile = React.useRef(null)
  const prepareSeq = React.useRef(0)
  const config = editor.draft
  const componentAgents = view.componentAgents || []
  const prepare = async (component, bindings = view.componentBindings || {}, freshId) => {
    const importId = freshId || view.componentImportId || crypto.randomUUID()
    const source = stableContent(editor.draft), seq = ++prepareSeq.current
    update({ component, componentImportId: importId, componentBindings: bindings })
    try { await authorCall(conversationId, 'prepareComponentImport', { config: editor.draft, component, importId, bindings }, result => seq === prepareSeq.current ? { componentPlan: result, componentSource: source } : {}) } catch {}
  }
  const componentStale = view.componentSource !== stableContent(config)
  const connectionAgents = [...config.agents, ...(view.component?.agents || []).flatMap(agent => view.componentPlan?.agentIdMap?.[agent.id] ? [{ ...agent, id: view.componentPlan.agentIdMap[agent.id] }] : [])]
  return <Section title={t('author.components')} hint={t('author.componentsHelp')}>
    <More summary={t('presets.exportComponent')}>
      <Field label={t('author.componentName')}><input value={view.componentName || ''} onChange={event => update({ componentName: event.target.value })} /></Field>
      <div className="rp-team-checks">{config.agents.map(agent => <Check key={agent.id} label={agent.name} checked={componentAgents.includes(agent.id)} onChange={enabled => update({ componentAgents: enabled ? [...componentAgents, agent.id] : componentAgents.filter(id => id !== agent.id) })} />)}</div>
      <div className="rp-team-button-row"><button type="button" className="rp-team-quiet is-bordered" disabled={!componentAgents.length || invalid || Boolean(view.busy)} onClick={() => void authorCall(conversationId, 'exportComponent', { config, agentIds: componentAgents, name: view.componentName || config.name }, () => ({})).then(result => downloadPreset(result.component, 'rp-team.component.json')).catch(() => {})}><Icon name="download" />{t('author.exportComponent')}</button></div>
    </More>
    <div className="rp-team-button-row"><button type="button" className="rp-team-quiet is-bordered" onClick={() => componentFile.current.click()}><Icon name="upload" />{t('author.importComponent')}</button></div>
    <input type="file" ref={componentFile} className="rp-team-file" accept=".json,application/json" onChange={async event => {
      const input = event.target.files?.[0]; event.target.value = ''
      if (!input) return
      try { const value = JSON.parse(await input.text()); await prepare(value.component || value, {}, crypto.randomUUID()) } catch (error) { update({ error: error.message }) }
    }} />
    {view.componentPlan ? <div className="rp-team-card rp-team-component-plan">
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
      <ConfirmButton className="is-bordered" label={t('author.mergeDraft')} confirmLabel={t('author.confirmMerge')} disabled={Boolean(view.busy) || invalid || componentStale || !view.componentPlan.config || Boolean(view.componentPlan.issues?.some(issue => issue.severity === 'error') || view.componentPlan.conflicts?.length)} onConfirm={() => { actions.applyConfig(view.componentPlan.config, { code: 'imported', name: view.component?.name || '' }); update({ componentPlan: null }) }} />
    </div> : null}
  </Section>
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
