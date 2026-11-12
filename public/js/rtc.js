// One WebRTC connection to the other person, using the "perfect negotiation" pattern
// (https://w3c.github.io/webrtc-pc/#perfect-negotiation-example) so it doesn't matter
// who sends the first offer.

export class PeerLink extends EventTarget {
  /**
   * @param {object} opts
   * @param {string} opts.peerId
   * @param {boolean} opts.polite   the polite side yields when both send offers at once
   * @param {RTCIceServer[]} opts.iceServers
   * @param {MediaStream} opts.localStream
   * @param {(data: object) => void} opts.sendSignal
   */
  constructor ({ peerId, polite, iceServers, localStream, sendSignal }) {
    super()
    this.peerId = peerId
    this.polite = polite
    this.sendSignal = sendSignal
    this.makingOffer = false
    this.ignoreOffer = false

    const pc = new RTCPeerConnection({ iceServers })
    this.pc = pc
    for (const track of localStream.getTracks()) pc.addTrack(track, localStream)

    pc.ontrack = ({ track, streams }) => {
      const stream = streams[0] || new MediaStream([track])
      this.dispatchEvent(new CustomEvent('stream', { detail: stream }))
    }

    pc.onicecandidate = ({ candidate }) => {
      if (candidate) sendSignal({ candidate })
    }

    pc.onnegotiationneeded = async () => {
      try {
        this.makingOffer = true
        await pc.setLocalDescription()
        sendSignal({ description: pc.localDescription })
      } catch (err) {
        console.error('negotiation failed', err)
      } finally {
        this.makingOffer = false
      }
    }

    pc.onconnectionstatechange = () => {
      this.dispatchEvent(new CustomEvent('state', { detail: pc.connectionState }))
    }

    pc.oniceconnectionstatechange = () => {
      if (pc.iceConnectionState === 'failed') pc.restartIce()
    }
  }

  async handleSignal ({ description, candidate }) {
    const pc = this.pc
    try {
      if (description) {
        const collision = description.type === 'offer' &&
          (this.makingOffer || pc.signalingState !== 'stable')
        this.ignoreOffer = !this.polite && collision
        if (this.ignoreOffer) return

        await pc.setRemoteDescription(description)
        if (description.type === 'offer') {
          await pc.setLocalDescription()
          this.sendSignal({ description: pc.localDescription })
        }
      } else if (candidate) {
        try {
          await pc.addIceCandidate(candidate)
        } catch (err) {
          if (!this.ignoreOffer) throw err
        }
      }
    } catch (err) {
      console.error('signal handling failed', err)
    }
  }

  close () {
    this.pc.ontrack = this.pc.onicecandidate = this.pc.onnegotiationneeded = null
    this.pc.onconnectionstatechange = this.pc.oniceconnectionstatechange = null
    this.pc.close()
  }
}
