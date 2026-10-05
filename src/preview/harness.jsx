import React from 'react'
import { createRoot } from 'react-dom/client'
import { OPTIONS, historicalRuns, initialConversations, scenarioRun } from './fixtures.js'
import { authorFixtureMethods } from './author-fixtures.js'
import { v040FixtureMethods } from './v040-fixtures.js'

const SCENARIOS = ['none', 'working', 'awaiting_commit', 'complete', 'failed', 'cancelled']
const SCENARIO_LABELS = { none: '无运行', working: '活动', awaiting_commit: '等待提交', complete: '完成', failed: '失败', cancelled: '取消' }

async function bootstrap() {
  const query = new URLSearchParams(location.search)
  const language = query.get('lang') === 'en' ? 'en-US' : 'zh-CN'
  Object.defineProperty(navigator, 'language', { value: language, configurable: true })
  if (query.get('theme') === 'dark') document.documentElement.dataset.theme = 'dark'
  let registration
  window.__ModuleLoader__ = { load(value) { registration = value } }
  new Function(__RP_TEAM_BUNDLE__)()
  const plugin = registration.factory(name => { if (name === 'react') return React; throw new Error(`Unexpected module: ${name}`) })

  const conversations = initialConversations()
  const listeners = new Set()
  const slots = new Map()
  const calls = []
  const runs = {}
  const state = {
    conversationId: query.get('c') === '2' ? 'preview-c-2' : 'preview-c-1',
    open: Boolean(query.get('page')), mounted: Boolean(query.get('page')), files: false, revision: 1,
    params: query.get('page') ? { page: query.get('page'), runId: '' } : {},
    width: query.get('w') || 'normal', rejectRetry: false
  }
  const notify = () => { for (const listener of [...listeners]) listener() }
  const subscribe = listener => { listeners.add(listener); return () => listeners.delete(listener) }
  const setScenario = (conversationId, scenario) => {
    const config = conversations[conversationId].config
    runs[conversationId] = { scenario, live: scenarioRun(conversationId, config, scenario), history: historicalRuns(conversationId, config) }
  }
  for (const id of Object.keys(conversations)) setScenario(id, query.get('run') || 'none')
  const liveRun = id => runs[id].live?.run || null
  const allRuns = id => [...runs[id].history, ...(runs[id].live ? [runs[id].live] : [])]

  const methods = {
    ...authorFixtureMethods(conversations),
    ...v040FixtureMethods(),
    getConfig: p => ({ conversationId: p.conversationId, ...structuredClone(conversations[p.conversationId]) }),
    saveConfig(p) {
      const current = conversations[p.conversationId]
      if (p.expectedRevision !== current.revision) throw Object.assign(new Error(`Configuration revision is ${current.revision}, not ${p.expectedRevision}`), { code: 'RP_TEAM_CONFIG_CONFLICT' })
      Object.assign(current, { enabled: p.enabled, revision: current.revision + 1, config: structuredClone(p.config), parameterValues: structuredClone(p.parameterValues || current.parameterValues || {}) })
      return structuredClone({ conversationId: p.conversationId, enabled: current.enabled, revision: current.revision, config: current.config, parameterValues: current.parameterValues })
    },
    getOptions: p => ({ conversationId: p.conversationId, ...structuredClone(OPTIONS) }),
    getStatus: p => ({ conversationId: p.conversationId, binding: null, run: structuredClone(liveRun(p.conversationId)), manualAgentIds: conversations[p.conversationId].manualAgentIds }),
    listTraces: p => allRuns(p.conversationId).map(({ run }) => ({ runId: run.runId, phase: run.phase, startedAt: run.startedAt, productMessageId: run.productMessageId, assistantMessageId: run.assistantMessageId, outputAgentId: run.outputAgentId })),
    getTrace(p) {
      const found = allRuns(p.conversationId).find(item => item.run.runId === p.runId)
      if (!found) throw Object.assign(new Error(`Unknown RP Team run ${p.runId}`), { code: 'RP_TEAM_RUN_NOT_FOUND' })
      return structuredClone({ ...found.run, events: found.events })
    },
    setManualAgents(p) { conversations[p.conversationId].manualAgentIds = p.agentIds; return { conversationId: p.conversationId, manualAgentIds: p.agentIds } },
    exportConfig: p => ({ format: 'rp-team-preset-v2', dependencies: { presets: [], models: [], toolGroups: [] }, config: structuredClone(conversations[p.conversationId].config) }),
    cancel(p) {
      const run = liveRun(p.conversationId)
      run.phase = 'cancelled'
      run.failure = 'Cancelled from RP Team controls'
      run.retryAvailable = true
      for (const member of Object.values(run.members)) if (['running', 'queued'].includes(member.status)) member.status = 'cancelled'
      runs[p.conversationId].scenario = 'cancelled'
      return structuredClone(run)
    },
    retry: p => ({ accepted: true, sourceRunId: p.runId, requestId: p.requestId, targetEventSeq: 12, memberIds: p.memberIds }),
    discardRetry: () => ({ discarded: true })
  }
  const rpTeam = Object.fromEntries(Object.entries(methods).map(([name, method]) => [name, async p => {
    calls.push({ method: name, payload: structuredClone(p) })
    await new Promise(resolve => setTimeout(resolve, 60))
    try { return { ok: true, value: method(p) } } catch (error) { return { ok: false, error: { message: error.message, code: error.code } } }
  }]))
  const eleckoiConversations = {
    getTrajectoryNavigationSnapshot: () => state.trajectoryNavigation,
    subscribeTrajectoryNavigation: subscribe,
    async openTrajectory(conversationId, options) { state.trajectoryNavigation = { conversationId, ...options }; calls.push({ method: "openTrajectory", payload: state.trajectoryNavigation }); notify() },
    getSnapshot: () => ({ items: Object.keys(conversations).map(id => ({ id, runtimeSessionId: `s-${id}` })) }),
    getDetailsSnapshot: () => ({ id: state.conversationId, runtimeSessionId: `s-${state.conversationId}` }),
    subscribe, subscribeDetails: subscribe,
    async regenerate(payload) {
      calls.push({ method: 'regenerate', payload })
      if (state.rejectRetry) throw new Error('Product run admission rejected (fixture)')
      const config = conversations[payload.conversationId].config
      runs[payload.conversationId].history.push(runs[payload.conversationId].live)
      runs[payload.conversationId].live = scenarioRun(payload.conversationId, config, 'working', `${payload.conversationId}-run-retry-${calls.length}`)
      runs[payload.conversationId].live.run.retrySourceRunId = payload.requestId
      runs[payload.conversationId].scenario = 'working'
      notify()
      return { accepted: true }
    }
  }
  const ctx = {
    remote: { rpTeam, async $mount() { return async () => {} } },
    eleckoiConversations,
    eleckoiTrajectory: { registerSource(source) { state.trajectorySource = source; return () => { delete state.trajectorySource } } },
    sidebarRight: {
      openTabIn(sessionId, kind, options) {
        if (sessionId !== `s-${state.conversationId}` || kind !== 'rp-team') throw new Error('Wrong workspace target')
        Object.assign(state, { params: options.params, open: true, mounted: true, files: false, revision: state.revision + 1 })
        notify()
      }
    },
    sidebarRightTabs: { register: () => () => {} },
    effect(mount) { mount() }, inject(_services, mount) { mount(ctx); return { async dispose() {} } },
    slots: { inject(_name, mount) { return mount() }, register(options, component) { slots.set(options.name, component); return () => slots.delete(options.name) } }
  }
  await plugin.apply(ctx)

  function useTabInfo() {
    React.useSyncExternalStore(subscribe, () => state.revision)
    return { tab: { visible: state.open, navigation: { params: state.params, revision: state.revision }, actions: { close() { state.mounted = false; state.open = false; notify() } } } }
  }
  const sessionStatus = sessionId => new Map([[sessionId, { running: ['working', 'awaiting_commit'].includes(runs[state.conversationId].scenario) }]])

  function Toolbar() {
    const id = state.conversationId
    const button = (label, action, pressed) => <button type="button" aria-pressed={pressed} onClick={() => { action(); notify() }}>{label}</button>
    return <div className="fixture-toolbar" aria-label="Fixture controls">
      <span>夹具</span>
      {button('聊天 A', () => { state.conversationId = 'preview-c-1' }, id === 'preview-c-1')}
      {button('聊天 B', () => { state.conversationId = 'preview-c-2' }, id === 'preview-c-2')}
      <span className="fixture-sep" />
      {SCENARIOS.map(scenario => <React.Fragment key={scenario}>{button(SCENARIO_LABELS[scenario], () => setScenario(id, scenario), runs[id].scenario === scenario)}</React.Fragment>)}
      <span className="fixture-sep" />
      {button('模拟别处保存', () => { const current = conversations[id]; current.revision += 1; current.config = { ...current.config, name: `${current.config.name}（别处修改）` } })}
      {button(state.rejectRetry ? '重试将被拒绝' : '重试将被接受', () => { state.rejectRetry = !state.rejectRetry }, state.rejectRetry)}
      {button('深色', () => { document.documentElement.dataset.theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark' }, document.documentElement.dataset.theme === 'dark')}
      {['narrow', 'normal', 'wide'].map(width => <React.Fragment key={width}>{button({ narrow: '窄', normal: '中', wide: '宽' }[width], () => { state.width = width }, state.width === width)}</React.Fragment>)}
    </div>
  }

  function Preview() {
    React.useSyncExternalStore(subscribe, () => `${state.conversationId}:${state.open}:${state.mounted}:${state.revision}:${state.files}:${state.width}:${state.rejectRetry}:${runs[state.conversationId].scenario}:${document.documentElement.dataset.theme}`)
    const [draft, setDraft] = React.useState('雨还没有停。')
    const Toggle = slots.get('eleckoi.roleplay.conversation.input.left')
    const Status = slots.get('eleckoi.roleplay.conversation.composer.dock')
    const After = slots.get('eleckoi.roleplay.message.after')
    const Workspace = slots.get('sidebar.right.pane.tab')
    const sessionId = `s-${state.conversationId}`
    const owner = { sessionId, useSessionStatus: select => select(sessionStatus(sessionId)), useTabInfo }
    const config = conversations[state.conversationId].config
    return <main className={`fixture width-${state.width} ${state.open ? '' : 'closed'}`}>
      <Toolbar />
      <article className="fixture-chat">
        <header><small>RP Team · 离线 UI 夹具 · 不调用模型</small><h1>{state.conversationId === 'preview-c-1' ? '那封尚未拆开的信' : '雨夜的门'}</h1></header>
        <div className="fixture-messages">
          <div className="fixture-message is-user">门外有人敲了三下。</div>
          <div className="fixture-message is-assistant">她把手停在柜门上，仍然相信那封信就藏在里面。
            {After ? <After sessionId={sessionId} conversationId={state.conversationId} productMessageId="msg-assistant-0" messageId={null} role="assistant" /> : null}</div>
          <div className="fixture-message is-user">开门。</div>
          <div className="fixture-message is-assistant">她没有立刻开门。雨声里，门外那人的呼吸很轻。
            {After ? <After sessionId={sessionId} conversationId={state.conversationId} productMessageId="msg-assistant-1" messageId="native-assistant-1" role="assistant" /> : null}</div>
        </div>
        <div className="fixture-composer chat-composer-region">
          <textarea aria-label="输入消息" value={draft} onChange={event => setDraft(event.target.value)} />
          <div className="fixture-composer-bar">
            {Toggle ? <Toggle key={state.conversationId} {...owner} /> : null}
            <span className="fixture-spacer" />
            <button type="button" className="fixture-native">模型</button>
            <button type="button" className="fixture-send" aria-label="发送">↑</button>
          </div>
          <div className="fixture-dock">
            <button type="button" className="fixture-native">3 轮 12 步</button>
            {Status ? <Status key={state.conversationId} {...owner} /> : null}
          </div>
        </div>
        <small className="fixture-config">当前聊天配置：{config.name} · {config.agents.length} 名成员</small>
      </article>
      {state.open ? <aside className="fixture-sidebar">
        <div className="fixture-tabs" role="tablist">
          <button type="button" role="tab" aria-selected={!state.files} onClick={() => { state.files = false; state.mounted = true; notify() }}>角色团队{state.mounted ? '' : '（已关闭）'}</button>
          <button type="button" role="tab" aria-selected={state.files} onClick={() => { state.files = true; notify() }}>文件</button>
          <span className="fixture-spacer" />
          <button type="button" onClick={() => { state.mounted = false; state.files = true; notify() }}>关闭团队页签</button>
          <button type="button" onClick={() => { state.open = false; notify() }}>收起</button>
        </div>
        <div className="fixture-pane">
          {state.mounted && Workspace ? <div hidden={state.files} style={{ height: '100%' }}><Workspace {...owner} /></div> : null}
          {state.files ? <div className="fixture-files">官方文件页签（夹具占位）</div> : null}
        </div>
      </aside> : null}
    </main>
  }
  createRoot(document.getElementById('app')).render(<Preview />)
  window.__rpTeamPreview = { calls, conversations, runs, state, notify, setScenario: (scenario, id = state.conversationId) => { setScenario(id, scenario); notify() } }
}
void bootstrap()
