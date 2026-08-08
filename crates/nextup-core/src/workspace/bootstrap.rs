//! AI-session bootstrap layer.
//!
//! A generated workspace must be **directly take-over-able** by any AI coding
//! session: agents auto-load root `CLAUDE.md` / `AGENTS.md`, so that is where
//! the handoff protocol lives. The twist over convention-only frameworks:
//! the volatile part of `CLAUDE.md` (current phase, next steps, blockers) sits
//! inside an engine-maintained marker block that is rewritten on every state
//! change — the entry file can never go stale, while everything outside the
//! markers belongs to humans/sessions and is never touched.
//!
//! The layer also emits an aggregation manifest (`project.yaml`) whose
//! `phase` / `progress` / `updated` lines are kept fresh by targeted
//! line replacement (comments and hand-edited fields survive), plus
//! `nextup_docs/` (layered detail), `memory/` (one fact per file) and
//! `work_record/` (monthly report source) scaffolds.

use std::path::Path;

use crate::error::Result;
use crate::workspace::atomic::atomic_write;
use crate::workspace::context::{load_context, now_rfc3339, ProjectContext};
use crate::workspace::layout::{WorkspacePaths, NEXTUP_DOCS_DIR, MODULE_GUIDES_SUBDIR};
use crate::workspace::ledger::{clamp_line, ledger_for, LedgerEvent, LedgerKind, SUMMARY_MAX_CHARS};
use crate::workspace::tasks::{compute_counts, Task, TaskStatus, TaskStore};
use crate::workspace::workflow::{gate_label, try_evaluate, WorkflowStatus};

pub const STATE_BEGIN: &str = "<!-- NEXTUP:STATE:BEGIN -->";
pub const STATE_END: &str = "<!-- NEXTUP:STATE:END -->";

/// Create every missing bootstrap file. Idempotent and non-destructive:
/// existing files are never overwritten. Returns the created file names.
pub fn scaffold(paths: &WorkspacePaths, ctx: &ProjectContext) -> Result<Vec<String>> {
    let workflow = try_evaluate(paths)?;
    let phase_title = match &workflow {
        Some(ws) => ws.current_phase_title(),
        None => "—".to_string(),
    };

    let mut created = Vec::new();
    let mut write_if_missing = |path: &Path, content: String| -> Result<()> {
        if path.exists() {
            return Ok(());
        }
        atomic_write(path, content.as_bytes())?;
        if let Some(name) = path.file_name() {
            created.push(name.to_string_lossy().into_owned());
        }
        Ok(())
    };

    write_if_missing(&paths.claude_md_file(), render_claude_md(ctx))?;
    write_if_missing(&paths.agents_md_file(), render_agents_md(ctx))?;
    write_if_missing(&paths.protocol_file(), render_protocol(ctx))?;
    write_if_missing(&paths.nextup_guide_file(), render_guide(ctx))?;
    write_if_missing(&paths.memory_index_file(), render_memory_index(ctx))?;
    write_if_missing(&paths.manifest_file(), super::manifest::render_manifest(ctx, &phase_title))?;
    write_if_missing(
        &paths.work_record_dir().join("_TEMPLATE.md"),
        render_work_record_template(ctx),
    )?;
    // Never merged if the user already has their own .mcp.json (v1 keeps
    // hands off existing mcpServers entries entirely). The bare command name
    // relies on PATH; the app rewrites it to an absolute path at init time
    // (see set_mcp_discovery_command) so the user never has to touch PATH.
    write_if_missing(&paths.mcp_discovery_file(), render_mcp_discovery(MCP_COMMAND_DEFAULT))?;
    // Adopting a repo that already has its own CLAUDE.md (the adopt wizard's
    // main case): write-if-missing leaves that file alone, which is correct —
    // but then nothing imports AGENTS.md and Claude Code loads none of the
    // takeover layer. Append the one line that fixes it.
    //
    // This is the single place the engine writes into a CLAUDE.md it did not
    // author, so it is deliberately the smallest possible edit: append only,
    // never rewrite or reorder, only when no live import is present, and the
    // result is reported in `created` so the user sees it happened. The
    // human's own content is untouched (D7/D16).
    ensure_agents_import(&paths.claude_md_file(), &mut created)?;
    // Skills ship to both roots as real files (D82): `.agents/skills/` is the
    // host-neutral canonical copy, `.claude/skills/` is where Claude Code
    // actually discovers them. Never a symlink — see layout::AGENT_CONFIG_DIR.
    // Each is write-if-missing on its own, so a user who edits one keeps that
    // edit; doctor::check_skill_mirrors is what stops the pair forking in
    // silence.
    for (name, content) in WORKSPACE_SKILLS {
        for (rel, path) in paths.skill_files(name) {
            if !path.exists() {
                atomic_write(&path, content.as_bytes())?;
                created.push(rel);
            }
        }
    }
    // Module guides: only for what this workspace enabled (D82). A corrupt
    // modules.json is a hard error here rather than a silent "nothing
    // enabled" — shipping an agent a workspace with its module contract
    // quietly missing is exactly the failure this batch exists to remove.
    for module in super::modules::get_modules(paths)?.enabled {
        let Some(content) = render_module_guide(&module, ctx) else {
            continue;
        };
        let path = paths.module_guide_file(&module);
        if !path.exists() {
            atomic_write(&path, content.as_bytes())?;
            created.push(WorkspacePaths::module_guide_rel(&module));
        }
    }
    // Fingerprint what the engine just shipped (and adopt provably-current
    // files on old workspaces in passing) so upgrades can tell "the engine
    // moved on" from "the user customized" (workspace::assets, D38).
    super::assets::record_pristine(paths, ctx)?;
    Ok(created)
}

/// The import line that makes the `AGENTS.md` body reachable from Claude Code.
pub(crate) const AGENTS_IMPORT: &str = "@AGENTS.md";

/// Append the `@AGENTS.md` import to an existing `CLAUDE.md` that lacks it.
///
/// No-op when the file is absent (scaffold just wrote our own shell) or when a
/// live import is already there — so this is idempotent across repeated
/// scaffold runs, which matters because the app calls it on every repair.
fn ensure_agents_import(path: &Path, created: &mut Vec<String>) -> Result<()> {
    if !path.is_file() {
        return Ok(());
    }
    let content = std::fs::read_to_string(path)?;
    if imports_agents_md(&content) {
        return Ok(());
    }
    let mut updated = content;
    if !updated.is_empty() && !updated.ends_with('\n') {
        updated.push('\n');
    }
    updated.push_str(&format!(
        "\n{AGENTS_IMPORT}\n\n<!-- Added by Agent NextUp: Claude Code reads only CLAUDE.md, and the\n     takeover guide plus the engine-maintained state block live in\n     AGENTS.md. Everything above is yours and was not touched. -->\n"
    ));
    atomic_write(path, updated.as_bytes())?;
    created.push(format!("CLAUDE.md ({AGENTS_IMPORT} import)"));
    Ok(())
}

/// Does this file carry a **live** `@AGENTS.md` import?
///
/// Shared by the writer (`scaffold`) and the checker (`doctor`) on purpose: two
/// separate judgements of "is the import there" would eventually disagree, and
/// the failure would be silent in both directions (scaffold adding a second
/// import, or doctor blessing a shell that loads nothing).
///
/// Mirrors the two host rules that decide whether an import actually fires: it
/// may sit **inline** in a sentence, and one inside a fenced block or a code
/// span is **skipped**. The second rule is the dangerous direction — a fenced
/// `@AGENTS.md` looks like an import to a naive scan while the host ignores it.
/// The trailing character is checked too, or `@AGENTS.mdx` would pass.
pub(crate) fn imports_agents_md(content: &str) -> bool {
    let mut fenced = false;
    for line in content.lines() {
        let trimmed = line.trim_start();
        if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
            fenced = !fenced;
            continue;
        }
        if fenced {
            continue;
        }
        // Code spans are host-ignored as well; drop them before looking.
        let mut visible = String::with_capacity(line.len());
        let mut in_span = false;
        for ch in line.chars() {
            if ch == '`' {
                in_span = !in_span;
            } else if !in_span {
                visible.push(ch);
            }
        }
        for (idx, _) in visible.match_indices(AGENTS_IMPORT) {
            let after = visible[idx + AGENTS_IMPORT.len()..].chars().next();
            // A bare mention must end there — `.mdx` is a different file.
            if after.is_none_or(|c| !c.is_alphanumeric()) {
                return true;
            }
        }
    }
    false
}

