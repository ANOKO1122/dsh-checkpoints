import assert from 'node:assert/strict'
import test from 'node:test'
import { createOperationLock, withMaintenance, type MaintenanceOwner } from '../src/operation-lock.ts'
import { loadRequiredImages } from '../src/client/required-images.ts'
import { createLatestRequest } from '../src/client/latest-request.ts'

test('workspace operations serialize and a failure does not poison the lock', async () => {
  const lock = createOperationLock()
  const order: number[] = []
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const first = lock('same', async () => { order.push(1); await gate; order.push(2); throw new Error('failure') })
  const rejected = assert.rejects(first, /failure/)
  const second = lock('same', async () => { order.push(3) })
  await lock('different', async () => { order.push(0) })
  assert.deepEqual(order, [1, 0])
  release()
  await Promise.all([rejected, second])
  assert.deepEqual(order, [1, 0, 2, 3])
  await lock('same', async () => { order.push(4) })
})

test('maintenance reserves all affected agents and releases them after failure', async () => {
  let active = 0
  const owner: MaintenanceOwner = {
    async runMaintenance(task) {
      active++
      try { return await task(new AbortController().signal) } finally { active-- }
    },
  }
  await assert.rejects(withMaintenance([owner, owner], async () => {
    assert.equal(active, 2)
    throw new Error('storage failure')
  }), /storage failure/)
  assert.equal(active, 0)
})

test('busy maintenance owner prevents every mutation', async () => {
  const busy: MaintenanceOwner = { runMaintenance() { throw new Error('busy') } }
  let called = false
  assert.throws(() => withMaintenance([busy], async () => { called = true }), /busy/)
  assert.equal(called, false)
})

test('partial image loads fail closed and release every successful preview', async () => {
  const disposed: number[] = []
  await assert.rejects(loadRequiredImages([1, 2, 3], async id => {
    if (id === 2) throw new Error('missing attachment')
    return id
  }, id => disposed.push(id)), /1 张原消息图片加载失败/)
  assert.deepEqual(disposed, [1, 3])
  assert.deepEqual(await loadRequiredImages([1, 3], async id => id, () => assert.fail()), [1, 3])
})

test('stale requests cannot overwrite newer data or a changed session', () => {
  const requests = createLatestRequest()
  const first = requests.begin()
  const next = requests.begin()
  assert.equal(first(), false)
  assert.equal(next(), true)
  requests.invalidate()
  assert.equal(next(), false)
})
