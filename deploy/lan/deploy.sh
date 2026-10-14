#!/usr/bin/env bash
# deploy.sh — deploy the pushed `main` to the LAN VM in one command, from a local checkout.
#
#   deploy/lan/deploy.sh            # refuses if an agent run is active in the app
#   deploy/lan/deploy.sh --force    # deploy anyway (kills running agent sessions)
#
# Steps: check local HEAD is pushed -> check no agent is running -> pull --ff-only on the VM
# -> one-time dirs -> build the app image -> `docker compose up -d` (recreates only changed
# services; the notifier reports the deploy to Telegram) -> health check.
# Nothing is copied to the server: the VM pulls the same commit from GitHub.
#
# Env overrides: DEPLOY_SSH (default xyster3k@192.168.1.31), DEPLOY_KEY (default
# ~/.ssh/id_ed25519_xyster3k).

set -euo pipefail

FORCE=0
[ "${1:-}" = "--force" ] && FORCE=1

DEPLOY_SSH="${DEPLOY_SSH:-xyster3k@192.168.1.31}"
DEPLOY_KEY="${DEPLOY_KEY:-$HOME/.ssh/id_ed25519_xyster3k}"
REPO_DIR="$(cd "$(dirname "$0")/../.." && pwd)"

git -C "$REPO_DIR" fetch --quiet origin main
SHA="$(git -C "$REPO_DIR" rev-parse HEAD)"
REMOTE_SHA="$(git -C "$REPO_DIR" rev-parse origin/main)"
if [ "$SHA" != "$REMOTE_SHA" ]; then
  echo "Local HEAD $SHA is not origin/main ($REMOTE_SHA). Push first (or check out main)." >&2
  exit 1
fi
echo "Deploying $(git -C "$REPO_DIR" log -1 --oneline) to $DEPLOY_SSH"

ssh -i "$DEPLOY_KEY" -o BatchMode=yes -o ConnectTimeout=10 "$DEPLOY_SSH" \
  bash -s -- "$SHA" "$FORCE" <<'REMOTE'
set -euo pipefail
sha="$1"
force="$2"
cd /srv/stack

echo "== Active agent runs"
busy="$(docker exec claudecodeui sh -c 'for p in /proc/[0-9]*; do c=$(tr "\0" " " < $p/cmdline 2>/dev/null); case "$c" in *"codex exec"*|*claude*) echo "${p#/proc/} $c";; esac; done' 2>/dev/null || true)"
if [ -n "$busy" ]; then
  echo "$busy"
  if [ "$force" != "1" ]; then
    echo "Agents are running; not deploying. Re-run with --force to deploy anyway." >&2
    exit 2
  fi
  echo "--force given: deploying anyway."
else
  echo "none"
fi

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

echo "== Build"
docker compose build claudecodeui

echo "== Up"
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
echo "Deployed $sha"
REMOTE