/// Generic process skills shipped into every workspace at init (D30).
///
/// Single source = this repo's own `.claude/skills/` — the dev repo dogfoods
/// the exact files it exports, so there is no template copy to drift. The
/// skills must stay **generic** (they defer project specifics to the target
/// project's own `CLAUDE.md`); `shipped_skills_stay_generic` guards that.
/// Written only when missing, so user edits in a workspace survive.
pub const WORKSPACE_SKILLS: [(&str, &str); 4] = [
    ("align-scope", include_str!("../../../../.claude/skills/align-scope/SKILL.md")),
    ("wrap-up", include_str!("../../../../.claude/skills/wrap-up/SKILL.md")),
    (
        "adversarial-review",
        include_str!("../../../../.claude/skills/adversarial-review/SKILL.md"),
    ),
    ("handoff-check", include_str!("../../../../.claude/skills/handoff-check/SKILL.md")),
];

/// Per-module guides, shipped **only for the modules a workspace enabled**
/// (D82). Same single-source discipline as the main guide: prose lives in its
/// own markdown file under `guide/modules/` and is embedded at compile time.
///
/// Keyed by the module ids in [`crate::workspace::modules`]; the pairing is
/// asserted by `every_known_module_has_a_guide` so adding a module without its
/// guide cannot compile past the test suite.
pub const MODULE_GUIDES: [(&str, &str); 4] = [
    (crate::workspace::modules::MODULE_COLLAB, include_str!("../../guide/modules/collab.md")),
    (crate::workspace::modules::MODULE_PRIME, include_str!("../../guide/modules/prime.md")),
    (crate::workspace::modules::MODULE_SPECS, include_str!("../../guide/modules/specs.md")),
    (crate::workspace::modules::MODULE_TEAM, include_str!("../../guide/modules/team.md")),
];

/// Render one module's guide. Returns `None` for an unknown id so callers can
/// treat "module recorded in modules.json that this build does not know" as
/// skip-and-continue rather than a panic (`validate_module` refuses unknown
/// ids on the write path, but an older file could still carry one).
pub(crate) fn render_module_guide(module: &str, ctx: &ProjectContext) -> Option<String> {
    MODULE_GUIDES
        .iter()
        .find(|(id, _)| *id == module)
        .map(|(_, template)| template.replace("@PROJECT_NAME@", &ctx.name))
}

/// Default hub-server command written into `.mcp.json`. A bare name resolves
/// through the agent host's PATH; the desktop app overrides it with the
/// resolved absolute path so no PATH setup is required (issue: mcp deploy UX).
pub const MCP_COMMAND_DEFAULT: &str = "nextup-mcp";

/// Point the workspace's root `.mcp.json` `nextup` server at `command`,
/// preserving any other `mcpServers` the user added. Creates the file if
/// absent. The `nextup` entry is engine-owned wiring, so overwriting just that
/// key is expected; every other server is left untouched. A file that exists
/// but does not parse is a hard error — silently replacing it would destroy
/// the user's other server entries.
///
/// Not wrapped in `with_mutation_lock`: callers are app-init/repair paths and
/// the write itself is atomic; a concurrent `scaffold` only writes this file
/// when missing.
pub fn set_mcp_discovery_command(paths: &WorkspacePaths, command: &str) -> Result<()> {
    let path = paths.mcp_discovery_file();
    let mut root: serde_json::Value = if path.is_file() {
        let raw = super::atomic::read_file(&path)?;
        serde_json::from_slice(&raw).map_err(|e| {
            crate::error::NextUpError::InvalidInput(format!(
                "{} is not valid JSON ({e}) — fix it before Agent NextUp can update the nextup entry",
                path.display()
            ))
        })?
    } else {
        serde_json::json!({})
    };
    if !root.is_object() {
        return Err(crate::error::NextUpError::InvalidInput(format!(
            "{} top level is not a JSON object — fix it before Agent NextUp can update the nextup entry",
            path.display()
        )));
    }
    let servers = root
        .as_object_mut()
        .expect("root verified as object above")
        .entry("mcpServers")
        .or_insert_with(|| serde_json::json!({}));
    if !servers.is_object() {
        *servers = serde_json::json!({});
    }
    servers.as_object_mut().expect("servers coerced to object above").insert(
        "nextup".to_string(),
        serde_json::json!({ "command": command, "args": ["--workspace", "."] }),
    );
    let mut rendered = serde_json::to_string_pretty(&root)?;
    rendered.push('\n');
    atomic_write(&path, rendered.as_bytes())?;
    Ok(())
}

/// How many recent decisions the CLAUDE.md state block shows.
pub(crate) const STATE_BLOCK_DECISIONS: usize = 3;
/// How many recent `progress` entries the state block shows (D78) — the
/// takeover reads "where the last session stopped" right after the one-liner.
pub(crate) const STATE_BLOCK_PROGRESS: usize = 3;

/// Ledger message through the D78 lens, state-block variant (the snapshot
/// has its own twin in handoff.rs).
fn state_line(text: &str) -> String {
    let (line, cut) = clamp_line(text, SUMMARY_MAX_CHARS);
    if cut {
        format!("{line} …(full text in the ledger)")
    } else {
        line.to_string()
    }
}

/// Task-side strings (title, blocked reason): same bound, bare ellipsis —
/// the full text lives in the task file, not the ledger.
fn state_title(text: &str) -> String {
    let (line, cut) = clamp_line(text, SUMMARY_MAX_CHARS);
    if cut {
        format!("{line} …")
    } else {
        line.to_string()
    }
}

/// Bring the engine-owned surfaces up to date with reality:
/// - rewrite the `CLAUDE.md` marker block (skip if file/markers are absent),
/// - sync `project.yaml`'s `phase` / `progress` / `updated` lines in place.
///
/// Standalone entry (scaffold repair etc.) that loads the state itself.
/// Mutation paths go through `sync::sync_after_mutation`, which preloads the
/// state once and calls [`refresh_with`] directly. This must never call
/// `generate_handoff` (recursion). Never touches content outside its
/// markers/lines, and is a silent no-op for anything the user deleted.
pub fn refresh(paths: &WorkspacePaths) -> Result<()> {
    if !paths.is_initialized() {
        return Ok(());
    }
    let ctx = load_context(&paths.context_file())?;
    let tasks = TaskStore::new(paths.tasks_dir()).list()?;
    let workflow = try_evaluate(paths)?;
    let ledger = ledger_for(paths);
    let decisions = ledger.recent_of_kind(LedgerKind::Decision, STATE_BLOCK_DECISIONS)?;
    let progress = ledger.recent_of_kind(LedgerKind::Progress, STATE_BLOCK_PROGRESS)?;
    refresh_with(paths, &ctx, &tasks, workflow.as_ref(), &decisions, &progress)
}

/// [`refresh`] with the state preloaded by the caller, so a mutation pass
/// never loads files or evaluates gates twice.
pub(crate) fn refresh_with(
    paths: &WorkspacePaths,
    ctx: &ProjectContext,
    tasks: &[Task],
    workflow: Option<&WorkflowStatus>,
    decisions: &[LedgerEvent],
    progress: &[LedgerEvent],
) -> Result<()> {
    refresh_agents_state(paths, ctx, tasks, workflow, decisions, progress)?;
    super::manifest::sync_manifest(paths, tasks, workflow)?;
    Ok(())
}

// ── AGENTS.md ───────────────────────────────────────────────────────────────

