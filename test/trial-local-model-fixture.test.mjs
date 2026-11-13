import test from 'node:test'
import assert from 'node:assert/strict'
import { startTrialLocalModelServer } from './fixtures/trial-local-model-server.mjs'

test('local trial model fixture speaks deterministic streamed OpenAI Chat Completions', async () => {
  const requests = []
  const server = await startTrialLocalModelServer({ onRequest: request => requests.push(request) })
  try {
    const response = await fetch(`${server.baseURL}/chat/completions`, {
      method: 'POST',
      headers: { authorization: 'Bearer fixture-only-secret', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'fixture-model', stream: true, messages: [{ role: 'user', content: 'smoke' }] }),
    })
    assert.equal(response.status, 200)
    assert.match(response.headers.get('content-type'), /text\/event-stream/u)
    const text = await response.text()
    assert.match(text, /CONTROLLED-LOCAL-REPLY/u)
    assert.match(text, /"finish_reason":"stop"/u)
    assert.match(text, /"prompt_tokens":20/u)
    assert.match(text, /data: \[DONE\]/u)
    assert.equal(requests.length, 1)
    assert.equal(requests[0].authorization, 'Bearer fixture-only-secret')
    assert.equal(requests[0].body.model, 'fixture-model')
  } finally {
    await server.close()
  }
})

test('local trial model fixture can fail one exact request for checkpoint/retry smoke tests', async () => {
  const requests = []
  const server = await startTrialLocalModelServer({ failRequestNumbers: [2], onRequest: request => requests.push(request) })
  try {
    const post = () => fetch(`${server.baseURL}/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'fixture-model', stream: true, messages: [] }),
    })
    assert.equal((await post()).status, 200)
    const failure = await post()
    assert.equal(failure.status, 503)
    assert.deepEqual(await failure.json(), { error: { message: 'Deterministic local fixture failure.' } })
    assert.deepEqual(requests.map(request => request.requestNumber), [1, 2])
  } finally {
    await server.close()
  }
})

test('local trial model fixture emits an actual OpenAI tool-call stream when requested', async () => {
  const server = await startTrialLocalModelServer({
    toolCallFor: ({ body }) => body.tools?.some(tool => tool.function?.name === 'rp_team_publish')
      ? { name: 'rp_team_publish', arguments: { body: 'CONTROLLED-PUBLISHED-REPLY' } }
      : undefined,
  })
  try {
    const response = await fetch(`${server.baseURL}/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'fixture-model', stream: true, tools: [{
        type: 'function', function: { name: 'rp_team_publish', parameters: { type: 'object' } },
      }], messages: [] }),
    })
    const text = await response.text()
    assert.equal(response.status, 200)
    assert.match(text, /"name":"rp_team_publish"/u)
    assert.match(text, /"arguments":"\{\\"body\\":\\"CONTROLLED-PUBLISHED-REPLY\\"\}"/u)
    assert.match(text, /"finish_reason":"tool_calls"/u)
    assert.match(text, /"prompt_tokens":20/u)
  } finally {
    await server.close()
  }
})
