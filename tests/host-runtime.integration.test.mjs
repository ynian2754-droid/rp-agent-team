import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createRpAgentTeam } from '../src/host/runtime.mjs'
import { StateStore } from '../src/host/state-store.mjs'
import { TEAM_DELIVERY_MODEL, TEAM_DELIVERY_PROVIDER } from '../src/host/delivery-adapter.mjs'
import { readRunRows } from '../src/host/run-persistence.mjs'
import { readRequestRecords } from '../src/host/request-persistence.mjs'
import { defaultTeamConfig } from '../src/shared/schema.mjs'

function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'rp-team-runtime-024-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const sessionEventListeners = new Set()
  const registeredAdapters = []
  const rootAgentContexts = new Map()
  const sessionEvents = []
  const localDeliveries = []
  const productCommits = []
  const drainedChildren = []
  const interruptedChildren = []
  let adapterStreamCalls = 0
  let spawnCalls = 0
  let receiptStatusCalls = 0
  let rootTurnController
  let drainHandler = async () => undefined
  const committedReceipt = {
    outcome: 'committed', productMessageId: 'published-root-message',
    assistantMessageId: 'published-root-message', assistantSeq: 79
  }
  let productBehavior = { commitReceipt: committedReceipt, settlementOutcome: 'failed', receiptStatus: { outcome: 'unknown' } }
  let prepareHandler = async () => ({ variableBridge: { enabled: true, state: {} }, settingBridge: { enabled: true, library: {} } })
  const nativeMembers = []
  let spawnHandler
  const rootAgent = {
    cancel() {
      if (!rootTurnController?.signal.aborted) rootTurnController?.abort(new Error('Official root Session cancelled'))
    },
    session: {
      id: 'stable-root-session',
      snapshotEvents: () => [...sessionEvents]
    }
  }
  const ctx = {
    on(name, listener) {
      if (name === 'session/event') sessionEventListeners.add(listener)
      return () => sessionEventListeners.delete(listener)
    },
    agents: { get: id => String(id) === rootAgent.session.id ? rootAgent : undefined },
    sessionController: {
      async cancel({ sessionId }) {
        if (String(sessionId) !== rootAgent.session.id) throw new Error(`Unknown root Session ${sessionId}`)
        rootAgent.cancel({ kind: 'user' })
        return { cancelled: true }
      }
    },
    agentTeams: {
      listMembers: () => [...nativeMembers],
      interrupt(_root, name) { interruptedChildren.push(name) },
      async spawnTeammate(root, specification) {
        if (!spawnHandler) throw new Error('No fake native spawn handler was installed')
        spawnCalls += 1
        const member = {
          id: `native-child-session-${nativeMembers.length + 1}`,
          name: specification.name, description: specification.description
        }
        nativeMembers.push(member)
        return await spawnHandler(root, specification, member)
      }
    },
    agentPresets: { list: async () => [] },
    tools: { schemas: () => [] },
    subagents: { async drainContinuableChildren(root, ids) {
      drainedChildren.push({ rootSessionId: root.session.id, ids: [...ids] })
      await drainHandler(root, ids)
    } },
    llm: {
      registerAdapter(providers, adapter) {
        registeredAdapters.push({ providers, adapter: {
          ...adapter,
          stream(...args) {
            adapterStreamCalls += 1
            return adapter.stream(...args)
          }
        } })
        return () => undefined
      },
      listProviders: () => [],
      listModels: () => [],
      async resolveModelInfo(provider, model) { return { id: model, provider, reasoning: { efforts: [] } } }
    },
    eleckoiRuntimeExtensions: {
      async recordLocalDelivery(input) { localDeliveries.push(input); return { recorded: true } }
    },
    async noop() {},
    eleckoiStoryState: {
      beginConversationWork(work) { return { ...work, claimed: true } },
      endConversationWork() {},
      async snapshot() { return { variables: {}, settings: {}, baseHash: 'world-base' } },
      async prepare(...args) { return await prepareHandler(...args) },
      async stageProductCommit(input) { productCommits.push({ type: 'stage', ...input }) },
      async commitProductTurn(input) {
        productCommits.push({ type: 'commit', ...input })
        return productBehavior.commitReceipt === committedReceipt ? {
          ...committedReceipt, productMessageId: `${input.conversationId}-assistant`,
          assistantMessageId: `${input.conversationId}-assistant`
        } : productBehavior.commitReceipt
      },
      async settleProductCommit(input) {
        productCommits.push({ type: 'settle', ...input })
        if (productBehavior.settlementError) throw productBehavior.settlementError
        return { outcome: productBehavior.settlementOutcome }
      },
      async getProductCommitStatus() { receiptStatusCalls += 1; return productBehavior.receiptStatus }
    }
  }
  const createRuntime = () => createRpAgentTeam(ctx, {
    defineTool: definition => definition,
    parseYaml: JSON.parse,
    stringifyYaml: JSON.stringify,
    scopeOf: agentCtx => agentCtx.scope
  })
  let runtime = createRuntime()

  function setupRoot(conversationId = 'conversation-024', snapshotOverrides = {}) {
    const listeners = new Map()
    const agentCtx = {
      sessions: { flush: async () => { productCommits.push({ type: 'flush' }); return true } },
      on(name, listener) {
        const rows = listeners.get(name) ?? []
        rows.push(listener)
        listeners.set(name, rows)
        return () => { const index = rows.indexOf(listener); if (index >= 0) rows.splice(index, 1) }
      }
    }
    rootAgentContexts.set(conversationId, { agentCtx, listeners })
    const getTurnSnapshot = async ({ messages, turn }) => ({
      conversationId, sessionId: rootAgent.session.id, turn,
      modelSnapshot: { provider: 'global-provider', model: 'global-model', temperature: 0.55, topP: 0.83, maxTokens: 987 },
      contextSnapshot: { currentUserInput: messages.find(message => message.role === 'user')?.content?.[0]?.text ?? '', history: [] },
      worldSnapshot: { variables: {}, settings: {}, baseHash: 'world-base' },
      inputMessageId: messages.find(message => message.role === 'user')?.id
    })
    runtime.extension.setupAgent({
      agentCtx, agent: rootAgent, sessionId: rootAgent.session.id, child: false,
      snapshot: { conversationId, ...snapshotOverrides }, binding: { conversationId, sessionId: rootAgent.session.id, kind: 'root' },
      getTurnSnapshot
    })
    return { agentCtx, listeners }
  }

  return {
    home, previousHome, ctx, get runtime() { return runtime }, registeredAdapters, rootAgent, sessionEvents, localDeliveries, productCommits, committedReceipt,
    drainedChildren, interruptedChildren,
    sessionEventListeners, rootAgentContexts, setupRoot,
    get adapterStreamCalls() { return adapterStreamCalls },
    get spawnCalls() { return spawnCalls },
    get receiptStatusCalls() { return receiptStatusCalls },
    restartRuntime() { runtime = createRuntime(); return runtime },
    setSpawnHandler(handler) { spawnHandler = handler },
    setRootTurnController(controller) { rootTurnController = controller },
    setDrainHandler(handler) { drainHandler = handler },
    setPrepareHandler(handler) { prepareHandler = handler },
    setProductBehavior(behavior) { productBehavior = { ...productBehavior, ...behavior } },
    emitSessionEvent(session, event) {
      sessionEvents.push(event)
      for (const listener of sessionEventListeners) listener(session, event)
    },
    async dispose() {
      await runtime.dispose()
      rmSync(home, { recursive: true, force: true })
      if (previousHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previousHome
    }
  }
}

