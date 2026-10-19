---
name: debug-loop
description: A disciplined loop for bugs that resist a first look and for performance regressions — build a command that goes red on this exact bug, shrink it, test ranked hypotheses, then fix behind a regression test. Use when something is broken, throwing, flaky or slow and the cause is not obvious.
---

# debug-loop — no theory before a red loop

Goal: the bug is fixed, a test that once went red on it now passes, and the cause that turned out to be true is on the record.

Redact before you show anything: commands, outputs and captured logs often carry credentials. Write `<REDACTED>` in their place and keep secrets in environment variables.

## 1. Build a feedback loop that goes red on this bug

This is the whole skill; everything after it is mechanical. Spend disproportionate effort here, and be inventive. Roughly in order of preference:

1. a failing test at whatever seam reaches the bug;
2. a request script against a running server;
3. a command run on a fixture, its output diffed against a known-good one;
4. a headless browser script asserting on the page, console or network;
5. a captured payload or trace replayed through the code path;
6. a throwaway harness that runs just the failing path;
7. a loop over many random inputs, for "sometimes wrong";
8. a bisection script between a known-good and a known-bad state;
9. the same input through the old and new versions, outputs diffed;
10. as a last resort, a scripted checklist a human follows, each result fed back to you.

Then tighten it: faster (skip unrelated setup), sharper (assert the exact symptom, not "did not crash"), steadier (pin time, seed randomness, isolate the filesystem). For an intermittent bug, raise the reproduction rate until it is debuggable — loop it, parallelise it, add load.

**Done when** you can name one command, already run and shown with its output, that drives the real code path, asserts the user's exact symptom, gives the same verdict every run, finishes in seconds and runs without a human. Until that command exists, the next step is more loop-building, not reading code for a theory.

If you genuinely cannot build one, say so and list what you tried. Mark the task `blocked` with that list as the reason, and ask the user for access to an environment that reproduces it, a captured artifact, or permission to add temporary instrumentation.

## 2. Reproduce and minimise

Run the loop and confirm it shows the failure the user described — a different failure nearby is a different bug. Then cut inputs, callers, configuration and steps one at a time, re-running after each cut. **Done when** every remaining element is load-bearing: removing any one turns the loop green.

## 3. Hypothesise

Write three to five ranked hypotheses, each with the prediction it makes: "if X is the cause, changing Y makes it disappear." A hypothesis without a prediction is a hunch — sharpen it or drop it. Show the list to the user before testing; they often know which one to try first. Carry on with your ranking if they are away.

## 4. Instrument

Each probe tests one prediction, one variable at a time. A debugger beats logs; targeted logs at the boundaries between hypotheses beat logging everything. Tag every temporary log with a unique prefix (`[DEBUG-a4f2]`) so removing them is a single search. For performance, measure a baseline first and bisect against it.

## 5. Fix behind a regression test

Turn the minimised repro into a failing test at a seam where the real bug pattern occurs, watch it fail, fix, watch it pass, then re-run the original loop. If no seam reaches the real pattern, that is itself a finding about the design: record it rather than writing a test that would give false confidence.

## 6. Clean up

Before calling it done: the original loop is green, the regression test passes (or the missing seam is recorded), every tagged log is gone, throwaway harnesses are deleted, and the hypothesis that proved true is stated in the commit and in your closing record.

---

Adapted from `diagnosing-bugs` in [mattpocock/skills](https://github.com/mattpocock/skills), and rewired to Agent NextUp's engine. The original is distributed under this licence:

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
