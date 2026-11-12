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

test('sniffs audio containers from their first bytes', async () => {
  const { sniffAudio } = await import('../server/sniff.js')
  const pad = (b) => Buffer.concat([b, Buffer.alloc(16)])
  assert.deepEqual(sniffAudio(pad(Buffer.from('1a45dfa3', 'hex'))), { mime: 'audio/webm', ext: 'webm' })
  assert.deepEqual(sniffAudio(pad(Buffer.from('00000020667479704d344120', 'hex'))), { mime: 'audio/mp4', ext: 'm4a' })
  assert.deepEqual(sniffAudio(pad(Buffer.from('OggS'))), { mime: 'audio/ogg', ext: 'ogg' })
  assert.equal(sniffAudio(pad(Buffer.from('hello world!'))), null)
  assert.equal(sniffAudio(Buffer.from('short')), null)
})

test('voice notes: kind is stored, old databases get the column, text joins in order', async () => {
  const { noteText, toText } = await import('../server/export.js')
  const db = openDb(':memory:')
  db.ensureCall('note1', 'note')
  db.ensureCall('call1')
  db.ensureCall('weird', 'nonsense')
  assert.equal(db.getCall('note1').kind, 'note')
  assert.equal(db.getCall('call1').kind, 'call')
  assert.equal(db.getCall('weird').kind, 'call')
  assert.ok(db.listCalls().every(c => typeof c.kind === 'string'))
  db.addParticipant('note1', { login: 'k', name: 'Krish' })
  const base = { callId: 'note1', speakerLogin: 'k', speakerName: 'Krish', trackId: 't1', durationMs: 15000, path: '/x', mime: 'audio/mp4' }
  const a = db.insertChunk({ ...base, seq: 1, startedAt: 2000 })
  const b = db.insertChunk({ ...base, seq: 0, startedAt: 1000 })
  db.saveSegment(db.getChunk(a), { original: 'फिर देखेंगे', english: 'then we will see.', language: 'hi' })
  db.saveSegment(db.getChunk(b), { original: 'Pehle plan', english: 'First the plan,', language: 'mixed' })
  assert.equal(noteText(db.segments('note1')), 'First the plan, then we will see.')
  assert.equal(noteText(db.segments('note1'), 'original'), 'Pehle plan फिर देखेंगे')
  assert.match(toText(db.getCall('note1'), db.participants('note1'), db.segments('note1')), /^Voice note note1/)
  db.close()

  // a database created before voice notes existed
  const { DatabaseSync } = await import('node:sqlite')
  const os = await import('node:os')
  const fs = await import('node:fs')
  const path = await import('node:path')
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bc-')), 'old.db')
  const old = new DatabaseSync(file)
  old.exec('CREATE TABLE calls (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, ended_at INTEGER, title TEXT)')
  old.prepare('INSERT INTO calls (id, created_at) VALUES (?, ?)').run('legacy', 1)
  old.close()
  const migrated = openDb(file)
  assert.equal(migrated.getCall('legacy').kind, 'call')
  migrated.ensureCall('n2', 'note')
  assert.equal(migrated.getCall('n2').kind, 'note')
  migrated.close()
})
