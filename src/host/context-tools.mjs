import { authorizedWorldState, selectedAgentAttachments } from './agent-context.mjs'
import { buildAgentContext } from './context-policy.mjs'
import { teamError } from '../shared/schema.mjs'

/** Product data enters once through the Host API; model tools only see this
 * member's projected packet and the run's ACL-controlled staged state. */
export function readTeamContext({ member, run, stateStore }) {
  const world = authorizedWorldState(run, member, stateStore)
  return buildAgentContext(member, {
    ...run.sources, hidden_state: world, long_memory: world,
    scene_state: world.variables?.scene ?? {}
  }, { messages: run.communication.allMessages(), drafts: run.drafts }).sources
}

export function registerContextTools({ agentCtx, defineTool, member, run, stateStore, assertActiveCaller, attachments, record }) {
  const disposers = []
  const output = { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] }
  const register = definition => disposers.push(agentCtx.tools.register(defineTool({
    ...definition, output,
    async execute(args, exec) {
      assertActiveCaller(exec.agent)
      exec.signal?.throwIfAborted()
      const result = await definition.execute(args ?? {}, exec)
      record({ type: 'context.operation', agentId: member.id, data: {
        operation: definition.name, ...(args?.source ? { source: args.source } : {})
      } })
      return result
    }
  })))
  const sourceParameters = { source: { type: 'string', required: true, description: 'One of your configured context categories; paths are relative to its already filtered value.' } }
  function sourceValue(source) {
    const visible = readTeamContext({ member, run, stateStore })
    if (!Object.hasOwn(visible, source)) throw teamError('RP_TEAM_CONTEXT_FORBIDDEN', 'This context category is not available to this member.')
    return visible[source]
  }
  register({
    name: 'rp_team_read_context',
    description: 'Read your authorized input, history, character, settings, messages or staged world context. This never returns unselected source fields.',
    parameters: { ...sourceParameters, path: { type: 'string', description: 'Optional JSON Pointer within the filtered value; empty means its root.' } },
    execute: args => {
      const result = readPointer(sourceValue(args.source), args.path ?? '')
      return result.found ? { found: true, value: structuredClone(result.value) } : { found: false }
    }
  })
  register({
    name: 'rp_team_search_context',
    description: 'Find literal text in your filtered context. Search and result paths never include hidden siblings. No regex or code is executed.',
    parameters: { ...sourceParameters, query: { type: 'string', required: true }, limit: { type: 'integer', description: 'Maximum returned matches, 1–100; default 20.' } },
    execute: args => {
      if (typeof args.query !== 'string' || !args.query.trim()) throw teamError('RP_TEAM_INVALID_REQUEST', 'A non-empty search query is required.')
      const limit = args.limit ?? 20
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw teamError('RP_TEAM_INVALID_REQUEST', 'Search limit must be 1–100.')
      const matches = []
      const query = args.query.toLowerCase()
      function visit(value, path) {
        if (matches.length >= limit) return
        if (typeof value === 'string' && value.toLowerCase().includes(query)) matches.push({ path, value })
        else if (value && typeof value === 'object') {
          for (const [key, child] of Object.entries(value)) {
            if (matches.length >= limit) break
            visit(child, `${path}/${key.replace(/~/gu, '~0').replace(/\//gu, '~1')}`)
          }
        }
      }
      visit(sourceValue(args.source), '')
      return { matches }
    }
  })
  register({
    name: 'rp_team_read_attachment',
    description: 'Read an authorized current-input file by its original zero-based attachment index. Metadata-only selections do not grant file content access. Returns at most 50 KiB, with a byte offset for continuation.',
    parameters: { index: { type: 'integer', required: true }, offset: { type: 'integer' } },
    execute: async (args, exec) => {
      const offset = args.offset ?? 0
      if (!Number.isSafeInteger(args.index) || args.index < 0 || !Number.isSafeInteger(offset) || offset < 0) throw teamError('RP_TEAM_INVALID_REQUEST', 'Attachment index and offset must be non-negative integers.')
      const selected = selectedAgentAttachments(member, run.attachments)
      const part = run.attachments[args.index]
      if (!part || !selected.includes(part)) throw teamError('RP_TEAM_CONTEXT_FORBIDDEN', 'This attachment content is not available to this member.')
      if (part.type !== 'file' || !part.attachment) throw teamError('RP_TEAM_INVALID_REQUEST', 'Select a text file attachment; images are supplied through model input.')
      const limit = 50 * 1024
      const chunks = []
      let position = 0, bytesRead = 0, hasMore = false
      for await (const chunk of attachments.readFileStream(part.attachment, exec.signal)) {
        exec.signal?.throwIfAborted()
        const end = position + chunk.length
        if (end > offset && bytesRead < limit) {
          const start = Math.max(0, offset - position)
          const count = Math.min(chunk.length - start, limit - bytesRead)
          chunks.push(chunk.subarray(start, start + count))
          bytesRead += count
        }
        position = end
        if (position > offset + limit) { hasMore = true; break }
      }
      const bytes = Buffer.concat(chunks)
      if (bytes.includes(0)) throw teamError('RP_TEAM_INVALID_REQUEST', 'This is a binary file, not text.')
      // Keep the continuation offset on a UTF-8 boundary, so a Chinese word
      // straddling the 50 KiB boundary survives paging without replacement chars.
      let end = bytes.length
      if (hasMore && end) {
        let start = end - 1
        while (start > 0 && end - start < 4 && (bytes[start] & 0xc0) === 0x80) start--
        const lead = bytes[start]
        const width = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1
        if (width > end - start) end = start
      }
      let content
      try { content = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, end)) }
      catch { throw teamError('RP_TEAM_INVALID_REQUEST', 'Use a UTF-8 text file and a continuation byte offset returned by this tool.') }
      return { index: args.index, offset, bytes: end, nextOffset: hasMore ? offset + end : null, content }
    }
  })
  return () => { for (const dispose of disposers.reverse()) dispose() }
}

function readPointer(value, path) {
  if (path === '') return { found: true, value }
  if (typeof path !== 'string' || !path.startsWith('/') || /~(?![01])/u.test(path)) throw teamError('RP_TEAM_INVALID_REQUEST', 'Use a valid JSON Pointer within the filtered source.')
  for (const encoded of path.slice(1).split('/')) {
    const key = encoded.replace(/~1/gu, '/').replace(/~0/gu, '~')
    if (value === null || typeof value !== 'object' || !Object.hasOwn(value, key)) return { found: false }
    value = value[key]
  }
  return { found: true, value }
}
