import { describeStateToolAccess } from './state-store.mjs'

const namespace = 'shared'
const lazySources = ['recent_history', 'full_history', 'character_card', 'worldbook']
const worldSections = /\[\[world:(focused|other)\]\]\s*([\s\S]*?)\[\[\/world\]\]/gu
const maxPreviousBeatChars = 2400

const text = { type: 'string' }
const requiredText = { ...text, required: true }
const array = items => ({ type: 'array', items })
const object = properties => ({ type: 'object', additionalProperties: false, properties })
const strings = array(text)

export const focusedWorldStartParameters = {
  summary: { ...requiredText, description: 'Briefly identify this beat.' },
  stimuli: { ...array(object({
    content: { ...requiredText, description: 'A verbatim passage from the current user input.' },
    record: { ...object({
      content: text, storyTime: requiredText, people: { ...strings, required: true },
      source: { ...text, enum: ['用户'] },
      perceivers: { ...array(object({ who: requiredText,
        how: { ...requiredText, enum: ['亲历', '目击', '听说', '可察觉', '不知'] }, what: text })), required: true },
      weight: { ...requiredText, enum: ['寻常', '要紧', '转折'] },
      shown: { ...requiredText, enum: ['已呈现', '仅痕迹', '未呈现', '待呈现'] },
      tags: strings, because: strings, changed: text
    }), required: true }
  })), required: true },
  file: object({
    player: requiredText, present: { ...strings, required: true },
    midbeat: array(object({ content: requiredText, when: text })),
    first: { ...text, description: 'The name of the person who must act first. Omit if unspecified.' }
  }),
  settingsLog: object({
    expectedVersion: { type: 'integer', required: true }, value: { type: 'array', required: true }
  })
}
export const focusedWorldStartParametersWithSceneCues = {
  ...focusedWorldStartParameters,
  file: object({
    ...focusedWorldStartParameters.file.properties,
    sceneCues: { ...array(object({ content: requiredText, perceivers: { ...strings, required: true } })), required: true,
      description: 'Currently observable details that could change each character’s response, also when an outcome is not known. List only characters who can perceive them.' }
  })
}
const paths = {
  world: '/canon/world',
  situations: '/situations',
  settings_log: '/story/settings-log',
  events: '/canon/events',
  hidden: '/canon/hidden'
}

/** Objective evidence for the adjudicator. Reads use the same per-path ACLs as Team tools. */
export function createLivedHistoryWorldFacts({ run, agent, stateStore }) {
  if (agent.execution?.livedHistoryPhase !== 'world') return
  const readable = new Set(describeStateToolAccess(agent, run.config.state.definitions)
    .filter(item => item.namespace === namespace && item.read).map(item => item.path))
  const facts = Object.fromEntries(Object.entries(paths).filter(([, path]) => readable.has(path)).map(([key, path]) => [
    key, stateStore.read({ conversationId: run.conversationId, runId: run.runId, agentId: agent.id, namespace, path })
  ]))
  const cast = new Set(facts.world?.value?.now?.present ?? [])
  if (Array.isArray(facts.events?.value)) {
    facts.events.value = startRecords(facts.events.value, cast, 12)
  }
  if (Array.isArray(facts.hidden?.value)) {
    facts.hidden.value = startRecords(facts.hidden.value, cast, 8)
  }
  return facts
}

/** Keep current facts and the end of the latest published beat in the initial prompt. The configured
 * source projections are still available through the existing authorized context tools. */
export function focusLivedHistoryWorldContext(agentContext, requestId) {
  const { sources } = agentContext
  const originals = lazySources.filter(key => Object.hasOwn(sources, key))
  const latest = Array.isArray(sources.recent_history) && sources.recent_history.findLast(row =>
    row?.role === 'assistant' && typeof row.content === 'string' && row.content.trim())
  const persona = sources.character_card?.persona ?? sources.character_card
  const names = Object.fromEntries(['user_name', 'assistant_name'].filter(key => typeof persona?.[key] === 'string')
    .map(key => [key, persona[key]]))
  const current = Array.isArray(sources.agent_messages) && sources.agent_messages.find(row =>
    row.type === 'request' && row.requestId === requestId)
  for (const key of originals) delete sources[key]
  if (current) {
    sources.agent_messages = [select(current, ['requestId', 'from', 'handoffId', 'data'])]
    if (typeof current.data?.input === 'string' && current.data.input === sources.current_input?.text &&
      !sources.current_input.attachments?.length) delete sources.current_input
  }
  if (Object.keys(names).length) sources.world_names = names
  if (latest) sources.world_last_beat = { text: latest.content.slice(-maxPreviousBeatChars), clipped: latest.content.length > maxPreviousBeatChars }
  if (originals.length) sources.world_source_lookup = originals
  const facts = sources.world_facts
  if (Array.isArray(facts?.events?.value)) {
    facts.events.value = facts.events.value.map(row => select(row,
      ['id', 'content', 'storyTime', 'people', 'source', 'perceivers', 'weight', 'shown', 'tags', 'because', 'changed', 'confidence', 'covers', 'corrects']))
  }
  if (Array.isArray(facts?.hidden?.value)) {
    facts.hidden.value = facts.hidden.value.map(row => select(row, ['id', 'content', 'people', 'known_to', 'surface', 'ways_out', 'since', 'status', 'tags']))
  }
  agentContext.categories = Object.keys(sources)
}

export function focusedWorldPrompt(prompt, focused) {
  return prompt.replace(worldSections, (_block, section, body) => section === (focused ? 'focused' : 'other') ? body.trim() : '')
}

const select = (record, keys) => Object.fromEntries(keys.filter(key => Object.hasOwn(record, key)).map(key => [key, record[key]]))

// Preserve a recent global tail alongside cast-linked older events. Neither limits the existing lookup tools.
function startRecords(rows, cast, limit) {
  const active = rows.filter(row => row && row.active !== false)
  const latest = new Set(active.slice(-Math.ceil(limit / 2)))
  const hasPresentPerson = row => [row.people, row.known_to, row.perceivers?.map(item => item?.who)]
    .some(names => Array.isArray(names) && names.some(name => cast.has(name)))
  for (const row of active.slice().reverse()) {
    if (latest.size >= limit) break
    if (hasPresentPerson(row)) latest.add(row)
  }
  return active.filter(row => latest.has(row))
}
