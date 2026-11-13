import { createHash } from 'node:crypto'
import { readSessionEvents } from './session-event-policy.mjs'
import { resolveAuthorParameters } from '../shared/author-parameters.mjs'
import {
  normalizeTeamConfig,
  teamError
} from '../shared/schema.mjs'
import {
  projectStateValueForAgent,
  validateConfiguredStateSnapshot,
  versionForPath
} from './state-store.mjs'

/** Author-facing state reads and edits. All edits are journaled before host receipts are written. */
export function createAuthorStateApi({ ctx, store, stateStore, recoveryReady, isConversationBusy = () => false, getRunRecords = () => [], reconcileBranch = async () => undefined }) {
  const conversations = ctx.eleckoiConversationsApi
  if (!conversations) throw new Error('ElecKoi Conversations API is required for author state APIs')

  const recovered = Promise.resolve(recoveryReady).then(recoverPendingEdits)

  async function getState({ conversationId, agentId, runId }) {
    await recovered
    await reconcileBranch(conversationId)
    const view = await readStateView(conversationId, runId)
    const selectedAgent = agentId ? view.config.agents.find(item => item.id === agentId) : undefined
    if (agentId && !selectedAgent) throw teamError('RP_TEAM_AGENT_NOT_FOUND', `Unknown state agent ${agentId}`)
    const definitions = selectedAgent
      ? view.definitions.filter(item => hasReadableValue(selectedAgent, item.namespace, item.path))
      : view.definitions
    const values = definitions.flatMap(definition => {
      const raw = getPointer(view.namespaces[definition.namespace], definition.path)
      const visible = selectedAgent && raw !== undefined
        ? projectStateValueForAgent(selectedAgent, definition.namespace, definition.path, raw)
        : raw
      if (visible === undefined && raw !== undefined) return []
      if (visible === undefined && raw === undefined && selectedAgent
        && !hasReadableValue(selectedAgent, definition.namespace, definition.path)) return []
      const initial = Object.hasOwn(definition, 'default')
        ? selectedAgent
          ? projectStateValueForAgent(selectedAgent, definition.namespace, definition.path, definition.default)
          : cloneJson(definition.default)
        : undefined
      const staged = view.stagedValues.get(pathKey(definition.namespace, definition.path))
      const stagedValue = staged && staged.value !== undefined && selectedAgent
        ? projectStateValueForAgent(selectedAgent, definition.namespace, definition.path, staged.value)
        : staged?.value
      const stagedAllowed = Boolean(staged) && (!selectedAgent || staged.value === undefined || stagedValue !== undefined)
      const stagedChanged = stagedAllowed && (!selectedAgent
        || missingProjectionDiffers(visible, raw === undefined, stagedValue, staged.value === undefined))
      return [{
        namespace: definition.namespace,
        path: definition.path,
        ...(visible === undefined ? {} : { value: cloneJson(visible) }),
        missing: raw === undefined,
        ...(initial === undefined ? {} : { initial: cloneJson(initial) }),
        version: definition.namespace === 'world'
          ? view.hostRevision
          : versionForPath(view.committed.pathVersions, definition.namespace, definition.path),
        ...(stagedChanged ? {
          staged: true,
          ...(stagedValue === undefined ? {} : { stagedValue: cloneJson(stagedValue) }),
          stagedMissing: stagedValue === undefined
        } : {})
      }]
    })
    return {
      conversationId: view.conversationId,
      revision: view.revision,
      worldHash: view.worldHash,
      anchor: view.anchor,
      busy: view.busy,
      pendingEdits: pendingFor(view.conversationId),
      definitions: selectedAgent ? definitions.map(withoutDefault) : definitions,
      values,
      ...(view.issues.length ? { issues: view.issues } : {})
    }
  }

  async function applyStateEdit(input) {
    await recovered
    const conversationId = requiredText(input.conversationId, 'conversationId')
    const operationId = requiredText(input.operationId, 'operationId')
    await reconcileBranch(conversationId)
    const identity = {
      expectedRevision: input.expectedRevision,
      ...(input.expectedWorldHash === undefined ? {} : { expectedWorldHash: input.expectedWorldHash }),
      ...(input.anchor === undefined ? {} : { anchor: input.anchor }),
      operations: input.operations
    }
    const existing = stateStore.getAuthorEdit(conversationId, operationId)
    if (existing.status !== 'unknown') {
      if (stableJson(existing.identity) !== stableJson(identity)) {
        throw teamError('RP_TEAM_AUTHOR_EDIT_CONFLICT', 'An author operation id cannot be reused for different edits')
      }
      let settled = existing.hostRequired
        ? await settlePendingEdit(conversationId, existing)
        : stateStore.commitAuthorEdit({ conversationId, operationId })
      if (settled.status === 'pending' && settled.hostRequired) {
        const hostStatus = await conversations.stateEditStatus({ conversationId, operationId })
        if (hostStatus.outcome === 'unknown') {
          const hostReceipt = await conversations.editCurrentState(authorEditHostPayload(existing))
          settled = settleAuthorEditReceipt(stateStore, conversationId, operationId, hostReceipt)
        } else if (hostStatus.outcome === 'committed') {
          settled = settleAuthorEditReceipt(stateStore, conversationId, operationId, hostStatus)
        } else if (['failed', 'cancelled'].includes(hostStatus.outcome)) {
          settled = stateStore.failAuthorEdit({ conversationId, operationId, reason: hostStatus.error ?? `ElecKoi state edit was ${hostStatus.outcome}` })
        }
      }
      if (settled.status === 'committed') return { operationId, status: 'committed', state: await getState({ conversationId }) }
      if (settled.status === 'failed') return { operationId, status: 'failed', error: settled.reason }
      return { operationId, status: 'pending' }
    }

    if (await isConversationBusy(conversationId)) throw conversationBusy()
    let editBegun = false
    try {
      const view = await readStateView(conversationId)
      assertExpectedState(input, view)
      const next = applyAuthorStateOperations(view, input.operations)
      const pluginChanged = stableJson(view.committed.namespaces) !== stableJson(next.pluginNamespaces)
      const nextRevision = view.committed.revision + (pluginChanged ? 1 : 0)
      const afterSnapshot = {
        revision: nextRevision,
        namespaces: next.pluginNamespaces,
        pathVersions: next.pathVersions
      }
      const hostOperations = next.normalizedOperations.filter(item => item.namespace === 'world')
      const hostRequired = hostOperations.length > 0
      const hostPayload = hostRequired ? {
        conversationId,
        operationId,
        expectedWorldHash: view.worldHash,
        anchor: input.anchor ?? view.anchor,
        ...(stableJson(view.host.rawWorld.variables) === stableJson(next.world.variables)
          ? {} : { variableStateJson: JSON.stringify(next.world.variables) }),
        ...(stableJson(view.host.settingLibrary) === stableJson(next.settingLibrary)
          ? {} : { settingLibrary: cloneJson(next.settingLibrary) })
      } : undefined
      stateStore.beginAuthorEdit({
        conversationId,
        operationId,
        expectedRevision: view.committed.revision,
        beforeSnapshot: view.committed,
        afterSnapshot,
        operations: next.normalizedOperations,
        anchor: input.anchor ?? view.anchor,
        identity,
        worldBefore: { ...view.host.rawWorld, settingLibrary: view.host.settingLibrary, worldHash: view.worldHash },
        worldAfter: { ...next.world, settingLibrary: next.settingLibrary },
        hostRequired
      })
      editBegun = true

      let hostReceipt
      if (hostRequired) {
        const result = await conversations.editCurrentState(hostPayload)
        if (['failed', 'cancelled'].includes(result?.outcome)) {
          const failed = stateStore.failAuthorEdit({ conversationId, operationId, reason: result.error ?? `ElecKoi state edit was ${result.outcome}` })
          return { operationId, status: 'failed', error: failed.reason }
        }
        if (result?.outcome !== 'committed') return { operationId, status: 'pending' }
        hostReceipt = nativeAuthorReceipt(result)
      }
      const receipt = stateStore.commitAuthorEdit({ conversationId, operationId, hostReceipt })
      if (receipt.status === 'pending') return { operationId, status: 'pending' }
      return { operationId, status: receipt.status, state: await getState({ conversationId }), receipt }
    } catch (error) {
      const receipt = stateStore.getAuthorEdit(conversationId, operationId)
      if (receipt.status === 'pending') {
        const resolved = await settlePendingEdit(conversationId, receipt)
        if (resolved.status === 'committed') return { operationId, status: 'committed', state: await getState({ conversationId }) }
        if (resolved.status === 'pending') return { operationId, status: 'pending' }
      }
      if (receipt.status === 'unknown' && !editBegun) throw error
      if (receipt.status === 'unknown') stateStore.failAuthorEdit({ conversationId, operationId, reason: error.message ?? String(error) })
      throw error
    }
  }

  async function getStateEditStatus({ conversationId, operationId }) {
    await recovered
    const receipt = stateStore.getAuthorEdit(conversationId, operationId)
    if (receipt.status === 'unknown') {
      const host = await conversations.stateEditStatus({ conversationId, operationId })
      return { operationId, status: host.outcome === 'unknown' ? 'not_found' : host.outcome, ...(host.error ? { error: host.error } : {}) }
    }
    const settled = await settlePendingEdit(conversationId, receipt)
    if (settled.status === 'unknown') return { operationId, status: 'not_found' }
    return {
      operationId,
      status: settled.status,
      ...(settled.reason ? { error: settled.reason } : {})
    }
  }

  async function listStateCheckpoints({ conversationId }) {
    await recovered
    await reconcileBranch(conversationId)
    const view = await readStateView(conversationId)
    const result = [{
      id: 'current', label: '当前聊天状态', anchor: view.anchor,
      values: valuesFrom(view.definitions, view.namespaces, view.committed.pathVersions),
      branchStatus: 'current', canRewind: false
    }]
    const hostEdits = await conversations.listStateEdits({ conversationId })
    const hostByOperation = new Map((hostEdits.edits ?? []).map(edit => [edit.operationId, edit]))
    const authorEdits = stateStore.listAuthorEdits(conversationId)
    for (const hostEdit of hostEdits.edits ?? []) {
      if (hostEdit.outcome !== 'committed') continue
      const localEdit = authorEdits.find(item => item.operationId === hostEdit.operationId && item.status === 'committed')
      const checkpointAnchor = hostEdit.anchor ?? localEdit?.hostReceipt?.anchor ?? localEdit?.anchor
      if (hostEdit.legacyStateUnavailable) {
        const values = view.definitions.length
          ? view.definitions.map(item => ({ namespace: item.namespace, path: item.path, missing: true, unknown: true, version: 0 }))
          : [{ namespace: 'world', path: '', missing: true, unknown: true, version: 0 }]
        result.push({
          id: `author:${hostEdit.operationId}`, label: `作者编辑 ${hostEdit.revision}（旧状态仅归档）`,
          anchor: checkpointAnchor, values, branchStatus: 'archived', canRewind: false,
          legacyStateUnavailable: true,
          ...(hostEdit.legacyWorldBeforeJson !== undefined ? { legacyWorldBeforeJson: hostEdit.legacyWorldBeforeJson } : {}),
          ...(hostEdit.legacyWorldAfterJson !== undefined ? { legacyWorldAfterJson: hostEdit.legacyWorldAfterJson } : {})
        })
        continue
      }
      if (!hostEdit.after || !hostEdit.before) continue
      const canRewind = await isAnchorActive(ctx, checkpointAnchor, hostEdit.active ?? localEdit?.hostReceipt?.active)
      const unknownPlugin = localEdit ? [] : view.definitions.filter(item => item.namespace !== 'world').map(item => item.namespace)
      result.push(stateEditCheckpoint({
        id: `author:${hostEdit.operationId}:before`, label: `作者编辑前 ${hostEdit.revision}`,
        anchor: checkpointAnchor, world: worldFromAuthorState(hostEdit.before),
        namespaces: localEdit?.beforeSnapshot.namespaces ?? view.committed.namespaces,
        pathVersions: localEdit?.beforeSnapshot.pathVersions ?? view.committed.pathVersions,
        unknownPlugin, definitions: view.definitions, canRewind
      }))
      result.push(stateEditCheckpoint({
        id: `author:${hostEdit.operationId}`, label: `作者编辑 ${hostEdit.revision}`,
        anchor: checkpointAnchor, world: worldFromAuthorState(hostEdit.after),
        namespaces: localEdit?.afterSnapshot.namespaces ?? view.committed.namespaces,
        pathVersions: localEdit?.afterSnapshot.pathVersions ?? view.committed.pathVersions,
        unknownPlugin, definitions: view.definitions, canRewind
      }))
    }
    for (const edit of authorEdits) {
      if (edit.status !== 'committed' || hostByOperation.has(edit.operationId)) continue
      const checkpointAnchor = edit.anchor
      const canRewind = await isAnchorActive(ctx, checkpointAnchor, edit.hostReceipt?.active)
      result.push(stateEditCheckpoint({
        id: `author:${edit.operationId}:before`, label: `作者编辑前 ${edit.revision}`,
        anchor: checkpointAnchor, world: worldFromLocalWorld(edit.worldBefore),
        namespaces: edit.beforeSnapshot.namespaces, pathVersions: edit.beforeSnapshot.pathVersions,
        unknownPlugin: [], definitions: view.definitions, canRewind
      }))
      result.push(stateEditCheckpoint({
        id: `author:${edit.operationId}`, label: `作者编辑 ${edit.revision}`,
        anchor: checkpointAnchor, world: worldFromLocalWorld(edit.worldAfter),
        namespaces: edit.afterSnapshot.namespaces, pathVersions: edit.afterSnapshot.pathVersions,
        unknownPlugin: [], definitions: view.definitions, canRewind
      }))
    }
    for (const run of committedRuns(stateStore.readConversation(conversationId))) {
      const receipt = await conversations.turnCommitStatus({ conversationId, runId: run.runId })
      const anchor = runAnchor({ ...run, receipt })
      if (!anchor) continue
      const runState = committedRunState(run)
      const canRewind = await isAnchorActive(ctx, anchor, receipt.active)
      result.push({
        id: `run:${run.runId}`,
        label: `Team 运行 ${run.runId}`,
        anchor,
        values: valuesFrom(view.definitions, runState.namespaces, runState.pathVersions, runState.unknownNamespaces),
        branchStatus: canRewind ? 'available' : 'missing',
        canRewind
      })
    }
    return { checkpoints: result }
  }

  async function restoreStateCheckpoint(input) {
    await recovered
    const current = await getState({ conversationId: input.conversationId })
    if (current.revision !== input.expectedRevision
      || (input.expectedWorldHash !== undefined && current.worldHash !== input.expectedWorldHash)) {
      throw teamError('RP_TEAM_AUTHOR_EDIT_CONFLICT', 'State changed while preparing checkpoint restore')
    }
    const checkpoint = (await listStateCheckpoints({ conversationId: input.conversationId })).checkpoints
      .find(item => item.id === input.checkpointId)
    if (!checkpoint) throw teamError('RP_TEAM_CHECKPOINT_NOT_FOUND', 'Unknown state checkpoint')
    if (!['values', 'rewind'].includes(input.mode)) throw teamError('RP_TEAM_CHECKPOINT_MODE_INVALID', 'Checkpoint mode must be values or rewind')
    if (input.mode === 'rewind' && !checkpoint.canRewind) throw teamError('RP_TEAM_CHECKPOINT_UNAVAILABLE', 'This checkpoint is no longer on the current Session branch')
    const selected = new Set((input.paths ?? []).map(item => pathKey(item.namespace, item.path)))
    const operations = checkpoint.values
      .filter(item => (item.path !== '' || item.namespace !== 'world')
        && !item.unknown && (!selected.size || selected.has(pathKey(item.namespace, item.path))))
      .map(item => item.missing
        ? { namespace: item.namespace, path: item.path, operation: 'remove' }
        : { namespace: item.namespace, path: item.path, operation: 'set', value: cloneJson(item.value) })
    if (!operations.length) throw teamError('RP_TEAM_CHECKPOINT_VALUES_UNAVAILABLE', 'This checkpoint has no provable values to restore')
    return applyStateEdit({
      conversationId: input.conversationId,
      operationId: input.operationId,
      expectedRevision: input.expectedRevision,
      expectedWorldHash: current.worldHash,
      anchor: current.anchor,
      operations
    })
  }

  async function readStateView(conversationId, runId) {
    const id = requiredText(conversationId, 'conversationId')
    const saved = store.get(id)
    const frozenRun = runId ? getRunRecords(id).find(record => (record.status?.runId ?? record.runId) === runId) : undefined
    const config = frozenRun?.config ? normalizeTeamConfig(frozenRun.config) : resolveAuthorParameters(saved.config, saved.parameterValues).config
    const [details, authorState, hostEdits] = await Promise.all([
      conversations.details(id),
      conversations.authorState(id),
      conversations.listStateEdits({ conversationId: id })
    ])
    const runtimeSessionId = String(details.runtimeSessionId ?? '')
    let sessionEvents = []
    if (runtimeSessionId) sessionEvents = await readSessionEvents(ctx, runtimeSessionId)
    const variables = parseObject(authorState.editableVariableStateJson ?? authorState.currentVariableStateJson)
    const initialVariables = parseObject(authorState.initialVariableStateJson)
    const settingLibrary = authorState.editableSettingLibrary !== undefined
      ? cloneJson(authorState.editableSettingLibrary)
      : cloneJson(authorState.settingLibrary ?? { groups: [], entries: [] })
    const host = {
      rawWorld: { variables, settings: settingContents(settingLibrary) },
      initialWorld: { variables: initialVariables, settings: {} },
      settingLibrary,
      anchor: latestSessionAnchor(runtimeSessionId, sessionEvents),
      busy: Boolean(await isConversationBusy(id))
    }
    const committed = stateStore.committedSnapshot({ conversationId: id })
    const namespaces = { ...cloneJson(committed.namespaces), world: cloneJson(host.rawWorld) }
    const definitions = withNativeDefinitions(config.state.definitions, host)
    if (runId) {
      const run = own(stateStore.readConversation(id).runs, runId)
      if (!run) throw teamError('RP_TEAM_STATE_RUN_NOT_FOUND', `Unknown state run ${runId}`)
    }
    const issues = []
    try { validateConfiguredStateSnapshot(config, namespaces) }
    catch (error) { issues.push({ code: error?.code ?? 'RP_TEAM_STATE_INVALID', message: String(error?.message ?? error) }) }
    const hostRevision = Math.max(0, ...(hostEdits.edits ?? []).map(item => Number(item.revision) || 0))
    const records = stateStore.listAuthorEdits(id)
    const revision = committed.revision + hostRevision
    const worldHash = hashJson({ variables, settingLibrary })
    const activeRecords = typeof getRunRecords === 'function' ? getRunRecords(id) : []
    const storedRuns = Object.values(stateStore.readConversation(id).runs)
    const stagedRun = runId
      ? storedRuns.find(item => item.runId === runId && ['open', 'pending'].includes(item.status))
      : selectStagedRun(storedRuns, activeRecords)
    const stagedValues = stagedRun ? stagedValueMap(stagedRun) : new Map()
    return {
      conversationId: id, config, host, committed, namespaces, definitions,
      hostRevision, revision, worldHash,
      anchor: host.anchor,
      busy: host.busy,
      issues,
      pending: records.filter(item => item.status === 'pending'),
      stagedValues,
      stagedRunId: stagedRun?.runId,
      runRecords: activeRecords
    }
  }

  async function recoverPendingEdits() {
    for (const item of stateStore.pendingAuthorEdits()) await settlePendingEdit(item.conversationId, item)
  }

  async function settlePendingEdit(conversationId, edit) {
    if (edit.status !== 'pending') return edit
    if (!edit.hostRequired) {
      const committed = stateStore.commitAuthorEdit({ conversationId, operationId: edit.operationId })
      return committed
    }
    const host = await conversations.stateEditStatus({ conversationId, operationId: edit.operationId })
    if (host.outcome === 'committed') {
      return settleAuthorEditReceipt(stateStore, conversationId, edit.operationId, host)
    }
    if (['failed', 'cancelled'].includes(host.outcome)) {
      const failed = stateStore.failAuthorEdit({ conversationId, operationId: edit.operationId, reason: host.error ?? `ElecKoi state edit was ${host.outcome}` })
      return failed
    }
    return edit
  }

  function pendingFor(conversationId) {
    return stateStore.listAuthorEdits(conversationId).filter(edit => edit.status === 'pending').map(edit => ({
      operationId: edit.operationId, status: edit.status
    }))
  }

  function assertExpectedState(input, view) {
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision !== view.revision) {
      throw teamError('RP_TEAM_AUTHOR_EDIT_CONFLICT', `State revision is ${view.revision}, not ${input.expectedRevision}`)
    }
    if (input.expectedWorldHash !== undefined && input.expectedWorldHash !== view.worldHash) {
      throw teamError('RP_TEAM_AUTHOR_EDIT_CONFLICT', 'State world hash changed while preparing the author edit')
    }
    if (input.anchor !== undefined && stableJson(input.anchor) !== stableJson(view.anchor)) {
      throw teamError('RP_TEAM_AUTHOR_EDIT_CONFLICT', 'Session anchor changed while preparing the author edit')
    }
  }

  return {
    ready: recovered,
    getState,
    listStateCheckpoints,
    applyStateEdit,
    getStateEditStatus,
    restoreStateCheckpoint,
    dispose() {}
  }

}

