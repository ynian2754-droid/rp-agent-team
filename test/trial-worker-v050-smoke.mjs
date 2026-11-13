import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parse as parseYaml } from 'yaml'
import { defaultTeamConfig } from '../src/shared/schema.mjs'
import { createTrialApi } from '../src/host/trials.mjs'
import { runTrialWorkerProcess } from '../src/host/trial-worker-client.mjs'
import { trialVariantStorageKey } from '../src/host/trial-worker.mjs'
import { TrialStorage } from '../src/host/trial-storage.mjs'
import { startTrialLocalModelServer } from './fixtures/trial-local-model-server.mjs'

const args = parseArgs(process.argv.slice(2))
const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const hostRoot = resolve(args.host)
const dataRoot = resolve(args.data)
const bundlePath = resolve(args.bundle)
const adaptationRoot = resolve(dirname(dirname(pluginRoot)), 'output', 'v051-adaptation')
assert.ok(dataRoot.startsWith(`${adaptationRoot}${sep}`), '--data must be a dedicated workspace output/v051-adaptation child directory.')
assert.ok(isAbsolute(hostRoot) && existsSync(join(hostRoot, 'apps', 'desktop-host', 'package.json')), '--host must point to the fixed ElecKoi checkout.')
assert.ok(existsSync(bundlePath), '--bundle must point to the already-built RP Team .tgz.')
if (existsSync(dataRoot)) throw new Error(`Smoke data path already exists; choose a fresh isolated path: ${dataRoot}`)
mkdirSync(dataRoot, { recursive: true })

const desktopHostPackagePath = join(hostRoot, 'apps', 'desktop-host', 'package.json')
const desktopHostPackage = JSON.parse(readFileSync(desktopHostPackagePath, 'utf8'))
const publicEsmEntry = desktopHostPackage.exports?.['.']?.import?.default
if (typeof publicEsmEntry !== 'string') throw new Error('@eleckoi/desktop-host has no public ESM package-root export.')
const desktopHostUrl = pathToFileURL(join(dirname(desktopHostPackagePath), publicEsmEntry)).href
const hostRequire = createRequire(desktopHostPackagePath)
const resourcesRoot = join(hostRoot, 'apps', 'desktop', 'resources', 'dsh')
const resources = {
  presetTemplatePath: join(resourcesRoot, 'agent-preset-template', 'agent.cordis.yml'),
  agentPatchPath: join(resourcesRoot, 'desktop-agent.patch.yml'),
  nodeBinPath: join(resourcesRoot, 'node-bin'),
  packageManagerEntryPath: join(dirname(hostRequire.resolve('pnpm')), 'bin', 'pnpm.mjs'),
  hostModuleUrl: desktopHostUrl,
}
for (const path of [resources.presetTemplatePath, resources.agentPatchPath, resources.nodeBinPath, resources.packageManagerEntryPath]) {
  if (!existsSync(path)) throw new Error(`The fixed Host checkout is missing an official resource: ${path}`)
}
Object.assign(process.env, {
  ELECKOI_PRESET_TEMPLATE_PATH: resources.presetTemplatePath,
  ELECKOI_AGENT_PATCH_PATH: resources.agentPatchPath,
  ELECKOI_NODE_BIN_PATH: resources.nodeBinPath,
  ELECKOI_PACKAGE_MANAGER_ENTRY_PATH: resources.packageManagerEntryPath,
  ELECKOI_DESKTOP_HOST_MODULE_URL: desktopHostUrl,
})
const desktopHost = await import(desktopHostUrl)
const resolvedResources = desktopHost.resolveDshDesktopResources(process.env)
assert.deepEqual(resolvedResources, resources, 'The official Host descriptor must resolve exactly the resources supplied by its fixed checkout.')

