# CloudCLI repository instructions

Read `CLAUDE.md` for the existing development and deployment rules. Read the
`Current home deployment and migration handoff` section of `README.md` before
working on infrastructure, updating the running image, or proposing deployment.

## Operating rules

- Diagnose first. Do not change code during diagnostics.
- Before a mutation, obtain user authorization unless the current conversation
  already explicitly authorizes that operation. Documentation edits do not imply
  authorization to commit, push, deploy, restart, or change DNS.
- Make application code and deployment configuration changes in this local
  repository. Do not edit or copy application code directly onto a server.
- Commit and push only when the user authorizes them. Follow the normal repository
  deployment workflow; hand deployment commands to the user unless the user
  explicitly authorizes execution for that task.
- Never use an assistant identity or AI/co-author attribution in commits.
- Run long operations in the background, provide concrete monitoring instructions,
  and stop until the user asks to continue, as required by `CLAUDE.md`.

## Current target (verified 2026-10-13)

- CloudCLI local-test host: Ubuntu VM `192.168.1.31`, SSH port `22`, user `xyster3k`.
- Local repository: `Z:\Projects\claudecodeui`. VM repository:
  `/srv/stack/claudecodeui`. VM stack: `/srv/stack`.
- Local UI: `http://192.168.1.31:3001`.
- QNAP management host: `192.168.1.82`. It is the hypervisor/storage host, not the
  Ubuntu application VM.
- Previous CloudCLI VPS: `5.78.207.50:22022`. Public URL remains
  `https://cli.yuriypoteshkin.com`; Cloudflare has NOT been switched.
- `65.21.149.194` is the separate LongevitySearch production server. Its commits,
  PM2 services, and TypeScript checks are not this CloudCLI patch repository.

## Migration constraints

- The user explicitly postponed URL/DNS cutover. Do not change Cloudflare, expose
  a new public route, or retire the old VPS without renewed authorization.
- The VM runs `cloudcli-migration/claudecodeui:20261013`, reconstructed from the
  original container filesystem and configuration. It is not yet a normal
  reproducible deployment from the Dockerfile.
- Do not run plain `docker compose build` / `up --force-recreate` on the VM yet.
  It would lose the temporary LAN port mapping and unmounted runtime state.
  Follow the persistence and deployment checklist in `README.md` first.
- Preserve `/home/node/.claude.json` and `/home/node/.local` before replacing the
  snapshot container. The UI DOES read `.claude.json` for MCP, as does Claude.
  Changing `CLAUDE_CONFIG_DIR` alone is not sufficient UI compatibility.
- A push to `main` triggers `.github/workflows/deploy.yml`, including deployment
  to the host in GitHub secrets. Verify the actual CI destination and intended
  deployment before any authorized push; do not assume it now points at the VM.
- Keep the backup and snapshot image. Before final cutover, reconcile new writes
  on both hosts; never blindly overwrite the VM with the old VPS data.
- Do not add private keys, tokens, OAuth secrets, database contents, or captured
  Docker inventories to git.

The full handoff, backup locations, read-only checks, and remaining work are in
`README.md`. Refresh verified facts when the user authorizes the next phase.