test('runtime disposal closes run admission while an in-flight root pre-step is preparing its snapshot', async () => {
  const f = fixture()
  let releasePrepare
  let markPrepareEntered
  const entered = new Promise(resolve => { markPrepareEntered = resolve })
  const blockedPrepare = new Promise(resolve => { releasePrepare = resolve })
  try {
    const conversationId = 'conversation-dispose-preparing'
    await f.runtime.api.saveConfig({ conversationId, expectedRevision: 0, enabled: true, config: defaultTeamConfig() })
    const { listeners } = f.setupRoot(conversationId)
    f.setPrepareHandler(async () => {
      markPrepareEntered()
      await blockedPrepare
      return { variableBridge: { enabled: true, state: {} }, settingBridge: { enabled: true, library: {} } }
    })
    const input = { id: 'dispose-race-input', role: 'user', content: [{ type: 'text', text: 'Continue.' }], source: { kind: 'user' } }
    let nextCalls = 0
    const preStep = listeners.get('agent/pre-step')[0]({ turn: 1, messages: [input], signal: new AbortController().signal }, async () => {
      nextCalls += 1
      return { kind: 'continue', messages: [input] }
    })
    await entered
    await f.runtime.dispose()
    releasePrepare()
    assert.deepEqual(await preStep, { kind: 'continue', messages: [input] })
    assert.equal(nextCalls, 1)
    assert.equal((await f.runtime.api.getStatus({ conversationId })).run, null)
  } finally {
    releasePrepare?.()
    await f.dispose()
  }
})

test('a real root pre-step freezes the Team run without entering native pre-step compaction, then persists the appended user event sequence', async () => {
  const f = fixture()
  try {
    const conversationId = 'conversation-input-sequence'
    await f.runtime.api.saveConfig({
      conversationId, expectedRevision: 0, enabled: true, config: defaultTeamConfig()
    })
    const { listeners } = f.setupRoot(conversationId)
    const input = {
      id: 'dsh-input-message-7', role: 'user', content: [{ type: 'text', text: 'Continue the scene.' }],
      source: { kind: 'user', rpcId: 'rpc-input-7' }
    }
    let nextCalls = 0
    await listeners.get('agent/pre-step')[0]({ turn: 7, messages: [input], signal: new AbortController().signal }, async () => {
      nextCalls += 1
      return { kind: 'continue' }
    })
    assert.equal(nextCalls, 0, 'Team delivery bypasses the ordinary pre-step chain, including root automatic compaction')
    assert.equal(f.sessionEvents.length, 0, 'the SDK has not appended the current user message during pre-step')
    assert.equal((await f.runtime.api.getStatus({ conversationId })).run.inputEventSeq, undefined)

    const request = await listeners.get('agent/request')[0]({ turn: 7 }, async () => ({
      provider: 'global-provider', model: 'global-model', temperature: 0.55, topP: 0.83, maxTokens: 987
    }))
    assert.equal(request.provider, TEAM_DELIVERY_PROVIDER)
    assert.equal(request.model, TEAM_DELIVERY_MODEL)
    assert.deepEqual(f.registeredAdapters[0].providers, [TEAM_DELIVERY_PROVIDER])

    const event = { seq: 41, type: 'user/message', data: input }
    f.sessionEvents.push(event)
    for (const listener of f.sessionEventListeners) listener(f.rootAgent.session, event)
    const status = await f.runtime.api.getStatus({ conversationId })
    assert.equal(status.run.inputMessageId, input.id)
    assert.equal(status.run.inputEventSeq, 41)
    assert.deepEqual(f.runtime.extension.mode({ sessionId: f.rootAgent.session.id }), 'team')
    const header = { seq: 42, type: 'request/header', data: { header: { config: {
      provider: TEAM_DELIVERY_PROVIDER, model: TEAM_DELIVERY_MODEL
    } } } }
    for (const listener of f.sessionEventListeners) listener(f.rootAgent.session, header)
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(f.localDeliveries, [{
      sessionId: f.rootAgent.session.id, requestSeq: 42,
      provider: TEAM_DELIVERY_PROVIDER, model: TEAM_DELIVERY_MODEL
    }], 'the internal route marker is tied to the real root request/header sequence')
  } finally {
    await f.dispose()
  }
})

test('a pending author edit blocks the next Team run before claiming the native Session', async () => {
  const f = fixture()
  try {
    const conversationId = 'conversation-pending-author-edit'
    await f.runtime.api.saveConfig({ conversationId, expectedRevision: 0, enabled: true, config: defaultTeamConfig() })
    const { listeners } = f.setupRoot(conversationId)
    const stateStore = f.runtime.authoring.stateStore
    const beforeSnapshot = stateStore.committedSnapshot({ conversationId })
    stateStore.beginAuthorEdit({
      conversationId, operationId: 'author-edit-pending', expectedRevision: beforeSnapshot.revision,
      beforeSnapshot, afterSnapshot: { ...beforeSnapshot, revision: beforeSnapshot.revision + 1 },
      operations: [], anchor: {}, hostRequired: true
    })
    const input = { id: 'pending-author-edit-input', role: 'user', content: [{ type: 'text', text: 'Continue.' }], source: { kind: 'user' } }
    await assert.rejects(listeners.get('agent/pre-step')[0](
      { turn: 1, messages: [input], signal: new AbortController().signal },
      async () => { throw new Error('A Team run must not continue through a pending author edit') }
    ), error => error.code === 'RP_TEAM_AUTHOR_EDIT_PENDING')
    assert.equal(f.runtime.authoring.stateStore.pendingAuthorEdits(conversationId).length, 1)
    assert.equal(f.runtime.authoring.getRunRecords(conversationId).length, 0)
  } finally {
    await f.dispose()
  }
})

async function deliverSinglePublisherTurn(f, conversationId, turn, body, options = {}) {
  const config = defaultTeamConfig()
  const publisher = structuredClone(config.agents.find(agent => agent.id === config.output.agentId))
  publisher.triggers = [{ type: 'always' }]
  publisher.context.sources = [{ type: 'current_input' }]
  publisher.communication = { sendTo: [], receiveFrom: [], requestTo: [], requestFrom: [] }
  publisher.execution.after = []
  config.agents = [publisher]
  config.output.agentId = publisher.id
  options.configure?.(config, publisher)
  await f.runtime.api.saveConfig({ conversationId, expectedRevision: 0, enabled: true, config })
  await options.beforeRun?.({ config })
  const { agentCtx, listeners } = f.setupRoot(conversationId, { mountedPresetId: 'base-preset' })
  const input = {
    id: `${conversationId}-input`, role: 'user', content: [{ type: 'text', text: 'Continue.' }],
    source: { kind: 'user', rpcId: `${conversationId}-request` }
  }
  const preStep = listeners.get('agent/pre-step')[0]
  await preStep({ turn, messages: [input], signal: new AbortController().signal }, async () => {
    throw new Error('A scheduled Team turn must not continue into the ordinary model path')
  })
  f.setSpawnHandler(async (root, specification, memberRow) => {
    const childSnapshot = await f.runtime.extension.resolveSnapshot({
      sessionId: memberRow.id, parentSessionId: root.session.id, child: true,
      snapshot: { conversationId }
    })
    await options.onChildSnapshot?.({ childSnapshot, memberRow })
    const definitions = []
    const childAgent = { session: { id: memberRow.id, parentSessionId: root.session.id } }
    const tools = {
      schemas: () => definitions,
      register(definition) { definitions.push(definition); return () => undefined },
      view: () => ({ restrictableNames: new Set() }),
      restrict: () => () => undefined,
      guard: () => () => undefined
    }
    const childCtx = {
      scope: {}, tools,
      on: () => () => undefined,
      systemPrompt: {
        getSectionOrder: () => 0,
        section: () => () => undefined
      }
    }
    const dispose = await f.runtime.extension.setupAgent({
      agentCtx: childCtx, agent: childAgent, sessionId: memberRow.id, child: true,
      snapshot: childSnapshot, binding: { conversationId, sessionId: memberRow.id, kind: 'child' }
    })
    const publish = definitions.find(definition => definition.name === 'rp_team_publish')
    assert.ok(publish, 'the scheduled output agent receives the real Team publish tool')
    if (options.failBeforePublish) {
      f.emitSessionEvent(childAgent.session, {
        seq: 77, type: 'turn/end', data: { turn, reason: { kind: 'error', error: { message: options.failBeforePublish } } }
      })
      dispose?.()
      return { member: memberRow }
    }
    await options.beforePublish?.({ definitions, childAgent, childSnapshot })
    publicationCalls += 1
    await publish.execute({ body }, { agent: childAgent, concludeTurn() {} })
    f.emitSessionEvent(childAgent.session, {
      seq: 77, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } }
    })
    dispose?.()
    return { member: memberRow }
  })

  if (Number.isSafeInteger(options.inputSeq)) f.emitSessionEvent(f.rootAgent.session, {
    seq: options.inputSeq, type: 'user/message', data: input
  })
  let delivered = ''
  let publicationCalls = 0
  let deliveryError
  try {
    for await (const chunk of f.registeredAdapters[0].adapter.stream({
      provider: TEAM_DELIVERY_PROVIDER, model: TEAM_DELIVERY_MODEL,
      sessionId: f.rootAgent.session.id, turn, signal: new AbortController().signal
    })) if (chunk.type === 'text-delta') delivered += chunk.text
  } catch (error) {
    deliveryError = error
  }
  if (options.failBeforePublish) {
    assert.match(String(deliveryError?.message ?? deliveryError), new RegExp(options.failBeforePublish))
    return {
      agentCtx, preStep, turnStopping: listeners.get('agent/turn-stopping')?.[0], listeners,
      notice: undefined, delivered, conversationId, turn, deliveryError,
      get publicationCalls() { return publicationCalls }
    }
  }
  if (deliveryError) throw deliveryError
  assert.equal(delivered, body)
  f.emitSessionEvent(f.rootAgent.session, { seq: 78, type: 'request/header', data: { header: { config: {
    provider: TEAM_DELIVERY_PROVIDER, model: TEAM_DELIVERY_MODEL
  } } } })
  await new Promise(resolve => setImmediate(resolve))
  f.emitSessionEvent(f.rootAgent.session, {
    seq: 79, type: 'assistant/message', data: { turn, step: 1, message: {
      role: 'assistant', id: `${conversationId}-assistant`,
      content: [{ type: 'text', text: delivered }],
      source: { kind: 'model', provider: TEAM_DELIVERY_PROVIDER, model: TEAM_DELIVERY_MODEL }
    } }
  })
  const notice = {
    id: `${conversationId}-settled-child`, role: 'user', content: [{ type: 'text', text: 'Child completed.' }],
    source: { kind: 'subagent-settled', form: 'notice', senderSessionId: 'native-child-session-1' }
  }
  return { agentCtx, preStep, turnStopping: listeners.get('agent/turn-stopping')?.[0], listeners,
    notice, delivered, conversationId, turn, get publicationCalls() { return publicationCalls } }
}