function withNativeDefinitions(definitions, host) {
  const byKey = new Map(definitions.map(item => [pathKey(item.namespace, item.path), structuredClone(item)]))
  const initial = parseObject(host.initialWorld?.variables ?? {})
  const variableKeys = new Set([...Object.keys(host.rawWorld?.variables ?? {}), ...Object.keys(initial)])
  for (const key of variableKeys) {
    const value = Object.hasOwn(host.rawWorld?.variables ?? {}, key) ? host.rawWorld.variables[key] : initial[key]
    const path = `/variables/${escapePointer(key)}`
    const existing = byKey.get(pathKey('world', path)) ?? {}
    const stateDefinition = { ...existing, namespace: 'world', path, type: existing.type ?? valueType(value), description: existing.description ?? '角色变量' }
    if (!Object.hasOwn(stateDefinition, 'default') && Object.hasOwn(initial, key)) stateDefinition.default = cloneJson(initial[key])
    byKey.set(pathKey('world', path), stateDefinition)
  }
  for (const [entryId, content] of Object.entries(host.rawWorld?.settings ?? {})) {
    const path = `/settings/${escapePointer(entryId)}`
    const existing = byKey.get(pathKey('world', path)) ?? {}
    byKey.set(pathKey('world', path), { ...existing, namespace: 'world', path, type: existing.type ?? 'string', description: existing.description ?? '对话设定源文本' })
  }
  return [...byKey.values()]
}

