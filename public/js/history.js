import { h, fmtDate, fmtOffset } from './common.js'

export function renderCallList (ul, calls, { empty = 'Nothing recorded yet.' } = {}) {
  if (!calls.length) {
    ul.replaceChildren(h('li', { class: 'muted' }, empty))
    return
  }
  ul.replaceChildren(...calls.map(c => {
    const dur = c.ended_at ? fmtOffset(c.ended_at - c.created_at) : 'live / unfinished'
    const badges = [
      c.pending_count ? h('span', { class: 'badge' }, `${c.pending_count} transcribing`) : null,
      c.failed_count ? h('span', { class: 'badge bad' }, `${c.failed_count} failed`) : null
    ]
    const note = c.kind === 'note'
    return h('li', {},
      h('a', { href: note ? `/note/${encodeURIComponent(c.id)}` : `/history.html?id=${encodeURIComponent(c.id)}` },
        note ? h('span', { class: 'kind' }, '🎙️ Voice note · ') : h('span', { class: 'kind' }, '📞 '),
        h('strong', {}, c.people || (note ? 'Empty note' : 'Nobody joined')),
        h('span', { class: 'muted' }, ` · ${fmtDate(c.created_at)} · ${dur} · ${c.segment_count} lines`),
        ...badges
      )
    )
  }))
}