test('owned settlement notices use the same official flush and receipt commit when DSH skips turn-stopping', async () => {
  const f = fixture()
  try {
    const round = await deliverSinglePublisherTurn(f, 'conversation-notice-commit', 9, 'One committed response.')
    let nextCalls = 0
    const result = await round.preStep({ turn: round.turn, messages: [round.notice], signal: new AbortController().signal }, async () => {
      nextCalls += 1
      return { kind: 'continue' }
    })
    assert.equal(nextCalls, 0)
    assert.deepEqual(result, { kind: 'enter', messages: [] })
    assert.deepEqual(f.productCommits.map(item => item.type), ['stage', 'flush', 'commit'])
    const status = (await f.runtime.api.getStatus({ conversationId: round.conversationId })).run
    assert.equal(status.phase, 'complete')
    assert.equal(status.productMessageId, `${round.conversationId}-assistant`)
    assert.equal(status.assistantSeq, 79)
    assert.equal(status.assistantMessageId, `${round.conversationId}-assistant`)
    assert.deepEqual(f.productCommits.at(-1), {
      type: 'commit', conversationId: round.conversationId, runId: status.runId,
      sessionId: f.rootAgent.session.id, turn: round.turn
    })
    const trace = await f.runtime.api.getTrace({ conversationId: round.conversationId, runId: status.runId })
    assert.equal(trace.events.find(event => event.type === 'publication.assistant_appended').data.assistantSeq, 79)
    assert.equal(round.agentCtx.sessions !== undefined, true)
  } finally {
    await f.dispose()
  }
})

test('an unconfirmed commit remains pending but exposes its real assistant message and failure trace', async () => {
  const f = fixture()
  try {
    f.setProductBehavior({ commitReceipt: { outcome: 'pending' }, settlementOutcome: 'unknown' })
    const round = await deliverSinglePublisherTurn(f, 'conversation-unknown-commit', 10, 'Response awaiting confirmation.')
    await assert.rejects(round.preStep({ turn: round.turn, messages: [round.notice], signal: new AbortController().signal }, async () => ({})),
      /Host did not confirm the Team response commit/)
    f.emitSessionEvent(f.rootAgent.session, {
      seq: 80, type: 'turn/end', data: { turn: round.turn, reason: { kind: 'error', error: { message: 'Receipt remains unknown.' } } }
    })
    await new Promise(resolve => setImmediate(resolve))
    const status = (await f.runtime.api.getStatus({ conversationId: round.conversationId })).run
    assert.equal(status.phase, 'awaiting_commit', 'unknown receipt is never represented as failed or committed')
    assert.equal(status.productCommitStaged, true)
    assert.equal(status.productMessageId, undefined)
    assert.equal(status.assistantSeq, 79)
    assert.equal(status.assistantMessageId, `${round.conversationId}-assistant`)
    assert.match(status.failure, /Receipt remains unknown|Host did not confirm/)
    const trace = await f.runtime.api.getTrace({ conversationId: round.conversationId, runId: status.runId })
    const failed = trace.events.find(event => event.type === 'publication.commit_failed')
    assert.equal(failed.data.status, 'unknown')
    assert.equal(failed.data.assistantSeq, 79)
    assert.equal(failed.data.assistantMessageId, `${round.conversationId}-assistant`)
  } finally {
    await f.dispose()
  }
})

