import { h, fmtDate, fmtOffset } from './common.js'

export function renderCallList (ul, calls) {
  if (!calls.length) {
    ul.replaceChildren(h('li', { class: 'muted' }, 'No calls yet.'))
    return
  }
  ul.replaceChildren(...calls.map(c => {
    const dur = c.ended_at ? fmtOffset(c.ended_at - c.created_at) : 'live / unfinished'
    const badges = [
      c.pending_count ? h('span', { class: 'badge' }, `${c.pending_count} transcribing`) : null,
      c.failed_count ? h('span', { class: 'badge bad' }, `${c.failed_count} failed`) : null
    ]
    return h('li', {},
      h('a', { href: `/history.html?id=${encodeURIComponent(c.id)}` },
        h('strong', {}, c.people || 'Nobody joined'),
        h('span', { class: 'muted' }, ` · ${fmtDate(c.created_at)} · ${dur} · ${c.segment_count} lines`),
        ...badges
      )
    )
  }))
}
