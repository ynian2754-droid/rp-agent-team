import { observeStatePath } from './execution-trace.mjs'
import { teamError } from '../shared/schema.mjs'
import { buildAgentContext } from './context-policy.mjs'
import { chronicleProvenanceData } from './lived-history-chronicle.mjs'
import { directDraftReviewParameters } from './lived-history-review.mjs'
import { draftPresentationParameter, writerPresentationParameter } from './lived-history-publication.mjs'
import { focusedWorldStartParameters, focusedWorldStartParametersWithSceneCues } from './lived-history-world.mjs'
import { normalizeSimulationSubmission, typedSimulationParameters } from './lived-history-simulation.mjs'

/** Register the scheduled agent's collaboration, state, draft, and publication tools. */
export function registerTeamTools({
  agentCtx, defineTool, member, run, stateStore,
  assertActiveCaller, assertInternalAuthority, requestDepth, requestExecutionId,
  record, persistRun, saveDraft, submitInternal, publish, simulation, simulationSubmitParameters, scopedReview, chronicle, requestWithPublication,
  singleGroup, worldStart, worldSubmit, requestWorldWithPresentation, writerPresentationReview
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
  const directDraftReview = scopedReview === 'draft' && member.execution?.livedHistoryDirectDraftReview
  const reviewPresentation = directDraftReview && member.execution.livedHistoryReviewPresentation && !writerPresentationReview
  const passageChoices = reviewPresentation && member.execution.livedHistoryPassageChoices
  const typedSimulation = simulation && (simulationSubmitParameters ?? (member.execution?.livedHistoryTypedSimulation && typedSimulationParameters))
  register({
    name: 'rp_team_submit_internal',
    description: directDraftReview ? `Submit the verdict for this draft${passageChoices ? ' and the numbers of its ledger evidence passages'
      : reviewPresentation ? ' and its ledger presentation excerpts' : ' with pass and issues'}.` : simulation
      ? 'Submit complete beats and stateOps together. Accepted output stages all valid changes and ends this activation.'
      : scopedReview ? 'Submit the verdict for this exact handoff with data {pass, issues}.'
      : chronicle ? 'Submit the chronicle batch once with data {state, events}. The host validates and stages it atomically.'
      : 'Store a structured internal result. For a terminal handoff, submit only after all other work; an accepted result ends this activation.',
    parameters: directDraftReview ? { ...directDraftReviewParameters, ...(reviewPresentation ? { presentation: draftPresentationParameter(passageChoices) } : {}) }
      : typedSimulation || { summary: { type: 'string', required: true },
      data: chronicle && member.execution.livedHistoryPhase === 'chronicleProvenance'
        ? chronicleProvenanceData : { type: 'json' } }, output,
    execute: directDraftReview
      ? ({ pass, issues, presentation }, exec) => submitInternal({ summary: pass ? '核验通过' : '核验发现问题', data: { pass, issues },
        ...(reviewPresentation ? { presentation } : {}) }, exec)
      : (args, exec) => submitInternal({ ...args, summary: requiredSummary(args.summary),
        ...(typedSimulation ? { data: normalizeSimulationSubmission(args.data) } : {}) }, exec)
  })
  if (simulation || scopedReview || chronicle) return () => { for (const dispose of disposers.reverse()) dispose?.() }
  if (singleGroup) {
    register({
      name: 'rp_team_clerk_single_group',
      description: 'Select evidence for the sole eligible actor once. The host requests their simulation, runs the configured review and retry, then returns the accepted result to world.',
      parameters: { summary: { type: 'string', required: true }, selection: { type: 'json', required: true } },
      output, execute: singleGroup
    })
    return () => { for (const dispose of disposers.reverse()) dispose?.() }
  }
  const preparedWorld = member.execution?.livedHistoryPreparedWorldClose
  if (worldStart) register({
    name: 'rp_team_world_start',
    description: 'Append verbatim-derived user stimuli once. Supply file to start the clerk immediately; omit file only for an adjudication without simulation. Pass an optional independent settings log update separately.',
    parameters: member.execution?.livedHistoryFocusedWorld
      ? {
        ...(member.execution.livedHistorySceneCues ? focusedWorldStartParametersWithSceneCues : focusedWorldStartParameters),
        ...(preparedWorld ? { background: { type: 'object', additionalProperties: false, properties: {
          events: { type: 'json', description: 'Ordered {key, record} entries for wall-clock or offstage facts already certain without actor results.' },
          worldPatch: { type: 'json', description: 'Changed clocks, agendas, or offstage_until already certain without actor results.' }
        } } } : {})
      } : {
      summary: { type: 'string', required: true }, stimuli: { type: 'json', required: true }, file: { type: 'json' },
      settingsLog: { type: 'json' }
    }, output, execute: worldStart
  })
  if (worldSubmit) register({
    name: 'rp_team_world_submit',
    description: 'Validate and submit the adjudication and its ordered events, hidden records and state writes atomically. Accepted submission ends this activation.',
    parameters: {
      summary: { type: 'string', required: true }, data: { type: 'json', required: true }, events: { type: 'json' },
      hidden: { type: 'json' }, state: { type: 'json' },
      ...(preparedWorld ? { worldPatch: { type: 'json', description: 'Changed now fields and situations by name, plus changed clocks, agendas, ties, or offstage_until. Omit unchanged and prepared fields.' } } : {})
    }, output, execute: worldSubmit
  })
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
      summary: { type: 'string' }, data: { type: 'json' }, reason: { type: 'string' }, topic: { type: 'string' },
      ...(member.communication?.handoffs?.some(rule => rule.autoPublish)
        ? { publishOnPass: { type: 'boolean', description: 'Authorize exact publication of this draft on approval for an enabled review handoff.' } }
        : {}),
      ...(member.execution?.livedHistoryWriterPresentation ? { presentation: writerPresentationParameter() } : {})
    }, output,
    execute: (args, exec) => {
      assertInternalAuthority()
      if (args.publishOnPass === true) return requestWithPublication(args, exec)
      if (args.handoffId === 'ask-world' && requestWorldWithPresentation) return requestWorldWithPresentation(args, exec)
      return run.communication.request({
        from: member.id, to: args.to, body: args.body, handoffId: args.handoffId,
        summary: args.summary, data: args.data, topic: args.topic, depth: requestDepth(exec.agent),
        reason: args.reason, executionId: requestExecutionId(exec.agent), presentation: args.presentation
      })
    }
  })
  if (new Set(member.communication?.handoffs?.filter(rule => rule.mode === 'await' && rule.parallel).map(rule => rule.to)).size > 1) register({
    name: 'rp_team_request_many', description: 'Start independent, parallel-enabled await handoffs to distinct agents and wait once for the ordered results.',
    parameters: { requests: { type: 'array', required: true, description: 'At least two independent requests.', items: {
      type: 'object', additionalProperties: false, properties: {
        to: { type: 'string', required: true }, handoffId: { type: 'string', required: true },
        summary: { type: 'string' }, data: { type: 'json' }, topic: { type: 'string' }, reason: { type: 'string' }
      }
    } } }, output,
    execute: (args, exec) => {
      assertInternalAuthority()
      return run.communication.requestMany({
        from: member.id, requests: args.requests, depth: requestDepth(exec.agent), executionId: requestExecutionId(exec.agent)
      })
    }
  })
  register({
    name: 'rp_team_read_messages', description: 'Read messages this agent is authorized to receive.',
    isConcurrencySafe: () => true,
    parameters: { from: { type: 'array', items: { type: 'string' } } }, output,
    execute: args => {
      const messages = run.communication.messagesFor(member.id, args.from)
      return { messages: buildAgentContext(member, {}, { messages }).sources.agent_messages ?? [] }
    }
  })
  register({
    name: 'rp_team_read_state', description: 'Read one declared state path allowed by this agent’s state permissions.',
    isConcurrencySafe: () => true,
    parameters: { namespace: { type: 'string', required: true }, path: { type: 'string', required: true } }, output,
    execute: args => {
      const result = stateStore.read({ conversationId: run.conversationId, runId: run.runId, agentId: member.id, namespace: args.namespace, path: args.path })
      record({ type: 'state.operation', agentId: member.id, data: { namespace: args.namespace, path: args.path, operation: 'read', version: result.version, after: result.value ?? null, afterMissing: result.value === undefined, valuesRecorded: true } })
      return result
    }
  })
  register({
    name: 'rp_team_state_version', description: 'Read a write-only CAS version without revealing the state value.',
    isConcurrencySafe: () => true,
    parameters: { namespace: { type: 'string', required: true }, path: { type: 'string', required: true } }, output,
    execute: args => stateStore.version({ conversationId: run.conversationId, runId: run.runId, agentId: member.id, namespace: args.namespace, path: args.path })
  })
  register({
    name: 'rp_team_write_state', description: 'Stage one declared state path for receipt-backed publication.',
    parameters: { namespace: { type: 'string', required: true }, path: { type: 'string', required: true }, value: { type: 'json', required: true }, expectedVersion: { type: 'integer', required: true } }, output,
    execute: async args => {
      if (!member.outputAuthority.state) throw teamError('RP_TEAM_OUTPUT_FORBIDDEN', `Agent ${member.id} has no state-write authority`)
      const beforeState = run.captureStateBefore?.(args.namespace, args.path, member.id)
      const before = observeStatePath(stateStore, run, args.namespace, args.path)
      const result = stateStore.write({ conversationId: run.conversationId, runId: run.runId, agentId: member.id, namespace: args.namespace, path: args.path, value: args.value, expectedVersion: args.expectedVersion })
      run.stateTransaction = stateStore.status({ conversationId: run.conversationId, runId: run.runId })
      const { version } = stateStore.version({ conversationId: run.conversationId, runId: run.runId, agentId: member.id, namespace: args.namespace, path: args.path })
      record({ type: 'state.operation', agentId: member.id, data: { namespace: args.namespace, path: args.path, operation: 'write', version, ...before, after: args.value, valuesRecorded: true } })
      if (beforeState && run.notifyStateChanged) await run.notifyStateChanged(beforeState)
      else await run.scheduler?.notify()
      persistRun()
      return result
    }
  })
  register({
    name: 'rp_team_remove_state', description: 'Stage removal of a declared object property with state authority, ACL and CAS checks. World setting deletion is unsupported.',
    parameters: { namespace: { type: 'string', required: true }, path: { type: 'string', required: true }, expectedVersion: { type: 'integer', required: true } }, output,
    execute: async args => {
      if (!member.outputAuthority.state) throw teamError('RP_TEAM_OUTPUT_FORBIDDEN', `Agent ${member.id} has no state-write authority`)
      const beforeState = run.captureStateBefore?.(args.namespace, args.path, member.id)
      const before = observeStatePath(stateStore, run, args.namespace, args.path)
      const result = stateStore.remove({ conversationId: run.conversationId, runId: run.runId, agentId: member.id, namespace: args.namespace, path: args.path, expectedVersion: args.expectedVersion })
      run.stateTransaction = stateStore.status({ conversationId: run.conversationId, runId: run.runId })
      const { version } = stateStore.version({ conversationId: run.conversationId, runId: run.runId, agentId: member.id, namespace: args.namespace, path: args.path })
      record({ type: 'state.operation', agentId: member.id, data: { namespace: args.namespace, path: args.path, operation: 'remove', version, ...before, afterMissing: true, valuesRecorded: true } })
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
  if (member.id === run.outputAgentId) register({
    name: 'rp_team_publish', description: 'Stage the sole user-facing response. Supply only one of body text or bodyRef, a request-side /draft reference to an approved handoff.',
    parameters: { body: { type: 'string' }, bodyRef: { type: 'json' }, selectedDraftIds: { type: 'array', items: { type: 'string' } } }, output,
    execute: (args, exec) => publish(args, exec)
  })
  return () => { for (const dispose of disposers.reverse()) dispose?.() }
}

function losslessJson(value) { const serialized = JSON.stringify(value); return serialized === undefined ? {} : JSON.parse(serialized) }

function requiredSummary(value) {
  if (typeof value !== 'string' || !value.trim()) throw teamError('RP_TEAM_INVALID_REQUEST', 'summary is required')
  return value.trim()
}
