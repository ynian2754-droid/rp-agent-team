export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }
export interface JsonObject { [key: string]: JsonValue }

export interface TeamConfig extends JsonObject {
  schemaVersion: number
  id: string
  name: string
  version: string
  metadata: JsonObject
  agents: JsonObject[]
  state: JsonObject
  execution: JsonObject
  output: JsonObject
}

export interface TeamConfigDto {
  parameterValues?: JsonObject
  conversationId: string
  enabled: boolean
  revision: number
  config: TeamConfig
}

export interface ConfigInput {
  parameterValues?: JsonObject
  conversationId: string
  expectedRevision: number
  enabled: boolean
  config: TeamConfig
}

export interface ModelOption {
  id: string
  name: string
  description?: string
  inputModalities?: string[]
  reasoning: {
    efforts: Array<{ id: string; name: string; description?: string }>
    defaultEffort?: string
  }
  parameters: { temperature: boolean; topP: boolean; maxTokens: boolean; reasoningEffort: boolean }
  context?: JsonObject
}

export interface TeamOptionsDto {
  conversationId: string
  revision: number
  providers: Array<{ id: string; name: string; models: ModelOption[] }>
  presets: Array<{ id: string; name: string; description?: string; broken?: string | boolean }>
  capabilities: Array<{ id: string; label: string; groupId: string; enabledByDefault: boolean; requiresTrust: boolean }>
}

export type RunPhase = 'preparing' | 'working' | 'composing' | 'publishing' | 'awaiting_commit' | 'failed' | 'cancelled' | 'complete'
export type MemberPhase = 'pending' | 'queued' | 'running' | 'complete' | 'failed' | 'cancelled' | 'skipped'

export interface MemberStatusDto {
  id: string
  name: string
  status: MemberPhase
  result: JsonValue
  error?: string
  model?: { provider?: string; model?: string }
  tokens?: { inputTokens?: number; outputTokens?: number; totalTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number; uncachedInputTokens?: number }
  activations?: number
  reusedFromRunId?: string
}

export interface PublicationDto {
  runId: string
  agentId: string
  body: string
  status: string
  operationCount: number
  selectedDraftIds: string[]
  stagedAt: string
}

export interface RunStatusDto {
  budget?: JsonObject
  inputMessageId?: string
  runId: string
  conversationId: string
  phase: RunPhase
  startedAt: string
  createdAt: string
  updatedAt: string
  outputAgentId: string
  members: Record<string, MemberStatusDto>
  publication: PublicationDto | null
  retrySourceRunId?: string
  productMessageId?: string
  assistantMessageId?: string
  assistantSeq?: number
  productCommitStaged?: boolean
  failure?: string
  retryAvailable: boolean
}

export interface TeamStatusDto {
  conversationId: string
  binding: null | {
    conversationId: string
    rootSessionId: string
    enabled: boolean
    configRevision: number
    currentConfigRevision: number
    stale: boolean
  }
  run: RunStatusDto | null
  manualAgentIds: string[]
}

export interface TraceEventDto {
  seq: number
  type: string
  agentId?: string
  at: string
  data: JsonObject
}

export interface ExecutionSessionDto {
  executionId: string
  agentId: string
  activation: number | null
  sessionId: string
  parentSessionId?: string
  depth?: number
  scheduled: boolean
  startedAt?: string
  endedAt?: string
  status: string
  endEventSeq?: number
  associationIncomplete?: boolean
}

export interface TraceSummaryDto {
  rootSessionId?: string
  turn?: number
  inputEventSeq?: number
  inputMessageId?: string
  rewound?: boolean
  retrySourceRunId?: string
  runId: string
  phase?: RunPhase
  startedAt: string
  productMessageId?: string
  outputAgentId?: string
  assistantMessageId?: string
  assistantSeq?: number
  productCommitStaged?: boolean
}

export interface TraceDetailDto extends RunStatusDto {
  rootSessionId?: string
  turn?: number
  inputEventSeq?: number
  inputMessageId?: string
  configuration?: TeamConfig
  localDeliveryAssistantSeq?: number
  localDeliveryRequestSeq?: number
  executionSessions: ExecutionSessionDto[]
  rewound?: boolean
  events: TraceEventDto[]
}

export interface PresetDocumentDto {
  format: 'rp-team-preset-v2'
  dependencies: {
    presets: string[]
    models: Array<{ provider: string; model: string }>
    toolGroups: string[]
  }
  config: TeamConfig
}

