import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { randomUUID, createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve, delimiter } from 'node:path'
import { pathToFileURL } from 'node:url'

const flag = name => process.argv[process.argv.indexOf(name) + 1]
assert.ok(process.argv.includes('--host') && process.argv.includes('--data'), 'Supply --host CLEAN_OFFICIAL_SOURCE --data NEW_ISOLATED_DIRECTORY')
assert.ok(process.argv.includes('--bundle') || process.argv.includes('--reopen'), 'Supply --bundle PACKED_SAMPLE.tgz; a source-directory link does not verify installed-package DSH scope identity')
const hostRoot = resolve(flag('--host'))
const dataRoot = resolve(flag('--data'))
const pluginRoot = resolve(import.meta.dirname, '..')
const hostRequire = createRequire(join(hostRoot, 'package.json'))
const load = name => import(pathToFileURL(hostRequire.resolve(name)).href)
const { initProfile, loadProfileDirectory, loadLayeredEnv, PROFILE_TEMPLATES } = await load('@deepseek-ai/dsh-app-boot')
const { runProfile } = await load('@deepseek-ai/dsh/profile-boot')
const { ELECKOI_DESKTOP_BUNDLES, ELECKOI_INSTALL_ANCHOR } = await load('@eleckoi/desktop-host')
const { LlmAdapter } = await load('@deepseek-ai/dsh-llm')
const resources = join(hostRoot, 'apps', 'desktop', 'resources', 'dsh')
const home = join(dataRoot, 'home')
const profilePath = join(home, 'profiles', 'desktop')
const provider = 'rp-team-official-local'
const requests = []
const observations = []
const modelCounts = new Map()
const activationTokens = new WeakMap()
const signal = () => AbortSignal.timeout(60_000)
const env = {
  DSH_HOME: home, DSH_SESSION_ROOT: join(dataRoot, 'sessions'), DSH_CWD: join(dataRoot, 'workspace'),
  ELECKOI_DATABASE_PATH: join(dataRoot, 'product.sqlite3'), ELECKOI_MEDIA_ROOT: join(dataRoot, 'media'),
  ELECKOI_WORKSPACE_ROOT: join(dataRoot, 'workspace'), ELECKOI_SESSION_SNAPSHOT_ROOT: join(dataRoot, 'snapshots'),
  ELECKOI_PRESET_ROOT: join(dataRoot, 'presets'), ELECKOI_SESSION_BRIDGE_ROOT: join(dataRoot, 'bridges'),
  ELECKOI_PRESET_TEMPLATE_PATH: join(resources, 'agent-preset-template', 'agent.cordis.yml'),
  DSH_TELEMETRY_DISABLED: '1',
}
for (const path of [dataRoot, home, env.DSH_SESSION_ROOT, env.DSH_CWD, env.ELECKOI_MEDIA_ROOT]) mkdirSync(path, { recursive: true })
Object.assign(process.env, env)
const patchPath = join(dataRoot, 'probe.patch.yml')
writeFileSync(patchPath, '- id: desktop-product-telemetry\n  disabled: true\n- id: product-analytics\n  disabled: true\n- id: agent-team\n  config:\n    maxMembers: 64\n' + (process.argv.includes('--native-ui') ? '- id: eleckoi-client-shell\n  disabled: true\n' : ''))
const profileExists = process.argv.includes('--reopen')
if (!profileExists) initProfile(profilePath, [...PROFILE_TEMPLATES.web.bundles, ...ELECKOI_DESKTOP_BUNDLES, '@deepseek-ai/dsh-experimental-agent-team-profile'])

async function* call(name, args, sessionId, count) {
  const id = `${name}-${sessionId}-${count}`
  const argumentsText = JSON.stringify(args)
  yield { type: 'block-start', index: 0, blockType: 'tool-call' }
  yield { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: argumentsText }
  yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: argumentsText } }
  yield { type: 'finish', reason: { kind: 'tool-calls' } }
}
async function* text(text) {
  yield { type: 'block-start', index: 0, blockType: 'text' }
  yield { type: 'text-delta', index: 0, text }
  yield { type: 'block-end', index: 0, block: { type: 'text', text } }
  yield { type: 'finish', reason: { kind: 'stop' } }
}
const messagesText = messages => JSON.stringify(messages)

