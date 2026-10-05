import { React } from './react.js'
import { t, toolHint, toolLabel } from './i18n.js'
import { isCapabilityEnabled, updateCapabilitySelection } from './capabilities.js'
import {
  COMMUNICATION_KEYS, STATE_ACCESS, TRIGGER_TYPES,
  allows, clearStateRule, communicationGaps, defaultCondition, dependents, effectiveStateRule, omitKeys, replaceTrigger,
  selectPublisher, setStateAccess, toggleAllowlist, toggleTrigger, toggleTrustedTool, unsupportedParameters
} from './editor-model.js'
import { conditionProblem, modelInfo, presetInfo } from './summaries.js'
import { Check, Field, JsonField, More, PeerChecklist, Radio } from './fields.jsx'
import { nameList } from './format.js'
import { ConditionTree } from './condition-editor.jsx'
import { conditionValueInvalid } from './typed-field.jsx'
import { HandoffEditor } from './handoff-editor.jsx'
import { stateChoices } from './author-model.js'
import { EventTriggerFields } from './event-trigger-editor.jsx'

const TRUST_IDS = ['builtin:workspace', 'builtin:creator', 'builtin:plugin-discovery', 'native:preset', 'builtin:mcp-resources', 'builtin:collaboration', 'builtin:other']
const numberOrEmpty = value => value === '' ? '' : Number(value)

