import { React } from './react.js'
import { t } from './i18n.js'
import { drafts } from './client-state.js'
import { addAgent, removeAgent, selectPublisher, validJsonShape } from './editor-model.js'
import { dropMemberBuffers, editConfig, editMember, setRawJson } from './draft-state.js'
import { memberIssues, modelInfo, presetInfo, peersFor, sourceTypes, stateCounts, triggerTypes } from './summaries.js'
import { labelList, nameList } from './format.js'
import { ConfirmButton, Icon } from './fields.jsx'
import { CommunicationSection, ContextSection, IdentitySection, OutputSection, StateSection, TriggerSection } from './member-sections.jsx'

const REFERENCE_ISSUES = new Set(['missingProvider', 'missingModel', 'missingPreset', 'brokenPreset'])
export const SECTIONS = ['identity', 'trigger', 'context', 'communication', 'state', 'output']
const SECTION_COMPONENTS = { identity: IdentitySection, trigger: TriggerSection, context: ContextSection, communication: CommunicationSection, state: StateSection, output: OutputSection }

/** One plain-language line per question; the editors stay folded until asked for. */
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
  if (section === 'trigger') {
    const types = triggerTypes(member)
    const parts = [types.length ? labelList(types, 'triggerShort') : t('summary.neverRuns')]
    if (member.execution.after.length) parts.push(t('summary.after', { names: nameList(config, member.execution.after, 2) }))
    return parts.join(t('clauseSep'))
  }
  if (section === 'context') {
    const types = sourceTypes(member)
    return types.length ? labelList(types, 'sourceShort') : t('summary.noContext')
  }
  if (section === 'communication') {
    const parts = []
    for (const key of ['sendTo', 'requestTo', 'receiveFrom']) {
      const peers = peersFor(config, member, key)
      if (peers.length) parts.push(t(`summary.${key}`, { names: nameList(config, peers, 2) }))
    }
    return parts.length ? parts.slice(0, 2).join(t('clauseSep')) : t('summary.noCommunication')
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
  const types = triggerTypes(member)
  const parts = [types.length ? labelList(types, 'triggerShort', 2) : t('summary.neverRuns')]
  if (member.execution.after.length) parts.push(t('summary.after', { names: nameList(config, member.execution.after, 1) }))
  return parts.join(t('clauseSep'))
}

