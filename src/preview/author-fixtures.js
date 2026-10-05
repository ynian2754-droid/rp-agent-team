// UI-only data. Runtime/CAS correctness is tested against the actual Host separately.
import { normalizeTeamConfig } from '../shared/schema.mjs'
export function authorFixtureMethods(conversations) {
 const library=new Map(),states=new Map()
 const current=id=> {
  if(!states.has(id))states.set(id,{conversationId:id,revision:0,worldHash:'fixture-0',anchor:{sessionId:`s-${id}`,turn:1,eventSeq:3},busy:false,pendingEdits:[],definitions:[{namespace:'shared',path:'/feeling',type:'string',default:'quiet'}],values:[{namespace:'shared',path:'/feeling',value:'curious',initial:'quiet',version:0,missing:false}]})
  return structuredClone(states.get(id))
 }
 const record=config=>({id:config.id,version:config.version,hash:`ui-${config.version}`,config:structuredClone(config)})
 return {
  getContextCatalog:()=>({version:'fixture-source',anchor:null,busy:false,sources:[{type:'character_card',fields:[{path:'/name',label:'姓名',type:'string'},{path:'/persona/name',label:'角色名字',type:'string'}]},{type:'current_input',fields:[{path:'/text',label:'输入文字',type:'string'}]}]}),
  previewConfig:p=>({configHash:'ui',sourceVersion:'fixture-source',anchor:null,issues:[],members:p.config.agents.map(agent=>({id:agent.id,name:agent.name,triggered:agent.triggers.some(x=>x.type==='always'||x.type==='manual'&&p.manualAgentIds?.includes(agent.id)),reasons:['配置检查'],context:{current_input:{text:p.inputText}},permissions:{stateRules:agent.statePermissions},tools:agent.capabilities,dependencies:agent.execution.after,missingSelections:[],dynamic:['模型的实际请求由运行时决定'],issues:[]}))}),
  getState:p=>{const data=current(p.conversationId);return p.agentId?{...data,values:[]}:data},
  listStateCheckpoints:p=>({checkpoints:[{id:'ui-checkpoint',label:'第 1 轮',anchor:current(p.conversationId).anchor,values:[{namespace:'shared',path:'/feeling',value:'calm',missing:false}],branchStatus:'current',canRewind:false}]}),
  applyStateEdit:p=>{const data=current(p.conversationId);if(p.expectedRevision!==data.revision)throw new Error('状态已改变，请重新读取。');for(const operation of p.operations){const row=data.values.find(x=>x.namespace===operation.namespace&&x.path===operation.path);row.value=operation.operation==='reset'?row.initial:operation.value;row.missing=operation.operation==='remove'}data.revision++;states.set(p.conversationId,data);return {status:'committed',operationId:p.operationId,state:data}},
  getStateEditStatus:p=>({operationId:p.operationId,status:'not_found'}),
  restoreStateCheckpoint:p=>({status:'committed',operationId:p.operationId}),
  listPresets:()=>({presets:[...library.values()].map(rows=>({id:rows[0].id,name:rows.at(-1).config.name,version:rows.at(-1).version,versions:rows.map(x=>({version:x.version,hash:x.hash,createdAt:'2026-10-04T00:00:00Z'}))}))}),
  getPreset:p=>library.get(p.id)?.find(x=>x.version===(p.version||library.get(p.id).at(-1).version)),
  savePreset:p=>{const r=record(normalizeTeamConfig(p.config)),rows=library.get(r.id)||[];const old=rows.find(x=>x.version===r.version);if(old&&JSON.stringify(old.config)!==JSON.stringify(r.config))throw new Error('这个版本已经保存，请改用新的版本。');if(!old)library.set(r.id,[...rows,r]);return r},
  copyPreset:p=>{const old=library.get(p.id).at(-1),r=record({...old.config,id:crypto.randomUUID(),name:old.config.name+' 副本'});library.set(r.id,[r]);return r},
  deletePreset:p=>{library.delete(p.id);return{deleted:true}},
  exportPreset:p=>({preset:{format:'rp-team-preset-v2',config:library.get(p.id).at(-1).config}}),
  importPreset:p=>{const r=record(normalizeTeamConfig(p.preset.config));library.set(r.id,[r]);return r},
  exportComponent:p=>({component:{format:'rp-team-component-v1',name:p.name,agents:p.config.agents.filter(x=>p.agentIds.includes(x.id))}}),
  prepareComponentImport:p=>({ports:[],conflicts:[],issues:[],changes:[{message:'UI fixture only'}],config:p.config,agentIdMap:{}}),
 }
}
