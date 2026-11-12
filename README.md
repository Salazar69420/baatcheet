# baatcheet

**Self-hosted 1:1 voice calls that turn Hindi, English or Hinglish conversations into word-for-word English transcripts.**

Open the app, start a call, and send the link to a friend. You talk in the browser over WebRTC.
Each side records **only its own microphone**, so every line knows who said it. The audio is
uploaded in short chunks, transcribed and translated by an audio-capable model through
[OpenRouter](https://openrouter.ai) (default: `google/gemini-3.1-flash-lite`), and appears as a
live transcript while you talk. After the call you can read, play back and export the whole
conversation.

It runs on your own Linux box behind [Tailscale](https://tailscale.com), so only people you
invite can reach it.

> 🔴 **Consent.** baatcheet records every call. Recording a conversation without everyone's
> consent is illegal in many places. The app shows a *Recording* badge throughout the call;
> make sure the people you call know and agree.

## Features

- 📞 1:1 browser audio calls with no app to install (WebRTC, peer to peer)
- 🎙️ Each speaker is recorded locally, which gives clean per-speaker tracks and accurate speaker labels
- 🇮🇳 Hindi, English and code-switched Hinglish, with the **original** text (Devanagari and Latin) plus a **literal English** translation
- ⚡ Live transcript during the call, about one chunk (15 s) behind
- 🗂️ History with per-line audio playback, failed-chunk retry, and `.md` / `.txt` export
- 🔒 No accounts: identity comes from Tailscale, and the server binds to localhost
- 💾 Durable: chunks are written to disk first and transcribed from a queue that resumes after a restart
- 🪶 Tiny stack: Node.js, Express, `ws`, the built-in `node:sqlite`, ffmpeg and vanilla JS. No build step.

## How it works

```
 Browser A ◄──────── WebRTC audio (direct over Tailscale) ────────► Browser B
   │ records own mic in standalone 15 s chunks       records own mic │
   └── POST /api/calls/:id/chunks ──►  Node server  ◄── chunks ──────┘
                                         │  ffmpeg → 16 kHz mono mp3 (+ silence check)
                                         │  OpenRouter chat/completions with input_audio
                                         ▼
                              SQLite: calls · chunks · segments
                                         │
             live transcript ◄── WebSocket ──► both browsers
```

- **Signaling:** a small WebSocket room server (`server/signaling.js`), with up to 2 people per call.
- **Connection:** the "perfect negotiation" pattern (`public/js/rtc.js`), so it doesn't matter who calls first.
- **Recording:** `public/js/recorder.js` restarts `MediaRecorder` for every chunk, so each file has its own header and can be decoded on its own. Chunks are stamped with a server-synced clock, so both speakers merge into one timeline.
- **Transcription:** `server/transcribe.js` asks the model for `{original, english, language}` JSON and passes the previous line as context.

## Quick start (local development)

You need Node.js 22.13 or newer and `ffmpeg` on your PATH.

```bash
git clone https://github.com/Salazar69420/baatcheet.git
cd baatcheet
cp .env.example .env        # add OPENROUTER_API_KEY
npm install
npm start                   # http://127.0.0.1:3000
```

Open `http://localhost:3000` in two browser tabs (localhost is allowed to use the mic), start a
call in one tab and paste the link into the other. Use a different name in each tab.

To test the model on a voice note without making a call:

```bash
npm run transcribe -- ~/Downloads/voice-note.ogg
```

## Deploy on a Linux server

See **[SETUP.md](SETUP.md)**. In short: Docker, then `docker compose up -d --build`, then
`sudo tailscale serve --bg 3000`, then share the machine with your friend.

## Configuration (`.env`)

| Variable | Default | Meaning |
|---|---|---|
| `OPENROUTER_API_KEY` | – | **Required** for transcription |
| `MODEL` | `google/gemini-3.1-flash-lite` | Any OpenRouter model that accepts `input_audio` |
| `CHUNK_SECONDS` | `15` | Length of each recorded chunk (3–120) |
| `TRANSCRIBE_CONCURRENCY` | `2` | Parallel model requests |
| `SILENCE_THRESHOLD_DB` | `-45` | Chunks quieter than this are skipped (saves money) |
| `PORT` / `HOST` | `3000` / `127.0.0.1` | Where the server listens |
| `DATA_DIR` | `./data` | Recordings and the SQLite database |
| `STUN_URLS` | Google STUN | Comma-separated STUN servers |
| `TURN_URLS`, `TURN_USERNAME`, `TURN_CREDENTIAL` | – | Optional TURN relay, for use without Tailscale |

## API

| Method | Path | |
|---|---|---|
| `GET` | `/healthz` | `ok` |
| `GET` | `/api/me` | Current identity and server settings |
| `POST` | `/api/calls` | Create a call and return `{id}` |
| `GET` | `/api/calls` | List calls |
| `GET` | `/api/calls/:id` | Call, participants, segments and chunk status |
| `POST` | `/api/calls/:id/chunks?seq&startedAt&durationMs&track` | Upload an audio chunk (raw body) |
| `POST` | `/api/calls/:id/retry` | Re-queue failed chunks |
| `GET` | `/api/calls/:id/export.md` / `.txt` | Download the transcript |
| `GET` | `/api/chunks/:id/audio` | Play one chunk |
| `WS` | `/ws` | Signaling and live transcript |

## Development

```bash
npm run dev     # restarts on file changes
npm test        # node:test, no extra dependencies
```

## Roadmap

- Group calls (mesh, up to 4 people)
- Drag-and-drop file sharing during a call
- AI summary and action items after each call
- Full-text search across transcripts
- Installable PWA
- Optional public-domain mode (Caddy + login) for people without Tailscale

## Credits

Inspired by [mikeal/roll-call](https://github.com/mikeal/roll-call) (Apache-2.0), which pioneered
"record every participant locally for podcast-quality audio" in the browser. baatcheet is a
from-scratch rewrite. Its signaling and TURN services no longer exist, so baatcheet ships its
own, and it adds transcription and translation on top.

## License

[MIT](LICENSE)
