import { randomUUID } from 'node:crypto'
import { activePrivateState, openJournal, pickPaths } from './journal.mjs'

const textOf = message => (message.content ?? []).filter(block => block.type === 'text').map(block => block.text).join('\n')

// Ordinary tools and official DSH events own this proof of concept. It does not
// register any ElecKoi conversation lifecycle participant or alter host files.
export function createToolTeam(ctx, { defineTool, createScope, scopeOf, journalPath }) {
  const journal = openJournal(journalPath)
  const bindings = new Map()
  const rootBindings = new Map()
  const runningByRoot = new Map()
  const agentsById = new Map()
  const installedRoots = new WeakSet()
  const teardown = []
  const controller = new AbortController()
  const pending = new Set()
  const track = task => { pending.add(task); task.finally(() => pending.delete(task)).catch(() => {}); return task }
  function ownedAgentContext(agent) {
    const key = scopeOf(agent.ctx)
    if (!key) throw new Error('Native Agent has no public scope identity')
    const scope = createScope(ctx, key)
    teardown.push(() => scope.dispose())
    agent.ctx.effect(() => () => scope.dispose())
    return scope.ctx
  }

  const tool = (name, description, parameters, execute) => defineTool({
    name, description, parameters,
    output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    execute,
  })

  function installMember(agent, binding) {
    if (agentsById.has(agent.id)) return
    agentsById.set(agent.id, binding)
    const { run, member } = binding
    const memberCtx = ownedAgentContext(agent)
    // Mask inherited native product, workspace, discovery and team tools. Own
    // scoped tools remain visible. A monotonic guard also denies guessed calls.
    memberCtx.tools.restrict({ allow: [] })
    const allowed = new Set(['rp_tool_read', 'rp_tool_send', 'rp_tool_submit'])
    memberCtx.tools.guard(exec => {
      if (!allowed.has(exec.name)) return 'This member may only use its scoped team tools'
      if (exec.name !== 'rp_tool_read' && run.status !== 'running') return 'This recorded attempt is closed; start a new team run before changing it'
    })
    if (member.model) memberCtx.on('agent/request', async (_payload, next) => ({ ...await next(), ...member.model }))
    memberCtx.tools.register(tool('rp_tool_read', 'Read only this member’s authorized product fields.', {}, async (_args, exec) => {
      exec.signal.throwIfAborted()
      const state = ctx.eleckoiConversationsApi.authorState(run.conversationId)
      const details = ctx.eleckoiConversationsApi.details(run.conversationId)
      return {
        input: run.inputText,
        character: pickPaths(details.metadata.characterPersona, member.characterPaths ?? []),
        variables: pickPaths(JSON.parse(state.currentVariableStateJson), member.variablePaths ?? []),
        settings: (state.settingLibrary?.entries ?? []).filter(entry => (member.settingIds ?? []).includes(entry.id)),
        private: member.readPrivate ? (run.priorPrivate ?? {}) : {},
      }
    }))
    memberCtx.tools.register(tool('rp_tool_send', 'Send a short internal observation to an allowed team member.', {
      to: { type: 'string', required: true }, body: { type: 'string', required: true },
    }, async ({ to, body }, exec) => {
      if (!(member.sendTo ?? []).includes(to)) throw new Error('Message recipient is not permitted')
      const target = run.memberNames[to]
      if (!target) throw new Error('The requested member has not been registered')
      const onAbort = Promise.withResolvers()
      const abort = () => onAbort.reject(exec.signal.reason)
      exec.signal.addEventListener('abort', abort, { once: true })
      try { exec.signal.throwIfAborted(); await Promise.race([run.memberReady[to].promise, onAbort.promise]) }
      finally { exec.signal.removeEventListener('abort', abort) }
      return ctx.agentTeams.sendMessage(agent, { target, content: [{ type: 'text', text: body }], signal: exec.signal })
    }))
    memberCtx.tools.register(tool('rp_tool_submit', 'Submit a result and allowed plugin-owned state. This does not publish RP text.', {
      summary: { type: 'string', required: true },
      privateDelta: { type: 'json' }, productDelta: { type: 'json' },
    }, async ({ summary, privateDelta = {}, productDelta = {} }, exec) => {
      exec.signal.throwIfAborted()
      for (const key of Object.keys(privateDelta)) if (!(member.writePrivateKeys ?? []).includes(key)) throw new Error('Private state write is not permitted')
      for (const key of Object.keys(productDelta)) if (!(member.writeVariableKeys ?? []).includes(key)) throw new Error('Product state write is not permitted')
      run.results[member.id] = { summary, privateDelta, productDelta }
      return { accepted: true, memberId: member.id }
    }))
    agent.ctx.effect(() => () => agentsById.delete(agent.id))
  }

  teardown.push(ctx.on('agent/created', ({ agent }) => {
    const rootConfig = [...bindings.values()].find(config => config.rootSessionId === agent.id)
    if (rootConfig) { installRoot(agent, rootConfig); return }
    const inherited = agentsById.get(agent.session.header.parentSession)
    if (inherited) { installMember(agent, inherited); return }
    const historical = journal.document.runs.findLast(run => run.members.some(member => member.sessionId === agent.id))
    if (historical) {
      const memberId = historical.members.find(member => member.sessionId === agent.id).agentId
      const definition = historical.memberPolicies.find(member => member.id === memberId)
      installMember(agent, { run: historical, member: definition })
      return
    }
    const run = runningByRoot.get(agent.session.header.parentSession)
    if (!run) return
    const root = ctx.agents.get(run.rootSessionId)
    const registered = ctx.agentTeams.listMembers(root).find(member => member.id === agent.id)
    const definition = run.config.members.find(member => run.memberNames[member.id] === registered?.name)
    if (!definition) throw new Error('Native team member has no authorized configuration')
    installMember(agent, { run, member: definition })
  }))

  async function executeTeam(root, exec) {
    const input = rootBindings.get(root.id)
    if (!input) throw new Error('No actual user input has entered the current step')
    if (runningByRoot.has(root.id)) throw new Error('A team tool is already active in this conversation')
    const config = bindings.get(input.conversationId)
    const inspection = await ctx.sessionController.inspect(root.id, exec.signal)
    const activeOutputs = new Set(inspection.events.filter(event => event.type === 'assistant/message').map(event => event.data.message.id))
    if (journal.document.runs.some(run => run.rootSessionId === root.id && run.inputMessageId === input.message.id && (['running', 'awaiting-publication'].includes(run.status) || (run.status === 'committed' && activeOutputs.has(run.outputMessageId))))) throw new Error('This input already has a team attempt; retry through a new formal generation')
    const run = {
      id: randomUUID(), conversationId: input.conversationId, rootSessionId: root.id,
      inputMessageId: input.message.id, inputText: textOf(input.message), turn: input.turn,
      status: 'running', members: [], results: {}, privateDelta: {}, productDelta: {},
      memberPolicies: structuredClone(config.members),
      startedAt: new Date().toISOString(),
    }
    Object.defineProperties(run, {
      config: { value: structuredClone({ members: config.members, publisherId: config.publisherId, productWriteTiming: config.productWriteTiming }), enumerable: false },
      priorPrivate: { value: activePrivateState(journal.document.runs, input.conversationId, inspection.events), enumerable: false },
      memberNames: { value: Object.fromEntries(config.members.map(member => [member.id, `${member.id}-${run.id.slice(0, 8)}`])), enumerable: false },
      memberReady: { value: Object.fromEntries(config.members.map(member => [member.id, Promise.withResolvers()])), enumerable: false },
    })
    runningByRoot.set(root.id, run)
    journal.document.runs.push(run)
    journal.save()
    const signal = AbortSignal.any([exec.signal, controller.signal])
    const children = []
    const cancel = () => { for (const id of children) ctx.subagents.interrupt(id, { kind: 'ancestor', agent: root }) }
    signal.addEventListener('abort', cancel, { once: true })
    try {
      const task = await ctx.agentTeams.createTask(root, { subject: `Team tool ${run.id}`, description: 'Two-member scoped product reading and result assembly' })
      run.taskId = task.id
      const claimedTask = await ctx.agentTeams.updateTask(root, { taskId: task.id, expectedRevision: task.revision, action: 'claim' })
      for (const member of config.members) {
        signal.throwIfAborted()
        const created = await ctx.agentTeams.spawnTeammate(root, {
          name: run.memberNames[member.id], description: member.description ?? member.id,
          context: 'fresh', provider: 'spawn', signal,
          prompt: [{ type: 'text', text: `${member.systemPrompt}\nMember ID: ${member.id}\nRead your scoped rp_tool_read. Submit with rp_tool_submit. Do not publish to the user.` }],
        })
        children.push(created.member.id)
        run.members.push({ agentId: member.id, sessionId: created.member.id })
        run.memberReady[member.id].resolve()
        journal.save()
      }
      await Promise.all(children.map(async id => {
        const child = ctx.agents.get(id)
        if (child) await child.whenIdle()
        const inspection = await ctx.sessionController.inspect(id, signal)
        const ending = inspection.events.findLast(event => event.type === 'turn/end')
        if (ending?.data.reason.kind !== 'completed') throw new Error(`Member Session ${id} did not complete: ${JSON.stringify(ending?.data.reason)}`)
      }))
      signal.throwIfAborted()
      for (const member of config.members) {
        const result = run.results[member.id]
        if (!result) throw new Error(`Member ${member.id} did not submit a result`)
        for (const [key, value] of Object.entries(result.privateDelta)) {
          if (Object.hasOwn(run.privateDelta, key)) throw new Error(`Conflicting private state writes: ${key}`)
          run.privateDelta[key] = value
        }
        for (const [key, value] of Object.entries(result.productDelta)) {
          if (Object.hasOwn(run.productDelta, key)) throw new Error(`Conflicting product state writes: ${key}`)
          run.productDelta[key] = value
        }
      }
      // Exercise the public write API only when this deliberate probe mode is
      // selected. Product save conflicts are reported, never hidden by a retry.
      if (config.productWriteTiming === 'during-tool' && Object.keys(run.productDelta).length) {
        const current = JSON.parse(ctx.eleckoiConversationsApi.authorState(run.conversationId).currentVariableStateJson)
        run.productWrite = ctx.eleckoiConversationsApi.replaceVariableState(run.conversationId, JSON.stringify({ ...current, ...run.productDelta }))
      }
      await ctx.agentTeams.updateTask(root, { taskId: task.id, expectedRevision: claimedTask.revision, action: 'complete' })
      run.status = 'awaiting-publication'
      journal.save()
      return { runId: run.id, results: run.results, candidate: run.results[config.publisherId].summary, productDelta: run.productDelta }
    } catch (error) {
      run.status = signal.aborted ? 'cancelled' : 'failed'
      run.error = String(error.message ?? error)
      journal.save()
      cancel()
      throw error
    } finally {
      signal.removeEventListener('abort', cancel)
      await ctx.subagents.drainContinuableChildren(root, children)
      runningByRoot.delete(root.id)
    }
  }

  function installRoot(agent, config) {
    const key = scopeOf(agent.ctx)
    if (installedRoots.has(key)) return
    ownedAgentContext(agent).tools.register(tool('rp_team_run', 'Run the configured two-member team and return a candidate for normal RP publication.', {}, async (_args, exec) => track(executeTeam(agent, exec))))
    installedRoots.add(key)
  }
  teardown.push(ctx.on('agent/pre-step', async (payload, next) => {
    if (agentsById.has(payload.agent.id)) return next()
    const config = [...bindings.values()].find(binding => binding.rootSessionId === payload.agent.id)
    if (!config) return next()
    const actualInput = payload.messages.findLast(message => message.source?.kind === 'user')
    if (actualInput) rootBindings.set(payload.agent.id, { conversationId: config.conversationId, message: actualInput, turn: payload.turn })
    installRoot(payload.agent, config)
    const decision = await next()
    if (decision.kind !== 'enter') return decision
    const messages = decision.messages.filter(message => message.source?.kind !== 'subagent-settled')
    if (decision.messages.length && !messages.length && rootBindings.get(payload.agent.id)?.turn !== payload.turn) return { kind: 'reject' }
    return { ...decision, messages }
  }))

  teardown.push(ctx.on('session/event', (session, event) => {
    const run = journal.document.runs.findLast(item => item.rootSessionId === session.id && item.turn === event.data?.turn && item.status === 'awaiting-publication')
    if (!run) return
    if (event.type === 'assistant/message') { run.outputMessageId = event.data.message.id; journal.save() }
    if (event.type === 'turn/end' && event.data.reason.kind !== 'completed') {
      run.status = event.data.reason.kind === 'aborted' ? 'cancelled' : 'failed'
      journal.save()
    }
  }))

  // Public invalidations are observations, not a product transaction hook. The
  // one-active-tool-per-conversation rule is explicit. Interrupted outstanding
  // attempts stay unknown on restart; models are never automatically replayed.
  const changes = track((async () => {
    for await (const change of ctx.eleckoiConversationsApi.changes(controller.signal)) {
      if (change.kind !== 'generation') continue
      const run = journal.document.runs.findLast(item => item.conversationId === change.conversationId && item.status === 'awaiting-publication')
      if (!run) continue
      run.status = change.error ? 'product-save-failed' : run.outputMessageId ? 'committed' : 'unknown'
      if (change.error) run.error = change.error
      journal.save()
    }
  })())

  const api = {
    bind(conversationId, config) {
      if (config.members.length !== 2 || new Set(config.members.map(member => member.id)).size !== 2) throw new Error('The proof requires exactly two independently identified members')
      if (!config.members.some(member => member.id === config.publisherId)) throw new Error('Publisher does not exist')
      const details = ctx.eleckoiConversationsApi.details(conversationId)
      bindings.set(conversationId, { ...structuredClone(config), conversationId, rootSessionId: details.runtimeSessionId })
      const root = ctx.agents.get(details.runtimeSessionId)
      if (root) installRoot(root, bindings.get(conversationId))
    },
    runs: () => structuredClone(journal.document.runs),
    async state(conversationId) {
      const { runtimeSessionId } = ctx.eleckoiConversationsApi.details(conversationId)
      const inspection = await ctx.sessionController.inspect(runtimeSessionId)
      return activePrivateState(journal.document.runs, conversationId, inspection.events)
    },
  }
  for (const run of journal.document.runs) if (['running', 'awaiting-publication'].includes(run.status)) run.status = 'unknown'
  journal.save()
  return { api, async dispose() {
    controller.abort(new Error('Team tool plugin stopped'))
    for (const stop of teardown.reverse()) await stop()
    await changes
    await Promise.allSettled([...pending])
  } }
}