const runtimeDataRoot = join(dataRoot, 'parent-runtime')
const workspaceRoot = join(dataRoot, 'parent-workspace')
const productDatabasePath = join(dataRoot, 'parent-product.sqlite3')
const productMediaRoot = join(dataRoot, 'parent-media')
const profileDirectory = join(dataRoot, 'parent-profile')
const trialStorePath = join(dataRoot, 'receipt-recovery-trial-api', 'conversations.json')
const instructionDshHome = join(dataRoot, 'native-preset-dsh-home')
const instructionRootMarker = '.rp-team-v050-native-preset-root'
const instructionFileName = 'RP_TEAM_NATIVE_PRESET_FIXTURE.md'
mkdirSync(instructionDshHome, { recursive: true })
const modelProvider = 'rp-team-local-fixture'
const modelId = 'rp-team-local-fixture-model'
const credentialRef = 'RP_TEAM_TRIAL_FIXTURE_KEY'
const reply = 'CONTROLLED-LOCAL-TRIAL-REPLY'
const fixtureOnlyKey = 'fixture-only-key'
process.env[credentialRef] = fixtureOnlyKey

let running
let trialApi
const modelServers = []
try {
  running = await desktopHost.runDshDesktopHeadlessProfile({
    runtimeDataRoot, workspaceRoot, productDatabasePath, productMediaRoot, profileDirectory, resources: resolvedResources,
  })
  let ctx = running.ctx
  const install = await ctx.pluginManager.installBundle(bundlePath)
  if (install.application !== 'applied') throw new Error(`The supplied RP Team bundle did not install in the isolated parent profile: ${JSON.stringify(install)}`)
  let team = ctx.rpAgentTeam
  if (!team || typeof team.freezeTrialSnapshot !== 'function') throw new Error('The installed RP Team bundle did not mount its official API.')

  const settings = ctx.settings.describe().find(item => item.ns === 'llm-pi-ai')
  if (!settings) throw new Error('The official DSH profile did not load llm-pi-ai settings.')
  const character = {
    spec: 'chara_card_v2', spec_version: '2.0', data: {
      name: 'RP Team isolated worker fixture', description: 'Deterministic smoke-test character.',
      personality: '', scenario: '', first_mes: '', mes_example: '', creator_notes: '',
      system_prompt: '', post_history_instructions: '', alternate_greetings: [], tags: [],
      creator: 'RP Team test fixture', character_version: '1',
    },
  }
  const preview = await ctx.eleckoiCharactersApi.prepareImport([{
    displayName: 'rp-team-isolated-worker-fixture.json', mimeType: 'application/json',
    base64: Buffer.from(JSON.stringify(character)).toString('base64'),
  }], 'sillytavern')
  const imported = ctx.eleckoiCharactersApi.commitImport(preview.token)
  const characterId = imported.importedCharacterIds?.[0]
  if (!characterId) throw new Error('The official character importer did not create the isolated trial fixture character.')

  const providerConfig = baseURL => ({
    displayName: 'RP Team local smoke fixture',
    api: 'openai-completions',
    apiKeyEnv: credentialRef,
    baseURL,
    models: [{ id: modelId, contextWindow: 8192, maxTokens: 256, reasoningEfforts: false }],
    retryPolicy: { mode: 'normal', maxRetries: 0 },
  })
  const modelSelection = { provider: modelProvider, model: modelId }
  const activePreset = await ctx.eleckoiAgentPresetsApi.create('RP Team isolated product preset', '', 'roleplay')
  const activePresetId = activePreset.id
  const presetCatalog = await ctx.eleckoiAgentPresetsApi.setActive(activePresetId)
  assert.equal(presetCatalog.activePresetIds.roleplay, activePresetId)
  assert.ok(presetCatalog.presets.some(preset => preset.id === activePresetId))
  const conversation = await ctx.eleckoiConversationsApi.create({
    title: 'RP Team isolated worker smoke', metadata: { characterId },
  })
  const conversationId = conversation.conversation.id
  assert.equal((await ctx.eleckoiAgentPresetsApi.read(activePresetId)).id, activePresetId)
  const details = await ctx.eleckoiConversationsApi.details(conversationId)
  const resolvedRoot = await ctx.sessionController.resolveAgent(details.runtimeSessionId)
  if (resolvedRoot?.error || !resolvedRoot?.agent) throw resolvedRoot?.error ?? new Error('The official source conversation root Agent did not resolve.')
  const rootNativePresetId = ctx.agentPresets.composedPreset(resolvedRoot.agent.ctx)
  if (typeof rootNativePresetId !== 'string' || !rootNativePresetId) throw new Error('The official source Session did not expose its actual native DSH preset.')
  const rootNativeDocument = await ctx.agentPresets.readDocument(rootNativePresetId)
  const nativeMarkerPresetId = 'rp-team-v050-native-marker'
  const nativeMarker = 'RP-TEAM-NATIVE-PRESET-MARKER-v050'
  const nativePlugins = parseYaml(rootNativeDocument.content)
  const instructionEntry = findNativePlugin(nativePlugins, 'agent-instructions')
  assert.ok(instructionEntry, 'The mounted root native preset must include the official agent-instructions plugin.')
  instructionEntry.config = {
    ...(instructionEntry.config ?? {}),
    dshHome: instructionDshHome,
    projectRootMarkers: [instructionRootMarker],
    instructionFileCandidates: [instructionFileName],
  }
  const nativeMarkerDefinition = { id: nativeMarkerPresetId, name: 'RP Team native marker fixture',
    description: 'Proves public DSH-native preset freezing and worker restoration.', plugins: nativePlugins }
  await ctx.agentPresets.register(nativeMarkerDefinition)
  const smokeModel = await startTrialLocalModelServer({ reply, toolCallFor: publishToolCall(reply) })
  modelServers.push(smokeModel)
  await ctx.settings.mutate('llm-pi-ai', [{ op: 'set', path: ['providers', modelProvider], value: providerConfig(smokeModel.baseURL) }], settings.revision)
  await ctx.eleckoiConversationModelsApi.select(conversationId, modelSelection)

  let config = defaultTeamConfig()
  config = {
    ...config,
    agents: config.agents.map(agent => ({ ...agent, modelRef: modelSelection,
      presetId: agent.id === config.output.agentId ? '' : nativeMarkerPresetId })),
    execution: { ...config.execution, budget: { maxRequests: 2, maxReportedTokens: 1024, maxElapsedMs: 60_000 } },
  }
  const prior = await team.getConfig({ conversationId })
  await team.saveConfig({ conversationId, expectedRevision: prior.revision,
    enabled: true, config, parameterValues: {} })
  const receiptGateRoot = join(dataRoot, 'receipt-recovery-fixture')
  const receiptGatePath = join(receiptGateRoot, 'verified-receipt.json')
  trialApi = createFixtureTrialApi(ctx, config, { fixtureRoot: receiptGateRoot, path: receiptGatePath })

  // First prove one real forked worker can boot/import/commit through the official local OpenAI-compatible protocol.
  assert.equal((await ctx.credentials.resolve(credentialRef))?.value, fixtureOnlyKey, 'The official DSH credential service should resolve the fixture-only environment secret.')
  let frozen = await trialApi.freezeTrialSnapshot({ conversationId })
  const snapshotPath = join(dataRoot, 'receipt-recovery-trial-api', 'trials', 'snapshots', `${frozen.snapshotId}.json`)
  const frozenSnapshot = JSON.parse(readFileSync(snapshotPath, 'utf8'))
  assert.ok(!JSON.stringify(frozenSnapshot).includes(fixtureOnlyKey), 'Public frozen JSON must not contain credential values.')
  assert.equal(frozenSnapshot.activeProductPresetId, activePresetId,
    'The user-facing product Agent preset must keep its own official catalog identity.')
  assert.ok(frozenSnapshot.productPresets.some(item => item.id === activePresetId),
    'Freezing must include the active product Agent preset archive.')
  assert.equal(frozenSnapshot.rootNativePresetId, rootNativePresetId,
    'The Session root composition must keep its distinct native DSH preset identity.')
  assert.notEqual(frozenSnapshot.rootNativePresetId, frozenSnapshot.activeProductPresetId,
    'A product preset ID must never be substituted for the native DSH preset ID.')
  const frozenNativeMarker = frozenSnapshot.nativePresetDocuments.find(item => item.id === nativeMarkerPresetId)
  const frozenInstructions = parseYaml(frozenNativeMarker?.content ?? '')
  const frozenInstructionEntry = findNativePlugin(frozenInstructions, 'agent-instructions')
  assert.equal(frozenInstructionEntry?.config?.dshHome, instructionDshHome,
    'The native preset freeze must preserve the explicit isolated fixture DSH home.')
  assert.deepEqual(frozenInstructionEntry?.config?.projectRootMarkers, [instructionRootMarker])
  assert.deepEqual(frozenInstructionEntry?.config?.instructionFileCandidates, [instructionFileName],
    'The native preset freeze must preserve the exact candidate used by the controlled worker workspace fixture.')
  const oneVariant = await trialApi.startTrial({
    conversationId,
    operationId: 'trial-worker-v050-receipt-recovery',
    scenario: { name: 'Recover committed receipt before checkpoint', snapshotId: frozen.snapshotId,
      steps: [{ inputText: 'Return a short greeting.' }, { inputText: 'Continue with one brief new detail.' }] },
    variants: [{ id: 'single', config, parameterValues: {} }],
    budget: { maxRequests: 4, maxReportedTokens: 2048, maxElapsedMs: 120_000 },
    turnBudget: { maxRequests: 2, maxReportedTokens: 1024, maxElapsedMs: 30_000 },
  })
  seedVariantWorkspace(oneVariant.trialId, ['single'], nativeMarker, trialStorePath)
  const recoveryStorage = new TrialStorage(trialStorePath)
  const gate = await waitForReceiptGate(receiptGatePath, recoveryStorage, oneVariant.trialId, 120_000)
  assert.equal(gate.format, 'rp-team.trial-receipt-smoke-gate')
  const gateReceipt = gate.receipt
  assert.equal(gate.trialId, oneVariant.trialId)
  assert.equal(gate.variantId, 'single')
  assert.equal(gate.workerGeneration, 0)
  assert.equal(gateReceipt.outcome, 'committed')
  assert.equal(gateReceipt.active, true)
  for (const field of ['conversationId', 'runId', 'sessionId', 'turn', 'inputMessageId', 'assistantMessageId', 'assistantSeq']) {
    assert.ok(gateReceipt[field] !== undefined, `The verified gate receipt must include ${field}.`)
  }
  const beforeKill = recoveryStorage.read().trials[oneVariant.trialId]
  const beforeVariant = beforeKill.variants.find(variant => variant.id === 'single')
  const beforeAttempt = beforeVariant.attempts.find(attempt => attempt.attemptId === gate.attemptId)
  assert.ok(beforeAttempt, 'The gate attempt must still be visible before a durable checkpoint exists.')
  assert.equal(beforeAttempt.sessionId, gateReceipt.sessionId)
  assert.equal(beforeAttempt.conversationId, gateReceipt.conversationId)
  assert.equal(beforeAttempt.runId, gateReceipt.runId)
  assert.equal(beforeAttempt.workerGeneration, 0)
  assert.equal(beforeVariant.turns.length, 0)
  assert.deepEqual(recoveryStorage.readWorkerCheckpoints(oneVariant.trialId, 'single'), [],
    'The worker must be stopped inside the committed-receipt/before-checkpoint window.')
  assert.equal(smokeModel.requests.length, 2, 'The first turn must use only its two local native model calls before the hard kill.')
  const processMarkerPath = join(recoveryStorage.workerRoot(oneVariant.trialId, 0), '.worker-process.json')
  const processMarker = JSON.parse(readFileSync(processMarkerPath, 'utf8'))
  assert.equal(processMarker.trialId, oneVariant.trialId)
  assert.ok(Number.isInteger(processMarker.pid) && processMarker.pid > 0)
  process.kill(processMarker.pid, 'SIGKILL')
  await writeContinueSignal(receiptGatePath)
  const interruptedTrial = await waitForTerminal(trialApi, oneVariant.trialId, 30_000)
  assert.equal(interruptedTrial.status, 'interrupted')
  assert.equal(interruptedTrial.failureCode, 'RP_TEAM_TRIAL_RESULT_UNKNOWN')
  assert.equal(smokeModel.requests.length, 2, 'Hard killing the worker must not dispatch another provider request.')
  assert.equal(processExists(processMarker.pid), false, 'Only the marked owned worker process should have exited.')
  assert.deepEqual(recoveryStorage.readWorkerCheckpoints(oneVariant.trialId, 'single'), [],
    'No checkpoint may appear before official cold receipt reconciliation.')
  await trialApi.dispose?.()
  trialApi = undefined
  await running.shutdown.shutdown(0)
  running = await desktopHost.runDshDesktopHeadlessProfile({
    runtimeDataRoot, workspaceRoot, productDatabasePath, productMediaRoot, profileDirectory, resources: resolvedResources,
  })
  ctx = running.ctx
  team = ctx.rpAgentTeam
  assert.ok(team?.restoreTrialStateSnapshot, 'The cold official Host must remount the RP Team internal recovery API.')
  trialApi = createFixtureTrialApi(ctx, config)
  const recoveredTrial = (await trialApi.getTrial({ trialId: oneVariant.trialId })).trial
  assert.equal(recoveredTrial.status, 'interrupted')
  assert.equal(recoveredTrial.failureCode, 'RP_TEAM_TRIAL_WORKER_INTERRUPTED')
  assert.equal(recoveredTrial.variants[0].turns.length, 1)
  const recoveredTurn = recoveredTrial.variants[0].turns[0]
  assert.equal(recoveredTurn.runId, gateReceipt.runId, 'Recovery must preserve the exact original Team run ID.')
  assert.equal(recoveredTurn.sessionId, gateReceipt.sessionId)
  assert.equal(recoveredTurn.nativeTurn, gateReceipt.turn)
  assert.match(recoveredTurn.body, new RegExp(reply, 'u'))
  assert.equal(smokeModel.requests.length, 2, 'Cold receipt recovery must complete with zero additional model calls.')
  const recoveredCheckpoint = recoveryStorage.readWorkerCheckpoints(oneVariant.trialId, 'single').find(row => row.turn === 1)
  assert.ok(recoveredCheckpoint && !recoveredCheckpoint.invalid)
  assert.equal(recoveredCheckpoint.value.turn.conversationId, gateReceipt.conversationId)
  assert.equal(recoveredCheckpoint.value.turn.workerGeneration, 0, 'Receipt recovery must stay attached to the original generation.')
  assert.equal(recoveredCheckpoint.value.turn.runId, gateReceipt.runId)
  assert.equal(recoveredCheckpoint.value.receipt.inputMessageId, gateReceipt.inputMessageId)
  assert.equal(recoveredCheckpoint.value.receipt.assistantMessageId, gateReceipt.assistantMessageId)
  await trialApi.retryTrial({ trialId: oneVariant.trialId, operationId: 'trial-worker-v050-receipt-recovery-resume' })
  const firstTrial = await waitForTerminal(trialApi, oneVariant.trialId, 120_000)
  assert.equal(firstTrial.status, 'complete', `The recovered worker did not continue its final turn: ${firstTrial.failure ?? firstTrial.status}`)
  assert.equal(firstTrial.variants[0].turns.length, 2)
  assert.equal(firstTrial.variants[0].turns[0].runId, gateReceipt.runId)
  assert.equal(recoveryStorage.read().trials[oneVariant.trialId].variants[0].turns[0].workerGeneration, 0)
  assert.equal(firstTrial.variants[0].turns[1].turn, 2)
  assert.equal(smokeModel.requests.length, 4, 'Only the final resumed turn may add its two local model calls.')
  assert.ok(smokeModel.requests.every(request => request.authorization === `Bearer ${fixtureOnlyKey}`))
  assert.ok(smokeModel.requests.every(request => request.body.model === modelId))
  assert.ok(smokeModel.requests.some(request => findOpenAiTool(request.body, 'rp_team_publish')),
    'The isolated output agent must receive the official Team publish tool in its model request.')
  assert.ok(smokeModel.requests.some(request => JSON.stringify(request.body.messages).includes(nativeMarker)),
    'The explicit native DSH preset instruction file marker must be present in an actual local model request.')
  const successfulRunId = firstTrial.variants[0].turns[0].runId
  const successfulTrajectory = await trialApi.getTrialTrajectory({ trialId: oneVariant.trialId, variantId: 'single', runId: successfulRunId })
  assert.ok(successfulTrajectory.native.executions.some(execution => execution.events.some(event =>
    event.type === 'agent-preset/selected' && event.data?.agentPreset === nativeMarkerPresetId)),
  'The real child Session must persist selection of the frozen native DSH preset.')
  await trialApi.dispose?.()
  trialApi = team
  await smokeModel.close()
  modelServers.splice(modelServers.indexOf(smokeModel), 1)

  // Then verify A/B use distinct imported Sessions and retry only resumes B's uncommitted turn.
  await ctx.agentPresets.register(nativeMarkerDefinition)
  const retryModel = await startTrialLocalModelServer({ reply, failRequestNumbers: [6], toolCallFor: publishToolCall(reply) })
  modelServers.push(retryModel)
  const nextSettings = ctx.settings.describe().find(item => item.ns === 'llm-pi-ai')
  await ctx.settings.mutate('llm-pi-ai', [{ op: 'set', path: ['providers', modelProvider], value: providerConfig(retryModel.baseURL) }], nextSettings.revision)
  frozen = await team.freezeTrialSnapshot({ conversationId })
  const task = await team.startTrial({
    conversationId,
    operationId: 'trial-worker-v050-local-model-ab-retry',
    scenario: { name: 'A/B local worker checkpoint and retry', snapshotId: frozen.snapshotId,
      steps: [
        { inputText: 'Start the scene with a short greeting.' },
        { inputText: 'Continue the same scene with one new detail.' },
      ] },
    variants: [{ id: 'A', config, parameterValues: {} }, { id: 'B', config, parameterValues: {} }],
    budget: { maxRequests: 20, maxReportedTokens: 8192, maxElapsedMs: 240_000 },
    turnBudget: { maxRequests: 2, maxReportedTokens: 1024, maxElapsedMs: 60_000 },
  })
  seedVariantWorkspace(task.trialId, ['A', 'B'], nativeMarker)
  let trial = await waitForTerminal(team, task.trialId, 120_000)
  assert.equal(trial.status, 'failed', `The first pass should stop at the deterministic local fixture error: ${trial.failure ?? trial.status}`)
  assert.equal(trial.variants[0].turns.length, 2, 'A must checkpoint both earlier turns before B fails.')
  assert.equal(trial.variants[1].turns.length, 0, 'B must not checkpoint its failed turn.')
  const committedARunIds = trial.variants[0].turns.map(turn => turn.runId)
  const storage = new TrialStorage(join(runtimeDataRoot, 'home', 'plugins', 'rp-agent-team', 'conversations.json'))
  const workerRoot = storage.workerRoot(task.trialId)
  const variantRuntime = variantId => join(workerRoot, trialVariantStorageKey(variantId), 'userdata', 'runtime')
  assert.ok(existsSync(join(variantRuntime('A'), 'home', 'profiles', 'desktop')),
    'Variant A must have its own isolated desktop profile directory.')
  assert.ok(existsSync(join(variantRuntime('B'), 'home', 'profiles', 'desktop')),
    'Variant B must have its own isolated desktop profile directory.')
  assert.notEqual(variantRuntime('A'), variantRuntime('B'), 'A/B must not share worker runtime/profile directories.')
  const failedAttempt = trial.variants[1].attempts.at(-1)
  assert.ok(failedAttempt?.runId, 'B’s native model error should retain its real Team run identity.')
  assert.equal(failedAttempt.status, 'failed', 'An explicit no-stage native model error is a terminal failed attempt.')
  const durableTrials = JSON.parse(readFileSync(join(runtimeDataRoot, 'home', 'plugins', 'rp-agent-team', 'trials', 'trials.json'), 'utf8'))
  const failedEvidence = durableTrials.trials[task.trialId].variants.find(variant => variant.id === 'B').attempts.at(-1)
  assert.equal(failedEvidence.commitOutcome, 'failed')
  assert.equal(failedEvidence.commitEvidence, 'session-no-stage')
  assert.equal(failedEvidence.commitIdentity.rootSessionId, failedEvidence.sessionId)
  assert.equal(failedEvidence.commitIdentity.phase, 'failed')
  assert.equal(failedEvidence.commitIdentity.productCommitStaged, false)
  assert.ok(failedEvidence.commitIdentity.inputMessageId, 'Session evidence must bind the failure to the exact durable input ID.')
  const failedTrajectory = await team.getTrialTrajectory({ trialId: task.trialId, variantId: 'B', runId: failedAttempt.runId })
  const inputEvent = failedTrajectory.native.events.find(event => event.type === 'user/message'
    && String(event.data?.id ?? event.data?.message?.id ?? '') === failedEvidence.commitIdentity.inputMessageId)
  const failedTurnEnd = failedTrajectory.native.events.find(event => event.type === 'turn/end'
    && Number(event.data?.turn) === failedEvidence.commitIdentity.turn)
  assert.ok(inputEvent && failedTurnEnd && failedTurnEnd.seq > inputEvent.seq,
    'The exact root Session input must precede its failed turn-end event.')
  assert.ok(['error', 'aborted'].includes(failedTurnEnd.data?.reason?.kind),
    'The Session must record an explicit native error or abort.')
  assert.equal(failedTrajectory.native.events.some(event => event.type === 'assistant/message'
    && Number(event.data?.turn) === failedEvidence.commitIdentity.turn
    && event.seq > inputEvent.seq), false,
  'No candidate assistant output may exist on the failed root turn before retry.')
  const firstPassRequestCount = retryModel.requests.length
  assert.equal(firstPassRequestCount, 6, 'The fixture should fail on B’s second native model request after A commits two turns.')
  const secondATurn = trial.variants[0].turns[1]
  assert.equal(secondATurn.turn, 2, 'The second A result is scenario step 2.')
  assert.notEqual(secondATurn.nativeTurn, secondATurn.turn,
    'The official Session turn must remain distinct from the scenario step.')
  const secondACheckpoint = storage.readWorkerCheckpoints(task.trialId, 'A').find(row => row.turn === 2)
  assert.ok(secondACheckpoint && !secondACheckpoint.invalid, 'The second A checkpoint must persist before B’s failure.')
  assert.equal(secondACheckpoint.value.turn.turn, 2)
  assert.equal(secondACheckpoint.value.turn.nativeTurn, secondATurn.nativeTurn)
  assert.equal(secondACheckpoint.value.receipt.turn, secondATurn.nativeTurn,
    'The durable product receipt must retain the native Session turn.')
  await team.retryTrial({ trialId: task.trialId, operationId: 'trial-worker-v050-local-model-retry' })
  trial = await waitForTerminal(team, task.trialId, 120_000)
  assert.equal(trial.status, 'complete', `The isolated trial retry did not complete: ${trial.failure ?? trial.status}`)
  assert.equal(trial.variants[0].turns.length, 2)
  assert.equal(trial.variants[1].turns.length, 2)
  assert.notEqual(trial.variants[0].turns[0].sessionId, trial.variants[1].turns[0].sessionId,
    'A and B must import the same frozen source into different official Session identities.')
  const storedTrial = storage.read().trials[task.trialId]
  assert.notEqual(storedTrial.variants[0].nativeConversationId, storedTrial.variants[1].nativeConversationId,
    'A/B must keep distinct imported conversation identities after retry.')
  assert.deepEqual(trial.variants[0].turns.map(turn => turn.runId), committedARunIds,
    'Retry must preserve A’s already committed run identities.')
  assert.match(trial.variants[0].turns[0].body, new RegExp(reply, 'u'))
  assert.match(trial.variants[1].turns[0].body, new RegExp(reply, 'u'))
  assert.equal(retryModel.requests.length, 10, 'Retry should run only B’s failed first turn and next turn, without replaying either of A’s turns.')
  assert.ok(retryModel.requests.every(request => request.body.model === modelId))

  console.log(JSON.stringify({
    result: 'passed',
    hostCheckout: hostRoot,
    bundlePath,
    receiptRecoverySmoke: { status: firstTrial.status, committedTurns: firstTrial.variants[0].turns.length,
      preKillRequests: 2, requests: smokeModel.requests.length, recoveredRunId: gateReceipt.runId,
      restoredOriginalGeneration: recoveredCheckpoint.value.turn.workerGeneration === 0, recoveryModelCalls: 0 },
    abRetry: {
      status: trial.status,
      completedTurns: trial.variants.reduce((sum, variant) => sum + variant.turns.length, 0),
      fixtureRequests: retryModel.requests.length,
      failedFirstPassRequests: firstPassRequestCount,
      retryDidNotRerunVariantA: true,
      turnsPerVariant: trial.variants.map(variant => ({ id: variant.id, count: variant.turns.length })),
      variantsUsedDifferentSessions: true,
      variantRuntimeDirectories: trial.variants.map(variant => variantRuntime(variant.id)),
    },
    parentProfileDirectory: profileDirectory,
    variantConversationIds: storedTrial.variants.map(variant => variant.nativeConversationId),
    localModelOnly: true,
    productAgentPreset: { id: activePresetId, name: activePreset.name },
    rootNativeAgentPresetId: rootNativePresetId,
    explicitMemberNativePresetId: nativeMarkerPresetId,
    actualRequestIncludedNativeMarker: true,
    actualChildSessionPersistedPresetSelection: true,
    credentialValuesOmittedFromFrozenJson: true,
  }, null, 2))
} finally {
  for (const model of modelServers) await model.close()
  if (trialApi) await trialApi.dispose?.()
  if (running) await running.shutdown.shutdown(0)
}

