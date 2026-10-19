---
name: slice-work
description: Break agreed work into tasks the engine can schedule — vertical slices, each declaring what must land before it. Use right after a scope is settled, when a plan or spec needs turning into tasks, or when one task has grown too big for a session.
---

# slice-work — turn agreed scope into schedulable tasks

Goal: the work exists as tasks in this workspace, each one a slice that can be finished in one session and shown working on its own, with `dependsOn` naming exactly what must land first — so "Next steps" and `list_tasks { ready: true }` always point at something that can actually start.

Start from a settled scope. If what "done" means is still open, settle it first: call the Skill tool with `align-scope`.

## 1. Read what is already there

- The open tasks (`list_tasks`) and the recent decisions, so new tasks neither duplicate nor contradict them.
- The project's vocabulary — `GLOSSARY.md` at the project root if there is one, otherwise the vocabulary files in memory — and use its words in every title.
- With the spec module on (`validate_task_specs` is in your tool list): the current specs of the capabilities this work touches (`list_specs`, `get_spec`).

Done when you can name every existing task this work touches.

## 2. Draft the slices

- **Vertical, not horizontal.** Each task cuts a narrow path through every layer it needs and can be shown working on its own. "A user can export one report as CSV" is a slice; "write the export backend" is a layer.
- **One session each.** A slice that will not fit gets cut again.
- **Prefactor first.** When the existing structure makes the change awkward, the clean-up is its own task and the feature depends on it.
- **Expand → migrate → contract** for a mechanical change that reaches across the whole project (a rename, a reshaped shared type): add the new form beside the old, move callers over in batches small enough that each stays green, remove the old form last — chained with `dependsOn`.
- For each task write a title naming what it delivers, a description saying what it delivers end to end and how anyone will know it works, and its blockers: only the tasks that genuinely gate it. Describe behaviour rather than files — the files shift as the work does.

Done when every agreed outcome is covered by at least one task and every blocker points at a task in the draft or already in the store.

## 3. Check the breakdown with the human

Show the draft as a numbered list — title, blocked by, what it delivers — and ask in one round, each question with your recommended answer: is the granularity right; does each task depend only on what truly gates it; should any be merged or split. Revise until they agree.

## 4. Create them

- Create the tasks blockers-first with `create_task`, so each `dependsOn` names a real id. Without the hub tools, follow the task file format in the guide (§2).
- With the spec module on, note in each behaviour-changing task that it owes a spec delta; the delta itself is written when the task is done.
- Record why the work is sliced this way with `record_decision`, and any slice you consciously left out with `record_rejected`.

Done when `list_tasks { ready: true }` returns exactly the first wave, minus any task you created with an `assignee` — that one is already dispatched, so `ready` leaves it out on purpose.

---

Adapted from `to-spec` and `to-tickets` in [mattpocock/skills](https://github.com/mattpocock/skills), and rewired to Agent NextUp's engine. The original is distributed under this licence:

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
