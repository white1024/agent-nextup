# Contributing to Agent NextUp

Thanks for looking. This file is the map: what the code is, where things live,
and which rules are enforced rather than merely preferred.

## First, how this repository works

This repository is a **published artifact**. Development happens in a private
working repository, and each publish replaces the tree here wholesale and lands
as a single commit ([`scripts/publish-oss.mjs`](scripts/publish-oss.mjs)).

One consequence is worth knowing before you spend time: **a change merged only
here would be overwritten by the next publish.** So an accepted contribution is
re-applied upstream and reaches you in a later publish commit, rather than
appearing as a merge. Open the PR normally — just don't be surprised when it
arrives as someone else's commit rather than a green "merged" badge.

Issues are the cheapest way to reach the maintainer, and the right first step
for anything larger than a fix: much of the design has written reasoning behind
it that is not visible in this repository.

A decoding key for the comments you will meet in the source: references like
`nextup_docs/08 §1`, `14 §3.3` or `D77` point at that private design record —
numbered design documents and decisions that do not ship here. They are
unrelated to the `nextup_docs/` directory the *product* creates inside a managed
workspace (the agent operating guide described in the site's disk contract);
the two share a name, not contents. Treat the numbers as provenance markers:
if you need the reasoning behind one, open an issue and ask.

## Getting set up

You need **Rust** (stable, edition 2021), **pnpm**, and the
[Tauri v2 prerequisites](https://v2.tauri.app/start/prerequisites/) for your OS
(on Windows that is WebView2, which ships with Windows 11). Node is pinned by
`use-node-version` in `.npmrc` and pnpm downloads it for you — whatever Node you
have installed does not matter.

```bash
pnpm install
pnpm tauri dev
```

Full build, packaging, and unsigned-build notes:
[reference/building](https://white1024.github.io/agent-nextup/reference/building/).
This file does not repeat them.

## Before you open a PR

```bash
pnpm test               # frontend unit tests (vitest)
pnpm build              # strict tsc + vite bundle
cargo test --workspace  # Rust tests — the bulk of the suite
```

All three should be green, and **running them locally is the only evidence you
will get**: no CI runs on pull requests. `release.yml` is the only workflow in
this repository, it triggers on a `v*` tag or a manual dispatch, and even then
its test steps are `continue-on-error` — a red test does not fail the job, so a
green job is not evidence that tests passed either.

So a reviewer has only your word and their own checkout. Say in the PR what you
ran and on which OS.

## Layout

```
crates/nextup-core/   the engine: workspaces, tasks, gates, ledger, specs, teams.
                     No Tauri dependency — the same operations layer serves both
                     the desktop app and the hub.
crates/nextup-mcp/    the MCP hub server an AI agent connects to. Ships inside the
                     installer; every tool call goes through the core.
src-tauri/           a thin IPC layer: #[tauri::command] wrappers, event plumbing,
                     window and terminal handling.
src/                 the React 19 + TypeScript frontend (see below).
scripts/             build and release tooling — sidecar staging, portable zip,
                     mirror publishing, and a few local helpers.
```

The website and the user documentation are not in this repository. They are
published from a private working repository as built output, onto the
`gh-pages` branch here; the pages are at
<https://white1024.github.io/agent-nextup/>. A documentation correction is welcome as
an issue — there is no source file here to send a PR against.

**Dependency direction is always `src-tauri` → `nextup-core`, never the reverse.**
The core does not know a GUI exists. If something in the core needs to reach
back into the app, the design is wrong somewhere upstream of the code.

## Layout of `src/`

The folders are a rule, not a filing preference, and
[`src/layering.test.ts`](src/layering.test.ts) enforces the parts that can be
checked mechanically:

| Folder | What belongs there | Enforced |
|---|---|---|
| `lib/` | plain modules: formatting, the ledger's display rules, the notification model, the auto-delivery sweep | no React, no `@tauri-apps` import, no UI imports |
| `hooks/` | React hooks shared across screens | may not import a component, `shell/`, or a screen |
| `components/` | pieces that **more than one** screen uses | may not import `shell/` or `views/` |
| `shell/` | the persistent app shell's own parts: workspace switcher, command palette, toast layer, error boundary | only `App.tsx` may import them |
| `views/<screen>/` | one screen and the pieces only that screen uses | `index` is the screen; everything else is private to it |
| `src/*` | entry points (`main.tsx`, `App.tsx`) and the platform boundary (`api.ts`, `types.ts`, `i18n.ts`, `theme.ts`, `styles.css`) | — |

Dependencies run downward through that table. Two of those rules are worth
spelling out, because they are the ones you are most likely to trip over:

**`lib/` is React-free** so those modules stay testable without a renderer —
vitest runs here with no DOM. The rule is about what `lib/` may depend on, not
about where tests live: two pure helpers are tested next to their single caller
instead (`elidePath` in `components/PathLabel.tsx`, and `views/teams/layout.ts`).

**A screen's parts stay inside the screen.** Putting a one-caller component in
`components/` claims it is shared, and the next person to edit it will believe
that claim and be careful about ten screens that do not exist. When a second
screen genuinely wants such a piece, the guard stops you from importing across
and asks you to promote it to `components/` first — that promotion *is* the
moment it becomes a shared component, and it should be a deliberate one.

Three other things in `src/` are single sources that are easy to duplicate by
accident:

- **`types.ts`** mirrors the Rust DTOs. It is not a place to invent a shape.
- **`i18n.ts`** carries `zh-TW` and `en` side by side; a new string needs both.
- **`styles.css`** holds the design tokens in `:root`. Take an existing token
  rather than writing a literal into a selector —
  [`src/styles.test.ts`](src/styles.test.ts) fails on a `var(--x)` with no
  declaration, because that mistake renders as *full-strength* text instead of
  the intended grey and nothing else warns about it.

## Tests

Rust carries most of the suite, inline with the code it covers. On the frontend,
vitest runs in the node environment with no jsdom, so unit tests cover the pure
modules in `lib/` plus four cross-cutting guards:

- `layering.test.ts` — the folder rules above
- `styles.test.ts` — every `var(--x)` resolves
- `boot.test.ts` — `index.html` is the one file that runs before the bundle
  loads, so it has to restate a few token values and command names; this test
  checks each restatement against its real source
- `i18n.test.ts` — every static `t("…")` call site names a key that exists. A
  missing key does not throw at runtime, it renders the key itself, so nothing
  else would catch it

React components are deliberately not unit-tested — that would mean adopting
jsdom, which has not been judged worth it. If you add a guard of your own, make
it fail on purpose once before you trust it.

## Language

**Code, comments and documentation in this repository are English.** Publishing
runs a CJK scan, so a stray Chinese comment is caught rather than shipped.

CJK is legitimate only where `CJK_ALLOWED` in `scripts/publish-oss.mjs` says
so, and every entry there carries a sentence saying why. Most waivers fall
into two families — the product's own Traditional Chinese resources
(`src/i18n.ts`, the language switcher's label, the bilingual workflow
templates) and tests whose *subject* is non-ASCII text (UTF-8 boundary
handling, character clamping, the localized spec lint) — but the list, not
the family, is the rule. If you are adding a fixture of that kind, add the
waiver with a sentence saying why.

## Style

There is no formatter config to fight with; match the file you are editing.
Two habits carry more weight here than formatting:

- **Comments say why, not what.** The code already says what. A comment that
  explains a non-obvious constraint — a race, an ordering requirement, a
  platform quirk — is worth more than five that narrate the next line.
- **Prefer making a rule checkable over documenting it.** Most of the guards in
  this repository exist because a written rule had already gone quietly stale
  once.
