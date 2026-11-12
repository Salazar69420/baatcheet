import { api, getMe, h, setStoredName } from './common.js'
import { renderCallList } from './history.js'

const $ = (id) => document.getElementById(id)

async function main () {
  const info = await getMe()
  $('who').replaceChildren(
    `Signed in as ${info.me.name}`,
    info.tailscale ? ' (via Tailscale)' : ' ',
    info.tailscale ? '' : h('a', { href: '#', onclick: (e) => { e.preventDefault(); rename() } }, '(change)')
  )
  if (!info.transcription) {
    $('who').append(h('br'), h('span', { class: 'warn' }, '⚠ Transcription is off: the server has no OPENROUTER_API_KEY.'))
  }

  $('start').onclick = async () => {
    $('start').disabled = true
    try {
      const { id } = await api('/api/calls', { method: 'POST' })
      location.href = `/call/${id}`
    } catch (err) {
      alert(`Could not start a call: ${err.message}`)
      $('start').disabled = false
    }
  }

  $('join').onsubmit = (e) => {
    e.preventDefault()
    const v = $('joinInput').value.trim()
    const id = (v.match(/\/call\/([A-Za-z0-9_-]{4,64})/) || v.match(/^([A-Za-z0-9_-]{4,64})$/) || [])[1]
    if (id) {
      location.href = `/call/${id}`
    } else {
      $('joinInput').setCustomValidity('That does not look like a call link')
      $('joinInput').reportValidity()
    }
  }
  $('joinInput').oninput = () => $('joinInput').setCustomValidity('')

  const { calls } = await api('/api/calls')
  renderCallList($('recent'), calls.slice(0, 10))
}

function rename () {
  const name = (prompt('Your name:') || '').trim().slice(0, 40)
  if (name) { setStoredName(name); location.reload() }
}

main().catch(err => { console.error(err); $('who').textContent = `Error: ${err.message}` })