export function MembersPage({ conversationId, editor, snapshot }) {
  const config = editor.draft
  const options = snapshot.options
  const member = config.agents.find(agent => agent.id === editor.selectedId) || config.agents[0]
  const rosterRef = React.useRef(null)
  const headingRef = React.useRef(null)
  const update = change => drafts.update(conversationId, change)
  const invalidKeys = Object.keys(editor.invalid)
  const issues = React.useMemo(() => Object.fromEntries(config.agents.map(agent => [agent.id, memberIssues(agent, config, options, invalidKeys)])),
    [config, options, editor.invalid])
  const focusLater = fn => requestAnimationFrame(() => requestAnimationFrame(fn))
  const select = id => {
    update(state => ({ ...state, selectedId: id, view: 'member' }))
    focusLater(() => headingRef.current?.focus())
  }
  const back = () => {
    update(state => ({ ...state, view: 'roster' }))
    focusLater(() => rosterRef.current?.querySelector(`[data-member="${CSS.escape(member.id)}"]`)?.focus())
  }
  const add = source => {
    update(state => {
      const added = addAgent(state.draft, source, { name: t('newMember'), copyName: name => t('copyName', { name }) })
      return { ...editConfig(state, added.config), selectedId: added.selectedId, view: 'member', open: { ...state.open, identity: true } }
    })
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
  const toggleSection = section => update(state => ({ ...state, open: { ...state.open, [section]: !state.open[section] } }))
  const allOpen = SECTIONS.every(section => editor.open[section])
  const memberIssueList = issues[member.id] || []

  return <div className="rp-team-members" data-view={editor.view === 'member' ? 'member' : 'roster'}>
    <div className="rp-team-roster rp-team-scroll" ref={rosterRef}>
      <div className="rp-team-publisher">
        <label htmlFor={`${conversationId}-publisher`}>{t('publisherQuestion')}</label>
        <select id={`${conversationId}-publisher`} value={config.output.agentId} onChange={event => changeConfig(draft => selectPublisher(draft, event.target.value))}>
          {config.agents.map(agent => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
        </select>
      </div>
      <ul className="rp-team-roster-list" aria-label={t('members')}>
        {config.agents.map(agent => {
          const list = issues[agent.id] || []
          const flag = list.some(issue => issue.level === 'error') ? 'error' : list.some(issue => REFERENCE_ISSUES.has(issue.code)) ? 'warn' : ''
          const flagText = flag === 'error' ? t('memberHasErrors') : t('memberHasMissing')
          return <li key={agent.id}>
            <button type="button" className="rp-team-roster-item" data-member={agent.id} aria-current={agent.id === member.id ? 'true' : undefined} onClick={() => select(agent.id)}>
              <span className="rp-team-roster-name">{agent.name}</span>
              {config.output.agentId === agent.id ? <span className="rp-team-tag">{t('publisherTag')}</span> : null}
              {flag ? <span className={`rp-team-roster-issue is-${flag}`} title={flagText}><Icon name="warn" /><span className="rp-team-sr">{flagText}</span></span> : null}
              <span className="rp-team-roster-meta">{rosterMeta(agent, config)}</span>
              <Icon name="chevron" className="rp-team-roster-chevron" />
            </button>
          </li>
        })}
      </ul>
      <button type="button" className="rp-team-add" onClick={() => add()}><Icon name="plus" />{t('addMember')}</button>
    </div>

    <div className="rp-team-sheet rp-team-scroll">
      <div className="rp-team-sheet-head">
        <button type="button" className="rp-team-back" onClick={back}><Icon name="back" />{t('backToMembers')}</button>
        <div className="rp-team-sheet-title">
          <h3 ref={headingRef} tabIndex={-1}>{member.name}</h3>
          {config.output.agentId === member.id ? <span className="rp-team-tag">{t('publisherTag')}</span> : null}
        </div>
        <p className="rp-team-sheet-desc">{member.description || t('noDescription')}</p>
        <div className="rp-team-sheet-actions">
          <button type="button" className="rp-team-quiet" onClick={() => update(state => ({ ...state, open: Object.fromEntries(SECTIONS.map(section => [section, !allOpen])) }))}>
            {allOpen ? t('collapseAll') : t('expandAll')}
          </button>
          <button type="button" className="rp-team-quiet" onClick={() => add(member)}>{t('duplicateMember')}</button>
          <ConfirmButton label={t('removeMember')} confirmLabel={t('confirmRemove')} disabled={config.agents.length === 1} onConfirm={remove} />
        </div>
      </div>
      <div className="rp-team-questions">
        {SECTIONS.map(section => {
          const Editor = SECTION_COMPONENTS[section]
          const open = Boolean(editor.open[section])
          return <Question key={section} section={section} open={open} onToggle={() => toggleSection(section)}
            summary={sectionSummary(section, member, config, options)} issues={memberIssueList.filter(issue => issue.section === section)}>
            {open ? <Editor key={member.id} conversationId={conversationId} member={member} config={config} options={options} edit={edit} json={json} changeConfig={changeConfig}
              setInvalid={(key, invalid) => update(state => { const next = { ...state.invalid }; if (invalid) next[`${member.id}:${key}`] = true; else for (const field of Object.keys(next)) if (field.startsWith(`${member.id}:${key}`)) delete next[field]; return { ...state, invalid: next } })} /> : null}
          </Question>
        })}
      </div>
    </div>
  </div>
}

function Question({ section, open, onToggle, summary, issues, children }) {
  const bodyId = React.useId()
  const level = issues.some(issue => issue.level === 'error') ? 'error' : issues.length ? 'warn' : ''
  return <section className={`rp-team-question ${open ? 'is-open' : ''}`}>
    <h4>
      <button type="button" aria-expanded={open} aria-controls={open ? bodyId : undefined} onClick={onToggle}>
        <Icon name="chevron" className="rp-team-q-chevron" />
        <span className="rp-team-q-title">{t(`section.${section}`)}</span>
        <span className="rp-team-q-summary">{summary}</span>
        {level ? <span className={`rp-team-q-issue is-${level}`}><Icon name="warn" /><span className="rp-team-sr">{issues.map(issue => t(`issue.${issue.code}`)).join(' ')}</span></span> : null}
      </button>
    </h4>
    {open ? <div id={bodyId} className="rp-team-q-body">
      {issues.length ? <ul className="rp-team-issues">{issues.map((issue, index) => <li key={`${issue.code}-${index}`} className={`is-${issue.level}`}>{t(`issue.${issue.code}`)}</li>)}</ul> : null}
      {children}
    </div> : null}
  </section>
}
