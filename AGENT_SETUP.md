# AGENT_SETUP.md: deployment instructions for an AI agent

> **For humans:** give your server's AI agent one line:
> *"Scan https://github.com/Salazar69420/baatcheet, read AGENT_SETUP.md, then plan and implement it
> with what we have."*
>
> **For the agent:** this whole file is your task. Read it fully, then write a short plan (which steps
> apply, what's already installed, what you'll skip), and execute it step by step.

---

## Goal

Deploy **baatcheet** on this Linux server so the owner and one friend can make private 1:1 voice
calls over Tailscale, with every call recorded per speaker and transcribed into word-for-word English
(Hindi, English and Hinglish supported) through OpenRouter.

You are expected to have **root access, GitHub access and Tailscale access** on this machine.
If any of these is missing, say so in your plan and work around it, or ask.

Read these files from the repo before acting: `SETUP.md` (human version of this guide), `README.md`,
`.env.example`, `docker-compose.yml`, `Dockerfile`.

## Rules (follow strictly)

1. **Never expose the app to the public internet.** It must listen on `127.0.0.1` only and be
   reachable solely through `tailscale serve` (HTTPS, tailnet-only). Do NOT use `tailscale funnel`.
   Do NOT open firewall ports. Do NOT bind the app to 0.0.0.0 on the host.
2. **Secrets.** Ask the owner for the OpenRouter API key. Put it only in `/opt/baatcheet/.env` with
   `chmod 600`. Never print it, echo it into logs, commit it, or pass it on a command line that ends up
   in `ps` or shell history (write the file with a heredoc or an editor).
3. **Don't delete or overwrite anything you didn't create.** If `/opt/baatcheet` already exists,
   `git pull` instead of re-cloning. Keep the existing `.env` and the Docker volume `baatcheet_data`,
   which holds all recordings and transcripts.
4. **Idempotent and verified.** Every step must be safe to re-run. Verify each step before moving on.
   If a step fails, show the exact error and your proposed fix before doing anything destructive.
5. **Human-only steps.** The Tailscale login URL, enabling HTTPS in the Tailscale admin console and
   sharing the machine with the friend all need a person. When you reach one, stop, say exactly what
   to click, and wait.

---

## Steps

### 1. Inspect the machine
- Report the distro and version, CPU architecture, free RAM and disk, and whether Docker, Docker
  Compose v2, git and Tailscale are installed. Also report what is listening on port 3000
  (`ss -ltnp | grep :3000`).
- If port 3000 is taken, pick a free port (e.g. 3010). Use it as `PORT` in `.env` and in the
  `tailscale serve` command below. Inside the container the app always uses 3000; `PORT` only
  changes the host side.

### 2. Install prerequisites (skip what's already present)
- **Docker Engine and Compose v2:** `curl -fsSL https://get.docker.com | sh`, then
  `systemctl enable --now docker`. Check with `docker compose version`.
- **Tailscale:** `curl -fsSL https://tailscale.com/install.sh | sh`. Check with `tailscale status`.
  If it isn't logged in, run `tailscale up` and give the owner the login URL.

### 3. Get the code
```bash
mkdir -p /opt && cd /opt
[ -d baatcheet/.git ] || git clone https://github.com/Salazar69420/baatcheet.git
cd /opt/baatcheet && git pull --ff-only && git log --oneline -3
```

### 4. Configure
- `cp -n .env.example .env && chmod 600 .env`
- Ask the owner for the OpenRouter key and set `OPENROUTER_API_KEY=` in `.env`.
- Check the key and model id without printing the key:
  ```bash
  curl -s -H "Authorization: Bearer $(grep ^OPENROUTER_API_KEY= .env | cut -d= -f2-)" \
    https://openrouter.ai/api/v1/models | grep -o '"id":"google/gemini-3[^"]*"' | sort -u
  ```
  - If `google/gemini-3.1-flash-lite` is listed, keep `MODEL=google/gemini-3.1-flash-lite`.
  - If it isn't, show the owner the closest `google/gemini-*flash-lite*` ids that accept audio
    input, ask which to use, and set `MODEL=` to that.
- Leave the other settings at their defaults, except `PORT` if 3000 was taken.

