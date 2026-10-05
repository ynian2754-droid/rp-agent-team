import { t } from './i18n.js'

export function nameList(config, ids, limit = 3) {
  if (ids.includes('*')) return t('allMembers')
  const names = ids.map(id => config.agents.find(agent => agent.id === id)?.name || id)
  return truncatedList(names, limit)
}

export function labelList(keys, prefix, limit = 4) {
  return truncatedList(keys.map(key => t(`${prefix}.${key}`)), limit)
}

function truncatedList(items, limit) {
  const shown = items.slice(0, limit).join(t('listSep'))
  return items.length > limit ? t('andMore', { list: shown, n: items.length - limit }) : shown
}
