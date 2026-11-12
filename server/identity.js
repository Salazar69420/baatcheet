// Who is calling? With `tailscale serve` in front of the app, every request from
// a tailnet user carries Tailscale-User-Login / Tailscale-User-Name headers.
// Without Tailscale (local dev), the browser supplies a display name instead.

const MAX_NAME = 40

// Tailscale sends non-ASCII names RFC 2047 encoded, e.g. =?utf-8?q?Kart=C4=B1k?=
export function decodeHeaderWord (value) {
  if (!value) return ''
  const m = /^=\?utf-8\?([qb])\?(.*)\?=$/i.exec(String(value).trim())
  if (!m) return String(value)
  const [, enc, text] = m
  if (enc.toLowerCase() === 'b') return Buffer.from(text, 'base64').toString('utf8')
  const bytes = text.replace(/_/g, ' ').replace(/=([0-9a-f]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
  return Buffer.from(bytes, 'latin1').toString('utf8')
}

export function cleanName (name) {
  return String(name || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, MAX_NAME)
}

export function slug (s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'user'
}

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {string} [fallbackName] name sent by the browser when not on Tailscale
 * @returns {{login: string, name: string, source: 'tailscale'|'local'} | null}
 */
export function identify (req, fallbackName) {
  const login = req.headers['tailscale-user-login']
  if (login) {
    const name = cleanName(decodeHeaderWord(req.headers['tailscale-user-name'])) || String(login)
    return { login: String(login), name, source: 'tailscale' }
  }
  let raw = fallbackName
  if (!raw && req.headers['x-baatcheet-name']) {
    try { raw = decodeURIComponent(String(req.headers['x-baatcheet-name'])) } catch { raw = '' }
  }
  const name = cleanName(raw)
  if (!name) return null
  return { login: `local:${slug(name)}`, name, source: 'local' }
}
