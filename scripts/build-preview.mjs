import { build } from 'esbuild'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const host = path.resolve(root, '..', existsSync(path.resolve(root, '..', 'ElecKoi-v0.2.4-adapt')) ? 'ElecKoi-v0.2.4-adapt' : 'ElecKoi')
const output = path.join(root, 'output', 'playwright')
await mkdir(output, { recursive: true })
await build({
  entryPoints: [path.join(root, 'src/preview/harness.jsx')],
  outfile: path.join(output, 'preview.js'), bundle: true, format: 'iife', platform: 'browser',
  target: ['chrome120'], jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"', __RP_TEAM_BUNDLE__: JSON.stringify(await readFile(path.join(root, 'dist/client.js'), 'utf8')) },
  alias: Object.fromEntries(['react', 'react-dom/client', 'react/jsx-runtime'].map(name => [name,
    path.join(host, 'node_modules', name === 'react' ? 'react/index.js' : name === 'react-dom/client' ? 'react-dom/client.js' : 'react/jsx-runtime.js')]))
})
const theme = await readFile(path.join(host, 'src/renderer/src/app/windows/styles/tokens.css'), 'utf8')
const fixtureCss = `
*{box-sizing:border-box}
body{margin:0;color:var(--text);background:var(--chat);font:14px/1.5 "Segoe UI","Microsoft YaHei UI","Microsoft YaHei",sans-serif}
.fixture{display:grid;grid-template-columns:minmax(0,1fr) var(--fixture-side,420px);grid-template-rows:auto minmax(0,1fr);height:100vh}
.fixture.width-narrow{--fixture-side:340px}.fixture.width-wide{--fixture-side:760px}.fixture.closed{grid-template-columns:1fr}
.fixture-toolbar{grid-column:1/-1;display:flex;flex-wrap:wrap;align-items:center;gap:4px;padding:6px 10px;border-bottom:1px dashed var(--line-strong);background:var(--surface-subtle);font-size:11px;color:var(--muted)}
.fixture-toolbar button{padding:2px 7px;border:1px solid var(--line-strong);border-radius:5px;background:transparent;color:inherit;font:inherit;cursor:pointer}
.fixture-toolbar button[aria-pressed=true]{background:var(--active);color:var(--text)}
.fixture-sep{width:1px;height:14px;margin:0 4px;background:var(--line-strong)}
.fixture-chat{display:flex;flex-direction:column;gap:14px;min-width:0;min-height:0;padding:24px 32px 14px;overflow:auto}
.fixture-chat h1{margin:4px 0 0;font-size:20px;font-weight:600}.fixture-chat small{color:var(--muted)}
.fixture-messages{display:grid;gap:14px;margin-top:auto;max-width:680px}
.fixture-message{max-width:620px;line-height:1.7}.fixture-message.is-user{justify-self:end;padding:8px 12px;border-radius:14px;background:var(--bubble-blue)}
.fixture-composer{display:grid;gap:4px;max-width:720px;padding:10px 10px 6px;border:1px solid var(--line-strong);border-radius:18px;background:var(--surface-raised)}
.fixture-composer textarea{min-height:48px;padding:4px 6px;border:0;background:transparent;color:inherit;font:inherit;resize:none;outline:none}
.fixture-composer-bar,.fixture-dock{display:flex;align-items:center;gap:6px;min-width:0}.fixture-spacer{flex:1}
.fixture-native{height:24px;padding:0 8px;border:0;border-radius:6px;background:transparent;color:var(--muted);font:12px/20px inherit;cursor:pointer}
.fixture-send{width:30px;height:30px;border:0;border-radius:50%;background:var(--text);color:var(--chat)}
.fixture-config{font-size:11px}
.fixture-sidebar{display:grid;grid-template-rows:auto minmax(0,1fr);min-width:0;min-height:0;border-left:1px solid var(--line-strong);background:var(--chat)}
.fixture-tabs{display:flex;align-items:center;gap:4px;padding:6px 8px;border-bottom:1px solid var(--line);font-size:12px}
.fixture-tabs button{padding:4px 9px;border:0;border-radius:7px;background:transparent;color:var(--muted);font:inherit;cursor:pointer}
.fixture-tabs button[aria-selected=true]{background:var(--active);color:var(--text)}
.fixture-pane{min-height:0}.fixture-files{padding:20px;color:var(--muted)}
@media(max-width:820px){.fixture{grid-template-columns:1fr}.fixture:not(.closed) .fixture-chat{display:none}.fixture-sidebar{border:0}}
`
await writeFile(path.join(output, 'index.html'), `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>RP Team · UI fixture</title><style>${theme}
${fixtureCss}</style></head><body><div id="app"></div><script src="./preview.js"></script></body></html>`)
await writeFile(path.join(output, 'README.md'), '# UI fixture\n\nBuilt client with Remote-shaped fixtures (src/preview/fixtures.js) and workspace-shaped props. Query parameters: `run=working|awaiting_commit|complete|failed|cancelled`, `page=config|team|run`, `c=2`, `w=narrow|wide`, `theme=dark`, `lang=en`. No model calls. This is not native DSH/Electron acceptance evidence.\n')
console.log(`Built UI fixture at ${output} from host ${host}`)