export function IdentitySection({ member, options, edit, json }) {
  const radio = React.useId()
  const lastRoute = React.useRef(null)
  const route = member.modelRef === 'inherit' ? null : member.modelRef
  if (route) lastRoute.current = route
  const info = modelInfo(member, options)
  const providers = options?.providers || []
  const parameters = member.parameters
  const efforts = info.model?.reasoning?.efforts || []
  const unsupported = unsupportedParameters(parameters, info.model)
  const preset = presetInfo(member, options)
  const setParameter = (key, value) => edit({ parameters: value === '' ? omitKeys(parameters, [key]) : { ...parameters, [key]: value } })
  const original = id => options ? t('originalReference', { id }) : id
  const parametersJson = json('parameters', value => ({ parameters: value }))
  return <>
    <Field label={t('name')} hint={t('stableIdHint', { id: member.id })}>
      <input value={member.name} onChange={event => edit({ name: event.target.value })} />
    </Field>
    <Field label={t('description')} hint={t('descriptionHint')}>
      <textarea rows={2} value={member.description} onChange={event => edit({ description: event.target.value })} />
    </Field>
    <Field label={t('systemPrompt')} hint={t('charCount', { n: member.systemPrompt.length })}>
      <textarea className="rp-team-prompt" rows={8} value={member.systemPrompt} onChange={event => edit({ systemPrompt: event.target.value })} />
    </Field>

    <fieldset className="rp-team-group">
      <legend>{t('model')}</legend>
      <div className="rp-team-choice-row">
        <Radio name={radio} label={t('inheritChatModel')} checked={!route} onChange={() => edit({ modelRef: 'inherit' })} />
        <Radio name={radio} label={t('specificModel')} checked={Boolean(route)} onChange={() => edit({ modelRef: lastRoute.current || { provider: '', model: '' } })} />
      </div>
      {route ? <div className="rp-team-grid">
        <Field label={t('provider')} warn={info.missingProvider ? t('missingProvider') : ''} hint={!options ? t('loadingOptions') : !route.provider ? t('chooseProvider') : ''}>
          <select value={route.provider} onChange={event => edit({ modelRef: { provider: event.target.value, model: '' } })}>
            <option value="">{t('choose')}</option>
            {route.provider && !info.provider ? <option value={route.provider}>{original(route.provider)}</option> : null}
            {providers.map(item => <option key={item.id} value={item.id}>{item.name || item.id}</option>)}
          </select>
        </Field>
        <Field label={t('modelName')} warn={info.missingModel ? t('unlistedModel') : ''} hint={route.provider && !route.model ? t('chooseModel') : ''}>
          <select value={route.model} disabled={!route.provider} onChange={event => edit({ modelRef: { ...route, model: event.target.value } })}>
            <option value="">{t('choose')}</option>
            {route.model && !info.model ? <option value={route.model}>{original(route.model)}</option> : null}
            {(info.provider?.models || []).map(item => <option key={item.id} value={item.id}>{item.name || item.id}</option>)}
          </select>
        </Field>
      </div> : <p className="rp-team-note">{t('inheritModelHelp')}</p>}
      <div className="rp-team-grid is-three">
        {[['temperature', 0, 2, 0.1], ['topP', 0, 1, 0.05], ['maxTokens', 1, undefined, 1]].map(([key, min, max, step]) => <Field key={key} label={t(key)}>
          <input type="number" inputMode="decimal" min={min} max={max} step={step} placeholder={t('modelDefault')} value={parameters[key] ?? ''}
            onChange={event => setParameter(key, numberOrEmpty(event.target.value))} />
        </Field>)}
      </div>
      {efforts.length || parameters.reasoningEffort ? <Field label={t('reasoningEffort')}>
        <select value={parameters.reasoningEffort || ''} onChange={event => setParameter('reasoningEffort', event.target.value)}>
          <option value="">{t('modelDefault')}</option>
          {parameters.reasoningEffort && !efforts.some(item => item.id === parameters.reasoningEffort) ? <option value={parameters.reasoningEffort}>{original(parameters.reasoningEffort)}</option> : null}
          {efforts.map(item => <option key={item.id} value={item.id}>{item.name || item.id}</option>)}
        </select>
      </Field> : null}
      {unsupported.length ? <div className="rp-team-callout is-warn">
        <p>{t('unsupportedParams', { list: unsupported.map(key => `${t(key)} = ${JSON.stringify(parameters[key])}`).join(t('listSep')) })}</p>
        <button type="button" className="rp-team-quiet is-bordered" onClick={() => edit({ parameters: omitKeys(parameters, unsupported) })}>{t('removeUnsupported')}</button>
      </div> : null}
      <More summary={t('advancedParameters')} startOpen={parametersJson.invalid}>
        <JsonField label={t('parameters')} value={parameters} binding={parametersJson} />
      </More>
    </fieldset>

    <Field label={t('preset')} hint={t('presetHint')} warn={preset.missing ? t('missingPreset') : preset.broken ? t('brokenPreset') : ''}>
      <select value={member.presetId} onChange={event => edit({ presetId: event.target.value })}>
        <option value="">{t('noPreset')}</option>
        {member.presetId && !preset.preset ? <option value={member.presetId}>{original(member.presetId)}</option> : null}
        {(options?.presets || []).map(item => <option key={item.id} value={item.id}>{item.name || item.id}{item.broken ? ` (${t('broken')})` : ''}</option>)}
      </select>
    </Field>
  </>
}