function applyAuthorStateOperations(view, operations) {
  if (!Array.isArray(operations) || operations.length === 0) throw teamError('RP_TEAM_AUTHOR_EDIT_INVALID', 'At least one state operation is required')
  const configDefinitions = view.definitions
  const pluginNamespaces = cloneJson(view.committed.namespaces)
  let world = cloneJson(view.host.rawWorld)
  let settingLibrary = cloneJson(view.host.settingLibrary)
  const normalizedOperations = []
  const pathVersions = { ...view.committed.pathVersions }
  const nextRevision = view.committed.revision + 1
  const touched = new Set()
  for (const input of operations) {
    if (!input || typeof input !== 'object' || Array.isArray(input)
      || typeof input.namespace !== 'string' || typeof input.path !== 'string'
      || !['set', 'remove', 'reset'].includes(input.operation)) {
      throw teamError('RP_TEAM_AUTHOR_EDIT_INVALID', 'Each operation needs a namespace, JSON Pointer path, and set/remove/reset operation')
    }
    if (input.path !== '' && !input.path.startsWith('/')) throw teamError('RP_TEAM_STATE_PATH_INVALID', 'State edits require a JSON Pointer')
    if (input.namespace === 'world' && !input.path) throw teamError('RP_TEAM_STATE_PATH_INVALID', 'Native world root edits are not supported')
    const definition = configDefinitions
      .filter(item => item.namespace === input.namespace && pathWithin(item.path, input.path))
      .sort((left, right) => right.path.length - left.path.length)[0]
    if (!definition) throw teamError('RP_TEAM_STATE_PATH_UNDEFINED', `State path ${input.namespace}${input.path} is not declared`)
    let operation = input.operation
    let value = input.value
    if (operation === 'reset') {
      if (!definition || !Object.hasOwn(definition, 'default')) throw teamError('RP_TEAM_AUTHOR_RESET_UNAVAILABLE', 'This state path has no configured default')
      operation = 'set'
      const suffix = input.path.slice(definition.path.length)
      value = suffix ? getPointer(definition.default, suffix) : definition.default
      if (value === undefined) throw teamError('RP_TEAM_AUTHOR_RESET_UNAVAILABLE', 'This state path has no configured default')
      value = cloneJson(value)
    }
    if (operation === 'set' && !Object.hasOwn(input, 'value') && input.operation !== 'reset') {
      throw teamError('RP_TEAM_AUTHOR_EDIT_INVALID', 'set requires a JSON value')
    }
    if (operation === 'set' && !isJsonValue(value)) throw teamError('RP_TEAM_INVALID_STATE', 'State values must be JSON serializable')
    if (input.namespace === 'world') {
      const target = getPointer(world, input.path)
      if (input.operation === 'remove' && target === undefined) throw teamError('RP_TEAM_STATE_PATH_UNDEFINED', 'Cannot remove a missing state path')
      if (input.path.startsWith('/settings/')) {
        if (operation !== 'set' || typeof value !== 'string' || target === undefined) {
          throw teamError('RP_TEAM_AUTHOR_EDIT_INVALID', 'Only existing setting files can be replaced with text')
        }
      }
      if (operation === 'remove') deletePointer(world, input.path)
      else setPointer(world, input.path, value)
      if (input.path.startsWith('/settings/')) {
        const entryId = decodePointer(input.path).at(1)
        const entry = settingLibrary?.entries?.find(item => item.id === entryId)
        if (!entry) throw teamError('RP_TEAM_STATE_PATH_UNDEFINED', `Unknown SettingLibrary entry ${entryId}`)
        entry.content = value
      }
      normalizedOperations.push({ namespace: input.namespace, path: input.path, operation, ...(operation === 'set' ? { value: cloneJson(value) } : {}) })
    } else {
      if (input.namespace !== 'shared' && !input.namespace.startsWith('private:')) {
        throw teamError('RP_TEAM_STATE_PATH_INVALID', `Unsupported author state namespace ${input.namespace}`)
      }
      pluginNamespaces[input.namespace] ??= {}
      const target = getPointer(pluginNamespaces[input.namespace], input.path)
      if (!input.path) {
        if (operation === 'remove') delete pluginNamespaces[input.namespace]
        else pluginNamespaces[input.namespace] = cloneJson(value)
      } else if (operation === 'remove') {
        if (target === undefined) throw teamError('RP_TEAM_STATE_PATH_UNDEFINED', `Cannot remove missing ${input.namespace}${input.path}`)
        deletePointer(pluginNamespaces[input.namespace], input.path)
      } else setPointer(pluginNamespaces[input.namespace], input.path, value)
      pathVersions[pathKey(input.namespace, input.path)] = nextRevision
      touched.add(pathKey(input.namespace, input.path))
      normalizedOperations.push({ namespace: input.namespace, path: input.path, operation, ...(operation === 'set' ? { value: cloneJson(value) } : {}) })
    }
  }
  validateConfiguredStateSnapshot(view.config, { ...pluginNamespaces, world })
  return { pluginNamespaces, world, settingLibrary, pathVersions, touched, normalizedOperations }
}

