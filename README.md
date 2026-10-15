# CloudCLI Custom Image

This repository builds `siteboon/claudecodeui` from the upstream CloudCLI source, applies local patches, and packages the result as the custom image used by the `claudecodeui` service.

The running UI is intentionally marked as `CloudCLI Custom`, `xyster3k`, and the current custom patch level (`p038`) so users can tell it is not the original upstream release.

Custom repository link used in the UI: `https://github.com/xyster3k/claudecodeui`.

**Operations:** see [Current home deployment and migration handoff](#current-home-deployment-and-migration-handoff).
The home VM is available for local testing; public URL cutover and normal deployment
adaptation are still pending. The image observed on the VM is `p081`; older `p038`
examples below describe the branding patch and are not the current deployment version.

## Why This Exists

The upstream npm package (`@cloudcli-ai/cloudcli`) is prebuilt, so runtime patching after install is not practical. This build clones the upstream source at a pinned commit, applies auditable patch files, builds the app, and installs local helper scripts into the final image.

## Repository Layout

```text
claudecodeui/
|-- Dockerfile                 # clone pinned upstream, apply patches, build runtime image
|-- extras/
|   |-- cloudcli-git-credential # GitHub PAT credential helper backed by CloudCLI auth DB
|   |-- cloudcli-project        # per-project git identity and token routing helper
|   |-- cloudcli-agy-login      # Gemini (Antigravity CLI) Google sign-in for the container
|   `-- etc-gitconfig           # global credential helper wiring for the container
|-- patches/                   # local customizations, applied in filename order
`-- README.md                  # this guide and feature inventory
```

## Pinned Upstream

`UPSTREAM_COMMIT` is defined in `Dockerfile`. Current pin:

```text
392c73b6933600ea8a589c5d4eff5f7b830f99c5  # v1.31.5
```

To bump upstream:

1. Update `ARG UPSTREAM_COMMIT=...` in `Dockerfile`.
2. Apply every file in `patches/` against the new upstream commit.
3. Refresh any patch that no longer applies.
4. Rebuild and smoke-test the image.
5. Update this README with any behavior changes.

## Pinned Codex CLI

`CODEX_CLI_VERSION` is defined in `Dockerfile` (currently `0.154.0`) and pins the globally
installed `@openai/codex` binary in the runtime image.

This matters because **the Codex CLI decides which models the API will serve**: the cached
`~/.codex/models_cache.json` is fetched keyed by `client_version`, so an old CLI simply never
sees newer models. Adding a model to `shared/modelConstants.js` only changes the dropdown — if
the CLI is too old, selecting it fails at runtime. `gpt-6-astra` needs CLI `>= 0.153.1`.

It is pinned rather than floating because an unpinned `npm install -g` sits in a Docker layer
that stays cached across rebuilds, so the CLI silently stayed old while the UI advertised new
models. Bump the pin whenever adopting a model that needs a newer CLI, and verify with:

```bash
docker exec claudecodeui codex --version
docker exec claudecodeui node -e "console.log(JSON.parse(require('fs').readFileSync('/home/node/.codex/models_cache.json','utf8')).models.map(m=>m.id))"
```

## Gemini runs on the Antigravity CLI

Google stopped serving Gemini CLI to personal accounts (free, AI Pro, Ultra) on 2026-06-18
("This client is no longer supported for Gemini Code Assist for individuals"). Since patch
085 the Gemini provider runs the Antigravity CLI (`agy`) instead, which accepts those
subscriptions. The image installs it to `/opt/agy/bin` with Google's installer (SHA-512
checked, always the latest build, then self-updating; it cannot be pinned).

- Sign-in: Settings → Gemini → Login runs `cloudcli-agy-login`, which shows a Google URL and
  reads the code back. The session is the file
  `~/.gemini/antigravity-cli/antigravity-oauth-token`; `~/.gemini` is bind-mounted from
  `/srv/stack/gemini-home`, so it survives rebuilds. No keyring service is needed.
- Chats run `agy --print … --output-format stream-json [--conversation <id>]`;
  `server/agy-event-translator.js` maps its events to the Gemini CLI shapes the UI parses.
- Usage counts against the Google account's Antigravity quota; when it is used up, chats show
  `Individual quota reached … Resets in …`.

Verify with:

```bash
docker exec claudecodeui agy --version
docker exec claudecodeui ls -l /home/node/.gemini/antigravity-cli/antigravity-oauth-token
```

