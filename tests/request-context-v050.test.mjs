import test from 'node:test'
import assert from 'node:assert/strict'
import {normalizeRequestContext} from '../src/client/trajectory/request-context.js'

test('native source objects and serialized blocks become readable request inputs', () => {
  const original = [{order:0,messageId:'system',role:'system',source:{kind:'system-prompt'},content:JSON.stringify([{type:'text',text:'ACTUAL SYSTEM'}])},
    {order:1,messageId:'user',role:'user',source:{kind:'user'},content:JSON.stringify([{type:'text',text:'ACTUAL USER'}])},
    {order:2,messageId:'tool',role:'user',source:{kind:'tool',callId:'call-1'},content:JSON.stringify([{type:'tool-result',callId:'call-1',output:{status:'ok'}}])}]
  const result=normalizeRequestContext(original)
  assert.deepEqual(result.map(item=>item.order),[1,2,3])
  assert.deepEqual(result.map(item=>item.kind),['system','user','tool'])
  assert.equal(result[0].content,'ACTUAL SYSTEM')
  assert.equal(result[1].content,'ACTUAL USER')
  assert.equal(result[2].source,'tool · call-1')
  assert.equal(JSON.parse(result[2].content).output.status,'ok')
  assert.ok(result.every(item=>typeof item.source==='string'&&typeof item.title==='string'&&typeof item.anchor==='string'))
  assert.deepEqual(original[0].source,{kind:'system-prompt'})
})

test('recorded product titles and non-block content remain unchanged', () => {
  const product={order:4,messageId:'old',role:'user',kind:'prompt',title:'世界设定',source:'原始位置',anchor:'insert_point_1',content:'[1,2]'}
  assert.deepEqual(normalizeRequestContext([product]),[product])
  assert.equal(normalizeRequestContext([{role:'user',source:{kind:'user'},content:'not json'}])[0].content,'not json')
  assert.equal(normalizeRequestContext(undefined),undefined)
})
