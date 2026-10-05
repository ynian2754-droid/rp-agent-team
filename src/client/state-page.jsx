import { React } from './react.js'
import { t } from './i18n.js'
import { authorViews, authorCall, AuthorError, ValueView } from './author-pages.jsx'
import { useKeyed, services } from './client-state.js'
import { Field, ConfirmButton, Check } from './fields.jsx'
import { StateValueEditor } from './state-value-editor.jsx'
import { valueForm, formValue, valueError, emptyValue } from './state-editor-model.js'
import { pointerLabel, stateEditRequest, stateKey } from './author-model.js'
import { isActivePhase } from './run-model.js'
import { MemoryView } from './memory-view.jsx'

export function StatePage({ conversationId, editor, snapshot }) {
  const view = useKeyed(authorViews, conversationId)
  const [scope, setScope] = React.useState('')
  const requestSeq = React.useRef(0)
  const runKey = `${snapshot.status?.run?.runId || ''}:${snapshot.status?.run?.phase || ''}`
  const refresh = async () => {
    const seq = ++requestSeq.current
    try {
      const state = await services.api.author('getState', { conversationId, ...(scope ? { agentId: scope } : {}) })
      const { checkpoints } = await services.api.author('listStateCheckpoints', { conversationId })
      if (seq === requestSeq.current) authorViews.update(conversationId, { state, checkpoints, stateScope: scope })
    } catch (error) { if (seq === requestSeq.current) authorViews.update(conversationId, { error: error.message }) }
  }
  React.useEffect(() => { void refresh(); return () => { requestSeq.current++ } }, [conversationId, scope, runKey])
  const data = view.state
  const blocked = Boolean(view.busy || view.pendingOperation || data?.busy || isActivePhase(snapshot.status?.run?.phase) || scope || view.stateScope !== scope)
  const updateEdit = (key, change) => authorViews.update(conversationId, current => ({ ...current, stateEdits: { ...current.stateEdits, [key]: change } }))
  const apply = (row, operation) => {
    const key = stateKey(row), edit = view.stateEdits[key]
    const base = edit?.base || data
    const request = stateEditRequest(base, [{ namespace: row.namespace, path: row.path, operation, ...(operation === 'set' ? { value: formValue(edit.form) } : {}) }])
    authorViews.update(conversationId, { pendingOperation: request.operationId })
    void authorCall(conversationId, 'applyStateEdit', request, result => ({ pendingOperation: result.status === 'pending' ? request.operationId : '',
      ...(result.status === 'committed' ? { stateEdits: { ...view.stateEdits, [key]: null } } : {}) })).then(refresh).catch(() => {})
  }
  const restore = (checkpoint, mode, paths) => {
    const request = { conversationId, checkpointId: checkpoint.id, mode, operationId: crypto.randomUUID(), expectedRevision: data.revision, expectedWorldHash: data.worldHash, ...(paths ? { paths } : {}) }
    authorViews.update(conversationId, { pendingOperation: request.operationId })
    void authorCall(conversationId, 'restoreStateCheckpoint', request, result => ({ pendingOperation: result.status === 'pending' ? request.operationId : '' })).then(refresh).catch(() => {})
  }
  const saveMemory = async (base, row, value) => {
    const request = stateEditRequest(base, [{ namespace: row.namespace, path: row.path, operation: 'set', value }])
    authorViews.update(conversationId, { pendingOperation: request.operationId })
    try {
      const result = await authorCall(conversationId, 'applyStateEdit', request, result => ({ pendingOperation: result.status === 'pending' ? request.operationId : '' }))
      await refresh()
      return result
    } catch { return null }
  }
  return <div className="rp-team-scroll"><div className="rp-team-page rp-team-author-page">
    <section className="rp-team-block"><div className="rp-team-state-section-head"><h3>{t('author.currentState')}</h3><button type="button" className="rp-team-quiet is-bordered" onClick={() => void refresh()}>{t('reload')}</button></div><p className="rp-team-note">{t('author.currentStateHelp')}</p>
      <Field label={t('author.viewAs')}><select value={scope} onChange={event => setScope(event.target.value)}><option value="">{t('author.authorView')}</option>{editor.draft.agents.map(agent => <option key={agent.id} value={agent.id}>{agent.name}</option>)}</select></Field>
      {blocked ? <p className="rp-team-callout">{t(scope ? 'author.memberViewReadOnly' : 'author.stateBusy')}</p> : null}
    </section><AuthorError view={view} />
    {view.pendingOperation ? <div className="rp-team-callout is-warn"><p>{t('author.commitPending')}</p><button type="button" className="rp-team-quiet" onClick={() => void authorCall(conversationId, 'getStateEditStatus', { conversationId, operationId: view.pendingOperation }, result => ({ pendingOperation: ['committed', 'failed', 'not_found'].includes(result.status) ? '' : view.pendingOperation, pendingStatus: result.status })).then(refresh).catch(() => {})}>{t('author.checkSave')}</button>
      {view.pendingStatus === 'unknown' ? <ConfirmButton label={t('author.dismissUnknown')} confirmLabel={t('author.confirmDismissUnknown')} onConfirm={() => authorViews.update(conversationId, { pendingOperation: '', pendingStatus: '' })} /> : null}
    </div> : null}
    {!data ? <p className="rp-team-placeholder">{t('loading')}</p> : <>
      {(data.issues || []).map((issue, index) => <p key={index} className="rp-team-callout is-warn">{issue.message || String(issue)}</p>)}
      <MemoryView conversationId={conversationId} config={snapshot.config} data={data} blocked={blocked} onSave={saveMemory} />
      {data.values.map(row => {
        const key = stateKey(row), edit = view.stateEdits[key]
        const rowBlocked = blocked || (row.namespace === 'world' && row.path === '')
        const definition = data.definitions.find(item => stateKey(item) === key)
        return <details className="rp-team-author-card" key={key} open={Boolean(edit)}>
          <summary>{pointerLabel(row.path)} <small>{row.namespace}</small>{row.staged ? <span className="rp-team-author-badge">{t('author.staged')}</span> : null}</summary>
          <div className="rp-team-author-card-body"><Field label={t('author.committedValue')}><ValueView value={row.value} missing={row.missing} /></Field>
            {row.staged ? <Field label={t('author.staged')}><ValueView value={row.stagedValue} missing={row.stagedMissing} /></Field> : null}
            {Object.hasOwn(row, 'initial') ? <details><summary>{t('author.initialValue')}</summary><ValueView value={row.initial} /></details> : null}
            {edit ? <>
              {edit.base.revision !== data.revision || edit.base.worldHash !== data.worldHash ? <p className="rp-team-callout is-warn">{t('author.editStale')}</p> : null}
              <StateValueEditor node={edit.form} chooseType onChange={form => updateEdit(key, { ...edit, form })} />
              <div className="rp-team-button-row"><button type="button" className="rp-team-primary" disabled={rowBlocked || Boolean(view.pendingOperation) || Boolean(valueError(edit.form))} onClick={() => apply(row, 'set')}>{t('author.applyValue')}</button><button type="button" className="rp-team-quiet" onClick={() => updateEdit(key, null)}>{t('discard')}</button></div>
            </> : <div className="rp-team-button-row">
              <button type="button" className="rp-team-quiet is-bordered" disabled={rowBlocked || Boolean(view.pendingOperation)} onClick={() => updateEdit(key, { base: data, form: valueForm(row.missing ? emptyValue(definition?.type || 'string') : row.value) })}>{t('author.editValue')}</button>
              <ConfirmButton label={t('author.resetValue')} confirmLabel={t('author.confirmReset')} disabled={rowBlocked || !definition || !Object.hasOwn(definition, 'default')} onConfirm={() => apply(row, 'reset')} />
              <ConfirmButton label={t('author.removeValue')} confirmLabel={t('author.confirmRemove')} disabled={rowBlocked || row.missing || (row.namespace === 'world' && row.path.startsWith('/settings/'))} onConfirm={() => apply(row, 'remove')} />
            </div>}
          </div>
        </details>
      })}
      {!data.values.length ? <p className="rp-team-placeholder">{t('author.noState')}</p> : null}
      {!scope ? <section className="rp-team-block"><h3>{t('author.checkpoints')}</h3><p className="rp-team-note">{t('author.checkpointsHelp')}</p>
        {view.checkpoints.map(checkpoint => <details className="rp-team-author-card" key={checkpoint.id}><summary>{checkpoint.label} <small>{checkpoint.branchStatus}</small></summary><div className="rp-team-author-card-body">
          <ValueView value={checkpoint.values} />
          {checkpoint.values.some(row => row.unknown) ? <p className="rp-team-callout is-warn">{t('author.unknownPastValues')}</p> : null}
          {checkpoint.values.filter(row => !row.unknown).map(row => <Check key={stateKey(row)} label={`${row.namespace} · ${pointerLabel(row.path)}`} checked={(view.checkpointPaths?.[checkpoint.id] || []).includes(stateKey(row))} onChange={enabled => {
            const selected = view.checkpointPaths?.[checkpoint.id] || [], key = stateKey(row)
            authorViews.update(conversationId, { checkpointPaths: { ...view.checkpointPaths, [checkpoint.id]: enabled ? [...selected, key] : selected.filter(item => item !== key) } })
          }} />)}<div className="rp-team-button-row">
            <ConfirmButton label={t('author.applyPast')} confirmLabel={t('author.confirmPast')} disabled={blocked || checkpoint.values.some(row => row.unknown)} onConfirm={() => restore(checkpoint, 'values')} />
            <ConfirmButton label={t('author.applySelectedPast')} confirmLabel={t('author.confirmPast')} disabled={blocked || !view.checkpointPaths?.[checkpoint.id]?.length} onConfirm={() => restore(checkpoint, 'values', checkpoint.values.filter(row => view.checkpointPaths[checkpoint.id].includes(stateKey(row))).map(({ namespace, path }) => ({ namespace, path })))} />
            <ConfirmButton label={t('author.rewind')} confirmLabel={t('author.confirmRewind')} disabled={blocked || !checkpoint.canRewind} onConfirm={() => restore(checkpoint, 'rewind')} />
          </div></div></details>)}
      </section> : null}
    </>}
  </div></div>
}
