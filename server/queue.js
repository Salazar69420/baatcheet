/**
 * Tiny in-process job queue: limited concurrency, retries with exponential backoff.
 * Durability comes from the database: on boot, unfinished chunks are pushed again.
 */
export class JobQueue {
  /**
   * @param {object} opts
   * @param {(id: any) => Promise<void>} opts.worker
   * @param {number} [opts.concurrency]
   * @param {number} [opts.maxAttempts]
   * @param {number} [opts.baseDelayMs]
   * @param {(id: any, err: Error, attempt: number) => void} [opts.onRetry]
   * @param {(id: any, err: Error) => void} [opts.onFailed]
   */
  constructor ({ worker, concurrency = 2, maxAttempts = 3, baseDelayMs = 2000, onRetry, onFailed }) {
    Object.assign(this, { worker, concurrency, maxAttempts, baseDelayMs, onRetry, onFailed })
    this.waiting = []
    this.queued = new Set()
    this.running = 0
    this.attempts = new Map()
    this.idleResolvers = []
  }

  push (id) {
    if (this.queued.has(id)) return
    this.queued.add(id)
    this.waiting.push(id)
    this._pump()
  }

  get size () { return this.waiting.length + this.running }

  /** Resolves when nothing is waiting or running (retries scheduled later don't count). */
  idle () {
    if (this.size === 0) return Promise.resolve()
    return new Promise(resolve => this.idleResolvers.push(resolve))
  }

  _pump () {
    while (this.running < this.concurrency && this.waiting.length) {
      const id = this.waiting.shift()
      this.running++
      this._run(id).finally(() => {
        this.running--
        this._pump()
        if (this.size === 0) this.idleResolvers.splice(0).forEach(r => r())
      })
    }
  }

  async _run (id) {
    const attempt = (this.attempts.get(id) || 0) + 1
    this.attempts.set(id, attempt)
    try {
      await this.worker(id)
      this.queued.delete(id)
      this.attempts.delete(id)
    } catch (err) {
      const retryable = err?.retryable !== false
      if (retryable && attempt < this.maxAttempts) {
        this.onRetry?.(id, err, attempt)
        const delay = this.baseDelayMs * 2 ** (attempt - 1)
        setTimeout(() => { this.waiting.push(id); this._pump() }, delay).unref?.()
      } else {
        this.queued.delete(id)
        this.attempts.delete(id)
        this.onFailed?.(id, err)
      }
    }
  }
}
