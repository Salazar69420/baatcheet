import { DatabaseSync } from 'node:sqlite'

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS calls (
  id          TEXT PRIMARY KEY,
  created_at  INTEGER NOT NULL,
  ended_at    INTEGER,
  title       TEXT
);

CREATE TABLE IF NOT EXISTS participants (
  call_id    TEXT NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
  login      TEXT NOT NULL,
  name       TEXT NOT NULL,
  joined_at  INTEGER NOT NULL,
  PRIMARY KEY (call_id, login)
);

CREATE TABLE IF NOT EXISTS chunks (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  call_id        TEXT NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
  speaker_login  TEXT NOT NULL,
  speaker_name   TEXT NOT NULL,
  track_id       TEXT NOT NULL,
  seq            INTEGER NOT NULL,
  started_at     INTEGER NOT NULL,
  duration_ms    INTEGER NOT NULL,
  path           TEXT NOT NULL,
  mime           TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending','processing','done','silent','failed')),
  attempts       INTEGER NOT NULL DEFAULT 0,
  error          TEXT,
  UNIQUE (call_id, track_id, seq)
);

CREATE TABLE IF NOT EXISTS segments (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  chunk_id       INTEGER NOT NULL UNIQUE REFERENCES chunks(id) ON DELETE CASCADE,
  call_id        TEXT NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
  speaker_login  TEXT NOT NULL,
  speaker_name   TEXT NOT NULL,
  started_at     INTEGER NOT NULL,
  original       TEXT NOT NULL,
  english        TEXT NOT NULL,
  language       TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_segments_call ON segments(call_id, started_at);
CREATE INDEX IF NOT EXISTS idx_chunks_status ON chunks(status);
`

export function openDb (file) {
  const db = new DatabaseSync(file)
  db.exec(SCHEMA)

  const q = {
    ensureCall: db.prepare('INSERT OR IGNORE INTO calls (id, created_at) VALUES (?, ?)'),
    getCall: db.prepare('SELECT * FROM calls WHERE id = ?'),
    endCall: db.prepare('UPDATE calls SET ended_at = ? WHERE id = ?'),
    reopenCall: db.prepare('UPDATE calls SET ended_at = NULL WHERE id = ?'),
    upsertParticipant: db.prepare(`INSERT INTO participants (call_id, login, name, joined_at) VALUES (?, ?, ?, ?)
      ON CONFLICT (call_id, login) DO UPDATE SET name = excluded.name`),
    participants: db.prepare('SELECT login, name, joined_at FROM participants WHERE call_id = ? ORDER BY joined_at'),
    listCalls: db.prepare(`SELECT c.*,
        (SELECT COUNT(*) FROM segments s WHERE s.call_id = c.id) AS segment_count,
        (SELECT COUNT(*) FROM chunks k WHERE k.call_id = c.id AND k.status IN ('pending','processing')) AS pending_count,
        (SELECT COUNT(*) FROM chunks k WHERE k.call_id = c.id AND k.status = 'failed') AS failed_count,
        (SELECT group_concat(name, ', ') FROM participants p WHERE p.call_id = c.id) AS people
      FROM calls c ORDER BY c.created_at DESC LIMIT ?`),
    insertChunk: db.prepare(`INSERT INTO chunks
      (call_id, speaker_login, speaker_name, track_id, seq, started_at, duration_ms, path, mime)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    chunkBySeq: db.prepare('SELECT id FROM chunks WHERE call_id = ? AND track_id = ? AND seq = ?'),
    getChunk: db.prepare('SELECT * FROM chunks WHERE id = ?'),
    chunksForCall: db.prepare(`SELECT id, speaker_login, speaker_name, seq, started_at, duration_ms, status, attempts, error
      FROM chunks WHERE call_id = ? ORDER BY started_at`),
    setStatus: db.prepare('UPDATE chunks SET status = ?, error = ? WHERE id = ?'),
    bumpAttempts: db.prepare('UPDATE chunks SET attempts = attempts + 1 WHERE id = ?'),
    resumable: db.prepare("SELECT id FROM chunks WHERE status IN ('pending','processing') ORDER BY started_at"),
    failedForCall: db.prepare("SELECT id FROM chunks WHERE call_id = ? AND status = 'failed'"),
    resetChunk: db.prepare("UPDATE chunks SET status = 'pending', attempts = 0, error = NULL WHERE id = ?"),
    insertSegment: db.prepare(`INSERT INTO segments
      (chunk_id, call_id, speaker_login, speaker_name, started_at, original, english, language)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (chunk_id) DO UPDATE SET original = excluded.original, english = excluded.english, language = excluded.language
      RETURNING *`),
    segments: db.prepare('SELECT * FROM segments WHERE call_id = ? ORDER BY started_at, id'),
    previousSegment: db.prepare(`SELECT speaker_name, original FROM segments
      WHERE call_id = ? AND started_at < ? ORDER BY started_at DESC LIMIT 1`)
  }

  return {
    raw: db,
    close: () => db.close(),
    ensureCall (id) { q.ensureCall.run(id, Date.now()); q.reopenCall.run(id) },
    getCall: (id) => q.getCall.get(id),
    endCall: (id) => q.endCall.run(Date.now(), id),
    addParticipant: (callId, who) => q.upsertParticipant.run(callId, who.login, who.name, Date.now()),
    participants: (callId) => q.participants.all(callId),
    listCalls: (limit = 100) => q.listCalls.all(limit),

    /** @returns {number|null} new chunk id, or null when this seq was already uploaded */
    insertChunk (c) {
      if (q.chunkBySeq.get(c.callId, c.trackId, c.seq)) return null
      const r = q.insertChunk.run(c.callId, c.speakerLogin, c.speakerName, c.trackId, c.seq, c.startedAt, c.durationMs, c.path, c.mime)
      return Number(r.lastInsertRowid)
    },
    getChunk: (id) => q.getChunk.get(id),
    chunksForCall: (callId) => q.chunksForCall.all(callId),
    setChunkStatus: (id, status, error = null) => q.setStatus.run(status, error, id),
    bumpAttempts: (id) => q.bumpAttempts.run(id),
    resumableChunkIds: () => q.resumable.all().map(r => r.id),
    resetFailed (callId) {
      const ids = q.failedForCall.all(callId).map(r => r.id)
      for (const id of ids) q.resetChunk.run(id)
      return ids
    },

    saveSegment (chunk, result) {
      return q.insertSegment.get(chunk.id, chunk.call_id, chunk.speaker_login, chunk.speaker_name,
        chunk.started_at, result.original, result.english, result.language)
    },
    segments: (callId) => q.segments.all(callId),
    previousSegment: (callId, before) => q.previousSegment.get(callId, before) || null
  }
}
