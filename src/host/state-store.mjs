import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { normalizeTeamConfig, teamError } from '../shared/schema.mjs'
import { validateValueSchema } from '../shared/value-schema.mjs'

const EMPTY_STATE = { version: 1, conversations: {} }
const OMIT = Symbol('omit')

/** Durable RP Team state and publication journal. Product receipts decide whether staged state is committed. */
export class StateStore {
  constructor(home = process.env.DSH_HOME, { filePath } = {}) {
    if (!filePath && !home) throw new Error('DSH_HOME is required for RP Team state storage')
    this.path = filePath ?? join(home, 'plugins', 'rp-agent-team', 'state.json')
  }

  /**
   * Open a durable run. Native world state uses `{ world: { variables, settings } }`;
   * `settings` is a flat `{ [virtualPath]: string }` map addressed as
   * `/settings/<JSON-Pointer-escaped virtualPath>`.
   */
  begin({ conversationId, runId, config, initialState = {} }) {
    const conversation = requiredText(conversationId, 'conversationId')
    const run = requiredText(runId, 'runId')
    const team = normalizeTeamConfig(config)
    const document = this.readDocument()
    const record = own(document.conversations, conversation) ?? newConversation()
    if (Object.values(record.authorEdits ?? {}).some(edit => edit.status === 'pending')) {
      throw teamError('RP_TEAM_STATE_AUTHOR_EDIT_PENDING', 'An author state edit must settle before a new Team run can begin')
    }
    const existing = own(record.runs, run)
    if (existing) {
      if (existing.configRevision !== configRevision(team)) throw teamError('RP_TEAM_STATE_RUN_CONFLICT', `Run ${run} already began with another config`)
      return publicRun(existing)
    }

    const provided = initialNamespaces(initialState)
    const namespaces = cloneJson(provided)
    for (const [namespace, value] of Object.entries(record.namespaces)) {
      if (namespace !== 'world') setOwn(namespaces, namespace, cloneJson(value))
    }
    for (const definition of team.state.definitions) {
      if (Object.hasOwn(definition, 'default')) setDefaultIfMissing(namespaces, definition.namespace, definition.path, definition.default)
    }
    validateConfiguredState(team, namespaces)
    const pathVersions = { ...record.pathVersions }
    const opened = {
      conversationId: conversation,
      runId: run,
      status: 'open',
      baseVersion: record.revision,
      basePathVersions: pathVersions,
      stagedPathVersions: { ...pathVersions },
      stagedVersion: Math.max(record.revision, ...Object.values(pathVersions), 0),
      state: namespaces,
      config: team,
      configRevision: configRevision(team),
      writes: [],
      receiptKey: run,
      createdAt: new Date().toISOString()
    }
    setOwn(record.runs, run, opened)
    setOwn(document.conversations, conversation, record)
    this.writeDocument(document)
    return publicRun(opened)
  }

  read({ conversationId, runId, agentId, namespace, path = '' }) {
    const record = this.readConversation(conversationId)
    const run = this.requireRun(record, runId)
    const agent = requireAgent(run.config, agentId)
    const target = validateTarget(namespace, path)
    assertPermission(agent, target.namespace, target.path, 'read')
    if (!stateDefinition(run.config, target.namespace, target.path)) {
      throw teamError('RP_TEAM_STATE_PATH_UNDEFINED', `State path ${target.namespace}${target.path} is not declared`)
    }
    const state = overlayWrites(run.state, run.writes)
    const projected = redactValue(agent, target.namespace, target.path, getPointer(state[target.namespace], target.path))
    return {
      value: projected === OMIT ? undefined : cloneJson(projected),
      version: versionForPath(run.stagedPathVersions, target.namespace, target.path)
    }
  }

  version({ conversationId, runId, agentId, namespace, path = '' }) {
    const run = this.requireRun(this.readConversation(conversationId), runId)
    const agent = requireAgent(run.config, agentId)
    const target = validateTarget(namespace, path)
    assertPermission(agent, target.namespace, target.path, 'write')
    if (!stateDefinition(run.config, target.namespace, target.path)) {
      throw teamError('RP_TEAM_STATE_PATH_UNDEFINED', `State path ${target.namespace}${target.path} is not declared`)
    }
    return { version: versionForPath(run.stagedPathVersions, target.namespace, target.path) }
  }

  /** Capture internal staged path versions for an activation without state values. */
  versionsSnapshot({ conversationId, runId }) {
    const run = this.requireRun(this.readConversation(conversationId), runId)
    return cloneJson(run.stagedPathVersions)
  }

