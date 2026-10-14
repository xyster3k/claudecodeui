# LAN deployment (QNAP VM `cloudcli-lab`)

Production runs on a VM in Virtualization Station on the QNAP NAS `HomeCloud` (192.168.1.82).

| | |
|---|---|
| VM | `cloudcli-lab`, 192.168.1.31 (DHCP), SSH `xyster3k@192.168.1.31` |
| Shell repo | `/srv/stack/claudecodeui` (this repo, `main`) |
| Docker stack | `/srv/stack` (`docker-compose.yml` + this directory's override) |
| Public URL | `https://cli.yuriypoteshkin.com`: Cloudflare Tunnel → Caddy → oauth2-proxy (Google) → app |
| LAN URL | `http://192.168.1.31:3001` (home network only, no Google gate) |

The home connection has **no open inbound ports**. `cloudflared` only dials out to Cloudflare,
so neither the home IP nor SSH is reachable from the internet. Keep it that way: do not add
port forwards on the router.

## Files

- `docker-compose.lan.yml` overrides the stack: it adds `cloudflared`, removes Caddy's 80/443
  ports, swaps in `Caddyfile.tunnel`, publishes the app on `:3001`, persists `~/.local` and
  `~/.gemini` (Gemini CLI login), and passes an optional `GEMINI_API_KEY` from `.env`.
- `Caddyfile.tunnel` is Caddy behind the tunnel: plain HTTP inside, scheme pinned to https.
- `notifier/notifier.js` is the Telegram notifier (service `notifier`, see below).
- The `Dockerfile` sets `CLAUDE_CONFIG_DIR=/home/node/.claude` and symlinks
  `~/.claude.json` into it, so Claude Code's config lives in the bind-mounted `claude-home`.

Secrets stay in `/srv/stack/.env` (never in git): `DOMAIN`, `GOOGLE_CLIENT_ID`,
`GOOGLE_CLIENT_SECRET`, `COOKIE_SECRET`, `ACME_EMAIL`, `TUNNEL_TOKEN`, plus
`COMPOSE_FILE=docker-compose.yml:claudecodeui/deploy/lan/docker-compose.lan.yml`. That line
makes every plain `docker compose ...` in `/srv/stack` include the override. **Without it, a
recreate drops the tunnel and the `:3001` port.**

## Normal deploy

Only when no agent is running. The container has no `ps`, so check with:

```bash
docker exec claudecodeui sh -c 'for p in /proc/[0-9]*; do c=$(tr "\0" " " < $p/cmdline 2>/dev/null); case "$c" in *"codex exec"*|*claude*) echo "${p#/proc/} $c";; esac; done'
```

Empty output means it is safe to deploy:

```bash
cd /srv/stack
git -C claudecodeui pull --ff-only origin main
docker compose build claudecodeui
docker compose up -d
```

Verify:

```bash
docker compose ps
docker logs --tail 20 cloudflared        # "Registered tunnel connection" x4
curl -s -o /dev/null -w '%{http_code}\n' http://192.168.1.31:3001/            # 200
docker exec caddy wget -qSO- --header "Host: cli.yuriypoteshkin.com" http://localhost/ 2>&1 | grep -m1 -E 'HTTP/|Location'   # 302 to /oauth2/sign_in
```

## Telegram notifications

The `notifier` container posts to the Telegram topic set by `TELEGRAM_CHAT_ID` and
`TELEGRAM_THREAD_ID`, using the bot in `TELEGRAM_BOT_TOKEN` (all three in `/srv/stack/.env`;
the old VPS used the same bot and topic). Every message starts with `[LAN]`. It reads the other
containers' logs and events from the Docker socket (read-only mount; no capabilities,
read-only filesystem) and sends:

| Event | Source |
|---|---|
| 🔑 Google login / ⚠️ failed | `oauth2-proxy` `[AuthSuccess]` / `[AuthFailure]` lines (email, IP) |
| 🔑 App login / ⚠️ failed | `claudecodeui` `[AUTH] login ...` lines from patch 084 (user, IP, LAN or public) |
| ❗ App error | `claudecodeui` stderr, stack traces grouped; known noise is ignored (`APP_ERROR_IGNORE`) |
| 💥 crash / OOM, ⏹ stop, ⚠️ SIGKILL, ▶️ start | Docker events for `claudecodeui`, `oauth2-proxy`, `cloudflared`, `caddy` |
| 🚀 New version deployed | a watched container starting from a different image than before |
| 🔴 Tunnel degraded / 🟢 restored | a `cloudflared` connection down for over 60 s (brief re-registers are normal and ignored) |

The same error or failed login is sent once, then summarized as "repeated ×N" after
10 minutes (`ERROR_WINDOW_SEC`). Long messages are split into several parts, never cut.
Without the token and chat ID the container stays idle and logs why.

It runs as an independent service, so it can be started or updated without touching the app:

```bash
cd /srv/stack
docker compose up -d notifier
docker logs --tail 20 notifier      # "notifier running; label LAN ..."; the topic gets "📡 Notifier started"
```

To add an ignore pattern or event, edit `notifier/notifier.js` locally, push, pull on the VM,
and run `docker compose restart notifier`.

## Rollback of the app container

The restored snapshot image `cloudcli-migration/claudecodeui:20261013` is kept on the VM.
Retagging it to the override's image name puts it back without rebuilding:

```bash
cd /srv/stack
docker tag cloudcli-migration/claudecodeui:20261013 stack-claudecodeui:lan
docker compose up -d --no-build claudecodeui
```

The snapshot predates the `~/.claude.json` symlink, so the app then reads the snapshot's own
copy of that file while the CLI uses `claude-home/.claude.json`. That is fine for an emergency
but not as a steady state.

## One-time migration (2026-10)

The container was restored from a full-filesystem snapshot. Before its first rebuild, the
state that existed only inside it was copied into bind mounts:

```bash
cd /srv/stack
docker cp claudecodeui:/home/node/.claude.json claude-home/.claude.json
docker cp claudecodeui:/home/node/.local home-local
```

Patch 082 added the `gemini-home` bind mount. Create it owned by the container user (uid
1000) before the first deploy that includes it; otherwise Docker creates it as root and the
CLI cannot save its login. The snapshot's `~/.gemini` held only session/tmp state, no login:

```bash
cd /srv/stack
mkdir -p gemini-home
docker cp claudecodeui:/home/node/.gemini/. gemini-home/
sudo chown -R 1000:1000 gemini-home
```

## Host hardening (run once, as xyster3k with sudo)

```bash
# No root logins over SSH; xyster3k has full sudo
echo 'PermitRootLogin no' | sudo tee /etc/ssh/sshd_config.d/10-no-root-login.conf
sudo sshd -t && sudo systemctl reload ssh

# Firewall: SSH only from the home network. Docker-published ports (:3001) bypass ufw by
# design and are reachable only on the LAN anyway; the tunnel needs no inbound rule.
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow from 192.168.1.0/24 to any port 22 proto tcp
sudo ufw --force enable
sudo ufw status verbose
```

## NAS

- VM autostart: Virtualization Station → `cloudcli-lab` → Settings → Auto Start → *Start* or
  *Retain previous state*. Without it the site stays down after a NAS reboot.
- NAS SSH uses a different user and key: `ssh -i ~/.ssh/id_ed25519_qnap_homecloud -o IdentitiesOnly=yes drpoteshkin@192.168.1.82`.
