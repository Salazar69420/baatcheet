import { randomBytes } from 'node:crypto'
import { WebSocketServer } from 'ws'
import { identify, cleanName } from './identity.js'

export const CALL_ID_RE = /^[A-Za-z0-9_-]{4,64}$/

/**
 * Pure room bookkeeping, kept separate from sockets so it is easy to test.
 * A peer is any object with an `id`.
 */
export class Rooms {
  constructor ({ maxPeers = 2 } = {}) {
    this.maxPeers = maxPeers
    this.rooms = new Map()
  }

  join (roomId, peer) {
    let room = this.rooms.get(roomId)
    if (!room) this.rooms.set(roomId, (room = new Map()))
    if (room.size >= this.maxPeers) return { ok: false, reason: 'full' }
    const others = [...room.values()]
    room.set(peer.id, peer)
    return { ok: true, others }
  }

  /** @returns {object[]} peers still in the room */
  leave (roomId, peer) {
    const room = this.rooms.get(roomId)
    if (!room) return []
    room.delete(peer.id)
    if (room.size === 0) this.rooms.delete(roomId)
    return [...room.values()]
  }

  get (roomId, peerId) {
    return this.rooms.get(roomId)?.get(peerId)
  }

  members (roomId) {
    return [...(this.rooms.get(roomId)?.values() || [])]
  }
}

const publicPeer = (p) => ({ id: p.id, login: p.login, name: p.name })

/**
 * WebSocket protocol (JSON messages)
 *  client → server: join {callId, name?} · signal {to, data} · leave · ping {t}
 *  server → client: joined · peer-joined · peer-left · signal · full · error · pong · segment · chunk
 */
export function attachSignaling (server, { db, config, onRoomEmpty }) {
  const rooms = new Rooms({ maxPeers: config.maxPeersPerCall })
  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 64 * 1024 })

  wss.on('connection', (ws, req) => {
    const peer = {
      id: randomBytes(6).toString('hex'),
      ws,
      callId: null,
      login: null,
      name: null,
      send: (msg) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg)) }
    }

    ws.isAlive = true
    ws.on('pong', () => { ws.isAlive = true })

    ws.on('message', (raw) => {
      let msg
      try { msg = JSON.parse(raw) } catch { return }
      if (!msg || typeof msg.type !== 'string') return

      switch (msg.type) {
        case 'ping':
          peer.send({ type: 'pong', t: msg.t, serverTime: Date.now() })
          break

        case 'join': {
          if (peer.callId) return
          if (!CALL_ID_RE.test(String(msg.callId))) return peer.send({ type: 'error', error: 'bad-call-id' })
          const who = identify(req, cleanName(msg.name))
          if (!who) return peer.send({ type: 'error', error: 'need-name' })
          const res = rooms.join(msg.callId, Object.assign(peer, { login: who.login, name: who.name }))
          if (!res.ok) return peer.send({ type: 'full' })
          peer.callId = msg.callId
          db.ensureCall(peer.callId)
          db.addParticipant(peer.callId, who)
          peer.send({
            type: 'joined',
            you: publicPeer(peer),
            peers: res.others.map(publicPeer),
            iceServers: config.iceServers,
            chunkSeconds: config.chunkSeconds,
            serverTime: Date.now()
          })
          for (const other of res.others) other.send({ type: 'peer-joined', peer: publicPeer(peer) })
          break
        }

        case 'signal': {
          if (!peer.callId) return
          const target = rooms.get(peer.callId, String(msg.to))
          if (target) target.send({ type: 'signal', from: peer.id, data: msg.data })
          break
        }

        case 'leave':
          leave()
          break
      }
    })

    function leave () {
      if (!peer.callId) return
      const callId = peer.callId
      peer.callId = null
      const remaining = rooms.leave(callId, peer)
      for (const other of remaining) other.send({ type: 'peer-left', id: peer.id })
      if (remaining.length === 0) onRoomEmpty?.(callId)
    }

    ws.on('close', leave)
    ws.on('error', leave)
  })

  // Drop dead sockets (phone went to sleep, network changed) so the room frees up.
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) { ws.terminate(); continue }
      ws.isAlive = false
      ws.ping()
    }
  }, 30_000)
  wss.on('close', () => clearInterval(heartbeat))

  return {
    rooms,
    wss,
    /** Send a message to everyone currently in a call. */
    broadcast (callId, msg) {
      for (const p of rooms.members(callId)) p.send(msg)
    }
  }
}
