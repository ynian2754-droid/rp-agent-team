import nativeAgentTeamService from '@deepseek-ai/dsh-experimental-agent-team'

export const name = 'rp-agent-team-native-service'
export const inject = ['eleckoiRuntimeExtensions', 'eleckoiStoryState']

// Team sessions keep an immutable native roster. RP Team uses its own
// maxActivations limit, so the shared DSH service must not impose a much
// smaller lifetime cap on otherwise valid repeated runs.
export const NATIVE_TEAM_MAX_MEMBERS = Number.MAX_SAFE_INTEGER

export function installStoryStateService(ctx) {
  const runtimeExtensions = ctx.eleckoiRuntimeExtensions
  if (typeof runtimeExtensions?.getProductCommitStatus !== 'function') return
  const storyState = ctx.eleckoiStoryState
  if (!storyState) throw new Error('ElecKoi story-state service is unavailable')
  const getProductCommitStatus = input => runtimeExtensions.getProductCommitStatus(input)
  if (typeof storyState.getProductCommitStatus !== 'function') {
    storyState.getProductCommitStatus = getProductCommitStatus
  }
}

export async function installNativeAgentTeamService(ctx, service = nativeAgentTeamService) {
  installStoryStateService(ctx)
  if (ctx.get('agentTeams')) return
  await ctx.plugin(service, { maxMembers: NATIVE_TEAM_MAX_MEMBERS })
}

export async function apply(ctx) {
  await installNativeAgentTeamService(ctx)
  await ctx.plugin(await import('./index.mjs'))
}
