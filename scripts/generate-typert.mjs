import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { WorkspaceTypertGenerator } from '@deepseek-ai/dsh-typert-generator'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const workspace = path.join(root, '.typert-workspace')
const packageRoot = path.join(workspace, 'packages', 'rp-team-api')
const packageName = '@rp-team/dsh-roleplay-team'

await rm(workspace, { recursive: true, force: true })
await mkdir(path.join(packageRoot, 'src'), { recursive: true })
await mkdir(path.join(root, 'lib'), { recursive: true })
await cp(path.join(root, 'src', 'host', 'remote.ts'), path.join(packageRoot, 'src', 'index.ts'))
await cp(path.join(root, 'src', 'host', 'remote-types.ts'), path.join(packageRoot, 'src', 'remote-types.ts'))

await writeFile(path.join(workspace, 'tsconfig.host.json'), JSON.stringify({
  files: [],
  references: [{ path: './packages/rp-team-api/tsconfig.host.json' }]
}, null, 2))
await writeFile(path.join(packageRoot, 'tsconfig.host.json'), JSON.stringify({
  compilerOptions: {
    target: 'ES2024', module: 'ESNext', moduleResolution: 'Bundler', strict: true,
    composite: true, declaration: true, skipLibCheck: true, noUncheckedIndexedAccess: true,
    exactOptionalPropertyTypes: true, rootDir: 'src', outDir: 'lib/types'
  },
  include: ['src/index.ts', 'src/remote-types.ts']
}, null, 2))
await writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({
  name: packageName,
  version: '0.2.1',
  type: 'module',
  exports: {
    '.': { types: './src/index.ts', default: './src/index.ts' },
    './types': { types: './src/remote-types.ts', default: './src/remote-types.ts' },
    './typert': { types: './lib/typert.host.d.ts', default: './lib/typert.host.js' },
    './remote': { types: './lib/typert.remote-client.d.ts', default: './lib/typert.remote-client.js' }
  },
  files: [
    'lib/typert.host.js', 'lib/typert.host.d.ts',
    'lib/typert.remote-client.js', 'lib/typert.remote-client.d.ts'
  ]
}, null, 2))

const generated = new WorkspaceTypertGenerator(workspace, { checkDiagnostics: false })
  .generate([packageName], ['host'])
if (generated.length !== 1 || generated[0]?.face !== 'host' || !generated[0].remote) {
  throw new Error('Typert did not generate the RP Team Host and Remote contracts.')
}

const artifact = generated[0]
const output = path.join(root, 'lib')
await Promise.all([
  writeFile(path.join(output, 'typert.host.js'), artifact.js),
  writeFile(path.join(output, 'typert.host.d.ts'), artifact.dts),
  writeFile(path.join(output, 'typert.remote-client.js'), artifact.remote.js),
  writeFile(path.join(output, 'typert.remote-client.d.ts'), artifact.remote.dts),
  writeFile(path.join(output, 'typert.remote-client.d.ts.map'), artifact.remote.dtsMap)
])
console.log(`Typert generated ${packageName}: Host and Remote contracts.`)
