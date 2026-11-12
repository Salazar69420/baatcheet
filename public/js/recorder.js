// Records ONLY the local microphone, as a series of standalone audio files.
//
// Why stop/restart instead of MediaRecorder's timeslice? With a timeslice, only the
// first blob has the container header, so later blobs can't be decoded on their own.
// Restarting the recorder gives every chunk its own header (gap ≈ a few ms).

const MIME_CANDIDATES = [
  'audio/webm;codecs=opus',
  'audio/ogg;codecs=opus',
  'audio/mp4;codecs=mp4a.40.2',
  'audio/mp4',
  'audio/webm'
]

export function pickMime () {
  if (typeof MediaRecorder === 'undefined') return null
  return MIME_CANDIDATES.find(t => MediaRecorder.isTypeSupported(t)) || ''
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
  }

  start () {
    if (this.mime === null) throw new Error('This browser cannot record audio (no MediaRecorder).')
    if (this.running) return
    this.running = true
    this._startOne()
  }

  _startOne () {
    if (!this.running) return
    const opts = { audioBitsPerSecond: 32_000 }
    if (this.mime) opts.mimeType = this.mime
    const rec = new MediaRecorder(this.stream, opts)
    const parts = []
    const startedAt = this.now()
    const t0 = performance.now()
    const seq = this.seq++

    rec.ondataavailable = (e) => { if (e.data?.size) parts.push(e.data) }
    rec.onstop = () => {
      const blob = new Blob(parts, { type: rec.mimeType || this.mime || 'audio/webm' })
      if (blob.size > 0) {
        this.pending.push({ seq, startedAt, durationMs: Math.round(performance.now() - t0), blob, track: this.track })
        this._drain()
      }
      this.dispatchEvent(new CustomEvent('chunk-closed', { detail: { seq } }))
    }
    rec.onerror = (e) => this.dispatchEvent(new CustomEvent('error', { detail: e.error || e }))

    rec.start()
    this.current = rec
    this.timer = setTimeout(() => {
      if (rec.state !== 'inactive') rec.stop()
      this._startOne()
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