export function TriggerSection({ member, config, edit, json, conversationId, setInvalid }) {
  const has = type => member.triggers.some(trigger => trigger.type === type)
  const waitedBy = dependents(config, member.id)
  const ofType = type => member.triggers.filter(trigger => trigger.type === type)
  return <>
    <fieldset className="rp-team-group">
      <legend>{t('triggerLegend')}</legend>
      <p className="rp-team-note">{t('triggerHelp')}</p>
      {TRIGGER_TYPES.map(type => <div key={type} className="rp-team-trigger">
        <Check label={t(`triggers.${type}`)} hint={t(`triggerHints.${type}`)} checked={has(type)}
          onChange={enabled => edit({ triggers: toggleTrigger(member, type, enabled, defaultCondition(config, member)) })} />
        {type === 'requested_by_agent' ? ofType(type).map((trigger, index) => <div className="rp-team-nested" key={index}>
          <PeerChecklist label={t('requestFromLabel')} hint={t('requestFromHelp')} agents={config.agents} excludeId={member.id} allowAll={false} value={trigger.from || []}
            onChange={from => edit({ triggers: replaceTrigger(member, type, index, { ...trigger, from }) })} />
        </div>) : null}
        {type === 'condition' ? ofType(type).map((trigger, index) => <ConditionEditor key={index} index={index} trigger={trigger} member={member} config={config} edit={edit} json={json} conversationId={conversationId} setInvalid={setInvalid} />) : null}
        {ofType(type).map((trigger, index) => <EventTriggerFields key={`event-${trigger.id || index}`} trigger={trigger} member={member} config={config} onChange={next => edit({ triggers: replaceTrigger(member, type, index, next) })} />)}
      </div>)}
    </fieldset>
    <PeerChecklist label={t('afterMembers')} hint={t('afterHelp')} agents={config.agents} excludeId={member.id} allowAll={false} value={member.execution.after}
      onChange={after => edit({ execution: { ...member.execution, after } })} />
    {waitedBy.length ? <p className="rp-team-note">{t('waitedBy', { names: nameList(config, waitedBy.map(agent => agent.id), 4) })}</p> : null}
    <Field label={t('failurePolicy')}>
      <select value={member.execution.onFailure} onChange={event => edit({ execution: { ...member.execution, onFailure: event.target.value } })}>
        <option value="continue">{t('continueOnFailure')}</option>
        <option value="stop">{t('stopOnFailure')}</option>
      </select>
    </Field>
  </>
}

function ConditionEditor({ index, trigger, member, config, edit, json, conversationId, setInvalid }) {
  const condition = trigger.condition
  const problem = conditionProblem(condition, config, member)
  const apply = next => ({ triggers: replaceTrigger(member, 'condition', index, { ...trigger, condition: next }) })
  const set = next => edit(apply(next))
  const conditionJson = json(`condition-${index}`, (value, current) => ({ triggers: replaceTrigger(current, 'condition', index, { ...trigger, condition: value }) }))
  const bufferKey = `${conversationId}/${member.id}/condition-${index}`
  const changeTree = next => { set(next); setInvalid?.(`typed-condition-${index}`, conditionValueInvalid(next, bufferKey)) }
  return <div className="rp-team-nested rp-team-condition">
    <ConditionTree value={condition} config={config} bufferKey={bufferKey} onChange={changeTree}
      onInvalid={() => setInvalid?.(`typed-condition-${index}`, conditionValueInvalid(condition, bufferKey))} />
    {problem ? <p className="rp-team-callout is-error">{t(`issue.condition_${problem}`)}</p> : null}
    <More summary={t('conditionJson')} startOpen={conditionJson.invalid}>
      <JsonField label={t('conditionExpression')} hint={t('conditionHelp')} value={condition} binding={conditionJson} />
    </More>
  </div>
}

export { ContextSection } from './context-section.jsx'