  write({ conversationId, runId, agentId, namespace, path = '', value, expectedVersion }) {
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0) {
      throw teamError('RP_TEAM_STATE_VERSION_REQUIRED', 'expectedVersion must be the version returned by state read')
    }
    const document = this.readDocument()
    const conversation = requiredText(conversationId, 'conversationId')
    const record = own(document.conversations, conversation)
    if (!record) throw teamError('RP_TEAM_STATE_RUN_NOT_FOUND', 'Unknown RP Team conversation')
    const run = this.requireRun(record, runId)
    if (run.status !== 'open') throw teamError('RP_TEAM_STATE_NOT_OPEN', `Run state is ${run.status}`)
    const agent = requireAgent(run.config, agentId)
    const target = validateTarget(namespace, path)
    if (!target.path) throw teamError('RP_TEAM_STATE_PATH_INVALID', 'Writing an entire state namespace is not supported')
    assertPermission(agent, target.namespace, target.path, 'write')
    assertWritableSubtree(agent, target.namespace, target.path)
    if (!stateDefinition(run.config, target.namespace, target.path)) {
      throw teamError('RP_TEAM_STATE_PATH_UNDEFINED', `State path ${target.namespace}${target.path} is not declared`)
    }
    if (value === undefined) throw teamError('RP_TEAM_INVALID_STATE', 'State values must be JSON serializable')
    const committedVersion = versionForPath(record.pathVersions, target.namespace, target.path)
    const baselineVersion = versionForPath(run.basePathVersions, target.namespace, target.path)
    if (committedVersion !== baselineVersion) throw stateConflict(target, baselineVersion, committedVersion)
    const stagedVersion = versionForPath(run.stagedPathVersions, target.namespace, target.path)
    if (stagedVersion !== expectedVersion) throw stateConflict(target, expectedVersion, stagedVersion)
    const nextValue = cloneJson(value)
    if (target.namespace === 'world' && target.path.startsWith('/settings')) {
      const segments = decodePointer(target.path)
      if (segments.length !== 2 || segments[0] !== 'settings' || !segments[1] || typeof nextValue !== 'string') {
        throw teamError('RP_TEAM_STATE_TYPE_MISMATCH', 'World setting writes require one encoded virtual path and string content')
      }
    }
    const definition = stateDefinition(run.config, target.namespace, target.path)
    if (definition && definition.path === target.path && !matchesType(nextValue, definition.type)) {
      throw teamError('RP_TEAM_STATE_TYPE_MISMATCH', `State value at ${target.namespace}${target.path} must be ${definition.type}`)
    }
    validateConfiguredState(run.config, overlayWrites(run.state, [
      ...run.writes, { namespace: target.namespace, path: target.path, value: nextValue }
    ]))
    const key = pathKey(target.namespace, target.path)
    const prior = run.writes.findIndex(item => pathKey(item.namespace, item.path) === key)
    const baselineExpectedVersion = prior === -1 ? baselineVersion : run.writes[prior].expectedVersion
    const staged = { namespace: target.namespace, path: target.path, value: nextValue, expectedVersion: baselineExpectedVersion, agentId }
    if (prior === -1) run.writes.push(staged)
    else run.writes[prior] = staged
    run.stagedVersion += 1
    run.stagedPathVersions[pathKey(target.namespace, target.path)] = run.stagedVersion
    setOwn(record.runs, run.runId, run)
    setOwn(document.conversations, conversation, record)
    this.writeDocument(document)
    return { staged: true, baseVersion: run.baseVersion, expectedVersion }
  }

  /** Stage removal of one declared object property using the same ACL and CAS rules as write(). */
  remove({ conversationId, runId, agentId, namespace, path = '', expectedVersion }) {
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0) {
      throw teamError('RP_TEAM_STATE_VERSION_REQUIRED', 'expectedVersion must be the version returned by state read')
    }
    const document = this.readDocument()
    const conversation = requiredText(conversationId, 'conversationId')
    const record = own(document.conversations, conversation)
    if (!record) throw teamError('RP_TEAM_STATE_RUN_NOT_FOUND', 'Unknown RP Team conversation')
    const run = this.requireRun(record, runId)
    if (run.status !== 'open') throw teamError('RP_TEAM_STATE_NOT_OPEN', `Run state is ${run.status}`)
    const agent = requireAgent(run.config, agentId)
    const target = validateTarget(namespace, path)
    if (!target.path) throw teamError('RP_TEAM_STATE_PATH_INVALID', 'Removing an entire state namespace is not supported')
    assertPermission(agent, target.namespace, target.path, 'write')
    assertWritableSubtree(agent, target.namespace, target.path)
    if (!stateDefinition(run.config, target.namespace, target.path)) {
      throw teamError('RP_TEAM_STATE_PATH_UNDEFINED', `State path ${target.namespace}${target.path} is not declared`)
    }
    if (target.namespace === 'world' && target.path.startsWith('/settings')) {
      throw teamError('RP_TEAM_STATE_DELETE_UNSUPPORTED', 'World setting file deletion is not supported')
    }
    const currentValue = getPointer(overlayWrites(run.state, run.writes)[target.namespace], target.path)
    if (currentValue === undefined) throw teamError('RP_TEAM_STATE_PATH_UNDEFINED', `State path ${target.namespace}${target.path} does not exist`)
    const committedVersion = versionForPath(record.pathVersions, target.namespace, target.path)
    const baselineVersion = versionForPath(run.basePathVersions, target.namespace, target.path)
    if (committedVersion !== baselineVersion) throw stateConflict(target, baselineVersion, committedVersion)
    const stagedVersion = versionForPath(run.stagedPathVersions, target.namespace, target.path)
    if (stagedVersion !== expectedVersion) throw stateConflict(target, expectedVersion, stagedVersion)
    const key = pathKey(target.namespace, target.path)
    const prior = run.writes.findIndex(item => pathKey(item.namespace, item.path) === key)
    const baselineExpectedVersion = prior === -1 ? baselineVersion : run.writes[prior].expectedVersion
    const staged = { namespace: target.namespace, path: target.path, operation: 'remove', expectedVersion: baselineExpectedVersion, agentId }
    validateConfiguredState(run.config, overlayWrites(run.state, [...run.writes, staged]))
    if (prior === -1) run.writes.push(staged)
    else run.writes[prior] = staged
    run.stagedVersion += 1
    run.stagedPathVersions[key] = run.stagedVersion
    setOwn(record.runs, run.runId, run)
    setOwn(document.conversations, conversation, record)
    this.writeDocument(document)
    return { staged: true, baseVersion: run.baseVersion, expectedVersion }
  }

  stage({ conversationId, runId, receiptKey = runId }) {
    const document = this.readDocument()
    const conversation = requiredText(conversationId, 'conversationId')
    const record = own(document.conversations, conversation)
    if (!record) throw teamError('RP_TEAM_STATE_RUN_NOT_FOUND', 'Unknown RP Team conversation')
    const run = this.requireRun(record, runId)
    if (run.status === 'pending') {
      if (run.receiptKey !== receiptKey) throw teamError('RP_TEAM_STATE_RECEIPT_CONFLICT', 'A different receipt is already associated with this run')
      return publicRun(run)
    }
    if (run.status !== 'open') throw teamError('RP_TEAM_STATE_NOT_OPEN', `Run state is ${run.status}`)
    validateConfiguredState(run.config, overlayWrites(run.state, run.writes))
    for (const write of run.writes) {
      const actualVersion = versionForPath(record.pathVersions, write.namespace, write.path)
      if (actualVersion !== write.expectedVersion) throw stateConflict(write, write.expectedVersion, actualVersion)
      const reserved = Object.values(record.runs).find(other => other.runId !== run.runId
        && other.status === 'pending'
        && other.writes.some(item => overlaps(write.namespace, write.path, item.namespace, item.path)))
      if (reserved) throw teamError('RP_TEAM_STATE_CONFLICT', `State path ${write.namespace}${write.path} is reserved by pending run ${reserved.runId}`)
    }
    run.status = 'pending'
    run.receiptKey = requiredText(receiptKey, 'receiptKey')
    run.stagedAt = new Date().toISOString()
    setOwn(record.runs, run.runId, run)
    setOwn(document.conversations, conversation, record)
    this.writeDocument(document)
    return publicRun(run)
  }

  commit({ conversationId, runId, receipt }) {
    if (receipt?.outcome !== 'committed') throw teamError('RP_TEAM_STATE_RECEIPT_REQUIRED', 'A committed product receipt is required')
    const document = this.readDocument()
    const conversation = requiredText(conversationId, 'conversationId')
    const record = own(document.conversations, conversation)
    if (!record) throw teamError('RP_TEAM_STATE_RUN_NOT_FOUND', 'Unknown RP Team conversation')
    const run = this.requireRun(record, runId)
    if (receipt.receiptKey !== undefined && receipt.receiptKey !== run.receiptKey) {
      throw teamError('RP_TEAM_STATE_RECEIPT_CONFLICT', 'Product receipt does not match the staged run')
    }
    if (run.status === 'committed') return publicRun(run)
    if (run.status !== 'pending') throw teamError('RP_TEAM_STATE_NOT_PENDING', `Cannot commit state for ${run.status} run`)

    for (const write of run.writes) {
      const actualVersion = versionForPath(record.pathVersions, write.namespace, write.path)
      if (actualVersion !== write.expectedVersion) throw stateConflict(write, write.expectedVersion, actualVersion)
    }
    run.priorCommittedState = committedSnapshot(record)
    const nextRevision = record.revision + 1
    for (const write of run.writes) {
      if (write.namespace !== 'world') {
        record.namespaces[write.namespace] ??= cloneJson(run.state[write.namespace] ?? {})
        if (write.operation === 'remove') deletePointer(record.namespaces[write.namespace], write.path)
        else setPointer(record.namespaces[write.namespace], write.path, write.value)
      }
      record.pathVersions[pathKey(write.namespace, write.path)] = nextRevision
    }
    record.revision = nextRevision
    run.status = 'committed'
    run.receipt = cloneJson(receipt)
    run.completedAt = new Date().toISOString()
    setOwn(record.runs, run.runId, run)
    setOwn(document.conversations, conversation, record)
    this.writeDocument(document)
    return publicRun(run)
  }

  rollback({ conversationId, runId, reason = 'Product turn was not committed' }) {
    const document = this.readDocument()
    const conversation = requiredText(conversationId, 'conversationId')
    const record = own(document.conversations, conversation)
    if (!record) throw teamError('RP_TEAM_STATE_RUN_NOT_FOUND', 'Unknown RP Team conversation')
    const run = this.requireRun(record, runId)
    if (run.status === 'rolled_back') return publicRun(run)
    if (run.status === 'committed') throw teamError('RP_TEAM_STATE_ALREADY_COMMITTED', 'Committed state cannot be rolled back')
    run.status = 'rolled_back'
    run.reason = String(reason)
    run.completedAt = new Date().toISOString()
    run.writes = []
    setOwn(record.runs, run.runId, run)
    setOwn(document.conversations, conversation, record)
    this.writeDocument(document)
    return publicRun(run)
  }

  async recover(receiptProvider) {
    if (typeof receiptProvider !== 'function') throw new TypeError('receiptProvider must be a function')
    const pending = []
    for (const [conversationId, record] of Object.entries(this.readDocument().conversations)) {
      for (const run of Object.values(record.runs)) {
        if (run.status === 'pending') pending.push({ conversationId, runId: run.runId, receiptKey: run.receiptKey })
      }
    }
    const results = []
    for (const item of pending) {
      const receipt = await receiptProvider(item)
      if (receipt?.outcome === 'committed') results.push(this.commit({ ...item, receipt: { outcome: 'committed', ...receipt } }))
      else if (receipt?.outcome === 'failed' || receipt?.outcome === 'cancelled') results.push(this.rollback({ ...item, reason: receipt.outcome }))
      else results.push({ ...item, status: 'pending' })
    }
    return results
  }

  snapshot({ conversationId, runId }) {
    const run = this.requireRun(this.readConversation(conversationId), runId)
    return cloneJson(overlayWrites(run.state, run.writes))
  }

  /** Capture committed Team state for a Host transaction that may rewind a Session. */
  committedSnapshot({ conversationId }) {
    return committedSnapshot(this.readConversation(conversationId))
  }

  /** Persist the plugin-state half of an author edit before its optional host receipt is written. */
  beginAuthorEdit(input) {
    const conversationId = requiredText(input.conversationId, 'conversationId')
    const operationId = requiredText(input.operationId, 'operationId')
    const document = this.readDocument()
    const record = own(document.conversations, conversationId) ?? newConversation()
    record.authorEdits ??= {}
    const requestHash = createHash('sha256').update(stableJson({
      expectedRevision: input.expectedRevision,
      beforeSnapshot: input.beforeSnapshot,
      afterSnapshot: input.afterSnapshot,
      operations: input.operations,
      anchor: input.anchor,
      hostRequired: input.hostRequired === true,
      identity: input.identity,
      worldBefore: input.worldBefore,
      worldAfter: input.worldAfter
    })).digest('hex')
    const prior = own(record.authorEdits, operationId)
    if (prior) {
      if (prior.requestHash !== requestHash) throw teamError('RP_TEAM_AUTHOR_EDIT_CONFLICT', 'An author operation id cannot be reused for different edits')
      return publicAuthorEdit(prior)
    }
    if (Object.values(record.authorEdits).some(edit => edit.status === 'pending')) {
      throw teamError('RP_TEAM_STATE_AUTHOR_EDIT_PENDING', 'A different author state edit is still pending')
    }
    const current = committedSnapshot(record)
    if (record.revision !== input.expectedRevision || stableJson(current) !== stableJson(input.beforeSnapshot)) {
      throw teamError('RP_TEAM_AUTHOR_EDIT_CONFLICT', 'Committed Team state changed while preparing the author edit')
    }
    if (!isRecord(input.afterSnapshot) || !Number.isSafeInteger(input.afterSnapshot.revision)
      || !isRecord(input.afterSnapshot.namespaces) || !isRecord(input.afterSnapshot.pathVersions)) {
      throw teamError('RP_TEAM_AUTHOR_EDIT_INVALID', 'The next committed Team state snapshot is invalid')
    }
    const item = {
      operationId,
      status: 'pending',
      requestHash,
      expectedRevision: input.expectedRevision,
      beforeSnapshot: cloneJson(input.beforeSnapshot),
      afterSnapshot: cloneJson(input.afterSnapshot),
      operations: cloneJson(input.operations),
      anchor: cloneJson(input.anchor),
      identity: input.identity === undefined ? undefined : cloneJson(input.identity),
      worldBefore: input.worldBefore === undefined ? undefined : cloneJson(input.worldBefore),
      worldAfter: input.worldAfter === undefined ? undefined : cloneJson(input.worldAfter),
      hostRequired: input.hostRequired === true,
      pluginChanged: stableJson(input.beforeSnapshot.namespaces) !== stableJson(input.afterSnapshot.namespaces),
      revision: Math.max(0, ...Object.values(record.authorEdits).map(edit => Number(edit.revision) || 0)) + 1,
      createdAt: new Date().toISOString()
    }
    setOwn(record.authorEdits, operationId, item)
    setOwn(document.conversations, conversationId, record)
    this.writeDocument(document)
    return publicAuthorEdit(item)
  }

  commitAuthorEdit({ conversationId, operationId, hostReceipt }) {
    const document = this.readDocument()
    const conversation = requiredText(conversationId, 'conversationId')
    const record = own(document.conversations, conversation)
    const item = own(record?.authorEdits, requiredText(operationId, 'operationId'))
    if (!item) throw teamError('RP_TEAM_AUTHOR_EDIT_NOT_FOUND', 'Unknown author state edit')
    if (item.status === 'committed') return publicAuthorEdit(item)
    if (item.status !== 'pending') throw teamError('RP_TEAM_AUTHOR_EDIT_SETTLED', `Author edit is ${item.status}`)
    if (item.hostRequired && hostReceipt?.status !== 'committed') {
      throw teamError('RP_TEAM_AUTHOR_EDIT_RECEIPT_REQUIRED', 'A committed ElecKoi world receipt is required')
    }
    const current = committedSnapshot(record)
    if (record.revision !== item.expectedRevision || stableJson(current) !== stableJson(item.beforeSnapshot)) {
      throw teamError('RP_TEAM_AUTHOR_EDIT_CONFLICT', 'Committed Team state changed before the author edit could settle')
    }
    if (item.pluginChanged) {
      record.revision = item.afterSnapshot.revision
      record.namespaces = cloneJson(item.afterSnapshot.namespaces)
      record.pathVersions = cloneJson(item.afterSnapshot.pathVersions)
    }
    item.status = 'committed'
    item.hostReceipt = item.hostRequired ? cloneJson(hostReceipt) : undefined
    item.committedRevision = record.revision
    item.completedAt = new Date().toISOString()
    setOwn(record.authorEdits, item.operationId, item)
    setOwn(document.conversations, conversation, record)
    this.writeDocument(document)
    return publicAuthorEdit(item)
  }

  failAuthorEdit({ conversationId, operationId, reason }) {
    const document = this.readDocument()
    const conversation = requiredText(conversationId, 'conversationId')
    const record = own(document.conversations, conversation)
    const item = own(record?.authorEdits, requiredText(operationId, 'operationId'))
    if (!item) return { operationId, status: 'unknown' }
    if (item.status === 'committed') return publicAuthorEdit(item)
    if (item.status === 'failed') return publicAuthorEdit(item)
    item.status = 'failed'
    item.reason = String(reason ?? 'Author edit failed')
    item.completedAt = new Date().toISOString()
    setOwn(record.authorEdits, item.operationId, item)
    setOwn(document.conversations, conversation, record)
    this.writeDocument(document)
    return publicAuthorEdit(item)
  }

  listAuthorEdits(conversationId) {
    const edits = own(this.readConversation(conversationId), 'authorEdits') ?? {}
    return Object.values(edits).sort((left, right) => left.revision - right.revision).map(publicAuthorEdit)
  }

  getAuthorEdit(conversationId, operationId) {
    const record = this.readConversation(conversationId)
    const edit = own(record.authorEdits, String(operationId))
    return edit ? publicAuthorEdit(edit) : { operationId: String(operationId), status: 'unknown' }
  }

  pendingAuthorEdits(conversationId) {
    const document = this.readDocument()
    const conversations = conversationId === undefined
      ? Object.entries(document.conversations)
      : [[String(conversationId), own(document.conversations, String(conversationId))]]
    return conversations.flatMap(([id, record]) => Object.values(record?.authorEdits ?? {})
      .filter(edit => edit.status === 'pending')
      .map(edit => ({ conversationId: id, ...publicAuthorEdit(edit), hostRequired: edit.hostRequired })))
  }

  /** Read the exact namespace/version baseline that preceded one committed Team run. */
  committedBaseline({ conversationId, runId }) {
    const record = this.readConversation(conversationId)
    const run = own(record.runs, requiredText(runId, 'runId'))
    if (run?.status === 'committed' && run.priorCommittedState) return cloneJson(run.priorCommittedState)
    const imported = own(record.restoreBaselines, String(runId))
    if (imported) return cloneJson(imported)
    throw teamError('RP_TEAM_STATE_BASELINE_UNAVAILABLE', `Run ${runId} has no committed-state baseline`)
  }

  /** Rebind a migrated historical run to the pre-run plugin-state checkpoint supplied by Host. */
  importCommittedBaseline({ conversationId, runId, snapshot }) {
    const baseline = normalizeCommittedSnapshot(snapshot)
    const document = this.readDocument()
    const conversation = requiredText(conversationId, 'conversationId')
    const id = requiredText(runId, 'runId')
    const record = own(document.conversations, conversation) ?? newConversation()
    record.restoreBaselines ??= {}
    const existing = own(record.restoreBaselines, id)
    if (existing && stableJson(existing) !== stableJson(baseline)) {
      throw teamError('RP_TEAM_STATE_BASELINE_CONFLICT', `Run ${id} was imported with another state baseline`)
    }
    if (!existing) setOwn(record.restoreBaselines, id, baseline)
    setOwn(document.conversations, conversation, record)
    this.writeDocument(document)
    return cloneJson(own(record.restoreBaselines, id))
  }

  /** Replace shared/private namespaces and CAS versions while retaining every run journal. */
  restoreCommittedSnapshot({ conversationId, snapshot }) {
    const committed = normalizeCommittedSnapshot(snapshot)
    const document = this.readDocument()
    const conversation = requiredText(conversationId, 'conversationId')
    const record = own(document.conversations, conversation) ?? newConversation()
    record.revision = committed.revision
    record.namespaces = committed.namespaces
    record.pathVersions = committed.pathVersions
    setOwn(document.conversations, conversation, record)
    this.writeDocument(document)
    return committedSnapshot(record)
  }

  status({ conversationId, runId }) {
    const run = this.requireRun(this.readConversation(conversationId), runId)
    return publicRun(run)
  }

  readConversation(conversationId) {
    const document = this.readDocument()
    const record = own(document.conversations, requiredText(conversationId, 'conversationId')) ?? newConversation()
    record.authorEdits ??= {}
    return record
  }

  requireRun(record, runId) {
    const id = requiredText(runId, 'runId')
    const run = own(record.runs, id)
    if (!run) throw teamError('RP_TEAM_STATE_RUN_NOT_FOUND', `Unknown RP Team run ${id}`)
    return run
  }

  readDocument() {
    try {
      const document = JSON.parse(readFileSync(this.path, 'utf8'))
      if (document?.version !== 1 || !isRecord(document.conversations)) {
        throw teamError('RP_TEAM_STATE_STORE_INVALID', 'RP Team state store has an unsupported format')
      }
      return document
    } catch (error) {
      if (error?.code === 'ENOENT') return cloneJson(EMPTY_STATE)
      throw error
    }
  }

  writeDocument(document) {
    mkdirSync(dirname(this.path), { recursive: true })
    const temporary = `${this.path}.${process.pid}.${Date.now()}.tmp`
    try {
      writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
      renameSync(temporary, this.path)
    } finally {
      rmSync(temporary, { force: true })
    }
  }
}

