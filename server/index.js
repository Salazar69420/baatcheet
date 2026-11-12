import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import express from 'express'

import { config } from './config.js'
import { openDb } from './db.js'
import { identify, slug } from './identity.js'
import { attachSignaling, CALL_ID_RE } from './signaling.js'
import { createPipeline } from './pipeline.js'
import { toMarkdown, toText } from './export.js'
import { sniffAudio } from './sniff.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const publicDir = path.join(here, '..', 'public')
const recordingsDir = path.join(config.dataDir, 'recordings')
fs.mkdirSync(recordingsDir, { recursive: true })

const db = openDb(path.join(config.dataDir, 'baatcheet.db'))
const app = express()
const server = http.createServer(app)

let signaling
const pipeline = createPipeline({ db, config, notify: (callId, msg) => signaling?.broadcast(callId, msg) })
signaling = attachSignaling(server, { db, config, onRoomEmpty: (callId) => db.endCall(callId) })

const EXT_BY_MIME = { 'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/mp4': 'm4a', 'audio/mpeg': 'mp3', 'audio/wav': 'wav' }

app.disable('x-powered-by')
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff')
  res.set('Referrer-Policy', 'no-referrer')
  res.set('Permissions-Policy', 'microphone=(self), camera=()')
  next()
})

function requireCall (req, res) {
  const id = req.params.id
  if (!CALL_ID_RE.test(id)) { res.status(400).json({ error: 'bad call id' }); return null }
  const call = db.getCall(id)
  if (!call) { res.status(404).json({ error: 'call not found' }); return null }
  return call
}

// ---- health & identity -----------------------------------------------------

app.get('/healthz', (req, res) => res.type('text').send('ok'))

app.get('/api/me', (req, res) => {
  const who = identify(req)
  console.log(`[visit] ${who ? `${who.name} <${who.login}> via ${who.source}` : 'unnamed visitor (no Tailscale identity yet)'} · ${String(req.headers['user-agent'] || '').slice(0, 120)}`)
  res.json({
    me: who,
    tailscale: who?.source === 'tailscale',
    transcription: Boolean(config.openrouterKey),
    model: config.model,
    chunkSeconds: config.chunkSeconds
  })
})

// In-call connection counters from the browser (no audio), logged for troubleshooting.
app.post('/api/diag', express.json({ limit: '4kb' }), (req, res) => {
  const who = identify(req)
  const d = req.body || {}
  const a = d.audio || {}
  const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : '?')
  const str = (v) => String(v ?? '').slice(0, 60)
  console.log(`[diag call ${str(d.callId)}] ${who?.name || 'unknown'} → ${str(d.peer)}: ` +
    `ice=${str(d.ice)} conn=${str(d.conn)} route=${str(d.route) || '?'} ` +
    `sent=${n(d.sentKB)}KB recv=${n(d.recvKB)}KB level=${n(d.recvLevel)} lost=${n(d.packetsLost)} ` +
    `audio=${a.paused ? 'PAUSED' : 'playing'}${a.muted ? ' MUTED' : ''} ready=${n(a.readyState)}${a.playError ? ` playError=${str(a.playError)}` : ''} ` +
    `mic=${d.micEnabled === false ? 'muted' : str(d.micState) || '?'} rec=${str(d.recMime) || 'none'}`)
  res.status(204).end()
})

// ---- calls ------------------------------------------------------------------

app.post('/api/calls', (req, res) => {
  const id = randomBytes(9).toString('base64url')
  db.ensureCall(id)
  res.status(201).json({ id })
})

app.get('/api/calls', (req, res) => {
  res.json({ calls: db.listCalls(200) })
})

app.get('/api/calls/:id', (req, res) => {
  const call = requireCall(req, res)
  if (!call) return
  res.json({
    call,
    participants: db.participants(call.id),
    segments: db.segments(call.id),
    chunks: db.chunksForCall(call.id)
  })
})

app.post('/api/calls/:id/retry', (req, res) => {
  const call = requireCall(req, res)
  if (!call) return
  const ids = db.resetFailed(call.id)
  ids.forEach(pipeline.enqueue)
  res.json({ requeued: ids.length })
})

