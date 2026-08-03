# Collaboration module — @PROJECT_NAME@

> This file exists because the **collaboration** module is enabled for this workspace. It is engine-shipped material: the main contract is in [01-nextup-guide.md](../01-nextup-guide.md), and this file only covers what the module adds. Disabling the module in the app leaves this file in place — it simply stops applying.

Parallel work by several humans and agents: identity, claiming, dependency waves.

## Identity

**Self-declared**: start nextup-mcp with `--agent <name>` or the `NEXTUP_AGENT` environment variable and it carries an identity; ledger events gain an `actor` field. Identity is **for auditing and claim semantics only, not authorisation** — authorisation remains one `agent_access.json` for the whole workspace and does not vary by name.

## Claim versus assign

`claim_task` registers you as the assignee and **cannot steal** — if someone else already holds it the call fails with kind `already_claimed` and carries `currentAssignee`, so you immediately know who to coordinate with.

`assign_task` is a dispatching action (a human or an orchestrator); it may override an existing claim or clear the assignment (**omitting `assignee` unassigns**), and every handover lands in the ledger.

If you cannot claim a task, do not use `assign_task` to put yourself on it — that is the dispatcher's move, not the executor's.

## Dependencies and waves

A task cannot start or complete until every entry in `dependsOn` is `done` (main guide §2). When blocked, the error kind is `dependencies_unmet` and carries `blockingTasks[]` (each `{id, status}`) — decide which task to wait on from the fields, without parsing the message.

When planning parallel work, make tasks within a wave independent of each other and dependent only on the previous wave. When a dependency blocks you, look at that task's status first rather than routing around the check.

## Where source-level parallelism ends

The Agent NextUp mutex only guarantees consistency for `.nextup` and task state. **Conflicts in source files are not its concern.** The convention for several agents editing code at once: one git worktree or branch each, `NEXTUP_AGENT` set in each environment, integration through git merge, and conflict resolution is git's job.

## Tools and headless fallback

`claim_task` and `assign_task` appear in the tool list only while this module is on (enabling it mid-session requires reconnecting MCP before they show up; disabling it mid-session makes calls fail with an error pointing at the switch).

Headless fallback: the field semantics in the main guide §2 can be edited by hand, but the engine's anti-collision and dependency gatekeeping only apply on the tool and app paths — so honour the same rules yourself, and append a `task_assignee_changed` ledger line.
