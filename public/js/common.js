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
  const info = await res.json()
  if (!info.me && ask) {
    let name = storedName()
    while (!name) {
      name = (prompt('Your name (shown to the other person and in transcripts):') || '').trim().slice(0, 40)
    }
    setStoredName(name)
    info.me = { login: `local:${name}`, name, source: 'local' }
  }
  meCache = info
  return info
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
