---
name: handoff-check
description: Confirm a fresh conversation could pick this project up from the documents alone — the procedure is in the body. Run it when the user says "check the project docs so it can be handed over" or "are we handover-ready?", or when a stretch of work ends and you want the handoff proven rather than assumed.
---

# handoff-check — handover readiness checkpoint

What it is for: not tied to any particular feature — a way to confirm **at any moment** that a new session could pick this project up seamlessly.

**Thin-shell principle**: this skill only does a fast self-check in the main session plus delegation. It never copies checklists out of other skills or project documents, because a copy is a new source of drift.

**Step 0**: read `CLAUDE.md` at the project root (or the equivalent entry document) to find where the handover entry point and the record mechanism live. If the project has a **more specialised** skill for document sync or handover regression (check the reference in the entry document), delegate that step to it rather than redoing it with this file's generic default.

## 1. Self-check for loose ends (main session, seconds)

- `git status`: uncommitted or unpushed work means dealing with that first (commit in batches per `/wrap-up`'s conventions).
- If the project has a health-check command, run it. It **must come back clean**; fix it before going further.
- **Does the record match reality?** Everything this session did — is it in the project's source of truth? Task statuses advanced? Settled decisions recorded? Pitfalls written down? Anything missing gets **recorded right now**, using the project's own record mechanism.
- **Spot-check the claims**: verifiable facts in the documents (counts, lists, commands) should match reality. If the project has a list of what to check against, follow it item by item — numbers hard-coded in prose are the usual drift point.

## 2. Substantial document changes -> delegate to `/adversarial-review` (skip if none)

If this round wrote a new document or rewrote a whole section, send a fresh-context agent to check it against reality item by item. Skip for small edits.

## 3. Cold-read acceptance (the heart of this skill)

- Send a **read-only** fresh-context agent that may start only from the project entry point (`CLAUDE.md` and the handover documents it points to) and must answer three questions — **where are we / what is next / how was the previous step verified** — and report anything unreadable, any broken link and any contradiction.
- The main session judges the answers **against reality**. A wrong answer, or no answer, means the handover path is broken somewhere.
- **Verification is not self-verification**: judge against reality and the pass criteria, not against how the agent phrased things.

## 4. Close out

- Fix each break the cold read reported. The usual ones: broken links, stale claims, counts in prose that have drifted, and formatting that truncates the latest record.
- Write the outcome into the project's record afterwards, or go straight into `/wrap-up` to close the session (commit and push).

## Cost

The cold-read agent is the expensive step here. Do not run it again when it just ran and nothing has changed since; when you only want a quick self-check, do step 1 alone.