/// Rewrite the state block in place. The target is `AGENTS.md` since D82 (the
/// body moved there; `CLAUDE.md` is only an import shell) — this is the single
/// place that decides which file carries the block, so moving it is a one-line
/// change here rather than a hunt through the mutation paths.
fn refresh_agents_state(
    paths: &WorkspacePaths,
    ctx: &ProjectContext,
    tasks: &[Task],
    workflow: Option<&WorkflowStatus>,
    decisions: &[LedgerEvent],
    progress: &[LedgerEvent],
) -> Result<()> {
    let path = paths.agents_md_file();
    if !path.is_file() {
        return Ok(());
    }
    let content = std::fs::read_to_string(&path)?;
    let Some(begin) = content.find(STATE_BEGIN) else { return Ok(()) };
    let after_begin = begin + STATE_BEGIN.len();
    let Some(end_rel) = content[after_begin..].find(STATE_END) else { return Ok(()) };
    let end = after_begin + end_rel;

    // Spec-layer line input (D79): computed here rather than threaded from
    // sync — two tiny reads (modules.json, one read_dir), not a second
    // state load or gate evaluation. The same read drives the module-guide
    // line (D82), so a toggle updates both on the next sync.
    let modules = crate::workspace::modules::get_modules(paths)?;
    let specs_caps = if modules.is_enabled(crate::workspace::modules::MODULE_SPECS) {
        Some(crate::workspace::specs::list_capabilities(paths)?.len())
    } else {
        None
    };
    // Only modules this build ships a guide for — an id from a newer build
    // must not point the agent at a file that will never exist.
    let guided: Vec<&str> = MODULE_GUIDES
        .iter()
        .map(|(id, _)| *id)
        .filter(|id| modules.is_enabled(id))
        .collect();
    let block = render_state_block(ctx, tasks, workflow, decisions, progress, specs_caps, &guided);
    let updated = format!(
        "{}{}\n{}\n{}{}",
        &content[..begin],
        STATE_BEGIN,
        block,
        STATE_END,
        &content[end + STATE_END.len()..]
    );
    if updated != content {
        atomic_write(&path, updated.as_bytes())?;
    }
    Ok(())
}

fn render_state_block(
    ctx: &ProjectContext,
    tasks: &[Task],
    workflow: Option<&WorkflowStatus>,
    decisions: &[LedgerEvent],
    progress: &[LedgerEvent],
    specs_caps: Option<usize>,
    guided_modules: &[&str],
) -> String {
    let counts = compute_counts(tasks);
    let mut md = String::with_capacity(1024);
    md.push_str("> ⚙️ Maintained automatically by the Agent NextUp engine (hand edits are overwritten on the next update); updated ");
    md.push_str(&now_rfc3339());
    md.push('\n');

    // One-line status
    md.push_str(&format!(
        "\n**Status**: {} (domain: {}) — {} tasks: {} todo / {} in progress / {} blocked / {} done",
        ctx.name, ctx.domain, counts.total, counts.todo, counts.in_progress, counts.blocked, counts.done
    ));
    if let Some(ws) = workflow {
        if ws.workflow.state.completed {
            md.push_str(&format!("; workflow **complete** (template {})", ws.workflow.template_name));
        } else {
            md.push_str(&format!(
                "; current phase **{}** ({}/{}, template {})",
                ws.current_phase_title(),
                ws.current_index + 1,
                ws.total_phases,
                ws.workflow.template_name
            ));
        }
    }
    md.push_str(".\n");

    // One spec-layer line (D79): a fixed-length count plus a pointer. The content
    // itself never moves in here (the D78 size invariant). No line at all when the
    // module is off. It lives in STATE rather than the CLAUDE.md template because
    // STATE re-renders on every sync, so existing workspaces pick it up without
    // an asset upgrade.
    if let Some(n) = specs_caps {
        md.push_str(&format!(
            "\n**Spec layer**: {n} capabilities (current behaviour in specs/; task deltas in tasks/<id>/specs/, folded in on archive).\n"
        ));
    }

    // Enabled-module guides (D82). Rendered here rather than in the CLAUDE.md
    // template for the same reason as the line above: STATE re-renders on
    // every sync, so a module toggled today is reflected today. No line at all
    // when nothing is enabled — a plain workspace says nothing about modules,
    // which is the whole point of the batch.
    if !guided_modules.is_empty() {
        md.push_str(&format!(
            "\n**Module guides**: {} — read the ones listed here; they are the only module contracts that apply to this workspace.\n",
            guided_modules
                .iter()
                .map(|m| format!("`{}/{}/{m}.md`", NEXTUP_DOCS_DIR, MODULE_GUIDES_SUBDIR))
                .collect::<Vec<_>>()
                .join(" ")
        ));
    }

    // Last progress (D78): the first thing a takeover reads is where the previous
    // round stopped, before the instructions and the tasks.
    //
    // It is labelled because this block mixes two kinds of field and a reader
    // cannot tell them apart by looking: the counts, the exit gates and the
    // spec line are recomputed from real state on every write, while this one
    // and the blocker reasons are an agent's own words, frozen at the moment
    // they were typed. During the D86 run a fold landed at 02:45:46Z, the
    // block was regenerated at 02:47:23Z, and Last progress still read "stuck
    // waiting for someone to archive it" — an auditor who trusted it would
    // have concluded the opposite of the truth. Half-fresh with no marking is
    // worse than uniformly stale, because it is trusted.
    if !progress.is_empty() {
        md.push_str("\n**Last progress** (verbatim from the session that wrote it — a claim of its moment, not a current fact):\n");
        for event in progress {
            md.push_str(&format!("- `{}` {}\n", event.at, state_line(&event.message)));
        }
    }

    // This phase's instructions and gates
    if let Some(ws) = workflow {
        if !ws.workflow.state.completed {
            if let Some(phase) = ws.workflow.phases.get(ws.current_index) {
                if !phase.ai_instructions.is_empty() {
                    md.push_str("\n**Instructions for this phase**:\n");
                    for line in &phase.ai_instructions {
                        md.push_str(&format!("- {line}\n"));
                    }
                }
                if !ws.gates.is_empty() {
                    md.push_str("\n**Exit gates** (evaluated by the engine against real state):\n");
                    for gate in &ws.gates {
                        md.push_str(&format!(
                            "- [{}] {} — {}\n",
                            if gate.passed { "x" } else { " " },
                            gate_label(&gate.gate),
                            gate.observed
                        ));
                    }
                }
            }
        }
    }

    // Next steps (selection and ordering live in tasks::next_steps, the same source
    // as handoff §3)
    let next = crate::workspace::tasks::next_steps(tasks);
    md.push_str("\n**Next steps** (up to 5; ▶ = in progress):\n");
    if next.is_empty() {
        md.push_str("- (no open tasks; break new ones out of this phase's instructions)\n");
    } else {
        for task in next.iter().take(5) {
            let marker = if task.status == TaskStatus::InProgress { "▶" } else { "·" };
            md.push_str(&format!(
                "- {} [P{}] {} — {}\n",
                marker,
                task.priority,
                task.id,
                state_title(&task.title)
            ));
        }
    }

    // Blockers. The reason is quoted prose with a date on it for the same
    // reason Last progress carries one: nothing recomputes it, so a reader
    // needs to see how old the claim is before acting on it.
    let blocked = crate::workspace::tasks::blocked(tasks);
    md.push_str("\n**Blockers**: ");
    if blocked.is_empty() {
        md.push_str("none right now.\n");
    } else {
        md.push_str("(reasons as stated when blocked; nothing re-checks them)\n");
        for task in blocked {
            let stamp = task
                .blocked_at
                .as_deref()
                .map(|at| format!("`{at}` "))
                .unwrap_or_default();
            md.push_str(&format!(
                "- {} — {} ({}reason: {})\n",
                task.id,
                state_title(&task.title),
                stamp,
                state_title(task.blocked_reason.as_deref().unwrap_or("unstated"))
            ));
        }
    }

    // Recent decisions (each clamped by the D78 lens — the state block is an index,
    // not an archive)
    if !decisions.is_empty() {
        md.push_str("\n**Recent decisions**:\n");
        for event in decisions {
            md.push_str(&format!("- `{}` {}\n", event.at, state_line(&event.message)));
        }
    }

    md.push_str("\n> Full content (recent ledger, all tasks, decisions in full) -> [.nextup/snapshots/latest_handoff.md](.nextup/snapshots/latest_handoff.md)");
    md
}

