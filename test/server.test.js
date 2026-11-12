import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decodeHeaderWord, identify } from '../server/identity.js'
import { mergeSegments, offset, toText } from '../server/export.js'
import { JobQueue } from '../server/queue.js'
import { openDb } from '../server/db.js'

test('decodes RFC 2047 Tailscale names', () => {
  assert.equal(decodeHeaderWord('=?utf-8?q?K=C3=A4rtik_G?='), 'Kärtik G')
  assert.equal(decodeHeaderWord('=?utf-8?b?4KSV4KS+4KSw4KWN4KSk4KS/4KSV?='), 'कार्तिक')
  assert.equal(decodeHeaderWord('Plain Name'), 'Plain Name')
})

test('identity prefers Tailscale headers, falls back to a local name', () => {
  const ts = identify({ headers: { 'tailscale-user-login': 'me@example.com', 'tailscale-user-name': 'Me' } }, 'Spoof')
  assert.deepEqual(ts, { login: 'me@example.com', name: 'Me', source: 'tailscale' })
  const local = identify({ headers: { 'x-baatcheet-name': encodeURIComponent('Riya S') } })
  assert.deepEqual(local, { login: 'local:riya-s', name: 'Riya S', source: 'local' })
  assert.equal(identify({ headers: {} }), null)
  assert.equal(identify({ headers: { 'x-baatcheet-name': '%E0%A4' } }), null)
})

test('segments from both speakers merge by start time', () => {
  const segs = [
    { id: 2, started_at: 2000, speaker_name: 'B', original: 'haan', english: 'yes', language: 'hi' },
    { id: 1, started_at: 1000, speaker_name: 'A', original: 'hello', english: 'hello', language: 'en' }
  ]
  assert.deepEqual(mergeSegments(segs).map(s => s.id), [1, 2])
  assert.equal(offset(65_000), '01:05')
  assert.equal(offset(3_725_000), '1:02:05')
  const txt = toText({ id: 'x', created_at: 0 }, [{ name: 'A' }, { name: 'B' }], segs)
  assert.match(txt, /\[00:01\] A: hello\n\[00:02\] B: yes\n {4}\(original\) haan/)
})

test('job queue retries then fails', async () => {
  let calls = 0
  let failed = null
  const q = new JobQueue({
    worker: async () => { calls++; throw new Error('boom') },
    maxAttempts: 3,
    baseDelayMs: 1,
    onFailed: (id, err) => { failed = [id, err.message] }
  })
  q.push(7)
  await new Promise(r => setTimeout(r, 50))
  assert.equal(calls, 3)
  assert.deepEqual(failed, [7, 'boom'])
})

test('job queue does not retry non-retryable errors and respects concurrency', async () => {
  let running = 0; let peak = 0; let calls = 0
  const q = new JobQueue({
    concurrency: 2,
    worker: async (id) => {
      calls++; running++; peak = Math.max(peak, running)
      await new Promise(r => setTimeout(r, 5))
      running--
      if (id === 'bad') throw Object.assign(new Error('400'), { retryable: false })
    }
  })
  for (const id of [1, 2, 3, 'bad']) q.push(id)
  await q.idle()
  assert.equal(peak, 2)
  assert.equal(calls, 4)
})

test('database round-trip: chunks dedupe per track and segments come back ordered', () => {
  const db = openDb(':memory:')
  db.ensureCall('call1')
  db.addParticipant('call1', { login: 'a', name: 'A' })
  const base = { callId: 'call1', speakerLogin: 'a', speakerName: 'A', trackId: 't1', durationMs: 1000, path: '/x', mime: 'audio/webm' }
  const c1 = db.insertChunk({ ...base, seq: 0, startedAt: 2000 })
  assert.equal(db.insertChunk({ ...base, seq: 0, startedAt: 2000 }), null)
  const c2 = db.insertChunk({ ...base, trackId: 't2', seq: 0, startedAt: 1000 })
  assert.ok(c1 && c2 && c1 !== c2)
  db.saveSegment(db.getChunk(c1), { original: 'b', english: 'b', language: 'en' })
  db.saveSegment(db.getChunk(c2), { original: 'a', english: 'a', language: 'en' })
  assert.deepEqual(db.segments('call1').map(s => s.original), ['a', 'b'])
  assert.equal(db.previousSegment('call1', 2000).original, 'a')
  assert.deepEqual(db.resumableChunkIds().sort(), [c1, c2].sort())
  db.setChunkStatus(c1, 'failed', 'x')
  assert.deepEqual(db.resetFailed('call1'), [c1])
  assert.equal(db.listCalls()[0].segment_count, 2)
  db.close()
})
