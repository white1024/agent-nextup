---
name: retrospect
description: Look back over a stretch of work and turn what went wrong into changes that steer the next session — automated checks first, then lessons, boundaries and pruned instructions, each backed by ledger evidence. Use in a Retrospect or Reflect phase, after a session that went sideways, or when the user asks what should change.
---

# retrospect — improve the ground the next session stands on

Goal: every friction this stretch of work hit lands in exactly one destination that changes what the next session does — and the mechanical ones land as checks, not sentences.

## 1. Gather the evidence

- Call `post_mortem_candidates` first. It derives candidates from hard ledger signals — overrides, blocked tasks, failed tool calls, refused calls — with the evidence attached. These are the floor: every one of them gets a verdict.
- Then read the rest of the stretch: recent ledger entries, tasks that were reopened or blocked, superseded decisions, and the conversation if you are still in it.
- Read what agents here actually load: AGENTS.md outside the engine's block, the module guides in `nextup_docs/modules/`, memory, and `lessons` in `.nextup/rules.json`.
- Answer the project's own retrospective questions as you go — `flywheel.postMortemPrompts` in `.nextup/rules.json`.

Done when every candidate from the first call carries a note of what actually happened, and every prompt has an answer.

## 2. Classify each finding

Ask these in order; the first yes decides the destination.

1. **Could a machine have caught it?** A wrong command, a broken link, a forbidden pattern, a value out of range, a file in the wrong place. The fix is a check — a test, a lint rule, a hook, a CI step. Look for the project's own check commands first: one that exists but is not wired in, or passes without checking anything, is itself the finding. A project with no automated check at all is a finding too.
2. **Was the information out of reach?** A log nobody could see, a server's output, a document the agent never found. The fix is access, or a pointer: one line in the right steering file naming where to look.
3. **Was it a judgement call that went the wrong way?** A lesson — an actionable rule for next time.
4. **Was a line crossed that must never be crossed?** A boundary.
5. **Was an approach tried and rightly dropped?** A rejection, so nobody proposes it again.
6. **Was a tool call slow or wasteful?** A lesson or a pointer naming the cheaper route.

Then scan the steering files for instructions that change nothing when removed: each one costs attention on every read.

Done when every finding has exactly one destination.

## 3. Present, most severe first

Order by the damage a repeat would do. For each: what happened (with its ledger timestamp), the destination, and the concrete change. The human cuts and reorders. Changes to AGENTS.md or the project's own docs, and removals of anything, wait for their yes (guide §14).

## 4. Apply

- **Checks**: build them, or open a task for each one too big for now (`create_task`).
- **Lessons**: `record_lesson` with `evidence`, the array of ledger `at` timestamps that justify it. A lesson that cites nothing is an opinion.
- **Boundaries**: hand the human the exact wording to add in the app's project settings — there is deliberately no tool for it.
- **Rejections**: `record_rejected`, the reason saying what was learned.
- **Pitfalls**: one memory file each.
- **Pruning**: memory is yours to prune; everything else only with the human's yes.

Done when each accepted change is on disk and you can name the file — or the task — that holds it.

---

Adapted from `retro` in [mattpocock/skills](https://github.com/mattpocock/skills), and rewired to Agent NextUp's engine. The original is distributed under this licence:

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