function canRead(agent, namespace, path) {
  const rules = agent.statePermissions.filter(item => item.namespace === namespace
    && (item.path === '' || item.path === path || path.startsWith(`${item.path}/`)))
    .sort((a, b) => b.path.length - a.path.length)
  return ['read', 'readwrite'].includes(rules[0]?.access)
}

function hasReadableValue(agent, namespace, path) {
  if (canRead(agent, namespace, path)) return true
  return agent.statePermissions.some(rule => rule.namespace === namespace
    && pathWithin(path, rule.path)
    && ['read', 'readwrite'].includes(rule.access)
    && canRead(agent, namespace, rule.path))
}

function pathWithin(parent, child) { return parent === '' || parent === child || child.startsWith(`${parent}/`) }

function withoutDefault(definition) {
  const result = { ...definition }
  delete result.default
  return result
}

function valuesFrom(definitions, namespaces, pathVersions, unknownNamespaces = []) {
  return definitions.map(definition => {
    const value = getPointer(namespaces[definition.namespace], definition.path)
    return {
      namespace: definition.namespace, path: definition.path,
      ...(value === undefined ? {} : { value: cloneJson(value) }),
      missing: value === undefined,
      ...(unknownNamespaces.includes(definition.namespace) ? { unknown: true } : {}),
      ...(Object.hasOwn(definition, 'default') ? { initial: cloneJson(definition.default) } : {}),
      version: versionForPath(pathVersions, definition.namespace, definition.path)
    }
  })
}

