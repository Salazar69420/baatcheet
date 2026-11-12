# SETUP.md: install baatcheet on a Linux server

These steps are written so that a person **or an AI agent** can follow them top to bottom on a
fresh Linux machine (Debian, Ubuntu, Fedora or Arch). Every step is idempotent: it is safe to run again.

The result: baatcheet runs in Docker, listening only on `127.0.0.1:3000`, and
**Tailscale** publishes it over HTTPS to the people on your tailnet. Nothing is opened to
the public internet.

> 🤖 **Deploying with an AI agent?** Point it at [AGENT_SETUP.md](AGENT_SETUP.md) instead. It contains
> the same steps written as an agent task, with safety rules, verification checks, backups and a hand-off report.

---

## 0. What you need

- A Linux machine that stays on (a home server, old laptop, Raspberry Pi 4/5, or VPS)
- An OpenRouter API key, from https://openrouter.ai/keys
- A Tailscale account (free) for you, plus the friend you'll call

## 1. Install Docker

```bash
command -v docker || curl -fsSL https://get.docker.com | sudo sh
sudo systemctl enable --now docker
docker compose version   # must print a version (Compose v2)
```

## 2. Install Tailscale and log in

```bash
command -v tailscale || curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up        # opens a login URL; the human must approve it once
tailscale status         # should list this machine
```

> **Agent note:** `tailscale up` prints a URL that a human must open. Show it to the user and wait.

## 3. Get the code

```bash
cd ~
[ -d baatcheet ] || git clone https://github.com/Salazar69420/baatcheet.git
cd baatcheet
git pull
```

## 4. Configure

```bash
[ -f .env ] || cp .env.example .env
chmod 600 .env
```

Edit `.env` and set at least:

```
OPENROUTER_API_KEY=sk-or-...
MODEL=google/gemini-3.1-flash-lite
```

> **Agent note:** ask the user for the API key. Never commit `.env`, and never print the key in logs.
> Check the model id exists: `curl -s https://openrouter.ai/api/v1/models | grep -o '"id":"google/gemini-3[^"]*"'`

## 5. Start it

```bash
docker compose up -d --build
docker compose ps                     # STATUS should become "healthy"
curl -fs http://127.0.0.1:3000/healthz && echo   # prints: ok
```

## 6. Publish it on your tailnet (HTTPS)

```bash
sudo tailscale serve --bg 3000
tailscale serve status        # shows https://<machine>.<tailnet>.ts.net
```

HTTPS matters: browsers only allow microphone access on secure pages. Tailscale also adds
`Tailscale-User-Login` / `Tailscale-User-Name` headers, which baatcheet uses as each caller's
identity, so there is no separate login.

If `tailscale serve` says HTTPS is disabled, enable **MagicDNS** and **HTTPS Certificates** in the
admin console (https://login.tailscale.com/admin/dns), then run the command again.

## 7. Let your friend in

Pick one:

- **Share just this machine (recommended):** in the admin console, open Machines → this machine → ⋯ → *Share…*, and send the invite to your friend. They install Tailscale on their phone or laptop and accept.
- **Or** invite them to your tailnet as a user.

Your friend then opens `https://<machine>.<tailnet>.ts.net` on their device.

## 8. Test a call

1. Open the URL, click **Start a call**, and allow the microphone.
2. Send the call link to your friend. When they open it you are connected, and the **● Recording** badge shows.
3. Talk for 30 seconds. Lines appear under *Live transcript*, about 15–20 seconds behind the speech.
4. Hang up. The **History** page shows the full transcript, with `.md` / `.txt` export.

Test the model without a call:

```bash
docker compose exec baatcheet node scripts/transcribe-file.js /path/inside/container.ogg
```

---

## Updating

```bash
cd ~/baatcheet && git pull && docker compose up -d --build
```

## Logs

```bash
docker compose logs -f --tail=100
```

## Backups

All recordings and the SQLite database live in the Docker volume `baatcheet_data`:

```bash
docker run --rm -v baatcheet_data:/data -v "$PWD":/backup alpine \
  tar czf /backup/baatcheet-backup-$(date +%F).tgz -C /data .
```

## Running without Docker

You need Node.js 22.13 or newer, plus ffmpeg:

```bash
sudo apt-get install -y ffmpeg      # or your distro's equivalent
npm install --omit=dev
npm start                           # reads .env automatically
```

To keep it running, use a systemd unit:

```ini
# /etc/systemd/system/baatcheet.service
[Unit]
Description=baatcheet
After=network-online.target

[Service]
WorkingDirectory=/home/YOUR_USER/baatcheet
ExecStart=/usr/bin/node --env-file=.env server/index.js
Restart=always
User=YOUR_USER

[Install]
WantedBy=multi-user.target
```

## Troubleshooting

| Symptom | Fix |
|---|---|
| "Microphone blocked" | Open the `https://….ts.net` URL, not `http://IP:3000`. The mic needs HTTPS (or localhost). |
| Stuck on "Connecting to …" | Both devices must be on Tailscale. Outside Tailscale, set `TURN_URLS` / `TURN_USERNAME` / `TURN_CREDENTIAL` in `.env`. |
| No transcript lines | Check `docker compose logs`. A missing `OPENROUTER_API_KEY` or a wrong `MODEL` shows as failed chunks on the History page, where a **Retry** button appears. |
| "This call already has two people" | v1 supports 1:1 calls only. Start a new call. |
| Everything is marked "silent" | Lower `SILENCE_THRESHOLD_DB` (e.g. `-55`) in `.env`, then run `docker compose up -d`. |