async function waitForTerminal(api, trialId, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let trial
  while (Date.now() < deadline) {
    trial = (await api.getTrial({ trialId })).trial
    if (['complete', 'failed', 'cancelled', 'interrupted'].includes(trial.status)) return trial
    await new Promise(resolveSleep => setTimeout(resolveSleep, 250))
  }
  return trial
}

function parseArgs(values) {
  const parsed = {}
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index]
    if (!value.startsWith('--') || !values[index + 1]) throw new Error('Usage: node test/trial-worker-v050-smoke.mjs --host <ElecKoi-checkout> --data <fresh-workspace-output-dir> --bundle <RP-Team.tgz>')
    parsed[value.slice(2)] = values[++index]
  }
  for (const key of ['host', 'data', 'bundle']) if (!parsed[key]) throw new Error(`Missing --${key}.`)
  return parsed
}

function publishToolCall(body) {
  return request => findOpenAiTool(request.body, 'rp_team_publish')
    ? { name: 'rp_team_publish', arguments: { body } }
    : undefined
}

function createFixtureTrialApi(ctx, config, testGate) {
  const team = ctx.rpAgentTeam
  return createTrialApi({
    ctx,
    store: { path: trialStorePath, get: () => ({ config: structuredClone(config), parameterValues: {}, enabled: true }) },
    stateStore: {
      committedSnapshot: ({ conversationId: id }) => team.captureTrialStateSnapshot({ conversationId: id }),
      restoreCommittedSnapshot: ({ conversationId: id, snapshot }) => team.restoreTrialStateSnapshot({ conversationId: id, snapshot }),
    },
    readState: args => team.getState(args),
    workerFactory: plan => runTrialWorkerProcess({ ...plan, desktopHostUrl, resources,
      ...(testGate ? { testGate: { fixtureOnly: true, ...testGate } } : {}) }),
    recoveryFactory: plan => runTrialWorkerProcess({ ...plan, desktopHostUrl, resources }),
  })
}