function missingProjectionDiffers(current, currentMissing, staged, stagedMissing) {
  if (currentMissing !== stagedMissing) return true
  if (staged === undefined) return false
  return stableJson(current) !== stableJson(staged)
}

function committedRuns(record) {
  return Object.values(record.runs ?? {}).filter(run => run.status === 'committed')
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
}

function runAnchor(run) {
  const receipt = run.receipt
  if (!receipt || !Number.isSafeInteger(receipt.turn) || !Number.isSafeInteger(receipt.assistantSeq)
    || !receipt.sessionId || !receipt.assistantMessageId) return undefined
  return {
    sessionId: receipt.sessionId, turn: receipt.turn,
    ...(receipt.inputMessageId ? { inputMessageId: receipt.inputMessageId } : {}),
    ...(Number.isSafeInteger(receipt.inputEventSeq) ? { inputEventSeq: receipt.inputEventSeq } : {}),
    assistantMessageId: receipt.assistantMessageId, assistantSeq: receipt.assistantSeq
  }
}

function committedRunState(run) {
  const prior = cloneJson(run.priorCommittedState ?? { revision: 0, namespaces: {}, pathVersions: {} })
  const namespaces = { ...cloneJson(run.state ?? prior.namespaces) }
  const pathVersions = { ...prior.pathVersions }
  const revision = prior.revision + 1
  for (const write of run.writes ?? []) {
    namespaces[write.namespace] ??= {}
    if (write.operation === 'remove') deletePointer(namespaces[write.namespace], write.path)
    else setPointer(namespaces[write.namespace], write.path, write.value)
    pathVersions[pathKey(write.namespace, write.path)] = revision
  }
  return {
    revision, namespaces, pathVersions,
    unknownNamespaces: Object.hasOwn(run.state ?? {}, 'world') ? [] : ['world']
  }
}

