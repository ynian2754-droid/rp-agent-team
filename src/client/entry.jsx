import { createClientApi } from './api.js'
import { React, bindHostReact } from './react.js'
import { setLocale, t } from './i18n.js'
import { createConversationStore } from './store.js'
import { createSessionConversationIndex } from './session-binding.js'
import { services, resetClientState, WORKSPACE_KIND } from './client-state.js'
import { MessageTraceLink, TeamStatusLine, TeamToggle } from './composer.jsx'
import { WorkspaceTab } from './workspace.jsx'
import { createTrajectorySource } from './trajectory-source.js'
import { RunActions } from './run-actions.jsx'
import { authorViews } from './author-pages.jsx'
import { typedBuffers } from './typed-field.jsx'
import rpTeamRemote from '../../lib/typert.remote-client.js'

const LOCALES = __RP_TEAM_LOCALES__
const CSS_TEXT = __RP_TEAM_CSS__
const PACKAGE_ID = '@rp-team/dsh-roleplay-team'

window.__ModuleLoader__.load({
  id: PACKAGE_ID,
  factory(require) {
    bindHostReact(require('react'))
    setLocale(LOCALES, navigator.language || '')

    function installStyles() {
      if (document.getElementById('rp-agent-team-styles')) return () => {}
      const node = document.createElement('style')
      node.id = 'rp-agent-team-styles'
      node.textContent = CSS_TEXT
      document.head.appendChild(node)
      return () => node.remove()
    }

    function installClient(ctx) {
      services.sidebarRight = ctx.sidebarRight
      services.conversations = ctx.eleckoiConversations
      services.trajectory = ctx.eleckoiTrajectory
      services.sessionIndex = createSessionConversationIndex(ctx.eleckoiConversations)
      services.api = createClientApi(ctx.remote.rpTeam)
      services.store = createConversationStore(services.api, ctx.eleckoiConversations)
      ctx.effect(() => ctx.eleckoiTrajectory.registerSource(createTrajectorySource({
        store: services.store, sessionIndex: services.sessionIndex, conversations: ctx.eleckoiConversations,
        renderActions: (conversationId, runId) => <RunActions conversationId={conversationId} runId={runId} />,
      })), 'RP Agent Team main trajectory source')
      ctx.effect(() => installStyles(), 'RP Agent Team client styles')
      ctx.effect(() => () => {
        services.store.dispose()
        services.sessionIndex.clear()
        resetClientState()
        authorViews.clear()
        typedBuffers.clear()
      }, 'RP Agent Team client state')
      ctx.effect(() => ctx.sidebarRightTabs.register({
        id: PACKAGE_ID, kind: WORKSPACE_KIND, keepMounted: true,
        title: () => t('team'),
        guide: [{ id: 'rp-team', order: 30, title: () => t('team'), description: () => t('settingsTitle') }]
      }), 'RP Agent Team workspace tab')
      const register = (name, id, Component, order = 0) => ctx.slots.inject(name, () => ctx.slots.register({
        name,
        id,
        order,
        registrant: PACKAGE_ID
      }, owner => <Component {...owner} />))

      register('eleckoi.roleplay.conversation.input.left', 'rp-agent-team-toggle', TeamToggle, -20)
      register('eleckoi.roleplay.conversation.composer.dock', 'rp-agent-team-status', TeamStatusLine, 20)
      register('eleckoi.roleplay.message.after', 'rp-agent-team-result', MessageTraceLink, 20)
      ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
        name: 'sidebar.right.pane.tab', key: PACKAGE_ID, registrant: PACKAGE_ID
      }, WorkspaceTab))
    }

    async function apply(ctx) {
      const disposeRemote = await ctx.remote.$mount(rpTeamRemote)
      const binding = ctx.inject(['remote.rpTeam'], installClient)
      return async () => {
        await binding.dispose()
        await disposeRemote()
      }
    }

    return { inject: ['slots', 'remote', 'eleckoiConversations', 'sidebarRight', 'sidebarRightTabs', 'eleckoiTrajectory'], apply }
  }
})
