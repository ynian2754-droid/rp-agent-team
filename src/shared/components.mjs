import { createHash } from 'node:crypto'
import { normalizeTeamConfig, teamError } from './schema.mjs'

const AGENT_PORT = '@rp-team-agent-port:'
const STATE_PORT = '@rp-team-state-port:'
const TEXT_FIELDS = ['name', 'description', 'systemPrompt']

/** Export a selected roster subset with explicit ports for every external reference. */
export function exportComponent(config, agentIds, name) {
  const normalized = normalizeTeamConfig(config)
  const requested = new Set(requireStringList(agentIds, 'agentIds'))
  const selected = normalized.agents.filter(agent => requested.has(agent.id))
  const unknown = [...requested].filter(id => !normalized.agents.some(agent => agent.id === id))
  if (unknown.length) throw teamError('RP_TEAM_AGENT_NOT_FOUND', `Unknown component agents: ${unknown.join(', ')}`)
  if (!selected.length) throw teamError('RP_TEAM_INVALID_REQUEST', 'A component must include at least one agent')
  const localIds = new Map(selected.map((agent, index) => [agent.id, `component-agent-${index + 1}`]))
  const ports = new Map()
  const sourceBindings = []
  const privateDefinitionKeys = new Set()
  const parameterIds = new Map((normalized.authorParameters ?? []).map((parameter, index) => [parameter.id, `component-parameter-${index + 1}`]))

  const makeAgentRef = (sourceId, use) => {
    const localId = localIds.get(sourceId)
    if (localId) return localId
    const target = normalized.agents.find(agent => agent.id === sourceId)
    const id = `agent-${digest(sourceId).slice(0, 14)}`
    const port = ports.get(id) ?? { id, kind: 'agent', label: `${target?.name ?? sourceId} (${sourceId})`, required: true, uses: [] }
    addUse(port, use)
    ports.set(id, port)
    return `${AGENT_PORT}${id}`
  }

  const stateReference = (namespace, path, use, ownerId) => {
    const privateOwner = namespace.startsWith('private:') ? namespace.slice('private:'.length) : ''
    if (privateOwner && localIds.has(privateOwner)) {
      const localNamespace = `private:${localIds.get(privateOwner)}`
      const definition = mostSpecificDefinition(normalized.state.definitions, namespace, path)
      if (definition) privateDefinitionKeys.add(definitionKey(definition))
      return { namespace: localNamespace, path }
    }
    const definition = mostSpecificDefinition(normalized.state.definitions, namespace, path)
    const rootPath = definition?.path ?? path
    const id = `state-${digest(`${namespace}\u0000${rootPath}`).slice(0, 14)}`
    const port = ports.get(id) ?? {
      id, kind: 'state', namespace, path: rootPath,
      label: `${namespace}${rootPath || '/'}`,
      required: true,
      ...(definition ? { definition: structuredClone(definition) } : {}),
      uses: []
    }
    addUse(port, `${ownerId}: ${use}`)
    ports.set(id, port)
    return { namespace: `${STATE_PORT}${id}`, path: relativePath(rootPath, path) }
  }

  const rewriteCondition = (condition, ownerId) => {
    if (condition.op === 'all' || condition.op === 'any') {
      return { ...condition, conditions: condition.conditions.map(item => rewriteCondition(item, ownerId)) }
    }
    if (condition.op === 'not') return { ...condition, condition: rewriteCondition(condition.condition, ownerId) }
    return { ...condition, ...stateReference(condition.namespace, condition.path, 'trigger condition', ownerId) }
  }

  const rewritePermission = (agent, permission) => {
    const covered = normalized.state.definitions.filter(definition => definition.namespace === permission.namespace
      && pointerContains(permission.path, definition.path))
    const paths = covered.length ? covered.map(definition => definition.path) : [permission.path]
    return paths.map(path => ({
      ...permission,
      ...stateReference(permission.namespace, path, `state permission ${permission.access}`, agent.id)
    }))
  }

  const componentAgents = selected.map(source => {
    const agent = structuredClone(source)
    const localId = localIds.get(source.id)
    agent.id = localId
    for (const key of ['sendTo', 'receiveFrom', 'requestTo', 'requestFrom']) {
      agent.communication[key] = expandWildcard(agent.communication[key], normalized.agents.map(item => item.id))
        .map(id => makeAgentRef(id, `communication.${key}`))
    }
    if (Array.isArray(agent.communication.handoffs)) {
      agent.communication.handoffs = agent.communication.handoffs.map(handoff => ({
        ...handoff,
        to: makeAgentRef(handoff.to, 'communication.handoffs.to')
      }))
    }
    for (const trigger of agent.triggers) {
      if (trigger.type === 'requested_by_agent') {
        trigger.from = expandWildcard(trigger.from, normalized.agents.map(item => item.id))
          .map(id => makeAgentRef(id, 'trigger.from'))
      } else if (trigger.type === 'condition') {
        trigger.condition = rewriteCondition(trigger.condition, source.id)
      }
    }
    for (const sourceSelection of agent.context.sources) {
      const index = agent.context.sources.indexOf(sourceSelection)
      if (sourceSelection.agentIds) {
        sourceSelection.agentIds = sourceSelection.agentIds.map(id => makeAgentRef(id, `context.sources[${index}].agentIds`))
      }
      if (sourceSelection.selector && ['hidden_state', 'long_memory', 'scene_state'].includes(sourceSelection.type)) {
        const statePath = sourceSelection.type === 'scene_state'
          ? appendPointer('/variables/scene', sourceSelection.selector)
          : sourceSelection.selector
        const ref = stateReference('world', statePath, `context.sources[${index}].selector`, source.id)
        if (ref.namespace.startsWith(STATE_PORT)) {
          sourceBindings.push({ agentRef: localId, sourceIndex: index, sourceType: sourceSelection.type, portId: ref.namespace.slice(STATE_PORT.length), suffix: ref.path })
        }
      }
    }
    agent.execution.after = agent.execution.after.map(id => makeAgentRef(id, 'execution.after'))
    agent.statePermissions = agent.statePermissions.flatMap(permission => rewritePermission(source, permission))
    rewriteParameterTokens(agent, parameterIds)
    return agent
  })

  const componentParameters = (normalized.authorParameters ?? []).map(parameter => {
    const portable = structuredClone(parameter)
    portable.id = parameterIds.get(parameter.id)
    if (portable.type === 'agent' && Object.hasOwn(portable, 'default')) {
      portable.default = makeAgentRef(portable.default, `author parameter ${parameter.id} default`)
    } else if (portable.type === 'state' && Object.hasOwn(portable, 'default')) {
      portable.default = stateReference(portable.default.namespace, portable.default.path, `author parameter ${parameter.id} default`, 'team')
    }
    portable.bindings = portable.bindings.map(binding => {
      if (binding.target.kind === 'agent') {
        binding.target.agentId = makeAgentRef(binding.target.agentId, `author parameter ${parameter.id} binding`)
      } else if (binding.target.kind === 'state_default') {
        const ref = stateReference(binding.target.namespace, binding.target.path, `author parameter ${parameter.id} state default`, 'team')
        binding.target = { kind: 'state_default', ...ref }
      }
      return binding
    })
    return portable
  })

  const componentMemory = normalized.memory?.collections?.map((collection, index) => ({
    ...structuredClone(collection),
    id: `component-memory-${index + 1}`,
    ...stateReference(collection.namespace, collection.path, `memory collection ${collection.id}`, 'team')
  }))

  const stateDefinitions = normalized.state.definitions.filter(definition => privateDefinitionKeys.has(definitionKey(definition)))
    .map(definition => ({
      ...structuredClone(definition),
      namespace: `private:${localIds.get(definition.namespace.slice('private:'.length))}`
    }))
  const outputAgent = normalized.agents.find(agent => agent.id === normalized.output.agentId)
  const outputRef = localIds.get(outputAgent.id) ?? null
  const publisherPortId = 'publisher'
  ports.set(publisherPortId, {
    id: publisherPortId,
    kind: 'publisher',
    label: `Source output agent: ${outputAgent.name}`,
    required: false,
    suggestedAgentRef: outputRef,
    uses: ['output.agentId']
  })
  const textualIdReferences = selected.flatMap(source => {
    const references = []
    for (const field of TEXT_FIELDS) {
      const value = source[field]
      if (typeof value !== 'string' || !value) continue
      const ids = normalized.agents.map(agent => agent.id).filter(id => value.includes(id))
      if (ids.length) references.push({ agentRef: localIds.get(source.id), field, ids: [...new Set(ids)] })
    }
    return references
  })

  const component = {
    format: 'rp-team-component-v1',
    name: requiredText(name, 'component name'),
    dependencies: { minimumPluginVersion: requires040(normalized) ? '0.4.0' : '0.3.0' },
    agents: componentAgents,
    state: { definitions: stateDefinitions },
    publisher: { portId: publisherPortId, suggestedAgentRef: outputRef },
    ports: [...ports.values()].sort((left, right) => left.id.localeCompare(right.id)),
    sourceBindings,
    textualIdReferences
  }
  if (componentParameters.length) component.authorParameters = componentParameters
  if (componentMemory?.length) component.memory = { collections: componentMemory }
  return component
}

