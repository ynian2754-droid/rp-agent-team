/** Runtime matching for bounded, author-configured Team triggers. */
export function createTriggerTracker({
  config,
  configRevision = '',
  currentInput = '',
  currentInputForAgent,
  userTurnOrdinal,
  cooldownMarkers = [],
  bypassCooldownAgentIds = []
} = {}) {
  const agents = new Map((config?.agents ?? []).map(agent => [agent.id, agent]))
  const configId = config?.id ?? configRevision
  const cooldownBypass = new Set(bypassCooldownAgentIds)
  const byId = new Map()
  for (const agent of agents.values()) {
    agent.triggers.forEach((trigger, index) => {
      byId.set(triggerIdentity(configId, agent.id, trigger, index), { agent, trigger, index })
    })
  }
  const latestCooldown = new Map()
  for (const marker of cooldownMarkers) {
    if (!marker?.triggerId || !Number.isSafeInteger(marker.userTurnOrdinal)) continue
    const previous = latestCooldown.get(marker.triggerId)
    if (!previous || marker.userTurnOrdinal > previous.userTurnOrdinal) latestCooldown.set(marker.triggerId, marker)
  }
  const matched = new Set()
  const started = new Set()

  function identity(agentId, trigger, index) {
    return triggerIdentity(configId, agentId, trigger, index)
  }

  function isCoolingDown(agentId, trigger, index) {
    if (trigger.cooldownTurns === undefined || trigger.cooldownTurns === 0) return false
    const marker = latestCooldown.get(identity(agentId, trigger, index))
    if (!marker) return false
    if (!Number.isSafeInteger(userTurnOrdinal)) return true
    return userTurnOrdinal - marker.userTurnOrdinal <= trigger.cooldownTurns
  }

  function match(agentId, trigger, index, { bypassCooldown = false, dedupe = true } = {}) {
    const triggerId = identity(agentId, trigger, index)
    if ((dedupe && matched.has(triggerId))
      || (!bypassCooldown && !cooldownBypass.has(agentId) && isCoolingDown(agentId, trigger, index))) return undefined
    if (dedupe) matched.add(triggerId)
    return { agentId, triggerId, triggerType: trigger.type }
  }

  function configured(agentId, type, predicate = () => true, options) {
    const agent = agents.get(agentId)
    if (!agent) return []
    return agent.triggers.flatMap((trigger, index) =>
      trigger.type === type && predicate(trigger) ? [match(agentId, trigger, index, options)].filter(Boolean) : [])
  }

  function matchInput() {
    const result = []
    for (const agent of agents.values()) {
      const projectedInput = currentInputForAgent ? currentInputForAgent(agent) : currentInput
      const text = typeof projectedInput === 'string' ? projectedInput : ''
      for (let index = 0; index < agent.triggers.length; index += 1) {
        const trigger = agent.triggers[index]
        if (trigger.type === 'periodic') {
          if (!Number.isSafeInteger(userTurnOrdinal)) continue
          const offset = trigger.offset ?? 0
          if (userTurnOrdinal >= offset && (userTurnOrdinal - offset) % trigger.every === 0) {
            const value = match(agent.id, trigger, index)
            if (value) result.push(value)
          }
        } else if (trigger.type === 'keyword' && hasCurrentInput(agent) && text.length > 0) {
          const source = trigger.caseSensitive ? text : text.toLowerCase()
          const terms = trigger.caseSensitive ? trigger.keywords : trigger.keywords.map(term => term.toLowerCase())
          const found = trigger.match === 'all'
            ? terms.every(term => source.includes(term))
            : terms.some(term => source.includes(term))
          if (found) {
            const value = match(agent.id, trigger, index)
            if (value) result.push(value)
          }
        }
      }
    }
    return result
  }

  function stateWatchTargets(namespace, path) {
    const targets = []
    for (const agent of agents.values()) {
      for (let index = 0; index < agent.triggers.length; index += 1) {
        const trigger = agent.triggers[index]
        if (trigger.type !== 'state_changed'
          || (namespace !== undefined && trigger.namespace !== namespace)
          || (path !== undefined && !pathsOverlap(trigger.path, path))) continue
        targets.push({
          triggerId: identity(agent.id, trigger, index), agentId: agent.id,
          namespace: trigger.namespace, path: trigger.path
        })
      }
    }
    return targets
  }

  function matchStateChanges(changes = []) {
    const result = []
    for (const change of changes) {
      const configuredTrigger = byId.get(change?.triggerId)
      const trigger = configuredTrigger?.trigger
      if (!trigger || trigger.type !== 'state_changed' || change.namespace !== trigger.namespace
        || change.path !== trigger.path || !stateValueKnown(change.before) || !stateValueKnown(change.after)
        || sameStateValue(change.before, change.after)) continue
      const value = match(configuredTrigger.agent.id, trigger, configuredTrigger.index)
      if (value) result.push(value)
    }
    return result
  }

  function matchMessage(message, canReceive = () => true) {
    if (!message || typeof message !== 'object') return []
    const result = []
    for (const agent of agents.values()) {
      if (message.to !== agent.id || !canReceive(agent.id, message)) continue
      for (let index = 0; index < agent.triggers.length; index += 1) {
        const trigger = agent.triggers[index]
        if (trigger.type !== 'message_received'
          || !(trigger.messageTypes ?? ['message']).includes(message.type)
          || (trigger.from?.length && !allows(trigger.from, message.from))
          || (trigger.topic !== undefined && trigger.topic !== message.topic)) continue
        const value = match(agent.id, trigger, index)
        if (value) result.push(value)
      }
    }
    return result
  }

  function markStarted(matches, { branchId, inputMessageId, runId, at = new Date().toISOString() } = {}) {
    const markers = []
    for (const value of matches ?? []) {
      if (!value?.triggerId || started.has(value.triggerId)) continue
      started.add(value.triggerId)
      markers.push({
        triggerId: value.triggerId, agentId: value.agentId,
        ...(Number.isSafeInteger(userTurnOrdinal) ? { userTurnOrdinal } : {}),
        ...(branchId ? { branchId: String(branchId) } : {}),
        ...(inputMessageId ? { inputMessageId: String(inputMessageId) } : {}),
        ...(runId ? { runId: String(runId) } : {}), at
      })
    }
    return markers
  }

  return {
    configured, matchTrigger: match, isCoolingDown, matchInput, stateWatchTargets, matchStateChanges,
    matchMessage, markStarted
  }
}

