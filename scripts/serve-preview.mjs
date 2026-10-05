import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'

const root = new URL('../output/playwright/', import.meta.url)
const files = { '/': ['index.html', 'text/html; charset=utf-8'], '/index.html': ['index.html', 'text/html; charset=utf-8'], '/preview.js': ['preview.js', 'text/javascript; charset=utf-8'] }
createServer(async (request, response) => {
  const file = files[new URL(request.url, 'http://localhost').pathname]
  if (!file) return response.writeHead(404).end()
  response.writeHead(200, { 'Content-Type': file[1], 'Cache-Control': 'no-store' })
  response.end(await readFile(new URL(file[0], root)))
}).listen(Number(process.argv[2] || 4178), '127.0.0.1', () => console.log('Built-client preview: http://127.0.0.1:' + (process.argv[2] || 4178)))
