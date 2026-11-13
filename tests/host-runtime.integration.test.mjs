import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { createRpAgentTeam } from '../src/host/runtime.mjs'
import { runFilePath } from '../src/host/run-persistence.mjs'
import { TEAM_DELIVERY_MODEL, TEAM_DELIVERY_PROVIDER } from '../src/host/delivery-adapter.mjs'
import { defaultTeamConfig } from '../src/shared/schema.mjs'

const CONVERSATION_ID = 'native-hook-conversation'
const ROOT_SESSION_ID = 'native-root-session'
const INPUT_ID = 'native-input-message'

function nativeTurnReason(previousReason, decision, step) {
  if (decision.kind === 'reject') return { kind: 'blocked' }
  if (previousReason && decision.messages.length === 0) return previousReason
  if (step === 1 && decision.messages.length === 0) return { kind: 'completed' }
  return undefined
}

function fixture({ receiptOutcome = 'pending', preparedTurn = 1, sessionListed = true,
  stageGate, stageError, onStageRequest, receiptGate, onReceiptQuery } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'rp-team-native-hooks-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const globalHooks = new Map()
  const scopes = new Map()
  const agents = new Map()
  const nativeMembers = []
  const sessionEvents = new Map()
  const registeredAdapters = []
  const stageCalls = []
  const invokedTools = []
  const childRequests = []
  const childContextReads = []
  const childTasks = new Set()
  const presetBindings = new Map()
  const registeredPresetDefinitions = []
  const nativePresetRegistrations = new Map()
  const presetSelections = []
  let nextChildId = 1
  let seq = 4
  let preparedAvailable = false
  let preparedRoute
  let rootStepSelection
  let currentTurnLookups = 0
  let runtime
  let uninstallRuntimeHooks
  let disposed = false
  let rootAssistantAppended = false
  let rootAssistantSeq
  let receipt = { outcome: receiptOutcome }
  let nativeTools
  let prepared = {
    conversationId: CONVERSATION_ID, sessionId: ROOT_SESSION_ID, operationId: 'prepared-op-1',
    turn: preparedTurn, inputMessageId: INPUT_ID, inputEventSeq: 7, worldHash: 'world-hash-1',
    model: { provider: 'frozen-provider', model: 'frozen-model', reasoningEffort: 'high' }
  }
  const inputMessage = {
    id: INPUT_ID, role: 'user', content: [{ type: 'text', text: 'Continue from the doorway.' }],
    source: { kind: 'user', rpcId: 'rpc-input-1' }
  }
  sessionEvents.set(ROOT_SESSION_ID, [
    { type: 'user/message', seq: 1, data: { id: 'prior-user', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'Earlier scene.' }] } },
    { type: 'user/message', seq: 2, data: { id: 'runtime-context-history', role: 'user', source: { kind: 'runtime-context' }, content: [{ type: 'text', text: 'Injected context must not count.' }] } },
    { type: 'assistant/message', seq: 3, data: { turn: 0, message: { id: 'prior-assistant', role: 'assistant', content: [{ type: 'text', text: 'A quiet arrival.' }] } } },
    { type: 'user/message', seq: 4, data: { id: 'settled-history', role: 'user', source: { kind: 'subagent-settled', senderSessionId: 'native-child-1' }, content: [{ type: 'text', text: 'Child notice must not count.' }] } }
  ])

  function onHook(bucket, name, listener, options = {}) {
    const list = bucket.get(name) ?? []
    if (options.prepend) list.unshift(listener)
    else list.push(listener)
    bucket.set(name, list)
    return () => {
      const index = list.indexOf(listener)
      if (index >= 0) list.splice(index, 1)
    }
  }

  function scopeFor(key) {
    let scope = scopes.get(key)
    if (scope) return scope
    const localTools = new Map()
    const guards = []
    const declarationFilters = []
    const systemSections = []
    const listeners = new Map()
    const baseTools = [
      { name: 'eleckoi_read_variables' },
      { name: 'eleckoi_apply_variable_patch' },
      { name: 'ordinary_extension_tool' }
    ]
    const tools = {
      register(definition) {
        localTools.set(definition.name, definition)
        return () => localTools.delete(definition.name)
      },
      schemas() {
        return [...baseTools, ...localTools.values()].filter(declaration => declarationFilters.every(accept => accept(declaration)))
      },
      restrictDeclarations(accept) {
        declarationFilters.push(accept)
        return () => { const index = declarationFilters.indexOf(accept); if (index >= 0) declarationFilters.splice(index, 1) }
      },
      guard(guard) {
        guards.push(guard)
        return () => { const index = guards.indexOf(guard); if (index >= 0) guards.splice(index, 1) }
      },
      async invoke(name, args = {}, agent, signal = new AbortController().signal) {
        const execution = { name, agent, signal, concludeTurn() {} }
        if (declarationFilters.some(accept => !accept(localTools.get(name) ?? { name }))) throw new Error(`Tool "${name}" is denied in this scope`)
        for (const guard of guards) {
          const denial = guard(execution)
          if (denial) throw new Error(denial === true ? `Tool "${name}" is not authorized` : String(denial))
        }
        invokedTools.push({ sessionId: agent?.session?.id, name })
        const tool = localTools.get(name)
        if (!tool) return { inherited: true, name }
        return await tool.execute(args, execution)
      },
      localTools, guards, declarationFilters
    }
    const ctx = {
      tools,
      systemPrompt: {
        section(section) { systemSections.push(section); return () => { const i = systemSections.indexOf(section); if (i >= 0) systemSections.splice(i, 1) } },
        getSectionOrder() { return 0 },
        async assemble(assembly, context, next = async () => assembly) {
          const listenersForEvent = listeners.get('system-prompt/assemble') ?? []
          async function invoke(index) {
            if (index >= listenersForEvent.length) return await next()
            return await listenersForEvent[index](assembly, context, () => invoke(index + 1))
          }
          return await invoke(0)
        }
      },
      on(name, listener, options) { return onHook(listeners, name, listener, options) },
      effect() {},
      async dispatch(name, event, next = async () => ({})) {
        const listenersForEvent = listeners.get(name) ?? []
        async function invoke(index) {
          if (index < 0) return await next()
          return await listenersForEvent[index](event, () => invoke(index - 1))
        }
        return await invoke(listenersForEvent.length - 1)
      },
      listeners
    }
    scope = { key, ctx, dispose() { for (const toolsRow of [...localTools.values()]) localTools.delete(toolsRow.name); listeners.clear() } }
    scopes.set(key, scope)
    return scope
  }

  const rootAgent = makeAgent(ROOT_SESSION_ID, 'root-scope', undefined, {
    agentPreset: 'base-preset', disabledToolGroupIds: []
  })
  agents.set(ROOT_SESSION_ID, rootAgent)

  const ctx = {
    on(name, listener, options) { return onHook(globalHooks, name, listener, options) },
    agents: { get: id => agents.get(String(id)) },
    tools: { schemas: () => [{ name: 'eleckoi_read_variables' }, { name: 'eleckoi_apply_variable_patch' }] },
    agentPresets: {
      async list() { return [
        { id: 'base-preset', name: 'Base preset' },
        { id: 'member-preset', name: 'Member preset' },
        ...[...nativePresetRegistrations.values()].map(({ id, name }) => ({ id, name }))
      ] },
      async acquireScope(id) {
        assert.ok(['base-preset', 'member-preset'].includes(id))
        return { key: `${id}-scope`, async [Symbol.asyncDispose]() {} }
      },
      async readDocument(id) {
        assert.equal(id, 'member-preset')
        return {
          agentPreset: id, name: 'Member preset',
          content: JSON.stringify([{ id: 'compaction-basic', config: { thresholdRatio: 0.9 } }])
        }
      },
      async register(definition) {
        registeredPresetDefinitions.push(structuredClone(definition))
        if (nativePresetRegistrations.has(definition.id)) throw new Error(`Duplicate preset ${definition.id}`)
        nativePresetRegistrations.set(definition.id, structuredClone(definition))
        return async () => { nativePresetRegistrations.delete(definition.id) }
      },
      async resolve(id) {
        if (!nativePresetRegistrations.has(id) && !['base-preset', 'member-preset'].includes(id)) {
          throw new Error(`Unknown preset ${id}`)
        }
        return { id }
      },
      composedPreset(agentCtx) {
        return presetBindings.get(String(agentCtx.scope))
      },
      async select(agent, id) {
        presetBindings.set(String(agent.ctx.scope), id)
        presetSelections.push({ sessionId: agent.session.id, agentPreset: id })
        await agent.session.append('agent-preset/selected', { agentPreset: id })
      }
    },
    agentTeams: {
      listMembers: () => [...nativeMembers],
      interrupt() {},
      async spawnTeammate(root, specification) {
        const childId = `native-child-${nextChildId++}`
        const child = makeAgent(childId, `scope-${childId}`, root.session.id, { agentPreset: 'base-preset', disabledToolGroupIds: [] })
        // DSH composes the parent Agent's current public preset onto the
        // child before emitting agent/created. The immutable creation header
        // can still contain the older preset ID.
        presetBindings.set(String(child.ctx.scope), ctx.agentPresets.composedPreset(root.ctx))
        nativeMembers.push({ id: childId, name: specification.name, description: specification.description })
        agents.set(childId, child)
        await emitGlobal('agent/created', { agent: child })
        const task = new Promise(resolve => setImmediate(resolve)).then(async () => {
          const childScope = scopeFor(child.ctx.scope)
          await emitGlobal('agent/prepare-step', { agent: child, turn: 1, step: 1, signal: AbortSignal.timeout(2000) })
          const selection = child.model.current()
          const model = await childScope.ctx.dispatch('agent/request', { turn: 1 }, async () => ({ ...selection, temperature: 0.6 }))
          assert.equal(model.provider, selection.provider)
          assert.equal(model.model, selection.model)
          assert.equal(model.reasoningEffort, selection.reasoningEffort)
          const requestAssembly = await childScope.ctx.systemPrompt.assemble({
            tools: childScope.ctx.tools.schemas()
          }, { agent: child, scope: child.ctx.scope })
          childRequests.push({ sessionId: childId, model, tools: requestAssembly.tools,
            agentPreset: ctx.agentPresets.composedPreset(child.ctx) })
          if (childId === 'native-child-1') {
            await assert.rejects(() => childScope.ctx.tools.invoke('eleckoi_apply_variable_patch', {}, child), /denied|not authorized/u)
            childContextReads.push(await childScope.ctx.tools.invoke('rp_team_read_context', { source: 'worldbook' }, child))
            childContextReads.push(await childScope.ctx.tools.invoke('rp_team_read_context', { source: 'recent_history' }, child))
            // The member's own model request passes the llm/stream hook while its activation is running.
            await dispatchLlmStream({ sessionId: childId, provider: model.provider, model: model.model,
              messages: [{ role: 'user', content: 'member request' }] }, async () => ({}))
            await childScope.ctx.tools.invoke('rp_team_submit_internal', { summary: 'Observed the doorway.' }, child)
          } else {
            await childScope.ctx.tools.invoke('rp_team_publish', { body: 'The door opened onto the rain-lit street.' }, child)
          }
          await emitSessionEvent(child.session, {
            type: 'turn/end', seq: seq++, data: { turn: 1, reason: { kind: 'completed' } }
          })
        })
        childTasks.add(task)
        void task.finally(() => childTasks.delete(task))
        return { member: { id: childId, name: specification.name } }
      }
    },
    subagents: { async drainChildren(_root, ids) { assert.deepEqual(ids.length, 2) } },
    sessionQuery: { async observeSession(sessionId) {
      return { events: sessionEvents.get(String(sessionId)) ?? [], [Symbol.dispose]() {} }
    } },
    sessionController: { async cancel() { return { cancelled: true } } },
    llm: {
      registerAdapter(providers, adapter) {
        registeredAdapters.push({ providers, adapter })
        return () => undefined
      },
      listProviders: () => [{ id: 'frozen-provider' }],
      listModels: () => [{ id: 'frozen-model', provider: 'frozen-provider' }],
      async resolveModelInfo(provider, model) {
        return { provider, id: model, reasoning: { efforts: [{ id: 'high' }] }, context: { contextWindow: 1000 } }
      }
    },
    eleckoiConversationsApi: {
      async list() {
        return sessionListed ? [{ id: CONVERSATION_ID, runtimeSessionId: ROOT_SESSION_ID }] : []
      },
      preparedTurn({ sessionId }) {
        return preparedRoute?.sessionId === sessionId ? structuredClone(preparedRoute) : null
      },
      async currentTurn(input = {}) {
        currentTurnLookups++
        if (!preparedAvailable) return null
        if (input.conversationId && input.conversationId !== prepared.conversationId) return null
        if (input.sessionId && input.sessionId !== prepared.sessionId) return null
        return structuredClone(prepared)
      },
      async authorState(conversationId) {
        assert.equal(conversationId, CONVERSATION_ID)
        return {
          currentVariableStateJson: '{"scene":{"mood":"quiet"}}', variableConfig: null,
          editableSettingLibrary: {
            groups: [{ id: 'group-1', name: 'Rules', metadata: { private: 'raw source detail' } }],
            entries: [{ id: 'setting-1', groupId: 'group-1', title: 'Street', content: '{{weather}}' },
              { id: 'unselected-setting', title: 'Other', content: 'raw sibling' }]
          },
          settingLibrary: { groups: [], entries: [{ id: 'setting-1', title: 'Street', content: 'Rain outside.' }] }
        }
      },
      async details(conversationId) {
        assert.equal(conversationId, CONVERSATION_ID)
        return { metadata: {
          characterId: 'synthetic-character', characterName: 'Aster',
          characterPersona: { description: 'A careful traveler.', hiddenInstruction: 'must not leak by default' }
        } }
      },
      async stageTurnState(input) {
        stageCalls.push(structuredClone(input))
        const ack = { outcome: 'pending', conversationId: input.conversationId, runId: input.runId, operationId: input.operationId }
        receipt = { ...ack }
        onStageRequest?.(structuredClone(input))
        if (stageGate) await stageGate
        if (stageError) throw stageError
        return { ...ack }
      },
      async turnCommitStatus({ conversationId, runId }) {
        onReceiptQuery?.()
        if (receiptGate) await receiptGate
        return { ...receipt, conversationId, runId, active: receipt.outcome === 'committed' }
      },
      async editCurrentState() { throw new Error('not used by this fixture') },
      async stateEditStatus() { return { outcome: 'unknown' } },
      async listStateEdits() { return { edits: [] } }
    },
    eleckoiConversationModelsApi: {
      async current(conversationId) {
        assert.equal(conversationId, CONVERSATION_ID)
        return structuredClone(prepared.model)
      }
    }
  }
  nativeTools = ctx.tools
  rootAgent.ctx.tools = nativeTools

  function makeAgent(id, scope, parentSession, header = {}) {
    if (!sessionEvents.has(id)) sessionEvents.set(id, [])
    const session = {
      id,
      header: { ...(parentSession ? { parentSession } : {}), ...header },
      snapshotEvents: () => [...(sessionEvents.get(id) ?? [])],
      async append(type, data) {
        await emitSessionEvent(session, { type, seq: seq++, data })
      }
    }
    presetBindings.set(String(scope), header.agentPreset)
    let selection = structuredClone(prepared.model)
    return {
      id, session, model: {
        current: () => selection,
        select(value) { selection = structuredClone(value) }
      }, ctx: {
        scope, effect() {}, tools: nativeTools,
        systemPrompt: { section() { return () => undefined }, getSectionOrder() { return 0 } }
      },
      cancel() {}, whenIdle: async () => undefined
    }
  }

  async function emitGlobal(name, ...args) {
    const listeners = globalHooks.get(name) ?? []
    for (const listener of listeners) await listener(...args)
  }

  async function dispatchPreStep(event, next = async () => ({ kind: 'enter', messages: event.messages })) {
    const listeners = globalHooks.get('agent/pre-step') ?? []
    async function invoke(index) {
      if (index < 0) return await next()
      return await listeners[index](event, () => invoke(index - 1))
    }
    return await invoke(listeners.length - 1)
  }

  async function dispatchLlmStream(options, next) {
    const listeners = globalHooks.get('llm/stream') ?? []
    async function invoke(index) {
      if (index < 0) return await next()
      return await listeners[index](options, () => invoke(index - 1))
    }
    return await invoke(listeners.length - 1)
  }

  async function emitSessionEvent(session, event) {
    const events = sessionEvents.get(String(session.id)) ?? []
    events.push(structuredClone(event))
    sessionEvents.set(String(session.id), events)
    for (const listener of globalHooks.get('session/event') ?? []) await listener(session, event)
  }

  function createRuntime() {
    return createRpAgentTeam(ctx, {
      defineTool: definition => definition,
      parseYaml: JSON.parse,
      stringifyYaml: JSON.stringify,
      scopeOf: agentCtx => agentCtx.scope,
      createScope: (agentCtx, key) => {
        if (!agentCtx?.systemPrompt) throw new Error('cannot get property "systemPrompt" without inject')
        assert.ok(agentCtx.tools, 'an Agent child scope must inherit the native tools injection')
        return scopeFor(key)
      }
    })
  }

  runtime = createRuntime()
  uninstallRuntimeHooks = runtime.install()

  return {
    ctx, rootAgent, scopes, registeredAdapters, stageCalls, childRequests, childContextReads, invokedTools,
    registeredPresetDefinitions, presetSelections, presetBindings,
    sessionEvents,
    emitSessionEvent, dispatchPreStep, dispatchLlmStream,
    get runtime() { return runtime },
    get spawnCount() { return nextChildId - 1 },
    get currentTurnLookups() { return currentTurnLookups },
    async configure(config = defaultTeamConfig(), { enabled = true, expectedRevision = 0 } = {}) {
      if (config.agents?.[0] && !config.agents[0].context.sources.some(source => source.type === 'worldbook')) {
        config.agents[0].context.sources.push({ type: 'worldbook' })
      }
      return await runtime.api.saveConfig({
        conversationId: CONVERSATION_ID, expectedRevision,
        enabled, config
      })
    },
    async startRootTurn({ turn = prepared.turn, message = inputMessage } = {}) {
      await emitGlobal('agent/created', { agent: rootAgent })
      await emitSessionEvent(rootAgent.session, { type: 'turn/start', seq: seq++, data: { turn } })
      preparedRoute = sessionListed && message.source?.kind === 'user' ? { ...prepared, turn } : undefined
      if (sessionListed) rootAgent.model.select(prepared.model)
      const signal = AbortSignal.timeout(2000)
      await emitGlobal('agent/prepare-step', { agent: rootAgent, turn, step: 1, signal })
      rootStepSelection = rootAgent.model.current()
      const decision = await dispatchPreStep({
        agent: rootAgent, turn, step: 1, messages: [message], signal
      }, async () => ({ kind: 'enter', messages: [message] }))
      if (decision.kind === 'enter' && decision.messages.length > 0) {
        await emitSessionEvent(rootAgent.session, { type: 'step/start', seq: seq++, data: { turn, step: 1 } })
      }
      return { decision, message }
    },
    async prepareRootRequest({ turn = prepared.turn } = {}) {
      const rootScope = scopeFor(rootAgent.ctx.scope)
      const result = await rootScope.ctx.dispatch('agent/request', { turn }, async () => ({
        ...rootStepSelection, temperature: 0.8, topP: 0.7, maxTokens: 150
      }))
      assert.equal(result.provider, rootStepSelection.provider)
      assert.equal(result.model, rootStepSelection.model)
      assert.equal(result.reasoningEffort, rootStepSelection.reasoningEffort)
      return result
    },
    async runLocalDelivery({ messages = [{ role: 'user', id: INPUT_ID, content: 'Actual current input.' }], route, turn = prepared.turn } = {}) {
      route ??= await this.prepareRootRequest({ turn })
      if (route.provider !== TEAM_DELIVERY_PROVIDER || route.model !== TEAM_DELIVERY_MODEL) {
        return { body: '', route }
      }
      await emitSessionEvent(rootAgent.session, {
        type: 'system/message', seq: seq++, data: { turn, step: 1, message: { role: 'system', content: 'Committed system prompt.' } }
      })
      await emitSessionEvent(rootAgent.session, {
        type: 'user/message', seq: prepared.inputEventSeq, data: inputMessage
      })
      preparedAvailable = true
      await emitSessionEvent(rootAgent.session, {
        type: 'request/header', seq: seq++, data: { header: { config: { provider: route.provider, model: route.model } } }
      })
      const options = {
        sessionId: rootAgent.session.id, provider: route.provider, model: route.model,
        requestId: 'native-local-request', messages, signal: new AbortController().signal
      }
      const source = registeredAdapters.at(-1).adapter.stream(options)
      let body = ''
      for await (const chunk of source) if (chunk.type === 'text-delta') body += chunk.text
      await Promise.all([...childTasks])
      return { body, route }
    },
    async appendRootAssistant(body = 'The door opened onto the rain-lit street.') {
      if (rootAssistantAppended) return rootAssistantSeq
      rootAssistantSeq = seq++
      await emitSessionEvent(rootAgent.session, {
        type: 'assistant/message', seq: rootAssistantSeq, data: {
          turn: prepared.turn,
          message: { id: 'native-assistant-message', role: 'assistant', content: [{ type: 'text', text: body }] }
        }
      })
      rootAssistantAppended = true
      return rootAssistantSeq
    },
    async commitRootTurn(body = 'The door opened onto the rain-lit street.', reason = { kind: 'completed' }) {
      const assistantSeq = await this.appendRootAssistant(body)
      receipt = {
        outcome: 'committed', conversationId: CONVERSATION_ID, runId: stageCalls.at(-1)?.runId,
        operationId: prepared.operationId, sessionId: ROOT_SESSION_ID, turn: prepared.turn,
        inputMessageId: INPUT_ID, assistantMessageId: 'native-assistant-message', assistantSeq,
        baseHash: 'world-hash-1', active: true
      }
      await emitSessionEvent(rootAgent.session, {
        type: 'turn/end', seq: seq++, data: { turn: prepared.turn, reason }
      })
      for (let attempt = 0; attempt < 30; attempt++) {
        const status = await runtime.api.getStatus({ conversationId: CONVERSATION_ID })
        if (status.run?.phase === 'complete') return status
        await new Promise(resolve => setTimeout(resolve, 5))
      }
      return await runtime.api.getStatus({ conversationId: CONVERSATION_ID })
    },
    setReceipt(value) { receipt = { ...value } },
    setPreparedTurn(turn) {
      prepared = { ...prepared, turn, inputEventSeq: seq + 1, operationId: `prepared-op-${turn}` }
    },
    dropPersistedTopLevelStageFlag(runId) {
      const traceRoot = join(dirname(runtime.authoring.store.path), 'traces')
      const path = runFilePath(traceRoot, CONVERSATION_ID, runId)
      const row = JSON.parse(readFileSync(path, 'utf8'))
      delete row.productCommitStaged
      writeFileSync(path, `${JSON.stringify(row, null, 2)}\n`, 'utf8')
    },
    async restart() {
      runtime = createRuntime()
      await runtime.ready
      uninstallRuntimeHooks = runtime.install()
      return runtime
    },
    async crashRestart() {
      const abandonedRuntime = runtime
      uninstallRuntimeHooks?.()
      runtime = createRuntime()
      await runtime.ready
      uninstallRuntimeHooks = runtime.install()
      return abandonedRuntime
    },
    async dispose({ removeHome = true } = {}) {
      if (disposed && removeHome) return
      disposed = true
      await runtime.dispose()
      if (removeHome) {
        rmSync(home, { recursive: true, force: true })
        if (previousHome === undefined) delete process.env.DSH_HOME
        else process.env.DSH_HOME = previousHome
      }
    }
  }
}

