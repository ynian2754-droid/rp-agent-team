import { createAgent } from '../shared/schema.mjs'

export const STATE_ACCESS = ['none', 'read', 'write', 'readwrite']
export const COMMUNICATION_KEYS = ['sendTo', 'receiveFrom', 'requestTo', 'requestFrom']
export const TRIGGER_TYPES = ['always', 'manual', 'requested_by_agent', 'condition', 'periodic', 'state_changed', 'message_received', 'keyword']
export const CONTEXT_SOURCES = ['current_input', 'recent_history', 'full_history', 'character_card', 'worldbook', 'long_memory', 'scene_state', 'agent_messages', 'drafts', 'hidden_state']
export const STATE_BACKED_SOURCES = new Set(['long_memory', 'scene_state', 'hidden_state'])
export const MEMBER_SCOPED_SOURCES = new Set(['agent_messages', 'drafts'])

export function addAgent(config, source, { name = '新成员', copyName = value => `${value} · 副本` } = {}) {
  const id = `agent-${globalThis.crypto.randomUUID()}`
  const agent = source ? { ...structuredClone(source), id, name: copyName(source.name), outputAuthority: { ...source.outputAuthority, user: false } } : createAgent({ id, name })
  const oldNamespace = source ? `private:${source.id}` : null
  const newNamespace = `private:${id}`
  const rewrite = value => Array.isArray(value) ? value.map(rewrite) : value && typeof value === 'object'
    ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, key === 'namespace' && item === oldNamespace ? newNamespace : rewrite(item)])) : value
  return { config: { ...config, agents: [...config.agents, source ? rewrite(agent) : agent], state: { ...config.state, definitions: [...config.state.definitions, ...config.state.definitions.filter(item => item.namespace === oldNamespace).map(rewrite)] } }, selectedId: id }
}

export function removeAgent(config, id) {
  if (config.agents.length === 1) return config
  const remaining = config.agents.filter(agent => agent.id !== id).map(agent => ({
    ...agent,
    execution: { ...agent.execution, after: agent.execution.after.filter(target => target !== id) },
    communication: Object.fromEntries(Object.entries(agent.communication).map(([key, ids]) => [key, ids.filter(target => key === 'handoffs' ? target.to !== id : target !== id)])),
    triggers: agent.triggers.filter(trigger => !referencesNamespace(trigger, `private:${id}`)).map(trigger => trigger.from ? { ...trigger, from: trigger.from.filter(target => target !== id) } : trigger),
    context: { ...agent.context, sources: agent.context.sources.map(source => source.agentIds ? { ...source, agentIds: source.agentIds.filter(target => target !== id) } : source) },
    statePermissions: agent.statePermissions.filter(rule => rule.namespace !== `private:${id}`)
  }))
  const next = { ...config, agents: remaining, state: { ...config.state, definitions: config.state.definitions.filter(rule => rule.namespace !== `private:${id}`) } }
  if (config.memory) next.memory = { collections: config.memory.collections.filter(row => row.namespace !== `private:${id}`) }
  // Keep unresolved parameter references visible for the author instead of silently redirecting them.
  return config.output.agentId === id ? selectPublisher(next, remaining[0].id) : next
}

function referencesNamespace(value, namespace) {
  if (!value || typeof value !== 'object') return false
  return value.namespace === namespace || Object.values(value).some(item => Array.isArray(item) ? item.some(child => referencesNamespace(child, namespace)) : referencesNamespace(item, namespace))
}

export function validJsonShape(field, value) {
  const record = item => Boolean(item) && typeof item === 'object' && !Array.isArray(item)
  const rows = keys => Array.isArray(value) && value.every(item => record(item) && keys.every(key => typeof item[key] === 'string'))
  if (field === 'parameters' || field === 'metadata') return record(value)
  if (field === 'context') return record(value) && Array.isArray(value.sources) && value.sources.every(item => record(item) && typeof item.type === 'string')
  if (field === 'trustedTools') return Array.isArray(value) && value.every(item => typeof item === 'string')
  if (field === 'capabilities') return rows(['id']) && value.every(item => typeof item.enabled === 'boolean')
  if (field === 'statePermissions') return rows(['namespace', 'path', 'access'])
  if (field === 'definitions') return rows(['namespace', 'path', 'type'])
  return record(value)
}

export function selectPublisher(config, agentId) {
  return { ...config, output: { ...config.output, agentId }, agents: config.agents.map(agent => ({ ...agent, outputAuthority: { ...agent.outputAuthority, user: agent.id === agentId } })) }
}

export function updateAgent(config, id, changes) {
  return { ...config, agents: config.agents.map(agent => agent.id === id ? { ...agent, ...changes } : agent) }
}

export function allows(list = [], id) {
  return list.includes('*') || list.includes(id)
}

/** Toggles one member in an allowlist. `*` stays exclusive, matching schema rules. */
export function toggleAllowlist(list = [], id, enabled) {
  if (id === '*') return enabled ? ['*'] : []
  if (list.includes('*')) return list
  return enabled ? [...new Set([...list, id])] : list.filter(value => value !== id)
}

export function toggleTrigger(member, type, enabled, condition) {
  if (!enabled) return member.triggers.filter(trigger => trigger.type !== type)
  if (member.triggers.some(trigger => trigger.type === type)) return member.triggers
  const trigger = type === 'condition' ? { type, condition } : type === 'requested_by_agent' ? { type, from: [] }
    : type === 'periodic' ? { type, every: 2, offset: 0 }
    : type === 'state_changed' ? { type, namespace: condition.namespace || 'shared', path: condition.path || '' }
    : type === 'message_received' ? { type, from: [], messageTypes: ['message'] }
    : type === 'keyword' ? { type, keywords: [], match: 'any', caseSensitive: false } : { type }
  if (['periodic', 'state_changed', 'message_received', 'keyword'].includes(type)) trigger.id = `trigger-${crypto.randomUUID()}`
  return [...member.triggers, trigger]
}