/** Build and validate an import draft. This function never writes config or library state. */
export function prepareComponentImport({ config, component, importId, bindings = {} }) {
  const target = normalizeTeamConfig(config)
  const portable = validateComponent(component)
  const key = requiredText(importId, 'importId')
  const agentBindings = isRecord(bindings.agents) ? bindings.agents : {}
  const stateBindings = isRecord(bindings.states) ? bindings.states : {}
  const portsById = new Map(portable.ports.map(port => [port.id, port]))
  const conflicts = []
  const issues = []
  const changes = []
  const agentIdMap = Object.fromEntries(portable.agents.map(agent => [agent.id, stableAgentId(key, agent.id)]))
  const parameterIdMap = Object.fromEntries((portable.authorParameters ?? []).map(parameter => [parameter.id, stableAgentId(key, `parameter-${parameter.id}`)]))
  const existingIds = new Set(target.agents.map(agent => agent.id))
  for (const [localId, importedId] of Object.entries(agentIdMap)) {
    if (existingIds.has(importedId)) conflicts.push({ kind: 'agent-id', severity: 'error', agentRef: localId, id: importedId, message: `Imported agent id ${importedId} already exists` })
  }

  const unresolved = new Set()
  for (const port of portable.ports) {
    if (port.kind === 'agent') {
      if (port.required && !Object.hasOwn(agentBindings, port.id)) {
        unresolved.add(port.id)
      } else if (Object.hasOwn(agentBindings, port.id) && agentBindings[port.id] !== null && (typeof agentBindings[port.id] !== 'string'
        || !existingIds.has(agentBindings[port.id]) && !Object.values(agentIdMap).includes(agentBindings[port.id]))) {
        issues.push({ code: 'invalid-agent-binding', severity: 'error', portId: port.id, value: agentBindings[port.id] })
      }
    } else if (port.kind === 'state' && !Object.hasOwn(stateBindings, port.id)) {
      unresolved.add(port.id)
    }
  }

  const mapAgentRef = (value, where) => {
    if (Object.hasOwn(agentIdMap, value)) return agentIdMap[value]
    if (!value.startsWith(AGENT_PORT)) {
      issues.push({ code: 'unknown-component-agent-ref', severity: 'error', agentRef: value, where })
      return null
    }
    const portId = value.slice(AGENT_PORT.length)
    const port = portsById.get(portId)
    if (!port || port.kind !== 'agent') {
      issues.push({ code: 'unknown-agent-port', severity: 'error', portId, where })
      return null
    }
    if (!Object.hasOwn(agentBindings, portId)) return null
    const bound = agentBindings[portId]
    if (bound === null) {
      issues.push({ code: 'agent-reference-removed', severity: 'warning', portId, where })
      return null
    }
    if (typeof bound !== 'string' || !existingIds.has(bound) && !Object.values(agentIdMap).includes(bound)) return null
    return bound
  }

  const addMappedDefinition = (port, binding) => {
    if (!port.definition) return
    const definition = {
      ...structuredClone(port.definition),
      namespace: binding.namespace,
      path: appendPointer(binding.path, relativePath(port.path, port.definition.path))
    }
    const existing = target.state.definitions.find(item => item.namespace === definition.namespace && item.path === definition.path)
      ?? changes.map(change => change.definition).find(item => item?.namespace === definition.namespace && item.path === definition.path)
    if (existing) {
      if (stableJson(existing) !== stableJson(definition)) {
        conflicts.push({ kind: 'state-definition', severity: 'error', portId: port.id, namespace: definition.namespace, path: definition.path, message: 'Mapped state definition conflicts with the destination definition' })
      }
      return
    }
    changes.push({ kind: 'state-definition-added', namespace: definition.namespace, path: definition.path, definition })
  }

  const mapStateRef = (namespace, path, where) => {
    if (!namespace.startsWith(STATE_PORT)) {
      const privatePrefix = 'private:'
      const localOwner = namespace.startsWith(privatePrefix) ? namespace.slice(privatePrefix.length) : ''
      if (localOwner && Object.hasOwn(agentIdMap, localOwner)) return { namespace: `${privatePrefix}${agentIdMap[localOwner]}`, path }
      issues.push({ code: 'unknown-component-state-ref', severity: 'error', namespace, path, where })
      return null
    }
    const portId = namespace.slice(STATE_PORT.length)
    const port = portsById.get(portId)
    if (!port || port.kind !== 'state') {
      issues.push({ code: 'unknown-state-port', severity: 'error', portId, where })
      return null
    }
    if (!Object.hasOwn(stateBindings, portId)) return null
    const binding = stateBindings[portId]
    if (binding === null) {
      issues.push({ code: 'state-reference-removed', severity: 'warning', portId, where })
      return null
    }
    if (!isRecord(binding) || !validNamespace(binding.namespace) || typeof binding.path !== 'string'
      || (binding.path !== '' && !binding.path.startsWith('/')) || binding.path.split('/').slice(1).some(part => /~(?![01])/u.test(part))) {
      issues.push({ code: 'invalid-state-binding', severity: 'error', portId, value: binding })
      return null
    }
    addMappedDefinition(port, binding)
    return { namespace: binding.namespace, path: appendPointer(binding.path, path) }
  }

  const mapCondition = (condition, where) => {
    if (condition.op === 'all' || condition.op === 'any') {
      const conditions = condition.conditions.map(item => mapCondition(item, where))
      return conditions.some(item => item === null) ? null : { ...condition, conditions }
    }
    if (condition.op === 'not') {
      const nested = mapCondition(condition.condition, where)
      return nested === null ? null : { ...condition, condition: nested }
    }
    const ref = mapStateRef(condition.namespace, condition.path, where)
    return ref === null ? null : { ...condition, ...ref }
  }

  const importedAgents = portable.agents.map(source => {
    const agent = structuredClone(source)
    const localId = source.id
    agent.id = agentIdMap[localId]
    for (const field of ['sendTo', 'receiveFrom', 'requestTo', 'requestFrom']) {
      agent.communication[field] = agent.communication[field].flatMap((ref, index) => {
        const mapped = mapAgentRef(ref, `${localId}.communication.${field}[${index}]`)
        return mapped === null ? [] : [mapped]
      })
    }
    if (Array.isArray(agent.communication.handoffs)) {
      agent.communication.handoffs = agent.communication.handoffs.flatMap((handoff, index) => {
        const mapped = mapAgentRef(handoff.to, `${localId}.communication.handoffs[${index}].to`)
        if (mapped === null) {
          issues.push({ code: 'handoff-removed', severity: 'warning', agentId: agent.id, handoffId: handoff.id })
          return []
        }
        return [{ ...handoff, to: mapped }]
      })
    }
    agent.execution.after = agent.execution.after.flatMap((ref, index) => {
      const mapped = mapAgentRef(ref, `${localId}.execution.after[${index}]`)
      return mapped === null ? [] : [mapped]
    })
    agent.triggers = agent.triggers.flatMap((trigger, index) => {
      if (trigger.type === 'requested_by_agent') {
        const original = trigger.from
        const from = original.flatMap((ref, refIndex) => {
          const mapped = mapAgentRef(ref, `${localId}.triggers[${index}].from[${refIndex}]`)
          return mapped === null ? [] : [mapped]
        })
        if (original.length && !from.length) {
          issues.push({ code: 'trigger-removed', severity: 'warning', agentId: agent.id, reason: 'No request sender remained after port bindings' })
          return []
        }
        return [{ ...trigger, from }]
      }
      if (trigger.type === 'condition') {
        const condition = mapCondition(trigger.condition, `${localId}.triggers[${index}].condition`)
        if (condition === null) {
          issues.push({ code: 'condition-trigger-removed', severity: 'warning', agentId: agent.id, reason: 'A state port was explicitly disconnected' })
          return []
        }
        return [{ ...trigger, condition }]
      }
      return [trigger]
    })
    agent.statePermissions = agent.statePermissions.flatMap((permission, index) => {
      const ref = mapStateRef(permission.namespace, permission.path, `${localId}.statePermissions[${index}]`)
      if (ref === null) return []
      return [{ ...permission, ...ref }]
    })
    agent.context.sources = agent.context.sources.flatMap((sourceSelection, index) => {
      let result = structuredClone(sourceSelection)
      if (sourceSelection.agentIds) {
        result.agentIds = sourceSelection.agentIds.flatMap((ref, refIndex) => {
          const mapped = mapAgentRef(ref, `${localId}.context.sources[${index}].agentIds[${refIndex}]`)
          return mapped === null ? [] : [mapped]
        })
      }
      return [result]
    })
    rewriteParameterTokens(agent, parameterIdMap)
    return agent
  })

  const mapParameterAgentRef = (value, where) => {
    const mapped = mapAgentRef(value, where)
    if (mapped !== null) return mapped
    const portId = value.startsWith(AGENT_PORT) ? value.slice(AGENT_PORT.length) : undefined
    issues.push({ code: 'author-parameter-agent-unresolved', severity: 'error', ...(portId ? { portId } : {}), where })
    return value
  }
  const mapParameterStateRef = (namespace, path, where) => {
    const ref = mapStateRef(namespace, path, where)
    if (ref !== null) return ref
    const portId = namespace.startsWith(STATE_PORT) ? namespace.slice(STATE_PORT.length) : undefined
    issues.push({ code: 'author-parameter-state-unresolved', severity: 'error', ...(portId ? { portId } : {}), where })
    return { namespace, path }
  }
  const importedParameters = (portable.authorParameters ?? []).map(source => {
    const parameter = structuredClone(source)
    parameter.id = parameterIdMap[source.id]
    if (parameter.type === 'agent' && Object.hasOwn(parameter, 'default')) {
      parameter.default = mapParameterAgentRef(parameter.default, `authorParameters.${source.id}.default`)
    } else if (parameter.type === 'state' && Object.hasOwn(parameter, 'default')) {
      parameter.default = mapParameterStateRef(parameter.default.namespace, parameter.default.path, `authorParameters.${source.id}.default`)
    }
    parameter.bindings = parameter.bindings.map((binding, index) => {
      if (binding.target.kind === 'agent') {
        binding.target.agentId = mapParameterAgentRef(binding.target.agentId, `authorParameters.${source.id}.bindings[${index}]`)
      } else if (binding.target.kind === 'state_default') {
        binding.target = { kind: 'state_default', ...mapParameterStateRef(binding.target.namespace, binding.target.path, `authorParameters.${source.id}.bindings[${index}]`) }
      }
      return binding
    })
    return parameter
  })
  const importedMemory = (portable.memory?.collections ?? []).map((source, index) => ({
    ...structuredClone(source),
    id: stableAgentId(key, `memory-${source.id ?? index + 1}`),
    ...mapParameterStateRef(source.namespace, source.path, `memory.collections[${index}]`)
  }))

  const orderedSourceBindings = [...portable.sourceBindings].sort((left, right) => left.agentRef.localeCompare(right.agentRef)
    || right.sourceIndex - left.sourceIndex)
  for (const sourceBinding of orderedSourceBindings) {
    const importedAgent = importedAgents.find(agent => agent.id === agentIdMap[sourceBinding.agentRef])
    const port = portsById.get(sourceBinding.portId)
    const binding = stateBindings[sourceBinding.portId]
    if (!importedAgent || !port || !Object.hasOwn(stateBindings, sourceBinding.portId)) continue
    if (binding === null) {
      importedAgent.context.sources.splice(sourceBinding.sourceIndex, 1)
      issues.push({ code: 'context-selection-removed', severity: 'warning', agentId: importedAgent.id, sourceType: sourceBinding.sourceType, portId: sourceBinding.portId })
      continue
    }
    if (!isRecord(binding) || binding.namespace !== 'world' || typeof binding.path !== 'string') {
      issues.push({ code: 'invalid-context-state-binding', severity: 'error', portId: sourceBinding.portId, sourceType: sourceBinding.sourceType })
      importedAgent.context.sources.splice(sourceBinding.sourceIndex, 1)
      continue
    }
    const mappedPath = appendPointer(binding.path, sourceBinding.suffix)
    const selector = sourceBinding.sourceType === 'scene_state'
      ? (pointerContains('/variables/scene', mappedPath) ? relativePath('/variables/scene', mappedPath) : null)
      : mappedPath
    if (selector === null) {
      issues.push({ code: 'context-selection-outside-scene', severity: 'warning', agentId: importedAgent.id, portId: sourceBinding.portId })
      importedAgent.context.sources.splice(sourceBinding.sourceIndex, 1)
    } else {
      importedAgent.context.sources[sourceBinding.sourceIndex].selector = selector
    }
  }

  const stateDefinitions = portable.state.definitions.map(definition => ({
    ...structuredClone(definition),
    namespace: `private:${agentIdMap[definition.namespace.slice('private:'.length)]}`
  }))
  const stateDefinitionsByKey = new Map()
  for (const definition of [...target.state.definitions, ...stateDefinitions, ...changes.map(change => change.definition).filter(Boolean)]) {
    const key = definitionKey(definition)
    if (stateDefinitionsByKey.has(key) && stableJson(stateDefinitionsByKey.get(key)) !== stableJson(definition)) {
      conflicts.push({ kind: 'state-definition', severity: 'error', namespace: definition.namespace, path: definition.path, message: 'Imported state definitions conflict' })
    } else stateDefinitionsByKey.set(key, definition)
  }

  const literalRefs = portable.textualIdReferences.map(item => ({
    code: 'literal-agent-id', severity: 'warning', agentId: agentIdMap[item.agentRef] ?? item.agentRef,
    field: item.field, ids: [...item.ids]
  }))
  issues.push(...literalRefs)
  const publisherBinding = Object.hasOwn(bindings, 'publisher')
    ? bindings.publisher
    : (portable.publisher?.portId && Object.hasOwn(agentBindings, portable.publisher.portId) ? agentBindings[portable.publisher.portId] : undefined)
  const merged = {
    ...target,
    agents: [...target.agents, ...importedAgents],
    state: { definitions: [...stateDefinitionsByKey.values()] },
    ...(importedParameters.length ? { authorParameters: [...(target.authorParameters ?? []), ...importedParameters] } : {}),
    ...(importedMemory.length ? { memory: { collections: [...(target.memory?.collections ?? []), ...importedMemory] } } : {})
  }
  if (publisherBinding !== undefined && publisherBinding !== null) {
    const available = new Map(merged.agents.map(agent => [agent.id, agent]))
    const publisher = available.get(publisherBinding)
    if (!publisher || !publisher.outputAuthority.user) {
      conflicts.push({ kind: 'publisher', severity: 'error', agentId: publisherBinding, message: 'Publisher binding must name an available agent with user output authority' })
    } else {
      merged.output = { agentId: publisherBinding }
      changes.push({ kind: 'publisher-bound', agentId: publisherBinding })
    }
  } else {
    changes.push({ kind: 'publisher-preserved', agentId: target.output.agentId })
  }

  for (const id of unresolved) issues.push({ code: 'unbound-port', severity: 'error', portId: id, kind: portsById.get(id)?.kind })
  for (const imported of importedAgents) changes.push({ kind: 'agent-added', agentId: imported.id, name: imported.name })
  let draft
  if (!conflicts.length && !unresolved.size && !issues.some(issue => issue.severity === 'error')) {
    try {
      draft = normalizeTeamConfig(merged)
    } catch (error) {
      issues.push({ code: 'merged-config-invalid', severity: 'error', message: error.message })
    }
  }
  const userIssues = issues.map(issue => ({ ...issue, message: issue.message ?? issueMessage(issue) }))
  const returnedPorts = portable.ports.map(port => ({
    ...structuredClone(port),
    bound: port.kind === 'agent' ? Object.hasOwn(agentBindings, port.id)
      : port.kind === 'state' ? Object.hasOwn(stateBindings, port.id)
        : publisherBinding !== undefined && publisherBinding !== null
  }))
  return {
    ...(draft ? { config: draft } : {}),
    ports: returnedPorts,
    conflicts,
    changes,
    issues: userIssues,
    agentIdMap
  }
}

