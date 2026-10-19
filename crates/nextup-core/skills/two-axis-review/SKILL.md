---
name: two-axis-review
description: Review finished work on two separate axes — the project's conventions, and what the task actually asked for — with one fresh reviewer per axis and the two reports kept apart. Use before a task is verified, in a Verify phase, or when asked to review a branch or a set of changes.
---

# two-axis-review — conventions and spec, never merged

Goal: two independent reports on the same change — does it follow how this project writes code, and does it do what the task asked — each finding citing its source, so neither axis can hide a failure on the other.

## 1. Pin the change

Take the fixed point the work started from (a commit, a branch, the merge base with the main branch; ask if it is not obvious). Capture `git diff <fixed-point>...HEAD` and the commit list once. Confirm the reference resolves and the diff is not empty before going further.

## 2. Find the spec source

- The tasks this change implements: ids in the commit messages, the task you were working, or the one named in the request. Read each with `get_task` — the description says what it delivers and how anyone will know it works.
- With the spec module on: each task's delta under `tasks/<id>/specs/`, and the current spec it modifies (`get_spec`).
- Nothing found: ask. If there truly is no spec, the spec axis reports exactly that.

## 3. Find the standards source

Every document in the project that says how code here is written — a coding-standards file, `CONTRIBUTING.md`, the conventions section of the project docs — plus the lint and format configuration. On top of those, the conventions axis always carries this baseline of code smells. Each one is a judgement call, never a hard violation, and a documented project rule overrides it:

- **Mysterious name** → rename until it says what it holds.
- **Duplicated code** → extract the shared shape.
- **Feature envy** → move the logic onto the data it keeps reaching for.
- **Data clump** → the fields that travel together want a type.
- **Primitive obsession** → a domain concept deserves its own small type.
- **Repeated switch** → one map or one polymorphic call both sites share.
- **Shotgun surgery** → what changes together belongs together.
- **Divergent change** → one module, one reason to change.
- **Speculative generality** → delete hooks the task never asked for.
- **Message chain** → hide the walk behind one call.
- **Middle man** → call the real target directly.
- **Refused bequest** → composition instead of inheritance.

Skip anything a tool already enforces.

## 4. Run the two reviewers in parallel

Send each axis to its own fresh reviewer — a sub-agent if your host has them, otherwise two separate passes that do not read each other's notes.

- **Conventions reviewer** gets the diff command, the commit list, the standards documents and the smell baseline in full. Brief: "For each hunk where it applies, report every breach of a documented rule (cite the file and rule) and any baseline smell (name it, quote the hunk). Separate hard breaches from judgement calls. Under 400 words."
- **Spec reviewer** gets the diff command, the commit list and the spec sources. Brief: "Report what the spec asked for that is missing or partial, what the diff does that nobody asked for, and what looks implemented but behaves wrong. Quote the spec line for each finding. Under 400 words."

## 5. Report side by side

Two headings, Conventions and Spec, each report as it came back. Keep the axes apart: no merging, no single ranking across them. End with one line per axis — how many findings, and the worst one.

## 6. Hand off

Fix the findings, or open a task for any that will not fit now. A spec axis that came back clean is evidence: record it, with the fixed point and the tasks it covered, where the verifier will read it. Marking a task verified stays with whoever holds that permission — usually the human.

---

Adapted from `code-review` in [mattpocock/skills](https://github.com/mattpocock/skills), and rewired to Agent NextUp's engine. The original is distributed under this licence:

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