function newConversation() { return { revision: 0, namespaces: {}, pathVersions: {}, runs: {}, authorEdits: {} } }

function committedSnapshot(record) {
  return cloneJson({ revision: record.revision, namespaces: record.namespaces, pathVersions: record.pathVersions })
}
function normalizeCommittedSnapshot(snapshot) {
  if (!snapshot || !Number.isSafeInteger(snapshot.revision) || snapshot.revision < 0
    || !isRecord(snapshot.namespaces) || !isRecord(snapshot.pathVersions)) {
    throw teamError('RP_TEAM_STATE_SNAPSHOT_INVALID', 'A committed-state snapshot is required')
  }
  const pathVersions = {}
  for (const [key, version] of Object.entries(snapshot.pathVersions)) {
    let target
    try { target = JSON.parse(key) } catch { throw teamError('RP_TEAM_STATE_SNAPSHOT_INVALID', 'A committed-state path version is malformed') }
    if (!Array.isArray(target) || target.length !== 2 || target.some(item => typeof item !== 'string')
      || !Number.isSafeInteger(version) || version < 0) {
      throw teamError('RP_TEAM_STATE_SNAPSHOT_INVALID', 'A committed-state path version is malformed')
    }
    pathVersions[key] = version
  }
  return {
    revision: snapshot.revision,
    namespaces: cloneJson(snapshot.namespaces),
    pathVersions
  }
}
function publicRun(run) {
  return {
    conversationId: run.conversationId,
    runId: run.runId,
    status: run.status,
    baseVersion: run.baseVersion,
    state: cloneJson(run.state),
    config: cloneJson(run.config),
    configRevision: run.configRevision,
    receiptKey: run.receiptKey,
    writes: cloneJson(run.writes),
    receipt: run.receipt ? cloneJson(run.receipt) : undefined,
    reason: run.reason
  }
}

