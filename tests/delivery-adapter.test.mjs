import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createTeamDeliveryAdapter, TEAM_DELIVERY_MODEL, TEAM_DELIVERY_PROVIDER
} from '../src/host/delivery-adapter.mjs'

test('local delivery returns one assistant body without provider usage or a network route', async () => {
  const calls = []
  const adapter = createTeamDeliveryAdapter(async options => {
    calls.push(options)
    return 'One published answer.'
  })
  const options = {
    provider: TEAM_DELIVERY_PROVIDER,
    model: TEAM_DELIVERY_MODEL,
    sessionId: 'stable-root-session',
    messages: []
  }
  const chunks = []
  for await (const chunk of adapter.stream(options)) chunks.push(chunk)

  assert.equal(calls.length, 1)
  assert.equal(calls[0], options)
  assert.deepEqual(chunks, [
    { type: 'text-delta', index: 0, text: 'One published answer.' },
    { type: 'finish', reason: { kind: 'stop' } }
  ])
  assert.equal(chunks.some(chunk => chunk.type === 'usage'), false)
  assert.equal((await adapter.listModels(TEAM_DELIVERY_PROVIDER)).length, 0)
  assert.deepEqual(await adapter.resolveModel(TEAM_DELIVERY_PROVIDER, TEAM_DELIVERY_MODEL), {
    provider: TEAM_DELIVERY_PROVIDER,
    id: TEAM_DELIVERY_MODEL,
    name: 'RP Team local delivery'
  })
  const prepared = await adapter.prepareCall(TEAM_DELIVERY_PROVIDER, TEAM_DELIVERY_MODEL)
  assert.deepEqual(prepared.model, {
    provider: TEAM_DELIVERY_PROVIDER,
    id: TEAM_DELIVERY_MODEL,
    name: 'RP Team local delivery'
  })
  const preparedChunks = []
  for await (const chunk of prepared.stream(options)) preparedChunks.push(chunk)
  assert.deepEqual(preparedChunks, chunks)
})

test('local delivery rejects a missing body and never claims it as model output', async () => {
  const adapter = createTeamDeliveryAdapter(async () => '  ')
  await assert.rejects(async () => {
    for await (const _chunk of adapter.stream({
      provider: TEAM_DELIVERY_PROVIDER,
      model: TEAM_DELIVERY_MODEL
    })) {}
  }, /one non-empty assistant body/u)
})