export interface RetryIntentDto {
  accepted: true
  sourceRunId: string
  requestId: string
  targetEventSeq: number
  targetMessageId?: string
  memberIds: string[]
}

export interface RpAgentTeamApi {
  previewParameters(input: JsonObject): JsonObject | Promise<JsonObject>
  listTrialScenarios(input: JsonObject): JsonObject | Promise<JsonObject>
  getTrialScenario(input: JsonObject): JsonObject | Promise<JsonObject>
  saveTrialScenario(input: JsonObject): JsonObject | Promise<JsonObject>
  deleteTrialScenario(input: JsonObject): JsonObject | Promise<JsonObject>
  exportTrialScenario(input: JsonObject): JsonObject | Promise<JsonObject>
  importTrialScenario(input: JsonObject): JsonObject | Promise<JsonObject>
  freezeTrialSnapshot(input: JsonObject): JsonObject | Promise<JsonObject>
  startTrial(input: JsonObject): JsonObject | Promise<JsonObject>
  listTrials(input: JsonObject): JsonObject | Promise<JsonObject>
  getTrial(input: JsonObject): JsonObject | Promise<JsonObject>
  cancelTrial(input: JsonObject): JsonObject | Promise<JsonObject>
  retryTrial(input: JsonObject): JsonObject | Promise<JsonObject>
  getTrialTrajectory(input: JsonObject): JsonObject | Promise<JsonObject>
  compareTrial(input: JsonObject): JsonObject | Promise<JsonObject>
  getContextCatalog(input: JsonObject): JsonObject | Promise<JsonObject>
  previewConfig(input: JsonObject): JsonObject | Promise<JsonObject>
  getState(input: JsonObject): JsonObject | Promise<JsonObject>
  listStateCheckpoints(input: JsonObject): JsonObject | Promise<JsonObject>
  applyStateEdit(input: JsonObject): JsonObject | Promise<JsonObject>
  getStateEditStatus(input: JsonObject): JsonObject | Promise<JsonObject>
  restoreStateCheckpoint(input: JsonObject): JsonObject | Promise<JsonObject>
  listPresets(input: JsonObject): JsonObject | Promise<JsonObject>
  getPreset(input: JsonObject): JsonObject | Promise<JsonObject>
  savePreset(input: JsonObject): JsonObject | Promise<JsonObject>
  copyPreset(input: JsonObject): JsonObject | Promise<JsonObject>
  deletePreset(input: JsonObject): JsonObject | Promise<JsonObject>
  exportPreset(input: JsonObject): JsonObject | Promise<JsonObject>
  importPreset(input: JsonObject): JsonObject | Promise<JsonObject>
  exportComponent(input: JsonObject): JsonObject | Promise<JsonObject>
  prepareComponentImport(input: JsonObject): JsonObject | Promise<JsonObject>
  getConfig(input: { conversationId: string }): TeamConfigDto | Promise<TeamConfigDto>
  saveConfig(input: ConfigInput): TeamConfigDto | Promise<TeamConfigDto>
  getOptions(input: { conversationId: string }): TeamOptionsDto | Promise<TeamOptionsDto>
  getStatus(input: { conversationId: string }): TeamStatusDto | Promise<TeamStatusDto>
  cancel(input: { conversationId: string; runId: string }): RunStatusDto | Promise<RunStatusDto>
  retry(input: { conversationId: string; runId: string; memberIds?: string[]; requestId: string }): RetryIntentDto | Promise<RetryIntentDto>
  discardRetry(input: { conversationId: string; runId: string; requestId: string }): { discarded: boolean } | Promise<{ discarded: boolean }>
  exportConfig(input: { conversationId: string }): PresetDocumentDto | Promise<PresetDocumentDto>
  setManualAgents(input: { conversationId: string; agentIds: string[] }): { conversationId: string; manualAgentIds: string[] } | Promise<{ conversationId: string; manualAgentIds: string[] }>
  listTraces(input: { conversationId: string }): TraceSummaryDto[] | Promise<TraceSummaryDto[]>
  getTrace(input: { conversationId: string; runId: string }): TraceDetailDto | Promise<TraceDetailDto>
  importConfig(input: { conversationId: string; preset: JsonValue }): { conversationId: string; config: TeamConfig } | Promise<{ conversationId: string; config: TeamConfig }>
}
