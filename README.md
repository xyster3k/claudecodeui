# CloudCLI Custom Image

This repository builds `siteboon/claudecodeui` from the upstream CloudCLI source, applies local patches, and packages the result as the custom image used by the `claudecodeui` service.

The running UI is intentionally marked as `CloudCLI Custom` so users can tell it is not the original upstream release.

## Why This Exists

The upstream npm package (`@cloudcli-ai/cloudcli`) is prebuilt, so runtime patching after install is not practical. This build clones the upstream source at a pinned commit, applies auditable patch files, builds the app, and installs local helper scripts into the final image.

## Repository Layout

```text
claudecodeui/
|-- Dockerfile                 # clone pinned upstream, apply patches, build runtime image
|-- extras/
|   |-- cloudcli-git-credential # GitHub PAT credential helper backed by CloudCLI auth DB
|   |-- cloudcli-project        # per-project git identity and token routing helper
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

## User Guide

Use CloudCLI as the web UI for coding-agent sessions across Claude, Codex, Gemini, and Cursor-backed workflows. The custom build adds operational features for multi-project work, builder orchestration, safer run control, voice input, and per-project GitHub credentials.

### Sidebar

The sidebar supports expanding multiple projects at once, persistent project visibility controls, project favorites, server-backed session naming, and run/stop controls directly on project/session rows.

Tips:

- Use the star button to keep active projects at the top.
- Expand several projects when comparing recent activity across workstreams.
- Use the stop button on a project/session row to terminate an active run without opening the chat.
- The `Custom` badge beside `CloudCLI` means this image contains local patches.

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

Every user-visible patch should be listed here when added. Keep this table current so users and operators know what differs from upstream.

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
| `038-custom-build-branding.patch` | Custom build branding | Sidebar and browser title identify the image as a custom build. |

## Adding A Feature

1. Clone upstream at the pinned commit.
2. Apply the current `patches/` stack in filename order.
3. Make the change in the upstream clone.
4. Save the diff as the next numbered patch, for example `039-my-feature.patch`.
5. Add a row to the Custom Feature Inventory.
6. Add usage notes under User Guide if users need to know how to operate the feature.
7. Rebuild and verify.

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

VPS rebuild:

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
4. Check that the sidebar shows `CloudCLI` with a `Custom` badge.
5. Update this README in the same change as the patch.

## Troubleshooting

`error: patch does not apply` means upstream changed or an earlier patch changed the same context. Rebuild the patch stack against the pinned commit and refresh the failing patch.

If GitHub HTTPS auth fails, check that a token exists in Settings -> API & Tokens, then run `cloudcli-project tokens` and `cloudcli-project show` inside the affected repo.

If Builder mode appears stuck after reconnecting, refresh the browser once and use the reconnect or stop controls before starting a duplicate task.
