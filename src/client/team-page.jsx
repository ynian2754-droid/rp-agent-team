import { React } from './react.js'
import { t } from './i18n.js'
import { examplePresets } from '../shared/schema.mjs'
import { authoringExamples } from '../shared/author-examples.mjs'
import { drafts } from './client-state.js'
import { selectPublisher } from './editor-model.js'
import { editConfig } from './draft-state.js'
import { Field, More } from './fields.jsx'
import { TypedField } from './typed-field.jsx'
import { StateDefinitions } from './state-definitions.jsx'
import { ParametersEditor } from './parameter-editor.jsx'
import { BudgetFields, MemoryDefinitions } from './resource-settings.jsx'
import { useConversation } from './client-state.js'

const LIMITS = { concurrency: 4, maxActivations: 32, maxPerAgent: 3, maxDepth: 4 }

export function TeamPage({ conversationId, editor, actions }) {
  const config = editor.draft
  const snapshot = useConversation(conversationId)
  const examples = [...examplePresets(), ...authoringExamples()]
  const fileRef = React.useRef(null)
  const [pending, setPending] = React.useState(null)
  const update = change => drafts.update(conversationId, change)
  const setConfig = change => update(state => editConfig(state, change(state.draft)))
  // Replacing an edited draft asks first; an unedited draft can always be restored from the saved copy.
  const offer = (config, notice) => editor.dirty ? setPending({ config, notice }) : actions.applyConfig(config, notice)

  return <div className="rp-team-scroll">
    <div className="rp-team-page">
      <ParametersEditor conversationId={conversationId} editor={editor} options={snapshot.options} />
      <section className="rp-team-block">
        <h3>{t('presetInfo')}</h3>
        <Field label={t('presetName')} hint={t('stableIdHint', { id: config.id })}>
          <input value={config.name} onChange={event => setConfig(draft => ({ ...draft, name: event.target.value }))} />
        </Field>
        <Field label={t('presetVersion')}>
          <input value={config.version} onChange={event => setConfig(draft => ({ ...draft, version: event.target.value }))} />
        </Field>
        <Field label={t('publisherQuestion')} hint={t('publisherHelp')}>
          <select value={config.output.agentId} onChange={event => setConfig(draft => selectPublisher(draft, event.target.value))}>
            {config.agents.map(agent => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
          </select>
        </Field>
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

      <section className="rp-team-block">
        <h3>{t('authorMetadata')}</h3>
        <p className="rp-team-note">{t('metadataHelp')}</p>
        {['author', 'description'].map(key => <Field key={key} label={t(`author.metadata.${key}`)}><input value={typeof config.metadata?.[key] === 'string' ? config.metadata[key] : ''} onChange={event => setConfig(draft => ({ ...draft, metadata: { ...draft.metadata, [key]: event.target.value } }))} /></Field>)}
        <More summary={t('author.extraMetadata')}><TypedField bufferKey={`${conversationId}/metadata`} value={config.metadata} chooseType={false} onChange={metadata => setConfig(draft => ({ ...draft, metadata }))}
          onInvalid={invalid => update(state => ({ ...state, invalid: { ...state.invalid, '$team:metadata': invalid } }))} /></More>
      </section>

      <section className="rp-team-block">
        <h3>{t('presetFiles')}</h3>
        <p className="rp-team-note">{t('presetFilesHelp')}</p>
        <div className="rp-team-button-row">
          <button type="button" className="rp-team-quiet is-bordered" onClick={() => fileRef.current?.click()}>{t('import')}</button>
          <button type="button" className="rp-team-quiet is-bordered" onClick={() => void actions.exportFile()}>{editor.dirty ? t('exportDraft') : t('export')}</button>
          <input ref={fileRef} className="rp-team-file" type="file" accept="application/json,.json" tabIndex={-1} aria-hidden="true"
            onChange={async event => {
              const file = event.target.files?.[0]
              event.target.value = ''
              const imported = file ? await actions.readImport(file) : null
              if (imported) offer(imported, { code: 'imported', name: imported.name })
            }} />
        </div>
        <Field label={t('loadExample')} hint={t('exampleHint')}>
          <select value="" onChange={event => {
            const example = examples.find(item => item.id === event.target.value)
            if (example) offer(example, { code: 'example', name: example.name })
          }}>
            <option value="">{t('chooseExample')}</option>
            {examples.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
        </Field>
        {pending ? <div className="rp-team-callout is-warn" role="alert">
          <p>{t('replaceDraftPrompt', { name: pending.config.name })}</p>
          <div className="rp-team-button-row">
            <button type="button" className="rp-team-quiet is-danger is-bordered" onClick={() => { actions.applyConfig(pending.config, pending.notice); setPending(null) }}>{t('replaceDraft')}</button>
            <button type="button" className="rp-team-quiet" onClick={() => setPending(null)}>{t('keep')}</button>
          </div>
        </div> : null}
      </section>
    </div>
  </div>
}
