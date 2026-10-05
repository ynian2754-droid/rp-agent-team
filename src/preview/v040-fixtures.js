import { resolveAuthorParameters } from '../shared/author-parameters.mjs'

/** UI fixtures only. Real worker isolation and execution are accepted separately. */
export function v040FixtureMethods() {
  const scenarios = new Map()
  return {
    previewParameters: ({ config, parameterValues }) => resolveAuthorParameters(config, parameterValues),
    listTrialScenarios: () => ({ scenarios: [...scenarios.values()] }),
    getTrialScenario: ({ scenarioId }) => ({ scenario: scenarios.get(scenarioId) }),
    saveTrialScenario: ({ scenario }) => { const next = { ...scenario, id: scenario.id || crypto.randomUUID() }; scenarios.set(next.id, next); return { scenario: next } },
    deleteTrialScenario: ({ scenarioId }) => ({ deleted: scenarios.delete(scenarioId) }),
    listTrials: () => ({ trials: [] }),
    freezeTrialSnapshot: () => ({ snapshotId: 'ui-snapshot', summary: { characterName: '界面样例', turnCount: 0, attachmentCount: 0 } }),
    startTrial: () => { throw Object.assign(new Error('界面样例不运行模型；实际试演需在 ElecKoi 中主动启动。'), { code: 'RP_TEAM_TRIAL_FIXTURE_ONLY' }) },
    exportTrialScenario: ({ scenarioId }) => ({ format: 'rp-team-trial-scenario', version: 1, scenario: scenarios.get(scenarioId) }),
    importTrialScenario: ({ export: document }) => { const next = { ...document.scenario, id: crypto.randomUUID() }; scenarios.set(next.id, next); return { scenario: next } },
  }
}