export function CommunicationSection({ member, config, edit, conversationId, setInvalid }) {
  const gaps = communicationGaps(config, member)
  const set = (key, value) => edit({ communication: { ...member.communication, [key]: value } })
  return <>
    <HandoffEditor member={member} config={config} edit={edit} conversationId={conversationId} setInvalid={setInvalid} />
    <p className="rp-team-note">{t('communicationHelp')}</p>
    <div className="rp-team-matrix-wrap">
      <table className="rp-team-matrix">
        <thead><tr><th scope="col">{t('member')}</th>{COMMUNICATION_KEYS.map(key => <th key={key} scope="col" title={t(`communication.${key}`)}>{t(`communicationShort.${key}`)}</th>)}</tr></thead>
        <tbody>
          <tr className="is-all">
            <th scope="row">{t('allMembers')}</th>
            {COMMUNICATION_KEYS.map(key => <td key={key}><input type="checkbox" aria-label={`${t(`communication.${key}`)}：${t('allMembers')}`}
              checked={member.communication[key].includes('*')} onChange={event => set(key, toggleAllowlist(member.communication[key], '*', event.target.checked))} /></td>)}
          </tr>
          {config.agents.map(agent => <tr key={agent.id}>
            <th scope="row">{agent.name}{agent.id === member.id ? <small>{t('selfSuffix')}</small> : null}</th>
            {COMMUNICATION_KEYS.map(key => {
              const list = member.communication[key]
              const gap = gaps[key].includes(agent.id)
              return <td key={key} className={gap ? 'has-gap' : ''}>
                <input type="checkbox" aria-label={`${t(`communication.${key}`)}：${agent.name}`} checked={allows(list, agent.id)} disabled={list.includes('*')}
                  onChange={event => set(key, toggleAllowlist(list, agent.id, event.target.checked))} />
                {gap ? <span className="rp-team-gap" title={t(`gap.${key}`)} aria-label={t(`gap.${key}`)}>!</span> : null}
              </td>
            })}
          </tr>)}
        </tbody>
      </table>
    </div>
    <dl className="rp-team-legend">
      {COMMUNICATION_KEYS.map(key => <React.Fragment key={key}><dt>{t(`communicationShort.${key}`)}</dt><dd>{t(`communication.${key}`)}</dd></React.Fragment>)}
    </dl>
    {Object.values(gaps).some(list => list.length) ? <p className="rp-team-note"><span className="rp-team-gap" aria-hidden="true">!</span> {t('gapHelp')}</p> : null}
  </>
}

export function StateSection({ member, config, edit, json }) {
  const definitions = stateChoices(config.state.definitions)
  const stateJson = json('statePermissions', statePermissions => ({ statePermissions }))
  const extra = member.statePermissions.filter(rule => !definitions.some(definition => definition.namespace === rule.namespace && definition.path === rule.path))
  return <>
    <p className="rp-team-note">{t('stateHelp')}</p>
    {definitions.length ? <table className="rp-team-state-table">
      <thead><tr><th scope="col">{t('statePath')}</th><th scope="col">{t('stateAccess')}</th></tr></thead>
      <tbody>
        {definitions.map(definition => {
          const rule = effectiveStateRule(member, definition.namespace, definition.path)
          const exact = Boolean(rule && rule.path === definition.path)
          const path = `${definition.namespace}${definition.path || '/'}`
          return <tr key={`${definition.namespace}${definition.path}`}>
            <th scope="row">
              <span className="rp-team-state-name">{definition.description || definition.path || '/'}</span>
              <code>{path}</code>
              {rule && !exact ? <small>{t('inheritedFrom', { path: `${rule.namespace}${rule.path || '/'}` })}</small> : null}
            </th>
            <td>
              <select aria-label={t('stateAccessFor', { path })} value={rule?.access || 'none'}
                onChange={event => edit({ statePermissions: setStateAccess(member, definition.namespace, definition.path, event.target.value) })}>
                {STATE_ACCESS.map(access => <option key={access} value={access}>{t(`access.${access}`)}</option>)}
              </select>
              {exact ? <button type="button" className="rp-team-link" onClick={() => edit({ statePermissions: clearStateRule(member, definition.namespace, definition.path) })}>{t('clearRule')}</button> : null}
            </td>
          </tr>
        })}
      </tbody>
    </table> : <p className="rp-team-callout">{t('noStateDefinitions')}</p>}
    {extra.length ? <div className="rp-team-group">
      <p className="rp-team-subhead">{t('extraRules')}</p>
      <ul className="rp-team-plain-list">{extra.map(rule => <li key={`${rule.namespace}${rule.path}`}><code>{rule.namespace}{rule.path || '/'}</code><span>{t(`access.${rule.access}`)}</span></li>)}</ul>
    </div> : null}
    <More summary={t('stateRulesJson')} startOpen={stateJson.invalid}>
      <JsonField label={t('stateScopes')} hint={t('stateScopeHelp')} value={member.statePermissions} binding={stateJson} />
    </More>
  </>
}