function publicAuthorEdit(edit) {
  return {
    operationId: edit.operationId,
    status: edit.status,
    revision: edit.revision,
    committedRevision: edit.committedRevision,
    expectedRevision: edit.expectedRevision,
    beforeSnapshot: cloneJson(edit.beforeSnapshot),
    afterSnapshot: cloneJson(edit.afterSnapshot),
    operations: cloneJson(edit.operations),
    anchor: cloneJson(edit.anchor),
    ...(edit.identity === undefined ? {} : { identity: cloneJson(edit.identity) }),
    ...(edit.worldBefore === undefined ? {} : { worldBefore: cloneJson(edit.worldBefore) }),
    ...(edit.worldAfter === undefined ? {} : { worldAfter: cloneJson(edit.worldAfter) }),
    hostRequired: edit.hostRequired,
    pluginChanged: edit.pluginChanged,
    ...(edit.hostReceipt === undefined ? {} : { hostReceipt: cloneJson(edit.hostReceipt) }),
    ...(edit.reason === undefined ? {} : { reason: edit.reason }),
    createdAt: edit.createdAt,
    ...(edit.completedAt === undefined ? {} : { completedAt: edit.completedAt })
  }
}

function initialNamespaces(value) {
  const source = isRecord(value?.namespaces) ? value.namespaces : value
  const namespaces = {}
  for (const [namespace, state] of Object.entries(source ?? {})) {
    if (namespace === 'versions') continue
    setOwn(namespaces, namespace, cloneJson(state))
  }
  return namespaces
}

