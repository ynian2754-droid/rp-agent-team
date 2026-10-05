import { editConfig } from './draft-state.js'
import { setStateAccess } from './editor-model.js'

export const VALUE_TYPES = ['string', 'number', 'boolean', 'object', 'array', 'null']
const id = () => globalThis.crypto.randomUUID()
export const valueType = value => value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value
export const emptyValue = type => ({ string: '', number: 0, boolean: false, object: {}, array: [], null: null, any: '' })[type]
export const pathParts = path => path === '' ? [] : path.slice(1).split('/').map(part => part.replace(/~1/g, '/').replace(/~0/g, '~'))
export const statePath = parts => parts.length ? '/' + parts.map(part => part.replace(/~/g, '~0').replace(/\//g, '~1')).join('/') : ''

export function valueForm(value) {
  const type = valueType(value)
  return { id: id(), type, text: type === 'number' || type === 'string' ? String(value) : '', checked: value === true,
    entries: type === 'object' ? Object.entries(value).map(([name, item]) => ({ id: id(), name, node: valueForm(item) }))
      : type === 'array' ? value.map(item => ({ id: id(), node: valueForm(item) })) : [] }
}

export function valueError(node) {
  if (node.type === 'number' && (!node.text.trim() || !Number.isFinite(Number(node.text)))) return 'number'
  if (node.type === 'object' && new Set(node.entries.map(entry => entry.name)).size !== node.entries.length) return 'duplicateField'
  return node.entries.map(entry => valueError(entry.node)).find(Boolean) || ''
}

export function formValue(node) {
  if (valueError(node)) throw new Error(valueError(node))
  if (node.type === 'string') return node.text
  if (node.type === 'number') return Number(node.text)
  if (node.type === 'boolean') return node.checked
  if (node.type === 'null') return null
  if (node.type === 'array') return node.entries.map(entry => formValue(entry.node))
  return Object.fromEntries(node.entries.map(entry => [entry.name, formValue(entry.node)]))
}

export function definitionForms(definitions) {
  return definitions.map(definition => ({ id: id(), namespace: definition.namespace, parts: pathParts(definition.path),
    source: { namespace: definition.namespace, path: definition.path },
    type: definition.type, valueSchema: definition.valueSchema, description: definition.description ?? '', hasDescription: Object.hasOwn(definition, 'description'),
    hasDefault: Object.hasOwn(definition, 'default'), value: valueForm(Object.hasOwn(definition, 'default') ? definition.default : emptyValue(definition.type)), open: false }))
}

export function formDefinition(form) {
  return { namespace: form.namespace, path: statePath(form.parts), type: form.type,
    ...(form.valueSchema ? { valueSchema: form.valueSchema } : {}),
    ...(form.hasDefault ? { default: formValue(form.value) } : {}),
    ...(form.hasDescription || form.description ? { description: form.description } : {}) }
}

export function definitionError(form, forms) {
  if (forms.some(other => other.id !== form.id && other.namespace === form.namespace && statePath(other.parts) === statePath(form.parts))) return 'duplicateState'
  if (form.hasDefault) return valueError(form.value)
  return ''
}

export function newDefinition(forms, name) {
  let n = 1
  while (forms.some(form => form.namespace === 'shared' && statePath(form.parts) === statePath([`${name} ${n}`]))) n++
  return { ...definitionForms([{ namespace: 'shared', path: statePath([`${name} ${n}`]), type: 'string' }])[0], source: null, open: true }
}

export function changeDefinitionType(form, type) {
  return { ...form, type, value: type === 'any' || form.value.type === type ? form.value : valueForm(emptyValue(type)) }
}

export function addValueEntry(node, name) {
  let n = 1
  while (node.entries.some(entry => entry.name === `${name} ${n}`)) n++
  return { ...node, entries: [...node.entries, { id: id(), ...(node.type === 'object' ? { name: `${name} ${n}` } : {}), node: valueForm('') }] }
}

export function moveValueEntry(node, index, offset) {
  const entries = [...node.entries], target = index + offset
  if (target < 0 || target >= entries.length) return node
  ;[entries[index], entries[target]] = [entries[target], entries[index]]
  return { ...node, entries }
}

/** Buffer unfinished values in the conversation draft, never write a half-valid definition. */
export function applyDefinitionForms(editor, forms) {
  const invalid = { ...editor.invalid }, rawJson = { ...editor.rawJson }
  delete rawJson['$team:definitions']
  if (forms.some(form => definitionError(form, forms))) invalid['$team:definitions'] = true
  else delete invalid['$team:definitions']
  const next = { ...editor, stateForms: forms, invalid, rawJson, dirty: true, notice: '', error: '' }
  if (invalid['$team:definitions']) return next
  const moved = forms.filter(form => form.source && (form.source.namespace !== form.namespace || form.source.path !== statePath(form.parts)))
  const rewrite = value => {
    const match = moved.find(form => value.namespace === form.source.namespace && value.path === form.source.path)
    return match ? { ...value, namespace: match.namespace, path: statePath(match.parts) } : value
  }
  const condition = value => {
    if (value.op === 'all' || value.op === 'any') return { ...value, conditions: value.conditions.map(condition) }
    if (value.op === 'not') return { ...value, condition: condition(value.condition) }
    return rewrite(value)
  }
  const draft = { ...editor.draft, state: { ...editor.draft.state, definitions: forms.map(formDefinition) },
    agents: moved.length ? editor.draft.agents.map(agent => ({ ...agent, statePermissions: agent.statePermissions.map(rewrite),
      triggers: agent.triggers.map(trigger => trigger.type === 'condition' ? { ...trigger, condition: condition(trigger.condition) } : trigger) })) : editor.draft.agents }
  if (moved.length) for (const agent of draft.agents) {
    for (const key of Object.keys(rawJson)) if (!invalid[key] && (key === `${agent.id}:statePermissions` || key.startsWith(`${agent.id}:condition-`))) delete rawJson[key]
  }
  return editConfig({ ...next, stateForms: forms.map(form => ({ ...form, source: { namespace: form.namespace, path: statePath(form.parts) } })) }, draft, { keepStateForms: true })
}

/** Set an exact grant; broader grants are left intact and remain visible as inherited. */
export function changeDefinitionAccess(editor, form, agentId, access) {
  const draft = { ...editor.draft, agents: editor.draft.agents.map(agent => agent.id === agentId
    ? { ...agent, statePermissions: setStateAccess(agent, form.namespace, statePath(form.parts), access) } : agent) }
  const rawJson = { ...editor.rawJson }, invalid = { ...editor.invalid }
  delete rawJson[`${agentId}:statePermissions`]
  delete invalid[`${agentId}:statePermissions`]
  return editConfig({ ...editor, rawJson, invalid }, draft)
}