test('a pre-publication failure skips Host settlement and retries after an unknown Host lookup', async () => {
  const f = fixture()
  try {
    const conversationId = 'conversation-prepublication-retry'
    f.setProductBehavior({
      settlementError: new Error('there is no staged product row'),
      settlementOutcome: 'unknown', receiptStatus: { outcome: 'unknown' }
    })
    const first = await deliverSinglePublisherTurn(f, conversationId, 20, 'Unused body.', {
      failBeforePublish: 'V024_INTENTIONAL_ACTOR_FAILURE', inputSeq: 40
    })
    const failed = (await f.runtime.api.getStatus({ conversationId })).run
    assert.equal(failed.phase, 'failed')
    assert.equal(failed.productCommitStaged, false)
    assert.equal(failed.productReceiptOutcome, undefined)
    assert.equal(failed.assistantSeq, undefined)
    assert.equal(failed.assistantMessageId, undefined)
    assert.equal(failed.productMessageId, undefined)
    assert.equal(failed.retryAvailable, true)
    assert.equal(f.productCommits.some(item => item.type === 'stage' || item.type === 'settle' || item.type === 'commit'), false)
    assert.equal(f.receiptStatusCalls, 0)

    const retryRequestId = 'retry-prepublication-20'
    const intent = f.runtime.api.retry({ conversationId, runId: failed.runId, requestId: retryRequestId })
    assert.equal(intent.accepted, true)
    assert.equal(intent.targetEventSeq, 40)

    const retryInput = {
      id: `${conversationId}-retry-input`, role: 'user', content: [{ type: 'text', text: 'Continue.' }],
      source: { kind: 'user', rpcId: retryRequestId }
    }
    await first.preStep({ turn: 21, messages: [retryInput], signal: new AbortController().signal }, async () => {
      throw new Error('An explicit retry must remain on the local Team delivery path')
    })
    f.emitSessionEvent(f.rootAgent.session, { seq: 41, type: 'user/message', data: retryInput })
    f.setSpawnHandler(async (root, _specification, memberRow) => {
      const childSnapshot = await f.runtime.extension.resolveSnapshot({
        sessionId: memberRow.id, parentSessionId: root.session.id, child: true, snapshot: { conversationId }
      })
      const definitions = []
      const childAgent = { session: { id: memberRow.id, parentSessionId: root.session.id } }
      const childTools = {
        schemas: () => definitions,
        register(definition) { definitions.push(definition); return () => undefined },
        view: () => ({ restrictableNames: new Set() }),
        restrict: () => () => undefined,
        guard: () => () => undefined
      }
      const childCtx = {
        scope: {}, tools: childTools, on: () => () => undefined,
        systemPrompt: { getSectionOrder: () => 0, section: () => () => undefined }
      }
      const dispose = await f.runtime.extension.setupAgent({
        agentCtx: childCtx, agent: childAgent, sessionId: memberRow.id, child: true,
        snapshot: childSnapshot, binding: { conversationId, sessionId: memberRow.id, kind: 'child' }
      })
      const publish = definitions.find(definition => definition.name === 'rp_team_publish')
      await publish.execute({ body: 'Retry succeeded.' }, { agent: childAgent, concludeTurn() {} })
      f.emitSessionEvent(childAgent.session, { seq: 77, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
      dispose?.()
      return { member: memberRow }
    })
    let delivered = ''
    for await (const chunk of f.registeredAdapters[0].adapter.stream({
      provider: TEAM_DELIVERY_PROVIDER, model: TEAM_DELIVERY_MODEL,
      sessionId: f.rootAgent.session.id, turn: 21, signal: new AbortController().signal
    })) if (chunk.type === 'text-delta') delivered += chunk.text
    assert.equal(delivered, 'Retry succeeded.')
    f.emitSessionEvent(f.rootAgent.session, { seq: 42, type: 'assistant/message', data: {
      turn: 21, step: 1, message: { role: 'assistant', id: 'retry-assistant', content: [{ type: 'text', text: delivered }] }
    } })
    await first.turnStopping({ turn: 21, signal: new AbortController().signal })
    const completed = (await f.runtime.api.getStatus({ conversationId })).run
    assert.equal(completed.phase, 'complete')
    assert.equal(completed.retrySourceRunId, failed.runId)
    assert.equal(completed.productMessageId, `${conversationId}-assistant`)
    assert.equal(f.productCommits.some(item => item.type === 'settle'), false)
  } finally {
    await f.dispose()
  }
})

test('cancelling a child before publication remains cancelled and does not ask Host to settle a missing receipt', async () => {
  const f = fixture()
  try {
    const conversationId = 'conversation-prepublication-cancel'
    const config = defaultTeamConfig()
    const publisher = structuredClone(config.agents.find(agent => agent.id === config.output.agentId))
    publisher.triggers = [{ type: 'always' }]
    publisher.context.sources = [{ type: 'current_input' }]
    publisher.communication = { sendTo: [], receiveFrom: [], requestTo: [], requestFrom: [] }
    publisher.execution.after = []
    config.agents = [publisher]
    config.output.agentId = publisher.id
    await f.runtime.api.saveConfig({ conversationId, expectedRevision: 0, enabled: true, config })
    const { listeners } = f.setupRoot(conversationId, { mountedPresetId: 'base-preset' })
    const input = {
      id: `${conversationId}-input`, role: 'user', content: [{ type: 'text', text: 'Continue.' }],
      source: { kind: 'user', rpcId: `${conversationId}-request` }
    }
    await listeners.get('agent/pre-step')[0]({ turn: 30, messages: [input], signal: new AbortController().signal }, async () => {
      throw new Error('A Team delivery should not enter the ordinary model path')
    })
    let markSpawned
    const spawned = new Promise(resolve => { markSpawned = resolve })
    f.setSpawnHandler(async (_root, specification, member) => {
      assert.match(specification.description, /rp-agent-team-activation:/)
      markSpawned(member)
      return { member }
    })
    const run = (await f.runtime.api.getStatus({ conversationId })).run
    const delivery = (async () => {
      for await (const _chunk of f.registeredAdapters[0].adapter.stream({
        provider: TEAM_DELIVERY_PROVIDER, model: TEAM_DELIVERY_MODEL,
        sessionId: f.rootAgent.session.id, turn: 30, signal: new AbortController().signal
      })) { /* no body is expected */ }
    })()
    await spawned
    const cancelled = await f.runtime.api.cancel({ conversationId, runId: run.runId })
    await assert.rejects(delivery, /Cancelled from RP Team controls|cancelled/i)
    assert.equal(cancelled.phase, 'cancelled')
    assert.equal(cancelled.productCommitStaged, false)
    assert.equal(cancelled.productReceiptOutcome, undefined)
    assert.equal(f.productCommits.some(item => item.type === 'settle' || item.type === 'stage'), false)
  } finally {
    await f.dispose()
  }
})

test('official root Session cancellation aborts and drains scheduled children, then the same root resumes ordinary RP', { timeout: 10_000 }, async () => {
  const f = fixture()
  const rootController = new AbortController()
  let finishChild
  let markSpawned
  const childFinished = new Promise(resolve => { finishChild = resolve })
  const spawned = new Promise(resolve => { markSpawned = resolve })
  let childSessionId
  try {
    const conversationId = 'conversation-official-root-cancel'
    f.setRootTurnController(rootController)
    const config = defaultTeamConfig()
    const publisher = structuredClone(config.agents.find(agent => agent.id === config.output.agentId))
    publisher.triggers = [{ type: 'always' }]
    publisher.context.sources = [{ type: 'current_input' }]
    publisher.communication = { sendTo: [], receiveFrom: [], requestTo: [], requestFrom: [] }
    publisher.execution.after = []
    config.agents = [publisher]
    config.output.agentId = publisher.id
    await f.runtime.api.saveConfig({ conversationId, expectedRevision: 0, enabled: true, config })

    const { listeners } = f.setupRoot(conversationId, { mountedPresetId: 'base-preset' })
    const input = {
      id: `${conversationId}-input`, role: 'user', content: [{ type: 'text', text: 'Wait for the child.' }],
      source: { kind: 'user', rpcId: `${conversationId}-request` }
    }
    await listeners.get('agent/pre-step')[0]({ turn: 40, messages: [input], signal: rootController.signal }, async () => {
      throw new Error('The Team root pre-step must claim its local delivery turn')
    })

    f.setDrainHandler(async (_root, ids) => {
      assert.ok(childSessionId && ids.includes(childSessionId), 'Drain omitted the active native child Session')
      await childFinished
    })
    f.setSpawnHandler(async (root, specification, memberRow) => {
      childSessionId = memberRow.id
      const childSnapshot = await f.runtime.extension.resolveSnapshot({
        sessionId: memberRow.id, parentSessionId: root.session.id, child: true,
        snapshot: { conversationId }
      })
      const definitions = []
      const childAgent = { session: { id: memberRow.id, parentSessionId: root.session.id } }
      const tools = {
        schemas: () => definitions,
        register(definition) { definitions.push(definition); return () => undefined },
        view: () => ({ restrictableNames: new Set() }),
        restrict: () => () => undefined,
        guard: () => () => undefined
      }
      const childCtx = {
        scope: {}, tools, on: () => () => undefined,
        systemPrompt: { getSectionOrder: () => 0, section: () => () => undefined }
      }
      const disposeChild = await f.runtime.extension.setupAgent({
        agentCtx: childCtx, agent: childAgent, sessionId: memberRow.id, child: true,
        snapshot: childSnapshot, binding: { conversationId, sessionId: memberRow.id, kind: 'child' }
      })
      assert.ok(definitions.some(definition => definition.name === 'rp_team_publish'))
      const stopChild = () => {
        f.emitSessionEvent(childAgent.session, {
          seq: 90, type: 'turn/end', data: { turn: 1, reason: { kind: 'aborted', error: { message: 'Official root Session cancelled' } } }
        })
        disposeChild?.()
        finishChild()
      }
      if (specification.signal.aborted) stopChild()
      else specification.signal.addEventListener('abort', stopChild, { once: true })
      markSpawned(memberRow.id)
      return { member: memberRow }
    })

    let deliveredText = ''
    const delivery = (async () => {
      for await (const chunk of f.registeredAdapters[0].adapter.stream({
        provider: TEAM_DELIVERY_PROVIDER, model: TEAM_DELIVERY_MODEL,
        sessionId: f.rootAgent.session.id, turn: 40, signal: rootController.signal
      })) {
        if (chunk.type === 'text-delta') deliveredText += chunk.text
      }
    })()
    const deliveryResult = delivery.then(
      () => ({ completed: true }),
      error => ({ error })
    )
    await spawned
    await new Promise(resolve => setImmediate(resolve))

    await f.ctx.sessionController.cancel({ sessionId: f.rootAgent.session.id })
    const result = await Promise.race([
      deliveryResult,
      new Promise((_, reject) => setTimeout(() => reject(new Error('Root cancellation did not drain Team delivery')), 3_000))
    ])
    assert.ok(result.error, 'A cancelled root turn unexpectedly completed')
    assert.match(String(result.error?.message ?? result.error), /cancel|abort/i)
    assert.equal(deliveredText, '', 'Cancellation published a partial or final user body')
    assert.equal(rootController.signal.aborted, true, 'Official Session cancellation did not abort the root turn signal')

    const run = (await f.runtime.api.getStatus({ conversationId })).run
    assert.equal(run.phase, 'cancelled')
    assert.equal(run.productCommitStaged, false)
    assert.equal(run.publication, null)
    assert.equal(f.productCommits.some(item => ['stage', 'flush', 'commit', 'settle'].includes(item.type)), false,
      'Pre-publication cancellation touched the product receipt path')
    assert.ok(f.interruptedChildren.length > 0, 'Root cancellation did not interrupt the child')
    assert.ok(f.drainedChildren.some(row => row.rootSessionId === f.rootAgent.session.id && row.ids.includes(childSessionId)),
      'Root cancellation did not drain the child Session before returning')

    const saved = await f.runtime.api.getConfig({ conversationId })
    await f.runtime.api.saveConfig({ conversationId, expectedRevision: saved.revision, enabled: false, config: saved.config })
    f.setRootTurnController(new AbortController())
    const nextInput = {
      id: `${conversationId}-ordinary-input`, role: 'user', content: [{ type: 'text', text: 'Ordinary RP resumes.' }],
      source: { kind: 'user', rpcId: `${conversationId}-ordinary-request` }
    }
    let nextCalls = 0
    const ordinaryPreStep = await listeners.get('agent/pre-step')[0]({
      turn: 41, messages: [nextInput], signal: new AbortController().signal
    }, async () => { nextCalls += 1; return { kind: 'continue', messages: [nextInput] } })
    assert.equal(nextCalls, 1)
    assert.equal(ordinaryPreStep.kind, 'continue')
    const ordinaryRequest = await listeners.get('agent/request')[0]({ turn: 41 }, async () => ({
      provider: 'global-provider', model: 'global-model', temperature: 0.55
    }))
    assert.deepEqual(ordinaryRequest, { provider: 'global-provider', model: 'global-model', temperature: 0.55 })
  } finally {
    await f.dispose()
  }
})

test('cold startup reconciles a pending receipt once without rerunning members or publication', async () => {
  const f = fixture()
  try {
    const conversationId = 'conversation-cold-receipt-recovery'
    const productMessageId = `${conversationId}-assistant`
    f.setProductBehavior({ commitReceipt: { outcome: 'pending' }, settlementOutcome: 'unknown', receiptStatus: { outcome: 'unknown' } })
    const round = await deliverSinglePublisherTurn(f, conversationId, 12, 'Published before shutdown.', {
      configure(config, publisher) {
        config.state.definitions = [{ namespace: 'shared', path: '/progress', type: 'string', default: 'before' }]
        publisher.statePermissions = [{ namespace: 'shared', path: '/progress', access: 'write' }]
        publisher.outputAuthority.state = true
      },
      beforeRun({ config }) {
        const state = new StateStore()
        const baseline = state.begin({ conversationId, runId: 'seed-shared-state', config, initialState: { shared: { progress: 'before' } } })
        state.write({ conversationId, runId: baseline.runId, agentId: config.output.agentId, namespace: 'shared', path: '/progress', value: 'before', expectedVersion: 0 })
        state.stage({ conversationId, runId: baseline.runId })
        state.commit({ conversationId, runId: baseline.runId, receipt: { outcome: 'committed', productMessageId: 'seeded-before-team' } })
      },
      async beforePublish({ definitions, childAgent }) {
        const version = definitions.find(item => item.name === 'rp_team_state_version')
        const write = definitions.find(item => item.name === 'rp_team_write_state')
        assert.ok(version)
        assert.ok(write)
        const current = await version.execute({ namespace: 'shared', path: '/progress' }, { agent: childAgent })
        await write.execute({ namespace: 'shared', path: '/progress', value: 'after', expectedVersion: current.version }, { agent: childAgent })
      }
    })
    await assert.rejects(round.preStep({ turn: round.turn, messages: [round.notice], signal: new AbortController().signal }, async () => ({})),
      /Host did not confirm the Team response commit/)
    const pending = (await f.runtime.api.getStatus({ conversationId })).run
    assert.equal(pending.phase, 'awaiting_commit')
    assert.equal(round.publicationCalls, 1)
    const beforeShutdown = new StateStore().committedSnapshot({ conversationId })
    assert.equal(beforeShutdown.namespaces.shared.progress, 'before')
    const startedModelCalls = f.adapterStreamCalls
    const startedChildren = f.spawnCalls

    await f.runtime.dispose()
    f.setProductBehavior({ receiptStatus: {
      outcome: 'committed', productMessageId, assistantMessageId: productMessageId, assistantSeq: 79
    } })
    f.restartRuntime()

    const recovered = (await f.runtime.api.getStatus({ conversationId })).run
    assert.equal(recovered.phase, 'complete')
    assert.equal(recovered.productMessageId, productMessageId)
    assert.equal(recovered.assistantMessageId, productMessageId)
    const committed = new StateStore().committedSnapshot({ conversationId })
    assert.equal(committed.namespaces.shared.progress, 'after')
    assert.equal(committed.revision, beforeShutdown.revision + 1)
    assert.equal(f.adapterStreamCalls, startedModelCalls, 'startup recovery does not ask a model to repeat the response')
    assert.equal(f.spawnCalls, startedChildren, 'startup recovery does not reactivate Team members')
    assert.equal(round.publicationCalls, 1, 'startup recovery does not repeat the publication')
    const checksAfterRecovery = f.receiptStatusCalls
    await f.runtime.api.getStatus({ conversationId })
    assert.equal(f.receiptStatusCalls, checksAfterRecovery, 'the committed receipt is reconciled exactly once')
    assert.equal(new StateStore().committedSnapshot({ conversationId }).revision, committed.revision)
  } finally {
    await f.dispose()
  }
})

test('cold recovery keeps the Host commit failure reason and the durable assistant mapping', async () => {
  const f = fixture()
  try {
    const conversationId = 'conversation-cold-failed-receipt'
    const reason = 'The durable story state failed its commit compare-and-swap.'
    f.setProductBehavior({ commitReceipt: { outcome: 'pending' }, settlementOutcome: 'unknown', receiptStatus: { outcome: 'unknown' } })
    const round = await deliverSinglePublisherTurn(f, conversationId, 14, 'Body already appended to the Session.')
    await assert.rejects(round.preStep({ turn: round.turn, messages: [round.notice], signal: new AbortController().signal }, async () => ({})),
      /Host did not confirm the Team response commit/)
    const modelCalls = f.adapterStreamCalls
    await f.runtime.dispose()
    f.setProductBehavior({ receiptStatus: {
      outcome: 'failed', reason, productMessageId: `${conversationId}-assistant`,
      assistantMessageId: `${conversationId}-assistant`, assistantSeq: 79
    } })
    f.restartRuntime()

    const recovered = (await f.runtime.api.getStatus({ conversationId })).run
    const trace = await f.runtime.api.getTrace({ conversationId, runId: recovered.runId })
    assert.equal(recovered.phase, 'failed')
    assert.equal(recovered.failure, reason)
    assert.equal(recovered.assistantSeq, 79)
    assert.equal(recovered.assistantMessageId, `${conversationId}-assistant`)
    assert.equal(trace.events.find(event => event.type === 'publication.commit_failed' && event.data.status === 'failed').data.reason, reason)
    assert.equal(trace.events.find(event => event.type === 'publication.rolled_back').data.reason, reason)
    assert.equal(f.adapterStreamCalls, modelCalls, 'receipt reconciliation does not generate a replacement response')
  } finally {
    await f.dispose()
  }
})

test('a definitive Host commit failure preserves its receipt reason in run status and trace', async () => {
  const f = fixture()
  try {
    const reason = 'The imported world checkpoint no longer matches the active story.'
    f.setProductBehavior({
      commitReceipt: { outcome: 'pending' },
      receiptStatus: { outcome: 'failed', reason }
    })
    const round = await deliverSinglePublisherTurn(f, 'conversation-commit-failure-reason', 11, 'This body reached the Session.')
    await assert.rejects(round.preStep({ turn: round.turn, messages: [round.notice], signal: new AbortController().signal }, async () => ({})),
      /Host did not confirm the Team response commit/)
    const status = (await f.runtime.api.getStatus({ conversationId: round.conversationId })).run
    const trace = await f.runtime.api.getTrace({ conversationId: round.conversationId, runId: status.runId })
    assert.equal(status.phase, 'failed')
    assert.equal(status.failure, reason, JSON.stringify({ status, commits: f.productCommits, events: trace.events }))
    assert.equal(status.assistantSeq, 79)
    assert.equal(status.assistantMessageId, `${round.conversationId}-assistant`)
    assert.equal(trace.events.find(event => event.type === 'publication.commit_failed').data.reason, reason)
    assert.equal(trace.events.find(event => event.type === 'publication.rolled_back').data.reason, reason)
  } finally {
    await f.dispose()
  }
})

test('a disabled Team root lets an ordinary native subagent settlement notice continue through the same Session', async () => {
  const f = fixture()
  try {
    const { listeners } = f.setupRoot('conversation-team-disabled')
    const notice = {
      id: 'settled-foreign-child', role: 'user', content: [{ type: 'text', text: 'A separate native child completed.' }],
      source: { kind: 'subagent-settled', form: 'notice', summary: 'Child completed.', senderSessionId: 'ordinary-child-session' }
    }
    let nextCalls = 0
    const result = await listeners.get('agent/pre-step')[0]({ turn: 1, messages: [notice], signal: new AbortController().signal }, async () => {
      nextCalls += 1
      return { kind: 'continue', messages: [notice] }
    })
    assert.equal(nextCalls, 1)
    assert.deepEqual(result.messages, [notice])
    const request = await listeners.get('agent/request')[0]({ turn: 1 }, async () => ({
      provider: 'global-provider', model: 'global-model'
    }))
    assert.deepEqual(request, { provider: 'global-provider', model: 'global-model' })
    assert.equal(f.runtime.extension.mode({ sessionId: f.rootAgent.session.id }), 'normal')
  } finally {
    await f.dispose()
  }
})

test('a Team child setup binds its Session to mutable run state, not the frozen config agent', async () => {
  const f = fixture()
  try {
    const conversationId = 'conversation-child-session-binding'
    const config = defaultTeamConfig()
    await f.runtime.api.saveConfig({ conversationId, expectedRevision: 0, enabled: true, config })
    const { listeners } = f.setupRoot(conversationId)
    const input = { id: 'child-binding-input', role: 'user', content: [{ type: 'text', text: 'Continue.' }], source: { kind: 'user' } }
    await listeners.get('agent/pre-step')[0]({ turn: 3, messages: [input], signal: new AbortController().signal }, async () => ({ kind: 'continue' }))
    const runId = (await f.runtime.api.getStatus({ conversationId })).run.runId
    const member = config.agents[0]
    const childSessionId = 'native-child-session-3'
    const tools = {
      schemas: () => [],
      view: () => ({ restrictableNames: new Set() }),
      guard: () => () => undefined
    }
    const childCtx = {
      scope: {}, tools,
      on: () => () => undefined
    }
    const dispose = await f.runtime.extension.setupAgent({
      agentCtx: childCtx, agent: { session: { id: childSessionId } }, sessionId: childSessionId, child: true,
      snapshot: { conversationId, rpTeamRunId: runId, rpTeamAgentId: member.id }
    })
    assert.equal(typeof dispose, 'function')
    dispose()
    const traceRoot = join(f.home, 'plugins', 'rp-agent-team', 'traces')
    const persisted = readRunRows(traceRoot, conversationId).find(row => row.status.runId === runId)
    assert.ok(persisted.members[member.id].sessions.includes(childSessionId),
      'native child setup persists the session on the mutable runtime member record')
    assert.equal(Object.hasOwn(member, 'sessions'), false, 'runtime sessions never mutate the frozen config agent')
  } finally {
    await f.dispose()
  }
})

test('native world patch policy is explicit in primary and nested Team child snapshots', async () => {
  const f = fixture()
  try {
    let projected
    const round = await deliverSinglePublisherTurn(f, 'conversation-native-write-policy', 13, 'World-aware response.', {
      configure(config, publisher) {
        config.state.definitions = [{ namespace: 'world', path: '/variables/truth', type: 'string', default: 'known' }]
        publisher.statePermissions = [{ namespace: 'world', path: '/variables', access: 'read' }]
        publisher.outputAuthority.state = true
      },
      async onChildSnapshot({ childSnapshot, memberRow }) {
        const variableBridge = JSON.parse(readFileSync(childSnapshot.variableStateFile, 'utf8'))
        const nestedSnapshot = await f.runtime.extension.resolveSnapshot({
          sessionId: 'nested-child-session', parentSessionId: memberRow.id, child: true, snapshot: childSnapshot
        })
        projected = { childSnapshot, variableBridge, nestedSnapshot }
      }
    })
    assert.ok(projected)
    assert.equal(projected.variableBridge.enabled, true)
    assert.equal(projected.variableBridge.writeEnabled, false)
    assert.deepEqual(projected.variableBridge.writePaths, [])
    assert.ok(projected.childSnapshot.disabledToolNames.includes('eleckoi_apply_variable_patch'))
    assert.ok(projected.nestedSnapshot.disabledToolNames.includes('eleckoi_apply_variable_patch'))
    await round.preStep({ turn: round.turn, messages: [round.notice], signal: new AbortController().signal }, async () => ({}))
    assert.equal((await f.runtime.api.getStatus({ conversationId: round.conversationId })).run.phase, 'complete')
  } finally {
    await f.dispose()
  }
})

test('native child tools await an exact requested activation and receive its projected terminal result', async () => {
  const f = fixture()
  try {
    const conversationId = 'conversation-native-handoff-await'
    const turn = 68
    const config = defaultTeamConfig()
    const requester = config.agents.find(agent => agent.id === 'agent-1')
    const target = config.agents.find(agent => agent.id === 'agent-2')
    requester.triggers = [{ type: 'always' }]
    requester.execution.after = []
    requester.outputAuthority.user = true
    requester.communication.handoffs = [{
      id: 'lookup', to: target.id, mode: 'await',
      requestSchema: { type: 'object', required: ['summary', 'data'], properties: {
        summary: { type: 'string' }, data: { type: 'object', required: ['query'], properties: { query: { type: 'string' } } }
      } },
      responseSchema: { type: 'object', required: ['summary', 'data'], properties: {
        summary: { type: 'string' }, data: { type: 'object', required: ['answer'], properties: { answer: { type: 'string' } } }
      } },
      requestSelectors: ['/summary', '/data/query'], responseSelectors: ['/summary', '/data/answer']
    }]
    target.triggers = [{ type: 'requested_by_agent', from: [requester.id] }]
    target.execution.after = []
    config.output.agentId = requester.id
    config.execution.concurrency = 1
    await f.runtime.api.saveConfig({ conversationId, expectedRevision: 0, enabled: true, config })
    const { listeners } = f.setupRoot(conversationId, { mountedPresetId: 'base-preset' })
    const input = { id: 'native-handoff-input', role: 'user', content: [{ type: 'text', text: 'Answer the question.' }], source: { kind: 'user' } }
    await listeners.get('agent/pre-step')[0]({ turn, messages: [input], signal: new AbortController().signal }, async () => {
      throw new Error('The Team root pre-step must claim this turn')
    })

    let requesterResult
    f.setSpawnHandler(async (root, _specification, memberRow) => {
      const childSnapshot = await f.runtime.extension.resolveSnapshot({
        sessionId: memberRow.id, parentSessionId: root.session.id, child: true, snapshot: { conversationId }
      })
      const childEvents = []
      const childAgent = { session: {
        id: memberRow.id, parentSessionId: root.session.id,
        snapshotEvents: () => [...childEvents]
      } }
      const definitions = []
      const tools = {
        schemas: () => definitions,
        register(definition) { definitions.push(definition); return () => undefined },
        view: () => ({ restrictableNames: new Set() }), restrict: () => () => undefined, guard: () => () => undefined
      }
      const childCtx = {
        scope: {}, tools, on: () => () => undefined,
        systemPrompt: { getSectionOrder: () => 0, section: () => () => undefined }
      }
      const dispose = await f.runtime.extension.setupAgent({
        agentCtx: childCtx, agent: childAgent, sessionId: memberRow.id, child: true,
        snapshot: childSnapshot, binding: { conversationId, sessionId: memberRow.id, kind: 'child' }
      })
      const emitChild = event => {
        childEvents.push(event)
        f.emitSessionEvent(childAgent.session, event)
      }
      const endTurn = (seq, text) => {
        emitChild({ seq, type: 'assistant/message', data: { turn: 1, step: 1, message: {
          role: 'assistant', content: [{ type: 'text', text }]
        } } })
        emitChild({ seq: seq + 1, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
        dispose?.()
      }

      if (childSnapshot.rpTeamAgentId === target.id) {
        const submit = definitions.find(definition => definition.name === 'rp_team_submit_internal')
        assert.ok(submit)
        await submit.execute({ summary: 'The answer is 42.', data: { answer: '42', hidden: 'not selected' } }, { agent: childAgent })
        endTurn(20, 'Target completed.')
        return { member: memberRow }
      }

      const request = definitions.find(definition => definition.name === 'rp_team_request')
      const publish = definitions.find(definition => definition.name === 'rp_team_publish')
      assert.ok(request && publish)
      const result = await request.execute({ to: target.id, handoffId: 'lookup', summary: 'Find the answer',
        data: { query: 'life' } }, { agent: childAgent })
      requesterResult = result
      await publish.execute({ body: `Answer: ${result.data.answer}` }, { agent: childAgent, concludeTurn() {} })
      endTurn(30, `Answer: ${result.data.answer}`)
      return { member: memberRow }
    })

    let delivered = ''
    for await (const chunk of f.registeredAdapters[0].adapter.stream({
      provider: TEAM_DELIVERY_PROVIDER, model: TEAM_DELIVERY_MODEL,
      sessionId: f.rootAgent.session.id, turn, signal: new AbortController().signal
    })) if (chunk.type === 'text-delta') delivered += chunk.text
    assert.equal(delivered, 'Answer: 42')
    assert.deepEqual(requesterResult, { summary: 'The answer is 42.', data: { answer: '42' } })
    f.emitSessionEvent(f.rootAgent.session, { seq: 79, type: 'assistant/message', data: { turn, step: 1, message: {
      role: 'assistant', id: 'native-handoff-assistant', content: [{ type: 'text', text: delivered }]
    } } })
    await listeners.get('agent/turn-stopping')[0]({ turn, signal: new AbortController().signal })

    const run = (await f.runtime.api.getStatus({ conversationId })).run
    const traceRoot = join(f.home, 'plugins', 'rp-agent-team', 'traces')
    const request = readRequestRecords(traceRoot, conversationId, run.runId)[0]
    assert.equal(request.status, 'completed')
    assert.equal(request.sourceExecutionId, `${run.runId}:agent-1:1`)
    assert.equal(request.targetExecutionId, `${run.runId}:agent-2:1`)
    assert.deepEqual(request.result, { summary: 'The answer is 42.', data: { answer: '42' } })
  } finally {
    await f.dispose()
  }
})

test('historical run import preserves durable message mapping and rewind restores its explicit pre-run state checkpoint', async () => {
  const f = fixture()
  try {
    const conversationId = 'conversation-historical-import'
    const config = defaultTeamConfig()
    const members = Object.fromEntries(config.agents.map(agent => [agent.id, {
      id: agent.id, name: agent.name, status: 'complete', result: { summary: 'Historical result.' },
      activations: 1, sessions: ['legacy-child-session']
    }]))
    const historicalRun = {
      version: 1,
      run: {
        runId: 'legacy-run-17', rootSessionId: 'stable-root-session', config,
        configRevision: 'legacy-config-revision',
        status: {
          runId: 'legacy-run-17', conversationId, phase: 'complete',
          startedAt: '2026-09-21T12:00:00.000Z', createdAt: '2026-09-21T12:00:00.000Z',
          updatedAt: '2026-09-21T12:02:00.000Z', turn: 17, outputAgentId: config.output.agentId,
          members, inputMessageId: 'legacy-user-message-17', inputEventSeq: 105,
          assistantSeq: 111, assistantMessageId: 'legacy-assistant-message-17',
          productMessageId: 'legacy-assistant-message-17',
          publication: { status: 'committed', bodyCharacters: 31, operationCount: 1 }
        },
        members, publication: { status: 'committed', bodyCharacters: 31, operationCount: 1 },
        trace: { startedAt: '2026-09-21T12:00:00.000Z', events: [
          { seq: 9, type: 'run.started', at: '2026-09-21T12:00:00.000Z', data: { categories: [] } },
          { seq: 10, type: 'publication.delivered', at: '2026-09-21T12:02:00.000Z', data: {
            sessionId: 'stable-root-session', turn: 17, bodyCharacters: 31
          } }
        ] }
      }
    }
    const baseline = { revision: 2, namespaces: { shared: { chapter: 4 } }, pathVersions: {} }
    const imported = await f.runtime.api.importHistoricalRun({ conversationId, run: historicalRun, stateBaselineBefore: baseline })
    assert.equal(imported.imported, true)
    assert.equal(imported.runId, 'legacy-run-17')
    assert.equal(imported.status.inputEventSeq, 105)
    assert.equal(imported.status.productMessageId, 'legacy-assistant-message-17')
    assert.equal(imported.status.startedAt, '2026-09-21T12:00:00.000Z')

    const stateStore = new StateStore(f.home)
    const changedBaseline = { revision: 0, namespaces: { shared: { wrong: true } }, pathVersions: {} }
    const conflictingImport = structuredClone(historicalRun)
    conflictingImport.run.status.inputEventSeq = 999
    await assert.rejects(f.runtime.api.importHistoricalRun({
      conversationId, run: conflictingImport, stateBaselineBefore: changedBaseline
    }), { code: 'RP_TEAM_IMPORT_CONFLICT' })
    assert.deepEqual(stateStore.committedBaseline({ conversationId, runId: 'legacy-run-17' }), baseline,
      'an identity conflict cannot mutate the imported restore checkpoint')

    assert.equal((await f.runtime.api.importHistoricalRun({
      conversationId, run: historicalRun, stateBaselineBefore: baseline
    })).imported, false, 're-import is idempotent')
    const traceBefore = await f.runtime.api.getTrace({ conversationId, runId: 'legacy-run-17' })
    assert.equal(traceBefore.events.find(event => event.type === 'publication.delivered').seq, 10)

    const current = { revision: 8, namespaces: { shared: { chapter: 11, latest: 'after rewind point' } },
      pathVersions: { '["shared","/chapter"]': 8 } }
    stateStore.restoreCommittedSnapshot({ conversationId, snapshot: current })
    const plan = await f.runtime.extension.prepareConversationRestore({
      conversationId, sessionId: 'stable-root-session', fromTurn: 17, beforeEventSeq: 105
    })
    await plan.apply()
    assert.deepEqual(stateStore.committedSnapshot({ conversationId }), baseline,
      'rewind restores the state captured immediately before the imported run')
    const rewound = await f.runtime.api.getTrace({ conversationId, runId: 'legacy-run-17' })
    assert.equal(rewound.events.at(-1).type, 'publication.rewound')
    assert.equal(rewound.events.at(-1).data.targetEventSeq, 105)
    await plan.rollback()
    assert.deepEqual(stateStore.committedSnapshot({ conversationId }), current,
      'a failed Host rewind can restore the pre-transaction plugin state')
    assert.deepEqual((await f.runtime.api.getTrace({ conversationId, runId: 'legacy-run-17' })).events, traceBefore.events,
      'rollback also restores imported trace data')
  } finally {
    await f.dispose()
  }
})

test('historical V1 cancellation migrates stable members and the real input mapping without inventing an assistant message', async () => {
  const f = fixture()
  try {
    const conversationId = 'conversation-historical-v1-cancelled'
    const startedAt = '2026-09-22T10:15:00.000Z'
    const legacyRun = {
      runId: 'legacy-cancelled-run', conversationId, rootSessionId: 'stable-root-session',
      configRevision: 'legacy-v1-revision', createdAt: startedAt, startedAt, turn: 1,
      phase: 'cancelled', inputMessageId: 'legacy-v1-user', inputEventSeq: 17,
      config: {
        lead: { id: 'old-lead', name: 'Old Lead', task: 'Coordinate the response.' },
        members: [
          { id: 'old-observer', name: 'Old Observer', task: 'Observe the scene.' },
          { id: 'old-writer', name: 'Old Writer', task: 'Write the response.' }
        ]
      },
      members: {
        'old-lead': { id: 'old-lead', name: 'Old Lead', status: 'cancelled', activations: 1, sessions: ['legacy-child-lead'] },
        'old-observer': { id: 'old-observer', name: 'Old Observer', status: 'complete', activations: 1, sessions: ['legacy-child-observer'] },
        'old-writer': { id: 'old-writer', name: 'Old Writer', status: 'skipped', activations: 0, sessions: [] }
      }
    }
    const baseline = { revision: 0, namespaces: {}, pathVersions: {} }
    const imported = await f.runtime.api.importHistoricalRun({
      conversationId, run: { version: 1, run: legacyRun }, stateBaselineBefore: baseline
    })
    assert.equal(imported.imported, true)
    assert.equal(imported.runId, 'legacy-cancelled-run')
    assert.equal(imported.status.phase, 'cancelled')
    assert.equal(imported.status.startedAt, startedAt)
    assert.equal(imported.status.turn, 1)
    assert.equal(imported.status.inputMessageId, 'legacy-v1-user')
    assert.equal(imported.status.inputEventSeq, 17)
    assert.equal(imported.status.outputAgentId, 'old-lead')
    assert.equal(imported.status.assistantSeq, undefined)
    assert.equal(imported.status.assistantMessageId, undefined)
    assert.equal(imported.status.productMessageId, undefined)
    assert.deepEqual(Object.keys(imported.status.members), ['old-lead', 'old-observer', 'old-writer'])
    assert.deepEqual(new StateStore(f.home).committedBaseline({ conversationId, runId: 'legacy-cancelled-run' }), baseline)
  } finally {
    await f.dispose()
  }
})

test('rewinding later runs restores the first affected pre-run state and ignores an imported cancelled run', async () => {
  const f = fixture()
  try {
    const conversationId = 'conversation-multi-run-rewind'
    const config = defaultTeamConfig()
    const members = Object.fromEntries(config.agents.map(agent => [agent.id, {
      id: agent.id, name: agent.name, status: 'complete', activations: 1, sessions: []
    }]))
    const beforeFirst = { revision: 0, namespaces: { shared: { chapter: 0 } }, pathVersions: {} }
    const beforeSecond = { revision: 1, namespaces: { shared: { chapter: 1 } }, pathVersions: { '["shared","/chapter"]': 1 } }
    const makeRun = ({ runId, turn, inputEventSeq, phase = 'complete', productMessageId }) => ({
      runId, rootSessionId: 'stable-root-session', config,
      status: {
        runId, conversationId, phase,
        startedAt: `2026-09-23T10:0${turn}:00.000Z`, createdAt: `2026-09-23T10:0${turn}:00.000Z`,
        turn, outputAgentId: config.output.agentId, members,
        inputMessageId: `user-${turn}`, inputEventSeq,
        ...(phase === 'complete' ? {
          assistantSeq: inputEventSeq + 3, assistantMessageId: `assistant-${turn}`,
          productMessageId, publication: { status: 'committed', bodyCharacters: 12 }
        } : {})
      },
      members, publication: phase === 'complete' ? { status: 'committed', bodyCharacters: 12 } : null,
      trace: { startedAt: `2026-09-23T10:0${turn}:00.000Z`, events: [] }
    })
    for (const [run, baseline] of [
      [makeRun({ runId: 'first-commit', turn: 1, inputEventSeq: 10, productMessageId: 'assistant-1' }), beforeFirst],
      [makeRun({ runId: 'cancelled-middle', turn: 2, inputEventSeq: 15, phase: 'cancelled' }), beforeSecond],
      [makeRun({ runId: 'second-commit', turn: 3, inputEventSeq: 30, productMessageId: 'assistant-3' }), beforeSecond]
    ]) {
      await f.runtime.api.importHistoricalRun({ conversationId, run, stateBaselineBefore: baseline })
    }
    const stateStore = new StateStore(f.home)
    const afterSecond = { revision: 2, namespaces: { shared: { chapter: 2 } }, pathVersions: { '["shared","/chapter"]': 2 } }
    stateStore.restoreCommittedSnapshot({ conversationId, snapshot: afterSecond })

    const rewindBeforeCancelled = await f.runtime.extension.prepareConversationRestore({
      conversationId, sessionId: 'stable-root-session', beforeEventSeq: 15
    })
    rewindBeforeCancelled.apply()
    assert.deepEqual(stateStore.committedSnapshot({ conversationId }), beforeSecond,
      'rewinding to the cancelled input removes later committed writes but keeps state from before that turn')

    stateStore.restoreCommittedSnapshot({ conversationId, snapshot: afterSecond })
    const rewindBeforeFirst = await f.runtime.extension.prepareConversationRestore({
      conversationId, sessionId: 'stable-root-session', beforeEventSeq: 10
    })
    rewindBeforeFirst.apply()
    assert.deepEqual(stateStore.committedSnapshot({ conversationId }), beforeFirst,
      'multiple affected committed runs restore the baseline preceding the earliest affected run')

    const afterReplayA = { revision: 1, namespaces: { shared: { chapter: 10 } }, pathVersions: { '["shared","/chapter"]': 1 } }
    const beforeReplayB = structuredClone(afterReplayA)
    const replayA = makeRun({ runId: 'replayed-first', turn: 1, inputEventSeq: 10, productMessageId: 'assistant-replay-1' })
    replayA.status.startedAt = '2026-10-01T10:01:00.000Z'
    const replayB = makeRun({ runId: 'replayed-second', turn: 3, inputEventSeq: 30, productMessageId: 'assistant-replay-3' })
    replayB.status.startedAt = '2026-10-01T10:03:00.000Z'
    await f.runtime.api.importHistoricalRun({ conversationId, run: replayA, stateBaselineBefore: beforeFirst })
    await f.runtime.api.importHistoricalRun({ conversationId, run: replayB, stateBaselineBefore: beforeReplayB })
    const foreignSessionRun = makeRun({ runId: 'other-session-run', turn: 3, inputEventSeq: 30, productMessageId: 'assistant-other-session' })
    foreignSessionRun.rootSessionId = 'different-root-session'
    foreignSessionRun.status.startedAt = '2026-09-01T10:00:00.000Z'
    await f.runtime.api.importHistoricalRun({
      conversationId, run: foreignSessionRun,
      stateBaselineBefore: { revision: 9, namespaces: { shared: { chapter: 999 } }, pathVersions: {} }
    })
    const afterReplayB = { revision: 2, namespaces: { shared: { chapter: 20 } }, pathVersions: { '["shared","/chapter"]': 2 } }
    stateStore.restoreCommittedSnapshot({ conversationId, snapshot: afterReplayB })
    const rewindReplayedSecond = await f.runtime.extension.prepareConversationRestore({
      conversationId, sessionId: 'stable-root-session', beforeEventSeq: 30
    })
    rewindReplayedSecond.apply()
    assert.deepEqual(stateStore.committedSnapshot({ conversationId }), beforeReplayB,
      'a reused Session sequence ignores already-rewound runs and runs bound to another root Session')
    const traceRows = await f.runtime.api.listTraces({ conversationId })
    assert.equal(traceRows.find(row => row.runId === 'second-commit').assistantMessageId, 'assistant-3')
    assert.equal(traceRows.find(row => row.runId === 'cancelled-middle').phase, 'cancelled')
  } finally {
    await f.dispose()
  }
})
