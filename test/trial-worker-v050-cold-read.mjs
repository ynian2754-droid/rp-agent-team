import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { TrialStorage } from '../src/host/trial-storage.mjs'

const [hostArg, dataArg] = process.argv.slice(2)
if (!hostArg || !dataArg) throw new Error('Usage: node test/trial-worker-v050-cold-read.mjs <ElecKoi-checkout> <trial-smoke-output>')
const hostRoot = resolve(hostArg)
const dataRoot = resolve(dataArg)
const runtimeDataRoot = join(dataRoot, 'parent-runtime')
const desktopHostPackagePath = join(hostRoot, 'apps', 'desktop-host', 'package.json')
const desktopHostPackage = JSON.parse(readFileSync(desktopHostPackagePath, 'utf8'))
const publicEsmEntry = desktopHostPackage.exports?.['.']?.import?.default
assert.equal(typeof publicEsmEntry, 'string', 'The fixed Host must expose its public ESM package root.')
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
Object.assign(process.env, {
  ELECKOI_PRESET_TEMPLATE_PATH: resources.presetTemplatePath,
  ELECKOI_AGENT_PATCH_PATH: resources.agentPatchPath,
  ELECKOI_NODE_BIN_PATH: resources.nodeBinPath,
  ELECKOI_PACKAGE_MANAGER_ENTRY_PATH: resources.packageManagerEntryPath,
  ELECKOI_DESKTOP_HOST_MODULE_URL: desktopHostUrl,
})

const desktopHost = await import(desktopHostUrl)
assert.deepEqual(desktopHost.resolveDshDesktopResources(process.env), resources)
const storage = new TrialStorage(join(runtimeDataRoot, 'home', 'plugins', 'rp-agent-team', 'conversations.json'))
const candidates = Object.values(storage.read().trials).filter(record => record.variants?.length === 2)
assert.equal(candidates.length, 1, 'The isolated smoke data must contain one A/B trial.')
let record = candidates[0]
const sourceSnapshotPath = storage.snapshotPath(record.scenario.snapshotId)
const sourceSnapshotHashBefore = hashFile(sourceSnapshotPath)
let running

try {
  running = await desktopHost.runDshDesktopHeadlessProfile({
    runtimeDataRoot,
    workspaceRoot: join(dataRoot, 'parent-workspace'),
    productDatabasePath: join(dataRoot, 'parent-product.sqlite3'),
    productMediaRoot: join(dataRoot, 'parent-media'),
    profileDirectory: join(dataRoot, 'parent-profile'),
    resources,
  })
  const team = running.ctx.rpAgentTeam
  assert.ok(team && typeof team.getTrial === 'function', 'Cold profile must mount the installed trial API.')
  const trial = (await team.getTrial({ trialId: record.trialId }))?.trial
  record = storage.read().trials[record.trialId]
  assert.equal(record.status, 'complete')
  assert.equal(trial?.status, 'complete')
  assert.deepEqual(trial.variants.map(variant => variant.id), ['A', 'B'])
  assert.deepEqual(trial.variants.map(variant => variant.turns.length), [2, 2])
  assert.notEqual(trial.variants[0].turns[0].sessionId, trial.variants[1].turns[0].sessionId)
  assert.notEqual(record.variants[0].nativeConversationId, record.variants[1].nativeConversationId)
  assert.deepEqual(trial.variants[0].turns.map(turn => turn.runId), record.variants[0].turns.map(turn => turn.runId))
  const aCheckpoints = storage.readWorkerCheckpoints(record.trialId, 'A').filter(row => !row.invalid)
    .sort((left, right) => left.turn - right.turn).map(row => row.value.turn.runId)
  assert.deepEqual(aCheckpoints, record.variants[0].turns.map(turn => turn.runId))
  assert.equal(record.variants[0].workerGeneration, 0)
  assert.ok(record.variants[0].turns.every(turn => turn.workerGeneration === 0))
  assert.equal(record.variants[1].workerGeneration, 1)
  assert.ok(record.variants[1].turns.every(turn => turn.workerGeneration === 1))
  const failed = record.variants[1].attempts.find(attempt => attempt.status === 'failed')
  assert.ok(failed)
  assert.equal(failed.commitOutcome, 'failed')
  assert.equal(failed.commitEvidence, 'session-no-stage')
  assert.equal(failed.workerGeneration, 0)
  assert.equal(failed.commitIdentity.productCommitStaged, false)
  assert.match(failed.error, /503:.*Deterministic local fixture failure/u)
  assert.equal(record.usage.requests, 10)
  assert.notEqual(record.variants[0].nativeConversationId, record.variants[1].nativeConversationId)
  const sourceSnapshotHashAfter = hashFile(sourceSnapshotPath)
  assert.equal(sourceSnapshotHashAfter, sourceSnapshotHashBefore,
    'A cold getTrial read must preserve the frozen source archive hash.')
  console.log(JSON.stringify({
    result: 'cold-read-passed', trialId: record.trialId, status: trial.status,
    turnsPerVariant: trial.variants.map(variant => ({ id: variant.id, count: variant.turns.length })),
    variantConversationIds: record.variants.map(variant => variant.nativeConversationId),
    variantSessionIds: trial.variants.map(variant => variant.turns[0].sessionId),
    workerGenerations: { A: record.variants[0].workerGeneration, B: record.variants[1].workerGeneration,
      failedBAttempt: failed.workerGeneration },
    aRunIds: record.variants[0].turns.map(turn => turn.runId),
    failedBAttempt: { runId: failed.runId, outcome: failed.commitOutcome, evidence: failed.commitEvidence,
      error: failed.error },
    usageRequests: record.usage.requests,
    sourceSnapshotId: record.scenario.snapshotId,
    sourceSnapshotSha256: sourceSnapshotHashAfter,
  }, null, 2))
} finally {
  if (running) await running.shutdown.shutdown(0)
}

function hashFile(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}