## User Guide

Use CloudCLI as the web UI for coding-agent sessions across Claude, Codex, Gemini, and Cursor-backed workflows. The custom build adds operational features for multi-project work, builder orchestration, safer run control, voice input, and per-project GitHub credentials.

### Sidebar

The sidebar supports expanding multiple projects at once, persistent project visibility controls, project favorites, server-backed session naming, and run/stop controls directly on project/session rows.

Tips:

- Use the star button to keep active projects at the top.
- Expand several projects when comparing recent activity across workstreams.
- Use the stop button on a project/session row to terminate an active run without opening the chat.
- The header reads `CloudCLI Custom` and shows `xyster3k p038`; update this patch level whenever a new numbered patch is added.
- The GitHub star badge links to the xyster3k custom repository, not the upstream project.

### Chat And Run Control

The custom chat flow allows sending while generation is active, keeps stop controls visible, recovers stale loading states, guards against duplicate submits, and routes aborts to the active provider session.

Tips:

- If a run looks stuck, use the visible stop control first.
- If the browser reconnects after a long run, the UI can recover builder/run state instead of leaving the composer permanently locked.
- Voice input is available from the composer when the browser supports the Web Speech API.

### Builder Mode

Builder mode adds a planner/worker/integrator workflow for larger implementation tasks. It includes runtime orchestration, worker retries, plan documentation, QA evidence collection, buffered writer normalization, detachable writer support, reconnect UI, and cross-provider model routing.

Tips:

- Use Builder mode for larger, multi-step code changes rather than simple one-shot chat requests.
- Configure builder defaults in Settings -> Builder.
- Keep QA enabled for changes where regressions are expensive.
- Use provider/model routing when planner, worker, integrator, or QA roles need different models.

### Settings

Settings includes custom auth-mode controls, builder settings, Codex permission defaults, notification/task settings, provider credentials, and GitHub token management.

Tips:

- Add GitHub tokens in Settings -> API & Tokens before using per-project token routing.
- Builder settings saved in the UI are sent with Builder mode requests and override file/global defaults.
- Codex can use the globally installed CLI inside the container.

### GitHub Credentials

The image installs `/usr/local/bin/cloudcli-git-credential` and wires it through `/etc/gitconfig`. Git HTTPS operations against `github.com` can use the active CloudCLI GitHub token, or a named token scoped to a repo.

Use `cloudcli-project` inside the container:

```bash
cloudcli-project
cloudcli-project list
cloudcli-project tokens
cloudcli-project show
cloudcli-project identity "Your Name" "you@example.com"
cloudcli-project token <token-name>
cloudcli-project use-ssh
cloudcli-project use-https <token-name>
cloudcli-project ssh-test
```

Tips:

- Run `cloudcli-project show` inside a repo to see the effective Git identity and token route.
- Run `cloudcli-project clear` to remove repo-specific overrides and fall back to global settings.
- Prefer named tokens when different projects need different GitHub accounts or permissions.

## Custom Feature Inventory

Every user-visible patch should be listed here when added. Keep this table current so users and operators know what differs from upstream. Also update the visible custom patch level in `038-custom-build-branding.patch` whenever the newest patch number changes.

