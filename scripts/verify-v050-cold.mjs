import assert from 'node:assert/strict'
import {createRequire} from 'node:module'
import {readFileSync,writeFileSync} from 'node:fs'
import {createHash} from 'node:crypto'
import {resolve,join,dirname} from 'node:path'
import {pathToFileURL} from 'node:url'

const argument=name=>process.argv[process.argv.indexOf(name)+1]
assert.ok(process.argv.includes('--host')&&process.argv.includes('--data'),'Supply --host FIXED_CHECKOUT --data COMPLETED_ISOLATED_SMOKE')
const hostRoot=resolve(argument('--host')),data=resolve(argument('--data'))
assert.ok(!data.includes('AppData'),'Never cold-open a real profile')
const previous=JSON.parse(readFileSync(join(data,'results.json'),'utf8'))
const require=createRequire(join(hostRoot,'package.json'))
const {runDshDesktopHeadlessProfile}=await import(pathToFileURL(require.resolve('@eleckoi/desktop-host')).href)
const {readSessionInspection}=await import(pathToFileURL(require.resolve('@eleckoi/dsh-product-api')).href)
const resourcesRoot=join(hostRoot,'apps/desktop/resources/dsh')
const imported=!!previous.importedHistory
const desktopProfile=!!previous.desktopProfile
const running=await runDshDesktopHeadlessProfile({runtimeDataRoot:join(data,desktopProfile?'dsh-runtime':'runtime'),workspaceRoot:join(data,'workspace'),productDatabasePath:join(data,imported?'product/eleckoi-common.sqlite3':desktopProfile?'eleckoi-common.sqlite3':'product.sqlite3'),productMediaRoot:join(data,imported?'product/media':'media'),resources:{presetTemplatePath:join(resourcesRoot,'agent-preset-template/agent.cordis.yml'),agentPatchPath:join(resourcesRoot,'desktop-agent.patch.yml'),nodeBinPath:join(resourcesRoot,'node-bin'),packageManagerEntryPath:join(dirname(require.resolve('pnpm')),'bin/pnpm.mjs')},patchFiles:[join(data,'probe.patch.yml')],environment:{DSH_TELEMETRY_DISABLED:'1'}})
const result={baseline:previous.baseline,hostVersion:previous.hostVersion,dshVersion:previous.dshVersion,bundleSha256:previous.bundleSha256,scenarios:[]}
try{
 const ctx=running.ctx,id=previous.successConversationId
 if(process.argv.includes('--bundle')) {
  const bundle=resolve(argument('--bundle'))
  await ctx.pluginManager.removeBundle('@rp-team/dsh-roleplay-team')
  const installed=await ctx.pluginManager.installBundle(bundle)
  assert.equal(installed.application,'applied',JSON.stringify(installed))
  result.bundleSha256=createHash('sha256').update(readFileSync(bundle)).digest('hex')
 }
 assert.ok(ctx.rpAgentTeam,'Installed bundle did not load after independent process restart')
 const committed=previous.scenarios.find(item=>item.receipt?.outcome==='committed')
 const receipt=await ctx.eleckoiConversationsApi.turnCommitStatus({conversationId:id,runId:committed.runId})
 assert.equal(receipt.outcome,'committed');assert.equal(receipt.active,true)
 assert.equal(receipt.assistantMessageId,committed.receipt.assistantMessageId)
 const state=await ctx.rpAgentTeam.getState({conversationId:id})
 assert.equal(state.values.find(value=>value.namespace==='shared'&&value.path==='/score')?.value,2)
 const config=await ctx.rpAgentTeam.getConfig({conversationId:id});assert.equal(config.enabled,false)
 result.scenarios.push({name:'durable-receipt-config-and-committed-state-after-process-restart',passed:true})
 const trace=await ctx.rpAgentTeam.getTrace({conversationId:id,runId:committed.runId})
 assert.equal(trace.executionSessions.filter(execution=>execution.scheduled).length,2)
 for(const execution of trace.executionSessions){const session=await readSessionInspection(ctx,execution.sessionId,AbortSignal.timeout(30000));assert.ok(session.events.some(event=>event.type==='assistant/message'))}
 const root=await readSessionInspection(ctx,receipt.sessionId,AbortSignal.timeout(30000))
 assert.ok(root.events.some(event=>event.type==='assistant/message'&&event.data.message.id===receipt.assistantMessageId))
 assert.ok(!root.running,'Reading recovery evidence must not start model work')
 result.scenarios.push({name:'persistent-member-session-links-native-body-and-no-automatic-regeneration',passed:true})
 writeFileSync(join(data,'cold-results.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2))
}catch(error){writeFileSync(join(data,'cold-failure.json'),JSON.stringify({message:error.message,stack:error.stack},null,2));console.error(error);process.exitCode=1}
finally{await running.shutdown.shutdown(process.exitCode??0)}
