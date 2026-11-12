const pad = (n) => String(n).padStart(2, '0')

/** "MM:SS" (or "H:MM:SS") offset of a segment from the start of the call. */
export function offset (ms) {
  const s = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${pad(m)}:${pad(s % 60)}`
}

/** Order segments from both speakers on one timeline. */
export function mergeSegments (segments) {
  return [...segments].sort((a, b) => a.started_at - b.started_at || a.id - b.id)
}

function header (call, participants) {
  const when = new Date(call.created_at).toISOString().replace('T', ' ').slice(0, 16) + ' UTC'
  const people = participants.map(p => p.name).join(', ') || 'unknown'
  return { when, people }
}

export function toMarkdown (call, participants, segments) {
  const { when, people } = header(call, participants)
  const start = segments.length ? Math.min(call.created_at, ...segments.map(s => s.started_at)) : call.created_at
  const out = [`# ${call.kind === 'note' ? 'Voice note' : 'Call'} ${call.id}`, '', `- **When:** ${when}`, `- **Who:** ${people}`, '']
  for (const s of mergeSegments(segments)) {
    if (!s.original && !s.english) continue
    out.push(`**[${offset(s.started_at - start)}] ${s.speaker_name}**`, '')
    out.push(`> ${s.english || '—'}`, '')
    if (s.language !== 'en' && s.original) out.push(`<sub>${s.original}</sub>`, '')
  }
  return out.join('\n')
}

export function toText (call, participants, segments) {
  const { when, people } = header(call, participants)
  const start = segments.length ? Math.min(call.created_at, ...segments.map(s => s.started_at)) : call.created_at
  const out = [`${call.kind === 'note' ? 'Voice note' : 'Call'} ${call.id}`, `When: ${when}`, `Who: ${people}`, '']
  for (const s of mergeSegments(segments)) {
    if (!s.original && !s.english) continue
    out.push(`[${offset(s.started_at - start)}] ${s.speaker_name}: ${s.english}`)
    if (s.language !== 'en' && s.original) out.push(`    (original) ${s.original}`)
  }
  return out.join('\n') + '\n'
}

/** A voice note as one block of text, ready to paste somewhere. mode: 'english' | 'original' */
export function noteText (segments, mode = 'english') {
  return mergeSegments(segments)
    .map(s => (mode === 'original' ? (s.original || s.english) : (s.english || s.original)).trim())
    .filter(Boolean)
    .join(' ')
}