function validateComponent(component) {
  if (!isRecord(component) || component.format !== 'rp-team-component-v1'
    || !Array.isArray(component.agents) || !Array.isArray(component.ports)
    || !isRecord(component.state) || !Array.isArray(component.state.definitions)) {
    throw teamError('RP_TEAM_COMPONENT_INVALID', 'Component must use rp-team-component-v1 format')
  }
  if (component.authorParameters !== undefined && !Array.isArray(component.authorParameters)) {
    throw teamError('RP_TEAM_COMPONENT_INVALID', 'Component authorParameters must be an array')
  }
  if (component.memory !== undefined && (!isRecord(component.memory) || !Array.isArray(component.memory.collections))) {
    throw teamError('RP_TEAM_COMPONENT_INVALID', 'Component memory must contain a collections array')
  }
  const ids = new Set()
  for (const port of component.ports) {
    if (!isRecord(port) || typeof port.id !== 'string' || !['agent', 'state', 'publisher'].includes(port.kind) || ids.has(port.id)) {
      throw teamError('RP_TEAM_COMPONENT_INVALID', 'Component ports must have unique ids and supported kinds')
    }
    ids.add(port.id)
  }
  return structuredClone(component)
}

function expandWildcard(values, roster) { return values.includes('*') ? [...roster] : [...values] }
function addUse(port, use) { if (!port.uses.includes(use)) port.uses.push(use) }
function mostSpecificDefinition(definitions, namespace, path) {
  return definitions.filter(item => item.namespace === namespace && pointerContains(item.path, path))
    .sort((left, right) => right.path.length - left.path.length)[0]
}
function pointerContains(parent, child) { return parent === '' || parent === child || child.startsWith(`${parent}/`) }
function relativePath(parent, child) {
  if (parent === child) return ''
  if (parent === '') return child
  return child.slice(parent.length)
}
function appendPointer(base, suffix) {
  if (!base) return suffix
  if (!suffix) return base
  return `${base}${suffix}`
}
function definitionKey(definition) { return JSON.stringify([definition.namespace, definition.path]) }
function validNamespace(value) {
  return typeof value === 'string' && (value === 'shared' || value === 'world'
    || value.startsWith('private:') && value.length > 'private:'.length)
}
function issueMessage(issue) {
  switch (issue.code) {
    case 'unbound-port': return `Bind or explicitly disconnect the required ${issue.kind} port “${issue.portId}”.`
    case 'literal-agent-id': return `The ${issue.field} text still contains source agent ID(s) ${issue.ids.join(', ')}. The text was left unchanged; review these references.`
    case 'agent-reference-removed': return `The reference to port “${issue.portId}” was removed from ${issue.where}. Review the resulting workflow.`
    case 'state-reference-removed': return `The state reference from port “${issue.portId}” was removed from ${issue.where}. Review the resulting permissions or trigger.`
    case 'condition-trigger-removed': return `A condition trigger was removed from ${issue.agentId} because its state port was disconnected.`
    case 'trigger-removed': return `A request trigger was removed from ${issue.agentId} because no sender remained bound.`
    case 'handoff-removed': return `Handoff ${issue.handoffId} was removed from ${issue.agentId} because its target port was disconnected.`
    case 'context-selection-removed': return `The ${issue.sourceType} context selection was removed from ${issue.agentId} because its state port was disconnected.`
    case 'context-selection-outside-scene': return `The selected state path does not belong to scene_state, so that context selection was removed from ${issue.agentId}.`
    case 'invalid-agent-binding': return `Agent port “${issue.portId}” must connect to an existing or imported agent, or be explicitly disconnected.`
    case 'invalid-state-binding': return `State port “${issue.portId}” must connect to a valid namespace and JSON Pointer, or be explicitly disconnected.`
    case 'invalid-context-state-binding': return `Context state port “${issue.portId}” must connect to a world path; the selection was omitted.`
    case 'unknown-agent-port': return `The component refers to unknown agent port “${issue.portId}” at ${issue.where}.`
    case 'unknown-state-port': return `The component refers to unknown state port “${issue.portId}” at ${issue.where}.`
    case 'unknown-component-agent-ref': return `The component refers to undeclared agent “${issue.agentRef}” at ${issue.where}; connect it through an explicit port.`
    case 'unknown-component-state-ref': return `The component refers to undeclared state “${issue.namespace}${issue.path}” at ${issue.where}; connect it through an explicit port.`
    case 'author-parameter-agent-unresolved': return `The author parameter agent reference at ${issue.where} is unresolved; bind its port before importing.`
    case 'author-parameter-state-unresolved': return `The author parameter state reference at ${issue.where} is unresolved; bind its port before importing.`
    case 'merged-config-invalid': return `The merged draft does not satisfy the team configuration schema: ${issue.message}`
    default: return 'Review this component import issue before applying the draft.'
  }
}
function stableAgentId(importId, localId) {
  const slug = value => value.toLowerCase().replace(/[^a-z0-9_-]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 22) || 'item'
  return `component-${slug(importId)}-${digest(importId).slice(0, 8)}-${slug(localId)}-${digest(localId).slice(0, 6)}`
}
function requires040(config) {
  return Boolean(config.authorParameters?.length || config.memory?.collections?.length || config.execution.budget
    || config.agents.some(agent => agent.triggers.some(trigger => ['periodic', 'state_changed', 'message_received', 'keyword'].includes(trigger.type)
      || trigger.cooldownTurns !== undefined || trigger.id !== undefined)))
}
function rewriteParameterTokens(value, ids) {
  if (typeof value === 'string') {
    return value.replace(/\{\{param:([^}]+)\}\}/gu, (token, id) => {
      const mapped = ids instanceof Map ? ids.get(id) : Object.hasOwn(ids, id) ? ids[id] : undefined
      return mapped === undefined ? token : `{{param:${mapped}}}`
    })
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) value[index] = rewriteParameterTokens(value[index], ids)
    return value
  }
  if (isRecord(value)) {
    for (const key of Object.keys(value)) value[key] = rewriteParameterTokens(value[key], ids)
  }
  return value
}
function digest(value) { return createHash('sha256').update(String(value), 'utf8').digest('hex') }
function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (isRecord(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`
  return JSON.stringify(value)
}
function requiredText(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw teamError('RP_TEAM_INVALID_REQUEST', `${label} is required`)
  return value.trim()
}
function requireStringList(value, label) {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || !item.trim())) {
    throw teamError('RP_TEAM_INVALID_REQUEST', `${label} must be a list of non-empty strings`)
  }
  return [...new Set(value.map(item => item.trim()))]
}
function isRecord(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) }
