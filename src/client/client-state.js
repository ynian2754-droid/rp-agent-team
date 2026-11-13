import { React } from './react.js'
import { createKeyedStore } from './keyed-store.js'
import { t } from './i18n.js'

export const WORKSPACE_KIND = 'rp-team'
/** One page per task: what just happened, who is on the team, where presets come from, trying it out, what is stored. */
export const PAGES = ['run', 'team', 'presets', 'trial', 'state']
export const TEAM_VIEWS = ['members', 'params', 'settings']
export const TRIAL_VIEWS = ['check', 'trial']
// Page names used by navigation requests from before the pages were regrouped.
const PAGE_ALIASES = { config: ['team', { teamView: 'members' }], preview: ['trial', { trialView: 'check' }], library: ['presets', {}] }

/** Resolves a requested page to a current page plus the sub-view it implies. */
export function resolvePage(page) {
  if (PAGES.includes(page)) return [page, {}]
  return PAGE_ALIASES[page] || ['run', {}]
}

// Services are installed by entry.jsx and released on plugin disposal.
export const services = { api: null, store: null, sessionIndex: null, sidebarRight: null, conversations: null, trajectory: null, trajectoryNavigation: null }

// Per-conversation workspace navigation and editor drafts. Both survive tab close
// and chat switches; they are cleared only when the plugin is disposed.
export const workspaceUi = createKeyedStore(() => ({ page: 'run', runId: '', teamView: 'members', trialView: 'check', memberTab: 'prompt' }))
export const drafts = createKeyedStore(() => null)
export const trialViews = createKeyedStore(() => ({ scenario: { name: t('trial.new'), steps: [{ id: crypto.randomUUID(), inputText: '', assertions: [] }] },
  scenarios: [], trials: [], presets: [], selectedId: '', secondPresetId: '', secondConfig: null, secondParameterValues: {}, trusted: false, includeSnapshot: false,
  budget: { maxRequests: 64, maxReportedTokens: 128000, maxElapsedMs: 600000 }, turnBudget: { maxRequests: 32, maxReportedTokens: 64000, maxElapsedMs: 180000 },
  busy: '', error: '', job: null, comparison: null, trajectory: null, invalid: {}, operationId: '' }))

export function resetClientState() {
  workspaceUi.clear()
  drafts.clear()
  trialViews.clear()
}

/**
 * Opens the team tab beside the chat. Without a page the tab returns to where the
 * author left it; `run` shows the overview of a round before any ledger detail.
 */
export function openWorkspace(sessionId, conversationId, page, runId = '') {
  const params = page ? { page, runId } : {}
  if (page) {
    const [resolved, extra] = resolvePage(page)
    workspaceUi.update(conversationId, { page: resolved, ...extra, ...(resolved === 'run' ? { runId } : {}) })
  }
  services.sidebarRight.openTabIn(sessionId, WORKSPACE_KIND, { params })
}

/** Jumps to the native ledger, focused on a run or one of its records. Throws when the chat view is not mounted. */
export function openTrajectory(conversationId, runId = '', recordId) {
  return services.trajectoryNavigation.open(conversationId, { runId, ...(recordId ? { recordId } : {}) })
}

export function useProductConversation(sessionId) {
  const { sessionIndex } = services
  return React.useSyncExternalStore(sessionIndex.subscribe, () => sessionIndex.get(sessionId), () => '')
}

export function useConversation(conversationId) {
  const { store } = services
  const id = conversationId || ''
  return React.useSyncExternalStore(listener => store.subscribe(id, listener), () => store.getSnapshot(id), () => store.getSnapshot(id))
}

export function useKeyed(keyed, key) {
  return React.useSyncExternalStore(listener => keyed.subscribe(key, listener), () => keyed.get(key), () => keyed.get(key))
}
