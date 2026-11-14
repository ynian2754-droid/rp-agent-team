import assert from 'node:assert/strict'
import test from 'node:test'
import { simulationEvidenceCatalog, simulationGroundRefs } from '../src/host/lived-history-sim-evidence.mjs'

test('the visible actor packet distinguishes the three uses of a self key from prior conduct', () => {
  const actor = {
    self: {
      account: { now: { text: '她有自己的解释。', when: '周二' }, before: null },
      commitments: { k1: { text: '答应她自己要把话说清楚。', since: '周一' } },
      carrying: { k1: { what: '表格还没有填。' }, k2: { what: '旧事已了', done: 'event-done' } },
      wants: { k1: { what: '下周前把表填上。', by: '周三' } }
    },
    toward: { 小林: { view: '她不会失约。' } },
    knows: [{ id: 'before', when: '周一' }],
    memories: [{ key: 'm1', event: 'before', storyTime: '周一' }],
    practices: [{ key: 'practice:0', last: '周五' }],
    ground_refs: ['self.commitments.absent']
  }
  const options = { includeSelf: true, stimulus: [{ event: 'present', when: '周二' }, { content: '灯亮了。' }] }
  const refs = simulationGroundRefs(actor, options.stimulus)
  assert.deepEqual(refs, [
    'before', 'm1', 'practice:0', 'self.commitments.k1', 'self.carrying.k1', 'self.wants.k1',
    'self.account.now', 'present', '此刻场面', '处境'
  ])
  const catalog = simulationEvidenceCatalog(actor, options)
  assert.deepEqual(catalog.get('self.commitments.k1'), {
    origin: 'self.commitments.k1', time: '周一', historical: false, personal: true
  })
  assert.deepEqual(catalog.get('m1'), { origin: 'before', time: '周一', historical: true })
  assert.equal(catalog.get('present').historical, false)
  assert.equal(catalog.has('k1'), false)
  assert.equal(catalog.has('self.commitments.absent'), false)
  assert.equal(simulationEvidenceCatalog(actor).has('self.commitments.k1'), false)
})

test('refs are local to an actor, and colliding lookups remain unavailable', () => {
  const actor = {
    knows: [{ id: 'self.commitments.k1', when: '周一' }, { id: 'old', when: '周一' }],
    precedents: [{ id: 'old', when: '周一' }],
    self: { commitments: { k1: { text: '一条规矩。' } } }
  }
  const peer = {
    self: { commitments: { k2: { text: '另一条规矩。' } } }
  }
  const first = simulationEvidenceCatalog(actor, { includeSelf: true })
  const second = simulationEvidenceCatalog(peer, { includeSelf: true })
  assert.equal(first.has('self.commitments.k1'), false)
  assert.equal(first.has('self.commitments.k2'), false)
  assert.equal(first.get('old').historical, true)
  assert.equal(second.has('self.commitments.k1'), false)
  assert.equal(second.get('self.commitments.k2').historical, false)
})
