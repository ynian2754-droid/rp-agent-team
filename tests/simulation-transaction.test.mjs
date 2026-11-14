import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { BlockAssembler } from '@deepseek-ai/dsh-llm'
import { validateArgs } from '@deepseek-ai/dsh-tools'
import { normalizeSimulationSubmission, normalizeSimulationSubmitStream, repairSimulationToolArguments,
  simulationParameters, simulationTargets, typedSimulationParameters } from '../src/host/lived-history-simulation.mjs'
import { StateStore } from '../src/host/state-store.mjs'
import { defaultTeamConfig } from '../src/shared/schema.mjs'

const pack = { group: ['阿青/乙', '玩家'], player: '玩家' }
const beat = { who: '阿青/乙' }
const change = (path, value, area = 'selves', person = beat.who) => ({ person, area, path, value })

const submission = departs => ({ summary: '阿青答复。', data: { beats: [{ ...beat,
  says: ['门还开着。'], does: '她把手放在门边。', grounds: [{ ref: '此刻场面', note: '她看见门未关。' }], departs
}], stateOps: [change(['last'], { seq: 1 })] } })

test('opt-in simulation tool validates the observed optional departs forms without changing the accepted decision', () => {
  for (const departs of [undefined, null, []]) {
    const args = JSON.parse(JSON.stringify(submission(departs)))
    assert.deepEqual(validateArgs(typedSimulationParameters, args), [])
    assert.deepEqual(normalizeSimulationSubmission(args.data), JSON.parse(JSON.stringify(submission().data)))
  }
  assert.equal(normalizeSimulationSubmission(submission('此处真的背离旧习。').data).beats[0].departs, '此处真的背离旧习。')
  assert.throws(() => normalizeSimulationSubmission(submission(['保留语义，不能删掉。']).data), { code: 'RP_TEAM_SIMULATION_INVALID' })
})

test('simulation repair accepts a single extra right brace only after strict payload validation', () => {
  const valid = JSON.stringify(submission([]))
  assert.equal(repairSimulationToolArguments(valid), valid)
  assert.equal(repairSimulationToolArguments(`${valid}} `), `${valid} `)
  const broken = [
    `${valid}}}`, `${valid}{}`, `${valid.slice(0, -8)}}`, '{"other":true}}',
    `${JSON.stringify({ ...submission(null), unexpected: true })}}`,
    `${JSON.stringify(submission(['不是空值。']))}}`,
    `${JSON.stringify({ ...submission(null), data: { beats: [], stateOps: 'bad' } })}}`
  ]
  for (const args of broken) assert.equal(repairSimulationToolArguments(args), args)
})

test('native ground choice schema and wire repair are scoped to the same enum', () => {
  const parameters = simulationParameters(['G1', 'G2'])
  const params = JSON.parse(JSON.stringify(submission(null)))
  assert.deepEqual(validateArgs(typedSimulationParameters, params), [])
  assert.notDeepEqual(validateArgs(parameters, params), [])
  for (const ref of ['G9000', '时刻场面']) {
    params.data.beats[0].grounds[0].ref = ref
    const malformed = `${JSON.stringify(params)}}`
    assert.notDeepEqual(validateArgs(parameters, params), [])
    assert.equal(repairSimulationToolArguments(malformed, parameters), malformed)
  }
  params.data.beats[0].grounds[0].ref = 'G1'
  assert.deepEqual(validateArgs(parameters, params), [])
  assert.equal(repairSimulationToolArguments(`${JSON.stringify(params)}}`, parameters), JSON.stringify(params))
})

test('simulation stream repairs both canonical and delta-only tool blocks with no changes to other blocks', async () => {
  const name = 'rp_team_submit_internal'
  const args = JSON.stringify(submission([]))
  for (const blockEnd of [false, true]) {
    const other = { type: 'tool-call-delta', index: 2, id: 'b', name: 'other', argumentsDelta: '{}}' }
    const start = { type: 'block-start', index: 1, blockType: 'tool-call' }
    const finish = { type: 'finish', reason: { kind: 'tool-calls' } }
    const chunks = [start, { type: 'tool-call-delta', index: 1, id: 'a', name, argumentsDelta: args.slice(0, 10) }, other,
      { type: 'tool-call-delta', index: 1, id: 'a', argumentsDelta: `${args.slice(10)}}` },
      ...(blockEnd ? [{ type: 'block-end', index: 1, block: { type: 'tool-call', id: 'a', name, arguments: `${args}}` } }] : []), finish]
    const assembler = new BlockAssembler()
    let repaired = 0
    const output = await Array.fromAsync(normalizeSimulationSubmitStream(chunks, { onRepair: () => { repaired += 1 } }))
    for (const chunk of output) assembler.push(chunk)
    assert.deepEqual(assembler.blocks().map(block => block.arguments), [args, '{}}'])
    assert.equal(repaired, 1)
    assert.equal(output.at(-1), finish)
    assert.ok(output.includes(other))
  }
})

test('simulation stream leaves truncated and non-simulation tool arguments to the native executor', async () => {
  const raw = `${JSON.stringify(submission(null))}}`
  const contents = [
    { type: 'tool-call-delta', index: 0, id: 'a', name: 'rp_team_submit_internal', argumentsDelta: raw },
    { type: 'finish', reason: { kind: 'max-tokens' } }
  ]
  assert.deepEqual(await Array.fromAsync(normalizeSimulationSubmitStream(contents)), contents)
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(Array.fromAsync(normalizeSimulationSubmitStream(contents, { signal: controller.signal })), { name: 'AbortError' })
})

