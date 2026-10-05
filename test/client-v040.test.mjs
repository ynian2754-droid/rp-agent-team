import test from 'node:test'
import assert from 'node:assert/strict'
import { examplePresets } from '../src/shared/schema.mjs'
import { createDraftState, editParameterValue, syncRemote, markSaved, replaceDraft } from '../src/client/draft-state.js'
import { createClientApi } from '../src/client/api.js'

test('parameter drafts detect independent remote conflicts and preserve in-flight edits', () => {
  const config = examplePresets()[0]
  const initial = { config, revision: 1, parameterValues: { tone: 'quiet' } }
  let draft = editParameterValue(createDraftState(initial), 'tone', 'warm')
  assert.ok(syncRemote(draft, { ...initial, revision: 2, parameterValues: { tone: 'cold' } }).remote)
  const submittedValues = draft.parameterValues
  draft = editParameterValue(draft, 'tone', 'playful')
  const saved = markSaved(draft, { ...initial, revision: 2, parameterValues: submittedValues }, draft.draft, submittedValues)
  assert.equal(saved.dirty, true)
  assert.equal(saved.parameterValues.tone, 'playful')
  assert.deepEqual(replaceDraft(saved, config).parameterValues, {})
  assert.deepEqual(replaceDraft(saved, config, '', { tone: 'trial' }).parameterValues, { tone: 'trial' })
})

test('parameter save values are optional but explicit values travel separately from the template', async () => {
  let payload
  const api = createClientApi({ getConfig() {}, saveConfig(input) { payload = input; return input } })
  const config = examplePresets()[0]
  await api.saveConfig('A', 1, true, config)
  assert.ok(!Object.hasOwn(payload, 'parameterValues'))
  await api.saveConfig('A', 1, true, config, { x: 2 })
  assert.deepEqual(payload.parameterValues, { x: 2 })
  assert.ok(!Object.hasOwn(payload.config, 'parameterValues'))
})