| Patch | Feature | User impact |
| --- | --- | --- |
| `001-sidebar-multi-expand.patch` | Multi-expand sidebar projects | Multiple projects can stay expanded at once. |
| `002-sidebar-project-visibility.patch` | Project visibility controls | Projects can be hidden or restored instead of permanently cluttering the sidebar. |
| `003-allow-send-during-generation.patch` | Send while active | New input can be submitted while a response is still generating. |
| `004-inbound-session-dedup.patch` | Session deduplication | Reduces duplicate inbound session handling. |
| `005-always-show-stop.patch` | Persistent stop control | Stop remains available during active runs. |
| `006-force-abort-when-loading.patch` | Stronger abort behavior | Stuck loading states can be interrupted more reliably. |
| `007-per-token-git-identity.patch` | Per-token Git identity | GitHub tokens can carry matching author identity metadata. |
| `008-ui-auth-mode-switch.patch` | Auth mode switching UI | Users can switch Git authentication mode from the UI. |
| `009-persist-thinking-mode.patch` | Thinking mode persistence | Reasoning/thinking preference survives refreshes. |
| `010-builder-mode-planning.patch` | Builder planning mode | Adds planning support for structured implementation tasks. |
| `011-builder-mode-runtime.patch` | Builder runtime | Runs planner, worker, and integration flows. |
| `012-cross-provider-qa-and-reasoning.patch` | Cross-provider QA/reasoning | QA and reasoning can use configured providers/models. |
| `013-planner-supervision-and-control.patch` | Planner supervision | Adds oversight checkpoints and control hooks. |
| `014-fresh-worker-retries-and-pass-logging.patch` | Worker retries and pass logs | Builder workers can retry with clearer run history. |
| `015-sidebar-run-stop-controls.patch` | Sidebar run/stop actions | Active work can be controlled from project/session rows. |
| `016-codex-global-cli-and-reasoning.patch` | Codex CLI/reasoning support | Codex uses the global CLI with reasoning options. |
| `017-builder-buffered-writer-normalization.patch` | Builder writer normalization | Builder output streaming is more consistent. |
| `018-builder-bypass-permissions-default.patch` | Builder permission default | Builder defaults to bypass-oriented permission behavior where configured. |
| `019-task-state-and-run-log-orchestration.patch` | Task state/run logs | Builder exposes richer task progress and run logs. |
| `020-nonblocking-worker-launch.patch` | Nonblocking workers | Builder worker startup does not block orchestration unnecessarily. |
| `021-builder-approval-session-routing.patch` | Approval session routing | Tool approvals route to the correct builder session. |
| `022-builder-sidebar-processing-transfer.patch` | Sidebar processing transfer | Sidebar reflects builder processing across session transitions. |
| `023-planner-plan-documentation.patch` | Plan documentation | Builder records planner output for review. |
| `024-builder-qa-evidence-and-plan-coverage.patch` | QA evidence and plan coverage | QA checks can reference evidence and plan coverage. |
| `025-builder-pipeline-quality-upgrade.patch` | Builder quality upgrades | Improves builder pipeline robustness and validation. |
| `026-builder-settings-ui.patch` | Builder settings UI | Adds Settings -> Builder configuration. |
| `028-session-name-extraction.patch` | Session name extraction | Sessions get better human-readable names from transcripts. |
| `029-builder-session-naming.patch` | Builder session naming | Builder-created sessions get clearer names. |
| `030-voice-input.patch` | Voice input | Browser speech recognition can append dictated text to the composer. |
| `031-loading-state-recovery.patch` | Loading recovery | UI can recover from stale loading/session state. |
| `032-json-extraction-brace-counting.patch` | JSON extraction hardening | Builder parsing handles fenced/embedded JSON more reliably. |
| `033-git-porcelain-unquote.patch` | Git porcelain parsing fix | Git status parsing handles quoted paths more safely. |
| `034-builder-cross-provider-model-routing.patch` | Builder model routing | Builder roles can route to effective provider/model selections. |
| `035-detachable-builder-writer.patch` | Detachable builder writer | Builder output can survive writer/session detach scenarios. |
| `036-builder-reconnect-ui.patch` | Builder reconnect UI | Users can reconnect to ongoing builder work. |
| `037-submit-dedup-guard.patch` | Submit dedup guard | Prevents accidental duplicate message submissions. |
| `038-custom-build-branding.patch` | Custom build branding | Sidebar, browser title, footer version, Settings/About, issue links, and GitHub star links identify this as `CloudCLI Custom p038 by xyster3k`. |
| `075-openai-gpt-5.6-models.patch` | OpenAI GPT-5.6 models | Adds GPT-5.6 Sol/Terra/Luna to the OpenAI (Codex) model picker; Codex default is now `gpt-5.6-sol`, and Builder Codex roles default to Sol (planner/integrator/QA) and Terra (worker). |
| `076-codex-inline-media-extraction.patch` | Inline media extraction | Stops a session from freezing the UI when a model captures a screenshot. Codex `tools.view_image()` results arrive as multi-megabyte base64 data URIs inlined in the tool output; they are now written once to a content-addressed cache (`~/.cloudcli/media`, served by `GET /api/media/:file`) and replaced by a marker the chat view renders as a real image. Any single tool output over 256 KB is likewise stashed, with a "Load full output" action that appends the exact remainder — nothing is truncated away. |
| `077-openai-gpt-6-astra.patch` | OpenAI GPT-6 Astra | Adds GPT-6 Astra, OpenAI's frontier flagship (successor to GPT-5.6 Sol), to the top of the OpenAI (Codex) model picker. Codex default is now `gpt-6-astra`, and Builder Codex roles default to Astra (planner/integrator/QA) with Terra kept as the worker for cost. Sol/Terra/Luna and the older models all remain selectable. Requires Codex CLI >= 0.153.1 — see `CODEX_CLI_VERSION` in `Dockerfile`. |
| `078-codex-device-auth-login.patch` | Codex device-code login | Settings → Codex → Login now runs `codex login --device-auth` (open `https://auth.openai.com/codex/device`, enter the one-time code shown in the terminal). The old browser flow waited for a callback on `localhost:1455` inside the container, which a remote browser can never reach, so sign-in never completed. Reopening the login modal also starts a fresh login instead of reattaching to a stale login PTY. Device-code sign-in must be allowed in ChatGPT security settings. |
| `079-voice-input-language.patch` | Voice input language | An EN/RU switch next to the Voice button picks the speech-recognition language (the browser API cannot auto-detect it). The choice is remembered per browser; switching while listening restarts recognition in the new language. |
| `080-codex-image-input.patch` | Codex sees attached images | Images attached in chat were silently dropped for OpenAI/Codex models: `queryCodex` never read `options.images`. They are now written to a temp dir and passed as `local_image` inputs (`codex exec --image`, also on resumed threads), so the model receives the actual pixels. Temp files are removed after the turn. |
| `081-codex-stop-and-interrupt.patch` | Codex stop + send while working | A new Codex thread was tracked under a placeholder `codex-<timestamp>` ID instead of its real thread ID, so status checks found nothing: no Stop button, no working indicator, and Stop could not find the run. Runs are now registered under the real ID from `thread.started`. A message sent while Codex is working (chat mode) interrupts the current turn and resumes the same thread with it; the work done so far stays in the thread history. Reloading the page reattaches the live stream to the running turn, like Claude sessions. Builder also now receives the real Codex thread ID. |
| `082-gemini-google-login.patch` | Gemini Google-account login | Settings → Gemini → Login opened a static "Setup Gemini API Access" page with a non-existent `gemini config set api_key` command, so Gemini could only be used with an API key (and the CLI was not installed in the image at all). Login now opens a terminal running `cloudcli-gemini-login`: it sets `security.auth.selectedType=oauth-personal` in `~/.gemini/settings.json` and runs Gemini with `NO_BROWSER=true`, which prints a Google sign-in URL and reads the authorization code back from the terminal. This uses the Google account's own quota (free tier or Google AI Pro/Ultra). Type `/quit` once Gemini's prompt appears. `GEMINI_API_KEY` in the server environment still works as an alternative. Also fixes the install check, which reported a missing CLI as "Gemini CLI not configured" because `spawn.sync` does not throw on ENOENT. |
| `083-thinking-mode-setter-type.patch` | Typecheck fix | No behavior change. Patch 009 replaced `setThinkingMode` with a persisting `(mode: string) => void` wrapper, but `ChatComposer` still typed the prop as `Dispatch<SetStateAction<string>>`, so frontend `tsc --noEmit` failed at `ChatInterface.tsx:491` (the Vite build does not typecheck, so it went unnoticed). The prop type now matches the wrapper. |
| `084-login-audit-log.patch` | Login audit log | The username/password login (`POST /api/auth/login`) logged nothing. It now writes `[AUTH] login ok|failed reason=unknown-user|bad-password user="..." ip=... via=direct|proxy` (client IP from `cf-connecting-ip` / `x-forwarded-for` behind the tunnel). The LAN Telegram notifier (`deploy/lan/notifier`) turns these into login and failed-login messages. Passwords are never logged. |
| `085-gemini-via-antigravity-cli.patch` | Gemini via Antigravity CLI | Google retired Gemini CLI for personal accounts, so Gemini login failed with "This client is no longer supported". The Gemini provider (chat, Builder, Tester, `/api/agent`) now runs `agy`: `--print` with `--output-format stream-json`, resume via `--conversation`, permission modes mapped to `--dangerously-skip-permissions` / `--mode accept-edits|plan`. `server/agy-event-translator.js` converts its events to the Gemini CLI shapes the UI already renders (text deltas, tool use/results, token totals, errors such as quota exhaustion). Models: Gemini 4 Argon and Gemini 3.8 Flash at low/medium/high effort (default Argon Medium); stale saved model IDs fall back to the default. Login runs `cloudcli-agy-login` (Google URL + pasted code); the terminal now re-joins hard-wrapped URLs so the full sign-in link is offered. Status reads agy's token file and shows the account email. Gemini MCP settings and `--allowed-tools` are not passed to agy. |