/// Index-only by design (D16): facts live in their sources of truth
/// (context.json, ledger, guide) — the sole exception is the engine-freshened
/// state block, which cannot drift because the engine rewrites it (D7).
/// Claude Code's entry point: a shell that imports [`render_agents_md`]'s
/// output (D82). Claude Code reads `CLAUDE.md` and not `AGENTS.md`, so the
/// import is what makes a host-neutral body reachable; `@AGENTS.md` is the
/// mechanism the official docs recommend for exactly this (a symlink is the
/// other option and is rejected — see `layout::AGENT_CONFIG_DIR`).
///
/// Deliberately tiny and free of facts: everything a session needs is one hop
/// away, and there is nothing here to drift. `doctor::check_entry_shell`
/// guards the import line, because a shell that lost it loads *nothing* — a
/// silent, total failure of the takeover layer.
fn render_claude_md(ctx: &ProjectContext) -> String {
    format!(
        "# {name} — Agent NextUp workspace\n\n@AGENTS.md\n\n<!-- The takeover guide, the engine's state block and the document index all\n     live in AGENTS.md so that any agent host can read them; the line above\n     imports the whole file for Claude Code. Keep it. -->\n",
        name = ctx.name,
    )
}

fn render_agents_md(ctx: &ProjectContext) -> String {
    format!(
        r#"# {name} — Agent NextUp workspace

> 🤖 **Read in this order**: (1) the Current state block below (engine-maintained, never stale) -> (2) [.nextup/snapshots/latest_handoff.md](.nextup/snapshots/latest_handoff.md) (the full handoff snapshot) -> (3) [memory/MEMORY.md](memory/MEMORY.md) (cross-session memory).
> 📐 **Follow [nextup_docs/00-protocol.md](nextup_docs/00-protocol.md) on every takeover** — it is short and it is the procedure. The file contract, formats and headless rules are in [nextup_docs/01-nextup-guide.md](nextup_docs/01-nextup-guide.md): required reading the first time you take over, and reference material after that.
> 🔌 When the **nextup hub tools** are available (MCP, connected automatically through `.mcp.json` at the root): route tasks, decisions, milestones and phase advances **through tool calls**. The tools keep the ledger and the handoff layer in sync; editing JSON by hand does not. Fall back to the guide's headless file operations only when the tools cannot be reached.
> 🗣️ Reply in the language the user writes in.
> 📇 This file is an **index plus the engine's state block**, and it is the entry point for every agent host. The source of truth for goals and boundaries is `.nextup/context.json`, and decisions live in the ledger and in memory — do not copy facts back into this file. Everything outside the state block belongs to the human; the engine does not touch it. (`CLAUDE.md` is a one-line shell that imports this file, because Claude Code reads only `CLAUDE.md` — edit this file, not that one.)

{begin}
(initialising; this block is maintained by the Agent NextUp engine)
{end}

## Directory and document index
| Path | What it is | When to read it |
|---|---|---|
| [nextup_docs/00-protocol.md](nextup_docs/00-protocol.md) | **The session operating protocol** — the eight steps of a takeover | **Every** takeover |
| [nextup_docs/01-nextup-guide.md](nextup_docs/01-nextup-guide.md) | The .nextup contract, task and ledger formats, gate semantics, hub tools (§9) | First takeover, or before touching any file |
| `.nextup/context.json` | Project goals, boundaries and milestones (**source of truth**) | When you need to know what is and is not in scope |
| [memory/MEMORY.md](memory/MEMORY.md) | Cross-session memory index (one fact per file) | Every takeover |
| `tasks/` | Atomic tasks, one file each (`T-XXXX.json`) | When picking up a task |
| `artifacts/` | Deliverable output directory | When delivering |
| `work_record/` | Monthly work record (`YYYY-MM.md`; template `_TEMPLATE.md`) | End of month, or when asked to record |
| [project.yaml](project.yaml) | Outward-facing aggregate manifest (`phase`/`progress`/`updated` synced by the engine) | When reporting outwards |
| `.mcp.json` | Connection settings for the nextup hub tools (Agent NextUp points it at the resolved `nextup-mcp` path) | Takes effect automatically; rarely needs reading |
| `.agents/skills/` | The process skills, canonical copies (`.claude/skills/` holds byte-identical copies for Claude Code) | When your host cannot invoke skills — read the `SKILL.md` and follow it |
| [CLAUDE.md](CLAUDE.md) | A shell that imports this file (Claude Code reads only that name) | Never edit it instead of this file |
"#,
        name = ctx.name,
        begin = STATE_BEGIN,
        end = STATE_END,
    )
}

/// Hub discovery file at the workspace root. Seeded with a bare `nextup-mcp`
/// command (keeps the file portable across machines/backups); the desktop app
/// rewrites it to the resolved absolute path at init time so no PATH setup is
/// needed (set_mcp_discovery_command). cwd is the project root when the host
/// spawns it, so `--workspace .` resolves correctly.
fn render_mcp_discovery(command: &str) -> String {
    // Built via serde so an absolute command path (Windows backslashes) is
    // always correctly JSON-escaped.
    let value = serde_json::json!({
        "mcpServers": {
            "nextup": { "command": command, "args": ["--workspace", "."] }
        }
    });
    let mut rendered = serde_json::to_string_pretty(&value)
        .unwrap_or_else(|_| String::from("{\"mcpServers\":{}}"));
    rendered.push('\n');
    rendered
}

fn render_memory_index(ctx: &ProjectContext) -> String {
    format!(
        r#"# Memory Index — {}

> 📦 This folder is the **single source of truth** for the project's cross-session memory, and it travels with the repo.
> One fact per file: each memory is its own `.md` (frontmatter with `type: user|feedback|project|reference` is recommended),
> and adding one means adding an index line below: `- [Title](file.md) — one-line hook`.
> The rule: write down a decision, finding or pitfall **the moment it is settled** in conversation, so the next session never has to derive it again.

(no memories yet)
"#,
        ctx.name
    )
}

fn render_work_record_template(ctx: &ProjectContext) -> String {
    format!(
        r#"<!-- Monthly report template: copy it to YYYY-MM.md (e.g. 2026-07.md) and fill it in.

     This format is load-bearing, and the tool that consumes it lives OUTSIDE
     this workspace: it belongs to the report owner's own toolchain. Agent NextUp
     ships no renderer and cannot run theirs, so a filled-in report cannot be
     verified by rendering it here — it is verified by the person who owns the
     report. Say that plainly when you hand one over, rather than claiming a
     check you had no way to run.

     What is known about the format: single-hash `#` headings, HTML comments
     and `>` quote lines are ignored, bold markers are stripped, and a line
     that matches nothing is dropped silently rather than flagged.

     What is not known here — whether `*` bullets, tabs or a skipped nesting
     level are accepted — so do not guess. Reproduce the shape below exactly:
     `-` bullets, spaces and never tabs, two spaces per nesting level (so the
     third level sits at four), no level skipped. That is the shape this
     template itself uses, which is the only shape anyone here can vouch for.
     If you need something it does not cover, ask the report owner; the
     specification is theirs, not this workspace's.

     The percentages are theirs too. `DEPT:` names the department the report
     rolls up into; each `##` carries that project's share of the month, kept
     consistent across projects and summing to 100%. They are set by hand —
     leave them as they stand unless you are given the figures. -->
DEPT: Department - 100%

## {name} - 100%
- Topic
  - Sub-item:
    - Delivered a concrete result (start with a past-tense verb; indent 4 spaces)

<!-- When there is no progress in a month, use this instead:
## {name} - 0%
- No progress this month
-->
"#,
        name = ctx.name
    )
}

// ── nextup_docs/01-nextup-guide.md ────────────────────────────────────────────

