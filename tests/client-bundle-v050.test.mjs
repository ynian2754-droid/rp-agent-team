import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import {runInNewContext} from 'node:vm'
import {build} from 'esbuild'

test('native ledger registers before React is bound and uses the ModuleLoader instance', async () => {
  const root = fileURLToPath(new URL('..', import.meta.url))
  const source = (await readFile(new URL('../src/client/entry.jsx',import.meta.url),'utf8'))
    .replace('__RP_TEAM_LOCALES__',JSON.stringify({zh:{},en:{}}))
    .replace('__RP_TEAM_CSS__',JSON.stringify(''))
  const compiled = await build({stdin:{contents:source,resolveDir:root+'/src/client',loader:'jsx'},
    bundle:true,format:'iife',platform:'browser',write:false,outfile:root+'/output/client-registration.js',external:['react'],
    jsxFactory:'React.createElement',jsxFragment:'React.Fragment'})
  let registration
  runInNewContext(compiled.outputFiles.find(file=>file.path.endsWith('.js')||file.path==='<stdout>').text,
    {window:{__ModuleLoader__:{load(value){registration=value}}},navigator:{language:'zh-CN'}})
  assert.equal(registration.id,'@rp-team/dsh-roleplay-team')
  const required=[]
  const plugin=registration.factory(name=>{required.push(name);assert.equal(name,'react');return {}})
  assert.deepEqual(required,['react'])
  assert.ok(plugin.inject.includes('sessions'))
})

test('trajectory replacement survives the official owner component prop', async () => {
  const root = fileURLToPath(new URL('..', import.meta.url))
  const compiled = await build({stdin:{contents:`export {installTrajectory} from './src/client/trajectory-view.jsx'; export {bindHostReact} from './src/client/react.js';`,resolveDir:root,loader:'js'},
    bundle:true,format:'cjs',platform:'browser',write:false,outfile:root+'/output/trajectory-seat.js',jsxFactory:'React.createElement',jsxFragment:'React.Fragment'})
  const module={exports:{}}
  runInNewContext(compiled.outputFiles[0].text,{module,exports:module.exports})
  module.exports.bindHostReact({createElement:(component,props)=>({component,props})})
  const entries=[]
  const nativeView=()=>null
  const inject=()=>({loadOlder(){}})
  const ctx={slots:{
    entriesOfSlot:name=>[{options:{priority:0},component:name==='eleckoi.roleplay.trajectory'?nativeView:()=>null,inject}],
    register:(options,component)=>{entries.push({options,component});return()=>{}},
  }}
  const navigation={clear(){}}
  const dispose=module.exports.installTrajectory(ctx,{}, {id:'team'},navigation)
  const seat=entries.find(entry=>entry.options.name==='eleckoi.roleplay.trajectory')
  const ownerComponent=()=>null
  const rendered=seat.component({component:ownerComponent,sessionId:'root'})
  assert.equal(rendered.component,nativeView)
  assert.notEqual(rendered.props.component,ownerComponent)
  assert.equal(rendered.props.component.name,'TeamTrajectory')
  assert.equal(seat.options.inject,inject)
  dispose()
})
