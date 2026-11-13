import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { randomUUID, createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { resolve, join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createAgent, defaultTeamConfig, normalizeTeamConfig } from '../src/shared/schema.mjs'

const option = name => {
  const index = process.argv.indexOf(name)
  return index < 0 ? undefined : process.argv[index + 1]
}
assert.ok(['--host', '--data', '--bundle'].every(name => process.argv.includes(name)),
  'Supply --host FIXED_CHECKOUT --data ISOLATED_DIR --bundle RP_TEAM.tgz')
const hostRoot = resolve(option('--host'))
const data = resolve(option('--data'))
const bundle = resolve(option('--bundle'))
const phase = option('--phase') ?? 'run'
assert.ok(['run', 'cold'].includes(phase), '--phase must be run or cold')
assert.ok(!/\\AppData\\|\\ElecKoi(?:\\|$)/iu.test(data), 'Use an isolated verification directory')
assert.ok(!data.startsWith(hostRoot + '\\'), 'Verification data must stay outside the Host checkout')
assert.ok(existsSync(bundle), `Candidate bundle not found: ${bundle}`)

const require = createRequire(join(hostRoot, 'package.json'))
const load = id => import(pathToFileURL(require.resolve(id)).href)
const { runDshDesktopHeadlessProfile } = await load('@eleckoi/desktop-host')
const { readSessionInspection } = await load('@eleckoi/dsh-product-api')
const { LlmAdapter } = await load('@deepseek-ai/dsh-llm')
const { parse } = await load('yaml')
const resourcesRoot = join(hostRoot, 'apps/desktop/resources/dsh')
const runtimeDataRoot = join(data, 'runtime')
const workspaceRoot = join(data, 'workspace')
const productDatabasePath = join(data, 'product.sqlite3')
const productMediaRoot = join(data, 'media')
const resources = {
  presetTemplatePath: join(resourcesRoot, 'agent-preset-template/agent.cordis.yml'),
  agentPatchPath: join(resourcesRoot, 'desktop-agent.patch.yml'),
  nodeBinPath: join(resourcesRoot, 'node-bin'),
  packageManagerEntryPath: join(dirname(require.resolve('pnpm')), 'bin/pnpm.mjs')
}
const overlay = join(data, 'probe.patch.yml')
const provider = 'rp-team-v050-preset-local'
const model = 'preset-worker'
const credentialRef = 'RP_TEAM_V050_PRESET_FIXTURE_KEY'
const limit = 1500
const contextWindow = 16384
const rootMarkerName = '.rp-team-preset-fixture-root'
const instructionFileName = 'RP_TEAM_MEMBER_PRESET.md'
const reportPath = join(data, 'preset-results.json')
const marker = phase === 'cold' && existsSync(reportPath)
  ? JSON.parse(readFileSync(reportPath, 'utf8')).marker
  : `RP_TEAM_NATIVE_MEMBER_PRESET_${randomUUID()}`
const fixturePresetId = `rp-team-member-fixture-${randomUUID()}`

mkdirSync(data, { recursive: true })
mkdirSync(workspaceRoot, { recursive: true })
mkdirSync(join(data, 'empty-dsh-home'), { recursive: true })
writeFileSync(join(workspaceRoot, rootMarkerName), '')
writeFileSync(join(workspaceRoot, instructionFileName), `Native preset marker: ${marker}\n`)
writeFileSync(overlay, '- id: desktop-product-telemetry\n  disabled: true\n- id: product-analytics\n  disabled: true\n')
process.env[credentialRef] = 'free-fixture-only'

function headlessProfile() {
  return runDshDesktopHeadlessProfile({
    runtimeDataRoot, workspaceRoot, productDatabasePath, productMediaRoot,
    resources, patchFiles: [overlay], environment: { DSH_TELEMETRY_DISABLED: '1' }
  })
}

async function coldPhase() {
  const previous = JSON.parse(readFileSync(reportPath, 'utf8'))
  assert.equal(previous.bundleSha256, createHash('sha256').update(readFileSync(bundle)).digest('hex'),
    'Cold phase must reopen the exact candidate bundle tested in the run phase')
  const running = await headlessProfile()
  try {
    const { ctx } = running
    if (!ctx.rpAgentTeam) {
      const installed = await ctx.pluginManager.installBundle(bundle)
      assert.equal(installed.application, 'applied', JSON.stringify(installed))
    }
    assert.ok(ctx.rpAgentTeam, 'Candidate plugin did not load in the independent cold process')
    const resolved = await ctx.agentPresets.resolve(previous.derivedPresetId)
    assert.equal(resolved.id, previous.derivedPresetId)
    const document = await ctx.agentPresets.readDocument(previous.derivedPresetId)
    const rows = parse(document.content)
    const instructions = findEntry(rows, 'agent-instructions')
    const compaction = findEntry(rows, 'compaction-basic')
    assert.ok(instructions?.config?.instructionFileCandidates?.includes(instructionFileName),
      'Cold-restored preset is missing its source instruction path')
    assert.ok(readFileSync(previous.instructionFilePath, 'utf8').includes(previous.marker),
      'Cold-restored workspace no longer contains the selected preset instruction marker')
    assert.ok(compaction, 'Cold-restored preset is missing compaction-basic')
    assert.equal(compaction.config.thresholdRatio, previous.thresholdRatio,
      'Cold restore must register the same derived compaction policy')
    const saved = JSON.parse(readFileSync(previous.derivedPresetFile, 'utf8'))
    assert.ok(saved.presets.some(recipe => recipe.id === previous.derivedPresetId),
      'Derived preset recipe must remain on disk after runtime disposal')
    writeFileSync(join(data, 'preset-cold-results.json'), JSON.stringify({
      ok: true, derivedPresetId: resolved.id, thresholdRatio: compaction.config.thresholdRatio,
      independentProcess: true, bundleSha256: previous.bundleSha256
    }, null, 2))
    console.log(JSON.stringify({ ok: true, phase: 'cold', derivedPresetId: resolved.id,
      thresholdRatio: compaction.config.thresholdRatio }))
  } finally {
    await running.shutdown.shutdown(0)
  }
}

if (phase === 'cold') {
  await coldPhase()
} else {
  const requests = []
  const usageFor = (messages, output = '') => ({
    inputTokens: Math.max(1, Math.ceil(JSON.stringify(messages).length / 4)),
    outputTokens: Math.max(1, Math.ceil(output.length / 4))
  })
  async function* text(options, value) {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: value }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: value } }
    yield { type: 'usage', usage: usageFor(options.messages, value) }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
  async function* tool(options, name, args) {
    const id = randomUUID(), value = JSON.stringify(args)
    yield { type: 'block-start', index: 0, blockType: 'tool-call' }
    yield { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: value }
    yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: value } }
    yield { type: 'usage', usage: usageFor(options.messages, value) }
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
  }
  class LocalAdapter extends LlmAdapter {
    providerInfo(id) { return { id, name: 'Free native preset verification fixture' } }
    async listModels() { return [{ provider, id: model, name: 'Preset worker', inputModalities: ['text'] }] }
    async resolveModel(providerId, modelId) {
      assert.equal(providerId, provider)
      assert.equal(modelId, model)
      return { provider: providerId, id: modelId, name: modelId, inputModalities: ['text'], context: { contextWindow } }
    }
    async *stream(options) {
      assert.equal(options.provider, provider, 'All verification model calls must use the free local adapter')
      options.signal?.throwIfAborted?.()
      const tools = (options.tools ?? []).map(item => item.name)
      const record = {
        provider: options.provider, model: options.model, purpose: options.purpose,
        sessionId: String(options.sessionId ?? ''), tools,
        promptContainsPresetMarker: JSON.stringify(options.messages).includes(marker),
        promptCharacters: JSON.stringify(options.messages).length
      }
      requests.push(record)
      assert.ok(!tools.some(name => name.startsWith('eleckoi_') || name === 'update_roleplay_plan'),
        `Product tool leaked into native request: ${tools.join(', ')}`)
      if (options.purpose === 'compaction') {
        yield* text(options, 'Summary: keep the current scene and preset instruction marker.')
        return
      }
      assert.equal(options.model, model, `Unexpected non-compaction model call: ${options.model}`)
      assert.ok(record.promptContainsPresetMarker,
        'The actual member request must contain the unique instruction from its selected native preset')
      const hasToolResult = (options.messages ?? []).some(message => message.role === 'tool')
      if (!hasToolResult) {
        assert.ok(tools.includes('rp_team_submit_internal'))
        yield* tool(options, 'rp_team_submit_internal', { summary: 'Initial member step complete.' })
      } else {
        assert.ok(tools.includes('rp_team_publish'))
        yield* tool(options, 'rp_team_publish', { body: 'Native preset and compaction verified.' })
      }
    }
  }

  const running = await headlessProfile()
  let fixturePresetDisposer
  try {
    const { ctx } = running
    await ctx.plugin({ name: 'rp-team-free-preset-verification', inject: ['llm'], apply(scope) {
      scope.llm.registerConfigurableProviders([{
        provider, displayName: 'Free preset verification fixture', settingsNs: 'llm-pi-ai', settingsPath: ['providers', provider]
      }])
      return scope.llm.registerAdapter([provider], new LocalAdapter())
    } })
    const installed = await ctx.pluginManager.installBundle(bundle)
    assert.equal(installed.application, 'applied', JSON.stringify(installed))
    assert.ok(ctx.rpAgentTeam, 'Candidate bundle did not expose its public Team API')

    const availableNativePresets = await ctx.agentPresets.list()
    const nativeBaseId = availableNativePresets.find(preset => preset.id === 'standard')?.id
    assert.ok(nativeBaseId, `The public native preset registry lacks standard: ${availableNativePresets.map(row => row.id).join(', ')}`)
    const baseDocument = await ctx.agentPresets.readDocument(nativeBaseId)
    const rows = parse(baseDocument.content)
    const instructions = findEntry(rows, 'agent-instructions')
    const baseCompaction = findEntry(rows, 'compaction-basic')
    assert.ok(instructions && baseCompaction,
      'The actual mounted native preset must include agent-instructions and compaction-basic')
    instructions.config = {
      ...(instructions.config ?? {}),
      dshHome: join(data, 'empty-dsh-home'),
      projectRootMarkers: [rootMarkerName],
      instructionFileCandidates: [instructionFileName],
      localInstructionFileCandidates: [],
      maxBytes: 8192
    }
    baseCompaction.config = {
      ...(baseCompaction.config ?? {}),
      headroomTokens: 64,
      retainTokens: 64,
      maxTokens: 128,
      compactionRetries: 0
    }
    delete baseCompaction.config.retainRatio
    fixturePresetDisposer = await ctx.agentPresets.register({
      id: fixturePresetId,
      name: 'RP Team unique prompt and compaction fixture',
      description: 'A temporary native preset for the isolated RP Agent Team acceptance script.',
      plugins: rows
    })
    assert.equal((await ctx.agentPresets.resolve(fixturePresetId)).id, fixturePresetId)

    const modelSettings = ctx.settings.describe().find(row => row.ns === 'eleckoi-client-models')
    assert.ok(modelSettings, 'The official headless profile did not expose model selection settings')
    await ctx.settings.mutate(modelSettings.ns, [
      { op: 'set', path: ['schemaVersion'], value: 2 },
      { op: 'set', path: ['entries', provider], value: {
        id: provider, name: 'Free local preset fixture', provider: 'custom', model,
        credentialRef, model_options: [{ id: model, name: 'Preset worker', inputModalities: ['text'], contextWindow }], parameters: {}
      } }
    ], modelSettings.revision)

    const characterId = randomUUID()
    const persona = { assistant_name: 'Preset Fixture Character', assistant_avatar: '', assistant_square: '', assistant_cover: '' }
    await ctx.eleckoiCharactersApi.create({ id: characterId, name: 'Preset Fixture Character', persona, primaryOpening: '' })
    const created = await ctx.eleckoiConversationsApi.create({ title: 'RP Team native preset and compaction check', metadata: {
      characterId, characterName: 'Preset Fixture Character', characterPersona: persona
    } })
    const conversationId = created.conversation.id
    await ctx.eleckoiConversationModelsApi.select(conversationId, { provider, model })

    const agent = createAgent({
      id: 'preset-member', name: 'Preset Member', description: 'Exercise the explicit native preset and automatic compaction.',
      modelRef: { provider, model }, parameters: { maxTokens: 128 }, presetId: fixturePresetId,
      compaction: { autoCompactTokenLimit: limit }, triggers: [{ type: 'always' }],
      context: { sources: [{ type: 'current_input' }] },
      outputAuthority: { internal: true, draft: false, state: false, user: true }
    })
    const config = defaultTeamConfig()
    config.agents = [agent]
    config.output = { agentId: agent.id }
    config.execution.budget = { maxRequests: 3, maxReportedTokens: 100000, maxElapsedMs: 60000 }
    const previous = await ctx.rpAgentTeam.getConfig({ conversationId })
    await ctx.rpAgentTeam.saveConfig({ conversationId, expectedRevision: previous.revision,
      enabled: true, config: normalizeTeamConfig(config) })

    const details = await ctx.eleckoiConversationsApi.details(conversationId)
    const before = await readSessionInspection(ctx, details.runtimeSessionId, AbortSignal.timeout(60000))
    const largeInput = `PRESET_COMPACTION_TRIGGER ${'A scene detail continues. '.repeat(900)}`
    const prepared = await ctx.eleckoiConversationsApi.preparePrompt(conversationId, largeInput, AbortSignal.timeout(60000))
    await ctx.sessionController.prompt({ sessionId: prepared.runtimeSessionId, requestId: randomUUID(), mode: 'queue',
      content: [{ type: 'text', text: largeInput }] }, AbortSignal.timeout(60000))
    await ctx.agents.get(prepared.runtimeSessionId).whenIdle()
    let generationError = ''
    try { await ctx.eleckoiConversationsApi.waitForGeneration(conversationId, prepared.operationId) }
    catch (error) { generationError = error.message }
    assert.equal(generationError, '', `Native generation failed: ${generationError}`)

    const status = await ctx.rpAgentTeam.getStatus({ conversationId })
    assert.equal(status.run?.phase, 'complete', JSON.stringify(status))
    const trace = await ctx.rpAgentTeam.getTrace({ conversationId, runId: status.run.runId })
    const memberSessionId = requests.find(request => request.purpose !== 'compaction')?.sessionId
    assert.ok(memberSessionId && memberSessionId !== prepared.runtimeSessionId, 'A distinct native child Session must serve the member')
    const memberInspection = await readSessionInspection(ctx, memberSessionId, AbortSignal.timeout(60000))
    const selectedEvent = memberInspection.events.find(event => event.type === 'agent-preset/selected')
    assert.ok(typeof selectedEvent?.data.agentPreset === 'string' && selectedEvent.data.agentPreset.startsWith('rp-team-'),
      'Child Session must durably select the derived native preset before its first request')
    const derivedPresetId = selectedEvent.data.agentPreset
    const workerRequests = requests.filter(request => request.sessionId === memberSessionId)
    const compactionRequests = workerRequests.filter(request => request.purpose === 'compaction')
    assert.equal(compactionRequests.length, 1, 'The native compaction plugin must make one real local summarization request')
    assert.ok(workerRequests.some(request => request.purpose !== 'compaction' && request.promptContainsPresetMarker),
      'A real member model request must contain the marker from its explicit native preset')
    assert.ok(workerRequests.every(request => request.provider === provider && request.model === model),
      'Ordinary and compaction requests must stay on the frozen fixture model')
    assert.ok(workerRequests.every(request => !request.tools.some(name => name.startsWith('eleckoi_') || name === 'update_roleplay_plan')),
      'Product tools must remain filtered on normal and compaction model requests')
    assert.ok(workerRequests.some(request => request.purpose !== 'compaction' && request.tools.includes('rp_team_publish')))
    const compactionEvents = memberInspection.events.filter(event => event.type.startsWith('compaction/'))
    assert.ok(compactionEvents.some(event => event.type === 'compaction/start'))
    assert.ok(compactionEvents.some(event => event.type === 'compaction/summary'))
    assert.ok(compactionEvents.some(event => event.type === 'compaction/end'))
    const requestHeaders = memberInspection.events.filter(event => event.type === 'request/header')
    assert.ok(requestHeaders.some(event => event.data.header?.config?.provider === provider && event.data.header?.config?.model === model),
      'Native request/header must preserve the authorized fixture model route')
    const budgetReservations = trace.events.filter(event => event.type === 'budget.request'
      && event.data.stage === 'reserved')
    assert.equal(budgetReservations.length, 3, 'The three-request run budget must account for both member calls and native compaction')
    assert.equal(budgetReservations.filter(event => event.data.purpose === 'compaction').length, 1,
      'Native compaction must consume a Team model-request budget slot')
    const newRootEvents = (await readSessionInspection(ctx, prepared.runtimeSessionId, AbortSignal.timeout(60000))).events
      .filter(event => event.seq > (before.events.at(-1)?.seq ?? -1))
    assert.equal(newRootEvents.filter(event => event.type === 'assistant/message').length, 1)
    assert.ok(JSON.stringify(newRootEvents).includes('Native preset and compaction verified.'))

    const derivedDocument = await ctx.agentPresets.readDocument(derivedPresetId)
    const derivedRows = parse(derivedDocument.content)
    const derivedCompaction = findEntry(derivedRows, 'compaction-basic')
    const derivedInstructions = findEntry(derivedRows, 'agent-instructions')
    const thresholdRatio = limit / contextWindow
    assert.equal(derivedCompaction?.config?.thresholdRatio, thresholdRatio)
    assert.ok(derivedInstructions?.config?.instructionFileCandidates?.includes(instructionFileName),
      'Derived preset must retain the explicit native instruction source')
    const derivedPresetFile = join(process.env.DSH_HOME, 'plugins', 'rp-agent-team', 'derived-presets.json')
    const derivedStorage = JSON.parse(readFileSync(derivedPresetFile, 'utf8'))
    assert.ok(derivedStorage.presets.some(recipe => recipe.id === derivedPresetId))
    const result = {
      ok: true, phase: 'run', host: hostRoot, bundle,
      bundleSha256: createHash('sha256').update(readFileSync(bundle)).digest('hex'),
      conversationId, rootSessionId: prepared.runtimeSessionId, memberSessionId,
      fixturePresetId, derivedPresetId, limit, contextWindow, thresholdRatio,
      marker, instructionFilePath: join(workspaceRoot, instructionFileName),
      actualRequests: workerRequests,
      selectedEvent: { type: selectedEvent.type, agentPreset: selectedEvent.data.agentPreset },
      compactionEvents: compactionEvents.map(event => ({ type: event.type, seq: event.seq })),
      budgetReservations: budgetReservations.map(event => ({ sessionId: event.data.sessionId,
        purpose: event.data.purpose, requestCount: event.data.requestCount })),
      derivedPresetFile
    }
    writeFileSync(reportPath, JSON.stringify(result, null, 2))
    console.log(JSON.stringify({ ok: true, phase: 'run', derivedPresetId, memberSessionId,
      compactionRequests: compactionRequests.length, reservedRequests: budgetReservations.length,
      bundleSha256: result.bundleSha256 }))
  } catch (error) {
    const failure = { ok: false, phase: 'run', message: error.message, stack: error.stack,
      requests: requests.map(({ promptContainsPresetMarker, promptCharacters, ...request }) => ({
        ...request, promptContainsPresetMarker, promptCharacters
      })) }
    writeFileSync(join(data, 'preset-failure.json'), JSON.stringify(failure, null, 2))
    console.error(error)
    process.exitCode = 1
  } finally {
    await fixturePresetDisposer?.()
    await running.shutdown.shutdown(process.exitCode ?? 0)
  }

  if (process.exitCode == null || process.exitCode === 0) {
    const script = fileURLToPath(import.meta.url)
    const child = spawnSync(process.execPath, [script, '--phase', 'cold', '--host', hostRoot, '--data', data, '--bundle', bundle], {
      cwd: dirname(script), encoding: 'utf8', timeout: 120000, windowsHide: true
    })
    if (child.stdout) process.stdout.write(child.stdout)
    if (child.stderr) process.stderr.write(child.stderr)
    if (child.error) throw child.error
    if (child.status !== 0) process.exitCode = child.status ?? 1
  }
}

function findEntry(rows, id) {
  for (const row of rows ?? []) {
    if (row?.id === id) return row
    if (Array.isArray(row?.config)) {
      const nested = findEntry(row.config, id)
      if (nested) return nested
    }
  }
}
