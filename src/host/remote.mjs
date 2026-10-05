import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'

/** Host runtime adapter for the generated `rpTeam` Remote contract. */
export class RpAgentTeamRemoteApi extends TypertRemoteService {
  static inject = ['typert', 'rpAgentTeam']

  constructor(ctx) {
    super(ctx, 'rpTeamApi', { namespace: 'rpTeam' })
    this.api = ctx.rpAgentTeam
  }

  async previewParameters(input) { return this.api.previewParameters(input) }
  async listTrialScenarios(input) { return this.api.listTrialScenarios(input) }
  async getTrialScenario(input) { return this.api.getTrialScenario(input) }
  async saveTrialScenario(input) { return this.api.saveTrialScenario(input) }
  async deleteTrialScenario(input) { return this.api.deleteTrialScenario(input) }
  async exportTrialScenario(input) { return this.api.exportTrialScenario(input) }
  async importTrialScenario(input) { return this.api.importTrialScenario(input) }
  async freezeTrialSnapshot(input) { return this.api.freezeTrialSnapshot(input) }
  async startTrial(input) { return this.api.startTrial(input) }
  async listTrials(input) { return this.api.listTrials(input) }
  async getTrial(input) { return this.api.getTrial(input) }
  async cancelTrial(input) { return this.api.cancelTrial(input) }
  async retryTrial(input) { return this.api.retryTrial(input) }
  async getTrialTrajectory(input) { return this.api.getTrialTrajectory(input) }
  async compareTrial(input) { return this.api.compareTrial(input) }
  async getContextCatalog(input) { return this.api.getContextCatalog(input) }
  async previewConfig(input) { return this.api.previewConfig(input) }
  async getState(input) { return this.api.getState(input) }
  async listStateCheckpoints(input) { return this.api.listStateCheckpoints(input) }
  async applyStateEdit(input) { return this.api.applyStateEdit(input) }
  async getStateEditStatus(input) { return this.api.getStateEditStatus(input) }
  async restoreStateCheckpoint(input) { return this.api.restoreStateCheckpoint(input) }
  async listPresets(input) { return this.api.listPresets(input) }
  async getPreset(input) { return this.api.getPreset(input) }
  async savePreset(input) { return this.api.savePreset(input) }
  async copyPreset(input) { return this.api.copyPreset(input) }
  async deletePreset(input) { return this.api.deletePreset(input) }
  async exportPreset(input) { return this.api.exportPreset(input) }
  async importPreset(input) { return this.api.importPreset(input) }
  async exportComponent(input) { return this.api.exportComponent(input) }
  async prepareComponentImport(input) { return this.api.prepareComponentImport(input) }
  async getConfig(input) { return this.api.getConfig(input) }
  async saveConfig(input) { return this.api.saveConfig(input) }
  async getOptions(input) { return this.api.getOptions(input) }
  async getStatus(input) { return this.api.getStatus(input) }
  async cancel(input) { return this.api.cancel(input) }
  async retry(input) { return this.api.retry(input) }
  async discardRetry(input) { return this.api.discardRetry(input) }
  async exportConfig(input) { return this.api.exportConfig(input) }
  async setManualAgents(input) { return this.api.setManualAgents(input) }
  async listTraces(input) { return this.api.listTraces(input) }
  async getTrace(input) { return this.api.getTrace(input) }
  async importConfig(input) { return this.api.importConfig(input) }
}

// Apply the official decorator at module initialization so source-mode tests
// and packaged Host imports register the same protocol markers as the TS face.
for (const name of Object.getOwnPropertyNames(RpAgentTeamRemoteApi.prototype).filter(name => name !== 'constructor')) {
  const initializers = []
  Remote(RpAgentTeamRemoteApi.prototype[name], {
    kind: 'method', name, private: false, static: false,
    addInitializer(initializer) { initializers.push(initializer) }
  })
  const instance = Object.create(RpAgentTeamRemoteApi.prototype)
  for (const initializer of initializers) initializer.call(instance)
}
