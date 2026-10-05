import { React } from './react.js'
import { t } from './i18n.js'
import { Field, Check, PeerChecklist } from './fields.jsx'
import { stateChoices, stateKey } from './author-model.js'
import { effectiveStateAccess } from './editor-model.js'

export function EventTriggerFields({ trigger, config, member, onChange }) {
  const set = changes => onChange({ ...trigger, ...changes })
  const type = trigger.type
  const choices = stateChoices(config.state.definitions).filter(row => ['read', 'readwrite'].includes(effectiveStateAccess(member, row.namespace, row.path)))
  return <div className="rp-team-nested">
    {type === 'periodic' ? <div className="rp-team-grid"><Field label={t('event.every')}><input type="number" min="1" value={trigger.every} onChange={event => set({ every: Number(event.target.value) })} /></Field><Field label={t('event.offset')}><input type="number" min="0" value={trigger.offset ?? 0} onChange={event => set({ offset: Number(event.target.value) })} /></Field></div> : null}
    {type === 'state_changed' ? <Field label={t('event.state')} hint={t('event.stateHelp')}><select value={stateKey(trigger)} onChange={event => { const row = choices.find(row => stateKey(row) === event.target.value); if (row) set({ namespace: row.namespace, path: row.path }) }}>
      {!choices.some(row => stateKey(row) === stateKey(trigger)) ? <option value={stateKey(trigger)}>{trigger.namespace} · {trigger.path} ({t('event.notReadable')})</option> : null}{choices.map(row => <option key={stateKey(row)} value={stateKey(row)}>{row.label}</option>)}
    </select></Field> : null}
    {type === 'message_received' ? <>
      <PeerChecklist label={t('event.from')} hint={t('event.fromHelp')} agents={config.agents} value={trigger.from || []} allowAll={false} onChange={from => set({ from })} />
      <fieldset className="rp-team-group"><legend>{t('event.messageTypes')}</legend>{['message', 'request', 'handoff_result'].map(kind => <Check key={kind} label={t(`event.messages.${kind}`)} checked={(trigger.messageTypes || ['message']).includes(kind)} onChange={enabled => set({ messageTypes: enabled ? [...(trigger.messageTypes || ['message']), kind] : trigger.messageTypes.filter(item => item !== kind) })} />)}</fieldset>
      <Field label={t('event.topic')}><input value={trigger.topic || ''} onChange={event => onChange(event.target.value ? { ...trigger, topic: event.target.value } : Object.fromEntries(Object.entries(trigger).filter(([key]) => key !== 'topic')))} /></Field>
    </> : null}
    {type === 'keyword' ? <>
      <Field label={t('event.keywords')} hint={t('event.keywordsHelp')}><textarea rows={3} value={trigger.keywords.join('\n')} onChange={event => set({ keywords: event.target.value.split('\n') })} /></Field>
      <Field label={t('event.match')}><select value={trigger.match || 'any'} onChange={event => set({ match: event.target.value })}><option value="any">{t('event.any')}</option><option value="all">{t('event.all')}</option></select></Field>
      <Check label={t('event.caseSensitive')} checked={Boolean(trigger.caseSensitive)} onChange={caseSensitive => set({ caseSensitive })} />
    </> : null}
    <Field label={t('event.cooldown')} hint={t('event.cooldownHelp')}><input type="number" min="0" step="1" value={trigger.cooldownTurns ?? ''} onChange={event => onChange(event.target.value === '' ? Object.fromEntries(Object.entries(trigger).filter(([key]) => key !== 'cooldownTurns')) : { ...trigger, cooldownTurns: Number(event.target.value) })} /></Field>
  </div>
}
