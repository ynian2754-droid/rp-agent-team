import { defaultTeamConfig, migrateV1ToV2, normalizeTeamConfig } from '../../shared/schema.mjs'

export { migrateV1ToV2 }

export function normalizeStoredConfig(value) {
  if (value?.schemaVersion === 2) return normalizeTeamConfig(value)
  if (value?.lead && Array.isArray(value.members)) return migrateV1ToV2(value)
  return normalizeTeamConfig(value ?? defaultTeamConfig())
}
