import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Rooms, CALL_ID_RE } from '../server/signaling.js'

test('rooms admit two peers and reject a third', () => {
  const rooms = new Rooms({ maxPeers: 2 })
  const a = { id: 'a' }; const b = { id: 'b' }; const c = { id: 'c' }
  assert.deepEqual(rooms.join('r1', a), { ok: true, others: [] })
  assert.deepEqual(rooms.join('r1', b), { ok: true, others: [a] })
  assert.deepEqual(rooms.join('r1', c), { ok: false, reason: 'full' })
  assert.equal(rooms.get('r1', 'b'), b)
})

test('leaving frees the slot and empty rooms are removed', () => {
  const rooms = new Rooms({ maxPeers: 2 })
  const a = { id: 'a' }; const b = { id: 'b' }
  rooms.join('r', a); rooms.join('r', b)
  assert.deepEqual(rooms.leave('r', a), [b])
  assert.equal(rooms.join('r', { id: 'c' }).ok, true)
  rooms.leave('r', b); rooms.leave('r', { id: 'c' })
  assert.equal(rooms.rooms.has('r'), false)
  assert.deepEqual(rooms.leave('nope', a), [])
})

test('call ids are validated', () => {
  assert.ok(CALL_ID_RE.test('AbC_12-xyz'))
  assert.ok(!CALL_ID_RE.test('../etc'))
  assert.ok(!CALL_ID_RE.test('abc'))
})