class LocalAdapter extends LlmAdapter {
  providerInfo(id) { return { id, name: 'Local deterministic tool-team probe' } }
  async listModels() { return ['root', 'observer', 'actor'].map(id => ({ provider, id, name: id, inputModalities: ['text'] })) }
  async resolveModel(providerId, id) { assert.equal(providerId, provider); return { provider, id, name: id, inputModalities: ['text'], context: { contextWindow: 100000 } } }
  async *stream(options) {
    assert.equal(options.provider, provider, 'All requests must stay on the free local adapter')
    options.signal.throwIfAborted()
    const session = await activeCtx.sessionController.inspect(options.sessionId, options.signal)
    const turn = session.events.findLast(event => event.type === 'step/start')?.data.turn
    const liveAgent = activeCtx.agents.get(options.sessionId)
    if (!activationTokens.has(liveAgent)) activationTokens.set(liveAgent, randomUUID())
    const countKey = `${activationTokens.get(liveAgent)}:${turn}`
    const count = modelCounts.get(countKey) ?? 0
    modelCounts.set(countKey, count + 1)
    const input = messagesText(options.messages)
    requests.push({ sessionId: options.sessionId, model: options.model, count, tools: (options.tools ?? []).map(tool => tool.name), messages: options.messages })
    if (options.model === 'root') {
      // Every root turn performs the real registered tool; no fake Session events.
      if (count === 0) {
        yield* call('rp_team_run', {}, options.sessionId, count); return
      }
      const previousTool = options.messages.findLast(message => message.role === 'tool')
      if (previousTool?.isError) { yield* text('<FINAL>TEAM_TOOL_FAILED</FINAL>'); return }
      yield* text('<FINAL>OFFICIAL_TOOL_TEAM_BODY</FINAL>'); return
    }
    assert.ok(!input.includes('HIDDEN_WORLD_SECRET'), 'Member request leaked a hidden variable/setting through an inherited path')
    if (input.includes('NESTED_ACL_PROBE')) {
      if (count === 0) { yield* call('rp_tool_read', {}, options.sessionId, count); return }
      assert.ok(!input.includes('"/score":'), 'Actor descendant inherited an observer-only state field')
      yield* text('NESTED_ACL_COMPLETE'); return
    }
    if (input.includes('RESUMED_ACL_PROBE')) {
      if (count === 0) { yield* call('rp_tool_read', {}, options.sessionId, count); return }
      assert.ok(!input.includes('HIDDEN_WORLD_SECRET'))
      yield* text('RESUMED_ACL_COMPLETE'); return
    }
    if (input.includes('PROBE_FAIL') && options.model === 'observer') throw new Error('PROBE_LOCAL_MEMBER_FAILURE')
    if (input.includes('PROBE_CANCEL') && options.model === 'observer') {
      observations.push({ kind: 'waiting-cancel', sessionId: options.sessionId })
      await new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true })); return
    }
    if (count === 0) { yield* call('rp_tool_read', {}, options.sessionId, count); return }
    if (options.model === 'observer' && count === 1) {
      assert.ok(input.includes('PUBLIC_SETTING_BODY'), 'Authorized setting content must reach the actual member request')
      assert.ok(input.includes('Synthetic tool team'), 'Actual character persona must reach the actual member request')
      // Deliberately guess a hidden inherited tool: verify execution denial,
      // rather than assuming an absent schema is sufficient isolation.
      yield* call('eleckoi_glob_variables', { pattern: '**' }, options.sessionId, count); return
    }
    if (options.model === 'observer' && count === 2) {
      assert.ok(input.includes('This member may only use its scoped team tools'))
      yield* call('rp_tool_send', { to: 'actor', body: 'SCOPED_OBSERVATION: the user sounded brief.' }, options.sessionId, count); return
    }
    if (options.model === 'observer' && count === 3) {
      yield* call('rp_tool_submit', { summary: 'SCOPED_OBSERVATION', privateDelta: { remembered: input.includes('PROBE_SECOND') ? 'SECOND_MEMORY' : 'PUBLIC_MEMORY' }, productDelta: { score: 2 } }, options.sessionId, count); return
    }
    if (options.model === 'actor' && !input.includes('SCOPED_OBSERVATION:')) {
      // Wait for the real native mailbox delivery; the adapter is a controlled
      // fixture, and this wait does not generate a model request or Session row.
      const until = Date.now() + 10000
      while (Date.now() < until) {
        options.signal.throwIfAborted()
        const inspection = await activeCtx.sessionController.inspect(options.sessionId, options.signal)
        if (JSON.stringify(inspection.events).includes('SCOPED_OBSERVATION:')) break
        await new Promise(resolve => setTimeout(resolve, 10))
      }
    }
    if (options.model === 'actor' && count === 1) {
      if (input.includes('PROBE_NESTED')) {
        const nested = await activeCtx.subagents.start('spawn', { parent: activeCtx.agents.get(options.sessionId), prompt: [{ type: 'text', text: 'NESTED_ACL_PROBE' }], signal: options.signal, toolFilter: { allow: [] } })
        try { await nested.result } finally { await nested.dispose() }
        observations.push({ kind: 'nested-acl', sessionId: nested.localAgent?.id })
      }
      yield* call('rp_tool_submit', { summary: 'OFFICIAL_TOOL_TEAM_BODY', privateDelta: { expressed: true } }, options.sessionId, count); return
    }
    yield* text('Internal member work complete.')
  }
}

