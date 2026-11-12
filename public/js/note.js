// Voice notes: one phone records the room (your own thoughts, or an in-person talk),
// the server transcribes and translates each chunk, and you copy the English text out.
// Reuses the call pipeline: a note is a "call" with kind = 'note' and one speaker.

import { api, getMe, displayName, warnIfInAppBrowser, fmtOffset, h } from './common.js'
import { ChunkRecorder, pickMime } from './recorder.js'
import { renderCallList } from './history.js'

const $ = (id) => document.getElementById(id)
const MIC_CONSTRAINTS = { audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false }

let noteId = (location.pathname.match(/^\/note\/([A-Za-z0-9_-]{4,64})$/) || [])[1] || null
let chunkSeconds = 15
let stream = null
let recorder = null
let recording = false
let stopping = false
let startedAt = 0 // performance.now() of the current take
let elapsedBefore = 0 // ms recorded in earlier takes of this note
let tickTimer = null
let pollTimer = null
let wakeLock = null
let stopLevel = () => {}
let mode = 'english'
let segments = []
let micIssue = ''
let failedParts = 0

const ui = {
  status: (text, kind = '') => { $('status').textContent = text; $('status').dataset.kind = kind },
  upload: (text) => { $('uploadStatus').textContent = text }
}

async function main () {
  warnIfInAppBrowser()
  const info = await getMe()
  chunkSeconds = info.chunkSeconds || chunkSeconds
  if (!info.transcription) ui.upload('⚠ Transcription is off (server has no OPENROUTER_API_KEY).')
  if (pickMime() === null) {
    ui.status('This browser cannot record audio. Open the page in Chrome or Safari.', 'error')
    $('recBtn').disabled = true
  }

  for (const btn of document.querySelectorAll('.seg-toggle button')) {
    btn.onclick = () => {
      mode = btn.dataset.mode
      document.querySelectorAll('.seg-toggle button').forEach(b => b.classList.toggle('on', b === btn))
      $('copy').textContent = mode === 'original' ? 'Copy original' : 'Copy English'
      renderText()
    }
  }

  $('recBtn').onclick = () => (recording ? stop() : start())
  $('copy').onclick = copyText
  $('micFix').onclick = restartMic
  $('newNote').onclick = () => { location.href = '/note' }
  window.addEventListener('beforeunload', (e) => {
    if (recording || recorder?.backlog) { e.preventDefault(); e.returnValue = '' }
  })
  document.addEventListener('visibilitychange', onVisibility)

  if (noteId) {
    await refresh().catch(err => ui.status(`Could not load this note: ${err.message}`, 'error'))
    if (segments.length) ui.status('Tap the red button to add more to this note.')
  }
  loadRecent()
}

// ---- recording -------------------------------------------------------------------

async function start () {
  if (stopping) return
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    ui.status('This browser can’t use the microphone on this page. Open it over https://….ts.net with Tailscale on.', 'error')
    return
  }
  $('recBtn').disabled = true
  try {
    ui.status('Asking for microphone…')
    stream = await navigator.mediaDevices.getUserMedia(MIC_CONSTRAINTS)
    if (!noteId) {
      const created = await api('/api/calls', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: 'note' })
      })
      noteId = created.id
      history.replaceState(null, '', `/note/${noteId}`)
    }
    watchMic()
    beginRecorder()
    recording = true
    startedAt = performance.now()
    tickTimer = setInterval(tick, 500)
    stopLevel = startLevel(stream)
    keepAwake()
    setRecUi(true)
    ui.status('Recording. Keep this screen open while you talk.', 'ok')
    schedulePoll(3000)
  } catch (err) {
    stream?.getTracks().forEach(t => t.stop())
    stream = null
    ui.status(err.name === 'NotAllowedError'
      ? 'Microphone blocked. Allow mic access for this site and try again.'
      : `Could not start: ${err.message}`, 'error')
  } finally {
    $('recBtn').disabled = false
  }
}

function beginRecorder () {
  recorder = new ChunkRecorder({ stream, chunkSeconds, now: () => Date.now(), upload: uploadChunk })
  recorder.addEventListener('upload-retry', () => ui.upload(`Uploading… (${recorder?.backlog ?? 0} waiting, retrying)`))
  recorder.addEventListener('uploaded', () => { ui.upload(recorder?.backlog ? `Uploading… (${recorder.backlog} waiting)` : ''); schedulePoll(1500) })
  recorder.addEventListener('upload-failed', (e) => ui.upload(`⚠ Gave up uploading part #${e.detail.seq}. Check your connection.`))
  recorder.addEventListener('error', (e) => ui.upload(`⚠ Recorder problem: ${e.detail?.message || e.detail?.name || e.detail}. Retrying…`))
  recorder.start()
}

