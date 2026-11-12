import { getMe, displayName } from './common.js'
import { Signal } from './ws.js'
import { PeerLink } from './rtc.js'
import { ChunkRecorder, pickMime } from './recorder.js'
import { TranscriptView } from './transcript.js'
import { attachMeter } from './meter.js'

const $ = (id) => document.getElementById(id)
const callId = decodeURIComponent(location.pathname.split('/').pop())

const ui = {
  status: (text, kind = '') => { $('status').textContent = text; $('status').dataset.kind = kind },
  rec: (on) => { $('rec').hidden = !on },
  upload: (text) => { $('uploadStatus').textContent = text }
}

let localStream
let signal
let link = null // PeerLink to the other person
let recorder = null
let myId = null
let iceServers = []
let chunkSeconds = 15
let ended = false
let transcript

async function main () {
  $('link').value = location.href
  $('copy').onclick = async () => {
    try { await navigator.clipboard.writeText(location.href); $('copy').textContent = 'Copied!' } catch { $('link').select() }
    setTimeout(() => { $('copy').textContent = 'Copy link' }, 1500)
  }

  const info = await getMe()
  $('meName').textContent = `${info.me.name} (you)`
  $('meInitial').textContent = initial(info.me.name)
  transcript = new TranscriptView($('transcript'), { myLogin: info.me.login })
  if (!info.transcription) ui.upload('⚠ Transcription is off (server has no OPENROUTER_API_KEY).')

  for (const btn of document.querySelectorAll('.seg-toggle button')) {
    btn.onclick = () => {
      document.querySelectorAll('.seg-toggle button').forEach(b => b.classList.toggle('on', b === btn))
      transcript.setMode(btn.dataset.mode)
    }
  }

  if (pickMime() === null) ui.upload('⚠ This browser cannot record audio — the call works but will not be transcribed.')

  ui.status('Asking for microphone…')
  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
      video: false
    })
  } catch (err) {
    ui.status(`Microphone blocked: ${err.message}. Allow mic access and reload.`, 'error')
    return
  }
  attachMeter(localStream, $('meMeter'))

  $('mute').onclick = toggleMute
  $('hangup').onclick = hangUp
  window.addEventListener('beforeunload', (e) => {
    if (recorder?.backlog) { e.preventDefault(); e.returnValue = '' }
  })

  // Load anything already transcribed (e.g. after a page reload mid-call).
  fetch(`/api/calls/${encodeURIComponent(callId)}`).then(r => r.ok ? r.json() : null).then(d => {
    if (d) transcript.addAll(d.segments)
  }).catch(() => {})

  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  signal = new Signal(`${proto}://${location.host}/ws`)
  signal.addEventListener('open', () => {
    ui.status('Joining…')
    signal.send({ type: 'join', callId, name: displayName() })
  })
  signal.addEventListener('close', () => { if (!ended) ui.status('Connection to server lost — reconnecting…', 'warn') })
  signal.addEventListener('message', (e) => onMessage(e.detail))
}

function onMessage (msg) {
  switch (msg.type) {
    case 'joined':
      myId = msg.you.id
      iceServers = msg.iceServers
      chunkSeconds = msg.chunkSeconds
      // after a reconnect the old link is stale
      closeLink()
      if (msg.peers.length) connectTo(msg.peers[0])
      else ui.status('Waiting for your friend to open the link…')
      break

    case 'peer-joined':
      connectTo(msg.peer)
      break

    case 'peer-left':
      if (link?.peerId === msg.id) {
        closeLink()
        ui.status('Your friend left. Waiting for them to come back…', 'warn')
        setThem(null)
        stopRecording()
      }
      break

    case 'signal':
      if (!link || link.peerId !== msg.from) {
        // signal from someone we haven't set up yet (shouldn't normally happen)
        connectTo({ id: msg.from, name: 'Friend' })
      }
      link.handleSignal(msg.data)
      break

    case 'full':
      ui.status('This call already has two people in it.', 'error')
      ended = true
      signal.close()
      break

    case 'error':
      ui.status(`Error: ${msg.error}`, 'error')
      break

    case 'segment':
      transcript.add(msg.segment)
      break

    case 'chunk':
      if (msg.status === 'failed') ui.upload(`⚠ A chunk failed to transcribe: ${msg.error || 'unknown error'} (retry from History)`)
      break
  }
}

