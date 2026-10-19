# Third-party notices

## mattpocock/skills

Several workflow skills that Agent NextUp ships into a workspace are adapted from
[mattpocock/skills](https://github.com/mattpocock/skills) and rewired to Agent NextUp's
engine (tasks and dependencies, the ledger, spec deltas). Each adapted file names its
source at the end.

| Shipped skill | Adapted from |
|---|---|
| `crates/nextup-core/skills/slice-work/` | `to-spec`, `to-tickets` |
| `crates/nextup-core/skills/retrospect/` | `retro` |
| `crates/nextup-core/skills/test-first/` | `tdd` |
| `crates/nextup-core/skills/debug-loop/` | `diagnosing-bugs` |
| `crates/nextup-core/skills/two-axis-review/` | `code-review` |
| `crates/nextup-core/skills/ship-notes/` | `pr` (which itself credits `show-me` by Dex Horthy, HumanLayer) |
| `crates/nextup-core/skills/work-the-frontier/` | `implement-spec` |

```
MIT License

Copyright (c) 2026 Matt Pocock

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
