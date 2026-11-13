import { React } from './react.js'
import { t } from './i18n.js'
import { drafts, workspaceUi, useKeyed } from './client-state.js'
import { addAgent, removeAgent, validJsonShape } from './editor-model.js'
import { dropMemberBuffers, editConfig, editMember, setRawJson, tabForSection } from './draft-state.js'
import { memberIssues, modelInfo, presetInfo, peersFor, sourceTypes, stateCounts } from './summaries.js'
import { labelList, nameList } from './format.js'
import { triggerSummary } from './explain.js'
import { ConfirmButton, Icon, Segmented, Sigil } from './fields.jsx'
import { CommunicationSection, ContextSection, ModelSection, OutputSection, PromptSection, StateSection, TriggerSection } from './member-sections.jsx'

const REFERENCE_ISSUES = new Set(['missingProvider', 'missingModel', 'missingPreset', 'brokenPreset'])
export const SECTIONS = ['identity', 'trigger', 'context', 'communication', 'state', 'output']
/** One tab per thing an author comes to change. */
export const MEMBER_TABS = ['prompt', 'model', 'trigger', 'context', 'links', 'access']
const TAB_SECTIONS = { prompt: [], model: ['identity'], trigger: ['trigger'], context: ['context'], links: ['communication'], access: ['state', 'output'] }

/** One plain-language line per question, shown above the controls that produce it. */
export function sectionSummary(section, member, config, options) {
  if (section === 'identity') {
    const model = modelInfo(member, options)
    const preset = presetInfo(member, options)
    const modelText = model.kind === 'inherit' ? t('summary.inheritModel')
      : model.kind === 'incomplete' ? t('summary.modelIncomplete')
        : model.missingProvider || model.missingModel ? t('summary.modelMissing', { id: `${model.providerId}/${model.modelId}` })
          : model.model?.name || model.modelId
    const presetText = preset.kind === 'none' ? t('summary.noPreset') : preset.preset?.name || preset.id
    return `${modelText}${t('listSep')}${presetText}`
  }
  if (section === 'trigger') return triggerSummary(member, config, 4)
  if (section === 'context') {
    const types = sourceTypes(member)
    return types.length ? labelList(types, 'sourceShort') : t('summary.noContext')
  }
  if (section === 'communication') {
    const parts = []
    const handoffs = member.communication.handoffs || []
    if (handoffs.length) parts.push(t('summary.handoffs', { names: nameList(config, [...new Set(handoffs.map(item => item.to))], 2) }))
    for (const key of ['sendTo', 'requestTo', 'receiveFrom']) {
      const peers = peersFor(config, member, key)
      if (peers.length) parts.push(t(`summary.${key}`, { names: nameList(config, peers, 2) }))
    }
    return parts.length ? parts.slice(0, 3).join(t('clauseSep')) : t('summary.noCommunication')
  }
  if (section === 'state') {
    const counts = stateCounts(config, member)
    const parts = ['read', 'write', 'readwrite'].filter(key => counts[key]).map(key => t(`summary.state_${key}`, { n: counts[key] }))
    if (counts.extra) parts.push(t('summary.state_extra', { n: counts.extra }))
    return parts.length ? parts.join(t('listSep')) : t('summary.noState')
  }
  const authority = ['internal', 'draft', 'state'].filter(key => member.outputAuthority[key])
  const parts = []
  if (config.output.agentId === member.id) parts.push(t('summary.publishes'))
  parts.push(authority.length ? labelList(authority, 'authorityShort') : t('summary.noAuthority'))
  const tools = member.capabilities.filter(item => item.enabled).length
  if (tools) parts.push(t('summary.tools', { n: tools }))
  if (member.execution.trustedTools.length) parts.push(t('summary.trusted', { n: member.execution.trustedTools.length }))
  return parts.join(t('listSep'))
}

function rosterMeta(member, config) {
  const parts = [triggerSummary(member, config)]
  const asks = peersFor(config, member, 'requestTo')
  if (asks.length) parts.push(t('summary.requestTo', { names: nameList(config, asks, 2) }))
  return parts.join(' · ')
}

