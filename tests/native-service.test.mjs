import test from 'node:test'
import assert from 'node:assert/strict'
import nativeAgentTeamService from '@deepseek-ai/dsh-experimental-agent-team'
import { apply, installNativeAgentTeamService, NATIVE_TEAM_MAX_MEMBERS } from '../src/host/native-service.mjs'

test('reuses an existing native agentTeams service without installing a second copy', async () => {
  const service = { name: 'already-installed' }
  let pluginCalls = 0
  const ctx = {
    get(name) {
      assert.equal(name, 'agentTeams')
      return service
    },
    plugin() { pluginCalls += 1 }
  }

  assert.equal(await installNativeAgentTeamService(ctx), undefined)
  assert.equal(pluginCalls, 0)
})

test('installs and awaits the pinned native Team service only when the service is absent', async () => {
  let finishInstallation
  let installed
  let installedConfig
  const ctx = {
    get(name) {
      assert.equal(name, 'agentTeams')
      return undefined
    },
    plugin(service, config) {
      installed = service
      installedConfig = config
      return new Promise(resolve => { finishInstallation = resolve })
    }
  }

  const applying = installNativeAgentTeamService(ctx)
  assert.equal(installed, nativeAgentTeamService)
  assert.deepEqual(installedConfig, { maxMembers: NATIVE_TEAM_MAX_MEMBERS })
  assert.equal(NATIVE_TEAM_MAX_MEMBERS, Number.MAX_SAFE_INTEGER)
  let settled = false
  applying.then(() => { settled = true })
  await Promise.resolve()
  assert.equal(settled, false, 'the wrapper must not finish before the child Fiber settles')
  finishInstallation()
  assert.equal(await applying, undefined, 'the child Fiber is awaited but not returned as a disposer')
})

test('bootstraps the single packaged entry by activating the team service before the runtime child', async () => {
  const installed = []
  const ctx = {
    get() { return undefined },
    plugin(plugin, config) {
      installed.push({ plugin, config })
      return Promise.resolve()
    }
  }

  assert.equal(await apply(ctx), undefined)
  assert.equal(installed[0].plugin, nativeAgentTeamService)
  assert.deepEqual(installed[0].config, { maxMembers: NATIVE_TEAM_MAX_MEMBERS })
  assert.equal(installed[1].plugin.name, 'rp-agent-team')
  assert.deepEqual(installed[1].plugin.inject, [
    'agents', 'agentPresets', 'agentTeams', 'eleckoiRuntimeExtensions',
    'eleckoiStoryState', 'eleckoiConversationChanges', 'eleckoiTrialSnapshots', 'credentials', 'llm', 'sessions', 'subagents', 'tools'
  ])
})
