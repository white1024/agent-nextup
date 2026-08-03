---
name: adversarial-review
description: Send a fresh-context agent to check every claim in the given documents (or the documents in the current diff) against the code and the real environment, and report graded findings. Required before committing any significant document change — a new document, a rewritten section, an outward-facing README or getting-started guide. Usage: /adversarial-review <file list | no arguments = the documents in the unpushed diff>
---

# adversarial-review — adversarial document review

The principle: **verification is not self-verification**. The session that wrote the document cannot be its own reviewer. Dispatch a general-purpose fresh-context agent and tell it explicitly not to trust the author.

## 1. Set the scope

- With arguments: review those files.
- Without arguments: the `.md` files in the unpushed diff, including uncommitted changes.
- Pure code changes are out of scope for this skill — that is what code review is for.

## 2. What the dispatch prompt must include

Instruct the agent to check each item against **the code and the real environment**, citing source file and line. Documents corroborating each other does not count.

| What to check | Check it against |
|---|---|
| UI wording (buttons, page names, fields, required vs optional) | Frontend source and the i18n resources |
| Commands and scripts | The project's build and dependency manifests, and whether the script files actually exist |
| Path claims (disk contract, output locations) | The path constants defined in code, and the real filesystem |
| List claims (tools, templates, commands) | The registry or enum in code (the single source of truth) |
| Behaviour claims (automation, defaults, the authorisation model) | The corresponding core module source |
| Relative links | Resolve every one of them |
| Internal consistency | Between the documents under review, and against existing outward-facing documents |
| **The counting red line** | Flag every tool count, test count or step count hard-coded in prose — those should point at a single source rather than being written out a second time |

If the project provides a "where to check each claim" reference (look at the development documents the `CLAUDE.md` index points to), include that whole table in the dispatch prompt so the agent does not have to find the sources itself.

Report format: one line per finding, `[error/warn/nit] file:line · claim · reality (source file:line)`. List the categories that came back clean as "checked" too, and end with a verdict on whether this can be committed as is.

## 3. Handling the findings

- **error**: must fix (a newcomer would hit a wall, or the claim contradicts reality).
- **warn**: fix by default; shelve only with a stated reason, recorded in the report.
- **nit**: your call.
- If fixing the errors changed a lot, send another round of review; otherwise the main session closes it out with its own check.
- Report back to the user: the total number of findings, what was done with each, and the remaining risk.

## 4. Boundaries

This reviews the factual accuracy of documents against reality. It does not hunt for code bugs (that is code review), and verifying the takeover path as a whole is left to the project's own cold-read or regression mechanism, if it has one — check the entry document.
