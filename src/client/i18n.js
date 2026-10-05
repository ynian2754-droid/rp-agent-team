let labels = {}

export function setLocale(locales, language = '') {
  labels = /^zh(?:-|$)/i.test(language) ? locales.zh : locales.en
}

export function lookup(table, key) {
  return key.split('.').reduce((value, part) => value?.[part], table)
}

/** Returns the localized string; `{name}` placeholders are filled from `vars`. Missing keys return the key. */
export function t(key, vars) {
  const value = lookup(labels, key)
  if (typeof value !== 'string') return key
  return vars ? value.replace(/\{(\w+)\}/g, (_, name) => vars[name] ?? '') : value
}

/** Localized label when present, otherwise the raw recorded value. */
export function tOr(key, fallback) {
  const value = lookup(labels, key)
  return typeof value === 'string' ? value : fallback
}

/** Event types contain dots, so they are looked up as whole keys. */
export function eventLabel(type) {
  return labels.events?.[type] || type
}

export function toolLabel(item) {
  return labels.toolLabels?.[item.id] || item.label || item.id
}

export function toolHint(item) {
  return labels.toolHints?.[item.id] || ''
}

export function formatTime(value, withDate = false) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  const today = new Date().toDateString() === date.toDateString()
  return date.toLocaleString(undefined, withDate || !today
    ? { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }
    : { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}
