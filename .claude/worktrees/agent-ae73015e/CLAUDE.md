# Global Development Rules

## NEVER sign commits as co-author

NEVER add "Co-Authored-By", "Co-authored-by", or any variation of co-author attribution to commit messages. Do not add any AI/bot/Claude signature, attribution, or credit line to commits. Commits are authored solely by the user.

## Don't burn tokens waiting for long processes — hand off and stop

When kicking off any long-running or continuous process (backfills, full scans, batch jobs, deploys with long builds, watch loops, anything that takes more than ~2 minutes):

1. **Start it in the background** (`nohup ... &` + write a PID file, or `run_in_background: true` on the tool call).
2. **Hand off concrete monitoring instructions to the user**: the exact SSH command, log path, PID file, and SQL query they can use to check progress.
3. **Stop after starting it.** Do NOT poll, sleep, tail, or call ScheduleWakeup just to wait for it. Token spend on waiting is pure waste.
4. **Resume only when the user pings.** They drive cadence; they will check progress and tell you when there's real work.

**Why:** Every minute spent tailing a 6-hour backfill, polling a quota cooldown, or watching a deploy is tokens burned for nothing. The user has explicitly flagged this as a hard rule.

**How to apply:**
- One-shot quick checks (<=30s, single sample) — foreground is fine.
- Anything >=2 minutes — background it, hand off the monitor command, stop.
- Same applies to subscription/quota cooldowns, slow builds, multi-hour batches, anything that's a clock-watch task.
- *Don't* schedule wake-ups to "check back in N minutes" unless the user explicitly asks for that pacing.

**Commands the user runs are run ON THE SERVER, not from a local machine.** The user is always SSHed into the relevant server. Hand them BARE shell commands — no `ssh -i ... root@... "..."` wrapper. They've already SSHed in. Wrapping commands in SSH is double-tunneling and frustrating; they've explicitly flagged it as a hard rule.

**The right end-of-turn message looks like:**
> Started [process]. PID `4096072`, log at `/tmp/foo.log`.
> Monitor: `tail -20 /tmp/foo.log; ps -p $(cat /tmp/foo.pid) -o etime --no-headers || echo done`
> Verify when finished: `<bare SQL/curl/script command>`
> Ping me when it finishes (or if it errors) and I'll review.

Then **stop**.

## When something repeats or keeps failing — STOP and diagnose

