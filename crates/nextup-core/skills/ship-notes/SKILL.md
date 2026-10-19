---
name: ship-notes
description: Write release notes or a pull-request body that a reviewer can act on — the smallest picture of the change, before-and-after evidence that it works, and whether it can be undone. Use in a Release phase for artifacts/release-notes.md, or whenever you write a PR description.
---

# ship-notes — what changed, how we know, can it be undone

Goal: someone who was not in the session can decide from this page alone whether to take the change and how carefully.

In a Release phase the file is `artifacts/release-notes.md` — the phase's exit gate checks that it exists. The same shape works as a PR body. Use the project's own vocabulary (`GLOSSARY.md` if there is one) and skip the preamble.

## The shape

```markdown
## Summary

<the smallest picture that makes the change clear>

## Evidence

- **Before:** <failing test run, output or screenshot>
  **After:** <passing run, output or screenshot>

## Can it be undone?

**Door:** one-way | two-way
**Reach:** <one word — what it can affect>
<only if needed: what could go wrong, and how to roll back>

## Known limitations and follow-ups
```

## Summary: pick the smallest picture

One or two of these, placed next to the sentence they support — never all of them:

- **Pseudocode** for logic or an algorithm.
- **A call tree** for runtime control flow.
- **A component tree** for UI structure, with the state and boundaries that matter.
- **A shallow file tree** for responsibilities or a broad refactor.
- **A sequence diagram** (Mermaid) for interactions between parts.
- **A diff of any of the above** when the point is what changed and the surrounding shape already exists.

## Evidence

Show the change working, before and after. A screenshot is the best evidence for a visual change; a test run or real output is next — name the test that failed before and passes now. "Tests pass" with nothing shown is not evidence.

## Can it be undone

A **two-way door** can be walked back cheaply: revert and nothing is lost. A **one-way door** cannot: a migration, a deleted field, a changed contract others depend on, anything destructive. Say which, then give the reach in a word — layout, consumers, data, performance — and the ramifications if it is one-way.

---

Adapted from `pr` in [mattpocock/skills](https://github.com/mattpocock/skills), itself crediting `show-me` by Dex Horthy (HumanLayer), and rewired to Agent NextUp's engine. The original is distributed under this licence:

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
