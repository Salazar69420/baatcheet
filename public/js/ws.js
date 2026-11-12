// WebSocket client that reconnects on its own and keeps a server clock offset.

export class Signal extends EventTarget {
  constructor (url) {
    super()
    this.url = url
    this.ws = null
    this.closed = false
    this.retry = 0
    this.clockOffset = 0 // serverTime - localTime, in ms
    this.connect()
  }

  connect () {
    const ws = new WebSocket(this.url)
    this.ws = ws
    ws.onopen = () => {
      this.retry = 0
      this.dispatchEvent(new Event('open'))
      this.ping()
      clearInterval(this.pingTimer)
      this.pingTimer = setInterval(() => this.ping(), 20_000)
    }
    ws.onmessage = (e) => {
      let msg
      try { msg = JSON.parse(e.data) } catch { return }
      if (msg.type === 'pong') {
        const now = Date.now()
        const rtt = now - msg.t
        this.clockOffset = msg.serverTime - (msg.t + rtt / 2)
        return
      }
      this.dispatchEvent(new CustomEvent('message', { detail: msg }))
    }
    ws.onclose = () => {
      clearInterval(this.pingTimer)
      this.dispatchEvent(new Event('close'))
      if (this.closed) return
      const delay = Math.min(10_000, 500 * 2 ** this.retry++)
      setTimeout(() => this.connect(), delay)
    }
    ws.onerror = () => ws.close()
  }

  ping () { this.send({ type: 'ping', t: Date.now() }) }

  /** Current time on the server's clock (used to line up both speakers). */
  now () { return Date.now() + this.clockOffset }

  send (msg) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg))
      return true
    }
    return false
  }

  close () {
    this.closed = true
    this.send({ type: 'leave' })
    this.ws?.close()
  }
}
