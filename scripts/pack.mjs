import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const destination = path.join(root, 'DSHbundle')
await mkdir(destination, { recursive: true })
const command = process.platform === 'win32'
  ? process.execPath
  : 'npm'
const args = process.platform === 'win32'
  ? [path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'), 'pack', '--pack-destination', destination]
  : ['pack', '--pack-destination', destination]
const result = spawnSync(command, args, {
  cwd: root,
  stdio: 'inherit'
})
if (result.error) throw result.error
if (result.status !== 0) process.exit(result.status ?? 1)
