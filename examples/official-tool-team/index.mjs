import { defineTool } from '@deepseek-ai/dsh-tools'
import { createScope, scopeOf } from '@deepseek-ai/dsh-scope'
import { createToolTeam } from './runtime.mjs'
import { join } from 'node:path'

export const name = 'rp-team-official-tool'
export const inject = ['agents', 'agentTeams', 'subagents', 'tools', 'sessions', 'sessionController', 'eleckoiConversationsApi']

export function apply(ctx, config = {}) {
  if (!config.journalPath && !process.env.DSH_HOME) throw new Error('A plugin data location is required')
  const journalPath = config.journalPath ?? join(process.env.DSH_HOME, 'plugins', 'rp-team-official-tool', 'journal.json')
  const runtime = createToolTeam(ctx, { defineTool, createScope, scopeOf, journalPath })
  ctx.provide('rpOfficialToolTeam', runtime.api)
  return runtime.dispose
}
