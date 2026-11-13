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

export function Switch({ checked, onChange, label, disabled, busy, title }) {
  return <button type="button" role="switch" className="rp-team-switch" aria-checked={checked} aria-label={label} aria-busy={busy || undefined} title={title}
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

// Built on first use: the host binds React after this module has been evaluated.
let iconPaths
const icons = () => iconPaths ??= {
  team: <><circle cx="9" cy="8" r="3" /><path d="M3 20v-1.5a6 6 0 0 1 12 0V20M16 5.2a3 3 0 0 1 0 5.6M17.5 14.2A5 5 0 0 1 21 19v1" /></>,
  chevron: <path d="m9 6 6 6-6 6" />,
  back: <path d="m15 6-6 6 6 6" />,
  plus: <path d="M12 5v14M5 12h14" />,
  trace: <><path d="M4 6h10M4 12h16M4 18h7" /><circle cx="18" cy="6" r="2" /><circle cx="15" cy="18" r="2" /></>,
  warn: <><path d="M12 4 2.8 20h18.4z" /><path d="M12 10v4M12 17h.01" /></>,
  open: <path d="M8 16 16 8M10 8h6v6" />,
  check: <path d="m5 12.5 4.5 4.5L19 7.5" />,
  cross: <path d="M6 6l12 12M18 6 6 18" />,
  expand: <path d="M9 4H4v5M15 4h5v5M9 20H4v-5M15 20h5v-5" />,
  shrink: <path d="M4 9h5V4M20 9h-5V4M4 15h5v5M20 15h-5v5" />,
  retry: <><path d="M4 12a8 8 0 0 1 13.7-5.6L20 9" /><path d="M20 4v5h-5M20 12a8 8 0 0 1-13.7 5.6L4 15" /><path d="M4 20v-5h5" /></>,
  stop: <rect x="6.5" y="6.5" width="11" height="11" rx="1.5" />,
  upload: <path d="M12 16V5M7.5 9.5 12 5l4.5 4.5M5 19h14" />,
  download: <path d="M12 5v11M7.5 11.5 12 16l4.5-4.5M5 19h14" />,
  sliders: <><path d="M4 7h9M17 7h3M4 17h3M11 17h9" /><circle cx="15" cy="7" r="2" /><circle cx="9" cy="17" r="2" /></>,
  clock: <><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></>
}

export function Icon({ name, className = '' }) {
  return <svg className={`rp-team-icon ${className}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{icons()[name]}</svg>
}

const HUES = 8
/** First visible character of a name, used as the member's mark across lists, runs and the ledger. */
export function sigilGlyph(name) {
  const first = [...String(name || '').trim()][0] || '·'
  return first.toUpperCase()
}

/** A member's fixed mark. The hue follows the member's position in the team, so it stays put across pages. */
export function Sigil({ name, index = 0, size = '', muted = false }) {
  return <span className={`rp-team-sigil hue-${((index % HUES) + HUES) % HUES} ${size ? `is-${size}` : ''} ${muted ? 'is-muted' : ''}`} aria-hidden="true">{sigilGlyph(name)}</span>
}

/** State is always a shape plus words; colour only reinforces it. */
export function StatusTag({ tone = 'idle', children }) {
  return <span className={`rp-team-tone tone-${tone}`}><span className="rp-team-tone-mark" aria-hidden="true" />{children}</span>
}

/** A row of mutually exclusive views. Arrow keys move between them, as in the host's own tab strips. */
export function Segmented({ label, value, options, onChange, className = '' }) {
  const onKey = event => {
    const index = options.findIndex(option => option.id === value)
    const next = { ArrowRight: index + 1, ArrowLeft: index - 1, Home: 0, End: options.length - 1 }[event.key]
    if (next === undefined) return
    event.preventDefault()
    const target = options[(next + options.length) % options.length]
    onChange(target.id)
    event.currentTarget.querySelector(`[data-id="${CSS.escape(target.id)}"]`)?.focus()
  }
  return <div className={`rp-team-seg ${className}`} role="tablist" aria-label={label} onKeyDown={onKey}>
    {options.map(option => <button key={option.id} type="button" role="tab" data-id={option.id} aria-selected={value === option.id} tabIndex={value === option.id ? 0 : -1}
      title={option.title} onClick={() => onChange(option.id)}>
      <span>{option.label}</span>
      {option.count !== undefined ? <span className="rp-team-seg-count">{option.count}</span> : null}
      {option.mark ? <span className={`rp-team-seg-mark is-${option.mark}`} aria-label={option.markLabel} /> : null}
    </button>)}
  </div>
}

export function Section({ title, hint, aside, children, className = '' }) {
  return <section className={`rp-team-section ${className}`}>
    {title || aside ? <header className="rp-team-section-head"><h3>{title}</h3>{aside ? <div className="rp-team-section-aside">{aside}</div> : null}</header> : null}
    {hint ? <p className="rp-team-note">{hint}</p> : null}
    {children}
  </section>
}

export function Empty({ title, children, action }) {
  return <div className="rp-team-empty"><h3>{title}</h3>{children ? <p>{children}</p> : null}{action}</div>
}