test('native Agent hooks run two scoped members, keep product tools denied, and stage one local delivery for the Host receipt', async () => {
  const f = fixture()
  try {
    f.presetBindings.set('root-scope', 'member-preset')
    assert.equal(f.rootAgent.session.header.agentPreset, 'base-preset', 'Session header keeps its creation-time preset')
    const config = defaultTeamConfig()
    config.agents[0].context.sources.push({ type: 'worldbook' })
    config.agents[0].context.sources.push({ type: 'recent_history' })
    config.agents[0].presetId = 'member-preset'
    config.agents[0].compaction.autoCompactTokenLimit = 400
    config.agents[1].parameters.temperature = 1.1
    await f.configure(config)
    await f.startRootTurn()
    assert.equal(f.currentTurnLookups, 0, 'prepare-step selects the local route before the input is admitted')
    assert.equal(f.spawnCount, 0, 'pre-request routing does not begin Team work before the native input append')
    const route = await f.prepareRootRequest()
    assert.deepEqual(route, { provider: TEAM_DELIVERY_PROVIDER, model: TEAM_DELIVERY_MODEL })
    assert.deepEqual(f.rootAgent.model.current(), {
      provider: 'frozen-provider', model: 'frozen-model', reasoningEffort: 'high'
    }, 'the live Session selection is restored before the local request dispatches')
    assert.equal(f.currentTurnLookups, 0, 'the local route is selected without a premature currentTurn query')
    assert.deepEqual(f.registeredAdapters[0].providers, [TEAM_DELIVERY_PROVIDER])
    const { body } = await f.runLocalDelivery({ route, messages: [
      { role: 'user', id: INPUT_ID, content: 'Actual current input.' },
      { role: 'assistant', channel: 'analysis', content: 'private reasoning must not persist' },
      { role: 'system', content: 'token=sk-12345678901234567890' }
    ] })
    assert.equal(route.provider, TEAM_DELIVERY_PROVIDER)
    assert.equal(route.model, TEAM_DELIVERY_MODEL)
    assert.equal(f.currentTurnLookups, 1, 'the adapter confirms official turn identity after prompt/input admission')
    assert.equal(body, 'The door opened onto the rain-lit street.')
    assert.equal(f.spawnCount, 2)
    assert.deepEqual(f.childRequests.map(item => [item.model.provider, item.model.model]), [
      ['frozen-provider', 'frozen-model'], ['frozen-provider', 'frozen-model']
    ])
    assert.deepEqual(f.childRequests.map(item => [item.model.temperature, item.model.topP, item.model.maxTokens]), [
      [0.8, 0.7, 150], [1.1, 0.7, 150]
    ], 'inherited child routes keep the actual root request parameters while member parameters override them')
    assert.equal(f.registeredPresetDefinitions.length, 1)
    const derivedPreset = f.registeredPresetDefinitions[0]
    assert.equal(derivedPreset.plugins[0].config.thresholdRatio, 0.4,
      'autoCompactTokenLimit is converted to the actual native compaction-basic threshold')
    assert.deepEqual(f.presetSelections, [{ sessionId: 'native-child-1', agentPreset: derivedPreset.id }],
      'the first child selects its derived preset through the public AgentPresetRegistry before its first request')
    assert.equal(f.childRequests[0].agentPreset, derivedPreset.id,
      'the child request uses the selected composition')
    assert.equal(f.childRequests[1].agentPreset, 'member-preset',
      'members without an override inherit the root Agent’s current composition')
    assert.ok(f.sessionEvents.get('native-child-1').some(event =>
      event.type === 'agent-preset/selected' && event.data.agentPreset === derivedPreset.id),
    'the official selection is recorded in the child Session event stream')
    assert.ok(f.childRequests.every(item => !item.tools.some(tool => tool.name.startsWith('eleckoi_') || tool.name === 'update_roleplay_plan')),
      'the native model request assembly excludes product tools even when they are Agent-owned')
    assert.equal(f.childContextReads[0].value.entries[0].content, 'Rain outside.')
    assert.deepEqual(f.childContextReads[1].value.map(item => item.content), ['Earlier scene.', 'A quiet arrival.'],
      'history excludes runtime-context and subagent-settled user-role messages')
    assert.equal(JSON.stringify(f.childContextReads[0]).includes('raw source detail'), false)
    assert.equal(JSON.stringify(f.childContextReads[0]).includes('raw sibling'), false)
    assert.ok(f.stageCalls.length === 1)
    assert.deepEqual(f.stageCalls[0].localDelivery, { provider: TEAM_DELIVERY_PROVIDER, model: TEAM_DELIVERY_MODEL })
    assert.equal(f.stageCalls[0].operationId, 'prepared-op-1')
    assert.equal(f.stageCalls[0].expectedWorldHash, 'world-hash-1')
    assert.equal(f.stageCalls[0].inputMessageId, INPUT_ID)
    assert.equal(Object.hasOwn(f.stageCalls[0], 'settingLibrary'), false,
      'a read-only run must not write the macro-expanded runtime projection over the raw setting-library source')
    assert.equal((await f.runtime.api.getStatus({ conversationId: CONVERSATION_ID })).run.phase, 'awaiting_commit')
    assert.ok(f.invokedTools.some(item => item.name === 'rp_team_publish'))
    assert.ok(!f.invokedTools.some(item => item.name === 'eleckoi_apply_variable_patch'))

    let emptyStepNextCalls = 0
    const ownedNotice = {
      id: 'owned-settlement-during-active-run', role: 'user',
      source: { kind: 'subagent-settled', senderSessionId: 'native-child-1' }, content: 'settled'
    }
    await f.appendRootAssistant(body)
    const pureNotice = await f.dispatchPreStep({
      agent: f.rootAgent, turn: 1, step: 2, messages: [ownedNotice], signal: new AbortController().signal
    }, async () => { emptyStepNextCalls++; return { kind: 'enter', messages: [] } })
    assert.deepEqual(pureNotice, { kind: 'enter', messages: [] },
      'an owned notice is consumed with the native empty-step completion path')
    assert.equal(emptyStepNextCalls, 0)
    const activeNoticeReason = nativeTurnReason({ kind: 'completed' }, pureNotice, 2)
    assert.deepEqual(activeNoticeReason, { kind: 'completed' },
      'native AgentLoop preserves the already completed turn when a notice arrives after the final assistant output')
    const mixedHuman = { id: 'mixed-human-input', role: 'user', source: { kind: 'user' }, content: 'Keep this real input.' }
    const runtimeNotice = { id: 'mixed-runtime-context', role: 'user', source: { kind: 'runtime-context' }, content: 'Keep native context.' }
    const mixed = await f.dispatchPreStep({
      agent: f.rootAgent, turn: 2, messages: [mixedHuman, ownedNotice], signal: new AbortController().signal
    }, async () => ({ kind: 'enter', messages: [mixedHuman, ownedNotice, runtimeNotice] }))
    assert.deepEqual(mixed.messages.map(message => message.id), ['mixed-human-input', 'mixed-runtime-context'],
      'the root human input and native runtime context survive while the owned notice is removed')
    await f.emitSessionEvent(f.rootAgent.session, { type: 'turn/end', seq: 90, data: { turn: 2 } })

    const trace = await f.runtime.api.getTrace({ conversationId: CONVERSATION_ID, runId: (await f.runtime.api.getStatus({ conversationId: CONVERSATION_ID })).run.runId })
    const input = trace.events.find(event => event.type === 'model.input')
    assert.ok(input)
    assert.equal(JSON.stringify(input).includes('private reasoning must not persist'), false)
    assert.equal(JSON.stringify(input).includes('sk-12345678901234567890'), false)
    assert.ok(trace.events.some(event => event.type === 'publication.local_delivery_route'))
    // A member Session's model request is traced under that member, not under the output agent.
    const memberAgent = trace.events.find(event => event.type === 'session.scope_installed' && event.data.sessionId === 'native-child-1')?.agentId
    const memberInput = trace.events.find(event => event.type === 'model.input' && event.data.sessionId === 'native-child-1')
    assert.ok(memberAgent && memberAgent !== trace.events.find(event => event.type === 'publication.local_delivery_route')?.agentId)
    assert.equal(memberInput?.agentId, memberAgent)

    const committed = await f.commitRootTurn(body, activeNoticeReason)
    assert.equal(committed.run.phase, 'complete')
    assert.equal(committed.run.assistantMessageId, 'native-assistant-message')
    const lateNotice = await f.startRootTurn({ turn: 2, message: {
      id: 'late-settled-notice', role: 'user', source: { kind: 'subagent-settled', senderSessionId: 'native-child-1' },
      content: [{ type: 'text', text: 'A prior child completed.' }]
    } })
    assert.deepEqual(lateNotice.decision, { kind: 'enter', messages: [] },
      'an owned settlement notice after completion completes as an empty native turn')
    const lateNoticeReason = nativeTurnReason(undefined, lateNotice.decision, 1)
    assert.deepEqual(lateNoticeReason, { kind: 'completed' })
    await f.emitSessionEvent(f.rootAgent.session, {
      type: 'turn/end', seq: 91, data: { turn: 2, reason: lateNoticeReason }
    })
    assert.equal(f.spawnCount, 2)
    await f.runtime.dispose()
    await f.restart()
    assert.deepEqual(await f.ctx.agentPresets.resolve(derivedPreset.id), { id: derivedPreset.id },
      'a fresh plugin runtime re-registers the persisted derived definition referenced by the Session event')
    assert.equal(f.ctx.agentPresets.composedPreset(f.rootAgent.ctx), 'member-preset')
  } finally {
    await f.dispose()
  }
})