function selectStagedRun(runs, activeRecords) {
  const staged = runs.filter(item => ['open', 'pending'].includes(item.status))
  if (staged.length <= 1) return staged[0]
  const activeIds = new Set((activeRecords ?? []).map(item => item.runId ?? item.id))
  return staged.find(item => activeIds.has(item.runId))
}

function stagedValueMap(run) {
  const namespaces = cloneJson(run.state ?? {})
  for (const write of run.writes ?? []) {
    namespaces[write.namespace] ??= {}
    if (write.operation === 'remove') deletePointer(namespaces[write.namespace], write.path)
    else setPointer(namespaces[write.namespace], write.path, write.value)
  }
  const changed = new Set((run.writes ?? []).map(item => pathKey(item.namespace, item.path)))
  const result = new Map()
  for (const definition of run.config?.state?.definitions ?? []) {
    const definitionKey = pathKey(definition.namespace, definition.path)
    if ([...changed].some(key => {
      const [namespace, path] = JSON.parse(key)
      return namespace === definition.namespace
        && (pathWithin(path, definition.path) || pathWithin(definition.path, path))
    })) {
      result.set(definitionKey, { value: getPointer(namespaces[definition.namespace], definition.path) })
    }
  }
  for (const key of changed) {
    const [namespace, path] = JSON.parse(key)
    result.set(pathKey(namespace, path), { value: getPointer(namespaces[namespace], path) })
  }
  return result
}

