import { normalizeTeamConfig, exportPreset, parsePreset } from '../shared/schema.mjs'

export function sanitizeConfig(config) { return normalizeTeamConfig(config) }
export function exportPayload(config) { return exportPreset(config) }
export function parseImport(value) { return parsePreset(value) }
