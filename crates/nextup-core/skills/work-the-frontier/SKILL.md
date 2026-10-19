---
name: work-the-frontier
description: Build every ready task in parallel — implementer sub-agents on the dependency frontier, each in its own worktree, merged onto one integration branch.
disable-model-invocation: true
---

# work-the-frontier — the task graph, built in parallel

Goal: every task in the graph done on one integration branch, reviewed, and handed to the human to verify — with as many independent tasks in flight at once as the graph allows.

**Before starting**, check three things and stop with a plain explanation if any fails:

- the work is already sliced into tasks with `dependsOn` (if not, call the Skill tool with `slice-work` first);
- this is a git repository;
- your host can run sub-agents in the background, each in its own worktree.

**You are the coordinator.** Sub-agents you start share this session's connection to the hub, so they cannot claim tasks from each other — you decide who builds what, and **you alone change task status**, through the hub, in this main checkout. Implementers only write code (and spec deltas) on their branches.

Claims keep *other* sessions off the tasks you hand out, but only when `claim_task` is in your tool list **and** this session declared an identity. Without both, nothing stops another session from picking the same task: say so to the user before you start.

The hub reads the files in this main checkout, not in the worktrees. A spec delta an implementer writes is invisible to `validate_task_specs` until its branch is merged here — so check deltas after merging, never before.

Keep messages to and from sub-agents short: point at the task, the notes and the commits; never restate what a pointer already reaches.

## Steps

1. **Read the graph**: `list_tasks` for everything, `list_tasks { ready: true }` for the frontier — todo, every dependency done, nobody assigned.
2. **Create the integration branch** from the current branch and check it out here, in the main checkout — merges land where the hub can see them.
3. **Optional — explore once**: when the tasks need the same digging (unfamiliar code, third-party docs), send one exploration sub-agent first and have it write its notes to a scratch directory outside the repository, where every implementer can read them.
4. **Dispatch the frontier.** For each ready task: claim it when you can (see above), mark it `in_progress`, and start an implementer sub-agent in its own worktree, on its own branch cut from the integration branch. Its brief: the task id (it reads the task with `get_task`), the notes directory, "build it test-first — call the Skill tool with `test-first`", "if it changes behaviour, write its spec delta under `tasks/<id>/specs/` on your branch", "leave task status alone", and "merge the integration branch tip into your branch before you report". Its report: the branch, the command that runs its tests, and their result.
5. **On each report**: run its test command yourself on its branch — a sub-agent's word is a claim. Merge it into the integration branch, call `validate_task_specs` for the task when that tool is in your list, mark the task `done`, and read the frontier again: anything that just became ready is dispatched now, not after the rest finish.
6. **When every task is done**: call the Skill tool with `two-axis-review` on the integration branch, then fix all its findings with one implementer sub-agent.
7. **Hand over**: report the integration branch, the tasks it closes, and the evidence for each. The tasks are done, not verified — verification is the human's.
8. **Clean up** every worktree you created.

---

Adapted from `implement-spec` in [mattpocock/skills](https://github.com/mattpocock/skills), and rewired to Agent NextUp's engine. The original is distributed under this licence:

> MIT License
>
> Copyright (c) 2026 Matt Pocock
>
> Permission is hereby granted, free of charge, to any person obtaining a copy
> of this software and associated documentation files (the "Software"), to deal
> in the Software without restriction, including without limitation the rights
> to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
> copies of the Software, and to permit persons to whom the Software is
> furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in all
> copies or substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
> IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
> FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
> AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
> LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
> OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
> SOFTWARE.