let activeCtx
async function start() {
  const profile = loadProfileDirectory('dsh', profilePath, ELECKOI_INSTALL_ANCHOR)
  assert.deepEqual(profile.skippedBundles, [])
  const running = await runProfile({ environment: loadLayeredEnv('dsh'), profile: 'desktop', resolvedProfile: { profile, installAnchor: ELECKOI_INSTALL_ANCHOR },
    patchFiles: [patchPath, join(resources, 'desktop-agent.patch.yml')], args: ['--no-open', '--port', '0'],
    packageManager: { command: process.execPath, args: ['--expose-internals', join(dirname(hostRequire.resolve('pnpm')), 'bin', 'pnpm.mjs')],
      env: { ...process.env, ...env, DSH_DESKTOP_NODE_EXECUTABLE: process.execPath, PATH: `${join(resources, 'node-bin')}${delimiter}${process.env.PATH}` } },
  })
  activeCtx = running.ctx
  await activeCtx.plugin({ name: 'local-tool-team-model', inject: ['llm'], apply(ctx) {
    ctx.llm.registerConfigurableProviders([{ provider, displayName: 'Local probe', settingsNs: 'llm-pi-ai', settingsPath: ['providers', provider] }])
    return ctx.llm.registerAdapter([provider], new LocalAdapter())
  } })
  return running
}

const config = timing => ({ publisherId: 'actor', productWriteTiming: timing, members: [
  { id: 'observer', description: 'Restricted observer', systemPrompt: 'Read permitted observations, communicate them, then submit. Do not inspect unrelated files.',
    model: { provider, model: 'observer' }, variablePaths: ['/score'], characterPaths: ['/assistant_name'], settingIds: ['public-setting'], sendTo: ['actor'], writePrivateKeys: ['remembered'], writeVariableKeys: ['score'] },
  { id: 'actor', description: 'Subjective actor', systemPrompt: 'Use limited observations, receive the observer’s native message, then submit a short RP candidate.',
    model: { provider, model: 'actor' }, variablePaths: [], characterPaths: ['/assistant_name'], settingIds: [], readPrivate: true, writePrivateKeys: ['expressed'] },
] })

async function persistModelMetadata(ctx) {
  const ns = ctx.settings.describe().find(row => row.ns === 'eleckoi-client-models')
  await ctx.settings.mutate(ns.ns, [{ op: 'set', path: ['schemaVersion'], value: 2 }, { op: 'set', path: ['entries', provider], value: {
    id: provider, name: 'Local test only', provider: 'custom', model: 'root', credentialRef: 'UNUSED_LOCAL_KEY',
    model_options: ['root', 'observer', 'actor'].map(id => ({ id, name: id, inputModalities: ['text'] })),
    parameters: {},
  } }], ns.revision)
}

