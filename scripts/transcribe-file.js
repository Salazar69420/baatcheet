#!/usr/bin/env node
// Test the transcription model on any audio file, without making a call.
//   npm run transcribe -- path/to/voice-note.ogg
import { toMp3, transcribeMp3 } from '../server/transcribe.js'
import { config } from '../server/config.js'

const file = process.argv[2]
if (!file) {
  console.error('usage: npm run transcribe -- <audio file>')
  process.exit(1)
}

const t0 = Date.now()
const { mp3, maxVolumeDb } = await toMp3(file, config.ffmpeg)
console.error(`converted → ${(mp3.length / 1024).toFixed(1)} KB mp3, peak ${maxVolumeDb} dB`)
const result = await transcribeMp3(mp3, { apiKey: config.openrouterKey, model: config.model })
console.error(`model ${config.model} answered in ${((Date.now() - t0) / 1000).toFixed(1)}s`)
console.log(JSON.stringify(result, null, 2))
