// Audio level meters read from WebRTC stats instead of the Web Audio API.
//
// Why not an AudioContext/AnalyserNode (like roll-call's waudio)? On iPhone/iPad Safari,
// routing a remote WebRTC stream into an AudioContext (which starts suspended until a tap)
// can silence that stream's <audio> element, so you see "connected" but hear nothing.
// RTCPeerConnection stats give us the same levels with no side effects.

function setLevel (el, level) {
  // audioLevel is linear 0..1; speech usually sits around 0.01–0.3, so lift it for display
  const shown = Math.min(1, Math.sqrt(Math.max(0, level || 0)) * 1.6)
  el.style.setProperty('--level', shown.toFixed(3))
}

/**
 * @param {RTCPeerConnection} pc
 * @param {{local: HTMLElement, remote: HTMLElement}} els
 * @returns {() => void} stop function
 */
export function startMeters (pc, { local, remote }) {
  let stopped = false
  const tick = async () => {
    if (stopped) return
    try {
      const recv = pc.getReceivers().find(r => r.track?.kind === 'audio')
      const src = recv?.getSynchronizationSources?.()[0]
      setLevel(remote, src?.audioLevel ?? 0)

      let localLevel = 0
      const stats = await pc.getStats()
      stats.forEach(s => {
        if (s.type === 'media-source' && s.kind === 'audio' && typeof s.audioLevel === 'number') localLevel = s.audioLevel
      })
      setLevel(local, localLevel)
    } catch {}
    if (!stopped) setTimeout(tick, 150)
  }
  tick()
  return () => { stopped = true; setLevel(local, 0); setLevel(remote, 0) }
}

/**
 * Snapshot of what the connection is doing, for the on-screen hint and server logs.
 * @param {RTCPeerConnection} pc
 */
export async function connectionSnapshot (pc) {
  const out = { ice: pc.iceConnectionState, conn: pc.connectionState, sentKB: 0, recvKB: 0, route: '' }
  const stats = await pc.getStats()
  const byId = new Map()
  stats.forEach(s => byId.set(s.id, s))
  stats.forEach(s => {
    if (s.type === 'outbound-rtp' && s.kind === 'audio') out.sentKB += (s.bytesSent || 0) / 1024
    if (s.type === 'inbound-rtp' && s.kind === 'audio') {
      out.recvKB += (s.bytesReceived || 0) / 1024
      out.packetsLost = s.packetsLost
      if (typeof s.audioLevel === 'number') out.recvLevel = Number(s.audioLevel.toFixed(3))
    }
    if (s.type === 'transport' && s.selectedCandidatePairId) {
      const pair = byId.get(s.selectedCandidatePairId)
      const l = pair && byId.get(pair.localCandidateId)
      const r = pair && byId.get(pair.remoteCandidateId)
      if (l && r) out.route = `${l.candidateType}/${l.protocol} → ${r.candidateType}`
    }
  })
  if (!out.route) {
    // Safari doesn't always expose transport.selectedCandidatePairId
    stats.forEach(s => {
      if (!out.route && s.type === 'candidate-pair' && s.state === 'succeeded' && (s.nominated || s.selected)) {
        const l = byId.get(s.localCandidateId)
        const r = byId.get(s.remoteCandidateId)
        if (l && r) out.route = `${l.candidateType}/${l.protocol} → ${r.candidateType}`
      }
    })
  }
  out.sentKB = Math.round(out.sentKB)
  out.recvKB = Math.round(out.recvKB)
  return out
}