## Adding A Feature

1. Clone upstream at the pinned commit.
2. Apply the current `patches/` stack in filename order.
3. Make the change in the upstream clone.
4. Save the diff as the next numbered patch, for example `039-my-feature.patch`.
5. Update the visible custom patch level in `038-custom-build-branding.patch` from `p038` to the new latest patch number.
6. Add a row to the Custom Feature Inventory.
7. Add usage notes under User Guide if users need to know how to operate the feature.
8. Rebuild and verify.

Example patch workflow:

```bash
git clone https://github.com/siteboon/claudecodeui.git /tmp/claudecodeui
cd /tmp/claudecodeui
git checkout 392c73b6933600ea8a589c5d4eff5f7b830f99c5
for p in /path/to/this/repo/patches/*.patch; do git apply --index "$p"; done
# make edits
git diff > /path/to/this/repo/patches/039-my-feature.patch
```

## Build And Deploy

Local build:

```bash
docker build -t siteboon/claudecodeui:custom .
```

### Current home deployment and migration handoff

Last verified: **2026-10-13, Europe/Madrid**. Re-check live state before making changes.

| Item | Current value |
| --- | --- |
| Local working repository | `Z:\Projects\claudecodeui` |
| Home application host | Ubuntu VM `192.168.1.31`, SSH `22`, user `xyster3k` |
| VM resources | 10 GiB assigned RAM, 2 vCPU, 160 GiB virtual disk |
| VM repository / stack | `/srv/stack/claudecodeui` / `/srv/stack` |
| Local test UI | `http://192.168.1.31:3001` |
| Running container / network | `claudecodeui` / `stack_web` |
| Running image | `cloudcli-migration/claudecodeui:20261013` |
| Patch repository HEAD at verification | `9b806eb27a09d44694436f1ab06d9cbfd24b7f67` (`p081`) |
| Runtime versions verified | Node `22.23.3`, Codex `0.154.0`, Claude Code `2.1.283` |
| QNAP storage / hypervisor | HomeCloud `192.168.1.82`, TS-262, 16 GiB physical RAM |
| Previous CloudCLI VPS | `5.78.207.50`, SSH `22022`, user `xyster3k` |
| Public URL | `https://cli.yuriypoteshkin.com`; Cloudflare cutover NOT performed |