app.get('/api/calls/:id/export.:fmt', (req, res) => {
  const call = requireCall(req, res)
  if (!call) return
  const args = [call, db.participants(call.id), db.segments(call.id)]
  const name = `baatcheet-${new Date(call.created_at).toISOString().slice(0, 10)}-${call.id}`
  if (req.params.fmt === 'md') {
    res.type('text/markdown; charset=utf-8').attachment(`${name}.md`).send(toMarkdown(...args))
  } else if (req.params.fmt === 'txt') {
    res.type('text/plain; charset=utf-8').attachment(`${name}.txt`).send(toText(...args))
  } else {
    res.status(400).json({ error: 'format must be md or txt' })
  }
})

// ---- audio chunks -------------------------------------------------------------

app.post('/api/calls/:id/chunks',
  express.raw({ type: ['audio/*', 'video/webm', 'application/octet-stream'], limit: config.maxChunkBytes }),
  (req, res) => {
    const call = requireCall(req, res)
    if (!call) return
    const who = identify(req)
    if (!who) return res.status(401).json({ error: 'unknown speaker' })

    const seq = Number(req.query.seq)
    const startedAt = Number(req.query.startedAt)
    const durationMs = Number(req.query.durationMs)
    const trackId = String(req.query.track || '')
    if (!Number.isInteger(seq) || seq < 0 || seq > 1e6 ||
        !Number.isFinite(startedAt) || !Number.isFinite(durationMs) ||
        !/^[a-z0-9]{6,32}$/.test(trackId)) {
      return res.status(400).json({ error: 'bad chunk metadata' })
    }
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) return res.status(400).json({ error: 'empty body' })

    // Trust the bytes, not the label: Safari sometimes sends an empty or wrong type.
    const declared = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase().replace('video/', 'audio/')
    const sniffed = sniffAudio(req.body)
    const mime = sniffed?.mime || (EXT_BY_MIME[declared] ? declared : 'application/octet-stream')
    const ext = sniffed?.ext || EXT_BY_MIME[declared] || 'bin'
    if (!sniffed) console.warn(`[chunk] ${who.name} seq ${req.query.seq}: unrecognised audio (declared ${declared || 'none'}, first bytes ${req.body.subarray(0, 12).toString('hex')})`)
    const dir = path.join(recordingsDir, call.id)
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, `${slug(who.login)}-${trackId}-${String(seq).padStart(5, '0')}.${ext}`)

    const chunkId = db.insertChunk({
      callId: call.id,
      speakerLogin: who.login,
      speakerName: who.name,
      trackId,
      seq,
      startedAt: Math.round(startedAt),
      durationMs: Math.round(durationMs),
      path: file,
      mime
    })
    if (chunkId === null) return res.status(200).json({ duplicate: true })

    fs.writeFileSync(file, req.body)
    db.addParticipant(call.id, who)
    if (config.openrouterKey) pipeline.enqueue(chunkId)
    else db.setChunkStatus(chunkId, 'failed', 'OPENROUTER_API_KEY is not set')
    res.status(201).json({ id: chunkId })
  })

app.get('/api/chunks/:chunkId/audio', (req, res) => {
  const chunk = db.getChunk(Number(req.params.chunkId))
  if (!chunk) return res.status(404).end()
  const resolved = path.resolve(chunk.path)
  if (!resolved.startsWith(path.resolve(recordingsDir) + path.sep)) return res.status(403).end()
  res.type(chunk.mime).sendFile(resolved)
})

// ---- pages ------------------------------------------------------------------

app.get('/call/:id', (req, res) => {
  if (!CALL_ID_RE.test(req.params.id)) return res.status(400).send('Bad call id')
  res.sendFile(path.join(publicDir, 'call.html'))
})
app.use(express.static(publicDir, { extensions: ['html'] }))

app.use((err, req, res, next) => {
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'chunk too large' })
  console.error(err)
  res.status(500).json({ error: 'internal error' })
})

// ---- start ---------------------------------------------------------------------

server.listen(config.port, config.host, () => {
  const resumed = config.openrouterKey ? pipeline.resume() : 0
  console.log(`baatcheet listening on http://${config.host}:${config.port}`)
  console.log(`  model: ${config.model} · chunk: ${config.chunkSeconds}s · data: ${config.dataDir}`)
  if (!config.openrouterKey) console.warn('  ⚠ OPENROUTER_API_KEY is not set — calls work, but nothing will be transcribed.')
  if (resumed) console.log(`  resumed ${resumed} unfinished chunk(s)`)
})

function shutdown () {
  console.log('shutting down…')
  signaling.wss.close()
  server.close(() => { db.close(); process.exit(0) })
  setTimeout(() => process.exit(0), 5000).unref()
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