pub(crate) fn render_guide(ctx: &ProjectContext) -> String {
    // The §9 tool lists and the §3 event vocabulary render from their
    // registries (crate::agent tiers, LedgerKind::ALL), so the guide can
    // never drift from the actual surfaces again — that drift happened three
    // times while the lists were hand-maintained prose.
    let tool_list = |tools: &[&str]| {
        tools.iter().map(|t| format!("`{t}`")).collect::<Vec<_>>().join(" ")
    };
    let kind_list = LedgerKind::ALL
        .iter()
        .map(|k| format!("`{}`", k.as_str()))
        .collect::<Vec<_>>()
        .join(" ");
    // Same discipline for the refusal vocabulary (D104): the prose version
    // omitted `workflow`, so agents branching on `kind` had no case for the
    // gate refusal they meet most often.
    let error_kinds = crate::error::AGENT_ERROR_KINDS
        .iter()
        .map(|(kind, advice)| format!("  - `{kind}` — {advice}"))
        .collect::<Vec<_>>()
        .join("\n");
    GUIDE_TEMPLATE
        .replace("@PROJECT_NAME@", &ctx.name)
        .replace("@READ_TOOLS@", &tool_list(&crate::agent::READ_TOOLS))
        .replace("@WRITE_TOOLS@", &tool_list(&crate::agent::WRITE_TOOLS))
        .replace("@GUARDED_TOOLS@", &tool_list(&crate::agent::GUARDED_TOOLS))
        .replace("@LEDGER_KINDS@", &kind_list)
        .replace("@ERROR_KINDS@", &error_kinds)
        // §3's display cap: prose saying "300" is how the guide and the hub
        // came to quote different numbers in the first place (D104).
        .replace("@SUMMARY_CAP@", &SUMMARY_MAX_CHARS.to_string())
}

/// The session operating protocol (D82). Split out of the guide so the piece
/// an agent re-reads on **every** takeover is small: the guide it points at is
/// reference material, read when the contract is actually needed.
pub(crate) fn render_protocol(ctx: &ProjectContext) -> String {
    PROTOCOL_TEMPLATE.replace("@PROJECT_NAME@", &ctx.name)
}

const PROTOCOL_TEMPLATE: &str = include_str!("../../guide/00-protocol.md");

/// The guide lives in its own markdown file (`guide/01-nextup-guide.md`) so
/// prose edits never touch Rust — embedded at compile time like the built-in
/// templates. Placeholders (`@PROJECT_NAME@`, `@READ_TOOLS@`, `@WRITE_TOOLS@`,
/// `@GUARDED_TOOLS@`, `@LEDGER_KINDS@`, `@ERROR_KINDS@`, `@SUMMARY_CAP@`) are
/// substituted in `render_guide`.
const GUIDE_TEMPLATE: &str = include_str!("../../guide/01-nextup-guide.md");

#[cfg(test)]
mod tests {
    use super::*;
    use crate::security::keystore::StaticKeyProvider;
    use crate::workspace::init::{initialize_project, InitProjectParams};
    use crate::workspace::ops::{add_ledger_note, create_task, update_task_status, NoteChannel};
    use crate::workspace::tasks::NewTask;

    fn workspace() -> (tempfile::TempDir, WorkspacePaths) {
        let dir = tempfile::tempdir().unwrap();
        initialize_project(
            &InitProjectParams {
                root: dir.path().to_string_lossy().into_owned(),
                name: "Handoff test demo".into(),
                domain: "coding".into(),
                description: "Verify the AI handoff layer".into(),
                goals: vec!["Any session can take it over directly".into()],
                boundaries: vec!["Never touch production data".into()],
                ..Default::default()
            },
            &StaticKeyProvider([9u8; 32]),
            "0.1.0",
        )
        .unwrap();
        let paths = WorkspacePaths::new(dir.path());
        (dir, paths)
    }

    #[test]
    fn init_scaffolds_full_bootstrap_layer() {
        let (_g, paths) = workspace();
        assert!(paths.claude_md_file().is_file());
        assert!(paths.agents_md_file().is_file());
        assert!(paths.nextup_guide_file().is_file());
        assert!(paths.memory_index_file().is_file());
        assert!(paths.manifest_file().is_file());
        assert!(paths.work_record_dir().join("_TEMPLATE.md").is_file());
        assert!(paths.mcp_discovery_file().is_file());
        // D82: both skill roots are real files with identical bytes. The
        // mirror is what Claude Code reads; the `.agents/` copy is canonical.
        for (name, _) in WORKSPACE_SKILLS {
            let [(_, canonical), (_, mirror)] = paths.skill_files(name);
            assert!(canonical.is_file(), "skill '{name}' shipped to .agents/skills/");
            assert!(mirror.is_file(), "skill '{name}' mirrored into .claude/skills/");
            assert_eq!(
                std::fs::read(&canonical).unwrap(),
                std::fs::read(&mirror).unwrap(),
                "skill '{name}': the two copies must ship byte-identical"
            );
        }

        // D82 entry-file inversion: the body (and the engine's state block)
        // live in AGENTS.md; CLAUDE.md is a shell whose only job is the
        // import, because Claude Code reads no other name.
        let claude = std::fs::read_to_string(paths.claude_md_file()).unwrap();
        let agents = std::fs::read_to_string(paths.agents_md_file()).unwrap();
        assert!(claude.contains("@AGENTS.md"), "the shell imports the body");
        assert!(
            !claude.contains(STATE_BEGIN),
            "the state block must not live in the shell — the engine rewrites AGENTS.md"
        );
        assert!(claude.len() < 512, "the shell stays a shell (no facts to drift)");
        assert!(agents.contains(STATE_BEGIN) && agents.contains(STATE_END));
        assert!(agents.contains("Directory and document index"), "the index moved with the body");

        // Hub discovery must be valid JSON pointing at the bare PATH binary.
        let discovery: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(paths.mcp_discovery_file()).unwrap())
                .unwrap();
        assert_eq!(discovery["mcpServers"]["nextup"]["command"], "nextup-mcp");
        assert_eq!(discovery["mcpServers"]["nextup"]["args"][1], ".");

