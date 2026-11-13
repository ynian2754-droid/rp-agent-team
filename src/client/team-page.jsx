import { React } from './react.js'
import { t } from './i18n.js'
import { drafts, workspaceUi, TEAM_VIEWS, useKeyed } from './client-state.js'
import { selectPublisher } from './editor-model.js'
import { editConfig, invalidEntries, teamViewForField } from './draft-state.js'
import { Field, More, Segmented } from './fields.jsx'
import { TypedField } from './typed-field.jsx'
import { StateDefinitions } from './state-definitions.jsx'
import { ParametersEditor } from './parameter-editor.jsx'
import { BudgetFields, MemoryDefinitions } from './resource-settings.jsx'
import { MembersPage } from './members.jsx'

const LIMITS = { concurrency: 4, maxActivations: 32, maxPerAgent: 3, maxDepth: 4 }

/** The team being edited: its members, the values an ordinary user adjusts, and the author's settings. */
export function TeamPage({ conversationId, editor, snapshot, changes }) {
  const ui = useKeyed(workspaceUi, conversationId)
  const view = TEAM_VIEWS.includes(ui.teamView) ? ui.teamView : 'members'
  const config = editor.draft
  const invalidTeam = invalidEntries(editor).filter(entry => entry.scope === '$team')
  const mark = (name, dirty) => invalidTeam.some(entry => teamViewForField(entry.field) === name) ? { mark: 'failed', markLabel: t('shell.needsFix') }
    : dirty ? { mark: 'dirty', markLabel: t('shell.draft') } : {}
  const options = [
    { id: 'members', label: t('teamNav.members'), count: config.agents.length, ...(changes.members.length || changes.removed.length ? { mark: 'dirty', markLabel: t('shell.draft') } : {}) },
    { id: 'params', label: t('teamNav.params'), count: (config.authorParameters || []).length, ...mark('params', changes.params) },
    { id: 'settings', label: t('teamNav.settings'), ...mark('settings', changes.team) }
  ]
  const drilled = view === 'members' && editor.view === 'member'
  return <div className="rp-team-teampage" data-view={view} data-drilled={drilled ? 'true' : undefined}>
    <div className="rp-team-subnav">
      <Segmented className="rp-team-pill" label={t('teamNav.label')} value={view} options={options} onChange={next => workspaceUi.update(conversationId, { teamView: next })} />
    </div>
    <div className="rp-team-teampage-body">
      {view === 'members' ? <MembersPage conversationId={conversationId} editor={editor} snapshot={snapshot} changes={changes} />
        : view === 'params' ? <div className="rp-team-scroll"><div className="rp-team-page"><ParametersEditor conversationId={conversationId} editor={editor} options={snapshot.options} /></div></div>
          : <SettingsPage conversationId={conversationId} editor={editor} />}
    </div>
  </div>
}

function SettingsPage({ conversationId, editor }) {
  const config = editor.draft
  const update = change => drafts.update(conversationId, change)
  const setConfig = change => update(state => editConfig(state, change(state.draft)))
  return <div className="rp-team-scroll">
    <div className="rp-team-page">
      <section className="rp-team-block">
        <h3>{t('settings.basics')}</h3>
        <div className="rp-team-grid is-name">
          <Field label={t('presetName')} hint={t('stableIdHint', { id: config.id })}>
            <input value={config.name} onChange={event => setConfig(draft => ({ ...draft, name: event.target.value }))} />
          </Field>
          <Field label={t('presetVersion')}>
            <input value={config.version} onChange={event => setConfig(draft => ({ ...draft, version: event.target.value }))} />
          </Field>
        </div>
        <Field label={t('publisherQuestion')} hint={t('publisherHelp')}>
          <select value={config.output.agentId} onChange={event => setConfig(draft => selectPublisher(draft, event.target.value))}>
            {config.agents.map(agent => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
          </select>
        </Field>
        <Field label={t('author.metadata.description')}>
          <textarea rows={3} value={typeof config.metadata?.description === 'string' ? config.metadata.description : ''}
            onChange={event => setConfig(draft => ({ ...draft, metadata: { ...draft.metadata, description: event.target.value } }))} />
        </Field>
        <Field label={t('author.metadata.author')} hint={t('metadataHelp')}>
          <input value={typeof config.metadata?.author === 'string' ? config.metadata.author : ''}
            onChange={event => setConfig(draft => ({ ...draft, metadata: { ...draft.metadata, author: event.target.value } }))} />
        </Field>
        <More summary={t('author.extraMetadata')}><TypedField bufferKey={`${conversationId}/metadata`} value={config.metadata} chooseType={false} onChange={metadata => setConfig(draft => ({ ...draft, metadata }))}
          onInvalid={invalid => update(state => ({ ...state, invalid: { ...state.invalid, '$team:metadata': invalid } }))} /></More>
      </section>

      <section className="rp-team-block">
        <h3>{t('executionLimits')}</h3>
        <p className="rp-team-note">{t('limitsHelp')}</p>
        <div className="rp-team-grid">
          {Object.entries(LIMITS).map(([key, fallback]) => <Field key={key} label={t(`limits.${key}`)} hint={t('defaultValue', { n: fallback })}>
            <input type="number" min="1" step="1" value={config.execution[key] ?? ''}
              onChange={event => setConfig(draft => ({ ...draft, execution: { ...draft.execution, [key]: event.target.value === '' ? '' : Number(event.target.value) } }))} />
          </Field>)}
        </div>
        <BudgetFields value={config.execution.budget} onChange={budget => setConfig(draft => ({ ...draft, execution: { ...draft.execution, budget } }))} />
      </section>

      <StateDefinitions conversationId={conversationId} editor={editor} />
      <MemoryDefinitions conversationId={conversationId} editor={editor} />
    </div>
  </div>
}