test('native malformed-response finish is repaired only when it identifies the single buffered simulator tool and arguments', async () => {
  const name = 'rp_team_submit_internal'
  const valid = JSON.stringify(submission([]))
  const raw = `${valid}}`
  const argument = { type: 'tool-call-delta', index: 0, id: 'a', name, argumentsDelta: raw }
  const start = { type: 'block-start', index: 0, blockType: 'tool-call' }
  const usage = { type: 'usage', usage: { inputTokens: 60, outputTokens: 30 } }
  const msg = `Tool call "${name}": Unexpected non-whitespace character after JSON at position ${valid.length} (line 1 column ${valid.length + 1})\n\nReceived arguments:\n${raw}`
  const finish = { type: 'finish', reason: { kind: 'error', failure: { code: 'MALFORMED_RESPONSE', message: msg } } }
  const assembler = new BlockAssembler()
  const recovered = await Array.fromAsync(normalizeSimulationSubmitStream([start, argument, usage, finish]))
  for (const chunk of recovered) assembler.push(chunk)
  assert.deepEqual(assembler.finish, { kind: 'tool-calls' })
  assert.equal(assembler.blocks()[0].arguments, valid)
  assert.equal(assembler.usage, usage.usage)

  const other = { type: 'tool-call-delta', index: 1, id: 'b', name: 'another_tool', argumentsDelta: '{}' }
  for (const chunks of [
    [start, argument, other, finish],
    [start, argument, { ...finish, reason: { ...finish.reason, failure: { code: 'MALFORMED_RESPONSE', message: `${msg} ` } } }],
    [start, argument, { ...finish, reason: { ...finish.reason, failure: { code: 'NETWORK_ERROR', message: msg } } }]
  ]) {
    const output = await Array.fromAsync(normalizeSimulationSubmitStream(chunks))
    assert.deepEqual(output.at(-1), chunks.at(-1))
    assert.equal(output.find(chunk => chunk.id === 'a').argumentsDelta, raw)
  }
})

test('simulation state operations have scope and canonical path versions', () => {
  const escaped = '/selves/阿青~1乙/carrying/a~0b'
  const versions = { [JSON.stringify(['shared', escaped])]: 4 }
  const agreed = { beats: [beat], stateOps: [change(['carrying', 'a~b'], { what: '信任她', since: '今天' })] }
  const [entry] = simulationTargets(pack, agreed, versions)
  assert.equal(entry.path, escaped)
  assert.equal(entry.expectedVersion, 4)
  assert.throws(() => simulationTargets(pack, { ...agreed, beats: [{ who: '玩家' }] }, versions), { code: 'RP_TEAM_SIMULATION_FORBIDDEN' })
  assert.throws(() => simulationTargets(pack, { ...agreed, stateOps: [change(['account'], {}, 'selves', '外人')] }, versions), { code: 'RP_TEAM_SIMULATION_FORBIDDEN' })
  assert.throws(() => simulationTargets(pack, { ...agreed, stateOps: [change([], {})] }, versions), { code: 'RP_TEAM_SIMULATION_INVALID' })
  assert.throws(() => simulationTargets(pack, { beats: [beat] }, versions), { code: 'RP_TEAM_SIMULATION_INVALID' })
  assert.deepEqual(simulationTargets(pack, { beats: [beat], stateOps: [] }, versions), [])
})

test('simulation batch leaves no partial journal when any path is stale, forbidden, or invalid', t => {
  const home = mkdtempSync(join(tmpdir(), 'rp-team-sim-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const store = new StateStore(home)
  const config = defaultTeamConfig()
  config.agents[0].statePermissions = [{ namespace: 'shared', path: '/selves', access: 'readwrite' }]
  config.state.definitions = [{ namespace: 'shared', path: '/selves', type: 'object', default: {} }]
  const base = { conversationId: 'conversation', runId: 'run', agentId: config.agents[0].id }
  store.begin({ ...base, config })
  const versions = store.versionsSnapshot(base)
  const account = change(['account'], { now: { text: '先留下。' } })
  const last = change(['last'], { seq: 1 })
  const targets = (ops, snapshot = versions) => simulationTargets(pack, { beats: [beat], stateOps: ops }, snapshot)
  const [, second] = targets([account, last])
  store.write({ ...base, ...second })
  const before = store.status(base)
  assert.throws(() => store.writeBatch({ ...base, targets: targets([account, last]) }), { code: 'RP_TEAM_STATE_CONFLICT' })
  assert.deepEqual(store.status(base), before)
  assert.throws(() => store.writeBatch({ ...base, targets: targets([account, change(['m1'], {}, 'memories')]) }),
    { code: 'RP_TEAM_STATE_FORBIDDEN' })
  assert.throws(() => store.writeBatch({ ...base, targets: targets([account, account]) }), { code: 'RP_TEAM_STATE_BATCH_OVERLAP' })
  assert.deepEqual(store.status(base), before)
  const [savedAccount, savedLast] = store.writeBatch({ ...base, targets: targets([account, last], store.versionsSnapshot(base)) })
  assert.ok(savedAccount.version < savedLast.version)
  const committed = store.stage(base)
  assert.deepEqual(new Set(committed.writes.map(row => row.path)), new Set(['/selves/阿青~1乙/account', '/selves/阿青~1乙/last']))
})
