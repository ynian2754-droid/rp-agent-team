import { statePath } from './state-editor-model.js'

export const pointerLabel = path => path === '' ? '/' : path.slice(1).split('/').map(part => part.replace(/~1/g, '/').replace(/~0/g, '~')).join(' › ')
export const stateKey = value => `${value.namespace}\u0000${value.path}`
export const stableContent = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item)

export function removedChildKey(key, parent, index, prefix = '') {
  if (!key.startsWith(`${parent}/${prefix}`)) return key
  const rest = key.slice(`${parent}/${prefix}`.length), match = /^(\d+)(\/.*)?$/.exec(rest)
  if (!match) return key
  const child = Number(match[1])
  return child === index ? null : child > index ? `${parent}/${prefix}${child - 1}${match[2] || ''}` : key
}

export function stateChoices(definitions) {
  const choices = []
  const add = (definition, schema, parts) => {
    const path = statePath(parts)
    choices.push({ namespace: definition.namespace, path, type: schema?.type || definition.type, label: `${definition.namespace} · ${pointerLabel(path)}` })
    for (const [name, child] of Object.entries(schema?.properties || {})) add(definition, child, [...parts, name])
  }
  for (const definition of definitions) add(definition, definition.valueSchema, definition.path === '' ? [] : definition.path.slice(1).split('/').map(part => part.replace(/~1/g, '/').replace(/~0/g, '~')))
  return choices.filter((choice, index) => choices.findIndex(other => stateKey(other) === stateKey(choice)) === index)
}

export function conditionNode(kind, base) {
  if (kind === 'all' || kind === 'any') return { op: kind, conditions: base.conditions || [base] }
  if (kind === 'not') return base.op === 'not' ? base : { op: kind, condition: base }
  if (base.op === 'all' || base.op === 'any') return conditionNode('leaf', base.conditions[0])
  if (base.op === 'not') return conditionNode('leaf', base.condition)
  return base
}

export function conditionBufferKey(key, parent, value, kind) {
  if (key !== parent && !key.startsWith(`${parent}/`)) return key
  let oldPrefix = parent, nextPrefix = parent
  if (kind === 'leaf') {
    while (value.op === 'all' || value.op === 'any' || value.op === 'not') {
      const group = value.op !== 'not'
      oldPrefix += group ? '/0' : '/not'
      value = group ? value.conditions[0] : value.condition
    }
  } else if ((kind === 'all' || kind === 'any') && !['all', 'any'].includes(value.op)) nextPrefix += '/0'
  else if (kind === 'not' && value.op !== 'not') nextPrefix += '/not'
  return key === oldPrefix || key.startsWith(`${oldPrefix}/`) ? `${nextPrefix}${key.slice(oldPrefix.length)}` : null
}

export function comparePresets(before, after) {
  const changes = []
  const left = new Map((before?.agents || []).map(agent => [agent.id, agent]))
  for (const agent of after.agents) {
    const old = left.get(agent.id)
    if (!old) changes.push({ name: agent.name, field: 'added' })
    else for (const field of ['name', 'systemPrompt', 'modelRef', 'triggers', 'context', 'communication', 'statePermissions', 'execution', 'outputAuthority']) {
      if (stableContent(old[field]) !== stableContent(agent[field])) changes.push({ name: agent.name, field, before: old[field], after: agent[field] })
    }
    left.delete(agent.id)
  }
  for (const old of left.values()) changes.push({ name: old.name, field: 'removed' })
  for (const field of ['state', 'execution', 'output', 'metadata']) if (stableContent(before?.[field]) !== stableContent(after[field])) changes.push({ name: '', field, before: before?.[field], after: after[field] })
  return changes
}

export function previewIsStale(preview, draft, sourceVersion, inputText, manualAgentIds) {
  return Boolean(preview && (preview.draftContent !== stableContent(draft) || (sourceVersion && preview.sourceVersion !== sourceVersion)
    || (inputText !== undefined && preview.inputText !== inputText) || (manualAgentIds !== undefined && stableContent(preview.manualAgentIds) !== stableContent(manualAgentIds))))
}

export function stateEditRequest(snapshot, values) {
  return { conversationId: snapshot.conversationId, operationId: globalThis.crypto.randomUUID(), expectedRevision: snapshot.revision,
    expectedWorldHash: snapshot.worldHash, anchor: snapshot.anchor, operations: values }
}