export function OutputSection({ member, config, options, edit, json, changeConfig }) {
  const publisher = config.output.agentId === member.id
  const capabilities = options?.capabilities || []
  const known = new Set(capabilities.map(item => item.id))
  const unknown = member.capabilities.filter(item => !known.has(item.id))
  const trusted = member.execution.trustedTools
  const capabilitiesJson = json('capabilities', value => ({ capabilities: value }))
  const trustedJson = json('trustedTools', (value, current) => ({ execution: { ...current.execution, trustedTools: value } }))
  const trustCandidates = [
    ...capabilities.filter(item => item.requiresTrust || TRUST_IDS.includes(item.id) || item.id.startsWith('mcp:') || item.id.startsWith('extension:') || trusted.includes(item.id)),
    ...trusted.filter(id => !known.has(id)).map(id => ({ id, unknown: true }))
  ]
  return <>
    <fieldset className="rp-team-group">
      <legend>{t('outputAuthority')}</legend>
      {['internal', 'draft', 'state'].map(key => <Check key={key} label={t(`authority.${key}`)} hint={t(`authorityHints.${key}`)} checked={member.outputAuthority[key]}
        onChange={enabled => edit({ outputAuthority: { ...member.outputAuthority, [key]: enabled } })} />)}
      <div className="rp-team-publisher-row">
        {publisher ? <p>{t('isPublisher')}</p> : <>
          <p>{t('notPublisher')}</p>
          <button type="button" className="rp-team-quiet is-bordered" onClick={() => changeConfig(draft => selectPublisher(draft, member.id))}>{t('makePublisher')}</button>
        </>}
      </div>
    </fieldset>
    <fieldset className="rp-team-group">
      <legend>{t('capabilities')}</legend>
      <p className="rp-team-note">{member.capabilities.length ? t('capabilitiesExplicit') : t('capabilitiesInherited')}</p>
      {!options ? <p className="rp-team-note">{t('loadingOptions')}</p> : !capabilities.length ? <p className="rp-team-note">{t('emptyCapabilities')}</p> : null}
      {capabilities.map(item => <Check key={item.id} label={toolLabel(item)} hint={toolHint(item) || item.id} checked={isCapabilityEnabled(member.capabilities, item)}
        onChange={enabled => edit({ capabilities: updateCapabilitySelection(member.capabilities, capabilities, item.id, enabled) })} />)}
      {options ? unknown.map(item => <Check key={item.id} label={item.id} hint={t('unknownCapability')} checked={item.enabled}
        onChange={enabled => edit({ capabilities: member.capabilities.map(entry => entry.id === item.id ? { ...entry, enabled } : entry) })} />) : null}
    </fieldset>
    <fieldset className="rp-team-group">
      <legend>{t('trustedTools')}</legend>
      <p className="rp-team-note">{t('trustedHelp')}</p>
      {trustCandidates.length ? trustCandidates.map(item => <Check key={item.id} label={item.unknown ? item.id : toolLabel(item)} hint={item.unknown ? t('unknownCapability') : item.id}
        checked={trusted.includes(item.id)} onChange={enabled => edit({ execution: toggleTrustedTool(member, item.id, enabled) })} />)
        : <p className="rp-team-note">{options ? t('noTrustTools') : t('loadingOptions')}</p>}
    </fieldset>
    <More summary={t('capabilityGroupIds')} startOpen={capabilitiesJson.invalid || trustedJson.invalid}>
      <JsonField label={t('capabilities')} value={member.capabilities} binding={capabilitiesJson} />
      <JsonField label={t('trustedGroupIds')} value={trusted} binding={trustedJson} />
    </More>
  </>
}