async function stop () {
  if (!recording || stopping) return
  stopping = true
  recording = false
  $('recBtn').disabled = true
  elapsedBefore += performance.now() - startedAt
  clearInterval(tickTimer)
  setRecUi(false)
  stopLevel()
  releaseWake()
  ui.status('Saving the last few seconds…')
  const r = recorder
  recorder = null
  try { await r?.stop() } finally {
    stream?.getTracks().forEach(t => t.stop())
    stream = null
    stopping = false
    $('recBtn').disabled = false
  }
  ui.upload('')
  api(`/api/calls/${encodeURIComponent(noteId)}/end`, { method: 'POST' }).catch(() => {})
  ui.status('Finishing the transcript…')
  schedulePoll(500)
  loadRecent()
}

async function uploadChunk ({ seq, startedAt, durationMs, blob, track, mime }) {
  const qs = new URLSearchParams({ seq, startedAt, durationMs, track })
  const res = await fetch(`/api/calls/${encodeURIComponent(noteId)}/chunks?${qs}`, {
    method: 'POST',
    headers: {
      'Content-Type': (blob.type || mime || 'application/octet-stream').split(';')[0],
      'X-Baatcheet-Name': encodeURIComponent(displayName())
    },
    body: blob
  })
  if (!res.ok) throw Object.assign(new Error(`upload failed: HTTP ${res.status}`), { status: res.status })
}

function setRecUi (on) {
  $('rec').hidden = !on
  $('recBtn').classList.toggle('on', on)
  $('recBtn').setAttribute('aria-pressed', String(on))
  $('recBtn').setAttribute('aria-label', on ? 'Stop recording' : 'Start recording')
  $('newNote').hidden = on || !noteId
}

function tick () {
  $('timer').textContent = fmtOffset(elapsedBefore + (recording ? performance.now() - startedAt : 0))
}

// ---- transcript ------------------------------------------------------------------

function schedulePoll (ms) {
  clearTimeout(pollTimer)
  pollTimer = setTimeout(poll, ms)
}

async function poll () {
  let pending = 0
  try { pending = await refresh() } catch {}
  if (recording || stopping || pending) schedulePoll(recording ? 3000 : 2000)
  else if (failedParts) ui.status(`${failedParts} part(s) could not be transcribed. Tap “Retry failed” below.`, 'warn')
  else if (noteId && segments.length) ui.status('Done. Copy it and paste it anywhere.', 'ok')
  else if (noteId) ui.status('Nothing was heard in that recording. Try again a little closer to the phone.', 'warn')
}

/** Load the note from the server; returns how many parts are still being transcribed. */
async function refresh () {
  if (!noteId) return 0
  const data = await api(`/api/calls/${encodeURIComponent(noteId)}`)
  segments = data.segments
  const chunks = data.chunks
  if (!recording && !elapsedBefore) {
    elapsedBefore = chunks.reduce((sum, c) => sum + (c.duration_ms || 0), 0)
    tick()
  }
  renderText()
  const n = (s) => chunks.filter(c => c.status === s).length
  const pending = n('pending') + n('processing')
  failedParts = n('failed')
  const parts = [`${n('done')} transcribed`]
  if (pending) parts.push(`${pending} in progress`)
  if (n('silent')) parts.push(`${n('silent')} silent`)
  if (n('failed')) parts.push(`${n('failed')} failed (${chunks.find(c => c.status === 'failed')?.error || 'error'})`)
  $('progress').textContent = chunks.length ? `Parts: ${parts.join(' · ')}` : ''
  if (n('failed') && !pending && !recording) {
    $('progress').append(' ', h('button', {
      class: 'btn small-btn',
      onclick: async (e) => {
        e.target.disabled = true
        await api(`/api/calls/${encodeURIComponent(noteId)}/retry`, { method: 'POST' }).catch(() => {})
        schedulePoll(500)
      }
    }, 'Retry failed'))
  }
  $('details').href = `/history.html?id=${encodeURIComponent(noteId)}`
  $('details').hidden = !chunks.length
  $('newNote').hidden = recording || !noteId
  return pending
}