        // The app rewrites the command to an absolute path (with backslashes)
        // and it must stay valid JSON, while a user-added server survives.
        let extra = paths.mcp_discovery_file();
        std::fs::write(
            &extra,
            r#"{"mcpServers":{"nextup":{"command":"nextup-mcp","args":["--workspace","."]},"other":{"command":"foo"}}}"#,
        )
        .unwrap();
        let abs = r"C:\tools\nextup\nextup-mcp.exe";
        set_mcp_discovery_command(&paths, abs).unwrap();
        let after: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&extra).unwrap()).unwrap();
        assert_eq!(after["mcpServers"]["nextup"]["command"], abs);
        assert_eq!(after["mcpServers"]["nextup"]["args"][0], "--workspace");
        assert_eq!(after["mcpServers"]["other"]["command"], "foo", "user servers preserved");

        let guide = std::fs::read_to_string(paths.nextup_guide_file()).unwrap();
        assert!(guide.contains("Hub tools"), "guide teaches the hub tool surface");
        assert!(guide.contains("agent_tool_called"));
        // D82: the protocol is its own file now (it is the one thing read every
        // session; the guide is reference material). The guide must point at it
        // and must not carry a copy.
        assert!(!guide.contains("## 0."), "the protocol lives in its own file now");
        assert!(guide.contains("00-protocol.md"), "the guide must point at the protocol");
        let protocol = std::fs::read_to_string(paths.protocol_file()).unwrap();
        assert!(protocol.contains("Session operating protocol"));
        assert!(!protocol.contains("@PROJECT_NAME@"), "placeholder must resolve (D38)");
        // D76: shipping skills is necessary but not sufficient — the protocol is
        // what agents actually execute each session, so it must promote every
        // shipped skill. Field evidence: a managed workspace with all three
        // skills on disk logged 289 ledger events and zero skill activations,
        // because the trigger lived only in skill descriptions.
        for (name, _) in WORKSPACE_SKILLS {
            assert!(protocol.contains(&format!("/{name}")), "the protocol must promote '/{name}'");
        }
        // D19 seed sections: anti-re-pitch + judgment rubric + delegation
        // contract + environment facts + revision-authority tiers.
        assert!(guide.contains("Do not revisit rejected proposals"), "guide teaches the rejected list");
        assert!(guide.contains("record_rejected"));
        assert!(guide.contains("Judgement rubric"));
        assert!(guide.contains("Delegation contract"));
        assert!(guide.contains("Verification is not self-verification"));
        assert!(guide.contains("couldn't determine"), "env facts forbid guessing");
        assert!(guide.contains("Who may change what"));
        // D20: evidence-based flywheel section.
        assert!(guide.contains("Retrospective flywheel"));
        assert!(guide.contains("post_mortem_candidates"));
        assert!(guide.contains("Each lesson goes to exactly one destination"));
        // §9 tool lists render from the tier registry — placeholders resolved
        // and every registered tool present, so the guide can't drift again.
        assert!(!guide.contains("@READ_TOOLS@") && !guide.contains("@WRITE_TOOLS@"));
        assert!(!guide.contains("@GUARDED_TOOLS@"));
        // D63: the guarded five render from GUARDED_TOOLS, never hand copied —
        // a fourth hand-maintained tool list is exactly the drift this
        // placeholder mechanism exists to stop.
        for tool in crate::agent::GUARDED_TOOLS.iter() {
            assert!(guide.contains(&format!("`{tool}`")), "guide §9 must name guarded '{tool}'");
        }
        // Placeholder-zero-residue is what asset fingerprinting (D38) relies
        // on for deterministic re-renders — the name one was unlocked before.
        assert!(!guide.contains("@PROJECT_NAME@") && guide.contains("Handoff test demo"));
        for tool in crate::agent::READ_TOOLS.iter().chain(crate::agent::WRITE_TOOLS.iter()) {
            assert!(guide.contains(&format!("`{tool}`")), "guide §9 must list '{tool}'");
        }

        let claude = std::fs::read_to_string(paths.agents_md_file()).unwrap();
        assert!(claude.contains(STATE_BEGIN));
        assert!(claude.contains("latest_handoff.md"));
        // Index-only (D16): facts point at their sources instead of copies.
        assert!(claude.contains(".nextup/context.json"), "goals/boundaries are pointed at, not copied");
        assert!(!claude.contains("## Project goals"), "no copied goals section");
        assert!(!claude.contains("Session operating protocol"), "protocol lives in the guide (§0)");
        // Initial refresh already populated the state block (init generates handoff).
        assert!(claude.contains("**Status**"));
        assert!(claude.contains("Plan"), "current phase shows in state block");

        let manifest = std::fs::read_to_string(paths.manifest_file()).unwrap();
        assert!(manifest.contains("id: handoff-test-demo"));
        assert!(manifest.contains("phase: Plan"));
        assert!(manifest.contains("progress: 0"));
    }

    /// §3's event vocabulary and §4's gate table must cover the real enums —
    /// the same drift class the tool lists had before their placeholders.
    #[test]
    fn guide_lists_every_ledger_kind_and_gate() {
        let (_g, paths) = workspace();
        let guide = std::fs::read_to_string(paths.nextup_guide_file()).unwrap();
        assert!(!guide.contains("@LEDGER_KINDS@"), "placeholder must be resolved");
        // §3's cap is the display constant itself, not a number retyped in
        // prose — that retyping is what let the hub quote a different one.
        assert!(!guide.contains("@SUMMARY_CAP@"), "placeholder must be resolved");
        assert!(
            guide.contains(&format!("capped at {SUMMARY_MAX_CHARS} characters")),
            "guide §3 must state the real display cap"
        );
        // Module contracts left the main guide in D82 — it must now carry the
        // pointer and none of the content, or a module-less workspace is back
        // to reading rules for capabilities it does not have.
        assert!(
            guide.contains(&format!("{NEXTUP_DOCS_DIR}/{MODULE_GUIDES_SUBDIR}/")),
            "main guide must point at the per-module guides"
        );
        for gone in ["## 16. Collaboration module", "## 17. Team module", "## 18. Spec module"] {
            assert!(!guide.contains(gone), "module contract '{gone}' must live in its own file now");
        }
        let ctx = load_context(&paths.context_file()).unwrap();
        let specs_guide = render_module_guide(crate::workspace::modules::MODULE_SPECS, &ctx)
            .expect("specs module ships a guide");
        assert!(
            specs_guide.contains("rewrite the whole block, this is not a diff"),
            "the MODIFIED full-rewrite iron rule must survive the move to the spec module guide"
        );
        // Whether a delta gets written at all has no engine enforcement (D105):
        // every gate, doctor check and archive step is silent on a missing one,
        // so the protocol prompt is the whole of it — and the protocol is the
        // one file re-read every session, which is why it lives there and not
        // in the on-demand guide. Condition on the tool, not on modules.json:
        // a workspace with the module switched off keeps the file and loses the
        // tool (D104 ②).
        let protocol = render_protocol(&ctx);
        assert!(
            protocol.contains("validate_task_specs"),
            "the protocol must prompt for the spec delta — nothing downstream will"
        );
        // Every other guard on this file asks "is this string present", which
        // an edit that swallows a whole numbered step passes untouched: D105
        // appended a sentence to step 3 without its trailing newline and step 4
        // — the `done`/`set_task_verification` contract — vanished into the
        // paragraph. Green tests, green check:docs, real workspaces shipping a
        // list that read 1,2,3,5,6,7,8. So the *shape* gets a guard too.
        let steps: Vec<usize> = protocol
            .lines()
            .filter_map(|l| l.split_once(". ").and_then(|(n, _)| n.parse().ok()))
            .collect();
        assert!(steps.len() >= 8, "the protocol lost steps: only {steps:?} survived");
        assert!(
            steps.iter().enumerate().all(|(i, n)| *n == i + 1),
            "protocol steps must run 1..N with none swallowed by the step above: {steps:?}"
        );
        for kind in LedgerKind::ALL {
            assert!(
                guide.contains(&format!("`{}`", kind.as_str())),
                "guide §3 must list ledger kind '{}'",
                kind.as_str()
            );
        }
        // Gate wire names come from serde's tag — the single source of truth.
        use crate::workspace::workflow::Gate;
        let gates = [
            Gate::MinTasks { count: 1 },
            Gate::AllTasksDone,
            Gate::NoBlockedTasks,
            Gate::ArtifactExists { path: "x".into() },
            Gate::MinDecisions { count: 1 },
            Gate::ManualConfirm { prompt: "p".into() },
            Gate::DoctorClean,
        ];
        for gate in &gates {
            let kind = serde_json::to_value(gate).unwrap()["kind"].as_str().unwrap().to_owned();
            assert!(guide.contains(&format!("`{kind}")), "guide §4 must list gate '{kind}'");
        }
    }

    /// §9 tells agents to branch on `kind` and never on message text, so the
    /// list of kinds is a contract. It is generated from `AGENT_ERROR_KINDS`
    /// (D104) after the prose version lost `workflow` — the refusal an agent
    /// meets whenever an exit gate is not satisfied.
    ///
    /// What this locks: every documented kind is one the code really produces
    /// (a renamed variant cannot leave a ghost entry behind), the six known
    /// agent-reachable refusals all stay documented, and the placeholder
    /// resolves. What it cannot lock: a *new* variant that a future hub tool
    /// returns — `refusals` below is hand-built, so adding one means adding it
    /// here too.
    #[test]
    fn guide_documents_every_refusal_an_agent_can_act_on() {
        use crate::error::{NextUpError, AGENT_ERROR_KINDS};
        let (_g, paths) = workspace();
        let guide = std::fs::read_to_string(paths.nextup_guide_file()).unwrap();
        assert!(!guide.contains("@ERROR_KINDS@"), "placeholder must be resolved");

        let refusals = [
            NextUpError::Unauthorized("tool".into()),
            NextUpError::InvalidInput("arg".into()),
            NextUpError::NotFound("T-9999".into()),
            NextUpError::Workflow("exit gates not satisfied: min_tasks(3) [1/3]".into()),
            NextUpError::DependenciesUnmet {
                id: "T-0002".into(),
                to: "in_progress".into(),
                blocking: vec![],
            },
            NextUpError::AlreadyClaimed { id: "T-0002".into(), current_assignee: "peer".into() },
        ];
        for error in &refusals {
            assert!(
                AGENT_ERROR_KINDS.iter().any(|(kind, _)| *kind == error.kind()),
                "'{}' is a refusal an agent can act on — guide §9 must carry it",
                error.kind()
            );
        }
        for (kind, _) in AGENT_ERROR_KINDS {
            assert!(
                refusals.iter().any(|e| e.kind() == kind),
                "guide §9 documents '{kind}', which no error variant produces"
            );
            assert!(guide.contains(&format!("`{kind}`")), "guide §9 must render '{kind}'");
        }

        // The IPC-only refusals must stay out: they are real, but the agent
        // tool surface has no delete and no archive, so an agent cannot meet
        // them (D60). If either becomes reachable, document it then.
        for ipc_only in ["has_dependents", "spec_fold_conflict"] {
            assert!(
                !AGENT_ERROR_KINDS.iter().any(|(kind, _)| *kind == ipc_only),
                "'{ipc_only}' is IPC-only — documenting it teaches a case that never arrives"
            );
        }
    }

    /// Adding a module without its guide would ship an agent a capability with
    /// no contract — the exact gap D82 closed. The registries must stay paired.
    #[test]
    fn every_known_module_has_a_guide() {
        use crate::workspace::modules::KNOWN_MODULES;
        assert_eq!(MODULE_GUIDES.len(), KNOWN_MODULES.len());
        let ctx = ProjectContext::new("Guide render demo", "coding", "", vec![], vec![]);
        for module in KNOWN_MODULES {
            let rendered = render_module_guide(module, &ctx)
                .unwrap_or_else(|| panic!("module '{module}' ships no guide"));
            assert!(
                !rendered.contains("@PROJECT_NAME@"),
                "module guide '{module}' must resolve its placeholder (D38 re-render determinism)"
            );
            assert!(
                rendered.contains("Guide render demo"),
                "module guide '{module}' must carry the project name"
            );
        }
        assert!(render_module_guide("no-such-module", &ctx).is_none());
    }

    /// The batch's whole point: a workspace carries the contracts for the
    /// modules it enabled and **nothing** for the ones it did not.
    #[test]
    fn module_guides_ship_only_for_enabled_modules() {
        use crate::workspace::modules::{MODULE_COLLAB, MODULE_SPECS, MODULE_TEAM};
        let dir = tempfile::tempdir().unwrap();
        initialize_project(
            &InitProjectParams {
                root: dir.path().to_string_lossy().into_owned(),
                name: "Module guide demo".into(),
                domain: "coding".into(),
                description: "One module on".into(),
                goals: vec!["ship only what applies".into()],
                boundaries: vec![],
                modules: vec![MODULE_COLLAB.to_string()],
                ..Default::default()
            },
            &StaticKeyProvider([9u8; 32]),
            "0.1.0",
        )
        .unwrap();
        let paths = WorkspacePaths::new(dir.path());
        assert!(paths.module_guide_file(MODULE_COLLAB).is_file(), "enabled module ships its guide");
        assert!(!paths.module_guide_file(MODULE_TEAM).is_file(), "disabled module ships nothing");
        assert!(!paths.module_guide_file(MODULE_SPECS).is_file(), "disabled module ships nothing");

        // The STATE block names exactly what applies, so the takeover surface
        // and the directory listing can never disagree.
        let claude = std::fs::read_to_string(paths.agents_md_file()).unwrap();
        assert!(claude.contains("**Module guides**"));
        assert!(claude.contains("modules/collab.md"));
        assert!(!claude.contains("modules/team.md"));
    }

    /// A workspace with nothing enabled must say nothing about modules — no
    /// guide files and no STATE line.
    #[test]
    fn a_module_less_workspace_carries_no_module_material() {
        let (_g, paths) = workspace();
        assert!(!paths.module_guides_dir().exists(), "no module dir when nothing is enabled");
        let claude = std::fs::read_to_string(paths.agents_md_file()).unwrap();
        assert!(!claude.contains("**Module guides**"));
    }

    /// A corrupt .mcp.json must be a hard error — silently replacing it with
    /// `{}` would destroy the user's other mcpServers entries.
    /// Adopting a repo that already has its own CLAUDE.md is the adopt
    /// wizard's main case. Without the appended import Claude Code reads that
    /// file and loads none of the takeover layer — a workspace that looks
    /// initialised and is functionally empty to the one host it targets.
    #[test]
    fn adopting_a_repo_with_its_own_claude_md_gains_the_import_and_keeps_the_text() {
        let (_g, paths) = workspace();
        let mine = "# My own project\n\nNotes I wrote, and a fence:\n\n```\n@AGENTS.md\n```\n";
        std::fs::write(paths.claude_md_file(), mine).unwrap();

        let ctx = load_context(&paths.context_file()).unwrap();
        let created = scaffold(&paths, &ctx).unwrap();

        let after = std::fs::read_to_string(paths.claude_md_file()).unwrap();
        assert!(after.starts_with(mine), "every byte the human wrote survives, in order");
        assert!(imports_agents_md(&after), "and the body is now reachable");
        assert!(
            created.iter().any(|c| c.contains("@AGENTS.md")),
            "the edit is reported, not silent: {created:?}"
        );
        // The fenced mention must not have counted as an import — otherwise
        // this repo would have been left broken.
        assert!(!imports_agents_md(mine), "a fenced import is not a live one");

        // Idempotent: the app re-runs scaffold on every repair press.
        let again = scaffold(&paths, &ctx).unwrap();
        assert!(!again.iter().any(|c| c.contains("@AGENTS.md")), "second run is a no-op");
        assert_eq!(std::fs::read_to_string(paths.claude_md_file()).unwrap(), after);
    }

    #[test]
    fn corrupt_mcp_discovery_is_rejected_not_replaced() {
        let (_g, paths) = workspace();
        std::fs::write(paths.mcp_discovery_file(), b"{\"mcpServers\": {oops}").unwrap();
        let err = set_mcp_discovery_command(&paths, "whatever").unwrap_err();
        assert_eq!(err.kind(), "invalid_input");
        assert!(err.to_string().contains(".mcp.json"), "error names the file: {err}");
        // File untouched.
        assert_eq!(
            std::fs::read(paths.mcp_discovery_file()).unwrap(),
            b"{\"mcpServers\": {oops}"
        );

        // Non-object top level is likewise refused.
        std::fs::write(paths.mcp_discovery_file(), b"[1,2,3]").unwrap();
        assert_eq!(set_mcp_discovery_command(&paths, "x").unwrap_err().kind(), "invalid_input");
    }

    #[test]
    fn refresh_updates_block_but_preserves_session_edits() {
        let (_g, paths) = workspace();
        // A session appends its own curated section outside the markers.
        let mut claude = std::fs::read_to_string(paths.agents_md_file()).unwrap();
        claude.push_str("\n## 手寫區\n- 這行是 session 加的,引擎不准動\n");
        std::fs::write(paths.agents_md_file(), &claude).unwrap();

        let id = create_task(&paths, "0.1.0", NewTask { title: "第一個任務".into(), priority: 0, ..Default::default() },
        )
        .unwrap()
        .id;
        update_task_status(&paths, "0.1.0", &id, TaskStatus::InProgress, None).unwrap();

        let updated = std::fs::read_to_string(paths.agents_md_file()).unwrap();
        assert!(updated.contains("這行是 session 加的"), "content outside markers survives");
        assert!(updated.contains("第一個任務"), "state block reflects the new task");
        assert!(updated.contains("▶"), "in-progress marker rendered");
    }

    #[test]
    fn refresh_skips_when_markers_removed() {
        let (_g, paths) = workspace();
        std::fs::write(paths.agents_md_file(), "# 完全自訂的 CLAUDE.md\n").unwrap();
        create_task(&paths, "0.1.0", NewTask { title: "t".into(), priority: 1, ..Default::default() },
        )
        .unwrap();
        let content = std::fs::read_to_string(paths.agents_md_file()).unwrap();
        assert_eq!(content, "# 完全自訂的 CLAUDE.md\n", "no markers -> engine keeps hands off");
    }

    #[test]
    fn decisions_show_up_in_state_block() {
        let (_g, paths) = workspace();
        add_ledger_note(&paths, "0.1.0", NoteChannel::Decision, "決定採用 rmcp 作為 MCP SDK").unwrap();
        let claude = std::fs::read_to_string(paths.agents_md_file()).unwrap();
        assert!(claude.contains("決定採用 rmcp 作為 MCP SDK"));
    }

    /// D78: progress entries render in their own Last progress section, right
    /// where a takeover looks first — and never leak into Recent decisions.
    #[test]
    fn progress_renders_in_its_own_state_section() {
        let (_g, paths) = workspace();
        add_ledger_note(&paths, "0.1.0", NoteChannel::Progress, "工單鏈路落地,下輪走實機驗證")
            .unwrap();
        let claude = std::fs::read_to_string(paths.agents_md_file()).unwrap();
        assert!(claude.contains("**Last progress**"));
        assert!(claude.contains("工單鏈路落地,下輪走實機驗證"));
        assert!(!claude.contains("**Recent decisions**"), "a progress entry is not a decision");
    }

    /// The state block must say which of its fields it stands behind. Counts
    /// and gates are recomputed every write; progress notes and blocker
    /// reasons are quoted prose that nothing re-checks. Unlabelled, the two
    /// read identically and the stale half inherits the engine's credibility.
    #[test]
    fn state_block_marks_the_fields_nothing_re_checks() {
        let (_g, paths) = workspace();
        add_ledger_note(&paths, "0.1.0", NoteChannel::Progress, "折疊完成,等人封存").unwrap();
        let t = create_task(
            &paths,
            "0.1.0",
            NewTask { title: "wire the export".into(), priority: 1, ..Default::default() },
        )
        .unwrap();
        update_task_status(&paths, "0.1.0", &t.id, TaskStatus::Blocked, Some("等 API 金鑰".into()))
            .unwrap();

        let claude = std::fs::read_to_string(paths.agents_md_file()).unwrap();
        assert!(claude.contains("**Last progress** (verbatim from the session"), "{claude}");
        assert!(claude.contains("nothing re-checks them"), "{claude}");
        // The engine-computed neighbour keeps saying so, which is what makes
        // the distinction readable rather than decorative.
        assert!(claude.contains("evaluated by the engine against real state"), "{claude}");
        // A blocker reason arrives dated, so its age is visible at a glance.
        let blocked_at = TaskStore::new(paths.tasks_dir())
            .get(&t.id)
            .unwrap()
            .blocked_at
            .expect("blocked tasks carry a date");
        assert!(claude.contains(&format!("`{blocked_at}` reason: 等 API 金鑰")), "{claude}");
    }

    /// Rejections have their own home (the do-not-revisit list) and must not
    /// crowd the decision window, which shows only a handful: a session that
    /// dutifully records what it turned down would otherwise push every real
    /// decision off the takeover surface.
    #[test]
    fn rejections_do_not_crowd_recent_decisions() {
        let (_g, paths) = workspace();
        add_ledger_note(&paths, "0.1.0", NoteChannel::Decision, "決定採用檔案為真相來源").unwrap();
        for i in 0..STATE_BLOCK_DECISIONS {
            crate::workspace::ops::add_rejected(&paths, "0.1.0", &format!("方案 {i}"), "成本過高")
                .unwrap();
        }
        let claude = std::fs::read_to_string(paths.agents_md_file()).unwrap();
        assert!(
            claude.contains("決定採用檔案為真相來源"),
            "the real decision must survive a burst of rejections: {claude}"
        );
        assert!(!claude.contains("rejected alternative"), "{claude}");
    }

    /// D78 lens-bound invariant: a full decision window of pathological
    /// (10k-char, CJK) entries plus an equally verbose task must leave the
    /// engine-owned state block bounded — a real workspace reached 14.5 KB
    /// from three verbose decisions before the clamp existed.
    /// Whoever removes the clamp turns this red.
    #[test]
    fn state_block_stays_bounded_with_pathological_entries() {
        let (_g, paths) = workspace();
        let huge = "廢".repeat(10_000); // one line, no newline: hits the hard cap
        for _ in 0..STATE_BLOCK_DECISIONS {
            add_ledger_note(&paths, "0.1.0", NoteChannel::Decision, &huge).unwrap();
        }
        create_task(
            &paths,
            "0.1.0",
            NewTask { title: huge.clone(), priority: 0, ..Default::default() },
        )
        .unwrap();

        let claude = std::fs::read_to_string(paths.agents_md_file()).unwrap();
        let begin = claude.find(STATE_BEGIN).unwrap();
        let end = claude.find(STATE_END).unwrap();
        let block = &claude[begin..end];
        assert!(
            block.len() < 8 * 1024,
            "state block must stay bounded under pathological input (got {} bytes)",
            block.len()
        );
        assert!(block.contains("…(full text in the ledger)"), "cut entries must point at the full text");
    }

    /// The shipped skills are the dev repo's own files, so a careless edit
    /// there would silently export repo-only workflow into every workspace.
    /// Two guards: frontmatter `name:` matches the shipped directory name,
    /// and no repo-specific token leaks in (those facts live in the dev
    /// repo's nextup_docs, which workspaces don't have).
    #[test]
    fn shipped_skills_stay_generic() {
        const REPO_ONLY_TOKENS: [&str; 10] = [
            "progress-log",
            "land-feature",
            "agent-e2e",
            "nextup-core",
            "src-tauri",
            "lib.rs",
            "agent.rs",
            "walkthrough table",
            // Concrete toolchain commands are project facts too — a generic
            // skill says "run the project's health check", never names one.
            "cargo",
            "pnpm",
        ];
        for (name, content) in WORKSPACE_SKILLS {
            assert!(
                content.contains(&format!("name: {name}")),
                "skill '{name}' frontmatter name matches its directory"
            );
            // Case-insensitive: `str::contains` would let "Cargo" through a
            // guard listing "cargo", and the point is the concept, not the
            // capitalisation.
            let lowered = content.to_lowercase();
            for token in REPO_ONLY_TOKENS {
                assert!(
                    !lowered.contains(&token.to_lowercase()),
                    "skill '{name}' must stay generic: found repo-only token '{token}'"
                );
            }
        }
    }

    #[test]
    fn scaffold_recreates_missing_skill_with_relative_name() {
        let (_g, paths) = workspace();
        std::fs::remove_file(paths.skill_file("wrap-up")).unwrap();
        let ctx = load_context(&paths.context_file()).unwrap();
        let created = scaffold(&paths, &ctx).unwrap();
        assert_eq!(created, vec![".claude/skills/wrap-up/SKILL.md".to_string()]);
        // A user-customized skill is never overwritten.
        std::fs::write(paths.skill_file("handoff-check"), "customized\n").unwrap();
        scaffold(&paths, &ctx).unwrap();
        assert_eq!(
            std::fs::read_to_string(paths.skill_file("handoff-check")).unwrap(),
            "customized\n"
        );
    }

    #[test]
    fn scaffold_is_idempotent_and_non_destructive() {
        let (_g, paths) = workspace();
        std::fs::write(paths.agents_md_file(), "custom agents file\n").unwrap();
        let ctx = load_context(&paths.context_file()).unwrap();
        let created = scaffold(&paths, &ctx).unwrap();
        assert!(created.is_empty(), "everything exists; nothing recreated");
        assert_eq!(
            std::fs::read_to_string(paths.agents_md_file()).unwrap(),
            "custom agents file\n"
        );
    }

    #[test]
    fn scaffold_fills_only_missing_files() {
        let (_g, paths) = workspace();
        std::fs::remove_file(paths.memory_index_file()).unwrap();
        std::fs::remove_file(paths.agents_md_file()).unwrap();
        let ctx = load_context(&paths.context_file()).unwrap();
        let mut created = scaffold(&paths, &ctx).unwrap();
        created.sort();
        assert_eq!(created, vec!["AGENTS.md".to_string(), "MEMORY.md".to_string()]);
    }

}
