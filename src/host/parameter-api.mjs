import { resolveAuthorParameters } from '../shared/author-parameters.mjs'
import { teamError } from '../shared/schema.mjs'

/** Resolve an author draft without saving it or starting a Team run. */
export function previewParameters(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw teamError('RP_TEAM_INVALID_REQUEST', 'previewParameters expects an object')
  }
  if (!Object.hasOwn(input, 'config')) throw teamError('RP_TEAM_INVALID_REQUEST', 'previewParameters requires config')
  return resolveAuthorParameters(input.config, input.parameterValues === undefined ? {} : input.parameterValues)
}