test('a mismatched admitted turn cannot start Team work or fall through to the ordinary model', async () => {
  const f = fixture({ preparedTurn: 2 })
  try {
    await f.configure()
    await f.startRootTurn({ turn: 1 })
    const route = await f.prepareRootRequest({ turn: 1 })
    assert.equal(route.provider, TEAM_DELIVERY_PROVIDER)
    await assert.rejects(() => f.runLocalDelivery({ turn: 1, route }), /admitted local-delivery turn identity/u)
    assert.equal(f.spawnCount, 0)
    assert.equal(f.stageCalls.length, 0)
  } finally {
    await f.dispose()
  }
})

test('a native Session absent from the ElecKoi conversation catalog keeps its ordinary route and tools', async () => {
  const f = fixture({ sessionListed: false })
  try {
    await f.configure()
    await f.startRootTurn()
    const route = await f.prepareRootRequest()
    assert.deepEqual(route, {
      provider: 'frozen-provider', model: 'frozen-model', reasoningEffort: 'high',
      temperature: 0.8, topP: 0.7, maxTokens: 150
    })
    assert.deepEqual(await f.scopes.get(f.rootAgent.ctx.scope).ctx.tools.invoke(
      'eleckoi_apply_variable_patch', {}, f.rootAgent
    ), { inherited: true, name: 'eleckoi_apply_variable_patch' })
    const rootScope = f.scopes.get(f.rootAgent.ctx.scope).ctx
    const ordinaryAssembly = await rootScope.systemPrompt.assemble({ tools: rootScope.tools.schemas() }, {
      agent: f.rootAgent, scope: f.rootAgent.ctx.scope
    })
    assert.ok(ordinaryAssembly.tools.some(tool => tool.name === 'eleckoi_apply_variable_patch'),
      'ordinary native requests retain product tools outside a Team member scope')
    assert.equal(f.currentTurnLookups, 0)
    assert.equal(f.spawnCount, 0)
    assert.equal(f.stageCalls.length, 0)
  } finally {
    await f.dispose()
  }
})

