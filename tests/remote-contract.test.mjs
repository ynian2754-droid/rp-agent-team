import test from 'node:test'
import assert from 'node:assert/strict'
import typertRemote from '../lib/typert.remote-client.js'

function descriptor(method) {
  const matches = typertRemote.descriptors.filter(item => item.namespace === 'rpTeam' && item.method === method)
  assert.equal(matches.length, 1, `expected one generated rpTeam/${method} descriptor`)
  return matches[0]
}

test('generated Remote contract exposes all runtime methods under rpTeam', () => {
  const methods = typertRemote.descriptors.map(item => item.method).sort()
  assert.deepEqual(methods, [
    'cancel', 'discardRetry', 'exportConfig', 'getConfig', 'getOptions', 'getStatus',
    'getTrace', 'importConfig', 'listTraces', 'retry', 'saveConfig', 'setManualAgents',
    'getContextCatalog', 'previewConfig', 'getState', 'listStateCheckpoints',
    'applyStateEdit', 'getStateEditStatus', 'restoreStateCheckpoint',
    'listPresets', 'getPreset', 'savePreset', 'copyPreset', 'deletePreset',
    'exportPreset', 'importPreset', 'exportComponent', 'prepareComponentImport',
    'previewParameters', 'listTrialScenarios', 'getTrialScenario', 'saveTrialScenario', 'deleteTrialScenario',
    'exportTrialScenario', 'importTrialScenario', 'freezeTrialSnapshot', 'startTrial', 'listTrials', 'getTrial',
    'cancelTrial', 'retryTrial', 'getTrialTrajectory', 'compareTrial'
  ].sort())
  assert.ok(typertRemote.descriptors.every(item => item.service === 'rpTeamApi' && item.namespace === 'rpTeam'))
})

test('generated Remote codecs accept an idle status and current options DTO', () => {
  const status = {
    conversationId: 'conversation-1', binding: null, run: null, manualAgentIds: []
  }
  assert.deepEqual(descriptor('getStatus').result.create().parse(status), status)

  const options = {
    conversationId: 'conversation-1', revision: 3,
    providers: [{
      id: 'provider', name: 'Provider', models: [{
        id: 'model', name: 'Model', description: 'Local test model', inputModalities: ['text'],
        reasoning: { efforts: [{ id: 'low', name: 'Low' }], defaultEffort: 'low' },
        parameters: { temperature: true, topP: true, maxTokens: true, reasoningEffort: true },
        context: { maxInputTokens: 8192 }
      }]
    }],
    presets: [{ id: 'preset', name: 'Preset' }],
    capabilities: [{ id: 'managed:read', label: 'Read', groupId: 'managed', enabledByDefault: true, requiresTrust: false }]
  }
  assert.deepEqual(descriptor('getOptions').result.create().parse(options), options)
})

test('generated Remote codecs preserve assistant event identity on run status and trace summaries', () => {
  const run = {
    runId: 'run-1', conversationId: 'conversation-1', phase: 'awaiting_commit',
    startedAt: '2026-10-03T12:00:00.000Z', createdAt: '2026-10-03T12:00:00.000Z',
    updatedAt: '2026-10-03T12:00:01.000Z', outputAgentId: 'actor', members: {},
    publication: null, retryAvailable: false, productCommitStaged: true,
    productMessageId: 'assistant-message-22', assistantMessageId: 'assistant-message-22', assistantSeq: 22
  }
  const status = {
    conversationId: 'conversation-1', binding: null, run, manualAgentIds: []
  }
  assert.deepEqual(descriptor('getStatus').result.create().parse(status), status)

  const summary = {
    runId: 'run-1', startedAt: run.startedAt, phase: 'awaiting_commit',
    productMessageId: 'assistant-message-22', assistantMessageId: 'assistant-message-22', assistantSeq: 22,
    productCommitStaged: true
  }
  assert.deepEqual(descriptor('listTraces').result.create().parse([summary]), [summary])

  const unstaged = { ...run, phase: 'failed', publication: null, retryAvailable: true, productCommitStaged: false }
  delete unstaged.productMessageId
  delete unstaged.assistantMessageId
  delete unstaged.assistantSeq
  const failedStatus = { conversationId: 'conversation-1', binding: null, run: unstaged, manualAgentIds: [] }
  assert.deepEqual(descriptor('getStatus').result.create().parse(failedStatus), failedStatus)
})

test('generated retry result carries the durable user event sequence', () => {
  const intent = {
    accepted: true, sourceRunId: 'run-1', requestId: 'request-1', targetEventSeq: 19,
    targetMessageId: 'message-user-19', memberIds: ['observer']
  }
  assert.deepEqual(descriptor('retry').result.create().parse(intent), intent)
})

test('author state and component contracts preserve dynamic values without losing null or missing identity', () => {
  const state = { conversationId: 'c', revision: 3, worldHash: 'hash', anchor: { sessionId: 's', turn: 2, eventSeq: 8 }, busy: false,
    values: [{ namespace: 'private:actor', path: '/belief', missing: false, value: { confidence: 0, known: false, assumption: null }, staged: true, stagedValue: ['uncertain'] }], definitions: [], pendingEdits: [] }
  assert.deepEqual(descriptor('getState').result.create().parse(state), state)
  const prepared = { ports: [{ id: 'state:1', kind: 'state' }], conflicts: [], changes: [], issues: [], agentIdMap: { old: 'new' }, config: { state: { definitions: [{ namespace: 'shared', path: '/belief', default: null }] } } }
  assert.deepEqual(descriptor('prepareComponentImport').result.create().parse(prepared), prepared)
})
