import path from 'node:path'

const env = process.env

function num (name, fallback, { min = -Infinity, max = Infinity } = {}) {
  const raw = env[name]
  if (raw === undefined || raw === '') return fallback
  const n = Number(raw)
  if (!Number.isFinite(n) || n < min || n > max) {
    throw new Error(`Invalid ${name}=${raw} (expected a number between ${min} and ${max})`)
  }
  return n
}

function list (name) {
  return (env[name] || '').split(',').map(s => s.trim()).filter(Boolean)
}

function iceServers () {
  const servers = []
  const stun = env.STUN_URLS === undefined ? ['stun:stun.l.google.com:19302'] : list('STUN_URLS')
  if (stun.length) servers.push({ urls: stun })
  const turn = list('TURN_URLS')
  if (turn.length) {
    servers.push({ urls: turn, username: env.TURN_USERNAME || '', credential: env.TURN_CREDENTIAL || '' })
  }
  return servers
}

export const config = {
  port: num('PORT', 3000, { min: 1, max: 65535 }),
  host: env.HOST || '127.0.0.1',
  dataDir: path.resolve(env.DATA_DIR || 'data'),
  openrouterKey: env.OPENROUTER_API_KEY || '',
  model: env.MODEL || 'google/gemini-3.1-flash-lite',
  chunkSeconds: num('CHUNK_SECONDS', 15, { min: 3, max: 120 }),
  concurrency: num('TRANSCRIBE_CONCURRENCY', 2, { min: 1, max: 16 }),
  silenceDb: num('SILENCE_THRESHOLD_DB', -45, { min: -120, max: 0 }),
  ffmpeg: env.FFMPEG_PATH || 'ffmpeg',
  maxChunkBytes: 10 * 1024 * 1024,
  maxPeersPerCall: 2,
  iceServers: iceServers()
}