test('Team OFF keeps the official product model after a local delivery on the same Session', async () => {
  const f = fixture()
  try {
    await f.configure()
    await f.startRootTurn({ turn: 1 })
    const firstRoute = await f.prepareRootRequest({ turn: 1 })
    assert.equal(firstRoute.provider, TEAM_DELIVERY_PROVIDER)
    await f.emitSessionEvent(f.rootAgent.session, {
      type: 'request/header', seq: 7, data: { header: { config: { provider: TEAM_DELIVERY_PROVIDER, model: TEAM_DELIVERY_MODEL } } }
    })
    await f.emitSessionEvent(f.rootAgent.session, { type: 'turn/end', seq: 8, data: { turn: 1 } })

    await f.configure(defaultTeamConfig(), { enabled: false, expectedRevision: 1 })
    f.rootAgent.model.select({ provider: TEAM_DELIVERY_PROVIDER, model: TEAM_DELIVERY_MODEL })
    await f.startRootTurn({ turn: 2, message: {
      id: 'second-input', role: 'user', source: { kind: 'user', rpcId: 'rpc-input-2' }, content: 'Next scene.'
    } })
    const nextRoute = await f.prepareRootRequest({ turn: 2 })
    assert.deepEqual(nextRoute, {
      provider: 'frozen-provider', model: 'frozen-model', reasoningEffort: 'high',
      temperature: 0.8, topP: 0.7, maxTokens: 150
    })
    assert.equal(f.spawnCount, 0)
    assert.equal(f.stageCalls.length, 0)
    assert.equal(f.currentTurnLookups, 0)
  } finally {
    await f.dispose()
  }
})

