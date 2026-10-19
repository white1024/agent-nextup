---
name: test-first
description: Build behaviour test-first, one red–green slice at a time, at seams agreed before the first test. Use when implementing a coding task, when fixing a bug whose symptom can be reproduced, or when the user mentions TDD, red-green or test-first.
---

# test-first — red, then green, one slice at a time

Goal: every behaviour this task adds is pinned by a test that was seen failing first, at a seam that survives the internals being rewritten.

Read the task before writing anything: its description says what it delivers and how anyone will know it works. That "how" is your first test.

## 1. Agree the seams

A **seam** is a public boundary where behaviour can be observed without reaching inside — a function's interface, an endpoint, a command's output. Tests live at seams.

- Propose the seams for this task. Prefer ones that already exist, and the highest one that still exercises the behaviour; fewer is better.
- Give each a line on what a test there catches and what it misses.
- Confirm them with the human before the first test is written.

Done when the seams are agreed.

## 2. Loop: one slice per cycle

1. **Red**: write one test for the next piece of behaviour, run it, and watch it fail for the reason you expect. A test that has never failed has never proved anything. If you forced the red by changing code or a fixture, compare against the untouched copy to prove the change landed before you trust the red.
2. **Green**: write only enough code to pass it. Run that test file and the type checker.
3. Take the next slice. Each test answers what the last cycle taught you — tracer bullets, not a batch written up front.

Run the full suite once at the end.

## 3. What makes a test worth keeping

- **Through the interface**: it calls what a caller calls and asserts what a caller sees, so it keeps passing when the internals are rewritten.
- **Independent expected values**: a known literal, a worked example, the spec — never a value recomputed the way the code computes it.
- **Mocks only at system boundaries**: external services, time, randomness. Your own modules run for real.
- **Named for the capability**: "a user can export a report as CSV", rather than the function it happens to call.

Refactoring belongs to review, once the suite is green.

## 4. Finish

Mark the task done when the full suite is green, and record the evidence where the verifier will read it: the test that failed before and passes now, by name, and the command that runs it.

---

Adapted from `tdd` in [mattpocock/skills](https://github.com/mattpocock/skills), and rewired to Agent NextUp's engine. The original is distributed under this licence:

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