/** Replaces the nth trigger of a type without touching any other trigger. */
export function replaceTrigger(member, type, index, next) {
  let seen = 0
  return member.triggers.map(trigger => trigger.type === type && seen++ === index ? next : trigger)
}

export function defaultCondition(config, member) {
  const readable = config.state.definitions.find(definition => ['read', 'readwrite'].includes(effectiveStateAccess(member, definition.namespace, definition.path)))
  const definition = readable || config.state.definitions[0]
  return definition ? { op: 'exists', namespace: definition.namespace, path: definition.path } : { op: 'exists', namespace: 'shared', path: '/flag' }
}

export function toggleSource(member, type, enabled) {
  const sources = member.context.sources
  if (!enabled) return { ...member.context, sources: sources.filter(item => item.type !== type) }
  if (sources.some(item => item.type === type)) return member.context
  return { ...member.context, sources: [...sources, type === 'recent_history' ? { type, limit: 12 } : { type }] }
}

/** Applies source changes; an `undefined` value removes that key instead of storing an empty value. */
export function updateSource(member, index, changes) {
  return {
    ...member.context,
    sources: member.context.sources.map((source, row) => {
      if (row !== index) return source
      const next = { ...source }
      for (const [key, value] of Object.entries(changes)) {
        if (value === undefined) delete next[key]
        else next[key] = value
      }
      return next
    })
  }
}

/** An unfinished field is deliberately invalid until the author supplies a path. */
export function addSource(member, type) {
  return { ...member.context, sources: [...member.context.sources, { type, selector: null }] }
}

export function removeSource(member, index) {
  return { ...member.context, sources: member.context.sources.filter((_source, row) => row !== index) }
}

export function incompleteSource(source) {
  return Object.hasOwn(source, 'selector') && source.selector !== '' &&
    (typeof source.selector !== 'string' || !source.selector.startsWith('/') || /~(?![01])/u.test(source.selector))
}

/** Keep edited and surviving row keys stable without adding IDs to saved sources. */
export function sourceRowKeys(previous, sources, allocate) {
  const keys = sources.map(source => {
    const old = previous.sources.indexOf(source)
    return old < 0 ? null : previous.keys[old]
  })
  return keys.map((key, index) => key ?? (
    previous.sources[index]?.type === sources[index].type &&
    !sources.includes(previous.sources[index]) && !keys.includes(previous.keys[index])
      ? previous.keys[index] ?? allocate() : allocate()
  ))
}

export function effectiveStateRule(agent, namespace, path) {
  return agent.statePermissions.filter(rule => rule.namespace === namespace &&
    (rule.path === '' || rule.path === path || path.startsWith(`${rule.path}/`)))
    .sort((left, right) => right.path.length - left.path.length)[0]
}

export function effectiveStateAccess(agent, namespace, path) {
  return effectiveStateRule(agent, namespace, path)?.access || 'none'
}

/** Writes one exact path rule. Broader and unrelated rules are preserved. */
export function setStateAccess(member, namespace, path, access) {
  const rest = member.statePermissions.filter(rule => !(rule.namespace === namespace && rule.path === path))
  return [...rest, { namespace, path, access }]
}

export function clearStateRule(member, namespace, path) {
  return member.statePermissions.filter(rule => !(rule.namespace === namespace && rule.path === path))
}

export function toggleTrustedTool(member, id, enabled) {
  const current = member.execution.trustedTools
  return { ...member.execution, trustedTools: enabled ? [...new Set([...current, id])] : current.filter(value => value !== id) }
}

/** Parameter keys the selected model does not advertise. Unknown models report nothing. */
export function unsupportedParameters(parameters, model) {
  if (!model) return []
  return Object.entries(parameters || {}).filter(([key, value]) => {
    if (key === 'reasoningEffort') return !model.reasoning?.efforts?.some(effort => effort.id === value)
    return model.parameters?.[key] === false
  }).map(([key]) => key)
}

export function omitKeys(record, keys) {
  return Object.fromEntries(Object.entries(record || {}).filter(([key]) => !keys.includes(key)))
}

export function dependents(config, id) {
  return config.agents.filter(agent => agent.execution.after.includes(id))
}

/** Peers for which this member's grant is not matched by the other side. */
export function communicationGaps(config, member) {
  const peer = id => config.agents.find(agent => agent.id === id)
  const targets = list => list.includes('*') ? config.agents.map(agent => agent.id) : list
  const unmatched = (list, check) => targets(list).filter(id => { const other = peer(id); return other && !check(other) })
  return {
    sendTo: unmatched(member.communication.sendTo, other => allows(other.communication.receiveFrom, member.id)),
    receiveFrom: unmatched(member.communication.receiveFrom, other => allows(other.communication.sendTo, member.id)),
    requestTo: unmatched(member.communication.requestTo, other => allows(other.communication.requestFrom, member.id) && other.triggers.some(trigger => trigger.type === 'requested_by_agent')),
    requestFrom: unmatched(member.communication.requestFrom, other => allows(other.communication.requestTo, member.id))
  }
}

export function manualMembers(config) {
  return config?.agents?.filter(agent => agent.triggers.some(trigger => trigger.type === 'manual')) || []
}