function assertPermission(agent, namespace, path, action) {
  if (!hasAccess(effectiveAccess(agent, namespace, path), action)) {
    throw teamError('RP_TEAM_STATE_FORBIDDEN', `Agent ${agent.id} cannot ${action} ${namespace}${path}`)
  }
}

function assertWritableSubtree(agent, namespace, path) {
  const protectedPath = protectedDescendantPath(agent, namespace, path)
  if (protectedPath) {
    throw teamError('RP_TEAM_STATE_FORBIDDEN', `Agent ${agent.id} cannot replace ${namespace}${path} because ${protectedPath} is protected`)
  }
}

function protectedDescendantPath(agent, namespace, path) {
  for (const rule of agent.statePermissions) {
    if (rule.namespace !== namespace || !pathWithin(path, rule.path) || rule.path === path) continue
    if (!hasAccess(effectiveAccess(agent, namespace, rule.path), 'write')) {
      return rule.path
    }
  }
  return ''
}

function effectiveAccess(agent, namespace, path) {
  const candidates = agent.statePermissions
    .filter(item => item.namespace === namespace && pathWithin(item.path, path))
    .sort((left, right) => right.path.length - left.path.length)
  return candidates[0]?.access ?? 'none'
}

function hasAccess(access, action) {
  return action === 'read'
    ? access === 'read' || access === 'readwrite'
    : access === 'write' || access === 'readwrite'
}

