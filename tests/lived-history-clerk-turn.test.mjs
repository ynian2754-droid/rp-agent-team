import assert from 'node:assert/strict'
import test from 'node:test'
import { finishSingleGroupClerk } from '../src/host/lived-history-clerk-turn.mjs'
import { teamError } from '../src/shared/schema.mjs'

function scenario({ present = ['星凛'], standard = false, simulation = [], review = [] } = {}) {
  const calls = []
  const requests = []
  const accepted = []
  const staged = []
  const agent = {
    communication: { handoffs: [
      { id: 'ask-sim-1', to: 'sim-1', mode: 'await', simulation: true, materialPack: true, terminal: true },
      ...(!standard ? [{ id: 'check-sim', to: 'checker', mode: 'await', compactReview: 'simulation', scopedReview: true, terminal: true }] : [])
    ] }
  }
  const selection = { slot: 1, group: ['星凛'], evidence: { 星凛: { knows: ['envelope'] } }, midbeat: [0] }
  const invoke = (args = { summary: '选好在场人物和证据', selection }) => finishSingleGroupClerk({
    source: { present }, member: agent, args,
    latestSimulation: () => requests.at(-1),
    request: async item => {
      calls.push(item)
      if (item.handoffId === 'check-sim') {
        const verdict = review.shift() ?? { pass: true, issues: [] }
        if (verdict instanceof Error) throw verdict
        return { data: verdict }
      }
      const result = simulation.shift()
      const row = { ref: `ask-sim-1#${requests.length + 1}`, status: result ? 'failed' : 'completed' }
      requests.push(row)
      if (result) throw result
      return { ref: row.ref, data: { beats: [{ who: '星凛', says: ['留下'] }] } }
    },
    acceptSimulation: async ({ ref }) => {
      accepted.push(ref)
      return { ref }
    },
    submit: async (item, approval) => {
      calls.push({ handoffId: 'submit' })
      if (approval) staged.push(approval.ref)
      return item
    }
  })
  return { invoke, calls, requests, accepted, staged, selection }
}

test('one clerk selection dispatches the scoped review and returns the exact accepted simulation by reference', async () => {
  const { invoke, calls, accepted, selection } = scenario()
  const submitted = await invoke()

  assert.deepEqual(calls.map(item => item.handoffId), ['ask-sim-1', 'check-sim', 'submit'])
  assert.equal(calls[0].data, selection)
  assert.deepEqual(calls[1].data, {
    packs: [{ $ref: 'ask-sim-1#1', side: 'request' }],
    beats: [{ $ref: 'ask-sim-1#1', pointer: '/beats' }]
  })
  assert.deepEqual(accepted, ['ask-sim-1#1'])
  assert.deepEqual(submitted.data, {
    groups: [{ slot: 1, people: ['星凛'], beats: { $ref: 'ask-sim-1#1', pointer: '/beats' } }],
    relays: 0, untreated: [], check: '已通过核验'
  })
})

test('a timed-out simulation gets exactly one retry with the exact previous pack', async () => {
  const timeout = teamError('RP_TEAM_HANDOFF_TIMEOUT', '模拟超时')
  const { invoke, calls, accepted } = scenario({ simulation: [timeout], standard: true })
  const submitted = await invoke()

  assert.deepEqual(calls.map(item => item.handoffId), ['ask-sim-1', 'ask-sim-1', 'submit'])
  assert.deepEqual(calls[1].data, { slot: 1, repeat: 'ask-sim-1#1' })
  assert.deepEqual(accepted, ['ask-sim-1#2'])
  assert.deepEqual(submitted.data.untreated, [])
  assert.equal(submitted.data.check, undefined)

  const twice = scenario({ simulation: [timeout, timeout] })
  const failed = await twice.invoke()
  assert.deepEqual(twice.calls.map(item => item.handoffId), ['ask-sim-1', 'ask-sim-1', 'submit'])
  assert.deepEqual(twice.accepted, [])
  assert.deepEqual(failed.data.untreated, ['星凛'])
})

test('only the repaired simulation is approved after the fresh review', async () => {
  const issues = [{ who: '星凛', kind: '读心', note: '只回应听见的话' }]
  const { invoke, calls, accepted, staged } = scenario({ review: [{ pass: false, issues }] })
  const submitted = await invoke()

  assert.deepEqual(calls.map(item => item.handoffId), ['ask-sim-1', 'check-sim', 'ask-sim-1', 'check-sim', 'submit'])
  assert.deepEqual(calls[2].data, { slot: 1, repeat: 'ask-sim-1#1', check_issues: issues })
  assert.equal(calls[3].data.beats[0].$ref, 'ask-sim-1#2')
  assert.deepEqual(accepted, ['ask-sim-1#2'])
  assert.deepEqual(staged, ['ask-sim-1#2'])
  assert.equal(submitted.data.groups[0].beats.$ref, 'ask-sim-1#2')

  const rejected = scenario({ review: [{ pass: false, issues }, { pass: false, issues }] })
  const failed = await rejected.invoke()
  assert.deepEqual(rejected.accepted, [])
  assert.deepEqual(failed.data.untreated, ['星凛'])
  assert.deepEqual(failed.data.groups, [])
})

test('review timeout returns an untreated group with no simulation state writes', async () => {
  const { invoke, calls, accepted } = scenario({ review: [teamError('RP_TEAM_HANDOFF_TIMEOUT', '核验超时')] })
  const submitted = await invoke()

  assert.deepEqual(calls.map(item => item.handoffId), ['ask-sim-1', 'check-sim', 'submit'])
  assert.deepEqual(accepted, [])
  assert.deepEqual(submitted.data, { groups: [], relays: 0, untreated: ['星凛'], check: '核验超时' })
})

test('single-group dispatch rejects partial, relay and late selection before requesting anything', async () => {
  const split = scenario({ present: ['星凛', '吴老师'] })
  await assert.rejects(split.invoke(), { code: 'RP_TEAM_MATERIAL_PACK_INVALID' })
  assert.deepEqual(split.calls, [])
  const { invoke, calls, requests, selection } = scenario()
  await assert.rejects(invoke({ selection: { ...selection, relay: { ref: 'ask-sim-2#1' } } }), { code: 'RP_TEAM_MATERIAL_PACK_INVALID' })
  requests.push({ ref: 'ask-sim-1#1', status: 'completed' })
  await assert.rejects(invoke(), { code: 'RP_TEAM_MATERIAL_PACK_INVALID' })
  assert.deepEqual(calls, [])
})
