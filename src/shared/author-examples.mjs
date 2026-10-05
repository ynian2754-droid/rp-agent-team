import { normalizeTeamConfig, examplePresets } from './schema.mjs'

/** Optional author examples. Runtime has no knowledge of these names or roles. */
export function authoringExamples() {
 return ['await','resume'].map(mode=>{
  const config=examplePresets()[0],seed=config.agents[0]
  const make=(id,name)=>({...structuredClone(seed),id,name,presetId:'',parameters:{},modelRef:'inherit',capabilities:[],context:{sources:[{type:'current_input'},{type:'recent_history',limit:8}]},communication:{sendTo:[],receiveFrom:[],requestTo:[],requestFrom:[]},statePermissions:[],triggers:[{type:'always'}],execution:{...seed.execution,after:[],trustedTools:[]},outputAuthority:{internal:true,draft:false,state:false,user:false}})
  const actor=make('actor','角色的主观认知'),environment=make('environment','环境与可感知信息')
  actor.systemPrompt=`只根据你实际能看到的输入、历史和返回的感官信息扮演角色。需要确认环境时，通过交接规则 perception 调用 environment。${mode==='await'?'拿到结果后在本次执行中继续。':'本次先记录观察意向；结果回来后在新执行中回应。'} 不强求剧情推进，不把内部分析写成正文。`
  actor.context.sources.push({type:'agent_messages',agentIds:['environment']})
  actor.communication={sendTo:[],receiveFrom:['environment'],requestTo:['environment'],requestFrom:[],handoffs:[{id:'perception',to:'environment',mode,timeoutMs:300000,onFailure:'return_error',requestSelectors:['/summary','/data/question'],responseSelectors:['/data/sensory'],responseSchema:{type:'object',properties:{data:{type:'object',properties:{sensory:{type:'string'}},required:['sensory']}},required:['data']}}]}
  actor.outputAuthority={internal:true,draft:true,state:false,user:true}
  environment.systemPrompt='描述角色此刻通过身体和感官可以获知的信息。把这些内容放在 submit_internal 的 data.sensory 中；未被感知的客观信息可以另放 data.objective。只回应本次请求，不主动规定故事目标。'
  environment.context.sources.push({type:'worldbook'},{type:'character_card'},{type:'hidden_state'})
  environment.triggers=[{type:'requested_by_agent',from:['actor']}]
  environment.communication={sendTo:['actor'],receiveFrom:[],requestTo:[],requestFrom:['actor']}
  config.id=`author-perception-${mode}`;config.name=mode==='await'?'先观察，再回应':'先继续，感知回来再回应';config.version='0.3.0';config.metadata={author:'RP Team example',description:'通过配置定义主观信息边界与不同的交接方式。'}
  config.agents=[actor,environment];config.output={agentId:'actor'};config.execution.concurrency=1
  config.state={definitions:[{namespace:'private:actor',path:'/attention',type:'object',default:{focus:'',confidence:0.5},valueSchema:{type:'object',properties:{focus:{type:'string'},confidence:{type:'number',minimum:0,maximum:1}},required:['focus','confidence']}}]}
  actor.statePermissions=[{namespace:'private:actor',path:'/attention',access:'readwrite'}];actor.outputAuthority.state=true
  return normalizeTeamConfig(config)
 })
}
