import {createHash} from 'node:crypto'
import {cpSync,existsSync,mkdirSync,readFileSync,readdirSync,writeFileSync} from 'node:fs'
import {join,resolve} from 'node:path'
import {pathToFileURL} from 'node:url'
import {conversationTraceDirectory,manualSelectionPath} from '../src/host/run-persistence.mjs'

const SESSION_FIELDS=new Set(['sessionId','rootSessionId','parentSessionId','runtimeSessionId','childSessionId'])
const MESSAGE_FIELDS=new Set(['inputMessageId','assistantMessageId','productMessageId'])
const CONTENT_FIELDS=new Set(['config','templateConfig','configuration','parameterValues','namespaces','state','content','body','summary','context','before','after','worldBefore','worldAfter','beforeSnapshot','afterSnapshot'])

function remapConfigPresets(value,mapping) {
  if(!value||typeof value!=='object')return value
  const copy=structuredClone(value)
  // Product preset import IDs are not native DSH registry identities.
  if(Array.isArray(copy.agents))for(const agent of copy.agents)if(typeof agent.presetId==='string'&&mapping.nativePresets?.[agent.presetId])agent.presetId=mapping.nativePresets[agent.presetId]
  if(copy.config)copy.config=remapConfigPresets(copy.config,mapping)
  return copy
}

/** Remap storage identities only. Author state and prompts are opaque values. */
export function remapIdentities(value,mapping,key='') {
  if(value===null||typeof value!=='object') {
    if(SESSION_FIELDS.has(key))return mapping.sessions?.[value]??value
    if(MESSAGE_FIELDS.has(key))return mapping.messages?.[value]??value
    if(key==='conversationId')return mapping.conversations?.[value]??value
    if(key==='characterId')return mapping.characters?.[value]??value
    if(key==='operationId')return mapping.operations?.[value]??value
    return value
  }
  if(['config','templateConfig','configuration'].includes(key))return remapConfigPresets(value,mapping)
  if(CONTENT_FIELDS.has(key))return structuredClone(value)
  if(key==='authorEdits')return Object.fromEntries(Object.entries(value).map(([id,item])=>
    [mapping.operations?.[id]??id,remapIdentities(item,mapping)]))
  if(Array.isArray(value))return value.map(item=>key==='childSessionIds'||key==='sessions'
    ?mapping.sessions?.[item]??item:remapIdentities(item,mapping))
  return Object.fromEntries(Object.entries(value).map(([field,item])=>[field,remapIdentities(item,mapping,field)]))
}

function sourceContentSignature(source,mapping) {
  const hash=createHash('sha256')
  const add=(label,kind,bytes=Buffer.alloc(0))=>{
    hash.update(`${kind}\0${label}\0${bytes.length}\0`)
    hash.update(bytes)
  }
  const addFile=(label,path)=>{
    if(!existsSync(path)){add(label,'absent');return}
    const bytes=readFileSync(path)
    add(label,'file',bytes)
  }
  for(const filename of ['presets.json','conversations.json','state.json','trials/trials.json'])
    addFile(filename,join(source,filename))
  for(const oldId of Object.keys(mapping.conversations??{}).sort()) {
    const manual=manualSelectionPath(join(source,'conversations.json'),oldId)
    addFile(`manual/${oldId}`,manual)
    const oldDir=conversationTraceDirectory(join(source,'traces'),oldId)
    if(!existsSync(oldDir)){add(`traces/${oldId}`,'directory-absent');continue}
    add(`traces/${oldId}`,'directory')
    for(const filename of readdirSync(oldDir).filter(file=>file.endsWith('.json')).sort())
      addFile(`traces/${oldId}/${filename}`,join(oldDir,filename))
  }
  return hash.digest('hex')
}

