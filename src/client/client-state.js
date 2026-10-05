import { React } from './react.js'
import { createKeyedStore } from './keyed-store.js'

export const WORKSPACE_KIND = 'rp-team'
export const PAGES = ['config', 'team', 'preview', 'trial', 'state', 'library']

// Services are installed by entry.jsx and released on plugin disposal.
export const services = { api: null, store: null, sessionIndex: null, sidebarRight: null, conversations: null, trajectory: null }

// Per-conversation workspace navigation and editor drafts. Both survive tab close
// and chat switches; they are cleared only when the plugin is disposed.
export const workspaceUi = createKeyedStore(() => ({ page: 'config', runId: '' }))
export const drafts = createKeyedStore(() => null)
export const trialViews = createKeyedStore(() => ({ scenario: { name: '试演', steps: [{ id: crypto.randomUUID(), inputText: '', assertions: [] }] },
  scenarios: [], trials: [], presets: [], selectedId: '', secondPresetId: '', secondConfig: null, secondParameterValues: {}, trusted: false, includeSnapshot: false,
  budget: { maxRequests: 64, maxReportedTokens: 128000, maxElapsedMs: 600000 }, turnBudget: { maxRequests: 32, maxReportedTokens: 64000, maxElapsedMs: 180000 },
  busy: '', error: '', job: null, comparison: null, trajectory: null, invalid: {}, operationId: '' }))

export function resetClientState() {
  workspaceUi.clear()
  drafts.clear()
  trialViews.clear()
}

export function openWorkspace(sessionId, conversationId, page = 'config', runId = '') {
  if (page === 'run') return services.conversations.openTrajectory(conversationId, { runId })
  workspaceUi.update(conversationId, { page, runId })
  services.sidebarRight.openTabIn(sessionId, WORKSPACE_KIND, { params: { page, runId } })
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