function noteText () {
  return [...segments]
    .sort((a, b) => a.started_at - b.started_at || a.id - b.id)
    .map(s => (mode === 'original' ? (s.original || s.english) : (s.english || s.original)).trim())
    .filter(Boolean)
    .join(' ')
}

function renderText () {
  const text = noteText()
  $('copy').disabled = !text
  if (!text) return
  const p = h('p', { lang: mode === 'original' ? undefined : 'en' }, text)
  $('text').replaceChildren(p)
  if (recording) $('text').scrollTop = $('text').scrollHeight
}

async function copyText () {
  const text = noteText()
  if (!text) return
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    // Older browsers / blocked clipboard: select the text so a long-press copies it.
    const range = document.createRange()
    range.selectNodeContents($('text'))
    const sel = getSelection()
    sel.removeAllRanges()
    sel.addRange(range)
    document.execCommand?.('copy')
  }
  const label = mode === 'original' ? 'Copy original' : 'Copy English'
  $('copy').textContent = 'Copied ✓'
  setTimeout(() => { $('copy').textContent = label }, 1500)
}

async function loadRecent () {
  try {
    const { calls } = await api('/api/calls')
    renderCallList($('recent'), calls.filter(c => c.kind === 'note').slice(0, 8), { empty: 'No voice notes yet.' })
  } catch {
    $('recent').replaceChildren()
  }
}

// ---- microphone health, level meter, screen wake ----------------------------------------

function watchMic () {
  const t = stream?.getAudioTracks()[0]
  if (!t) return micProblem('No microphone found.')
  t.onmute = () => { if (recording) micProblem('Your phone paused the microphone (another app or call may be using it).') }
  t.onunmute = () => micOk()
  t.onended = () => { if (recording) micProblem('Your microphone stopped.') }
}

function onVisibility () {
  if (document.visibilityState !== 'visible') return
  if (recording) {
    keepAwake()
    const t = stream?.getAudioTracks()[0]
    if (!t || t.readyState === 'ended' || t.muted) micProblem('The microphone was paused while the page was in the background.')
  }
  if (noteId && !recording) schedulePoll(200)
}

function micProblem (why) {
  micIssue = why
  $('micMsg').textContent = `⚠ ${why} Tap “Restart my microphone” to keep going. Keep this screen open while recording.`
  $('micMsg').hidden = false
  $('micFix').hidden = false
}

function micOk () {
  micIssue = ''
  $('micMsg').hidden = true
  $('micFix').hidden = true
}

/** Fresh mic, fresh recorder; everything already uploaded stays in the note. */
async function restartMic () {
  $('micFix').disabled = true
  try {
    const fresh = await navigator.mediaDevices.getUserMedia(MIC_CONSTRAINTS)
    const old = recorder
    recorder = null
    stopLevel()
    await old?.stop()
    stream?.getTracks().forEach(t => t.stop())
    stream = fresh
    watchMic()
    if (recording) { beginRecorder(); stopLevel = startLevel(stream) }
    micOk()
  } catch (err) {
    micProblem(`Could not restart the microphone (${err.name}: ${err.message}).`)
  } finally {
    $('micFix').disabled = false
  }
}

function startLevel (s) {
  const bar = $('level').firstElementChild
  let ctx
  try { ctx = new (window.AudioContext || window.webkitAudioContext)() } catch { return () => {} }
  const src = ctx.createMediaStreamSource(s)
  const an = ctx.createAnalyser()
  an.fftSize = 512
  src.connect(an)
  const buf = new Uint8Array(an.fftSize)
  let raf = 0
  const draw = () => {
    an.getByteTimeDomainData(buf)
    let peak = 0
    for (const v of buf) peak = Math.max(peak, Math.abs(v - 128))
    bar.style.width = `${Math.min(100, (peak / 128) * 160)}%`
    raf = requestAnimationFrame(draw)
  }
  ctx.resume().catch(() => {})
  draw()
  return () => { cancelAnimationFrame(raf); bar.style.width = '0'; ctx.close().catch(() => {}) }
}

async function keepAwake () {
  try { if (!wakeLock && 'wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen') } catch {}
  wakeLock?.addEventListener?.('release', () => { wakeLock = null }, { once: true })
}

function releaseWake () {
  wakeLock?.release().catch(() => {})
  wakeLock = null
}

main().catch(err => {
  console.error(err)
  ui.status(`Something went wrong: ${err.message}`, 'error')
})