export function triggerIdentity(configId, agentId, trigger, index) {
  return stableStringify(trigger.id !== undefined
    ? [String(configId ?? ''), agentId, 'id', trigger.id]
    : [String(configId ?? ''), agentId, 'legacy', index, trigger])
}

/** Use only committed runs still represented by the active branch's real input events. */
export function committedTriggerCooldowns(rows, activeInputMessageIds) {
  const activeInputs = new Set((activeInputMessageIds ?? []).map(String))
  const latest = new Map()
  if (!activeInputs.size) return []
  for (const row of rows ?? []) {
    const status = row?.status ?? {}
    const inputMessageId = String(row?.inputMessageId ?? status.inputMessageId ?? '')
    if (status.phase !== 'complete' || !activeInputs.has(inputMessageId)
      || row?.trace?.events?.some(event => event.type === 'publication.rewound')) continue
    for (const marker of row?.triggerCooldownMarkers ?? []) {
      if (!marker?.triggerId || !Number.isSafeInteger(marker.userTurnOrdinal)) continue
      const previous = latest.get(marker.triggerId)
      if (!previous || marker.userTurnOrdinal > previous.userTurnOrdinal) latest.set(marker.triggerId, structuredClone(marker))
    }
  }
  return [...latest.values()]
}

/** Select the newest committed Team checkpoint still present on the current branch. */
export function latestCommittedStateCheckpoint(rows, activeInputMessageIds, stateTransactions = {}) {
  const activeInputs = new Set((activeInputMessageIds ?? []).map(String))
  if (!activeInputs.size) return undefined
  return (rows ?? []).flatMap(row => {
    const status = row?.status ?? {}
    const runId = String(status.runId ?? row?.runId ?? '')
    const inputId = String(status.inputMessageId ?? row?.inputMessageId ?? '')
    const transaction = stateTransactions?.[runId]
    if (status.phase !== 'complete' || !activeInputs.has(inputId)
      || row?.trace?.events?.some(event => event.type === 'publication.rewound')
      || !Number.isSafeInteger(status.inputEventSeq) || transaction?.status !== 'committed') return []
    return [{ runId, inputEventSeq: status.inputEventSeq, transaction }]
  }).sort((left, right) => right.inputEventSeq - left.inputEventSeq)[0]
}

/** Compare one committed checkpoint with the current per-member visible state. */
export function stateChangesFromCheckpoint({ targets = [], checkpoint, currentValues = new Map(), project = (_target, value) => value } = {}) {
  if (!checkpoint) return []
  return targets.flatMap(target => {
    if (!currentValues.has(target.triggerId)) return []
    const previous = snapshotPath(checkpoint.state, target.namespace, target.path)
    let before = { known: false, present: false }
    if (previous.present) {
      const visible = project(target, previous.value)
      before = visible === undefined
        ? { known: true, present: false }
        : { known: true, present: true, value: structuredClone(visible) }
    } else if (stateDefinitionCovers(checkpoint.config, target.namespace, target.path)) {
      before = { known: true, present: false }
    }
    return [{ ...target, before, after: currentValues.get(target.triggerId) }]
  })
}

function hasCurrentInput(agent) {
  return agent.context?.sources?.some(source => source.type === 'current_input'
    && (source.selector === undefined || source.selector === '' || source.selector === '/text')) === true
}

function pathsOverlap(left, right) {
  return pointerWithin(left, right) || pointerWithin(right, left)
}

function pointerWithin(parent, child) {
  if (parent === '') return true
  return child === parent || child.startsWith(`${parent}/`)
}

function stateValueKnown(value) {
  return value?.known === true && typeof value.present === 'boolean'
}

function snapshotPath(snapshot, namespace, path) {
  let value = snapshot?.[namespace]
  if (path === '') return value === undefined ? { present: false } : { present: true, value }
  for (const raw of path.slice(1).split('/')) {
    const segment = raw.replace(/~1/g, '/').replace(/~0/g, '~')
    if (value === null || typeof value !== 'object' || !Object.hasOwn(value, segment)) return { present: false }
    value = value[segment]
  }
  return value === undefined ? { present: false } : { present: true, value }
}

function stateDefinitionCovers(config, namespace, path) {
  return config?.state?.definitions?.some(definition => definition.namespace === namespace
    && (definition.path === '' || path === definition.path || path.startsWith(`${definition.path}/`))) === true
}

function sameStateValue(left, right) {
  return left.present === right.present && (!left.present || stableStringify(left.value) === stableStringify(right.value))
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function allows(configured, value) {
  return configured.includes('*') || configured.includes(value)
}
