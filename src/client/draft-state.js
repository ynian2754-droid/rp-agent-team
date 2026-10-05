// Pure editor-draft transitions. One state object exists per product conversation;
// it records which saved revision the draft started from so a save can never
// silently overwrite a newer remote configuration.

const RAW_FIELDS = ['parameters', 'context', 'statePermissions', 'capabilities']

export function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`
  return JSON.stringify(value)
}

const copy = value => value == null ? value : JSON.parse(JSON.stringify(value))

export function createDraftState(dto, ui = {}) {
  const config = copy(dto.config)
  const selectedId = config.agents.some(agent => agent.id === ui.selectedId) ? ui.selectedId : config.agents[0]?.id || ''
  return {
    draft: config,
    parameterValues: copy(dto.parameterValues || {}),
    baseValues: stableJson(dto.parameterValues || {}),
    base: stableJson(dto.config),
    baseRevision: dto.revision,
    dirty: false,
    invalid: {},
    rawJson: {},
    remote: null,
    error: '',
    notice: '',
    selectedId,
    view: ui.view || 'roster',
    open: ui.open || {}
  }
}

const uiOf = state => state ? { selectedId: state.selectedId, view: state.view, open: state.open } : {}

/** Reconciles a newly read saved configuration with the local draft. */
export function syncRemote(state, dto) {
  if (!dto?.config) return state
  if (!state?.draft) return createDraftState(dto, uiOf(state))
  if (dto.revision === state.baseRevision || state.remote?.revision === dto.revision) return state
  if (!state.dirty) return { ...createDraftState(dto, uiOf(state)), notice: state.notice }
  if (stableJson(dto.config) === state.base && stableJson(dto.parameterValues || {}) === state.baseValues) return { ...state, baseRevision: dto.revision, remote: null }
  return { ...state, remote: { revision: dto.revision } }
}

export function resolveConflict(state, choice, dto) {
  if (choice === 'discard') return createDraftState(dto, uiOf(state))
  return { ...state, base: stableJson(dto.config), baseValues: stableJson(dto.parameterValues || {}), baseRevision: dto.revision, remote: null, error: '' }
}

/** A save only clears the draft when nothing changed while the request was in flight. */
export function markSaved(state, saved, submitted, submittedValues = state.parameterValues) {
  if (state.draft === submitted && state.parameterValues === submittedValues) return { ...createDraftState(saved, uiOf(state)), notice: 'saved' }
  return { ...state, base: stableJson(saved.config), baseValues: stableJson(saved.parameterValues || {}), baseRevision: saved.revision, remote: null, error: '' }
}

export function replaceDraft(state, config, notice = '', parameterValues = {}) {
  const selectedId = config.agents.some(agent => agent.id === state.selectedId) ? state.selectedId : config.agents[0]?.id || ''
  return { ...state, draft: config, parameterValues: copy(parameterValues), dirty: true, invalid: {}, rawJson: {}, error: '', notice, selectedId }
}

export function editParameterValue(state, id, value) {
  const parameterValues = { ...state.parameterValues }
  if (value === undefined) delete parameterValues[id]
  else parameterValues[id] = value
  return { ...state, parameterValues, dirty: true, error: '', notice: '' }
}

export function editConfig(state, config, { keepStateForms = false } = {}) {
  if (!keepStateForms && state.stateForms && config.state.definitions !== state.draft.state.definitions) {
    const invalid = { ...state.invalid }
    delete invalid['$team:definitions']
    state = { ...state, stateForms: undefined, invalid }
  }
  return { ...state, draft: config, dirty: true, error: '', notice: '' }
}

function clearKeys(record, predicate) {
  const next = {}
  for (const [key, value] of Object.entries(record)) if (!predicate(key)) next[key] = value
  return next
}

/**
 * Applies member changes. Structured edits drop the matching raw JSON buffer so the
 * JSON view reflects them; `keepRaw` keeps the buffer the edit came from.
 */
export function editMember(state, memberId, changes, { keepRaw } = {}) {
  const draft = { ...state.draft, agents: state.draft.agents.map(agent => agent.id === memberId ? { ...agent, ...changes } : agent) }
  const stale = new Set(RAW_FIELDS.filter(field => Object.hasOwn(changes, field)).map(field => `${memberId}:${field}`))
  if (changes.execution && Object.hasOwn(changes.execution, 'trustedTools')) stale.add(`${memberId}:trustedTools`)
  const conditionPrefix = Object.hasOwn(changes, 'triggers') ? `${memberId}:condition-` : null
  const member = draft.agents.find(agent => agent.id === memberId)
  const drop = key => key !== keepRaw && (stale.has(key) || (conditionPrefix !== null && key.startsWith(conditionPrefix))
    || (changes.triggers && !changes.triggers.some(trigger => trigger.type === 'condition') && key.startsWith(`${memberId}:typed-condition-`))
    || (changes.communication && key.startsWith(`${memberId}:handoff-`) && !(member.communication.handoffs || []).some(item => key.startsWith(`${memberId}:handoff-${item.id}-`))))
  return { ...state, draft, dirty: true, error: '', notice: '', invalid: clearKeys(state.invalid, drop), rawJson: clearKeys(state.rawJson, drop) }
}

export function setRawJson(state, key, raw, invalid) {
  const next = { ...state.invalid }
  if (invalid) next[key] = true
  else delete next[key]
  return { ...state, rawJson: { ...state.rawJson, [key]: raw }, invalid: next }
}

export function dropMemberBuffers(state, memberId) {
  const drop = key => key.startsWith(`${memberId}:`)
  return { ...state, invalid: clearKeys(state.invalid, drop), rawJson: clearKeys(state.rawJson, drop) }
}

export function invalidEntries(state) {
  return Object.keys(state?.invalid || {}).filter(key => state.invalid[key]).map(key => {
    const index = key.indexOf(':')
    return { key, scope: key.slice(0, index), field: key.slice(index + 1) }
  })
}

const SECTION_BY_FIELD = { parameters: 'identity', context: 'context', statePermissions: 'state', capabilities: 'output', trustedTools: 'output' }

export function sectionForField(field) {
  return field.includes('condition-') ? 'trigger' : field.startsWith('handoff-') ? 'communication' : SECTION_BY_FIELD[field] || 'identity'
}
