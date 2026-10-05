import test from 'node:test'
import assert from 'node:assert/strict'
import { stateChoices, stateKey, stableContent, conditionNode, conditionBufferKey, comparePresets, previewIsStale, stateEditRequest, removedChildKey } from '../src/client/author-model.js'
import { createDraftState, editMember, sectionForField } from '../src/client/draft-state.js'
import { createKeyedStore } from '../src/client/keyed-store.js'
import { createClientApi } from '../src/client/api.js'
import { examplePresets, normalizeTeamConfig, exportPreset } from '../src/shared/schema.mjs'
import { authoringExamples } from '../src/shared/author-examples.mjs'
import { removeAgent } from '../src/client/editor-model.js'
import { memberIssues } from '../src/client/summaries.js'

test('nested state fields keep escaped identity and selectable ACL addresses', () => {
 const choices=stateChoices([{namespace:'shared',path:'/body',type:'object',valueSchema:{type:'object',properties:{'pulse/rate':{type:'number'},'~secret':{type:'string'}}}}])
 assert.deepEqual(choices.map(x=>x.path),['/body','/body/pulse~1rate','/body/~0secret'])
 assert.equal(new Set(choices.map(stateKey)).size,3)
})
test('condition groups preserve typed values; preview invalidates on inputs, sources and draft', () => {
 const leaf={op:'compare',namespace:'shared',path:'/pulse',operator:'gt',value:12}
 assert.deepEqual(conditionNode('all',leaf),{op:'all',conditions:[leaf]})
 assert.deepEqual(conditionNode('any',conditionNode('all',leaf)),{op:'any',conditions:[leaf]})
 assert.deepEqual(conditionNode('leaf',conditionNode('not',conditionNode('all',leaf))),leaf)
 assert.equal(conditionBufferKey('chat/rule','chat/rule',leaf,'all'),'chat/rule/0')
 assert.equal(conditionBufferKey('chat/rule/0','chat/rule',conditionNode('all',leaf),'leaf'),'chat/rule')
 assert.equal(conditionBufferKey('chat/rule/1','chat/rule',conditionNode('all',leaf),'leaf'),null)
 assert.equal(conditionBufferKey('other/rule','chat/rule',leaf,'all'),'other/rule')
 const draft={id:'a'},preview={draftContent:stableContent(draft),sourceVersion:'a',inputText:'hey',manualAgentIds:['actor']}
 assert.equal(previewIsStale(preview,draft,'a','hey',['actor']),false)
 for(const args of [[{id:'b'},'a','hey',['actor']],[draft,'b','hey',['actor']],[draft,'a','new',['actor']],[draft,'a','hey',[]]]) assert.equal(previewIsStale(preview,...args),true)
})
test('state editing sends the captured revision/anchor and a unique operation once', async () => {
 const snapshot={conversationId:'c',revision:4,worldHash:'w',anchor:{sessionId:'s',eventSeq:9}}
 const request=stateEditRequest(snapshot,[{namespace:'shared',path:'/a',operation:'set',value:null}])
 assert.equal(request.expectedRevision,4);assert.deepEqual(request.anchor,snapshot.anchor)
 assert.notEqual(request.operationId,stateEditRequest(snapshot,[]).operationId)
 let calls=0
 const api=createClientApi({getConfig:async()=>({}),applyStateEdit:async p=>{calls++;assert.equal(p,request);return {ok:false,error:{code:'CONFLICT',message:'State changed'}}}})
 await assert.rejects(api.author('applyStateEdit',request),{code:'CONFLICT'})
 assert.equal(calls,1)
})
test('removing handoffs/triggers removes only the corresponding invalid draft markers', () => {
 const config=examplePresets()[0], id=config.agents[0].id
 let draft=createDraftState({config,revision:1})
 draft.invalid={[`${id}:handoff-one-name`]:true,[`${id}:handoff-two-name`]:true,[`${id}:typed-condition-0`]:true}
 draft=editMember(draft,id,{communication:{...config.agents[0].communication,handoffs:[{id:'two'}]}})
 assert.equal(draft.invalid[`${id}:handoff-one-name`],undefined)
 assert.equal(draft.invalid[`${id}:handoff-two-name`],true)
 draft=editMember(draft,id,{triggers:[{type:'always'}]})
 assert.equal(draft.invalid[`${id}:typed-condition-0`],undefined)
 assert.equal(sectionForField('typed-condition-0'),'trigger');assert.equal(sectionForField('handoff-x-name'),'communication')
 const issues=memberIssues(config.agents[0],config,undefined,[`${id}:typed-condition-0`,`${id}:handoff-x-name`])
 assert.deepEqual(issues.filter(item=>item.code==='invalidInput').map(item=>item.section),['trigger','communication'])
})
test('buffer cleanup is scoped to a conversation and informs mounted consumers', () => {
 const store=createKeyedStore(()=>null);store.update('a/value',{text:'draft'});store.update('b/value',{text:'keep'})
 let changes=0;store.subscribe('a/value',()=>changes++)
 store.removeWhere(key=>key.startsWith('a/'))
 assert.equal(store.get('a/value'),null);assert.equal(changes,1);assert.equal(store.get('b/value').text,'keep')
})
test('library differences include actual field changes with before/after values', () => {
 const config=examplePresets()[0], next=structuredClone(config)
 next.agents[0].context.sources=[]
 assert.deepEqual(comparePresets(config,next).map(x=>x.field),['context'])
 assert.equal(comparePresets(config,next)[0].before,config.agents[0].context)
})

test('removing a condition or schema field preserves unfinished sibling buffers at their new positions', () => {
 const store=createKeyedStore(()=>null)
 store.update('chat/condition/0',{text:'remove'});store.update('chat/condition/1/not',{text:'unfinished'})
 store.update('other/condition/1',{text:'keep'})
 store.remapKeys(key=>removedChildKey(key,'chat/condition',0))
 assert.equal(store.get('chat/condition/0/not').text,'unfinished')
 assert.equal(store.has('chat/condition/1/not'),false)
 assert.equal(store.get('other/condition/1').text,'keep')
 assert.equal(removedChildKey('chat/schema/field-2/enum','chat/schema',1,'field-'),'chat/schema/field-1/enum')
 assert.equal(removedChildKey('chat/schema/items/enum','chat/schema',1,'field-'),'chat/schema/items/enum')
})
test('handoff contracts preserve old V2 data and reject malformed rules; deletion follows typed targets', () => {
 const old=examplePresets()[0];assert.equal(Object.hasOwn(normalizeTeamConfig(old).agents[0].communication,'handoffs'),false)
 const next=authoringExamples()[0];assert.equal(next.agents[0].communication.handoffs[0].mode,'await');assert.equal(exportPreset(next).dependencies.minimumPluginVersion,'0.3.0')
 const rule=next.agents[0].communication.handoffs[0]
 for(const patch of [{mode:'unknown'},{timeoutMs:0},{responseSelectors:['bad']},{to:'missing'}]) {const invalid=structuredClone(next);Object.assign(invalid.agents[0].communication.handoffs[0],patch);assert.throws(()=>normalizeTeamConfig(invalid))}
 const duplicate=structuredClone(next);duplicate.agents[0].communication.handoffs.push(rule);assert.throws(()=>normalizeTeamConfig(duplicate),/Duplicate handoff/)
 const remaining=normalizeTeamConfig(removeAgent(next,'environment'));assert.equal(remaining.agents[0].communication.handoffs.length,0)
})