test('runtime-context and foreign settlement messages do not admit a root Team run', async () => {
  const f = fixture()
  try {
    await f.configure()
    const messages = [
      { id: 'context-only', role: 'user', source: { kind: 'runtime-context' } },
      { id: 'foreign-notice', role: 'user', source: { kind: 'subagent-settled', senderSessionId: 'foreign-child' } }
    ]
    for (let index = 0; index < messages.length; index++) {
      const turn = index + 1
      await f.startRootTurn({ turn, message: messages[index] })
      const route = await f.prepareRootRequest({ turn })
      assert.equal(route.provider, 'frozen-provider')
      assert.equal(route.model, 'frozen-model')
    }
    assert.equal(f.spawnCount, 0)
    assert.equal(f.stageCalls.length, 0)
    assert.equal(f.currentTurnLookups, 0)
  } finally {
    await f.dispose()
  }
})

test('an unknown Host outcome stays pending across runtime restart and resolves from the durable receipt without rerunning members', async () => {
  const f = fixture({ receiptOutcome: 'unknown' })
  try {
    await f.configure()
    await f.startRootTurn()
    const { body } = await f.runLocalDelivery()
    assert.equal(body, 'The door opened onto the rain-lit street.')
    assert.equal(f.stageCalls.length, 1)
    const runId = f.stageCalls[0].runId
    assert.equal((await f.runtime.api.getStatus({ conversationId: CONVERSATION_ID })).run.phase, 'awaiting_commit')

    await f.dispose({ removeHome: false })
    f.setReceipt({ outcome: 'unknown', conversationId: CONVERSATION_ID, runId })
    await f.restart()
    let status = await f.runtime.api.getStatus({ conversationId: CONVERSATION_ID })
    assert.equal(status.run.phase, 'awaiting_commit')
    assert.equal(f.spawnCount, 2)
    assert.equal(f.stageCalls.length, 1)

    f.setReceipt({
      outcome: 'committed', conversationId: CONVERSATION_ID, runId,
      operationId: 'prepared-op-1', sessionId: ROOT_SESSION_ID, turn: 1,
      inputMessageId: INPUT_ID, assistantMessageId: 'native-assistant-message', assistantSeq: 11,
      baseHash: 'world-hash-1', active: true
    })
    await f.runtime.authoring.reconcileBranch(CONVERSATION_ID)
    status = await f.runtime.api.getStatus({ conversationId: CONVERSATION_ID })
    assert.equal(status.run.phase, 'complete')
    assert.equal(status.run.assistantMessageId, 'native-assistant-message')
    assert.equal(f.spawnCount, 2)
    assert.equal(f.stageCalls.length, 1)
  } finally {
    await f.dispose()
  }
})

