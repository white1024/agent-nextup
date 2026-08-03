# Spec module — @PROJECT_NAME@

> This file exists because the **spec** module is enabled for this workspace. It is engine-shipped material: the main contract is in [01-nextup-guide.md](../01-nextup-guide.md), and this file only covers what the module adds. Disabling the module in the app leaves this file in place — it simply stops applying.

The current-behaviour spec layer.

## The split

The ledger records **why** (the timeline), `specs/` records **what** (the present). One file per capability at `specs/<capability>/spec.md`, describing how the system behaves **now**.

A spec states the present, not a wish — wishes and motivation belong in the task artifact's `proposal.md`. A task that changes behaviour writes the difference as a **delta**, and the engine folds it into the main spec when the task is archived, which is what keeps `specs/` equal to the sum of completed work.

## Format (OpenSpec-compatible, plain Markdown)

A requirement's identity is `### Requirement: Title`, compared **exactly** after trimming — typos are not forgiven, and near-miss names are refused outright to prevent a silent missed fold. A scenario is `#### Scenario: Name` with **exactly four `#`** (three or five vanish silently). Statements carry SHALL or MUST wording (必須 is accepted, for workspaces written in Chinese).

## The delta

It lives at `tasks/<task-id>/specs/<capability>/spec.md` — write it directly with your own file tools — in four sections:

- `## ADDED Requirements` — the new requirement in full
- `## MODIFIED Requirements` — **rewrite the whole block, this is not a diff**; read the current state with `get_spec` first and preserve every existing scenario; dropping any one of them means the fold is refused
- `## REMOVED Requirements` — the title plus `**Reason**:`
- `## RENAMED Requirements` — paired `- FROM:` and `- TO:`; if the content changes too, write that separately under MODIFIED using the **new** title

**A delta that creates a capability should carry `## Purpose`** — one or two sentences on what the capability is for. Write it: the fold that creates the file is the moment it is cheap, and a capability created without one opens on the placeholder `TBD — fill in after the first fold.`, which is what the workspace's own source of truth then shows every reader. A later delta may fill that placeholder, but only while it is still the placeholder; once a real Purpose exists, a delta's Purpose is ignored and logged as a warning (rewriting the standing description of a capability is a human's edit, not a fold's).

## The flow

Write the artifacts (proposal and design as free prose, which the engine does not parse) → implement → **check yourself with `validate_task_specs`** (a dry-run; the conflicts it reports are the same ones that will refuse you at archive time) → mark `done` → the user verifies → archiving folds it in (the engine does this, leaving a `spec_folded` ledger trace).

**Folding is the engine's job — do not edit the main spec yourself to "keep it in sync".** If a human edited the main spec first that is fine too; the engine treats an already-synced edit as a no-op.

**Where your reach ends: the delta.** Writing it is the whole of your job here, and nothing you do will change `specs/` — folding is triggered by archiving, archiving follows the user's verification, and neither is a tool you hold. (`specs/` can still change *around* you: a human may archive a task, or the app's auto-archive sweep may fold one when the workspace is opened. Re-read with `get_spec` rather than assuming it is as you last saw it.) So a session that finishes its delta and reports "the delta is written and ready to fold" has finished; do not go looking for a way to make `specs/` reflect it, and do not edit the main spec by hand to close the gap. `validate_task_specs` is how you confirm the delta will fold cleanly when the time comes — that is the strongest statement available to you, and it is enough.

When a fold is refused for conflicts: fix the delta (comparing against the current state with `get_spec` where needed) and ask the user to archive again. `workspace_doctor` lists every task that will not fold and why.
