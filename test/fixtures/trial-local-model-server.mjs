import { createServer } from 'node:http'

/** A deterministic OpenAI Chat Completions endpoint for real forked trial workers. */
export async function startTrialLocalModelServer({ reply = 'CONTROLLED-LOCAL-REPLY', onRequest = () => {}, failRequestNumbers = [], toolCallFor, port } = {}) {
  if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) {
    throw new Error('Local model fixture port must be an integer from 1 through 65535.')
  }
  let requestNumber = 0
  const requests = []
  const server = createServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (request.method !== 'POST' || !request.url?.endsWith('/chat/completions')) {
      response.writeHead(404).end()
      return
    }
    const currentRequest = ++requestNumber
    const received = { authorization: request.headers.authorization, body, requestNumber: currentRequest }
    requests.push(received)
    onRequest(received)
    if (failRequestNumbers.includes(currentRequest)) {
      response.writeHead(503, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: { message: 'Deterministic local fixture failure.' } }))
      return
    }
    response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive' })
    const write = value => response.write(`data: ${JSON.stringify(value)}\n\n`)
    const id = `chatcmpl-fixture-${Date.now()}`
    const base = { id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: body.model, choices: [{ index: 0 }] }
    const toolCall = toolCallFor?.(received)
    if (toolCall) {
      write({ ...base, choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{
        index: 0,
        id: `call-fixture-${currentRequest}`,
        type: 'function',
        function: { name: toolCall.name, arguments: JSON.stringify(toolCall.arguments ?? {}) },
      }] }, finish_reason: null }] })
      write({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })
    } else {
      write({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: reply }, finish_reason: null }] })
      write({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
    }
    write({ ...base, choices: [], usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 } })
    response.end('data: [DONE]\n\n')
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port ?? 0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Local model fixture did not bind a TCP port.')
  return {
    baseURL: `http://127.0.0.1:${address.port}/v1`,
    requests,
    close: () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
  }
}
