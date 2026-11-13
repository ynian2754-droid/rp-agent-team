import test from 'node:test'
import assert from 'node:assert/strict'
import {build} from 'esbuild'
import {fileURLToPath} from 'node:url'
import {createTrajectoryNavigation} from '../src/client/trajectory-navigation.js'
import {associateTrajectory} from '../src/client/trajectory/identities.js'
import {readFileSync} from 'node:fs'
import {setLocale} from '../src/client/i18n.js'
setLocale({zh:JSON.parse(readFileSync(new URL('../locale/zh.json',import.meta.url),'utf8')),en:{}},'zh-CN')
const output=await build({stdin:{contents:`export * from './src/client/trajectory/source-layout.ts';export * from './src/client/trajectory/harness-groups.ts';export * from './src/client/trajectory/source-registry.ts';export {bindTrajectoryComponents} from './src/client/trajectory/native.ts'`,resolveDir:fileURLToPath(new URL('..',import.meta.url))},bundle:true,platform:'node',format:'esm',write:false})
const lib=await import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString('base64')}`)
lib.bindTrajectoryComponents({trajectoryRecordId:cell=>cell.recordId || `${cell.kind}:${cell.sourceSeq}`,formatElapsedSeconds:String})
const t=(key,args={})=>Object.entries(args).reduce((value,[name,text])=>value.replaceAll(`{${name}}`,String(text)),key)
const root=[{turn:4,inputMessageId:'input-new',groups:[{title:'input',cells:[{index:1,kind:'user',text:'input',sourceSeq:53,timeSeconds:null}]},{title:'body',cells:[{index:2,kind:'message',recordId:'assistant\u00004\u00001',messageId:'body-new',sourceSeq:67,text:'body',timeSeconds:null,input:0,output:0}]}]}]
const runs=['old','new'].map((id,index)=>({runId:id,rootSessionId:'root',turn:4,inputEventSeq:53,inputMessageId:`input-${id}`,startedAt:`2026-10-04T0${index}:00:00Z`,phase:index?'complete':'failed',...(index?{assistantMessageId:'body-new',localDeliveryAssistantSeq:67}:{}),members:{actor:{name:'Actor'}}}))
function execution(runId) {return {runId,loading:false,association:{executionId:`${runId}:actor:1`,agentId:'actor',sessionId:`${runId}-session`,activation:1,scheduled:true,status:'complete'},snapshot:{eventNodes:[{kind:'user',seq:1,time:1,content:[{type:'text',text:'BOOT'}]},{kind:'context',seq:2,time:2,content:[{type:'text',text:'BACKGROUND'}]},{kind:'assistant',seq:5,time:100,turn:1,step:1,blocks:[{kind:'text',text:'reply'}],usage:{inputTokens:7,outputTokens:3}}],eventLocations:new Map(),requests:[],callSchemas:new Map(),partial:null,runningCalls:[]}}}
test('attempt grouping uses real input/output identities when two attempts reuse native seq',()=>{
 const merged=lib.mergeTrajectorySources(root,{runs:[...runs].reverse(),executions:runs.map(run=>execution(run.runId)),renderActions:()=>null},'root',t,{scope:'all',member:'',category:''})
 const cells=merged.flatMap(turn=>turn.groups.flatMap(group=>group.cells))
 assert.deepEqual(cells.filter(cell=>cell.headerType==='run').map(cell=>[cell.runId,cell.defaultCollapsed]),[['old',true],['new',false]])
 assert.deepEqual(cells.filter(cell=>cell.eventCategory==='publication').map(cell=>cell.runId),['new'])
 assert.equal(cells.filter(cell=>cell.kind==='message'&&cell.sourceType==='team').length,2)
 assert.equal(cells.some(cell=>['system','context'].includes(cell.kind)),false)
 assert.equal(lib.nativeUsage(cells).requests,2)
 assert.equal(new Set(cells.map(cell=>cell.recordId)).size,cells.length)
})
test('official input continuation maps the effective input to its new execution without a new user round',()=>{
 const snapshot={eventNodes:[],eventLocations:new Map(),requests:[]}
 const enriched=associateTrajectory(snapshot,{inputs:[{turn:3,eventSeq:53,messageId:'input-new'}],links:[{turn:4,inputEventSeq:53,inputMessageId:'input-new'},{turn:5,inputEventSeq:53,inputMessageId:'WRONG'}]})
 assert.equal(enriched.inputTurns.get(53),4)
 assert.deepEqual(enriched.turnEvents.map(turn=>turn.inputMessageId),['input-new','input-new'])
 assert.equal(enriched.turnEvents.some(turn=>turn.turn===5),false)
})
test('navigation invokes the official selector, publishes an opaque focus and releases it',()=>{
 const nav=createTrajectoryNavigation(new Map([['root','chat']]))
 const calls=[];const stop=nav.bind('root',(...args)=>calls.push(args))
 nav.open('chat',{runId:'old'})
 assert.deepEqual(calls,[['trajectory','rp-team:old']])
 assert.equal(nav.getTrajectoryNavigationSnapshot().runId,'old')
 stop();assert.throws(()=>nav.open('chat'),/打开/)
 nav.clear();assert.equal(nav.getTrajectoryNavigationSnapshot(),null)
})

test('input association preserves native outcomes instead of labelling every input completed',()=>{
 const snapshot={eventNodes:[],eventLocations:new Map(),requests:[],turnEvents:[{turn:1,status:'error',endSeq:9,reason:'fixture failure'}]}
 const inputs={inputs:[{turn:1,eventSeq:1,messageId:'one'},{turn:2,eventSeq:10,messageId:'two'},{turn:3,eventSeq:12,messageId:'three'}]}
 const projected=associateTrajectory(snapshot,inputs,undefined,undefined,{abortedTurns:[2]})
 assert.deepEqual(projected.turnEvents.map(event=>event.status),['error','aborted','unknown'])
 assert.equal(projected.turnEvents[0].reason,'fixture failure')
 assert.equal(projected.turnEvents[0].endSeq,9)
})
test('native Session references are shared across reused execution associations and released on close',async()=>{
 let retained=0,released=0
 const snapshot=execution('new').snapshot
 const binding={session:{subscribe:()=>()=>{},loadOlder:async()=>{}},eventSource:{getSnapshot:()=>({hasMore:false})}}
 const sessions={retain:()=>{retained++;return {ready:Promise.resolve(binding),release:()=>released++}}}
 const source={id:'team',getSnapshot:()=>[{...runs[1],executionSessions:[execution('new').association,execution('new').association]}],subscribe:()=>()=>{},loadOlder:async()=>false}
 const registry=lib.createTrajectorySourceRegistry({sessions,uiConversation:{binding:()=>({target:()=>({subscribe:()=>()=>{},getSnapshot:()=>snapshot})})}})
 registry.registerSource(source);const view=registry.forSession('root');const stop=view.subscribe(()=>{})
 await new Promise(resolve=>setImmediate(resolve));assert.equal(retained,1)
 stop();assert.equal(released,1);assert.equal(view.getSnapshot().runs.length,0)
})
