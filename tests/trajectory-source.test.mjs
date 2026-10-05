import assert from 'node:assert/strict'
import test from 'node:test'
import { createTrajectorySource } from '../src/client/trajectory-source.js'
const tick = () => new Promise(resolve => setImmediate(resolve))
function setup() {
  let listener; let nav; let pollStops = 0; let release;
  const state = { traces: Array.from({length:7}, (_,i)=>({runId:`r${i}`,startedAt:`2026-10-0${i+1}`})), details:{}, status:null }
  const store = { getSnapshot:()=>state, subscribe:(_id,fn)=>{listener=fn;return()=>{listener=null}}, watchStatus:()=>()=>pollStops++, listTraces:async()=>{},
    loadTrace:async(_id,id)=>{state.details[id]={runId:id,rootSessionId:'root',events:[],executionSessions:[]};listener?.()} }
  const conversations = {getTrajectoryNavigationSnapshot:()=>nav,subscribeTrajectoryNavigation:()=>()=>{}}
  const source=createTrajectorySource({store,sessionIndex:new Map([['root','conversation']]),conversations,renderActions:()=>null})
  return {source,state,store,setNav:value=>nav=value,stopCount:()=>pollStops,setDeferred:()=>store.loadTrace=async(_id,id)=>{await new Promise(r=>release=r);state.details[id]={runId:id};listener?.()},resolve:()=>release()}
}
test('source pages history and includes a navigation-selected older run without guessing turn', async()=>{
 const f=setup();f.setNav({conversationId:'conversation',runId:'r0'});const stop=f.source.subscribe('root',()=>{});await tick();await tick();
 assert.equal(f.source.getSnapshot('root').length,6);assert.ok(f.source.getSnapshot('root').some(r=>r.runId==='r0'));assert.equal(f.source.hasMore('root'),true);
 assert.equal(await f.source.loadOlder('root'),true);await tick();assert.equal(f.source.getSnapshot('root').length,7);assert.equal(f.source.hasMore('root'),false);
 stop();assert.equal(f.stopCount(),1);assert.deepEqual(f.source.getSnapshot('root'),[])
})
test('a late trace response cannot recreate a closed view snapshot',async()=>{
 const f=setup();f.state.traces=f.state.traces.slice(0,1);f.setDeferred();const stop=f.source.subscribe('root',()=>{});stop();f.resolve();await tick();assert.deepEqual(f.source.getSnapshot('root'),[])
})