function settingContents(library) {
  return Object.fromEntries((library?.entries ?? []).filter(entry => typeof entry.id === 'string' && typeof entry.content === 'string')
    .map(entry => [entry.id, entry.content]))
}

function worldFromAuthorState(state) {
  if (!state || typeof state !== 'object') return undefined
  return {
    variables: parseObject(state.variableStateJson),
    settings: settingContents(state.settingLibrary)
  }
}

function worldFromLocalWorld(world) {
  if (!world || typeof world !== 'object') return undefined
  return { variables: cloneJson(world.variables ?? {}), settings: cloneJson(world.settings ?? {}) }
}

function stateEditCheckpoint({ id, label, anchor, world, namespaces, pathVersions, unknownPlugin, definitions, canRewind }) {
  const snapshot = { ...cloneJson(namespaces ?? {}), ...(world ? { world } : {}) }
  const unknown = [...unknownPlugin]
  if (!world) unknown.push('world')
  return {
    id, label, anchor,
    values: valuesFrom(definitions, snapshot, pathVersions, unknown),
    branchStatus: canRewind ? 'available' : 'missing', canRewind
  }
}

function nativeAuthorReceipt(receipt) {
  if (!receipt || receipt.outcome !== 'committed') return undefined
  return { ...receipt, status: 'committed' }
}

function settleAuthorEditReceipt(stateStore, conversationId, operationId, receipt) {
  const normalized = nativeAuthorReceipt(receipt)
  if (!normalized) return { operationId, status: 'pending' }
  return stateStore.commitAuthorEdit({ conversationId, operationId, hostReceipt: normalized })
}

function authorEditHostPayload(edit) {
  const before = edit.worldBefore ?? {}
  const after = edit.worldAfter ?? {}
  return {
    conversationId: edit.conversationId,
    operationId: edit.operationId,
    expectedWorldHash: edit.worldBefore?.worldHash ?? edit.identity.expectedWorldHash,
    ...(edit.anchor ? { anchor: edit.anchor } : {}),
    ...(stableJson(before.variables) === stableJson(after.variables) || after.variables === undefined
      ? {} : { variableStateJson: JSON.stringify(after.variables) }),
    ...(stableJson(before.settingLibrary) === stableJson(after.settingLibrary) || after.settingLibrary === undefined
      ? {} : { settingLibrary: cloneJson(after.settingLibrary) })
  }
}

async function isAnchorActive(ctx, anchor, active) {
  if (typeof active === 'boolean') return active
  if (!anchor?.sessionId || !Number.isSafeInteger(anchor.turn)) return false
  const events = await readSessionEvents(ctx, anchor.sessionId)
  const identityExists = (id, seq, role) => events.some(event => {
    const data = event?.data ?? event
    const message = data?.message ?? data?.item ?? data
    return (!role || message?.role === role || event?.type === `${role}/message`)
      && (!id || message?.id === id || data?.messageId === id)
      && (!Number.isSafeInteger(seq) || event?.seq === seq || data?.seq === seq)
  })
  if (anchor.inputMessageId && !identityExists(anchor.inputMessageId, anchor.inputEventSeq, 'user')) return false
  if (anchor.assistantMessageId && !identityExists(anchor.assistantMessageId, anchor.assistantSeq, 'assistant')) return false
  return Boolean(anchor.inputMessageId || anchor.assistantMessageId || events.some(event => {
    const data = event?.data ?? event
    return event?.type === 'turn/end' && data?.turn === anchor.turn
  }))
}

function latestSessionAnchor(sessionId, events) {
  if (!sessionId || !Array.isArray(events)) return undefined
  const turnEndIndexes = events.map((event, index) => event?.type === 'turn/end' ? index : -1).filter(index => index >= 0)
  const turnEndIndex = turnEndIndexes.at(-1)
  const turnEnd = turnEndIndex === undefined ? undefined : events[turnEndIndex]
  if (!turnEnd) return undefined
  const turn = (turnEnd.data ?? turnEnd).turn
  const priorTurnEndIndex = turnEndIndexes.at(-2) ?? -1
  const messages = events.slice(priorTurnEndIndex + 1, turnEndIndex + 1).flatMap(event => {
    const data = event?.data ?? event
    const role = event?.type === 'user/message' ? 'user' : event?.type === 'assistant/message' ? 'assistant' : undefined
    const message = role === 'user' ? data?.message ?? data?.item ?? data : data?.message ?? data?.item
    return role && message ? [{ event, data, message: { ...message, role } }] : []
  })
  const assistant = messages.filter(item => item.message.role === 'assistant' && (item.data.turn === undefined || item.data.turn === turn)).at(-1)
  const input = [...messages].reverse().find(item => item.message.role === 'user')
  return {
    sessionId, turn,
    ...(input?.message?.id ? { inputMessageId: input.message.id } : {}),
    ...(Number.isSafeInteger(input?.event?.seq) ? { inputEventSeq: input.event.seq } : {}),
    ...(assistant?.message?.id ? { assistantMessageId: assistant.message.id } : {}),
    ...(Number.isSafeInteger(assistant?.event?.seq) ? { assistantSeq: assistant.event.seq } : {})
  }
}

