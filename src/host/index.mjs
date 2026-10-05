import { defineTool } from '@deepseek-ai/dsh-tools'
import { scopeOf } from '@deepseek-ai/dsh-scope'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import { parse, stringify } from 'yaml'
import { RpAgentTeamRemoteApi } from './remote.mjs'
import { createRpAgentTeam } from './runtime.mjs'
import { createAuthorStateApi } from './author-state.mjs'
import { createAuthorToolsApi } from './author-tools.mjs'
import { previewParameters } from './parameter-api.mjs'
import { createTrialApi } from './trials.mjs'

export const name = 'rp-agent-team'
export const inject = [
  'agents', 'agentPresets', 'agentTeams', 'eleckoiRuntimeExtensions',
  'eleckoiStoryState', 'eleckoiConversationChanges', 'eleckoiTrialSnapshots', 'credentials', 'llm', 'sessions', 'subagents', 'tools'
]

export async function apply(ctx) {
  const runtime = createRpAgentTeam(ctx, { defineTool, parseYaml: parse, stringifyYaml: stringify, scopeOf, LlmAdapter })
  let authorState, trials, disposeExtension
  try {
    authorState = createAuthorStateApi({ ctx, ...runtime.authoring })
    await authorState.ready
    const authorTools = createAuthorToolsApi({ ctx, ...runtime.authoring, getOptions: runtime.api.getOptions, readState: authorState.getState })
    for (const method of ['getState', 'listStateCheckpoints']) runtime.api[method] = authorState[method]
    for (const method of ['applyStateEdit', 'getStateEditStatus', 'restoreStateCheckpoint']) runtime.api[method] = async input => {
      const result = await authorState[method](input)
      if (result.status === 'committed') ctx.eleckoiConversationChanges.publish({ kind: 'snapshot' })
      return result
    }
    Object.assign(runtime.api, authorTools)
    runtime.api.previewParameters = previewParameters
    trials = createTrialApi({ ctx, ...runtime.authoring, getOptions: runtime.api.getOptions, readState: authorState.getState })
    for (const [method, handler] of Object.entries(trials)) if (!['dispose', 'restoreTrialStateSnapshot', 'captureTrialStateSnapshot'].includes(method)) runtime.api[method] = handler
    // Only the isolated worker Host receives this internal method, never Typert Remote.
    runtime.api.restoreTrialStateSnapshot = trials.restoreTrialStateSnapshot
    runtime.api.captureTrialStateSnapshot = trials.captureTrialStateSnapshot
    ctx.provide('rpAgentTeam', runtime.api)
    disposeExtension = ctx.eleckoiRuntimeExtensions.register(runtime.extension)
    await disposeExtension.ready
    await ctx.plugin(RpAgentTeamRemoteApi)
  } catch (error) {
    try { await trials?.dispose(); await authorState?.dispose(); await runtime.dispose() } finally { await disposeExtension?.() }
    throw error
  }
  let disposed = false
  return ctx.effect(() => async () => {
    if (disposed) return
    disposed = true
    try { await trials.dispose(); await authorState.dispose(); await runtime.dispose() } finally { await disposeExtension() }
  })
}
