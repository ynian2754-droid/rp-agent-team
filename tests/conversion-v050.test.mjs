import test from 'node:test'
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {existsSync,mkdtempSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {convertPluginData,remapIdentities} from '../scripts/remap-plugin-data-v050.mjs'
import {conversationTraceDirectory} from '../src/host/run-persistence.mjs'
const mapping={conversations:{old:'new'},sessions:{root:'root-new',child:'child-new'},messages:{input:'input-new'}}
test('identity remapping preserves author values and native event numbers',()=>{
 const value={conversationId:'old',rootSessionId:'root',inputMessageId:'input',inputEventSeq:53,config:{id:'old',agents:[{id:'child'}]},namespaces:{shared:{sessionId:'root'}},members:{actor:{sessions:['child']}}}
 const result=remapIdentities(value,mapping)
 assert.equal(result.conversationId,'new');assert.equal(result.rootSessionId,'root-new');assert.equal(result.inputEventSeq,53)
 assert.deepEqual(result.config,value.config);assert.deepEqual(result.namespaces,value.namespaces);assert.deepEqual(result.members.actor.sessions,['child-new'])
})
test('conversion writes separate identities, archives unmatched records and reuses only matching inputs',()=>{
 const base=mkdtempSync(join(tmpdir(),'rp-team-v050-conversion-')),source=join(base,'source'),destination=join(base,'converted')
 mkdirSync(source);const raw=JSON.stringify({version:2,conversations:{old:{config:{id:'preset-stable'}},unmapped:{enabled:true}}})
 writeFileSync(join(source,'conversations.json'),raw)
 const traceDir=conversationTraceDirectory(join(source,'traces'),'old');mkdirSync(traceDir,{recursive:true});writeFileSync(join(traceDir,'run.json'),JSON.stringify({status:{conversationId:'old',runId:'stable-run'},rootSessionId:'root',executionSessions:[{sessionId:'child'}]}))
 writeFileSync(join(traceDir,'run.json.handoffs.json'),JSON.stringify({version:1,requests:[]}))
 const report=convertPluginData({source,destination,mapping});assert.equal(report.traces,1);assert.deepEqual(report.archivedConversations,['unmapped'])
 assert.equal(report.handoffSidecars,1)
 assert.equal(readFileSync(join(source,'conversations.json'),'utf8'),raw)
 assert.equal(JSON.parse(readFileSync(join(destination,'conversations.json'),'utf8')).conversations.new.config.id,'preset-stable')
 const firstMarker=JSON.parse(readFileSync(join(destination,'conversion-v050.json'),'utf8'))
 assert.match(firstMarker.sourceSignature,/^[a-f0-9]{64}$/)
 assert.equal(convertPluginData({source,destination,mapping}).reused,true)
 writeFileSync(join(source,'state.json'),JSON.stringify({version:1,conversations:{old:{state:{changed:true}}}}))
 assert.throws(()=>convertPluginData({source,destination,mapping}),/different source contents.*new empty destination/i)
 assert.deepEqual(JSON.parse(readFileSync(join(destination,'conversion-v050.json'),'utf8')),firstMarker)
 assert.equal(existsSync(join(destination,'state.json')),false)
 assert.throws(()=>convertPluginData({source,destination:source,mapping}),/unchanged/)
})

test('legacy conversion markers without source signatures require a new destination',()=>{
 const base=mkdtempSync(join(tmpdir(),'rp-team-v050-legacy-marker-')),source=join(base,'source'),destination=join(base,'converted')
 mkdirSync(source);mkdirSync(destination)
 const mappingHash=createHash('sha256').update(JSON.stringify(mapping)).digest('hex')
 const legacyMarker={version:1,mappingHash,source}
 writeFileSync(join(destination,'conversion-v050.json'),JSON.stringify(legacyMarker))
 assert.throws(()=>convertPluginData({source,destination,mapping}),/no source signature.*new empty destination/i)
 assert.deepEqual(JSON.parse(readFileSync(join(destination,'conversion-v050.json'),'utf8')),legacyMarker)
})

test('legacy trial checkpoints stay archived while author scenarios can be frozen again',()=>{
 const base=mkdtempSync(join(tmpdir(),'rp-team-v050-trial-conversion-')),source=join(base,'source'),destination=join(base,'converted')
 mkdirSync(join(source,'trials'),{recursive:true})
 writeFileSync(join(source,'trials','trials.json'),JSON.stringify({version:1,scenarios:{scenario:{conversationId:'old',inputs:['hello']}},trials:{trial:{phase:'running'}}}))
 const report=convertPluginData({source,destination,mapping})
 assert.equal(report.archivedTrials,1)
 const converted=JSON.parse(readFileSync(join(destination,'trials','trials.json'),'utf8'))
 assert.equal(converted.scenarios.scenario.conversationId,'new');assert.deepEqual(converted.trials,{})
 assert.equal(JSON.parse(readFileSync(join(destination,'legacy-0.4.1-archive','trials','trials.json'),'utf8')).trials.trial.phase,'running')
})

test('native preset references follow exact import mapping without renaming Team presets or author data',()=>{
 const value={characterId:'old-character',config:{id:'team-stable',agents:[{id:'actor-stable',presetId:'native-old',systemPrompt:'native-old'}],state:{definitions:[{default:{presetId:'native-old',characterId:'old-character'}}]}},namespaces:{shared:{characterId:'old-character'}}}
 const result=remapIdentities(value,{...mapping,characters:{'old-character':'new-character'},presets:{'native-old':'product-new'},nativePresets:{'native-old':'native-new'}})
 assert.equal(result.characterId,'new-character');assert.equal(result.config.id,'team-stable')
 assert.equal(result.config.agents[0].presetId,'native-new');assert.equal(result.config.agents[0].id,'actor-stable')
 assert.equal(result.config.agents[0].systemPrompt,'native-old');assert.deepEqual(result.config.state,value.config.state)
 assert.deepEqual(result.namespaces,value.namespaces)
 assert.equal(remapIdentities(value,{presets:{'native-old':'product-new'}}).config.agents[0].presetId,'native-old',
  'An unmapped native reference stays visible as missing rather than becoming a product ID')
})

test('imported operation identities remap receipts and edit keys while author state stays opaque',()=>{
 const value={authorEdits:{'old-op':{operationId:'old-op',hostReceipt:{operationId:'old-op'},
   beforeSnapshot:{namespaces:{shared:{operationId:'old-op'}}}}},commitIdentity:{operationId:'old-op'},
   namespaces:{shared:{operationId:'old-op'}}}
 const result=remapIdentities(value,{operations:{'old-op':'new-op'}})
 assert.equal(result.commitIdentity.operationId,'new-op')
 assert.equal(result.authorEdits['new-op'].operationId,'new-op')
 assert.equal(result.authorEdits['new-op'].hostReceipt.operationId,'new-op')
 assert.deepEqual(result.authorEdits['new-op'].beforeSnapshot,value.authorEdits['old-op'].beforeSnapshot)
 assert.deepEqual(result.namespaces,value.namespaces)
})
