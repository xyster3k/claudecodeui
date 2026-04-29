# Custom CloudCLI image

Builds `siteboon/claudecodeui` from upstream source with local patches applied. The image is what the `claudecodeui` service in `/srv/stack/docker-compose.yml` runs.

## Why a custom build

The upstream npm package (`@cloudcli-ai/cloudcli`) is prebuilt — there's no way to patch it post-install. Building from source lets us fix specific UX issues without forking the whole project on GitHub.

## Layout

```
claudecodeui/
├── Dockerfile          # multi-stage: clone upstream @ pinned commit -> apply patches -> build -> runtime
├── patches/            # unified diffs, applied in filename order (git apply --index)
│   └── 001-sidebar-multi-expand.patch
└── README.md
```

## Pinned upstream commit

`UPSTREAM_COMMIT` is baked into the Dockerfile as an ARG default.

**Bumping it:**
1. Update the `ARG UPSTREAM_COMMIT=...` line in `Dockerfile`
2. Re-test that every patch in `patches/` still applies cleanly against the new commit
3. Rebuild locally: `docker compose build claudecodeui`
4. Commit

## Active patches

### 001-sidebar-multi-expand.patch

**What:** flips the project-list toggle from accordion (at most one expanded) to multi-expand (any number expanded).

**Why:** with several in-flight projects, you want to see last-activity timestamps across all of them at a glance; the accordion forced click-by-click inspection.

**Where:** `src/components/sidebar/hooks/useSidebarController.ts`, inside `toggleProject`.

## Adding a new patch

1. Clone upstream locally at the same pinned commit: `git clone https://github.com/siteboon/claudecodeui.git && git checkout <UPSTREAM_COMMIT>`
2. Make your edits.
3. `git diff > 002-your-change.patch`
4. Copy the patch into `patches/` (name prefix determines apply order).
5. Rebuild, test.

## Rebuilding on the VPS

```bash
cd /srv/stack && sudo docker compose build claudecodeui && sudo docker compose up -d --force-recreate claudecodeui
```

## Troubleshooting

**"error: patch does not apply"** — the pinned commit drifted or the target file changed. Refresh the patch against the current pin:

```bash
git clone https://github.com/siteboon/claudecodeui.git
cd claudecodeui && git checkout <UPSTREAM_COMMIT>
git apply --check ../patches/your.patch   # will tell you which hunks fail
```

Re-record the patch against the new commit.
