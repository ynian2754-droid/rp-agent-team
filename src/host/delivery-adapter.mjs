export const TEAM_DELIVERY_PROVIDER = 'rp-team-local'
export const TEAM_DELIVERY_MODEL = 'team-delivery'

/** A truthful local LLM route: it returns the Team's body and never fabricates usage. */
export function createTeamDeliveryAdapter(deliver, LlmAdapter) {
  const Adapter = LlmAdapter ?? class {
    providerRetryPolicy() { return undefined }
    imageRequestPricing() { return undefined }
    async resolveModel(provider, model) { return { provider, id: model, name: 'RP Team local delivery' } }
    async prepareCall(provider, model, signal) {
      return { model: await this.resolveModel(provider, model, signal), stream: options => this.stream(options) }
    }
  }
  return new class extends Adapter {
    providerInfo(provider) { return { id: provider, name: 'RP Team local delivery' } }
    listModels() { return Promise.resolve([]) }
    async resolveModel(provider, model, signal) {
      signal?.throwIfAborted()
      if (provider !== TEAM_DELIVERY_PROVIDER || model !== TEAM_DELIVERY_MODEL) {
        throw new Error('Unknown RP Team local delivery route')
      }
      return { provider, id: model, name: 'RP Team local delivery' }
    }
    async *stream(options) {
      if (options.provider !== TEAM_DELIVERY_PROVIDER || options.model !== TEAM_DELIVERY_MODEL) {
        throw new Error('Unknown RP Team local delivery route')
      }
      options.signal?.throwIfAborted()
      const body = await deliver(options)
      options.signal?.throwIfAborted()
      if (typeof body !== 'string' || !body.trim()) {
        throw new Error('RP Team local delivery requires one non-empty assistant body')
      }
      yield { type: 'text-delta', index: 0, text: body }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }()
}