function getPointer(value, path) {
  if (path === '') return value
  let current = value
  for (const segment of decodePointer(path)) {
    if (current === null || typeof current !== 'object' || !Object.hasOwn(current, segment)) return undefined
    current = current[segment]
  }
  return current
}

function setPointer(value, path, next) {
  const segments = decodePointer(path)
  let current = value
  for (let index = 0; index < segments.length - 1; index += 1) {
    const segment = segments[index]
    if (Array.isArray(current)) {
      const position = arrayIndex(segment, current.length, true)
      if (current[position] === undefined) current[position] = /^\d+$/u.test(segments[index + 1]) ? [] : {}
      if (current[position] === null || typeof current[position] !== 'object') throw teamError('RP_TEAM_STATE_PATH_INVALID', `Cannot traverse ${path}`)
      current = current[position]
    } else {
      if (!current || typeof current !== 'object') throw teamError('RP_TEAM_STATE_PATH_INVALID', `Cannot traverse ${path}`)
      if (!Object.hasOwn(current, segment)) {
        Object.defineProperty(current, segment, {
          value: /^\d+$/u.test(segments[index + 1]) ? [] : {},
          enumerable: true,
          configurable: true,
          writable: true
        })
      }
      if (current[segment] === null || typeof current[segment] !== 'object') throw teamError('RP_TEAM_STATE_PATH_INVALID', `Cannot traverse ${path}`)
      current = current[segment]
    }
  }
  const final = segments.at(-1)
  if (Array.isArray(current)) current[arrayIndex(final, current.length, true)] = cloneJson(next)
  else {
    if (!current || typeof current !== 'object') throw teamError('RP_TEAM_STATE_PATH_INVALID', `Cannot set ${path}`)
    Object.defineProperty(current, final, { value: cloneJson(next), enumerable: true, configurable: true, writable: true })
  }
}

function deletePointer(value, path) {
  const segments = decodePointer(path)
  let current = value
  for (const segment of segments.slice(0, -1)) {
    if (!current || typeof current !== 'object' || !Object.hasOwn(current, segment)) throw teamError('RP_TEAM_STATE_PATH_UNDEFINED', `Missing path ${path}`)
    current = current[segment]
  }
  const key = segments.at(-1)
  if (Array.isArray(current)) throw teamError('RP_TEAM_STATE_DELETE_UNSUPPORTED', 'Removing array elements is not supported')
  if (!current || typeof current !== 'object' || !Object.hasOwn(current, key)) {
    throw teamError('RP_TEAM_STATE_PATH_UNDEFINED', `Missing path ${path}`)
  }
  delete current[key]
}

function decodePointer(path) {
  if (typeof path !== 'string' || !path.startsWith('/')) throw teamError('RP_TEAM_STATE_PATH_INVALID', 'Invalid JSON Pointer')
  return path.slice(1).split('/').map(part => {
    if (/~(?:[^01]|$)/u.test(part)) throw teamError('RP_TEAM_STATE_PATH_INVALID', 'Invalid JSON Pointer escape')
    return part.replace(/~1/g, '/').replace(/~0/g, '~')
  })
}

function escapePointer(value) { return String(value).replace(/~/g, '~0').replace(/\//g, '~1') }
function pathKey(namespace, path) { return JSON.stringify([namespace, path]) }
function requiredText(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw teamError('RP_TEAM_INVALID_REQUEST', `${label} is required`)
  return value.trim()
}
function cloneJson(value) { return JSON.parse(JSON.stringify(value)) }
function valueType(value) {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  if (typeof value === 'number') return 'number'
  if (typeof value === 'object') return 'object'
  return typeof value
}
function isJsonValue(value, seen = new Set()) {
  if (value === null || ['string', 'boolean'].includes(typeof value)) return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (typeof value !== 'object' || seen.has(value)) return false
  seen.add(value)
  const valid = Array.isArray(value)
    ? value.every(item => isJsonValue(item, seen))
    : Object.getPrototypeOf(value) === Object.prototype && Object.values(value).every(item => isJsonValue(item, seen))
  seen.delete(value)
  return valid
}
function hashJson(value) { return createHash('sha256').update(stableJson(value)).digest('hex') }
function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`
  return JSON.stringify(value)
}
function own(value, key) { return value && Object.hasOwn(value, key) ? value[key] : undefined }
function parseObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return cloneJson(value)
  if (typeof value !== 'string') return {}
  try { const result = JSON.parse(value); return result && typeof result === 'object' && !Array.isArray(result) ? result : {} }
  catch { return {} }
}
function arrayIndex(segment, length, allowAppend = false) {
  if (!/^\d+$/u.test(segment)) throw teamError('RP_TEAM_STATE_PATH_INVALID', `Invalid array index ${segment}`)
  const index = Number(segment)
  if (!Number.isSafeInteger(index) || index > length || (index === length && !allowAppend)) {
    throw teamError('RP_TEAM_STATE_PATH_INVALID', `Array index ${segment} is out of bounds`)
  }
  return index
}
function conversationBusy() { return teamError('ELECKOI_CONVERSATION_BUSY', 'The conversation is generating or otherwise busy') }