async function conversation(ctx, timing = 'none') {
  const characterId = randomUUID()
  const persona = { assistant_name: 'Synthetic tool team', assistant_avatar: '', assistant_square: '', assistant_cover: '' }
  ctx.eleckoiCharactersApi.create({ id: characterId, name: 'Synthetic tool team', persona, primaryOpening: '' })
  const library = ctx.eleckoiCharacterConfigurationApi.readSettingLibrary(characterId)
  const now = new Date().toISOString()
  const entries = [['public-setting', 'PUBLIC_SETTING_BODY'], ['hidden-setting', 'HIDDEN_WORLD_SECRET']].map(([id, content], order) => ({
    id, title: id, iconId: '', kind: 'normal', groupId: '', content, openingMessages: [], defaultOpeningMessageId: '',
    agentSelectionHint: '', agentReadStrategy: 'required', dynamicMode: 'standard', contentMode: 'plain_text',
    keywords: [], keywordScanDepth: 2, conditionKeywords: [], keywordCondition: 'none', keywordUseRegex: false,
    keywordIgnoreCase: true, keywordWholeWord: false, keywordRecursionDepth: 0, triggerMode: 'always', enabled: true,
    position: 'insert_point_1', promptPositionId: '', insertRole: 'user', order, viewOrder: order, groupViewOrder: 0,
    treeViewOrder: order, createdAt: now, updatedAt: now,
  }))
  library.entries = entries
  const activeVersion = library.versions.find(version => version.id === library.activeVersionId)
  if (activeVersion) activeVersion.entries = entries
  ctx.eleckoiCharacterConfigurationApi.saveSettingLibrary(characterId, library)
  const vars = ctx.eleckoiCharacterConfigurationApi.readVariableConfig(characterId)
  vars.variables.push(...[['score', 'number', '1'], ['hidden', 'string', 'HIDDEN_WORLD_SECRET']].map(([title, type, defaultValue]) => ({
    id: randomUUID(), title, objectId: '', enabled: true, type, defaultValue, description: '', updateRule: '', readMode: 'required', order: 1, treeViewOrder: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  })))
  ctx.eleckoiCharacterConfigurationApi.saveVariableConfig(characterId, vars)
  const details = await ctx.eleckoiConversationsApi.create({ title: `Public tool probe ${timing}`, metadata: { characterId, characterName: 'Synthetic tool team', characterPersona: persona } })
  const id = details.conversation.id
  await ctx.eleckoiConversationModelsApi.select(id, { provider, model: 'root' })
  ctx.rpOfficialToolTeam.bind(id, config(timing))
  return id
}

async function send(ctx, id, input, cancel = false) {
  const before = await ctx.sessionController.inspect(id)
  const prepared = await ctx.eleckoiConversationsApi.preparePrompt(id, input, signal())
  const work = ctx.sessionController.prompt({ sessionId: id, requestId: randomUUID(), mode: 'queue', content: [{ type: 'text', text: input }] }, signal())
  if (cancel) {
    const until = Date.now() + 10000
    while (!observations.some(row => row.kind === 'waiting-cancel') && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 10))
    assert.ok(observations.some(row => row.kind === 'waiting-cancel'))
    ctx.agents.get(id).cancel({ kind: 'user' })
  }
  await work
  await ctx.agents.get(id).whenIdle()
  let productError = ''
  try { await ctx.eleckoiConversationsApi.waitForGeneration(id, prepared.operationId) } catch (error) { productError = String(error.message) }
  const inspection = await ctx.sessionController.inspect(id)
  return { inspection, productError, newEvents: inspection.events.filter(event => event.seq > (before.events.at(-1)?.seq ?? -1)) }
}