The user explicitly asked to postpone URL cutover. Continue local testing and
prepare reviewable changes; do not change DNS, publish a Tunnel route, shut down
the old VPS, or deploy without the relevant user authorization.

Connect from the local machine:

```bash
ssh -i ~/.ssh/id_ed25519_xyster3k xyster3k@192.168.1.31
```

The QNAP SSH key is a different key, `id_ed25519_qnap_homecloud`, for
`drpoteshkin@192.168.1.82`. Keep private key material out of the repository.
The VM is managed by QNAP Virtualization Station (display name `CloudCLI-Lab`,
domain UUID `125c5c7a-1003-4082-8f21-7c5f7490826f`). Its disk is
`/share/Public/CloudCLI-Lab/vm/CloudCLI-Lab.img`, with a VirtIO NIC on bridge
`qvs0`, MAC `52:54:00:4a:2c:ca`, and autostart configured with a 60-second delay.
`192.168.1.31` was obtained through DHCP; verify/reserve the address before
depending permanently on the current IP-bound port mapping. Storage is on the
main SATA SSD volume; the NVMe remains the QNAP cache and was not reformatted.
The separate LongevitySearch production server is `65.21.149.194`; its PM2
services and commit `944739129` reported by another agent are not this repository.

#### What has been completed

- Captured 264 filesystem parts plus inventory, Docker images, three container
  filesystem exports, Docker volume data, a filesystem manifest, and consistent
  SQLite snapshots: **272 verified backup artifacts** in total.
- All transferred artifacts passed SHA-256 checks. Sixteen SQLite snapshots
  passed integrity checks; all sixteen were restored and checked on the VM.
- Finished the VM restore worker's **271 steps**. This count excludes the
  filesystem manifest, which is used to plan restoration rather than unpacked.