export function convertPluginData({source,destination,mapping}) {
  source=resolve(source);destination=resolve(destination)
  if(destination===source||destination.startsWith(source+'\\')||destination.startsWith(source+'/'))throw new Error('Source must remain an unchanged stopped-profile copy; use a separate destination')
  const id=createHash('sha256').update(JSON.stringify(mapping)).digest('hex')
  const sourceSignature=sourceContentSignature(source,mapping)
  const marker=join(destination,'conversion-v050.json')
  if(existsSync(marker)) {
    const previous=JSON.parse(readFileSync(marker,'utf8'))
    if(previous.mappingHash!==id)throw new Error('Destination was converted using a different mapping; use a new empty destination')
    if(typeof previous.sourceSignature!=='string')throw new Error('Existing conversion marker has no source signature; use a new empty destination instead of reusing this legacy conversion')
    if(previous.sourceSignature!==sourceSignature)throw new Error('Destination was converted from different source contents; use a new empty destination')
    return {...previous,reused:true}
  }
  if(existsSync(destination)&&readdirSync(destination).length)throw new Error('Use an empty conversion destination')
  mkdirSync(destination,{recursive:true})
  const report={version:1,mappingHash:id,sourceSignature,conversations:[],archivedConversations:[],traces:0,handoffSidecars:0,archivedTrials:0,source}
  for(const entry of readdirSync(source,{withFileTypes:true})) {
    if(['conversations.json','state.json','traces','runs','manual','trials'].includes(entry.name))continue
    if(entry.name==='presets.json')writeFileSync(join(destination,entry.name),JSON.stringify(remapIdentities(JSON.parse(readFileSync(join(source,entry.name),'utf8')),mapping),null,2)+'\n')
    else cpSync(join(source,entry.name),join(destination,entry.name),{recursive:true})
  }
  // Old frozen snapshots use the removed Host protocol. Preserve scenarios for
  // a fresh freeze; old results/checkpoints remain read-only in the archive.
  const trialFile=join(source,'trials','trials.json')
  if(existsSync(trialFile)) {
    const oldTrials=JSON.parse(readFileSync(trialFile,'utf8'))
    mkdirSync(join(destination,'trials'),{recursive:true})
    writeFileSync(join(destination,'trials','trials.json'),JSON.stringify({version:1,scenarios:remapIdentities(oldTrials.scenarios??{},mapping),trials:{}},null,2)+'\n')
    report.archivedTrials=Object.keys(oldTrials.trials??{}).length
  }
  for(const filename of ['conversations.json','state.json']) {
    if(!existsSync(join(source,filename)))continue
    const input=JSON.parse(readFileSync(join(source,filename),'utf8'))
    const conversations={}
    for(const [oldId,record]of Object.entries(input.conversations??{})) {
      const newId=mapping.conversations?.[oldId]
      if(!newId){if(!report.archivedConversations.includes(oldId))report.archivedConversations.push(oldId);continue}
      if(conversations[newId])throw new Error('Multiple source conversations map to the same destination')
      conversations[newId]=remapIdentities(record,mapping)
      if(!report.conversations.includes(newId))report.conversations.push(newId)
    }
    writeFileSync(join(destination,filename),JSON.stringify({...input,conversations},null,2)+'\n')
  }
  for(const [oldId,newId]of Object.entries(mapping.conversations??{})) {
    const manual=manualSelectionPath(join(source,'conversations.json'),oldId)
    if(existsSync(manual)) {
      const target=manualSelectionPath(join(destination,'conversations.json'),newId)
      mkdirSync(resolve(target,'..'),{recursive:true})
      writeFileSync(target,JSON.stringify(remapIdentities(JSON.parse(readFileSync(manual,'utf8')),mapping),null,2)+'\n')
    }
    const oldDir=conversationTraceDirectory(join(source,'traces'),oldId)
    if(!existsSync(oldDir))continue
    const newDir=conversationTraceDirectory(join(destination,'traces'),newId)
    mkdirSync(newDir,{recursive:true})
    for(const filename of readdirSync(oldDir).filter(file=>file.endsWith('.json'))) {
      const row=JSON.parse(readFileSync(join(oldDir,filename),'utf8'))
      const converted=remapIdentities(row,mapping)
      converted.conversion={sourceConversationId:oldId,mappingHash:id,sourceVersion:'0.4.1'}
      writeFileSync(join(newDir,filename),JSON.stringify(converted,null,2)+'\n')
      if(filename.endsWith('.json.handoffs.json'))report.handoffSidecars++
      else report.traces++
    }
  }
  // Preserve all legacy material for inspection; it is not live state and cannot
  // restart an old in-flight model request or reuse an old filesystem bridge.
  cpSync(source,join(destination,'legacy-0.4.1-archive'),{recursive:true})
  writeFileSync(marker,JSON.stringify(report,null,2)+'\n')
  return report
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  const get=name=>{const index=process.argv.indexOf(name);if(index<0)throw new Error(`Missing ${name}`);return process.argv[index+1]}
  const report=convertPluginData({source:get('--source'),destination:get('--destination'),mapping:JSON.parse(readFileSync(get('--mapping'),'utf8'))})
  console.log(JSON.stringify(report,null,2))
}
