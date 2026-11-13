import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {createRequire} from 'node:module'
import {randomUUID,createHash} from 'node:crypto'
import {mkdirSync,readFileSync,writeFileSync,existsSync} from 'node:fs'
import {resolve,join,dirname} from 'node:path'
import {pathToFileURL} from 'node:url'
import {createAgent,normalizeTeamConfig,defaultTeamConfig} from '../src/shared/schema.mjs'

const arg=name=>process.argv[process.argv.indexOf(name)+1]
assert.ok(process.argv.includes('--host')&&process.argv.includes('--data')&&process.argv.includes('--bundle'),'Supply --host FIXED_CHECKOUT --data ISOLATED_DIR --bundle RP_TEAM.tgz')
const hostRoot=resolve(arg('--host')),data=resolve(arg('--data')),bundle=resolve(arg('--bundle'))
assert.ok(!data.includes('AppData')&&!data.endsWith('ElecKoi'),'Use an isolated verification directory')
const require=createRequire(join(hostRoot,'package.json'))
const hostPackage=require(join(hostRoot,'package.json'))
const load=id=>import(pathToFileURL(require.resolve(id)).href)
const {runDshDesktopHeadlessProfile}=await load('@eleckoi/desktop-host')
const {readSessionInspection}=await load('@eleckoi/dsh-product-api')
const {LlmAdapter}=await load('@deepseek-ai/dsh-llm')
const resourcesRoot=join(hostRoot,'apps/desktop/resources/dsh')
const provider='rp-team-v050-local',requests=[]
const resources={presetTemplatePath:join(resourcesRoot,'agent-preset-template/agent.cordis.yml'),agentPatchPath:join(resourcesRoot,'desktop-agent.patch.yml'),nodeBinPath:join(resourcesRoot,'node-bin'),packageManagerEntryPath:join(dirname(require.resolve('pnpm')),'bin/pnpm.mjs')}
mkdirSync(data,{recursive:true})
const overlay=join(data,'probe.patch.yml')
writeFileSync(overlay,'- id: desktop-product-telemetry\n  disabled: true\n- id: product-analytics\n  disabled: true\n')
const signal=()=>AbortSignal.timeout(60_000)
const imported=process.argv.includes('--existing-conversation')
const desktopProfile=process.argv.includes('--desktop-profile')
assert.ok(!desktopProfile||!imported,'The migration and desktop smoke profiles have different path layouts')
const running=await runDshDesktopHeadlessProfile({runtimeDataRoot:join(data,desktopProfile?'dsh-runtime':'runtime'),workspaceRoot:join(data,'workspace'),productDatabasePath:join(data,imported?'product/eleckoi-common.sqlite3':desktopProfile?'eleckoi-common.sqlite3':'product.sqlite3'),productMediaRoot:join(data,imported?'product/media':'media'),resources,patchFiles:[overlay],environment:{DSH_TELEMETRY_DISABLED:'1'}})
const ctx=running.ctx
async function* text(value){yield {type:'block-start',index:0,blockType:'text'};yield {type:'text-delta',index:0,text:value};yield {type:'block-end',index:0,block:{type:'text',text:value}};yield {type:'usage',usage:{inputTokens:30,outputTokens:10}};yield {type:'finish',reason:{kind:'stop'}}}
async function* tool(name,args){const id=randomUUID(),value=JSON.stringify(args);yield {type:'block-start',index:0,blockType:'tool-call'};yield {type:'tool-call-delta',index:0,id,name,argumentsDelta:value};yield {type:'block-end',index:0,block:{type:'tool-call',id,name,arguments:value}};yield {type:'usage',usage:{inputTokens:7,outputTokens:3}};yield {type:'finish',reason:{kind:'tool-calls'}}}
class Local extends LlmAdapter {
 providerInfo(id){return {id,name:'Deterministic free adaptation fixture'}}
 async listModels(){return ['root','observer','actor'].map(id=>({provider,id,name:id,inputModalities:['text']}))}
 async resolveModel(p,id){assert.equal(p,provider);return {provider:p,id,name:id,inputModalities:['text'],context:{contextWindow:100000}}}
 async *stream(options){
  assert.equal(options.provider,provider,'No paid provider may be called')
  options.signal.throwIfAborted();const input=JSON.stringify(options.messages),tools=options.tools?.map(tool=>tool.name)||[]
  requests.push({sessionId:options.sessionId,model:options.model,temperature:options.temperature,tools,messages:options.messages})
  if(options.model==='root'){yield* text('<FINAL>ORDINARY_BODY</FINAL>');return}
  assert.ok(!input.includes('HIDDEN_WORLD_CANARY'),'Actual member request leaked hidden context')
  assert.ok(!tools.some(name=>name.startsWith('eleckoi_')),'Product tools leaked to member: '+tools.filter(name=>name.startsWith('eleckoi_')).join(', '))
  if(input.includes('PROBE_CANCEL')){await new Promise((resolve,reject)=>{if(options.signal.aborted)reject(options.signal.reason);else options.signal.addEventListener('abort',()=>reject(options.signal.reason),{once:true})});return}
  const results=options.messages.filter(message=>message.role==='tool')
  if(options.model==='observer'){
   if(results.length===0){yield* tool('rp_team_read_context',{source:'current_input'});return}
   if(results.length===1){const state=await ctx.rpAgentTeam.getState({conversationId:report.successConversationId});const version=state.values.find(value=>value.namespace==='shared'&&value.path==='/score').version;yield* tool('rp_team_write_state',{namespace:'shared',path:'/score',value:input.includes('SECOND')?3:2,expectedVersion:version});return}
   if(results.length===2){yield* tool('rp_team_state_version',{namespace:'world',path:'/variables/probe'});return}
   if(results.length===3){const version=JSON.parse(results[2].content.filter(block=>block.type==='text').map(block=>block.text).join('')).version;yield* tool('rp_team_write_state',{namespace:'world',path:'/variables/probe',value:input.includes('SECOND')?3:2,expectedVersion:version});return}
   if(results.length===4){yield* tool('rp_team_send',{to:'actor',body:'VISIBLE_NOTE'});return}
   if(results.length===5){yield* tool('rp_team_submit_internal',{summary:'Observer complete'});return}
   yield* text('Internal observer result');return
  }
  assert.ok(input.includes('VISIBLE_NOTE'),'Actor did not receive permitted internal message')
  if(results.length===0){yield* tool('rp_team_publish',{body:'<FINAL>TEAM_BODY</FINAL>'});return}
  yield* text('<FINAL>TEAM_BODY</FINAL>')
 }
}
const report={baseline:execFileSync('git',['-C',hostRoot,'rev-parse','HEAD'],{encoding:'utf8'}).trim(),hostVersion:hostPackage.version,dshVersion:hostPackage.dependencies['@deepseek-ai/dsh'],bundleSha256:createHash('sha256').update(readFileSync(bundle)).digest('hex'),desktopProfile,scenarios:[]}
async function send(id,input){
 const details=await ctx.eleckoiConversationsApi.details(id)
 const before=await readSessionInspection(ctx,details.runtimeSessionId,signal())
 const prepared=await ctx.eleckoiConversationsApi.preparePrompt(id,input,signal())
 await ctx.sessionController.prompt({sessionId:prepared.runtimeSessionId,requestId:randomUUID(),mode:'queue',content:[{type:'text',text:input}]},signal())
 await ctx.agents.get(prepared.runtimeSessionId).whenIdle()
 let error='';try{await ctx.eleckoiConversationsApi.waitForGeneration(id,prepared.operationId)}catch(cause){error=cause.message}
 const inspection=await readSessionInspection(ctx,prepared.runtimeSessionId,signal())
 return {prepared,error,inspection,newEvents:inspection.events.filter(event=>event.seq>(before.events.at(-1)?.seq??-1))}
}
try{
 await ctx.plugin({name:'free-v050-model',inject:['llm'],apply(scope){scope.llm.registerConfigurableProviders([{provider,displayName:'Free fixture',settingsNs:'llm-pi-ai',settingsPath:['providers',provider]}]);return scope.llm.registerAdapter([provider],new Local())}})
 const installed=await ctx.pluginManager.installBundle(bundle)
 assert.equal(installed.application,'applied',JSON.stringify(installed));assert.ok(ctx.rpAgentTeam)
 const modelNs=ctx.settings.describe().find(row=>row.ns==='eleckoi-client-models')
 await ctx.settings.mutate(modelNs.ns,[{op:'set',path:['schemaVersion'],value:2},{op:'set',path:['entries',provider],value:{id:provider,name:'Free local',provider:'custom',model:'root',credentialRef:'UNUSED_LOCAL_KEY',model_options:['root','observer','actor'].map(id=>({id,name:id,inputModalities:['text']})),parameters:{}}}],modelNs.revision)
 let id
 if(process.argv.includes('--existing-conversation')) {
  id=arg('--existing-conversation')
  const details=await ctx.eleckoiConversationsApi.details(id)
  assert.ok(details.runtimeSessionId,'Imported conversation has no native Session binding')
  const prior=await readSessionInspection(ctx,details.runtimeSessionId,signal())
  report.importedHistory={sessionId:details.runtimeSessionId,eventCount:prior.events.length,messageIds:prior.events.filter(event=>['user/message','assistant/message'].includes(event.type)).map(event=>event.type==='assistant/message'?event.data.message.id:event.data.id)}
  report.originalConfig=await ctx.rpAgentTeam.getConfig({conversationId:id})
 } else {
  const characterId=randomUUID(),persona={assistant_name:'Synthetic Character',assistant_avatar:'',assistant_square:'',assistant_cover:'',hidden_character_truth:'HIDDEN_WORLD_CANARY'}
  ctx.eleckoiCharactersApi.create({id:characterId,name:'Synthetic Character',persona,primaryOpening:''})
  const details=await ctx.eleckoiConversationsApi.create({title:'Isolated RP Agent Team verification',metadata:{characterId,characterName:'Synthetic Character',characterPersona:persona}})
  id=details.conversation.id
 }
 report.successConversationId=id
 await ctx.eleckoiConversationModelsApi.select(id,{provider,model:'root'})
 const config=defaultTeamConfig();config.agents=[
 createAgent({id:'observer',name:'Observer',modelRef:{provider,model:'observer'},parameters:{temperature:0.3},context:{sources:[{type:'current_input'}]},communication:{sendTo:['actor']},statePermissions:[{namespace:'shared',path:'/score',access:'readwrite'},{namespace:'world',path:'/variables/probe',access:'readwrite'}],outputAuthority:{internal:true,state:true}}),
 createAgent({id:'actor',name:'Actor',modelRef:{provider,model:'actor'},context:{sources:[{type:'current_input'},{type:'agent_messages',agentIds:['observer']}]},communication:{receiveFrom:['observer']},outputAuthority:{internal:true,user:true},execution:{after:['observer'],onFailure:'stop'}})]
 config.output={agentId:'actor'};config.state={definitions:[{namespace:'shared',path:'/score',type:'number',default:1},{namespace:'world',path:'/variables/probe',type:'number',default:0}]}
 const priorConfig=await ctx.rpAgentTeam.getConfig({conversationId:id})
 await ctx.rpAgentTeam.saveConfig({conversationId:id,expectedRevision:priorConfig.revision,enabled:true,config:normalizeTeamConfig(config)})
 const first=await send(id,'PROBE_FIRST')
 assert.equal(first.error,'')
 const status=await ctx.rpAgentTeam.getStatus({conversationId:id})
 report.admission={prepared:first.prepared,status,eventTypes:first.newEvents.map(event=>({type:event.type,seq:event.seq}))}
 assert.ok(status.run,'Native Team admission produced no run: '+JSON.stringify(report.admission))
 assert.equal(status.run.phase,'complete',JSON.stringify(status))
 const bodies=first.newEvents.filter(event=>event.type==='assistant/message'&&event.data.message.content.some(block=>block.type==='text'))
 assert.equal(bodies.length,1);assert.ok(JSON.stringify(bodies).includes('TEAM_BODY'))
 assert.equal(requests.filter(request=>request.model==='root').length,0,'Team publication must not call root external model')
 assert.equal(requests.find(request=>request.model==='observer').temperature,0.3)
 const receipt=await ctx.eleckoiConversationsApi.turnCommitStatus({conversationId:id,runId:status.run.runId});assert.equal(receipt.outcome,'committed');assert.equal(receipt.active,true)
 const state=await ctx.rpAgentTeam.getState({conversationId:id})
 assert.equal(state.values.find(value=>value.namespace==='shared'&&value.path==='/score')?.value,2,'Accepted product save must commit staged plugin state')
 assert.equal(JSON.parse((await ctx.eleckoiConversationsApi.authorState(id)).currentVariableStateJson).probe,2,'Product variables must commit with the official body checkpoint')
 report.scenarios.push({name:'full-runtime-native-members-local-delivery-unique-body-commit',passed:true,conversationId:id,runId:status.run.runId,receipt})
 const trace=await ctx.rpAgentTeam.getTrace({conversationId:id,runId:status.run.runId})
 assert.equal(trace.executionSessions.filter(execution=>execution.scheduled).length,2)
 assert.ok(trace.events.some(event=>event.type==='model.input'))
 for(const execution of trace.executionSessions){const member=await readSessionInspection(ctx,execution.sessionId,signal());assert.ok(member.events.some(event=>event.type==='assistant/message'))}
 report.scenarios.push({name:'persistent-native-execution-associations-and-request-input',passed:true})
 const second=await send(id,'PROBE_SECOND');assert.equal(second.error,'')
 assert.equal(second.prepared.runtimeSessionId,first.prepared.runtimeSessionId)
 const secondStatus=await ctx.rpAgentTeam.getStatus({conversationId:id});assert.notEqual(secondStatus.run.runId,status.run.runId)
 assert.equal((await ctx.rpAgentTeam.getState({conversationId:id})).values.find(value=>value.path==='/score').value,3)
 assert.equal(second.newEvents.filter(event=>event.type==='assistant/message').length,1)
 report.scenarios.push({name:'multiple-turns-stable-product-session-new-run-committed-state',passed:true})
 const secondInput=second.newEvents.find(event=>event.type==='user/message'&&event.data.source?.kind==='user')
 assert.ok(secondInput,'Regeneration must locate the real user input')
 const regenerationId=randomUUID()
 const regenerated=await ctx.eleckoiConversationsApi.regenerateMessage(id,secondInput.seq,regenerationId)
 const started=await ctx.eleckoiConversationsApi.startRegeneration(id,regenerationId,false);assert.equal(started.accepted,true)
 await ctx.agents.get(regenerated.runtimeSessionId).whenIdle()
 await ctx.eleckoiConversationsApi.waitForGeneration(id,regenerated.operationId)
 const regeneratedStatus=await ctx.rpAgentTeam.getStatus({conversationId:id})
 assert.equal(regeneratedStatus.run.phase,'complete');assert.notEqual(regeneratedStatus.run.runId,secondStatus.run.runId)
 const regeneratedReceipt=await ctx.eleckoiConversationsApi.turnCommitStatus({conversationId:id,runId:regeneratedStatus.run.runId})
 assert.equal(regeneratedReceipt.active,true)
 assert.equal((await ctx.eleckoiConversationsApi.turnCommitStatus({conversationId:id,runId:secondStatus.run.runId})).active,false)
 assert.equal(regeneratedReceipt.inputMessageId,secondInput.data.id)
 report.scenarios.push({name:'official-regeneration-retains-input-identity-new-run-historical-attempt-inactive',passed:true})
 await ctx.eleckoiConversationsApi.deleteMessagesFrom(id,regeneratedReceipt.assistantSeq,'assistant')
 assert.equal((await ctx.eleckoiConversationsApi.turnCommitStatus({conversationId:id,runId:regeneratedStatus.run.runId})).active,false)
 assert.equal(JSON.parse((await ctx.eleckoiConversationsApi.authorState(id)).currentVariableStateJson).probe,2)
 assert.equal((await ctx.rpAgentTeam.getState({conversationId:id})).values.find(value=>value.namespace==='shared'&&value.path==='/score').value,2)
 report.scenarios.push({name:'official-rewind-restores-world-and-plugin-checkpoints',passed:true})
 const unrestricted=await ctx.rpAgentTeam.getConfig({conversationId:id})
 const limited=structuredClone(unrestricted.config);limited.execution.budget={maxRequests:1}
 await ctx.rpAgentTeam.saveConfig({...unrestricted,expectedRevision:unrestricted.revision,config:limited})
 const requestStart=requests.length,budget=await send(id,'PROBE_BUDGET')
 assert.ok(budget.error,'Budget exhaustion must fail generation')
 assert.equal(requests.length-requestStart,1,'Dispatch must reserve request slots before launching')
 assert.equal(budget.newEvents.filter(event=>event.type==='assistant/message').length,0)
 assert.equal((await ctx.rpAgentTeam.getState({conversationId:id})).values.find(value=>value.path==='/score').value,2)
 assert.equal((await ctx.rpAgentTeam.getStatus({conversationId:id})).run.phase,'failed')
 report.scenarios.push({name:'native-budget-dispatch-stop-no-body-or-state-commit',passed:true})
 const limitedSaved=await ctx.rpAgentTeam.getConfig({conversationId:id})
 await ctx.rpAgentTeam.saveConfig({...limitedSaved,expectedRevision:limitedSaved.revision,config:unrestricted.config})
 const cancellation=send(id,'PROBE_CANCEL')
 const deadline=Date.now()+10000
 let cancelling
 while(Date.now()<deadline){cancelling=(await ctx.rpAgentTeam.getStatus({conversationId:id})).run;if(cancelling?.phase==='working')break;await new Promise(resolve=>setTimeout(resolve,20))}
 assert.equal(cancelling?.phase,'working')
 await ctx.rpAgentTeam.cancel({conversationId:id,runId:cancelling.runId})
 const cancelled=await cancellation
 assert.equal(cancelled.newEvents.filter(event=>event.type==='assistant/message').length,0)
 assert.equal((await ctx.rpAgentTeam.getState({conversationId:id})).values.find(value=>value.path==='/score').value,2)
 assert.equal((await ctx.rpAgentTeam.getStatus({conversationId:id})).run.phase,'cancelled')
 report.scenarios.push({name:'client-cancel-drains-native-children-no-body-or-state-commit',passed:true})
 const saved=await ctx.rpAgentTeam.getConfig({conversationId:id})
 await ctx.rpAgentTeam.saveConfig({...saved,enabled:false,expectedRevision:saved.revision})
 const normal=await send(id,'PROBE_ORDINARY');assert.equal(normal.error,'');assert.ok(JSON.stringify(normal.newEvents).includes('ORDINARY_BODY'))
 assert.equal(requests.filter(request=>request.model==='root').length,1)
 report.scenarios.push({name:'team-off-stable-session-ordinary-chat',passed:true})
 const api=ctx.rpAgentTeam
 await ctx.pluginManager.setBundleEnabled('@rp-team/dsh-roleplay-team',false)
 assert.ok(!ctx.rpAgentTeam);await ctx.pluginManager.removeBundle('@rp-team/dsh-roleplay-team')
 assert.ok(!(await ctx.pluginManager.listBundles()).some(bundle=>bundle.name==='@rp-team/dsh-roleplay-team'))
 const reinstall=await ctx.pluginManager.installBundle(bundle);assert.equal(reinstall.application,'applied');assert.notEqual(api,ctx.rpAgentTeam)
 report.scenarios.push({name:'disable-uninstall-reinstall-release',passed:true})
 report.requests=requests.map(({messages,...request})=>request)
 report.successConversationId=id
 if(report.importedHistory){const current=await readSessionInspection(ctx,report.importedHistory.sessionId,signal());const retained=new Set(current.events.filter(event=>['user/message','assistant/message'].includes(event.type)).map(event=>event.type==='assistant/message'?event.data.message.id:event.data.id));assert.ok(report.importedHistory.messageIds.every(id=>retained.has(id)),'Continuation/regeneration/rewind damaged imported history');report.scenarios.push({name:'imported-history-retained-through-local-continuation-regeneration-and-rewind',passed:true})}
 writeFileSync(join(data,'results.json'),JSON.stringify(report,null,2))
 console.log(JSON.stringify(report,null,2))
}catch(error){
 report.requests=requests.map(({messages,...request})=>request)
 report.error={message:error.message,stack:error.stack}
 writeFileSync(join(data,'failure.json'),JSON.stringify(report,null,2))
 console.error(error);process.exitCode=1
}finally{await running.shutdown.shutdown(process.exitCode??0)}