test('a pre-ack staged publication survives a cold runtime restart and blocks a new run until its durable receipt settles', async t => {
  for (const { initialOutcome, finalOutcome } of [
    { initialOutcome: 'unknown', finalOutcome: 'committed' },
    { initialOutcome: 'pending', finalOutcome: 'failed' }
  ]) {
    await t.test(`${initialOutcome} then ${finalOutcome}`, async () => {
      let releaseStage
      let stageRequested
      const stageGate = new Promise(resolve => { releaseStage = resolve })
      const stageStarted = new Promise(resolve => { stageRequested = resolve })
      const f = fixture({ stageGate, onStageRequest: stageRequested })
      let abandonedRuntime
      let delivery
      try {
        await f.configure()
        await f.startRootTurn()
        let originalDeliveryResolved = false
        delivery = f.runLocalDelivery()
        void delivery.then(() => { originalDeliveryResolved = true })
        await stageStarted
        const runId = f.stageCalls[0].runId
        f.dropPersistedTopLevelStageFlag(runId)
        f.setReceipt({ outcome: initialOutcome, conversationId: CONVERSATION_ID, runId, operationId: 'prepared-op-1' })

        abandonedRuntime = await f.crashRestart()
        let status = await f.runtime.api.getStatus({ conversationId: CONVERSATION_ID })
        assert.equal(status.run.phase, 'awaiting_commit', 'the status snapshot stage marker survives rehydration')
        assert.equal(status.run.productCommitStaged, true)
        assert.equal(f.runtime.authoring.stateStore.status({ conversationId: CONVERSATION_ID, runId }).status, 'pending')
        assert.equal(originalDeliveryResolved, false, 'the staged response stays behind the unresolved Host acknowledgement')

        f.setPreparedTurn(2)
        await f.startRootTurn({ turn: 2 })
        await assert.rejects(f.runLocalDelivery({ turn: 2 }), { code: 'RP_TEAM_COMMIT_PENDING' })
        assert.equal(f.spawnCount, 2, 'a new turn does not restart Team members while the prior receipt is uncertain')
        assert.equal(f.stageCalls.length, 1, 'a new turn does not restage the prior publication')

        f.setReceipt(finalOutcome === 'committed'
          ? {
            outcome: 'committed', conversationId: CONVERSATION_ID, runId,
            operationId: 'prepared-op-1', sessionId: ROOT_SESSION_ID, turn: 1,
            inputMessageId: INPUT_ID, assistantMessageId: 'native-assistant-message', assistantSeq: 11,
            baseHash: 'world-hash-1', active: true
          }
          : { outcome: 'failed', conversationId: CONVERSATION_ID, runId, operationId: 'prepared-op-1', error: 'Host rejected staged state' })
        await f.runtime.authoring.reconcileBranch(CONVERSATION_ID)
        status = await f.runtime.api.getStatus({ conversationId: CONVERSATION_ID })
        assert.equal(status.run.phase, finalOutcome === 'committed' ? 'complete' : 'failed')
        assert.equal(f.runtime.authoring.stateStore.status({ conversationId: CONVERSATION_ID, runId }).status,
          finalOutcome === 'committed' ? 'committed' : 'rolled_back')
        assert.equal(f.spawnCount, 2)
        assert.equal(f.stageCalls.length, 1)

        releaseStage()
        const original = await delivery
        assert.equal(original.body, 'The door opened onto the rain-lit street.')
        assert.equal(originalDeliveryResolved, true, 'the original in-flight response is delivered once after its stage call resolves')
        await abandonedRuntime.dispose()
        abandonedRuntime = undefined
      } finally {
        releaseStage()
        f.setReceipt({ outcome: 'failed', conversationId: CONVERSATION_ID, runId: f.stageCalls[0]?.runId, error: 'test cleanup' })
        if (delivery) await Promise.allSettled([delivery])
        await abandonedRuntime?.dispose()
        await f.dispose()
      }
    })
  }
})

