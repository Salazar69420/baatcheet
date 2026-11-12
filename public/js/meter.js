// Small audio level meter (replaces roll-call's waudio/visuals components).

export function attachMeter (stream, el) {
  const Ctx = window.AudioContext || window.webkitAudioContext
  if (!Ctx || !stream.getAudioTracks().length) return () => {}
  const ctx = new Ctx()
  const src = ctx.createMediaStreamSource(stream)
  const analyser = ctx.createAnalyser()
  analyser.fftSize = 512
  src.connect(analyser)
  const buf = new Uint8Array(analyser.fftSize)
  let raf

  const tick = () => {
    analyser.getByteTimeDomainData(buf)
    let sum = 0
    for (const v of buf) { const x = (v - 128) / 128; sum += x * x }
    const rms = Math.sqrt(sum / buf.length)
    const level = Math.min(1, rms * 4)
    el.style.setProperty('--level', level.toFixed(3))
    raf = requestAnimationFrame(tick)
  }
  const resume = () => ctx.resume().catch(() => {})
  document.addEventListener('click', resume, { once: true })
  resume()
  tick()

  return () => { cancelAnimationFrame(raf); src.disconnect(); ctx.close().catch(() => {}) }
}
