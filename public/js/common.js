// Shared helpers for every page.

const NAME_KEY = 'baatcheet:name'

function storedName () {
  try { return localStorage.getItem(NAME_KEY) || '' } catch { return '' }
}

export function setStoredName (name) {
  try { localStorage.setItem(NAME_KEY, name) } catch {}
}

let meCache = null

/** Who am I? Tailscale identity if available, otherwise a remembered display name. */
export async function getMe ({ ask = true } = {}) {
  if (meCache) return meCache
  const res = await fetch('/api/me', { headers: nameHeader() })
  if (!res.ok) throw new Error(`Server answered HTTP ${res.status}`)
  const info = await res.json()
  if (!info.me && ask) {
    // In-page form, not window.prompt(): some in-app browsers make prompt() return
    // null instantly, which used to spin forever and freeze the page.
    const name = storedName() || await askName()
    setStoredName(name)
    // ask again with the name header so we get the exact login the server uses
    const again = await fetch('/api/me', { headers: nameHeader() }).then(r => r.json()).catch(() => null)
    info.me = again?.me || { login: `local:${name}`, name, source: 'local' }
  }
  meCache = info
  return info
}

/** Ask for a display name with an in-page dialog. Resolves with the trimmed name. */
export function askName ({ initial = '' } = {}) {
  return new Promise(resolve => {
    const input = h('input', {
      name: 'name', required: true, maxlength: 40, autocomplete: 'nickname',
      placeholder: 'e.g. Kartik', 'aria-label': 'Your name'
    })
    input.value = initial
    const form = h('form', { class: 'name-form' },
      h('h2', {}, 'What should we call you?'),
      h('p', { class: 'muted' }, 'Shown to the other person and in transcripts.'),
      input,
      h('button', { class: 'btn primary' }, 'Continue')
    )
    const overlay = h('div', { class: 'overlay', role: 'dialog', 'aria-modal': 'true' }, form)
    form.onsubmit = (e) => {
      e.preventDefault()
      const v = input.value.trim().slice(0, 40)
      if (!v) return
      overlay.remove()
      resolve(v)
    }
    document.body.append(overlay)
    input.focus()
  })
}

/** Banner for in-app browsers (WhatsApp, Instagram, …) where calls often can't use the mic. */
export function warnIfInAppBrowser () {
  const ua = navigator.userAgent || ''
  const inApp = /FBAN|FBAV|Instagram|WhatsApp|Line\/|MicroMessenger|Snapchat|; wv\)/i.test(ua)
  const noMic = !window.isSecureContext || !navigator.mediaDevices?.getUserMedia
  if (!inApp && !noMic) return false
  const copy = h('button', {
    class: 'btn',
    onclick: async () => {
      try { await navigator.clipboard.writeText(location.href); copy.textContent = 'Copied!' } catch { prompt('Copy this link:', location.href) }
    }
  }, 'Copy link')
  const msg = noMic
    ? 'This browser can’t use the microphone here. Open this link in Chrome or Safari (make sure Tailscale is on).'
    : 'You’re inside an app’s built-in browser. Calls may not work here: tap ⋯ and choose “Open in browser”, or copy the link into Chrome or Safari.'
  document.body.prepend(h('div', { class: 'banner' }, h('span', {}, msg), copy))
  return true
}

export function displayName () {
  return meCache?.me?.name || storedName()
}

function nameHeader () {
  const name = storedName()
  return name ? { 'X-Baatcheet-Name': encodeURIComponent(name) } : {}
}

export async function api (path, opts = {}) {
  const res = await fetch(path, { ...opts, headers: { ...nameHeader(), ...(opts.headers || {}) } })
  const data = res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text()
  if (!res.ok) throw Object.assign(new Error(data?.error || `HTTP ${res.status}`), { status: res.status })
  return data
}

export function h (tag, attrs = {}, ...children) {
  const el = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue
    if (k === 'class') el.className = v
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v)
    else el.setAttribute(k, v === true ? '' : v)
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue
    el.append(c instanceof Node ? c : document.createTextNode(String(c)))
  }
  return el
}

export function fmtDate (ms) {
  return new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

export function fmtOffset (ms) {
  const s = Math.max(0, Math.floor(ms / 1000))
  const m = Math.floor(s / 60)
  return `${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}