export function MembersPage({ conversationId, editor, snapshot, changes }) {
  const config = editor.draft
  const options = snapshot.options
  const ui = useKeyed(workspaceUi, conversationId)
  const member = config.agents.find(agent => agent.id === editor.selectedId) || config.agents[0]
  const memberIndex = config.agents.indexOf(member)
  const tab = MEMBER_TABS.includes(ui.memberTab) ? ui.memberTab : 'prompt'
  const [focus, setFocus] = React.useState(false)
  const rosterRef = React.useRef(null)
  const headingRef = React.useRef(null)
  const update = change => drafts.update(conversationId, change)
  const setTab = next => workspaceUi.update(conversationId, { memberTab: next })
  const invalidKeys = Object.keys(editor.invalid)
  const issues = React.useMemo(() => Object.fromEntries(config.agents.map(agent => [agent.id, memberIssues(agent, config, options, invalidKeys)])),
    [config, options, editor.invalid])
  const changed = new Map(changes.members.map(item => [item.id, item.kind]))
  const focusLater = fn => requestAnimationFrame(() => requestAnimationFrame(fn))
  const select = id => {
    setFocus(false)
    update(state => ({ ...state, selectedId: id, view: 'member' }))
    focusLater(() => headingRef.current?.focus())
  }
  const back = () => {
    setFocus(false)
    update(state => ({ ...state, view: 'roster' }))
    focusLater(() => rosterRef.current?.querySelector(`[data-member="${CSS.escape(member.id)}"]`)?.focus())
  }
  const add = source => {
    setFocus(false)
    update(state => {
      const added = addAgent(state.draft, source, { name: t('newMember'), copyName: name => t('copyName', { name }) })
      return { ...editConfig(state, added.config), selectedId: added.selectedId, view: 'member' }
    })
    setTab('prompt')
    focusLater(() => headingRef.current?.focus())
  }
  const remove = () => update(state => {
    const draft = removeAgent(state.draft, member.id)
    if (draft === state.draft) return state
    return { ...dropMemberBuffers(editConfig(state, draft), member.id), selectedId: draft.agents[0].id, view: 'roster' }
  })

  const edit = (changes, options) => update(state => editMember(state, member.id, changes, options))
  const json = (field, apply, validate = value => validJsonShape(field, value)) => {
    const key = `${member.id}:${field}`
    return {
      raw: editor.rawJson[key],
      invalid: Boolean(editor.invalid[key]),
      onInput(raw) {
        let parsed
        let valid = false
        try { parsed = JSON.parse(raw); valid = validate(parsed) } catch {}
        update(state => {
          const buffered = setRawJson(state, key, raw, !valid)
          if (!valid) return buffered
          const current = buffered.draft.agents.find(agent => agent.id === member.id)
          return editMember(buffered, member.id, apply(parsed, current), { keepRaw: key })
        })
      }
    }
  }
  const changeConfig = change => update(state => editConfig(state, change(state.draft)))
  const setInvalid = (key, invalid) => update(state => {
    const next = { ...state.invalid }
    if (invalid) next[`${member.id}:${key}`] = true
    else for (const field of Object.keys(next)) if (field.startsWith(`${member.id}:${key}`)) delete next[field]
    return { ...state, invalid: next }
  })
  const memberIssueList = issues[member.id] || []
  const issuesFor = name => memberIssueList.filter(issue => tabForSection(issue.section) === name)
  const tabOptions = MEMBER_TABS.map(name => {
    const list = issuesFor(name)
    const level = list.some(issue => issue.level === 'error') ? 'failed' : list.length ? 'warn' : ''
    return { id: name, label: t(`mtab.${name}`), title: t(`mtabHint.${name}`), ...(level ? { mark: level, markLabel: list.map(issue => t(`issue.${issue.code}`)).join(' ') } : {}) }
  })
  const props = { conversationId, member, config, options, edit, json, changeConfig, setInvalid }
  const publisher = config.output.agentId === member.id
  const focused = focus && tab === 'prompt'

  return <div className="rp-team-members" data-view={editor.view === 'member' ? 'member' : 'roster'}>
    <div className="rp-team-roster rp-team-scroll" ref={rosterRef}>
      <ul className="rp-team-roster-list" aria-label={t('members')}>
        {config.agents.map((agent, index) => {
          const list = issues[agent.id] || []
          const flag = list.some(issue => issue.level === 'error') ? 'error' : list.some(issue => REFERENCE_ISSUES.has(issue.code)) ? 'warn' : ''
          const flagText = flag === 'error' ? t('memberHasErrors') : t('memberHasMissing')
          const kind = changed.get(agent.id)
          return <li key={agent.id}>
            <button type="button" className="rp-team-roster-item" data-member={agent.id} aria-current={agent.id === member.id ? 'true' : undefined} onClick={() => select(agent.id)}>
              <Sigil name={agent.name} index={index} />
              <span className="rp-team-roster-top">
                <span className="rp-team-roster-name">{agent.name}</span>
                {config.output.agentId === agent.id ? <span className="rp-team-tag">{t('roster.publisher')}</span> : null}
                {kind ? <span className="rp-team-dirty" title={t(kind === 'added' ? 'roster.added' : 'roster.changed')}><span className="rp-team-sr">{t(kind === 'added' ? 'roster.added' : 'roster.changed')}</span></span> : null}
                {flag ? <span className={`rp-team-roster-issue is-${flag}`} title={flagText}><Icon name="warn" /><span className="rp-team-sr">{flagText}</span></span> : null}
              </span>
              <span className="rp-team-roster-meta">{rosterMeta(agent, config)}</span>
              {agent.description ? <span className="rp-team-roster-desc">{agent.description}</span> : null}
              <Icon name="chevron" className="rp-team-roster-chevron" />
            </button>
          </li>
        })}
      </ul>
      <button type="button" className="rp-team-add" onClick={() => add()}><Icon name="plus" />{t('addMember')}</button>
      {changes.removed.length ? <p className="rp-team-note rp-team-roster-removed">{t('roster.removed', { names: changes.removed.join(t('listSep')) })}</p> : null}
    </div>

    <div className={`rp-team-sheet ${focused ? 'is-focus' : 'rp-team-scroll'}`}>
      {focused ? null : <div className="rp-team-sheet-head">
        <button type="button" className="rp-team-back" onClick={back}><Icon name="back" />{t('backToMembers')}</button>
        <div className="rp-team-sheet-title">
          <Sigil name={member.name} index={memberIndex} size="large" />
          <h3 ref={headingRef} tabIndex={-1}>{member.name}</h3>
          {publisher ? <span className="rp-team-tag">{t('roster.publisher')}</span> : null}
          {changed.has(member.id) ? <span className="rp-team-chip is-draft">{t(changed.get(member.id) === 'added' ? 'roster.added' : 'roster.changed')}</span> : null}
          <span className="rp-team-sheet-actions">
            <button type="button" className="rp-team-quiet" onClick={() => add(member)}>{t('duplicateMember')}</button>
            <ConfirmButton label={t('removeMember')} confirmLabel={t('confirmRemove')} disabled={config.agents.length === 1} onConfirm={remove} />
          </span>
        </div>
      </div>}
      {focused ? null : <Segmented className="rp-team-mtabs" label={t('mtab.label')} value={tab} options={tabOptions} onChange={setTab} />}
      <div className="rp-team-mtab-body" key={`${member.id}:${tab}`}>
        {focused ? null : <TabLead tab={tab} member={member} config={config} options={options} issues={issuesFor(tab)} />}
        {tab === 'prompt' ? <PromptSection {...props} focus={focused} onFocus={setFocus} />
          : tab === 'model' ? <ModelSection {...props} />
            : tab === 'trigger' ? <TriggerSection {...props} />
              : tab === 'context' ? <ContextSection {...props} />
                : tab === 'links' ? <CommunicationSection {...props} />
                  : <><StateSection {...props} /><OutputSection {...props} /></>}
      </div>
    </div>
  </div>
}

/** What the controls below currently add up to, plus anything that needs fixing. */
function TabLead({ tab, member, config, options, issues }) {
  const summary = TAB_SECTIONS[tab].map(section => sectionSummary(section, member, config, options)).join(t('clauseSep'))
  if (!summary && !issues.length) return null
  return <div className="rp-team-lead">
    {summary ? <p className="rp-team-lead-summary"><span className="rp-team-eyebrow">{t('mtab.now')}</span>{summary}</p> : null}
    {issues.length ? <ul className="rp-team-issues">{issues.map((issue, index) => <li key={`${issue.code}-${index}`} className={`is-${issue.level}`}>{t(`issue.${issue.code}`)}</li>)}</ul> : null}
  </div>
}