function connectTo (peer) {
  closeLink()
  setThem(peer)
  ui.status(`Connecting to ${peer.name}…`)
  link = new PeerLink({
    peerId: peer.id,
    polite: myId < peer.id,
    iceServers,
    localStream,
    sendSignal: (data) => signal.send({ type: 'signal', to: peer.id, data })
  })
  link.addEventListener('stream', (e) => {
    const audio = $('remoteAudio')
    if (audio.srcObject !== e.detail) {
      audio.srcObject = e.detail
      audio.play().catch(() => ui.status('Tap anywhere to hear your friend', 'warn'))
      document.addEventListener('click', () => audio.play().catch(() => {}), { once: true })
      attachMeter(e.detail, $('themMeter'))
    }
  })
  link.addEventListener('state', (e) => {
    const s = e.detail
    if (s === 'connected') {
      ui.status(`In call with ${peer.name}`, 'ok')
      $('share').hidden = true
      startRecording()
    } else if (s === 'disconnected') {
      ui.status('Connection unstable — trying to recover…', 'warn')
    } else if (s === 'failed') {
      ui.status('Could not connect directly. If you are not both on Tailscale, configure a TURN server.', 'error')
    }
  })
}

function closeLink () {
  if (link) { link.close(); link = null }
}

function setThem (peer) {
  $('themName').textContent = peer ? peer.name : 'Waiting for your friend'
  $('themInitial').textContent = peer ? initial(peer.name) : '…'
  $('share').hidden = Boolean(peer)
}

function startRecording () {
  if (recorder || pickMime() === null) return
  recorder = new ChunkRecorder({
    stream: localStream,
    chunkSeconds,
    now: () => signal.now(),
    upload: uploadChunk
  })
  recorder.addEventListener('upload-retry', () => ui.upload(`Uploading… (${recorder?.backlog ?? 0} waiting, retrying)`))
  recorder.addEventListener('uploaded', () => ui.upload(recorder?.backlog ? `Uploading… (${recorder.backlog} waiting)` : ''))
  recorder.addEventListener('upload-failed', (e) => ui.upload(`⚠ Gave up uploading chunk #${e.detail.seq}`))
  recorder.start()
  ui.rec(true)
}

async function stopRecording () {
  const r = recorder
  recorder = null
  ui.rec(false)
  if (r) {
    if (r.backlog) ui.upload('Finishing uploads…')
    await r.stop()
    ui.upload('')
  }
}

async function uploadChunk ({ seq, startedAt, durationMs, blob, track }) {
  const qs = new URLSearchParams({ seq, startedAt, durationMs, track })
  const res = await fetch(`/api/calls/${encodeURIComponent(callId)}/chunks?${qs}`, {
    method: 'POST',
    headers: {
      'Content-Type': (blob.type || 'audio/webm').split(';')[0],
      'X-Baatcheet-Name': encodeURIComponent(displayName())
    },
    body: blob
  })
  if (!res.ok) throw Object.assign(new Error(`upload failed: HTTP ${res.status}`), { status: res.status })
}

function toggleMute () {
  const track = localStream.getAudioTracks()[0]
  track.enabled = !track.enabled
  $('mute').setAttribute('aria-pressed', String(!track.enabled))
  $('mute').textContent = track.enabled ? '🎙️' : '🔇'
  $('mute').title = track.enabled ? 'Mute' : 'Unmute'
}

async function hangUp () {
  ended = true
  closeLink()
  ui.status('Call ended. Saving the last bits of audio…')
  await stopRecording()
  signal?.close()
  localStream?.getTracks().forEach(t => t.stop())
  location.href = `/history.html?id=${encodeURIComponent(callId)}`
}

function initial (name) {
  return (name || '?').trim().charAt(0).toUpperCase() || '?'
}

main().catch(err => {
  console.error(err)
  ui.status(`Something went wrong: ${err.message}`, 'error')
})
