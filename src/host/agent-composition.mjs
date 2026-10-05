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

export async function resolveAgentPreset({ agent, parentPresetId, model, llm, agentPresets, parseYaml, cache }) {
  const baseId = agent.presetId || parentPresetId
  if (!baseId) throw teamError('RP_TEAM_PRESET_REQUIRED', `No native Agent preset is available for ${agent.name}`)
  if (agent.compaction.autoCompactTokenLimit === undefined) return baseId
  const info = await llm.resolveModelInfo(model.provider, model.model)
  const contextWindow = info.context?.contextWindow
  if (!contextWindow || agent.compaction.autoCompactTokenLimit > contextWindow) {
    throw teamError('RP_TEAM_INVALID_COMPACTION', `${agent.name} compaction threshold exceeds the model context window`)
  }
  const id = `rp-team-${fingerprint({ baseId, agentId: agent.id, agent, limit: agent.compaction.autoCompactTokenLimit }).slice(0, 24)}`
  if (!cache.has(id)) {
    const pending = createDerivedPreset({
      id, baseId, thresholdRatio: agent.compaction.autoCompactTokenLimit / contextWindow, agentPresets, parseYaml
    })
    cache.set(id, pending)
    pending.catch(() => cache.delete(id))
  }
  await cache.get(id)
  return id
}

export async function disposeRegisteredAgentPresets(cache) {
  const registrations = await Promise.allSettled([...cache.values()])
  await Promise.allSettled(registrations
    .filter(result => result.status === 'fulfilled' && typeof result.value === 'function')
    .map(result => result.value()))
  cache.clear()
}

async function createDerivedPreset({ id, baseId, thresholdRatio, agentPresets, parseYaml }) {
  const document = await agentPresets.readDocument(baseId)
  const plugins = parseYaml(document.content)
  if (!Array.isArray(plugins)) throw teamError('RP_TEAM_PRESET_INVALID', `Native preset ${baseId} is not an entry list`)
  const compaction = findPresetEntry(plugins, 'compaction-basic')
  if (!compaction) throw teamError('RP_TEAM_COMPACTION_UNAVAILABLE', `Native preset ${baseId} has no compaction-basic plugin`)
  compaction.config ??= {}
  compaction.config.thresholdRatio = thresholdRatio
  return await agentPresets.register({
    id, name: `RP Team · ${document.name || baseId}`,
    description: `Derived per-agent compaction from ${baseId}`, plugins
  })
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