If the same thing breaks twice (process dies, import fails, deploy doesn't pick up change, test fails after a fix), do NOT just retry the same fix. That's how you burn hours.

**First question: "Is the code on the server actually NEW, or still OLD?"**
Check this BEFORE any other debugging:
1. `ssh ... "cd /path && git log -1 --oneline"` — what commit is on server?
2. Compare to local: `git log -1 --oneline`
3. If they differ, the server is running old code. Everything else is noise until that's fixed.
4. Also check: was `npm install` run? Was `npm run build` run? Was the process restarted after pull?

**Second question: what actually killed the previous attempt?**
- Read the last 50 lines of logs
- Check for unhandled promise rejections, OOM kills, network timeouts, rate-limit responses
- Don't assume "terminal closed" without evidence — `nohup` survives that
- Check `dmesg`, `journalctl`, and the app's own stderr log

**Third: find the ROOT cause, not the symptom.**
- "Process died" is a symptom, not a cause
- "API returned 429, we don't handle it, so Node crashed" is a cause
- Fix the cause (add retry/backoff) not the symptom (just restart)

Only after those three steps should you retry. Otherwise you're in a loop.

## ABSOLUTE RULE: Never Copy or Modify Files Directly on Servers

**NEVER** copy files to a server, SCP files to a server, edit files on a server via SSH, or run `sed`/`echo`/`tee` to write content on a server. Not even "just this once." Not even for a quick fix.

The **only** correct way to get code onto a server is:
1. Write/edit locally
2. `git commit` + `git push` from the local machine
3. `git pull` on the server

SSH is **READ-ONLY**: checking logs, querying the DB, running scripts that already exist there. Period.

Violating this rule means the server diverges from git, and the next deploy will overwrite or conflict with the manual change — causing data loss or broken deploys.

## Deployment Workflow (MANDATORY)
All changes must follow this exact sequence — NO exceptions:
1. Make changes in LOCAL code
2. `git add` + `git commit` + `git push`
3. **Hand the deploy command to the user.** Do NOT run it yourself.
4. Wait for the user to ping back when the deploy is done.
5. After deploy: read-only verification (logs, SQL, curl health) — Claude can run these.

### Deploys are user-run. Never run them yourself.

After `git push`, **STOP**. Do not SSH to the server to run `git pull`, `npm install`, `npm run build`, `npm run migrate`, `pm2 restart`, or any other deploy/build/restart command. Hand the user the exact bare shell command(s) and wait for them to confirm.

**Why:** the user always has SSH open already; running deploys yourself causes duplicate sessions, racy concurrent restarts, surprise mid-flight changes, and burns tokens on multi-minute builds. The user has explicitly flagged this as a hard rule.

**How to apply:**
- After `git push`, end your turn with: `Pushed <hash>. Run on the server: <exact bare command>. Ping me when it's done.`
- Bare commands only — no `ssh -i ... root@... "..."` wrapper. The user is already SSHed in.
- Reading logs, running SQL, hitting health endpoints **after** the user confirms the deploy is fine — that's read-only verification.
- Building, migrating, or restarting services is a deploy — never Claude's job.
- Never schedule wake-ups or sleep waiting for a deploy to finish.

**NEVER modify files directly on the server.** SSH is for READ-ONLY operations only: checking logs, querying DB, testing endpoints.

NEVER: `pm2 delete`, `pm2 start` for infrastructure services, editing server files with sed/echo, creating scripts on the server.

## Pipeline Testing (Stage-by-Stage)
When debugging pipelines:
1. Trigger ONE stage at a time (use `current_stage` in DB + `resume=true`)
2. Check output in logs and DB
3. If wrong — fix in LOCAL code — commit — push — deploy — retry SAME stage
4. If correct — move to next stage
5. Repeat until all stages pass

## Code Changes
- When restructuring/refactoring: COPY-PASTE original code exactly, only change imports/exports. Never rewrite from memory.
- **NEVER truncate text or content** — not in UI, not in API responses, not in processing. Always show full text, chunk if needed for LLM processing, but never slice/trim content for display. If text is long, use expandable sections or scrollable containers — never cut it.
- **ALL table columns MUST be sortable.** Every `<table>` in the UI must use the `useSortable` hook + `SortableTh` (or `SortableTable` wrapper for server components). No plain `<th>` elements in data tables — every column header must be clickable to sort asc/desc. This applies to new tables and any table being modified.
- Max prompt size to LLM: ~10,000 chars. If content is larger, chunk it or use search/windowed retrieval.
- QA/review stages must check the ENTIRE document by chunking, never by slicing first N chars.

## SSH Access
- MedicalCopywriting VPS: `ssh -i ~/.ssh/id_ed25519_xyster3k root@185.250.36.47`
- LongevitySearch VPS: `ssh -i ~/.ssh/id_ed25519_xyster3k root@65.21.149.194`

## Follow Through — Never Drop Requirements

When the user gives you a list of requirements or answers to your questions, **record every single point** using TodoWrite and **track each one to completion**. Do NOT forget, skip, or half-implement any requirement — even if the task is long and complex.

- **Before starting work:** re-read the user's original request and all their answers. Make sure every point is captured in your task list.
- **During work:** after completing each sub-task, check back against the original requirements. Ask yourself: "Did I miss anything the user asked for?"
- **Before reporting done:** go through the original request point by point and verify each one is implemented. If something was skipped, do it now — don't report it as "out of scope" unless the user explicitly said to skip it.
- **Common failure mode:** the user asks for 3 things, you get deep into #1, and by the time you finish #2 you've forgotten #3. The TodoWrite tool exists to prevent this. Use it.
- **If the user corrects you** (e.g., "other teams should NOT see strategies"), that correction applies to ALL similar cases in the codebase, not just the one file you were editing. Think: "Where else does this same pattern exist?"

## Working Style — Clarify Before You Code

Before doing any non-trivial implementation work, **stop and ask clarifying questions** instead of guessing. Wrong assumptions waste hours; questions cost minutes.

### When to ask
Ask before starting if ANY of these are true:
- The task touches >1 file or >1 layer (DB, API, UI, pipeline)
- There's a design choice with multiple reasonable answers (where the toggle lives, what the default is, what the precedence is, what naming to use)
- The user said "do X" but X has implicit sub-decisions they probably haven't thought through
- You'd need to delete/rewrite existing code and aren't sure what depends on it
- The task uses a vague word like "add", "fix", "improve", "make it work" without naming the exact behavior change
- The task touches data the user cares about (DB schemas, migrations, file deletion, anything irreversible)

Skip the questions only when the task is genuinely trivial (one file, one obvious change, no design choice).

### How to ask
- **Number the questions.** Multi-question messages with bullets get half-answered. Numbered lists get fully answered.
- **For each question, list concrete options (a/b/c) with the trade-offs.** Don't ask "what should X do?" — ask "should X do (a) thing-with-this-trade-off, (b) other-thing-with-other-trade-off, or (c) third-option?"
- **State your default recommendation** for each question and the reason. Most users will accept the default; explicit defaults turn long questionnaires into one-line confirmations.
- **Group questions by area.** Schema questions together, UI questions together, pipeline questions together.
- **Don't ask about things you can verify yourself.** Read the code first, then ask only the questions the code can't answer.
- **One round of questions, not death-by-thousand-prompts.** Get everything you need in a single message. If the user's answers reveal a new question, that's fine — but don't drip-feed.

### After answers
- Summarize what you understood in 2-4 lines: "Locking in: X, Y, Z. Starting work."
- Use TodoWrite to track the steps.
- Then execute. Don't re-ask things you already got answers to.

### If the user pushes back ("just do it", "stop asking", "I trust your judgment")
- Stop asking. Pick the recommended defaults. Note the assumptions in 1-2 lines, then start work.
- If you hit a question mid-implementation that genuinely blocks you, ask THAT one — but make it clear it's blocking, not optional.

### Investigate before you fix
When the user reports a bug or asks "what went wrong":
1. **Read the actual logs/code/data first.** Don't theorize from the description.
2. **Quote the exact evidence** (file:line, log line, DB row) when explaining what you found.
3. **Distinguish "what broke" from "why".** Both matter; conflating them produces vague fixes.
4. **Identify root cause, not symptom.** If a stage fails because of a downstream stage, fix the downstream stage.

### Communication during long work
- Mark obvious cosmetic issues as "cosmetic, fix later" instead of stopping to fix them mid-task.
- When something pre-existing is broken (not introduced by current work), call it out as **"pre-existing, separate bug"** and don't auto-fix unless asked.
- Surface bugs you find but don't have permission to fix — list them at the end of the task summary so the user can decide.

### Reporting
At the end of multi-step work, report in this structure:
1. **What changed** — files touched, grouped by layer
2. **Build/typecheck status**
3. **Deploy steps** (exact commands)
4. **How to test**
5. **What I did NOT do** — explicit list of related work that was out of scope, so the user knows nothing slipped through
6. **Issues found** — pre-existing bugs surfaced, unresolved questions, things that need a follow-up

This format prevents the user from having to re-discover what you skipped.

## Project aliases

When the user refers to a project by a short alias, resolve it to the absolute path below before doing any work. Do not guess; if a name they use isn't on this list, ask.

- **"Catalogue" / "Catalogue project" / "Solutions catalogue"** — `/home/node/projects/Solutions-catalogue`
  - Format: `blueprints/<slug>.md` for full self-contained system guides; `snippets/<slug>.md` for focused single-pattern reference pages; `projects/<slug>.md` for project-level overviews. The README.md table at the root must be updated whenever a new blueprint/snippet/project is added so the index stays current.
  - When the user asks to "save in the Catalogue", "write up to the Catalogue", "add this as a blueprint", etc., they mean adding a `.md` file under this repo with the full source code + lessons + pitfalls baked in, then linking it from the README.
