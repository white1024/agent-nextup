---
name: wrap-up
description: Close out a session so the next one can pick it up cold — the steps are in the body. Run it before every session ends, and whenever the user says "wrap up", "that's it for today", or asks you to finish up.
---

# wrap-up — closing a session

Goal: the next session should be able to pick up seamlessly by reading nothing more than the project's entry point (`CLAUDE.md` and whatever it points at).

**Step 0**: read `CLAUDE.md` at the project root (or the equivalent entry document) and work out what each step below means *in this project* — the commit conventions, the health-check command, where progress and decisions are recorded. Where the entry document says nothing, fall back to the generic default in each step. Then run through them in order:

## 1. Take stock of the working tree and commit

- Survey with `git status`. If there are uncommitted changes, commit them in batches **by logical sub-task** rather than all at once.
- A message is **motivation (why) plus technical reasoning (how)**, not a list of files. Where the project has its own commit conventions — message format, sign-off, environment traps — follow those.

## 2. Health check

If the project has a health-check command (doctor, lint, tests — check the entry document or the development docs), run it. It **must come back clean**; fix it before wrapping up if it does not.

## 3. Take stock of verification (be honest)

Sort everything this session claims to have finished:

- **Verified**: with evidence — what you ran, what you saw (tests green, real output).
- **Unverified**: with the method — who could verify it and by what steps (for example the parts needing manual GUI operation).
- Anything you are unsure about counts as unverified. Do not fake it.

## 4. Write back into the project's record

Add this session's progress, the decisions that were settled and the pitfalls you hit to **the project's own record mechanism** (a progress log, a decision record, memory, task state — whichever exists). Where the project provides tools for recording, use the tools rather than editing files by hand.

The discipline: **every fact goes into its own source of truth and is not copied to a second place** — in particular, do not push current state or decisions back into an index or entry file such as `CLAUDE.md`.

After writing, follow whatever **maintenance rules the record file states in its own header** (retention window, rolling archive, compaction — only if the header says so; skip it otherwise): keep hot data in the main file and move entries that fall outside the retention window into the archive **whole**, so the takeover entry point stays light.

**Done means**: for every fact this session settled, you can name the file and the line that now holds it. If you cannot point at one, it is not recorded — writing "discussed X" in a chat reply is not a record. Check the same way you would check a commit: re-read what you just wrote, not what you meant to write.

## 5. Push and confirm

- `git push`, then `git log @{u}..HEAD --oneline` should be empty (nothing left unpushed).
- If the project has no remote, or the user has never established a push convention with you on this project, ask once before pushing.

## 6. Report

The closing message: the list of commits from this session (hash plus one line each), the verified/unverified table, and where the next session should pick up.
