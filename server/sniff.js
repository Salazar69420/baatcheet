// Identify an audio container from its first bytes.

/** @param {Buffer} buf @returns {{mime: string, ext: string} | null} */
export function sniffAudio (buf) {
  if (!buf || buf.length < 12) return null
  if (buf.readUInt32BE(0) === 0x1a45dfa3) return { mime: 'audio/webm', ext: 'webm' } // EBML (WebM/Matroska)
  if (buf.toString('latin1', 4, 8) === 'ftyp') return { mime: 'audio/mp4', ext: 'm4a' } // ISO BMFF (MP4/M4A)
  if (buf.toString('latin1', 0, 4) === 'OggS') return { mime: 'audio/ogg', ext: 'ogg' }
  if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WAVE') return { mime: 'audio/wav', ext: 'wav' }
  if (buf.toString('latin1', 0, 3) === 'ID3' || (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0)) return { mime: 'audio/mpeg', ext: 'mp3' }
  // Fragmented MP4 pieces can start with other boxes
  const box = buf.toString('latin1', 4, 8)
  if (['moov', 'moof', 'styp', 'free', 'mdat'].includes(box)) return { mime: 'audio/mp4', ext: 'm4a' }
  return null
}
