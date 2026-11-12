import { h, fmtOffset } from './common.js'

// Renders segments from both speakers on one timeline, ordered by start time.
// mode: 'both' | 'english' | 'original'

export class TranscriptView {
  constructor (container, { myLogin = null, startTime = null, chunkAudio = false } = {}) {
    this.el = container
    this.myLogin = myLogin
    this.startTime = startTime
    this.chunkAudio = chunkAudio
    this.mode = 'both'
    this.segments = new Map()
  }

  setMode (mode) {
    this.mode = mode
    this.el.dataset.mode = mode
  }

  add (seg) {
    if (!seg || (!seg.original && !seg.english)) return
    if (this.startTime === null || seg.started_at < this.startTime) this.startTime = seg.started_at
    this.segments.set(seg.chunk_id, seg)
    const existing = this.el.querySelector(`[data-chunk="${seg.chunk_id}"]`)
    const node = this._render(seg)
    if (existing) { existing.replaceWith(node); return }

    // insert in time order (segments can arrive out of order)
    const after = [...this.el.children].find(c => Number(c.dataset.t) > seg.started_at)
    this.el.insertBefore(node, after || null)
    this.el.querySelector('.empty')?.remove()
  }

  addAll (segments) { segments.forEach(s => this.add(s)) }

  _render (seg) {
    const mine = this.myLogin && seg.speaker_login === this.myLogin
    const showOriginal = seg.language !== 'en' && seg.original && seg.original !== seg.english
    return h('article', { class: `seg ${mine ? 'mine' : 'theirs'}`, 'data-chunk': seg.chunk_id, 'data-t': seg.started_at },
      h('header', {},
        h('span', { class: 'who' }, seg.speaker_name),
        h('time', {}, fmtOffset(seg.started_at - (this.startTime ?? seg.started_at))),
        h('span', { class: `lang lang-${seg.language}` }, seg.language),
        this.chunkAudio ? h('button', { class: 'play', title: 'Play this audio', onclick: () => playChunk(seg.chunk_id) }, '▶') : null
      ),
      h('p', { class: 'english' }, seg.english || seg.original),
      showOriginal ? h('p', { class: 'original', lang: seg.language === 'hi' ? 'hi' : undefined }, seg.original) : null
    )
  }
}

let player
function playChunk (chunkId) {
  player ??= new Audio()
  player.src = `/api/chunks/${chunkId}/audio`
  player.play().catch(() => {})
}
