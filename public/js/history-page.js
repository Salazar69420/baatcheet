import { api, fmtDate, fmtOffset } from './common.js'
import { renderCallList } from './history.js'
import { TranscriptView } from './transcript.js'

const $ = (id) => document.getElementById(id)
const id = new URLSearchParams(location.search).get('id')

async function showList () {
  $('listView').hidden = false
  const { calls } = await api('/api/calls')
  renderCallList($('calls'), calls)
}

async function showCall () {
  $('callView').hidden = false
  const base = `/api/calls/${encodeURIComponent(id)}`
  $('exportMd').href = `${base}/export.md`
  $('exportTxt').href = `${base}/export.txt`

  const view = new TranscriptView($('transcript'), { chunkAudio: true })
  for (const btn of document.querySelectorAll('.seg-toggle button')) {
    btn.onclick = () => {
      document.querySelectorAll('.seg-toggle button').forEach(b => b.classList.toggle('on', b === btn))
      view.setMode(btn.dataset.mode)
    }
  }

  $('retry').onclick = async () => {
    $('retry').disabled = true
    await api(`${base}/retry`, { method: 'POST' }).catch(err => alert(err.message))
    $('retry').disabled = false
    refresh()
  }

  async function refresh () {
    const data = await api(base)
    const { call, participants, segments, chunks } = data
    $('callTitle').textContent = participants.map(p => p.name).join(' & ') || 'Call'
    const dur = call.ended_at ? ` · ${fmtOffset(call.ended_at - call.created_at)}` : ' · not finished'
    $('callMeta').textContent = `${fmtDate(call.created_at)}${dur} · id ${call.id}`
    view.startTime = segments.length ? Math.min(...segments.map(s => s.started_at)) : null
    view.addAll(segments)

    const pending = chunks.filter(c => c.status === 'pending' || c.status === 'processing').length
    const failed = chunks.filter(c => c.status === 'failed').length

    // One line per speaker, so it's obvious when one person's audio never made it.
    const speakers = new Map(participants.map(p => [p.login, p.name]))
    for (const c of chunks) if (!speakers.has(c.speaker_login)) speakers.set(c.speaker_login, c.speaker_name)
    const lines = [...speakers].map(([login, name]) => {
      const mine = chunks.filter(c => c.speaker_login === login)
      if (!mine.length) return `${name}: no audio received`
      const n = (s) => mine.filter(c => c.status === s).length
      const parts = [`${n('done')} transcribed`, `${n('silent')} silent`]
      const p = n('pending') + n('processing')
      if (p) parts.push(`${p} in progress`)
      if (n('failed')) {
        const lastErr = mine.find(c => c.status === 'failed')?.error
        parts.push(`${n('failed')} failed${lastErr ? ` (${lastErr})` : ''}`)
      }
      return `${name}: ${parts.join(' · ')}`
    })
    $('progress').textContent = chunks.length ? `Audio chunks — ${lines.join('  |  ')}` : 'No audio was recorded for this call.'
    $('retry').hidden = !failed
    return pending
  }

  // keep polling while chunks are still being transcribed
  const loop = async () => {
    const pending = await refresh().catch(() => 0)
    if (pending) setTimeout(loop, 4000)
  }
  loop()
}

;(id ? showCall() : showList()).catch(err => {
  console.error(err)
  document.querySelector('main').textContent = `Error: ${err.message}`
})
