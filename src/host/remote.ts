import type { Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'

import type { ConfigInput, JsonValue, JsonObject, PresetDocumentDto, RetryIntentDto, RpAgentTeamApi, RunStatusDto, TeamConfig, TeamConfigDto, TeamOptionsDto, TeamStatusDto, TraceDetailDto, TraceSummaryDto } from './remote-types.js'
export type * from './remote-types.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    rpAgentTeam: RpAgentTeamApi
  }
}

/** Direct generated Remote adapter over the runtime's ordinary DTO methods. */
export class RpAgentTeamRemoteApi extends TypertRemoteService {
  static inject = ['typert', 'rpAgentTeam']
  private readonly api: RpAgentTeamApi

  constructor(ctx: Context) {
    super(ctx, 'rpTeamApi', { namespace: 'rpTeam' })
    this.api = ctx.rpAgentTeam
  }

  @Remote
  async previewParameters(input: JsonObject): Promise<JsonObject> {
    return this.api.previewParameters(input)
  }

  @Remote
  async listTrialScenarios(input: JsonObject): Promise<JsonObject> {
    return this.api.listTrialScenarios(input)
  }

  @Remote
  async getTrialScenario(input: JsonObject): Promise<JsonObject> {
    return this.api.getTrialScenario(input)
  }

  @Remote
  async saveTrialScenario(input: JsonObject): Promise<JsonObject> {
    return this.api.saveTrialScenario(input)
  }

  @Remote
  async deleteTrialScenario(input: JsonObject): Promise<JsonObject> {
    return this.api.deleteTrialScenario(input)
  }

  @Remote
  async exportTrialScenario(input: JsonObject): Promise<JsonObject> {
    return this.api.exportTrialScenario(input)
  }

  @Remote
  async importTrialScenario(input: JsonObject): Promise<JsonObject> {
    return this.api.importTrialScenario(input)
  }

  @Remote
  async freezeTrialSnapshot(input: JsonObject): Promise<JsonObject> {
    return this.api.freezeTrialSnapshot(input)
  }

  @Remote
  async startTrial(input: JsonObject): Promise<JsonObject> {
    return this.api.startTrial(input)
  }

  @Remote
  async listTrials(input: JsonObject): Promise<JsonObject> {
    return this.api.listTrials(input)
  }

  @Remote
  async getTrial(input: JsonObject): Promise<JsonObject> {
    return this.api.getTrial(input)
  }

  @Remote
  async cancelTrial(input: JsonObject): Promise<JsonObject> {
    return this.api.cancelTrial(input)
  }

  @Remote
  async retryTrial(input: JsonObject): Promise<JsonObject> {
    return this.api.retryTrial(input)
  }

  @Remote
  async getTrialTrajectory(input: JsonObject): Promise<JsonObject> {
    return this.api.getTrialTrajectory(input)
  }

  @Remote
  async compareTrial(input: JsonObject): Promise<JsonObject> {
    return this.api.compareTrial(input)
  }

  @Remote
  async getContextCatalog(input: JsonObject): Promise<JsonObject> {
    return this.api.getContextCatalog(input)
  }

  @Remote
  async previewConfig(input: JsonObject): Promise<JsonObject> {
    return this.api.previewConfig(input)
  }

  @Remote
  async getState(input: JsonObject): Promise<JsonObject> {
    return this.api.getState(input)
  }

  @Remote
  async listStateCheckpoints(input: JsonObject): Promise<JsonObject> {
    return this.api.listStateCheckpoints(input)
  }

  @Remote
  async applyStateEdit(input: JsonObject): Promise<JsonObject> {
    return this.api.applyStateEdit(input)
  }

  @Remote
  async getStateEditStatus(input: JsonObject): Promise<JsonObject> {
    return this.api.getStateEditStatus(input)
  }

  @Remote
  async restoreStateCheckpoint(input: JsonObject): Promise<JsonObject> {
    return this.api.restoreStateCheckpoint(input)
  }

  @Remote
  async listPresets(input: JsonObject): Promise<JsonObject> {
    return this.api.listPresets(input)
  }

  @Remote
  async getPreset(input: JsonObject): Promise<JsonObject> {
    return this.api.getPreset(input)
  }

  @Remote
  async savePreset(input: JsonObject): Promise<JsonObject> {
    return this.api.savePreset(input)
  }

  @Remote
  async copyPreset(input: JsonObject): Promise<JsonObject> {
    return this.api.copyPreset(input)
  }

  @Remote
  async deletePreset(input: JsonObject): Promise<JsonObject> {
    return this.api.deletePreset(input)
  }

  @Remote
  async exportPreset(input: JsonObject): Promise<JsonObject> {
    return this.api.exportPreset(input)
  }

  @Remote
  async importPreset(input: JsonObject): Promise<JsonObject> {
    return this.api.importPreset(input)
  }

  @Remote
  async exportComponent(input: JsonObject): Promise<JsonObject> {
    return this.api.exportComponent(input)
  }

  @Remote
  async prepareComponentImport(input: JsonObject): Promise<JsonObject> {
    return this.api.prepareComponentImport(input)
  }

  @Remote
  async getConfig(input: { conversationId: string }): Promise<TeamConfigDto> {
    return this.api.getConfig(input)
  }

  @Remote
  async saveConfig(input: ConfigInput): Promise<TeamConfigDto> {
    return this.api.saveConfig(input)
  }

  @Remote
  async getOptions(input: { conversationId: string }): Promise<TeamOptionsDto> {
    return this.api.getOptions(input)
  }

  @Remote
  async getStatus(input: { conversationId: string }): Promise<TeamStatusDto> {
    return this.api.getStatus(input)
  }

  @Remote
  async cancel(input: { conversationId: string; runId: string }): Promise<RunStatusDto> {
    return this.api.cancel(input)
  }

  @Remote
  async retry(input: { conversationId: string; runId: string; memberIds?: string[]; requestId: string }): Promise<RetryIntentDto> {
    return this.api.retry(input)
  }

  @Remote
  async discardRetry(input: { conversationId: string; runId: string; requestId: string }): Promise<{ discarded: boolean }> {
    return this.api.discardRetry(input)
  }

  @Remote
  async exportConfig(input: { conversationId: string }): Promise<PresetDocumentDto> {
    return this.api.exportConfig(input)
  }

  @Remote
  async setManualAgents(input: { conversationId: string; agentIds: string[] }): Promise<{ conversationId: string; manualAgentIds: string[] }> {
    return this.api.setManualAgents(input)
  }

  @Remote
  async listTraces(input: { conversationId: string }): Promise<TraceSummaryDto[]> {
    return this.api.listTraces(input)
  }

  @Remote
  async getTrace(input: { conversationId: string; runId: string }): Promise<TraceDetailDto> {
    return this.api.getTrace(input)
  }

  @Remote
  async importConfig(input: { conversationId: string; preset: JsonValue }): Promise<{ conversationId: string; config: TeamConfig }> {
    return this.api.importConfig(input)
  }
}