/** Return metadata for state tools using the same effective ACL and subtree rules as execution. */
export function describeStateToolAccess(agent, definitions) {
  return definitions.flatMap(({ namespace, path }) => {
    const access = effectiveAccess(agent, namespace, path)
    const writable = path !== '' && hasAccess(access, 'write') && !protectedDescendantPath(agent, namespace, path)
    const rights = {
      namespace, path,
      read: hasAccess(access, 'read'),
      version: hasAccess(access, 'write'),
      write: writable
    }
    return rights.read || rights.version ? [rights] : []
  })
}

function redactValue(agent, namespace, path, value) {
  const allowed = hasAccess(effectiveAccess(agent, namespace, path), 'read')
  if (value === null || typeof value !== 'object') return allowed ? value : OMIT
  if (Array.isArray(value)) {
    const result = value.map((item, index) => {
      const projected = redactValue(agent, namespace, pointerJoin(path, String(index)), item)
      return projected === OMIT ? null : projected
    })
    return allowed || result.some(item => item !== null) ? result : OMIT
  }
  const result = {}
  for (const [key, child] of Object.entries(value)) {
    const projected = redactValue(agent, namespace, pointerJoin(path, key), child)
    if (projected !== OMIT) setOwn(result, key, projected)
  }
  return allowed || Object.keys(result).length ? result : OMIT
}