### 5. Build and start
```bash
cd /opt/baatcheet
docker compose up -d --build
docker compose ps            # wait until STATUS shows (healthy), up to ~60 s
curl -fs http://127.0.0.1:${PORT:-3000}/healthz   # must print: ok
docker compose logs --tail=30
```
- Make sure the logs do **not** show `OPENROUTER_API_KEY is not set`.
- Make sure the port is bound only to loopback: `ss -ltnp | grep ${PORT:-3000}` should show `127.0.0.1`.

### 6. Prove transcription works end to end
Make a short spoken test clip and run it through the real pipeline (ffmpeg, then OpenRouter):
```bash
apt-get install -y espeak-ng 2>/dev/null || dnf install -y espeak-ng 2>/dev/null || true
espeak-ng -w /tmp/bc-test.wav "Hello, this is a test of the baatcheet transcription system."
docker cp /tmp/bc-test.wav baatcheet:/tmp/bc-test.wav
docker compose exec baatcheet node scripts/transcribe-file.js /tmp/bc-test.wav
```
**Expected:** JSON whose `original` and `english` are close to the spoken sentence, with
`"language": "en"`.

**If it fails:** show the full error (it contains no key) and diagnose it. Likely causes are a wrong
model id, a model that doesn't accept audio, or no credits on the account.

### 7. Publish on the tailnet over HTTPS
```bash
tailscale serve --bg ${PORT:-3000}
tailscale serve status
```
- If it says HTTPS or certificates are disabled, ask the owner to enable **MagicDNS** and
  **HTTPS Certificates** at https://login.tailscale.com/admin/dns. Wait, then retry.
- Check from the server:
  ```bash
  TS_HOST=$(tailscale status --json | grep -o '"DNSName":"[^"]*' | head -1 | cut -d'"' -f4 | sed 's/\.$//')
  curl -fs "https://$TS_HOST/healthz"
  ```
- Do **not** run `tailscale funnel`.

### 8. Make it survive reboots
- The compose service already has `restart: unless-stopped`. Confirm that Docker and Tailscale both
  start at boot: `systemctl is-enabled docker` and `systemctl is-enabled tailscaled`.
- The `tailscale serve --bg` config persists on its own. Verify it after `systemctl restart tailscaled`.

### 9. Backups (set these up; don't skip)
Create a nightly root cron job that archives the Docker volume to `/var/backups/baatcheet/` and keeps
the last 14 archives:
```bash
mkdir -p /var/backups/baatcheet
cat >/etc/cron.daily/baatcheet-backup <<'EOF'
#!/bin/sh
docker run --rm -v baatcheet_data:/data -v /var/backups/baatcheet:/backup alpine \
  tar czf /backup/baatcheet-$(date +%F).tgz -C /data .
ls -1t /var/backups/baatcheet/*.tgz | tail -n +15 | xargs -r rm --
EOF
chmod +x /etc/cron.daily/baatcheet-backup && /etc/cron.daily/baatcheet-backup && ls -lh /var/backups/baatcheet
```

### 10. Create an update script
Write `/opt/baatcheet/update.sh` and make it executable. It should run `git pull --ff-only` and
`docker compose up -d --build`, wait until `/healthz` answers, then print the last 20 log lines.
It lives outside git, so add it to `.git/info/exclude`.

### 11. Hand-off report to the owner
- The HTTPS URL (`https://<machine>.<tailnet>.ts.net`).
- The results of steps 5, 6 and 7, including the transcription JSON from step 6.
- How to share this machine with the friend: Tailscale admin console → **Machines** → this machine →
  **⋯** → **Share…** → send the invite. The friend installs Tailscale on their phone or laptop, accepts
  the share, and opens the same URL.
- How to update (`/opt/baatcheet/update.sh`), how to view logs (`docker compose logs -f`), and where
  the backups are.
- Anything you skipped or couldn't verify, and why.

---

## Done means

- [ ] `docker compose ps` shows baatcheet as **healthy**
- [ ] `/healthz` returns `ok` both on `127.0.0.1` and on the `ts.net` HTTPS URL
- [ ] The test clip went through OpenRouter and came back transcribed
- [ ] Nothing listens publicly on the app port, and there is no `tailscale funnel`
- [ ] `.env` is mode `600` and not in git, and the key was never printed
- [ ] The nightly backup and `update.sh` are in place
- [ ] The hand-off report has been delivered
