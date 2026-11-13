import { createHash } from 'node:crypto'
import { teamError } from '../shared/schema.mjs'
import { stableJson } from './context-world-adapter.mjs'

export async function validateAgentModelRoutes(config, llm) {
  for (const agent of config.agents) {
    if (agent.modelRef === 'inherit') continue
    const info = await llm.resolveModelInfo(agent.modelRef.provider, agent.modelRef.model)
    if (agent.parameters.reasoningEffort !== undefined && !info.reasoning?.efforts?.some(item => item.id === agent.parameters.reasoningEffort)) {
      throw teamError('RP_TEAM_UNSUPPORTED_MODEL_PARAMETER', `${agent.parameters.reasoningEffort} reasoning effort is not supported by ${info.provider}/${info.id}`)
    }
    if (agent.parameters.maxTokens !== undefined && info.context?.contextWindow && agent.parameters.maxTokens > info.context.contextWindow) {
      throw teamError('RP_TEAM_UNSUPPORTED_MODEL_PARAMETER', `${agent.name} maxTokens exceeds this model's context window`)
    }
  }
}

export async function resolveAgentModel(agent, inherited, llm) {
  const inherit = agent.modelRef === 'inherit'
  const route = inherit ? inherited : { ...agent.modelRef }
  if (!route?.provider || !route?.model) throw teamError('RP_TEAM_MODEL_REQUIRED', `No model route is available for ${agent.name}`)
  const model = { ...(inherit ? route : {}), provider: route.provider, model: route.model, ...agent.parameters }
  if (agent.parameters.reasoningEffort !== undefined || agent.compaction.autoCompactTokenLimit !== undefined) {
    const info = await llm.resolveModelInfo(model.provider, model.model)
    if (agent.parameters.reasoningEffort !== undefined && !info.reasoning?.efforts?.some(item => item.id === agent.parameters.reasoningEffort)) {
      throw teamError('RP_TEAM_UNSUPPORTED_MODEL_PARAMETER', `${agent.name} reasoning effort is unsupported by ${model.provider}/${model.model}`)
    }
    if (agent.compaction.autoCompactTokenLimit !== undefined && (!info.context?.contextWindow || agent.compaction.autoCompactTokenLimit > info.context.contextWindow)) {
      throw teamError('RP_TEAM_INVALID_COMPACTION', `${agent.name} compaction threshold exceeds the model context window`)
    }
  }
  return model
}

export async function resolveAgentPreset({ agent, parentPresetId, model, llm, agentPresets, parseYaml, cache, persistDefinition }) {
  const baseId = agent.presetId || parentPresetId
  if (!baseId) throw teamError('RP_TEAM_PRESET_REQUIRED', `No native Agent preset is available for ${agent.name}`)
  if (agent.compaction.autoCompactTokenLimit === undefined) return baseId
  const info = await llm.resolveModelInfo(model.provider, model.model)
  const contextWindow = info.context?.contextWindow
  if (!contextWindow || agent.compaction.autoCompactTokenLimit > contextWindow) {
    throw teamError('RP_TEAM_INVALID_COMPACTION', `${agent.name} compaction threshold exceeds the model context window`)
  }
  const document = await agentPresets.readDocument(baseId)
  const recipe = {
    baseId, baseContent: document.content, baseContentHash: fingerprint(document.content),
    baseName: document.name ?? baseId,
    agentId: agent.id, autoCompactTokenLimit: agent.compaction.autoCompactTokenLimit, contextWindow
  }
  const id = derivedPresetId(recipe)
  recipe.id = id
  if (!cache.has(id)) {
    const pending = (async () => {
      await persistDefinition?.(recipe)
      return await agentPresets.register(derivedPresetDefinition(recipe, parseYaml))
    })()
    cache.set(id, pending)
    pending.catch(() => cache.delete(id))
  }
  await cache.get(id)
  return id
}

export function restoreRegisteredAgentPreset(recipe, { agentPresets, parseYaml }) {
  return agentPresets.register(derivedPresetDefinition(recipe, parseYaml))
}

export async function disposeRegisteredAgentPresets(cache) {
  const registrations = await Promise.allSettled([...cache.values()])
  await Promise.allSettled(registrations
    .filter(result => result.status === 'fulfilled' && typeof result.value === 'function')
    .map(result => result.value()))
  cache.clear()
}

function derivedPresetId(recipe) {
  return `rp-team-${fingerprint({
    baseId: recipe.baseId, baseContentHash: recipe.baseContentHash,
    agentId: recipe.agentId, autoCompactTokenLimit: recipe.autoCompactTokenLimit,
    contextWindow: recipe.contextWindow
  }).slice(0, 24)}`
}

function derivedPresetDefinition(recipe, parseYaml) {
  if (recipe.id !== derivedPresetId(recipe) || fingerprint(recipe.baseContent) !== recipe.baseContentHash) {
    throw teamError('RP_TEAM_PRESET_INVALID', `Stored derived preset ${recipe.id} does not match its source`)
  }
  const plugins = parseYaml(recipe.baseContent)
  if (!Array.isArray(plugins)) throw teamError('RP_TEAM_PRESET_INVALID', `Native preset ${recipe.baseId} is not an entry list`)
  const compaction = findPresetEntry(plugins, 'compaction-basic')
  if (!compaction) throw teamError('RP_TEAM_COMPACTION_UNAVAILABLE', `Native preset ${recipe.baseId} has no compaction-basic plugin`)
  compaction.config ??= {}
  compaction.config.thresholdRatio = recipe.autoCompactTokenLimit / recipe.contextWindow
  return {
    id: recipe.id, name: `RP Team · ${recipe.baseName || recipe.baseId}`,
    description: `Derived per-agent compaction from ${recipe.baseId}`, plugins
  }
}

function fingerprint(value) {
  return createHash('sha256').update(stableJson(value)).digest('hex')
}

function findPresetEntry(plugins, id) {
  for (const item of plugins) {
    if (item?.id === id) return item
    if (Array.isArray(item?.config)) {
      const found = findPresetEntry(item.config, id)
      if (found) return found
    }
  }
  return undefined
}
