import { spawn } from 'node:child_process'

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions'

export function buildPrompt (context) {
  const lines = [
    'You are a precise transcription and translation engine for a phone call.',
    'The audio contains one speaker talking in Hindi, English, or a mix of both (Hinglish).',
    'Return ONLY a JSON object with exactly these keys:',
    '  "original": a verbatim, word-for-word transcript in the language actually spoken.',
    '              Write Hindi words in Devanagari and English words in Latin script, exactly as said.',
    '              Keep filler words, repetitions and false starts. Do not correct grammar.',
    '  "english":  a faithful, literal, word-for-word English translation of "original".',
    '              Do not summarize, shorten, explain, or add anything.',
    '  "language": one of "hi", "en", "mixed", or "none".',
    'If there is no intelligible speech, return {"original":"","english":"","language":"none"}.',
    'Never invent words that are not in the audio.'
  ]
  if (context) {
    lines.push('', `For context only (do NOT transcribe this), the previous line in the call was: «${context}»`)
  }
  return lines.join('\n')
}

/** Extract {original, english, language} from whatever the model returned. */
export function parseModelJson (content) {
  if (Array.isArray(content)) content = content.map(p => (typeof p === 'string' ? p : p?.text || '')).join('')
  const text = String(content ?? '').trim()
  if (!text) throw new Error('Empty model response')

  const unfenced = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  let obj
  try {
    obj = JSON.parse(unfenced)
  } catch {
    const start = unfenced.indexOf('{')
    const end = unfenced.lastIndexOf('}')
    if (start === -1 || end <= start) throw new Error(`Model did not return JSON: ${text.slice(0, 200)}`)
    obj = JSON.parse(unfenced.slice(start, end + 1))
  }
  if (Array.isArray(obj)) obj = obj[0]
  if (!obj || typeof obj !== 'object') throw new Error('Model JSON is not an object')

  const original = String(obj.original ?? obj.transcript ?? '').trim()
  const english = String(obj.english ?? obj.translation ?? '').trim()
  let language = String(obj.language ?? '').trim().toLowerCase()
  if (!['hi', 'en', 'mixed', 'none'].includes(language)) language = original ? 'mixed' : 'none'
  return { original, english: english || (language === 'en' ? original : ''), language }
}

/**
 * Convert any browser recording (webm/ogg/mp4) to small mono mp3 and measure loudness in one pass.
 * @returns {Promise<{mp3: Buffer, maxVolumeDb: number|null}>}
 */
export function toMp3 (inputPath, ffmpeg = 'ffmpeg') {
  return new Promise((resolve, reject) => {
    const args = ['-hide_banner', '-nostats', '-i', inputPath,
      '-af', 'volumedetect', '-ac', '1', '-ar', '16000', '-b:a', '32k', '-f', 'mp3', 'pipe:1']
    const proc = spawn(ffmpeg, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    const out = []
    let err = ''
    proc.stdout.on('data', d => out.push(d))
    proc.stderr.on('data', d => { err += d; if (err.length > 64_000) err = err.slice(-32_000) })
    proc.on('error', (e) => reject(e.code === 'ENOENT' ? new Error(`ffmpeg not found (${ffmpeg}). Install ffmpeg or set FFMPEG_PATH.`) : e))
    proc.on('close', (code) => {
      if (code !== 0) return reject(new Error(`ffmpeg exited ${code}: ${err.trim().split('\n').slice(-3).join(' | ')}`))
      const m = /max_volume:\s*(-?[\d.]+|-inf) dB/.exec(err)
      const maxVolumeDb = m ? (m[1] === '-inf' ? -Infinity : Number(m[1])) : null
      resolve({ mp3: Buffer.concat(out), maxVolumeDb })
    })
  })
}

/**
 * Send one mp3 chunk to OpenRouter and get the transcript back.
 */
export async function transcribeMp3 (mp3, { apiKey, model, context, timeoutMs = 90_000 }) {
  if (!apiKey) throw new Error('OPENROUTER_API_KEY is not set')
  const body = {
    model,
    temperature: 0,
    response_format: { type: 'json_object' },
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: buildPrompt(context) },
        { type: 'input_audio', input_audio: { data: mp3.toString('base64'), format: 'mp3' } }
      ]
    }]
  }

  const res = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://github.com/Salazar69420/baatcheet',
      'X-Title': 'baatcheet'
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs)
  })

  const text = await res.text()
  let data
  try { data = JSON.parse(text) } catch { data = null }
  if (!res.ok || data?.error) {
    const msg = data?.error?.message || text.slice(0, 300)
    const err = new Error(`OpenRouter ${res.status}: ${msg}`)
    // 4xx other than rate limits won't get better by retrying
    err.retryable = res.status === 429 || res.status >= 500 || res.status === 0
    throw err
  }
  const content = data?.choices?.[0]?.message?.content
  return { ...parseModelJson(content), usage: data?.usage || null }
}