test('dispose drains an in-flight Host stage and settles only from its durable receipt', async t => {
  for (const outcome of ['pending', 'committed', 'unknown']) {
    await t.test(outcome, async () => {
      let releaseStage
      let stageRequested
      let releaseReceipt
      let receiptQueried
      const stageGate = new Promise(resolve => { releaseStage = resolve })
      const stageStarted = new Promise(resolve => { stageRequested = resolve })
      const receiptGate = new Promise(resolve => { releaseReceipt = resolve })
      const receiptStarted = new Promise(resolve => { receiptQueried = resolve })
      const f = fixture({
        stageGate, onStageRequest: stageRequested,
        ...(outcome === 'committed' ? { receiptGate, onReceiptQuery: receiptQueried } : {})
      })
      try {
        await f.configure()
        await f.startRootTurn()
        const delivery = f.runLocalDelivery()
        let delivered = false
        void delivery.then(() => { delivered = true })
        await stageStarted
        assert.equal(delivered, false, 'the response remains behind the Host stage acknowledgement')
        assert.equal(f.stageCalls.length, 1)

        const disposing = f.runtime.dispose()
        const runId = f.stageCalls[0].runId
        if (outcome === 'committed') {
          releaseStage()
          const result = await delivery
          assert.equal(result.body, 'The door opened onto the rain-lit street.')
          const assistantSeq = await f.appendRootAssistant(result.body)
          f.setReceipt({
            outcome, conversationId: CONVERSATION_ID, runId,
            operationId: 'prepared-op-1', sessionId: ROOT_SESSION_ID, turn: 1,
            inputMessageId: INPUT_ID, assistantMessageId: 'native-assistant-message', assistantSeq,
            baseHash: 'world-hash-1', active: true
          })
          await receiptStarted
          releaseReceipt()
        } else {
          f.setReceipt({ outcome, conversationId: CONVERSATION_ID, runId, operationId: 'prepared-op-1' })
          releaseStage()
          const result = await delivery
          assert.equal(result.body, 'The door opened onto the rain-lit street.')
        }
        await disposing

        assert.equal(f.stageCalls.length, 1, 'disposal does not stage the same response twice')
        const status = await f.runtime.api.getStatus({ conversationId: CONVERSATION_ID })
        const state = f.runtime.authoring.stateStore.status({ conversationId: CONVERSATION_ID, runId })
        if (outcome === 'committed') {
          assert.equal(status.run.phase, 'complete')
          assert.equal(state.status, 'committed')
          assert.equal(status.run.assistantMessageId, 'native-assistant-message')
        } else {
          assert.equal(status.run.phase, 'awaiting_commit')
          assert.equal(state.status, 'pending', 'an uncertain receipt preserves staged state rather than rolling it back')
        }
      } finally {
        releaseStage()
        releaseReceipt()
        await f.dispose()
      }
    })
  }
})

