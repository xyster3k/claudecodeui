#!/usr/bin/env bash
# deploy.sh — deploy the pushed `main` to the LAN VM in one command, from a local checkout.
#
#   deploy/lan/deploy.sh            # refuses to restart the app while an agent is running
#   deploy/lan/deploy.sh --wait     # waits until no agent has run for 5 minutes, then restarts
#   deploy/lan/deploy.sh --force    # restarts even if agents are running (kills them)
#
# Steps: check local HEAD is pushed -> pull --ff-only on the VM -> one-time dirs -> build the
# app image (the running app is untouched) -> agent gate -> `docker compose up -d` (recreates
# only changed services; the notifier reports the deploy to Telegram) -> health check.
# Nothing is copied to the server: the VM pulls the same commit from GitHub.
#
# Env overrides: DEPLOY_SSH (default xyster3k@192.168.1.31), DEPLOY_KEY (default
# ~/.ssh/id_ed25519_xyster3k), WAIT_IDLE_SEC (default 300), WAIT_MAX_SEC (default 43200).

set -euo pipefail

MODE=refuse
case "${1:-}" in
  --force) MODE=force ;;
  --wait) MODE=wait ;;
  "") ;;
  *) echo "usage: $0 [--wait|--force]" >&2; exit 64 ;;
esac

DEPLOY_SSH="${DEPLOY_SSH:-xyster3k@192.168.1.31}"
DEPLOY_KEY="${DEPLOY_KEY:-$HOME/.ssh/id_ed25519_xyster3k}"
WAIT_IDLE_SEC="${WAIT_IDLE_SEC:-300}"
WAIT_MAX_SEC="${WAIT_MAX_SEC:-43200}"
REPO_DIR="$(cd "$(dirname "$0")/../.." && pwd)"

git -C "$REPO_DIR" fetch --quiet origin main
SHA="$(git -C "$REPO_DIR" rev-parse HEAD)"
REMOTE_SHA="$(git -C "$REPO_DIR" rev-parse origin/main)"
if [ "$SHA" != "$REMOTE_SHA" ]; then
  echo "Local HEAD $SHA is not origin/main ($REMOTE_SHA). Push first (or check out main)." >&2
  exit 1
fi
echo "Deploying $(git -C "$REPO_DIR" log -1 --oneline) to $DEPLOY_SSH (mode: $MODE)"

ssh -i "$DEPLOY_KEY" -o BatchMode=yes -o ConnectTimeout=10 -o ServerAliveInterval=60 "$DEPLOY_SSH" \
  bash -s -- "$SHA" "$MODE" "$WAIT_IDLE_SEC" "$WAIT_MAX_SEC" <<'REMOTE'
set -euo pipefail
sha="$1"
mode="$2"
idle_needed="$3"
wait_max="$4"
cd /srv/stack
ts() { date -u +%H:%M:%SZ; }

# Agent processes in the app container, one "pid executable" per line. Matched by executable
# name (argv[0], or argv[1] for `node <script>`), not by substring: the always-running plugin
# server lives under ~/.claude-code-ui and must not count.
agents() {
  docker exec claudecodeui sh -c '
    for p in /proc/[0-9]*; do
      set -- $(tr "\000" " " < $p/cmdline 2>/dev/null)
      [ $# -gt 0 ] || continue
      for a in "$1" "${2:-}"; do
        case "${a##*/}" in
          claude|codex|gemini) echo "${p#/proc/} ${a##*/}"; break ;;
        esac
      done
    done' 2>/dev/null || true
}

echo "== Pull"
git -C claudecodeui fetch --quiet origin main
git -C claudecodeui merge --ff-only "$sha"
actual="$(git -C claudecodeui rev-parse HEAD)"
[ "$actual" = "$sha" ] || { echo "VM checkout is at $actual, expected $sha" >&2; exit 1; }

echo "== One-time dirs"
# gemini-home (patch 082): seed from the running container once so nothing is lost.
if [ ! -d gemini-home ]; then
  mkdir -p gemini-home
  docker cp claudecodeui:/home/node/.gemini/. gemini-home/ 2>/dev/null || true
  echo "created gemini-home"
fi

echo "== Build (running app untouched) $(ts)"
docker compose build claudecodeui

echo "== Notifier (independent of agents; its code is bind-mounted, so restart to reload)"
docker compose up -d notifier
docker compose restart notifier

echo "== Agent gate ($mode) $(ts)"
busy="$(agents)"
if [ -n "$busy" ]; then
  echo "running agents:"; echo "$busy"
  case "$mode" in
    force) echo "--force: restarting anyway." ;;
    refuse)
      echo "Agents are running; image is built but the app was NOT restarted." >&2
      echo "Re-run with --wait (deploy when idle) or --force." >&2
      exit 2 ;;
    wait)
      echo "waiting for ${idle_needed}s with no agent running (max ${wait_max}s)..."
      waited=0; idle=0
      while [ "$idle" -lt "$idle_needed" ]; do
        if [ "$waited" -ge "$wait_max" ]; then
          echo "Gave up after ${wait_max}s; image is built but the app was NOT restarted." >&2
          exit 3
        fi
        sleep 30; waited=$((waited + 30))
        if [ -n "$(agents)" ]; then
          [ "$idle" -gt 0 ] && echo "$(ts) agent started again; idle timer reset"
          idle=0
        else
          idle=$((idle + 30))
        fi
      done
      echo "$(ts) idle for ${idle_needed}s; restarting." ;;
  esac
else
  echo "none"
fi

echo "== Up $(ts)"
docker compose up -d

echo "== Health"
for attempt in $(seq 1 30); do
  code="$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3001/ || true)"
  if [ "$code" = "200" ]; then
    echo "app HTTP 200 after ${attempt} attempt(s)"
    break
  fi
  [ "$attempt" = 30 ] && { echo "app not healthy (last HTTP $code)" >&2; docker compose logs --tail=50 claudecodeui >&2; exit 1; }
  sleep 2
done
docker compose ps --format 'table {{.Name}}\t{{.Status}}'
echo "== Notifier"
docker logs --tail 5 notifier 2>&1 || true
echo "Deployed $sha $(ts)"
REMOTE
