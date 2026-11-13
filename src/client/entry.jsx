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
import { createTrajectoryNavigation } from './trajectory-navigation.js'
import { installTrajectory } from './trajectory-view.jsx'
import { authorViews } from './author-pages.jsx'
import { typedBuffers } from './typed-field.jsx'
import rpTeamRemote from '../../lib/typert.remote-client.js'

const LOCALES = __RP_TEAM_LOCALES__
const CSS_TEXT = __RP_TEAM_CSS__
const TRAJECTORY_CSS = '__RP_TEAM_TRAJECTORY_CSS__'
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
      node.textContent = CSS_TEXT + TRAJECTORY_CSS
      document.head.appendChild(node)
      return () => node.remove()
    }

    let trajectoryComponents
    function installClient(ctx) {
      services.sidebarRight = ctx.sidebarRight
      services.conversations = ctx.eleckoiConversations
      services.sessionIndex = createSessionConversationIndex(ctx.eleckoiConversations)
      services.trajectoryNavigation = createTrajectoryNavigation(services.sessionIndex)
      services.api = createClientApi(ctx.remote.rpTeam)
      services.store = createConversationStore(services.api, ctx.eleckoiConversations)
      ctx.effect(() => {
        let active = true
        let disposeTrajectory
        const source = createTrajectorySource({
          store: services.store, sessionIndex: services.sessionIndex, conversations: services.trajectoryNavigation,
          renderActions: (conversationId, runId) => <RunActions conversationId={conversationId} runId={runId} />,
        })
        const navigation = services.trajectoryNavigation
        // Page chunks are loaded after the client has activated. Waiting for
        // browser I/O inside apply leaves the plugin in "loading" at boot.
        void trajectoryComponents.then(components => {
          if (active) disposeTrajectory = installTrajectory(ctx, components, source, navigation)
        }).catch(error => console.error('RP Agent Team trajectory could not load', error))
        return () => { active = false; disposeTrajectory?.() }
      }, 'RP Agent Team native session trajectory')
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
      trajectoryComponents = require('@eleckoi/dsh-client-conversations').loadTrajectoryComponents()
        .then(components => ({ ...components, conversationRuntime: require('@deepseek-ai/dsh-client-ui-conversation') }))
      const disposeRemote = await ctx.remote.$mount(rpTeamRemote)
      const binding = ctx.inject(['remote.rpTeam'], installClient)
      return async () => {
        await binding.dispose()
        await disposeRemote()
      }
    }

    return { inject: ['slots', 'remote', 'eleckoiConversations', 'sidebarRight', 'sidebarRightTabs', 'sessions', 'uiConversation'], apply }
  }
})
