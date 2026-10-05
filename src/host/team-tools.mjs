import { observeStatePath } from './execution-trace.mjs'
import { teamError } from '../shared/schema.mjs'
import { buildAgentContext } from './context-policy.mjs'

/** Register the scheduled agent's collaboration, state, draft, and publication tools. */
export function registerTeamTools({
  agentCtx, defineTool, member, run, stateStore,
  assertActiveCaller, assertInternalAuthority, requestDepth, requestExecutionId,
  record, persistRun, saveDraft, submitInternal, publish
}) {
  const disposers = []
  const register = definition => disposers.push(agentCtx.tools.register(defineTool({
    ...definition,
    async execute(args, exec) {
      assertActiveCaller(exec.agent)
      return losslessJson(await definition.execute(args ?? {}, exec))
    }
  })))
  const output = { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }] }
  register({
    name: 'rp_team_send', description: 'Send an ACL-checked logical message to configured agents.',
    parameters: {
      to: { type: 'string', required: true }, body: { type: 'string' }, handoffId: { type: 'string' },
      summary: { type: 'string' }, data: { type: 'json' }, topic: { type: 'string' }
    }, output,
    execute: (args, exec) => {
      assertInternalAuthority()
      return run.communication.send({
        from: member.id, to: args.to, body: args.body, handoffId: args.handoffId,
        summary: args.summary, data: args.data, topic: args.topic, executionId: requestExecutionId(exec.agent)
      })
    }
  })
  register({
    name: 'rp_team_request', description: 'Request a configured agent activation through the run scheduler.',
    parameters: {
      to: { type: 'string', required: true }, body: { type: 'string' }, handoffId: { type: 'string' },
      summary: { type: 'string' }, data: { type: 'json' }, reason: { type: 'string' }, topic: { type: 'string' }
    }, output,
    execute: (args, exec) => {
      assertInternalAuthority()
      return run.communication.request({
        from: member.id, to: args.to, body: args.body, handoffId: args.handoffId,
        summary: args.summary, data: args.data, topic: args.topic, depth: requestDepth(exec.agent),
        reason: args.reason, executionId: requestExecutionId(exec.agent)
      })
    }
  })
  register({
    name: 'rp_team_read_messages', description: 'Read messages this agent is authorized to receive.',
    parameters: { from: { type: 'array', items: { type: 'string' } } }, output,
    execute: args => {
      const messages = run.communication.messagesFor(member.id, args.from)
      return { messages: buildAgentContext(member, {}, { messages }).sources.agent_messages ?? [] }
    }
  })
  register({
    name: 'rp_team_read_state', description: 'Read one declared state path allowed by this agent’s state permissions.',
    parameters: { namespace: { type: 'string', required: true }, path: { type: 'string', required: true } }, output,
    execute: args => {
      const result = stateStore.read({ conversationId: run.conversationId, runId: run.runId, agentId: member.id, namespace: args.namespace, path: args.path })
      record({ type: 'state.operation', agentId: member.id, data: { namespace: args.namespace, path: args.path, operation: 'read', version: result.version, after: result.value ?? null, afterMissing: result.value === undefined, valuesRecorded: true } })
      return result
    }
  })
  register({
    name: 'rp_team_state_version', description: 'Read a write-only CAS version without revealing the state value.',
    parameters: { namespace: { type: 'string', required: true }, path: { type: 'string', required: true } }, output,
    execute: args => stateStore.version({ conversationId: run.conversationId, runId: run.runId, agentId: member.id, namespace: args.namespace, path: args.path })
  })
  register({
    name: 'rp_team_write_state', description: 'Stage one declared state path for receipt-backed publication.',
    parameters: { namespace: { type: 'string', required: true }, path: { type: 'string', required: true }, value: { type: 'json', required: true }, expectedVersion: { type: 'integer', required: true } }, output,
    execute: async args => {
      if (!member.outputAuthority.state) throw teamError('RP_TEAM_OUTPUT_FORBIDDEN', `Agent ${member.id} has no state-write authority`)
      const beforeState = run.captureStateBefore?.(args.namespace, args.path)
      const before = observeStatePath(stateStore, run, args.namespace, args.path)
      const result = stateStore.write({ conversationId: run.conversationId, runId: run.runId, agentId: member.id, namespace: args.namespace, path: args.path, value: args.value, expectedVersion: args.expectedVersion })
      run.stateTransaction = stateStore.status({ conversationId: run.conversationId, runId: run.runId })
      record({ type: 'state.operation', agentId: member.id, data: { namespace: args.namespace, path: args.path, operation: 'write', version: args.expectedVersion + 1, ...before, after: args.value, valuesRecorded: true } })
      if (beforeState && run.notifyStateChanged) await run.notifyStateChanged(beforeState)
      else await run.scheduler?.notify()
      persistRun()
      return result
    }
  })
  register({
    name: 'rp_team_save_draft', description: 'Save a private or explicitly shared draft for configured agents.',
    parameters: { text: { type: 'string', required: true }, visibleTo: { type: 'array', items: { type: 'string' } }, draftId: { type: 'string' } }, output,
    execute: args => saveDraft(args)
  })
  register({
    name: 'rp_team_submit_internal', description: 'Store a structured internal result for run orchestration; it is not user-facing.',
    parameters: { summary: { type: 'string', required: true }, data: { type: 'json' } }, output,
    execute: (args, exec) => submitInternal({ ...args, summary: requiredSummary(args.summary) }, exec)
  })
  if (member.id === run.outputAgentId) register({
    name: 'rp_team_publish', description: 'Stage the sole user-facing response from the configured output agent.',
    parameters: { body: { type: 'string', required: true }, selectedDraftIds: { type: 'array', items: { type: 'string' } } }, output,
    execute: (args, exec) => publish(args, exec)
  })
  return () => { for (const dispose of disposers.reverse()) dispose?.() }
}

function losslessJson(value) { const serialized = JSON.stringify(value); return serialized === undefined ? {} : JSON.parse(serialized) }

function requiredSummary(value) {
  if (typeof value !== 'string' || !value.trim()) throw teamError('RP_TEAM_INVALID_REQUEST', 'summary is required')
  return value.trim()
}
