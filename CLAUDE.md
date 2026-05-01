# Global Development Rules

## When something repeats or keeps failing — STOP and diagnose

If the same thing breaks twice (process dies, import fails, deploy doesn't pick up change, test fails after a fix), do NOT just retry the same fix. That's how you burn hours.

First question: "Is the code on the server actually NEW, or still OLD?" Check this BEFORE any other debugging:

- ssh ... "cd /path && git log -1 --oneline" — what commit is on server?
- Compare to local: git log -1 --oneline
- If they differ, the server is running old code. Everything else is noise until that's fixed.
- Also check: was npm install run? Was npm run build run? Was the process restarted after pull?

Second question: what actually killed the previous attempt?

- Read the last 50 lines of logs
- Check for unhandled promise rejections, OOM kills, network timeouts, rate-limit responses
- Don't assume "terminal closed" without evidence — nohup survives that
- Check dmesg, journalctl, and the app's own stderr log

Third: find the ROOT cause, not the symptom.

- "Process died" is a symptom, not a cause
- "API returned 429, we don't handle it, so Node crashed" is a cause
- Fix the cause (add retry/backoff) not the symptom (just restart)

Only after those three steps should you retry. Otherwise you're in a loop.

## Deployment Workflow (MANDATORY)

All changes must follow this exact sequence — NO exceptions:

- Make changes in LOCAL code
- git add + git commit + git push
- On server: git pull && npm run build && pm2 restart <service>
- Verify via logs

NEVER modify files directly on the server. SSH is for READ-ONLY operations only: checking logs, querying DB, testing endpoints.

The ONLY allowed pm2 commands after deploy:

- pm2 restart medcopyai
- pm2 restart pipeline-worker

NEVER: pm2 delete, pm2 start for infrastructure services, editing server files with sed/echo, creating scripts on the server.

## Pipeline Testing (Stage-by-Stage)

When debugging pipelines:

- Trigger ONE stage at a time (use current_stage in DB + resume=true)
- Check output in logs and DB
- If wrong → fix in LOCAL code → commit → push → deploy → retry SAME stage
- If correct → move to next stage
- Repeat until all stages pass

## Code Changes

- When restructuring/refactoring: COPY-PASTE original code exactly, only change imports/exports. Never rewrite from memory.
- NEVER truncate text or content — not in UI, not in API responses, not in processing. Always show full text, chunk if needed for LLM processing, but never slice/trim content for display. If text is long, use expandable sections or scrollable containers — never cut it.
- ALL table columns MUST be sortable. Every `<table>` in the UI must use the useSortable hook + SortableTh (or SortableTable wrapper for server components). No plain `<th>` elements in data tables — every column header must be clickable to sort asc/desc. This applies to new tables and any table being modified.
- Max prompt size to LLM: ~10,000 chars. If content is larger, chunk it or use search/windowed retrieval.
- QA/review stages must check the ENTIRE document by chunking, never by slicing first N chars.

## SSH Access

- MedicalCopywriting VPS: ssh -i ~/.ssh/id_ed25519_xyster3k root@185.250.36.47
- LongevitySearch VPS: ssh -i ~/.ssh/id_ed25519_xyster3k root@65.21.149.194

## Follow Through — Never Drop Requirements

When the user gives you a list of requirements or answers to your questions, record every single point using TodoWrite and track each one to completion. Do NOT forget, skip, or half-implement any requirement — even if the task is long and complex.

- Before starting work: re-read the user's original request and all their answers. Make sure every point is captured in your task list.
- During work: after completing each sub-task, check back against the original requirements. Ask yourself: "Did I miss anything the user asked for?"
- Before reporting done: go through the original request point by point and verify each one is implemented. If something was skipped, do it now — don't report it as "out of scope" unless the user explicitly said to skip it.
- Common failure mode: the user asks for 3 things, you get deep into #1, and by the time you finish #2 you've forgotten #3. The TodoWrite tool exists to prevent this. Use it.
- If the user corrects you (e.g., "other teams should NOT see strategies"), that correction applies to ALL similar cases in the codebase, not just the one file you were editing. Think: "Where else does this same pattern exist?"

## Working Style — Clarify Before You Code

Before doing any non-trivial implementation work, stop and ask clarifying questions instead of guessing. Wrong assumptions waste hours; questions cost minutes.

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

- Number the questions. Multi-question messages with bullets get half-answered. Numbered lists get fully answered.
- For each question, list concrete options (a/b/c) with the trade-offs. Don't ask "what should X do?" — ask "should X do (a) thing-with-this-trade-off, (b) other-thing-with-other-trade-off, or (c) third-option?"
- State your default recommendation for each question and the reason. Most users will accept the default; explicit defaults turn long questionnaires into one-line confirmations.
- Group questions by area. Schema questions together, UI questions together, pipeline questions together.
- Don't ask about things you can verify yourself. Read the code first, then ask only the questions the code can't answer.
- One round of questions, not death-by-thousand-prompts. Get everything you need in a single message. If the user's answers reveal a new question, that's fine — but don't drip-feed.

### After answers

- Summarize what you understood in 2-4 lines: "Locking in: X, Y, Z. Starting work."
- Use TodoWrite to track the steps.
- Then execute. Don't re-ask things you already got answers to.

### If the user pushes back ("just do it", "stop asking", "I trust your judgment")

- Stop asking. Pick the recommended defaults. Note the assumptions in 1-2 lines, then start work.
- If you hit a question mid-implementation that genuinely blocks you, ask THAT one — but make it clear it's blocking, not optional.

## Investigate before you fix

When the user reports a bug or asks "what went wrong":

- Read the actual logs/code/data first. Don't theorize from the description.
- Quote the exact evidence (file:line, log line, DB row) when explaining what you found.
- Distinguish "what broke" from "why". Both matter; conflating them produces vague fixes.
- Identify root cause, not symptom. If a stage fails because of a downstream stage, fix the downstream stage.

## Communication during long work

- Mark obvious cosmetic issues as "cosmetic, fix later" instead of stopping to fix them mid-task.
- When something pre-existing is broken (not introduced by current work), call it out as "pre-existing, separate bug" and don't auto-fix unless asked.
- Surface bugs you find but don't have permission to fix — list them at the end of the task summary so the user can decide.

## Reporting

At the end of multi-step work, report in this structure:

- **What changed** — files touched, grouped by layer
- **Build/typecheck status**
- **Deploy steps** (exact commands)
- **How to test**
- **What I did NOT do** — explicit list of related work that was out of scope, so the user knows nothing slipped through
- **Issues found** — pre-existing bugs surfaced, unresolved questions, things that need a follow-up

This format prevents the user from having to re-discover what you skipped.
