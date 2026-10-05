import { React } from './react.js'
import { t } from './i18n.js'
import { Check, Field, More } from './fields.jsx'
import { pointerLabel } from './author-model.js'

export function PathPicker({ fields = [], value, onChange, label }) {
  const selected = Array.isArray(value)
  const [path, setPath] = React.useState('')
  return <fieldset className="rp-team-path-picker"><legend>{label}</legend>
    <Check label={t('author.allFields')} checked={!selected} onChange={enabled => onChange(enabled ? undefined : [])} />
    {selected ? <>
      <div className="rp-team-field-tree">{fields.map(field => <Check key={field.path} label={field.label || pointerLabel(field.path)} checked={value.includes(field.path)}
        onChange={enabled => onChange(enabled ? [...new Set([...value, field.path])] : value.filter(item => item !== field.path))} />)}</div>
      {value.filter(item => !fields.some(field => field.path === item)).map(item => <Check key={item} label={pointerLabel(item)} checked onChange={() => onChange(value.filter(path => path !== item))} />)}
      <More summary={t('author.addressAdvanced')}><Field label={t('conditionPath')}><input value={path} placeholder="/data/name" onChange={event => setPath(event.target.value)} /></Field><button type="button" className="rp-team-quiet" disabled={path !== '' && (!path.startsWith('/') || /~(?![01])/u.test(path))} onClick={() => { onChange([...new Set([...value, path])]); setPath('') }}>{t('author.addPath')}</button></More>
    </> : null}
  </fieldset>
}