async function waitForReceiptGate(path, storage, trialId, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (existsSync(path)) return JSON.parse(readFileSync(path, 'utf8'))
    const trial = storage.read().trials[trialId]
    if (['complete', 'failed', 'cancelled', 'interrupted'].includes(trial?.status)) {
      throw new Error(`The isolated worker ended before the fixture receipt gate: ${trial.failure || trial.status}`)
    }
    await new Promise(resolveSleep => setTimeout(resolveSleep, 100))
  }
  throw new Error(`Timed out waiting for the fixture receipt gate: ${path}`)
}

function writeContinueSignal(path) {
  writeFileSync(`${path}.continue`, 'continue\n', 'utf8')
}

function processExists(pid) {
  try { process.kill(pid, 0); return true }
  catch { return false }
}

function seedVariantWorkspace(trialId, variantIds, marker, storePath = join(runtimeDataRoot, 'home', 'plugins', 'rp-agent-team', 'conversations.json')) {
  const store = new TrialStorage(storePath)
  const workerRoot = store.workerRoot(trialId)
  for (const variantId of variantIds) {
    const workspace = join(workerRoot, trialVariantStorageKey(variantId), 'userdata', 'workspace')
    mkdirSync(workspace, { recursive: true })
    writeFileSync(join(workspace, instructionRootMarker), '', 'utf8')
    writeFileSync(join(workspace, instructionFileName), `Native preset marker: ${marker}\n`, 'utf8')
  }
}

function findOpenAiTool(requestBody, name) {
  return requestBody?.tools?.find(tool => tool?.function?.name === name)
}

function findNativePlugin(plugins, id) {
  for (const plugin of Array.isArray(plugins) ? plugins : []) {
    if (plugin?.id === id) return plugin
    const nested = findNativePlugin(plugin?.config, id)
    if (nested) return nested
  }
  return undefined
}
