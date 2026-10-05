import { React } from './react.js'
import { t } from './i18n.js'
import { allows, toggleAllowlist } from './editor-model.js'

export function Field({ label, hint, warn, error, children, className = '' }) {
  const id = React.useId()
  const note = error || warn || hint
  const described = note ? `${id}-note` : undefined
  const control = React.isValidElement(children)
    ? React.cloneElement(children, { id: children.props.id || id, 'aria-describedby': described, ...(error ? { 'aria-invalid': true } : {}) })
    : children
  return <div className={`rp-team-field ${className}`}>
    <label className="rp-team-field-label" htmlFor={children?.props?.id || id}>{label}</label>
    {control}
    {note ? <small id={described} className={error ? 'rp-team-field-error' : warn ? 'rp-team-field-warn' : 'rp-team-field-hint'}>{note}</small> : null}
  </div>
}

/** JSON text kept verbatim while invalid; valid input updates the draft immediately. */
export function JsonField({ label, hint, value, binding, rows = 6 }) {
  const text = binding.raw ?? JSON.stringify(value, null, 2)
  return <Field label={label} hint={hint} error={binding.invalid ? t('invalidJson') : ''}>
    <textarea className="rp-team-code" rows={rows} spellCheck="false" value={text} onChange={event => binding.onInput(event.target.value)} />
  </Field>
}

/** Folded advanced area. It starts open when it holds something the author must see, such as invalid JSON. */
export function More({ summary, startOpen, children }) {
  const ref = React.useRef(null)
  React.useEffect(() => { if (startOpen && ref.current) ref.current.open = true }, [])
  return <details ref={ref} className="rp-team-more"><summary>{summary}</summary>{children}</details>
}

export function Check({ label, hint, checked, onChange, disabled, children }) {
  return <label className={`rp-team-check ${disabled ? 'is-disabled' : ''}`}>
    <input type="checkbox" checked={checked} disabled={disabled} onChange={event => onChange(event.target.checked)} />
    <span className="rp-team-check-text"><span>{label}</span>{hint ? <small>{hint}</small> : null}{children}</span>
  </label>
}

export function Radio({ name, label, hint, checked, onChange, disabled }) {
  return <label className={`rp-team-check ${disabled ? 'is-disabled' : ''}`}>
    <input type="radio" name={name} checked={checked} disabled={disabled} onChange={() => onChange()} />
    <span className="rp-team-check-text"><span>{label}</span>{hint ? <small>{hint}</small> : null}</span>
  </label>
}

export function Switch({ checked, onChange, label, disabled, busy }) {
  return <button type="button" role="switch" className="rp-team-switch" aria-checked={checked} aria-label={label} aria-busy={busy || undefined}
    disabled={disabled} onClick={() => onChange(!checked)}>
    <span className="rp-team-switch-track" aria-hidden="true"><span /></span>
    <span className="rp-team-switch-text">{checked ? t('enabled') : t('disabled')}</span>
  </button>
}

/** Checkbox list over team members. `*` is exclusive, as the schema requires. */
export function PeerChecklist({ label, hint, agents, value = [], onChange, allowAll = true, excludeId, selfId }) {
  const all = value.includes('*')
  return <fieldset className="rp-team-peers">
    <legend>{label}</legend>
    {hint ? <p className="rp-team-note">{hint}</p> : null}
    {allowAll ? <Check label={t('allMembers')} checked={all} onChange={enabled => onChange(toggleAllowlist(value, '*', enabled))} /> : null}
    {agents.filter(agent => agent.id !== excludeId).map(agent => <Check key={agent.id}
      label={agent.id === selfId ? `${agent.name}${t('selfSuffix')}` : agent.name}
      checked={allows(value, agent.id)} disabled={all}
      onChange={enabled => onChange(toggleAllowlist(value, agent.id, enabled))} />)}
    {!agents.some(agent => agent.id !== excludeId) ? <p className="rp-team-note">{t('noOtherMembers')}</p> : null}
  </fieldset>
}

/** Two-step destructive action; the second click within the prompt confirms. */
export function ConfirmButton({ label, confirmLabel, onConfirm, disabled, className = '' }) {
  const [asking, setAsking] = React.useState(false)
  const confirmRef = React.useRef(null)
  React.useEffect(() => { if (asking) confirmRef.current?.focus() }, [asking])
  if (!asking) return <button type="button" className={`rp-team-quiet ${className}`} disabled={disabled} onClick={() => setAsking(true)}>{label}</button>
  return <span className="rp-team-confirm" role="group" aria-label={label}>
    <button ref={confirmRef} type="button" className="rp-team-quiet is-danger" onClick={() => { setAsking(false); onConfirm() }}>{confirmLabel}</button>
    <button type="button" className="rp-team-quiet" onClick={() => setAsking(false)} onKeyDown={event => { if (event.key === 'Escape') setAsking(false) }}>{t('keep')}</button>
  </span>
}

export function Icon({ name, className = '' }) {
  const paths = {
    team: <><circle cx="9" cy="8" r="3" /><path d="M3 20v-1.5a6 6 0 0 1 12 0V20M16 5.2a3 3 0 0 1 0 5.6M17.5 14.2A5 5 0 0 1 21 19v1" /></>,
    chevron: <path d="m9 6 6 6-6 6" />,
    back: <path d="m15 6-6 6 6 6" />,
    plus: <path d="M12 5v14M5 12h14" />,
    trace: <><path d="M4 6h10M4 12h16M4 18h7" /><circle cx="18" cy="6" r="2" /><circle cx="15" cy="18" r="2" /></>,
    warn: <><path d="M12 4 2.8 20h18.4z" /><path d="M12 10v4M12 17h.01" /></>,
    open: <path d="M8 16 16 8M10 8h6v6" />
  }
  return <svg className={`rp-team-icon ${className}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>
}