function requireAgent(config, agentId) {
  const agent = config.agents.find(item => item.id === agentId)
  if (!agent) throw teamError('RP_TEAM_AGENT_NOT_FOUND', `Unknown state agent ${String(agentId)}`)
  return agent
}

function validateTarget(namespace, path) {
  if (typeof namespace !== 'string' || !(namespace === 'shared' || namespace === 'world' || (namespace.startsWith('private:') && namespace.length > 'private:'.length))) {
    throw teamError('RP_TEAM_STATE_PATH_INVALID', `Invalid state namespace ${String(namespace)}`)
  }
  if (typeof path !== 'string' || (path !== '' && !path.startsWith('/')) || path.split('/').slice(1).some(part => /~(?![01])/u.test(part))) {
    throw teamError('RP_TEAM_STATE_PATH_INVALID', `Invalid JSON Pointer ${String(path)}`)
  }
  return { namespace, path }
}

function stateDefinition(config, namespace, path) {
  return config.state.definitions
    .filter(item => item.namespace === namespace && pathWithin(item.path, path))
    .sort((left, right) => right.path.length - left.path.length)[0]
}

function validateConfiguredState(config, state) {
  for (const definition of config.state.definitions) {
    const value = getPointer(state[definition.namespace], definition.path)
    if (value === undefined) continue
    if (!matchesType(value, definition.type)) {
      throw teamError('RP_TEAM_STATE_TYPE_MISMATCH', `State value at ${definition.namespace}${definition.path} must be ${definition.type}`)
    }
    const issues = validateValueSchema(value, definition.valueSchema)
    if (issues.length) {
      const issue = issues[0]
      throw teamError('RP_TEAM_STATE_TYPE_MISMATCH', `State value at ${definition.namespace}${definition.path}${issue.path} ${issue.message}`)
    }
  }
}

/** Validate all configured paths without opening a StateStore transaction. */
export function validateConfiguredStateSnapshot(config, state) {
  validateConfiguredState(normalizeTeamConfig(config), state)
  return cloneJson(state)
}

/** Apply the same nested ACL projection used by StateStore.read to a pure snapshot. */
export function projectStateValueForAgent(agent, namespace, path, value) {
  const projected = redactValue(agent, namespace, path, value)
  return projected === OMIT ? undefined : cloneJson(projected)
}

function pathWithin(parent, child) { return parent === '' || parent === child || child.startsWith(`${parent}/`) }
function pathKey(namespace, path) { return JSON.stringify([namespace, path]) }

export function versionForPath(versions, namespace, path) {
  let version = 0
  const entries = Array.isArray(versions?.versions)
    ? versions.versions
    : Array.isArray(versions)
      ? versions
      : Object.entries(versions ?? {}).map(([key, current]) => {
        const [itemNamespace, itemPath] = JSON.parse(key)
        return { namespace: itemNamespace, path: itemPath, version: current }
      })
  for (const item of entries) {
    if (namespace === item.namespace && overlapsPath(path, item.path)) version = Math.max(version, item.version)
  }
  return version
}

function overlaps(leftNamespace, leftPath, rightNamespace, rightPath) {
  return leftNamespace === rightNamespace && overlapsPath(leftPath, rightPath)
}
function overlapsPath(left, right) {
  return pathWithin(left, right) || pathWithin(right, left)
}

