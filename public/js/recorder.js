// Records ONLY the local microphone, as a series of standalone audio files.
//
// Why stop/restart instead of MediaRecorder's timeslice? With a timeslice, only the
// first blob has the container header, so later blobs can't be decoded on their own.
// Restarting the recorder gives every chunk its own header (gap ≈ a few ms).

const WEBM_FIRST = [
  'audio/webm;codecs=opus',
  'audio/ogg;codecs=opus',
  'audio/mp4;codecs=mp4a.40.2',
  'audio/mp4',
  'audio/webm'
]
// Safari (all iPhone/iPad browsers are Safari underneath) says it can record WebM,
// but its native and most reliable recorder output is MP4/AAC.
const MP4_FIRST = ['audio/mp4;codecs=mp4a.40.2', 'audio/mp4', ...WEBM_FIRST]

export function isAppleWebKit () {
  const ua = navigator.userAgent || ''
  const iOS = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  const desktopSafari = /Safari\//.test(ua) && !/Chrome|Chromium|CriOS|Edg|OPR|Firefox|FxiOS/.test(ua)
  return iOS || desktopSafari
}

export function pickMime () {
  if (typeof MediaRecorder === 'undefined') return null
  const list = isAppleWebKit() ? MP4_FIRST : WEBM_FIRST
  return list.find(t => MediaRecorder.isTypeSupported(t)) || ''
}

export class ChunkRecorder extends EventTarget {
  /**
   * @param {object} opts
   * @param {MediaStream} opts.stream     local mic stream
   * @param {number} opts.chunkSeconds
   * @param {() => number} opts.now       server-synced clock
   * @param {(chunk: {seq:number, startedAt:number, durationMs:number, blob:Blob, track:string}) => Promise<void>} opts.upload
   */
  constructor ({ stream, chunkSeconds, now, upload }) {
    super()
    this.stream = stream
    this.chunkMs = chunkSeconds * 1000
    this.now = now
    this.upload = upload
    this.mime = pickMime()
    this.track = Array.from(crypto.getRandomValues(new Uint8Array(8)), b => (b % 36).toString(36)).join('')
    this.seq = 0
    this.running = false
    this.pending = [] // chunks waiting to upload
    this.uploading = false
    this.current = null
    this.chunksMade = 0
    this.bytesMade = 0
    this.lastError = ''
  }

  start () {
    if (this.mime === null) throw new Error('This browser cannot record audio (no MediaRecorder).')
    if (this.running) return
    this.running = true
    this._startOne()
  }

  _startOne () {
    if (!this.running) return
    let rec
    const parts = []
    const startedAt = this.now()
    const t0 = performance.now()
    try {
      const opts = { audioBitsPerSecond: 32_000 }
      if (this.mime && !this.useDefaultMime) opts.mimeType = this.mime
      rec = new MediaRecorder(this.stream, opts)
      rec.ondataavailable = (e) => { if (e.data?.size) parts.push(e.data) }
      rec.onerror = (e) => {
        const err = e.error || e
        this.lastError = `${err.name || 'Error'}: ${err.message || ''}`.trim()
        this.dispatchEvent(new CustomEvent('error', { detail: err }))
      }
      rec.start()
    } catch (err) {
      // e.g. iOS refusing a mimeType, or the previous recorder still finalizing.
      this.lastError = `${err.name || 'Error'}: ${err.message || ''}`.trim()
      this.dispatchEvent(new CustomEvent('error', { detail: err }))
      if (this.mime && !this.useDefaultMime) this.useDefaultMime = true // retry with the browser's default format
      this.timer = setTimeout(() => this._startOne(), 2000)
      return
    }

    const seq = this.seq++
    rec.onstop = () => {
      const mime = parts[0]?.type || rec.mimeType || this.mime || ''
      const blob = new Blob(parts, { type: mime })
      this.chunksMade++
      this.bytesMade += blob.size
      if (blob.size > 0) {
        this.pending.push({ seq, startedAt, durationMs: Math.round(performance.now() - t0), blob, track: this.track, mime })
        this._drain()
      }
      this.dispatchEvent(new CustomEvent('chunk-closed', { detail: { seq, bytes: blob.size } }))
    }

    this.current = rec
    this.timer = setTimeout(() => {
      if (rec.state === 'inactive') return this._startOne()
      // start the next chunk only after this one has fully finished (safer on iOS)
      rec.addEventListener('stop', () => this._startOne(), { once: true })
      rec.stop()
    }, this.chunkMs)
  }

  /** Stop recording; resolves once every chunk has been uploaded (or given up on). */
  async stop () {
    this.running = false
    clearTimeout(this.timer)
    const rec = this.current
    if (rec && rec.state !== 'inactive') {
      await new Promise(resolve => {
        rec.addEventListener('stop', () => setTimeout(resolve, 0), { once: true })
        rec.stop()
      })
    }
    await this.flushed()
  }

  flushed () {
    if (!this.pending.length && !this.uploading) return Promise.resolve()
    return new Promise(resolve => this.addEventListener('drained', resolve, { once: true }))
  }

  get backlog () { return this.pending.length + (this.uploading ? 1 : 0) }

  async _drain () {
    if (this.uploading) return
    this.uploading = true
    while (this.pending.length) {
      const chunk = this.pending[0]
      let ok = false
      for (let attempt = 0; attempt < 6 && !ok; attempt++) {
        try {
          await this.upload(chunk)
          ok = true
        } catch (err) {
          if (err.status && err.status >= 400 && err.status < 500 && err.status !== 408 && err.status !== 429) break
          this.dispatchEvent(new CustomEvent('upload-retry', { detail: { seq: chunk.seq, err } }))
          await new Promise(r => setTimeout(r, Math.min(15_000, 1000 * 2 ** attempt)))
        }
      }
      this.pending.shift()
      this.dispatchEvent(new CustomEvent(ok ? 'uploaded' : 'upload-failed', { detail: { seq: chunk.seq } }))
    }
    this.uploading = false
    this.dispatchEvent(new Event('drained'))
  }
}
