import { allows, communicationGaps, effectiveStateAccess, incompleteSource, unsupportedParameters } from './editor-model.js'
import { sectionForField } from './draft-state.js'

/** Describes the member's model reference against the host catalog without changing it. */
export function modelInfo(member, options) {
  if (member.modelRef === 'inherit') return { kind: 'inherit' }
  const providerId = member.modelRef?.provider || ''
  const modelId = member.modelRef?.model || ''
  if (!providerId || !modelId) return { kind: 'incomplete', providerId, modelId }
  if (!options?.providers) return { kind: 'route', providerId, modelId, catalog: false }
  const provider = options.providers.find(item => item.id === providerId)
  const model = provider?.models?.find(item => item.id === modelId)
  return { kind: 'route', providerId, modelId, provider, model, catalog: true, missingProvider: !provider, missingModel: Boolean(provider) && !model }
}

export function presetInfo(member, options) {
  if (!member.presetId) return { kind: 'none' }
  const preset = options?.presets?.find(item => item.id === member.presetId)
  return { kind: 'preset', id: member.presetId, preset, missing: Boolean(options?.presets) && !preset, broken: Boolean(preset?.broken) }
}

export function stateCounts(config, member) {
  const counts = { read: 0, write: 0, readwrite: 0 }
  for (const definition of config.state.definitions) {
    const access = effectiveStateAccess(member, definition.namespace, definition.path)
    if (access !== 'none') counts[access]++
  }
  const extra = member.statePermissions.filter(rule => !config.state.definitions.some(definition => definition.namespace === rule.namespace && definition.path === rule.path)).length
  return { ...counts, extra }
}

/** Mirrors the schema rule: a condition leaf needs a declared state path the member can read. */
export function conditionProblem(condition, config, member) {
  if (!condition || typeof condition !== 'object') return 'invalid'
  if (condition.op === 'all' || condition.op === 'any') {
    for (const item of condition.conditions || []) { const problem = conditionProblem(item, config, member); if (problem) return problem }
    return null
  }
  if (condition.op === 'not') return conditionProblem(condition.condition, config, member)
  if (condition.op !== 'exists' && condition.op !== 'compare') return 'invalid'
  const path = typeof condition.path === 'string' ? condition.path : ''
  const declared = config.state.definitions.some(definition => definition.namespace === condition.namespace && (definition.path === '' || definition.path === path || path.startsWith(`${definition.path}/`)))
  if (!declared) return 'undeclared'
  return ['read', 'readwrite'].includes(effectiveStateAccess(member, condition.namespace, path)) ? null : 'unreadable'
}

/**
 * Problems shown next to a member and its sections. `level: 'error'` blocks saving
 * (via schema validation or invalid JSON); `warn` explains a configuration that saves.
 */
export function memberIssues(member, config, options, invalidKeys = []) {
  const issues = []
  const add = (section, code, level = 'error') => issues.push({ section, code, level })
  const model = modelInfo(member, options)
  if (model.kind === 'incomplete') add('identity', 'incompleteModel')
  if (model.missingProvider) add('identity', 'missingProvider', 'warn')
  if (model.missingModel) add('identity', 'missingModel', 'warn')
  if (model.model && unsupportedParameters(member.parameters, model.model).length) add('identity', 'unsupportedParameters', 'warn')
  const preset = presetInfo(member, options)
  if (preset.missing) add('identity', 'missingPreset', 'warn')
  if (preset.broken) add('identity', 'brokenPreset', 'warn')
  if (!member.triggers.length) add('trigger', 'noTrigger', 'warn')
  if (member.context.sources.some(incompleteSource)) add('context', 'incompleteSource')
  for (const trigger of member.triggers) {
    if (trigger.type !== 'condition') continue
    const problem = conditionProblem(trigger.condition, config, member)
    if (problem) add('trigger', `condition_${problem}`)
  }
  const gaps = communicationGaps(config, member)
  if (Object.values(gaps).some(list => list.length)) add('communication', 'oneSided', 'warn')
  if (member.statePermissions.some(rule => rule.namespace.startsWith('private:') && !config.agents.some(agent => `private:${agent.id}` === rule.namespace))) add('state', 'orphanPrivate')
  const known = new Set((options?.capabilities || []).map(item => item.id))
  if (options?.capabilities && member.capabilities.some(item => !known.has(item.id))) add('output', 'unknownCapability', 'warn')
  for (const key of invalidKeys) {
    if (!key.startsWith(`${member.id}:`)) continue
    const field = key.slice(member.id.length + 1)
    add(sectionForField(field), field.startsWith('typed-') || field.startsWith('handoff-') ? 'invalidInput' : 'invalidJson')
  }
  return issues
}

export function triggerTypes(member) {
  return [...new Set(member.triggers.map(trigger => trigger.type))]
}

export function sourceTypes(member) {
  return [...new Set(member.context.sources.map(source => source.type))]
}

export function peersFor(config, member, key) {
  const list = member.communication[key]
  if (list.includes('*')) return ['*']
  return config.agents.filter(agent => allows(list, agent.id)).map(agent => agent.id)
}
