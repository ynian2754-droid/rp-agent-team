import { build } from 'esbuild'
import { cp, mkdir, readFile, readdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dist = path.join(root, 'dist')
const hostSource = path.join(root, 'src', 'host')

await import('./generate-typert.mjs')
await rm(dist, { recursive: true, force: true })
await mkdir(dist, { recursive: true })
await mkdir(path.join(dist, 'host'), { recursive: true })

async function copyTree(source, target) {
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (entry.name.endsWith('.test.mjs')) continue
    const from = path.join(source, entry.name)
    const to = path.join(target, entry.name)
    if (entry.isDirectory()) {
      await mkdir(to, { recursive: true })
      await copyTree(from, to)
    } else if (/\.(?:mjs|js|json)$/.test(entry.name)) {
      await cp(from, to)
    }
  }
}

await copyTree(hostSource, path.join(dist, 'host'))
await mkdir(path.join(dist, 'shared'), { recursive: true })
await copyTree(path.join(root, 'src', 'shared'), path.join(dist, 'shared'))

const remoteConfigPath = path.join(root, 'scripts', 'tsconfig.remote.json')
const remoteConfigFile = ts.readConfigFile(remoteConfigPath, ts.sys.readFile)
if (remoteConfigFile.error) throw new Error(ts.flattenDiagnosticMessageText(remoteConfigFile.error.messageText, '\n'))
const remoteConfig = ts.parseJsonConfigFileContent(remoteConfigFile.config, ts.sys, path.dirname(remoteConfigPath))
const remoteProgram = ts.createProgram(remoteConfig.fileNames, remoteConfig.options)
const remoteDiagnostics = ts.getPreEmitDiagnostics(remoteProgram)
if (remoteDiagnostics.length) {
  throw new Error(ts.formatDiagnosticsWithColorAndContext(remoteDiagnostics, {
    getCurrentDirectory: ts.sys.getCurrentDirectory,
    getCanonicalFileName: value => value,
    getNewLine: () => ts.sys.newLine
  }))
}
if (remoteProgram.emit().emitSkipped) throw new Error('TypeScript did not emit the Host Remote service.')

const source = await readFile(path.join(root, 'src', 'client', 'entry.jsx'), 'utf8')
const styles = await readFile(path.join(root, 'src', 'client', 'team.css'), 'utf8')
const [zh, en] = await Promise.all([
  readFile(path.join(root, 'locale', 'zh.json'), 'utf8').then(JSON.parse),
  readFile(path.join(root, 'locale', 'en.json'), 'utf8').then(JSON.parse)
])
const client = source
  .replace('__RP_TEAM_CSS__', JSON.stringify(styles))
  .replace('__RP_TEAM_LOCALES__', JSON.stringify({ zh, en }))
if (client.includes('__RP_TEAM_CSS__') || client.includes('__RP_TEAM_LOCALES__')) {
  throw new Error('Client build placeholders were not replaced.')
}
await build({
  stdin: {
    contents: client,
    resolveDir: path.join(root, 'src', 'client'),
    sourcefile: 'entry.jsx',
    loader: 'jsx'
  },
  outfile: path.join(dist, 'client.js'),
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['chrome120'],
  jsx: 'transform',
  jsxFactory: 'React.createElement',
  jsxFragment: 'React.Fragment',
  external: ['react'],
  legalComments: 'none'
})

const hostEntry = path.join(dist, 'host', 'index.mjs')
await readFile(hostEntry, 'utf8')
await readFile(path.join(dist, 'host', 'remote.mjs'), 'utf8')
await readFile(path.join(dist, 'host', 'remote-types.d.ts'), 'utf8')
for (const entry of ['host/runtime.mjs', 'host/run-state.mjs', 'host/state-store.mjs', 'shared/schema.mjs']) {
  await readFile(path.join(dist, entry), 'utf8')
}
const clientEntry = await readFile(path.join(dist, 'client.js'), 'utf8')
if (!clientEntry.includes('window.__ModuleLoader__.load') || !/factory\(require\w*\)/.test(clientEntry) ||
  !/bindHostReact\(require\w*\(["']react["']\)\)/.test(clientEntry) || /__SECRET_INTERNALS|__CLIENT_INTERNALS|react\.(?:production|development)/.test(clientEntry)) {
  throw new Error('Client output must register through ModuleLoader and use its shared React instance.')
}
console.log('Built the host modules and shared-React client loader into dist/.')
