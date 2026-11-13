// Plain-language sentences about when a member runs. The same wording is used by the
// member list, the round overview and the next-round forecast.
import { t, tOr } from './i18n.js'
import { nameList } from './format.js'

const names = (config, ids, limit = 2) => nameList(config, ids, limit)

function triggerPhrase(trigger, config) {
  if (trigger.type === 'periodic') return t('when.periodic', { n: trigger.every })
  if (trigger.type === 'requested_by_agent') return trigger.from?.length ? t('when.requestedBy', { names: names(config, trigger.from) }) : t('when.requested')
  return t(`triggerShort.${trigger.type}`)
}

/** "每轮" / "每 2 轮" / "被 角色本人 请求时" … one short phrase per configured trigger. */
export function triggerPhrases(member, config) {
  return [...new Set(member.triggers.map(trigger => triggerPhrase(trigger, config)))]
}

/** One line for the member list: how it gets in, then what it waits for. */
export function triggerSummary(member, config, limit = 2) {
  const phrases = triggerPhrases(member, config)
  const parts = [phrases.length ? phrases.slice(0, limit).join(t('listSep')) + (phrases.length > limit ? '…' : '') : t('summary.neverRuns')]
  if (member.execution.after.length) parts.push(t('summary.after', { names: names(config, member.execution.after, 1) }))
  return parts.join(t('clauseSep'))
}

/** Why a member that did not start stayed out of a finished round. */
export function idleReasonText(reason, config) {
  if (reason.code === 'onRequest') return reason.from?.length ? t('idle.onRequest', { names: names(config, reason.from) }) : t('idle.onRequestAny')
  if (reason.code === 'periodic') return t('idle.periodic', { n: reason.every })
  return t(`idle.${reason.code}`)
}

/** How an activated member entered the round, worded like its entry in the member list when the member is known. */
export function causeText(cause, config, member) {
  if (!cause) return ''
  if (cause.type === 'request') return t('cause.request', { name: names(config, [cause.by]) })
  if (cause.type === 'resume') return t('cause.resume')
  // The host records `condition:<index into member.triggers>` for conditions and `retry` for members a retry reran.
  const phrase = raw => {
    if (raw === 'retry') return t('cause.retry')
    const [type, position] = String(raw).split(':')
    const indexed = position === undefined ? undefined : member?.triggers?.[Number(position)]
    const trigger = indexed?.type === type ? indexed : member?.triggers?.find(item => item.type === type)
    return trigger ? triggerPhrase(trigger, config) : tOr(`triggerShort.${type}`, t('cause.trigger'))
  }
  return [...new Set(cause.triggers.map(phrase))].join(t('listSep'))
}

/**
 * Folds a member's trigger checks from the host preview into one forecast.
 * `run` wins over everything; a keyword or event trigger makes an otherwise idle member "depends".
 */
export function forecast(member, config) {
  const checks = member.triggerChecks || []
  const lines = checks.map(check => {
    if (check.outcome === 'cooldown') return t('next.cooldown', { turn: check.availableAt })
    if (check.type === 'always') return t('next.always')
    if (check.type === 'manual') return t(check.outcome === 'run' ? 'next.manualSelected' : 'next.manualIdle')
    if (check.type === 'requested_by_agent') return check.from?.length ? t('next.onRequest', { names: names(config, check.from) }) : t('next.onRequestAny')
    if (check.type === 'periodic') return check.outcome === 'unknown' ? t('next.periodicUnknown', { n: check.every })
      : t(check.outcome === 'run' ? 'next.periodicRun' : 'next.periodicSkip', { n: check.every, turn: check.ordinal })
    if (check.type === 'condition') return t(check.outcome === 'run' ? 'next.conditionRun' : check.outcome === 'skip' ? 'next.conditionSkip' : 'next.conditionUnknown')
    if (check.type === 'keyword') return t('next.keyword')
    return t('next.onEvent')
  })
  const has = outcome => checks.some(check => check.outcome === outcome)
  const definite = checks.some(check => check.outcome === 'run' && check.type !== 'keyword')
  const kind = !checks.length ? 'never'
    : definite || member.triggered && !checks.some(check => check.type === 'keyword') ? 'run'
      : checks.some(check => check.type === 'keyword') || has('on_event') || has('unknown') ? 'depends'
        : has('on_request') ? 'request' : 'skip'
  return { kind, lines: [...new Set(lines)] }
}
