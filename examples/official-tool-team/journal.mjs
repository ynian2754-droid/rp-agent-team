import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

// This file belongs to the plugin. Never open or write the product database.
export function openJournal(path) {
  if (!path) throw new Error('Configure an absolute plugin-owned journalPath before enabling the tool')
  const document = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : { version: 1, runs: [] }
  if (document.version !== 1 || !Array.isArray(document.runs)) throw new Error('Unsupported tool-team journal')
  const save = () => {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(`${path}.tmp`, JSON.stringify(document, null, 2))
    renameSync(`${path}.tmp`, path)
  }
  return { document, save }
}

export function activePrivateState(runs, conversationId, events) {
  const outputs = new Set(events.filter(event => event.type === 'assistant/message').map(event => event.data.message.id))
  const state = {}
  for (const run of runs) {
    if (run.conversationId !== conversationId || run.status !== 'committed' || !outputs.has(run.outputMessageId)) continue
    Object.assign(state, run.privateDelta)
  }
  return state
}

export function pickPaths(root, paths) {
  const result = {}
  for (const pointer of paths) {
    if (!pointer.startsWith('/')) throw new Error('A permitted field must use an absolute JSON Pointer')
    const parts = pointer.slice(1).split('/').map(part => part.replaceAll('~1', '/').replaceAll('~0', '~'))
    if (parts.some(part => ['__proto__', 'constructor', 'prototype'].includes(part))) throw new Error('Invalid field path')
    let value = root
    for (const part of parts) value = value?.[part]
    if (value !== undefined) result[pointer] = structuredClone(value)
  }
  return result
}
