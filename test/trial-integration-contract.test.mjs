import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTrialApi } from '../src/host/trials.mjs'
import { defaultTeamConfig } from '../src/shared/schema.mjs'

test('trial API freezes resolved routes, deduplicates starts, and resumes each variant from its own checkpoint', async () => {
  const home = mkdtempSync(join(tmpdir(), 'rp-team-trial-contract-'))
  const workers = [], captured = []
  const config = defaultTeamConfig()
  config.authorParameters = [{id:'route',name:'Model',type:'model',default:'inherit',bindings:[{mode:'set',target:{kind:'agent',agentId:config.agents[0].id,path:'/modelRef'}}]}]
  const snapshot = {format:'eleckoi.rp-team-trial-snapshot',version:1,conversationId:'source',createdAt:'2026-10-04T00:00:00Z',archive:{},character:{},teamState:{revision:0,namespaces:{},pathVersions:{}}}
  const api = createTrialApi({
    ctx:{eleckoiTrialSnapshots:{
      freeze:async()=>({privateSnapshot:snapshot,createdAt:snapshot.createdAt,summary:{}}),getHostRoot:()=>home,
      captureModelProviders:async({providerIds})=>{captured.push(providerIds);return providerIds.map(provider=>({provider,settingsValue:{}}))},
      captureAgentPresets:async()=>[],
    }},
    store:{path:join(home,'config.json'),get:()=>({config,enabled:true})},
    stateStore:{committedSnapshot:()=>snapshot.teamState},
    getOptions:async input=>{assert.deepEqual(input,{conversationId:'source'});return{}},
    workerFactory:plan=>{
      let finish
      const done=new Promise(resolve=>{finish=resolve})
      const worker={plan,finish,done,cancel:async()=>{plan.onProgress({type:'trial:cancelled'});finish({cancelled:true})}}
      workers.push(worker);return worker
    },
  })
  const flush = async count=>{for(let i=0;i<20&&workers.length<count;i++)await new Promise(resolve=>setImmediate(resolve));assert.equal(workers.length,count)}
  const fail = worker=>{worker.plan.onProgress({type:'trial:failed',variantId:'A',message:'fixture interruption',interrupted:true});worker.finish({})}
  try {
    const frozen=await api.freezeTrialSnapshot({conversationId:'source'})
    const input={conversationId:'owner-chat',operationId:'start-1',scenario:{name:'Two variants',snapshotId:frozen.snapshotId,steps:[{inputText:'one'},{inputText:'two'}]},variants:['A','B'].map(id=>({id,config,parameterValues:{route:{provider:'local-route',model:'local-model'}}}))}
    const first=await api.startTrial(input);await flush(1)
    assert.deepEqual(captured[0],['local-route'])
    assert.equal((await api.getTrial({trialId:first.trialId})).trial.sourceConversationId,'source')
    assert.equal((await api.startTrial(input)).trialId,first.trialId)
    assert.equal(workers.length,1)
    const checkpoint={...snapshot,createdAt:'2026-10-04T00:00:01Z',teamState:{revision:1,namespaces:{shared:{count:1}},pathVersions:{}}}
    workers[0].plan.onProgress({type:'turn:completed',variantId:'A',turn:{turn:1,runId:'run-A-1',body:'one',state:{},usage:{requests:1,reportedTokens:2},nativeEvents:[],sessionId:'session-A',trajectory:{executions:[]}},checkpoint})
    fail(workers[0]);await new Promise(resolve=>setImmediate(resolve))
    await api.retryTrial({trialId:first.trialId,operationId:'retry-1'});await flush(2)
    assert.equal(workers[1].plan.variants[0].turns.length,1)
    assert.equal(workers[1].plan.variants[1].turns.length,0)
    assert.equal(workers[1].plan.snapshots.A.teamState.revision,1)
    assert.equal(workers[1].plan.snapshots.B.teamState.revision,0)
    await api.retryTrial({trialId:first.trialId,operationId:'retry-1'})
    assert.equal(workers.length,2)
    fail(workers[1]);await new Promise(resolve=>setImmediate(resolve))
    await api.retryTrial({trialId:first.trialId,operationId:'retry-2'});await flush(3)
    assert.equal((await api.cancelTrial({trialId:first.trialId})).trial.status,'cancelled')
  } finally {await api.dispose();rmSync(home,{recursive:true,force:true})}
})