- Restored application data under `/srv`, `/home`, `/root`, `/opt`, and
  `/usr/local`, while retaining the VM's SSH authorized keys, network setup, and
  machine identity. Other captured host files, the source swapfile, and Docker
  logs remain in the NAS backup; they were not activated on the new VM.
- Loaded original Docker images and imported all three container filesystem
  snapshots with their saved runtime metadata. Only `claudecodeui` is running.
- Verified the local UI and `/api/auth/status` return HTTP 200. This proves local
  availability, not completion of user login, chat, terminal, or provider tests.
- Caddy and oauth2-proxy snapshots are available but their containers are not
  running. The local URL uses application login without the previous Google gate.

The capture was online. SQLite snapshots are individually consistent, but the
whole capture is not a single frozen point in time. New data written to either
host since capture must be reconciled before any final switch.

#### Persistent state and first ordinary deployment

Existing application bind mounts are:

| VM path | Container path |
| --- | --- |
| `/srv/projects` | `/home/node/projects` |
| `/srv/stack/claude-home` | `/home/node/.claude` |
| `/srv/stack/codex-home` | `/home/node/.codex` |
| `/srv/stack/gh-config` | `/home/node/.config/gh` |
| `/srv/stack/cloudcli-data` | `/home/node/.cloudcli` |
| `/srv/stack/git-home/.gitconfig` | `/home/node/.gitconfig` |
| `/srv/stack/deploy-ssh` | `/home/node/.ssh` |
| `/srv/stack/claudecodeui-data` | `/home/node/.claude-code-ui` |

The snapshot additionally preserves unmounted files, including
`/home/node/.claude.json` and `/home/node/.local` (user-installed Python packages
and CLI state). A fresh build/recreation does not preserve those automatically.
Before the first normal deployment:

1. Finish or stop active agents with user authorization, then take an up-to-date
   backup of writable mounts, SQLite, `.claude.json`, and `.local`.
2. Add reviewed deployment configuration in git for the LAN mapping
   `192.168.1.31:3001:3001`, for example `docker-compose.lan.yml`. The current
   `/srv/stack/docker-compose.yml` does not publish the app's port. Preserve the
   LAN address when selecting compose files for every subsequent deployment.
3. Migrate unmounted state to persistent directories and preserve UID/GID
   `1000:1000`. Preserve package requirements as part of the reproducible image
   where appropriate; do not rely only on manually installed runtime packages.
4. If using `CLAUDE_CONFIG_DIR=/home/node/.claude`, migrate the global config to
   the appropriate file in that mounted directory and keep `/home/node/.claude.json`
   compatible, e.g. through an image-created symlink or reviewed code changes.
   The UI reads the home-level file in `server/claude-sdk.js`,
   `server/modules/providers/list/claude/claude-mcp.provider.ts`, and
   `server/utils/mcp-detector.js`. Verify UI and CLI MCP settings agree before
   replacing the snapshot container. Do not assume the UI ignores this file.
5. Keep `cloudcli-migration/claudecodeui:20261013` and backups for rollback.
   Returning to an image does not undo database or bind-mount changes.
6. Use the normal local edit / authorized commit and push / deployment workflow.
   Do not edit application code directly on either server. Verify login, existing
   sessions, projects, terminal/WebSockets, Claude/Codex, and persistence after
   recreation before declaring deployment complete.

**CI destination must be checked before a push.** `.github/workflows/deploy.yml`
runs on pushes to `main` and `workflow_dispatch`, verifies the patch stack, then
pulls/builds/recreates the container on the host in `DEPLOY_HOST`, `DEPLOY_PORT`,
`DEPLOY_USER`, with `DEPLOY_SSH_KEY` and `DEPLOY_KNOWN_HOSTS`. The current secret
values have not been inspected in this migration. A documentation-only push can
still deploy. Do not assume the target switched to the home VM. A hosted GitHub
runner cannot directly use the private LAN IP without an approved connectivity
solution; a public HTTP Tunnel alone is not ordinary SSH deploy connectivity.

#### Backup, logs, and read-only checks

NAS backup location:

```text
/share/CACHEDEV1_DATA/Public/CloudCLI-Lab/migration-20261013-005917
Z:\CloudCLI-Lab\migration-20261013-005917
```

The backup and `source-inventory.json` contain private credentials/configuration.
Retain their restricted access. Never copy their contents into git or public logs.

VM migration metadata is in `/srv/cloudcli-migration`:

- `source-metadata/source-inventory.json`: private saved container configuration.
- `container-snapshots/`: preserved compressed filesystem snapshots.
- `runtime-state.json`: readiness state; it records `ready_for_local_test`.
- `runtime-restore.log`: historical import/start log with a final verified LAN
  readiness entry. Earlier failure entries remain as history.
- `incoming/`: temporary files from interrupted uploads; not application data.
  Do not delete migration artifacts without explicit cleanup authorization.

Run these read-only checks after SSHing into the VM:

```bash
docker ps --format '{{.Names}} {{.Image}} {{.Status}} {{.Ports}}'
curl -fsS http://192.168.1.31:3001/api/auth/status
sudo cat /srv/cloudcli-migration/runtime-state.json
docker exec claudecodeui node --version
docker exec claudecodeui codex --version
docker exec claudecodeui claude --version
free -h
df -h /
```

The VM publishes port 3001 on its LAN address. A host-side probe to
`127.0.0.1:3001` will fail with the current mapping. Inside the container,
`127.0.0.1:3001` is valid.

Windows migration workers, state, and logs remain in:

```text
C:\Users\yuriy\Documents\Codex\2026-10-12\new-chat\work\qnap-cloudcli
```

That directory contains `capture-server.py`, `restore-server.py`,
`runtime-restore.py`, their saved state, and historical logs. These are migration
tools, not the normal deployment workflow. Capture uses independent SHA-256
verified parts and immutable checkpoints. Data restore caches each archive
locally, verifies it, and resumes VM uploads from confirmed remote byte offsets;
the remote writer releases idle connections after 45 seconds. Do not restart
completed workers just because an old log contains a `FAILED` line. Use current
state and live container/HTTP checks, then diagnose before any authorized retry.

The existing monitor is:

```powershell
& 'C:\Users\yuriy\Documents\Codex\2026-10-12\new-chat\outputs\migration-monitor.ps1'
```

Capture and data restore finished; those Windows workers are no longer required.
The running application is independent of that PC. Keep the NAS/VM powered on.

#### Deferred public URL and memory work

After user approval, a proposed route is Cloudflare Tunnel -> Caddy -> existing
oauth2-proxy authentication checks -> CloudCLI. The saved oauth2-proxy has
`--upstream=static://202`; pointing a Tunnel directly at it will not serve the UI.
The existing Google callback is
`https://cli.yuriypoteshkin.com/oauth2/callback`. Prepare and verify proxy/TLS,
Google login, streaming, and WebSockets before changing the production route.
Resolve changes written to both machines first; do not blindly synchronize the
old VPS over new VM work. Keep the previous VPS until rollback is verified.

RAM remains 10 GiB. Node's measured default heap limit was about 2096 MiB; this
is a per-process limit, not evidence that the VM needs more RAM. For the separate
LongevitySearch project's heavy typecheck, the recommendation was:

```bash
NODE_OPTIONS=--max-old-space-size=6144 npm run typecheck
```

This recommendation has NOT been applied by this migration task. Scope it to
that project's typecheck command rather than every Node process or the whole
CloudCLI container. Archive-related TypeScript errors need separate diagnosis;
`.gitignore` does not exclude files from TypeScript. That project and its PM2
production services should be handled in their own repository/workflow.

### Legacy rebuild reference

The following was the previous VPS rebuild procedure. It is **not ready to run
on the home VM** until the persistence, port mapping, CI, and backup steps above
are completed and deployment is authorized:

```bash
cd /srv/stack
sudo docker compose build claudecodeui
sudo docker compose up -d --force-recreate claudecodeui
```

## Verification

Before deploying a new patch:

1. Confirm all patches apply against the pinned upstream commit.
2. Run the frontend/server build through Docker.
3. Smoke-test login, sidebar load, chat submit, stop/abort, Settings, Git panel, and Builder mode if touched.
4. Check that the sidebar shows `CloudCLI Custom` and the latest `xyster3k pNNN` patch level.
5. Update this README in the same change as the patch.

## Troubleshooting

`error: patch does not apply` means upstream changed or an earlier patch changed the same context. Rebuild the patch stack against the pinned commit and refresh the failing patch.

If GitHub HTTPS auth fails, check that a token exists in Settings -> API & Tokens, then run `cloudcli-project tokens` and `cloudcli-project show` inside the affected repo.

If Builder mode appears stuck after reconnecting, refresh the browser once and use the reconnect or stop controls before starting a duplicate task.