test('a rejected stage settles from the Host receipt, or locally when the Host never wrote a turn row', async t => {
  for (const outcome of ['failed', 'cancelled', 'unknown']) {
    await t.test(outcome, async () => {
      let releaseStage
      let stageRequested
      const stageGate = new Promise(resolve => { releaseStage = resolve })
      const stageStarted = new Promise(resolve => { stageRequested = resolve })
      const f = fixture({
        stageGate, stageError: new Error('local stage acknowledgment lost'),
        onStageRequest: stageRequested
      })
      try {
        await f.configure()
        await f.startRootTurn()
        const delivery = f.runLocalDelivery()
        await stageStarted
        const runId = f.stageCalls[0].runId
        f.setReceipt({
          outcome, conversationId: CONVERSATION_ID, runId, operationId: 'prepared-op-1',
          ...(outcome === 'failed' ? { error: 'Host rejected staged state' } : {})
        })
        releaseStage()
        await assert.rejects(delivery, /local stage acknowledgment lost/)

        const status = await f.runtime.api.getStatus({ conversationId: CONVERSATION_ID })
        const state = f.runtime.authoring.stateStore.status({ conversationId: CONVERSATION_ID, runId })
        // 'unknown' means the Host has no row for this run: the rejected stage can never commit,
        // so the run fails locally and the conversation is not left waiting forever.
        assert.equal(status.run.phase, outcome === 'unknown' ? 'failed' : outcome)
        assert.equal(state.status, 'rolled_back')
        if (outcome === 'unknown') {
          assert.equal(status.run.failure, 'local stage acknowledgment lost')
          assert.equal(f.runtime.authoring.isConversationBusy(CONVERSATION_ID), false, 'author edits are no longer blocked')
          f.setPreparedTurn(2)
          await f.startRootTurn({ turn: 2 })
          // The fixture's Host still rejects every stage; what matters is that the next turn reaches it again
          // instead of failing with RP_TEAM_RUN_NOT_ACTIVE or RP_TEAM_COMMIT_PENDING.
          await assert.rejects(f.runLocalDelivery({ turn: 2 }), /local stage acknowledgment lost/)
          assert.equal(f.stageCalls.length, 2, 'the next turn runs the Team and stages again')
        }
      } finally {
        releaseStage()
        await f.dispose()
      }
    })
  }
})

test('a trigger cooldown carries across committed turns on the active Session surface', async () => {
  const f = fixture()
  try {
    const config = defaultTeamConfig()
    config.agents[0].triggers = [{ type: 'keyword', keywords: ['doorway'], cooldownTurns: 3 }]
    await f.configure(config)
    await f.startRootTurn()
    const first = await f.runLocalDelivery()
    assert.equal(first.body, 'The door opened onto the rain-lit street.')
    assert.equal(f.spawnCount, 2, 'turn 1: the keyword starts agent-1 and the publisher runs after it')
    const committed = await f.commitRootTurn(first.body)
    assert.equal(committed.run.phase, 'complete')

    f.setPreparedTurn(2)
    await f.startRootTurn({ turn: 2 })
    const second = await f.runLocalDelivery({ turn: 2 })
    assert.equal(second.body, 'The door opened onto the rain-lit street.')
    assert.equal(f.spawnCount, 3, 'turn 2: the same keyword is inside its 3-turn cooldown, so only the publisher runs')
    const status = await f.runtime.api.getStatus({ conversationId: CONVERSATION_ID })
    assert.equal(status.run.members['agent-1'].status, 'skipped')
  } finally {
    await f.dispose()
  }
})
test('cancelling a finished run does not interrupt whatever the root Session is doing now', async () => {
  const f = fixture()
  try {
    await f.configure()
    await f.startRootTurn()
    const { body } = await f.runLocalDelivery()
    const committed = await f.commitRootTurn(body)
    assert.equal(committed.run.phase, 'complete')
    let rootCancels = 0
    f.rootAgent.cancel = () => { rootCancels++ }
    const status = await f.runtime.api.cancel({ conversationId: CONVERSATION_ID, runId: committed.run.runId })
    assert.equal(status.phase, 'complete')
    assert.equal(rootCancels, 0)
  } finally {
    await f.dispose()
  }
})