import fs from 'node:fs'
import { JobQueue } from './queue.js'
import { toMp3, transcribeMp3 } from './transcribe.js'

/**
 * Wires chunks → ffmpeg → OpenRouter → segments, and tells the people on the call.
 */
export function createPipeline ({ db, config, notify, log = console }) {
  async function processChunk (chunkId) {
    const chunk = db.getChunk(chunkId)
    if (!chunk || chunk.status === 'done' || chunk.status === 'silent') return

    db.setChunkStatus(chunk.id, 'processing')
    db.bumpAttempts(chunk.id)
    notify(chunk.call_id, { type: 'chunk', id: chunk.id, status: 'processing', speaker: chunk.speaker_login })

    let converted
    try {
      converted = await toMp3(chunk.path, config.ffmpeg)
    } catch (err) {
      // A file ffmpeg can't read won't get better on retry; record what it starts with.
      if (/Invalid data|EBML|moov atom not found|could not find codec/i.test(err.message)) {
        let head = ''
        try { head = fs.readFileSync(chunk.path).subarray(0, 16).toString('hex') } catch {}
        throw Object.assign(new Error(`unreadable audio (${chunk.mime}, ${fileSize(chunk.path)} bytes, starts ${head}): ${err.message.slice(-200)}`), { retryable: false })
      }
      throw err
    }
    const { mp3, maxVolumeDb } = converted
    if (maxVolumeDb !== null && maxVolumeDb < config.silenceDb) {
      db.setChunkStatus(chunk.id, 'silent')
      notify(chunk.call_id, { type: 'chunk', id: chunk.id, status: 'silent', speaker: chunk.speaker_login })
      return
    }

    const kind = db.getCall(chunk.call_id)?.kind || 'call'
    const prev = db.previousSegment(chunk.call_id, chunk.started_at)
    const context = prev?.original ? (kind === 'note' ? prev.original : `${prev.speaker_name}: ${prev.original}`).slice(-500) : ''
    const result = await transcribeMp3(mp3, { apiKey: config.openrouterKey, model: config.model, context, kind })

    if (!result.original && !result.english) {
      db.setChunkStatus(chunk.id, 'silent')
      notify(chunk.call_id, { type: 'chunk', id: chunk.id, status: 'silent', speaker: chunk.speaker_login })
      return
    }

    const segment = db.saveSegment(chunk, result)
    db.setChunkStatus(chunk.id, 'done')
    notify(chunk.call_id, { type: 'segment', segment })
    notify(chunk.call_id, { type: 'chunk', id: chunk.id, status: 'done', speaker: chunk.speaker_login })
  }

  const queue = new JobQueue({
    worker: processChunk,
    concurrency: config.concurrency,
    maxAttempts: 3,
    onRetry (id, err, attempt) {
      log.warn(`[transcribe] chunk ${id} attempt ${attempt} failed: ${err.message} — retrying`)
      db.setChunkStatus(id, 'pending', err.message)
    },
    onFailed (id, err) {
      log.error(`[transcribe] chunk ${id} failed: ${err.message}`)
      db.setChunkStatus(id, 'failed', err.message)
      const chunk = db.getChunk(id)
      if (chunk) notify(chunk.call_id, { type: 'chunk', id, status: 'failed', error: err.message, speaker: chunk.speaker_login })
    }
  })

  return {
    queue,
    enqueue: (id) => queue.push(id),
    resume () {
      const ids = db.resumableChunkIds()
      for (const id of ids) queue.push(id)
      return ids.length
    }
  }
}

function fileSize (p) {
  try { return fs.statSync(p).size } catch { return 0 }
}
