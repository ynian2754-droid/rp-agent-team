import test from 'node:test'
import assert from 'node:assert/strict'
import { examplePresets, normalizeTeamConfig } from '../src/shared/schema.mjs'
import { createDraftState, editConfig } from '../src/client/draft-state.js'
import { addValueEntry, applyDefinitionForms, changeDefinitionAccess, changeDefinitionType, definitionForms, formDefinition, formValue, moveValueEntry, newDefinition, pathParts, statePath, valueError, valueForm } from '../src/client/state-editor-model.js'

const editorFor = config => createDraftState({ config, revision: 1 })

test('state forms round-trip every supported type, nested values, omitted defaults and escaped paths', () => {
  const values = ['', -2.3e9, false, { mood: 'calm', memories: [{ remembered: true }, null, 4] }, [1, false, ''], null]
  const definitions = values.map((value, i) => ({ namespace: 'shared', path: `/item-${i}`, type: ['string', 'number', 'boolean', 'object', 'array', 'null'][i], default: value }))
  definitions.push({ namespace: 'world', path: '', type: 'any', default: { '': { 'a/b~c': true } }, description: '' }, { namespace: 'shared', path: '/nested~1name/~0last', type: 'string' })
  assert.deepEqual(definitionForms(definitions).map(formDefinition), definitions)
  for (const path of ['', '/', '/a//b', '/人物/心理~1感受/~0记忆']) assert.equal(statePath(pathParts(path)), path)
  assert.deepEqual(formValue(valueForm(JSON.parse('{"__proto__":{"v":1},"constructor":2}'))), JSON.parse('{"__proto__":{"v":1},"constructor":2}'))
})

test('unfinished numbers and duplicate fields survive in the draft, block save, and recover without data loss', () => {
  let editor = editorFor(examplePresets()[0])
  let form = newDefinition([], '心情')
  form = { ...changeDefinitionType(form, 'number'), hasDefault: true, value: { ...valueForm(4), text: '-' } }
  editor = applyDefinitionForms(editor, [form])
  assert.equal(editor.invalid['$team:definitions'], true)
  assert.equal(editor.stateForms[0].value.text, '-')
  assert.deepEqual(editor.draft.state.definitions, [])
  editor = applyDefinitionForms(editor, [{ ...editor.stateForms[0], value: { ...form.value, text: '-2.5' } }])
  assert.equal(editor.invalid['$team:definitions'], undefined)
  assert.equal(editor.draft.state.definitions[0].default, -2.5)
  let object = addValueEntry(addValueEntry(valueForm({}), '字段'), '字段')
  object.entries[1].name = object.entries[0].name
  assert.equal(valueError(object), 'duplicateField')
  assert.throws(() => formValue(object), /duplicateField/)
})

test('adding, deleting and reordering mixed list content does not change sibling identity or values', () => {
  const node = valueForm(['first', { nested: [true, 2] }, null])
  const moved = moveValueEntry(node, 1, -1)
  assert.equal(moved.entries[0].id, node.entries[1].id)
  assert.deepEqual(formValue(moved), [{ nested: [true, 2] }, 'first', null])
  assert.deepEqual(formValue({ ...moved, entries: moved.entries.filter(entry => entry.id !== node.entries[0].id) }), [{ nested: [true, 2] }, null])
  assert.equal(changeDefinitionType({ value: node }, 'any').value, node)
})

test('duplicate state locations cannot silently overwrite a definition', () => {
  const editor = editorFor(examplePresets()[0])
  const forms = definitionForms([{ namespace: 'shared', path: '/mood', type: 'string' }, { namespace: 'shared', path: '/mood', type: 'number' }])
  const result = applyDefinitionForms(editor, forms)
  assert.equal(result.invalid['$team:definitions'], true)
  assert.deepEqual(result.draft.state.definitions, [])
})

test('renaming follows exact permission and nested condition references without rewriting compared data', () => {
  const config = examplePresets()[0]
  config.state.definitions = [{ namespace: 'shared', path: '/mood', type: 'any' }]
  config.agents[0].statePermissions = [{ namespace: 'shared', path: '/mood', access: 'readwrite' }, { namespace: 'shared', path: '/other', access: 'read' }]
  const compared = { namespace: 'shared', path: '/mood' }
  config.agents[0].triggers = [{ type: 'condition', condition: { op: 'not', condition: { op: 'all', conditions: [{ op: 'compare', namespace: 'shared', path: '/mood', operator: 'eq', value: compared }] } } }]
  const editor = editorFor(config), form = definitionForms(config.state.definitions)[0]
  const result = applyDefinitionForms(editor, [{ ...form, parts: ['心理', '心情'] }])
  assert.equal(result.draft.agents[0].statePermissions[0].path, '/心理/心情')
  assert.equal(result.draft.agents[0].statePermissions[1].path, '/other')
  const condition = result.draft.agents[0].triggers[0].condition.condition.conditions[0]
  assert.equal(condition.path, '/心理/心情')
  assert.deepEqual(condition.value, compared)
  assert.doesNotThrow(() => normalizeTeamConfig(result.draft))
})

test('private ownership and exact grants serialize through the existing schema without widening a parent rule', () => {
  const config = examplePresets()[0], form = newDefinition([], '记忆')
  form.namespace = `private:${config.agents[0].id}`
  form.hasDefault = true
  form.value = valueForm('uncertain')
  let editor = applyDefinitionForms(editorFor(config), [form])
  editor = changeDefinitionAccess(editor, editor.stateForms[0], config.agents[0].id, 'readwrite')
  const normalized = normalizeTeamConfig(editor.draft)
  assert.equal(normalized.state.definitions[0].namespace, form.namespace)
  assert.equal(normalized.agents[0].statePermissions.at(-1).access, 'readwrite')
  assert.equal(normalized.agents[1].statePermissions.length, 0)
})

test('member removal or imported replacement cannot resurrect stale private state forms', () => {
  const editor = applyDefinitionForms(editorFor(examplePresets()[0]), [newDefinition([], '记忆')])
  const replaced = editConfig(editor, { ...editor.draft, state: { definitions: [] } })
  assert.equal(replaced.stateForms, undefined)
})