function setDefaultIfMissing(namespaces, namespace, path, value) {
  if (path === '') {
    if (!Object.hasOwn(namespaces, namespace)) setOwn(namespaces, namespace, cloneJson(value))
    return
  }
  if (!Object.hasOwn(namespaces, namespace)) setOwn(namespaces, namespace, {})
  if (getPointer(namespaces[namespace], path) === undefined) setPointer(namespaces[namespace], path, value)
}

function getPointer(value, pointer) {
  if (pointer === '') return value
  let current = value
  for (const segment of decodePointer(pointer)) {
    if (current === null || typeof current !== 'object' || !Object.hasOwn(current, segment)) return undefined
    current = current[segment]
  }
  return current
}

function setPointer(value, pointer, nextValue) {
  if (pointer === '') throw teamError('RP_TEAM_STATE_PATH_INVALID', 'Replacing an entire state namespace is not supported')
  const segments = decodePointer(pointer)
  let current = value
  for (let index = 0; index < segments.length - 1; index += 1) {
    const segment = segments[index]
    if (Array.isArray(current)) {
      const position = arrayIndex(segment, current.length, true)
      if (current[position] === undefined) current[position] = /^\d+$/u.test(segments[index + 1]) ? [] : {}
      if (current[position] === null || typeof current[position] !== 'object') {
        throw teamError('RP_TEAM_STATE_PATH_INVALID', `Cannot traverse state path ${pointer}`)
      }
      current = current[position]
    } else {
      if (current === null || typeof current !== 'object') throw teamError('RP_TEAM_STATE_PATH_INVALID', `Cannot traverse state path ${pointer}`)
      if (!Object.hasOwn(current, segment)) setOwn(current, segment, /^\d+$/u.test(segments[index + 1]) ? [] : {})
      if (current[segment] === null || typeof current[segment] !== 'object') throw teamError('RP_TEAM_STATE_PATH_INVALID', `Cannot traverse state path ${pointer}`)
      current = current[segment]
    }
  }
  const final = segments.at(-1)
  if (Array.isArray(current)) current[arrayIndex(final, current.length, true)] = cloneJson(nextValue)
  else {
    if (current === null || typeof current !== 'object') throw teamError('RP_TEAM_STATE_PATH_INVALID', `Cannot traverse state path ${pointer}`)
    setOwn(current, final, cloneJson(nextValue))
  }
}

function deletePointer(value, pointer) {
  const segments = decodePointer(pointer)
  let current = value
  for (const segment of segments.slice(0, -1)) {
    if (current === null || typeof current !== 'object' || !Object.hasOwn(current, segment)) {
      throw teamError('RP_TEAM_STATE_PATH_UNDEFINED', `State path ${pointer} does not exist`)
    }
    current = current[segment]
  }
  const final = segments.at(-1)
  if (Array.isArray(current)) throw teamError('RP_TEAM_STATE_DELETE_UNSUPPORTED', 'Removing array elements is not supported')
  if (current === null || typeof current !== 'object' || !Object.hasOwn(current, final)) {
    throw teamError('RP_TEAM_STATE_PATH_UNDEFINED', `State path ${pointer} does not exist`)
  }
  delete current[final]
}

function arrayIndex(segment, length, allowAppend = false) {
  if (!/^\d+$/u.test(segment)) throw teamError('RP_TEAM_STATE_PATH_INVALID', `Invalid array index ${segment}`)
  const index = Number(segment)
  if (!Number.isSafeInteger(index) || index > length || (index === length && !allowAppend)) {
    throw teamError('RP_TEAM_STATE_PATH_INVALID', `Array index ${segment} is out of bounds`)
  }
  return index
}

function decodePointer(pointer) { return pointer.slice(1).split('/').map(segment => segment.replace(/~1/g, '/').replace(/~0/g, '~')) }
function pointerJoin(pointer, segment) {
  return `${pointer}/${segment.replace(/~/g, '~0').replace(/\//g, '~1')}`
}

function overlayWrites(state, writes) {
  const result = cloneJson(state)
  for (const write of writes) {
    result[write.namespace] ??= {}
    if (write.operation === 'remove') deletePointer(result[write.namespace], write.path)
    else setPointer(result[write.namespace], write.path, write.value)
  }
  return result
}

function cloneJson(value) {
  if (value === undefined) return undefined
  const serialized = JSON.stringify(value)
  if (serialized === undefined) throw teamError('RP_TEAM_INVALID_STATE', 'State values must be JSON serializable')
  return JSON.parse(serialized)
}

function matchesType(value, type) {
  if (type === 'any') return true
  if (type === 'null') return value === null
  if (type === 'object') return isRecord(value)
  if (type === 'array') return Array.isArray(value)
  return typeof value === type
}

function configRevision(config) {
  return createHash('sha256').update(stableJson(config)).digest('hex')
}
function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (isRecord(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`
  return JSON.stringify(value)
}
function stateConflict(target, expected, actual) {
  return teamError('RP_TEAM_STATE_CONFLICT', `State path ${target.namespace}${target.path} is version ${actual}, not ${expected}`)
}
function requiredText(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw teamError('RP_TEAM_INVALID_REQUEST', `${label} is required`)
  return value.trim()
}
function isRecord(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) }
function own(record, key) { return isRecord(record) && Object.hasOwn(record, key) ? record[key] : undefined }
function setOwn(record, key, value) {
  Object.defineProperty(record, key, { value, enumerable: true, configurable: true, writable: true })
}