let running
const sampleDir = join(pluginRoot, 'examples', 'official-tool-team')
const source = ['index.mjs', 'runtime.mjs', 'journal.mjs'].map(file => readFileSync(join(sampleDir, file), 'utf8')).join('\n')
assert.ok(!source.includes('eleckoiConversationLifecycle'), 'Sample must not even inject the three-callback service')
const result = { hostCommit: 'd4b6bb949771693cd357ddd535ead22f4e835774', dshCommit: 'c1b47e41fcd54d20a0f061df28683bfc29ee24e5', lifecycleRegistrationEvidence: 'sample-source-does-not-reference-lifecycle-service', scenarios: [] }
try {
  running = await start()
  const ctx = running.ctx
  assert.ok(ctx.agentTeams, 'The official team profile must provide the roster and UI bundle')
  if (!profileExists) {
    const installed = await ctx.pluginManager.installBundle(process.argv.includes('--bundle') ? resolve(flag('--bundle')) : sampleDir)
    assert.equal(installed.application, 'applied', JSON.stringify(installed))
    await persistModelMetadata(ctx)
  }
  assert.ok(ctx.rpOfficialToolTeam, 'The ordinary installed tool bundle must load without host-patch')
  if (profileExists) {
    const previous = JSON.parse(readFileSync(join(dataRoot, 'results.json'), 'utf8'))
    const id = previous.successConversationId
    ctx.rpOfficialToolTeam.bind(id, config('none'))
    const state = await ctx.rpOfficialToolTeam.state(id)
    assert.deepEqual(state, { remembered: 'PUBLIC_MEMORY', expressed: true })
    assert.equal(JSON.parse(ctx.eleckoiConversationsApi.authorState(previous.writeConversationId).currentVariableStateJson).score, 9)
    result.scenarios.push({ name: 'independent-process-reopen', passed: true, privateState: state })
  } else {
    const id = await conversation(ctx)
    ctx.rpOfficialToolTeam.bind(id, config('none')) // Rebinding a live root is idempotent.
    const sent = await send(ctx, id, 'PROBE_SUCCESS')
    assert.equal(sent.productError, '')
    const bodies = sent.newEvents.filter(event => event.type === 'assistant/message' && event.data.message.content.some(block => block.type === 'text'))
    assert.equal(bodies.filter(event => JSON.stringify(event.data.message.content).includes('OFFICIAL_TOOL_TEAM_BODY')).length, 1)
    assert.deepEqual(await ctx.rpOfficialToolTeam.state(id), { remembered: 'PUBLIC_MEMORY', expressed: true })
    assert.ok(requests.find(request => request.sessionId === id).tools.includes('rp_team_run'), 'The root model must see the registered team tool schema before it calls it')
    assert.ok(requests.filter(request => request.model === 'actor').some(request => messagesText(request.messages).includes('SCOPED_OBSERVATION:')), 'Communication must appear in a real member request')
    const root = ctx.agents.get(id)
    const members = ctx.agentTeams.listMembers(root).filter(member => member.role === 'teammate')
    assert.equal(members.length, 2)
    for (const member of members) {
      const inspection = await ctx.sessionController.inspect(member.id)
      assert.ok(inspection.events.some(event => event.type === 'assistant/message'))
      assert.ok(inspection.events.some(event => event.type === 'tool/result'))
    }
    result.successConversationId = id
    result.scenarios.push({ name: 'two-member-tools-publication-roster-private-state', passed: true, members: members.map(member => member.id) })

    const resumedMember = ctx.rpOfficialToolTeam.runs().findLast(run => run.conversationId === id).members.find(member => member.agentId === 'actor')
    await ctx.subagents.prompt({ parentSessionId: id, childSessionId: resumedMember.sessionId, requestId: randomUUID(), mode: 'continuable', delivery: 'queue', content: [{ type: 'text', text: 'RESUMED_ACL_PROBE' }] }, signal())
    await ctx.agents.get(resumedMember.sessionId)?.whenIdle()
    assert.ok(requests.some(request => messagesText(request.messages).includes('RESUMED_ACL_PROBE')))
    assert.deepEqual(await ctx.rpOfficialToolTeam.state(id), { remembered: 'PUBLIC_MEMORY', expressed: true })
    result.scenarios.push({ name: 'resumed-member-reapplies-scope-without-changing-closed-run', passed: true })

    await send(ctx, id, 'PROBE_SECOND')
    assert.deepEqual(await ctx.rpOfficialToolTeam.state(id), { remembered: 'SECOND_MEMORY', expressed: true })
    const beforeDelete = await ctx.sessionController.inspect(id)
    const secondBody = beforeDelete.events.findLast(event => event.type === 'assistant/message' && event.data.message.content.some(block => block.text?.includes('OFFICIAL_TOOL_TEAM_BODY')))
    await ctx.eleckoiConversationsApi.deleteMessagesFrom(id, secondBody.seq, 'assistant')
    assert.deepEqual(await ctx.rpOfficialToolTeam.state(id), { remembered: 'PUBLIC_MEMORY', expressed: true })
    const afterDelete = await ctx.sessionController.inspect(id)
    const firstUser = afterDelete.events.find(event => event.type === 'user/message' && event.data.source?.kind === 'user')
    const regenRequestId = randomUUID()
    const preparedRegen = await ctx.eleckoiConversationsApi.regenerateMessage(id, firstUser.seq, regenRequestId)
    await ctx.eleckoiConversationsApi.startRegeneration(id, regenRequestId, false)
    await ctx.agents.get(id).whenIdle()
    await ctx.eleckoiConversationsApi.waitForGeneration(id, preparedRegen.operationId)
    assert.deepEqual(await ctx.rpOfficialToolTeam.state(id), { remembered: 'PUBLIC_MEMORY', expressed: true })
    result.scenarios.push({ name: 'multi-turn-delete-regenerate-private-state-follows-active-output-identities', passed: true })

    const nestedId = await conversation(ctx)
    await send(ctx, nestedId, 'PROBE_NESTED')
    assert.ok(observations.some(observation => observation.kind === 'nested-acl'))
    result.scenarios.push({ name: 'nested-native-agent-inherits-actor-scope', passed: true })

    const writeId = await conversation(ctx, 'during-tool')
    const wrote = await send(ctx, writeId, 'PROBE_WRITE_DURING')
    assert.ok(wrote.productError, 'Immediate database replacement should expose the genuine product baseline conflict')
    assert.equal(JSON.parse(ctx.eleckoiConversationsApi.authorState(writeId).currentVariableStateJson).score, 2)
    assert.deepEqual(await ctx.rpOfficialToolTeam.state(writeId), {})
    result.scenarios.push({ name: 'during-generation-variable-write', actual: 'database-write-succeeds-product-save-conflicts', productError: wrote.productError })

    const afterWriteId = await conversation(ctx)
    await send(ctx, afterWriteId, 'PROBE_AFTER_SAVE')
    const beforeHistory = await ctx.eleckoiConversationsApi.variableTimeline(afterWriteId)
    const current = JSON.parse(ctx.eleckoiConversationsApi.authorState(afterWriteId).currentVariableStateJson)
    ctx.eleckoiConversationsApi.replaceVariableState(afterWriteId, JSON.stringify({ ...current, score: 9 }))
    assert.equal(JSON.parse(ctx.eleckoiConversationsApi.authorState(afterWriteId).currentVariableStateJson).score, 9)
    const afterHistory = await ctx.eleckoiConversationsApi.variableTimeline(afterWriteId)
    assert.deepEqual(afterHistory.floors, beforeHistory.floors)
    const afterWriteSession = await ctx.sessionController.inspect(afterWriteId)
    const savedBody = afterWriteSession.events.findLast(event => event.type === 'assistant/message' && event.data.message.content.some(block => block.text?.includes('OFFICIAL_TOOL_TEAM_BODY')))
    await ctx.eleckoiConversationsApi.deleteMessagesFrom(afterWriteId, savedBody.seq, 'assistant')
    const restoredScore = JSON.parse(ctx.eleckoiConversationsApi.authorState(afterWriteId).currentVariableStateJson).score
    assert.equal(restoredScore, 1, 'Deleting the body restores its original product checkpoint, not the later independent write')
    assert.deepEqual(await ctx.rpOfficialToolTeam.state(afterWriteId), {})
    // Explicitly write 9 again for the separate-process persistence check. This
    // is a new author edit, not a claim that the deleted checkpoint retained 9.
    ctx.eleckoiConversationsApi.replaceVariableState(afterWriteId, JSON.stringify({ ...current, score: 9 }))
    result.scenarios.push({ name: 'after-save-variable-write', actual: 'current-database-changes-existing-floor-does-not-delete-restores-1', beforeHistory, afterHistory, restoredScore })
    result.writeConversationId = afterWriteId

    const failedId = await conversation(ctx)
    await send(ctx, failedId, 'PROBE_FAIL')
    assert.deepEqual(await ctx.rpOfficialToolTeam.state(failedId), {})
    assert.equal(ctx.rpOfficialToolTeam.runs().findLast(run => run.conversationId === failedId).status, 'failed')
    result.scenarios.push({ name: 'member-failure-discards-private-state', passed: true })

    const cancelledId = await conversation(ctx)
    await send(ctx, cancelledId, 'PROBE_CANCEL', true)
    assert.deepEqual(await ctx.rpOfficialToolTeam.state(cancelledId), {})
    assert.equal(ctx.rpOfficialToolTeam.runs().findLast(run => run.conversationId === cancelledId).status, 'cancelled')
    result.scenarios.push({ name: 'cancel-drains-children-and-discards-private-state', passed: true })
  }
  result.requests = requests
  result.journal = ctx.rpOfficialToolTeam.runs()
  result.bundle = (await ctx.pluginManager.listBundles()).find(bundle => bundle.name === '@rp-team/official-tool-team')
  const loadedDir = join(profilePath, 'node_modules', '@rp-team', 'official-tool-team')
  result.loadedHashes = Object.fromEntries(['index.mjs', 'runtime.mjs', 'journal.mjs'].map(file => {
    const hash = data => createHash('sha256').update(data).digest('hex')
    const sourceHash = hash(readFileSync(join(sampleDir, file)))
    const loadedHash = hash(readFileSync(join(loadedDir, file)))
    assert.equal(loadedHash, sourceHash, `Installed ${file} differs from the reviewed source`)
    return [file, loadedHash]
  }))
  if (process.argv.includes('--uninstall')) {
    const id = result.successConversationId ?? JSON.parse(readFileSync(join(dataRoot, 'results.json'), 'utf8')).successConversationId
    const liveRoot = ctx.agents.get(id)
    const priorApi = ctx.rpOfficialToolTeam
    await ctx.pluginManager.setBundleEnabled('@rp-team/official-tool-team', false)
    if (liveRoot) assert.ok(!liveRoot.ctx.tools.schemas().some(tool => tool.name === 'rp_team_run'), 'Disable must release the scoped root tool')
    await ctx.pluginManager.removeBundle('@rp-team/official-tool-team')
    assert.ok(!(await ctx.pluginManager.listBundles()).some(bundle => bundle.name === '@rp-team/official-tool-team'))
    assert.ok((await ctx.sessionController.inspect(id)).events.some(event => event.type === 'assistant/message'))
    const reinstalled = await ctx.pluginManager.installBundle(process.argv.includes('--bundle') ? resolve(flag('--bundle')) : sampleDir)
    assert.equal(reinstalled.application, 'applied')
    assert.notEqual(ctx.rpOfficialToolTeam, priorApi, 'Reinstallation must create a fresh plugin instance')
    ctx.rpOfficialToolTeam.bind(id, config('none'))
    assert.deepEqual(await ctx.rpOfficialToolTeam.state(id), { remembered: 'PUBLIC_MEMORY', expressed: true })
    result.scenarios.push({ name: 'disable-uninstall-reinstall-preserves-native-session-and-private-state', passed: true, liveRootToolReleaseChecked: Boolean(liveRoot) })
  }
  writeFileSync(join(dataRoot, profileExists ? 'reopen-results.json' : 'results.json'), JSON.stringify(result, null, 2))
  console.log(JSON.stringify({ ok: true, result: join(dataRoot, profileExists ? 'reopen-results.json' : 'results.json'), scenarios: result.scenarios.map(row => row.name) }))
  if (process.argv.includes('--ui')) {
    const previous = JSON.parse(readFileSync(join(dataRoot, 'results.json'), 'utf8'))
    writeFileSync(join(dataRoot, 'ui-ready.json'), JSON.stringify({ url: ctx.connection.authenticatedUrl(`http://127.0.0.1:${ctx.webServer.port}`), conversationId: previous.successConversationId }))
    const deadline = Date.now() + 180000
    while (!existsSync(join(dataRoot, 'ui.done')) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 250))
  }
} catch (error) {
  writeFileSync(join(dataRoot, 'failed-results.json'), JSON.stringify({ ...result, error: error.stack, requests }, null, 2))
  throw error
} finally { await running?.ctx.fiber.dispose() }
