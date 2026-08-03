//! Handoff snapshot: the four-section takeover contract rendered to
//! `.nextup/snapshots/latest_handoff.md`.
//!
//! `render_handoff` is a pure function over [`HandoffInput`] (unit-testable
//! without a workspace); [`generate_handoff`] gathers state, renders, persists
//! and — per the D24 continuity contract — refreshes the bootstrap surfaces
//! (CLAUDE.md state block, manifest) so every entry point stays in lockstep.
//! `bootstrap::refresh` must never call back into this module (recursion).

use std::fmt::Write as _;

use crate::error::Result;
use crate::workspace::context::ProjectContext;
use crate::workspace::layout::WorkspacePaths;
use crate::workspace::ledger::{clamp_line, LedgerEvent, SUMMARY_MAX_CHARS};
use crate::workspace::tasks::{compute_counts, Task, TaskStatus};
use crate::workspace::workflow::{gate_label, WorkflowStatus};

pub(crate) const RECENT_EVENTS: usize = 15;
pub(crate) const RECENT_DECISIONS: usize = 10;
/// `progress` entries shown in §2's lead block (D78): a session summary only
/// matters until the next few sessions have absorbed it, so the window is
/// deliberately small.
pub(crate) const RECENT_PROGRESS: usize = 3;
const NEXT_STEPS: usize = 10;

/// Everything the renderer needs, gathered up front so `render_handoff`
/// stays a pure, unit-testable function.
pub struct HandoffInput<'a> {
    pub context: &'a ProjectContext,
    pub tasks: &'a [Task],
    pub recent_events: &'a [LedgerEvent],
    pub decisions: &'a [LedgerEvent],
    /// Newest few `progress` entries (D78) — where the last session stopped.
    pub progress: &'a [LedgerEvent],
    /// Live harness status; `None` for legacy workspaces without workflow.json.
    pub workflow: Option<&'a WorkflowStatus>,
    pub app_version: &'a str,
    pub generated_at: String,
}

/// Regenerate every takeover surface and return the fresh snapshot markdown.
/// The name is historical shorthand — this writes the snapshot, ledgers it
/// AND refreshes the CLAUDE.md state block + manifest. It is a thin alias for
/// [`crate::workspace::sync::sync_after_mutation`]; see that module for the
/// full contract.
pub fn generate_handoff(paths: &WorkspacePaths, app_version: &str) -> Result<String> {
    Ok(crate::workspace::sync::sync_after_mutation(paths, app_version)?.handoff)
}

/// One ledger message reduced to lens size (D78): first line, hard cap, and
/// an explicit pointer when anything was cut — a shortened surface must never
/// look complete. The full text stays in the append-only ledger.
fn lens_line(text: &str) -> String {
    let (line, cut) = clamp_line(text, SUMMARY_MAX_CHARS);
    if cut {
        format!("{line} … (full text in ledger)")
    } else {
        line.to_string()
    }
}

/// Task-side strings (title, blocked reason) get the same bound but a bare
/// ellipsis — their full text lives in the task file, not the ledger.
fn lens_title(text: &str) -> String {
    let (line, cut) = clamp_line(text, SUMMARY_MAX_CHARS);
    if cut {
        format!("{line} …")
    } else {
        line.to_string()
    }
}

/// Pure renderer for the four mandatory sections of the handoff contract.
pub fn render_handoff(input: &HandoffInput<'_>) -> String {
    let mut md = String::with_capacity(4096);
    let ctx = input.context;
    let counts = compute_counts(input.tasks);

    let _ = writeln!(md, "# Agent NextUp Handoff Snapshot");
    let _ = writeln!(md);
    let _ = writeln!(
        md,
        "> Generated: {} · App: v{} · Schema: v{}",
        input.generated_at, input.app_version, ctx.schema_version
    );
    let _ = writeln!(
        md,
        "> Bootstrap rule: a new AI session must read this file first, then follow `.nextup/rules.json`."
    );

    // ── 1. Current system state & architecture summary ─────────────────────
    let _ = writeln!(md, "\n## 1. Current System State & Architecture Summary\n");
    let _ = writeln!(md, "- **Project:** {} (domain: {})", ctx.name, ctx.domain);
    if !ctx.description.trim().is_empty() {
        let _ = writeln!(md, "- **Description:** {}", ctx.description.trim());
    }
    let unverified_suffix = if counts.done_unverified > 0 {
        format!(" ({} done but unverified)", counts.done_unverified)
    } else {
        String::new()
    };
    let _ = writeln!(
        md,
        "- **Task state:** {} total — {} todo / {} in progress / {} blocked / {} done{}",
        counts.total, counts.todo, counts.in_progress, counts.blocked, counts.done,
        unverified_suffix
    );
    if let Some(ws) = input.workflow {
        let phase_title = ws
            .workflow
            .phases
            .get(ws.current_index)
            .map(|p| p.title.as_str())
            .unwrap_or("?");
        if ws.workflow.state.completed {
            let _ = writeln!(
                md,
                "- **Workflow:** COMPLETED — all {} phases done (template: {})",
                ws.total_phases, ws.workflow.template_name
            );
        } else {
            let unmet = ws.gates.iter().filter(|g| !g.passed).count();
            let _ = writeln!(
                md,
                "- **Workflow phase:** {} ({}/{}, template: {}) — {} exit gate(s) unmet",
                phase_title,
                ws.current_index + 1,
                ws.total_phases,
                ws.workflow.template_name,
                unmet
            );
        }
    }
    if !ctx.goals.is_empty() {
        let _ = writeln!(md, "- **Goals:**");
        for goal in &ctx.goals {
            let _ = writeln!(md, "  - {}", lens_title(goal));
        }
    }
    if !ctx.boundaries.is_empty() {
        let _ = writeln!(md, "- **Boundaries (do not cross):**");
        for boundary in &ctx.boundaries {
            let _ = writeln!(md, "  - {}", lens_title(boundary));
        }
    }
    if !ctx.rejected.is_empty() {
        let _ = writeln!(md, "- **Rejected alternatives (do NOT re-pitch without new facts):**");
        for r in &ctx.rejected {
            let _ = writeln!(md, "  - {} — {}", lens_title(&r.proposal), lens_title(&r.reason));
        }
    }
    if !ctx.milestones.is_empty() {
        let _ = writeln!(md, "- **Milestones:**");
        for m in &ctx.milestones {
            let verification = match (m.done, m.verified) {
                (true, true) => ", verified",
                (true, false) => ", unverified",
                _ => "",
            };
            let _ = writeln!(
                md,
                "  - [{}] {} ({}{})",
                if m.done { "x" } else { " " },
                lens_title(&m.title),
                m.id,
                verification
            );
        }
    }

    // ── 2. Context delta / recent ledger ───────────────────────────────────
    let _ = writeln!(md, "\n## 2. Context Delta / Recent Ledger\n");
    // Where the last session stopped, before the raw event stream (D78) —
    // the first thing a takeover reads after the system state.
    if !input.progress.is_empty() {
        let _ = writeln!(md, "**Last progress (newest {} `progress` entries):**", RECENT_PROGRESS);
        for event in input.progress {
            let _ = writeln!(md, "- `{}` {}", event.at, lens_line(&event.message));
        }
        let _ = writeln!(md);
    }
    let visible: Vec<&LedgerEvent> = input
        .recent_events
        .iter()
        .filter(|e| !e.kind.is_noise())
        .collect();
    let visible = &visible[visible.len().saturating_sub(RECENT_EVENTS)..];
    if visible.is_empty() {
        let _ = writeln!(md, "_No recorded activity yet._");
    } else {
        for event in visible {
            let task_ref = event
                .task_id
                .as_deref()
                .map(|id| format!(" [{id}]"))
                .unwrap_or_default();
            let _ = writeln!(
                md,
                "- `{}` **{:?}**{}: {}",
                event.at,
                event.kind,
                task_ref,
                lens_line(&event.message)
            );
        }
    }

    // ── 3. Next immediate steps ─────────────────────────────────────────────
    let _ = writeln!(md, "\n## 3. Next Immediate Steps\n");
    if let Some(ws) = input.workflow {
        if ws.workflow.state.completed {
            let _ = writeln!(
                md,
                "**Workflow completed.** Run a post-mortem review or start the next cycle.\n"
            );
        } else if let Some(phase) = ws.workflow.phases.get(ws.current_index) {
            let _ = writeln!(md, "**Current phase: {}** — {}", phase.title, phase.description);
            if !phase.ai_instructions.is_empty() {
                let _ = writeln!(md, "\nPhase directives (follow in order):");
                for instruction in &phase.ai_instructions {
                    let _ = writeln!(md, "- {instruction}");
                }
            }
            if !ws.gates.is_empty() {
                let _ = writeln!(md, "\nExit gates (must pass before advancing):");
                for gate in &ws.gates {
                    let _ = writeln!(
                        md,
                        "- [{}] {} — {}",
                        if gate.passed { "x" } else { " " },
                        gate_label(&gate.gate),
                        gate.observed
                    );
                }
            }
            let _ = writeln!(md);
        }
    }
    // Selection & ordering live in tasks::next_steps, shared with the
    // CLAUDE.md state block so the two surfaces can never disagree.
    let next = crate::workspace::tasks::next_steps(input.tasks);
    if next.is_empty() {
        let _ = writeln!(md, "_No open tasks. Define the next atomic tasks in `tasks/`._");
    } else {
        for task in next.iter().take(NEXT_STEPS) {
            let marker = if task.status == TaskStatus::InProgress { "▶" } else { "·" };
            let _ = writeln!(
                md,
                "- {} **[P{}] {}** — {}",
                marker,
                task.priority,
                task.id,
                lens_title(&task.title)
            );
        }
    }

    // ── 4. Current blockers / technical decisions ──────────────────────────
    let _ = writeln!(md, "\n## 4. Current Blockers / Technical Decisions\n");
    let blocked = crate::workspace::tasks::blocked(input.tasks);
    if blocked.is_empty() {
        let _ = writeln!(md, "**Blockers:** none.");
    } else {
        // Dated and caveated for the same reason the state block does it
        // (01 invariant 14): nothing recomputes a blocker, so a reason is a
        // claim as of when it was typed. This is the *other* takeover surface
        // — leaving it bare here would mean the caveat depended on which of
        // the two a session happened to read.
        let _ = writeln!(md, "**Blockers** (reasons as stated when blocked; nothing re-checks them):");
        for task in blocked {
            let stamp =
                task.blocked_at.as_deref().map(|at| format!("{at} ")).unwrap_or_default();
            let _ = writeln!(
                md,
                "- {} — {} ({}reason: {})",
                task.id,
                lens_title(&task.title),
                stamp,
                lens_title(task.blocked_reason.as_deref().unwrap_or("unspecified"))
            );
        }
    }
    // Completion claims nobody has checked yet: the next session must treat
    // these as assumptions to re-verify, not as established facts.
    let unverified_tasks: Vec<&Task> = input
        .tasks
        .iter()
        .filter(|t| t.status == TaskStatus::Done && !t.is_verified())
        .collect();
    let unverified_milestones: Vec<_> =
        ctx.milestones.iter().filter(|m| m.done && !m.verified).collect();
    let _ = writeln!(md);
    if unverified_tasks.is_empty() && unverified_milestones.is_empty() {
        let _ = writeln!(md, "**Unverified done work:** none.");
    } else {
        let _ = writeln!(
            md,
            "**Unverified done work** (completion claimed but not checked — verify before building on it):"
        );
        for task in unverified_tasks {
            let _ = writeln!(md, "- {} — {}", task.id, lens_title(&task.title));
        }
        for m in unverified_milestones {
            let _ = writeln!(md, "- {} — {} (milestone)", m.id, lens_title(&m.title));
        }
    }
    let _ = writeln!(md);
    if input.decisions.is_empty() {
        let _ = writeln!(md, "**Decisions:** none recorded this cycle.");
    } else {
        let _ = writeln!(md, "**Decisions:**");
        for decision in input.decisions {
            let _ = writeln!(md, "- `{}` {}", decision.at, lens_line(&decision.message));
        }
    }

    // The snapshot is a window, not an archive — say where the rest lives so
    // no session mistakes "not shown here" for "never happened" (D78).
    let _ = writeln!(md);
    let _ = writeln!(
        md,
        "> Older events/decisions: `search_workspace` (FTS5) or the App's history view; \
         `.nextup/ledger.jsonl` keeps every full entry."
    );

    md
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workspace::ledger::{Ledger, LedgerKind};
    use crate::workspace::tasks::{NewTask, TaskStore};

    fn sample_context() -> ProjectContext {
        ProjectContext::new(
            "Agent NextUp",
            "coding",
            "a sample project used by the render tests",
            vec!["ship phase 2".into()],
            vec!["no vendor lock-in".into()],
        )
    }

    fn render(tasks: &[Task], events: &[LedgerEvent], decisions: &[LedgerEvent]) -> String {
        render_handoff(&HandoffInput {
            context: &sample_context(),
            tasks,
            recent_events: events,
            decisions,
            progress: &[],
            workflow: None,
            app_version: "0.1.0",
            generated_at: "2026-07-06T00:00:00Z".into(),
        })
    }

    /// D78: progress entries lead §2 so a takeover reads "where the last
    /// session stopped" before the raw event stream; absent entries render
    /// no header at all.
    #[test]
    fn progress_leads_section_two() {
        let progress =
            LedgerEvent::new(LedgerKind::Progress, "landed the sweep; verify pass next", None);
        let md = render_handoff(&HandoffInput {
            context: &sample_context(),
            tasks: &[],
            recent_events: &[],
            decisions: &[],
            progress: &[progress],
            workflow: None,
            app_version: "0.1.0",
            generated_at: "2026-07-06T00:00:00Z".into(),
        });
        assert!(md.contains("**Last progress"));
        assert!(md.contains("landed the sweep; verify pass next"));
        let header = md.find("## 2.").unwrap();
        let prog = md.find("**Last progress").unwrap();
        let stream_or_empty =
            md.find("_No recorded activity yet._").unwrap_or(usize::MAX);
        assert!(header < prog && prog < stream_or_empty, "progress renders at the top of §2");

        let without = render(&[], &[], &[]);
        assert!(!without.contains("**Last progress"), "no entries -> no header");
    }

    #[test]
    fn contains_all_four_mandatory_sections() {
        let md = render(&[], &[], &[]);
        assert!(md.contains("## 1. Current System State & Architecture Summary"));
        assert!(md.contains("## 2. Context Delta / Recent Ledger"));
        assert!(md.contains("## 3. Next Immediate Steps"));
        assert!(md.contains("## 4. Current Blockers / Technical Decisions"));
    }

    /// D78 lens-bound invariant: the snapshot size is engine-guaranteed no
    /// matter how verbose a session gets — full windows of pathological
    /// (10k-char, CJK) entries in every free-form slot must still render
    /// bounded, and every cut ledger line must say where the full text lives.
    /// Whoever removes the clamp turns this red.
    #[test]
    fn snapshot_stays_bounded_with_pathological_entries() {
        let huge = "廢".repeat(10_000); // one line, no newline: hits the hard cap
        let dir = tempfile::tempdir().unwrap();
        let store = TaskStore::new(dir.path());
        let t = store
            .create(NewTask { title: huge.clone(), priority: 0, ..Default::default() })
            .unwrap();
        store.update_status(&t.id, TaskStatus::Blocked, Some(huge.clone())).unwrap();

        let events: Vec<LedgerEvent> = (0..RECENT_EVENTS)
            .map(|_| LedgerEvent::new(LedgerKind::Note, huge.clone(), None))
            .collect();
        let decisions: Vec<LedgerEvent> = (0..RECENT_DECISIONS)
            .map(|_| LedgerEvent::new(LedgerKind::Decision, huge.clone(), None))
            .collect();

        let md = render(&store.list().unwrap(), &events, &decisions);
        assert!(
            md.len() < 32 * 1024,
            "snapshot must stay bounded under pathological input (got {} bytes)",
            md.len()
        );
        assert!(
            md.contains("… (full text in ledger)"),
            "cut ledger entries must point at the full text"
        );
        assert!(md.contains("`search_workspace`"), "history signpost must be present");
    }

    #[test]
    fn blockers_and_decisions_are_listed() {
        let dir = tempfile::tempdir().unwrap();
        let store = TaskStore::new(dir.path());
        let t = store
            .create(NewTask { title: "hook up MCP".into(), priority: 0, ..Default::default() })
            .unwrap();
        store
            .update_status(&t.id, TaskStatus::Blocked, Some("SDK release pending".into()))
            .unwrap();
        let tasks = store.list().unwrap();

        let decision = LedgerEvent::new(LedgerKind::Decision, "adopt rmcp for MCP", None);
        let md = render(&tasks, &[], &[decision]);
        assert!(md.contains("SDK release pending"));
        assert!(md.contains("adopt rmcp for MCP"));
    }

    #[test]
    fn in_progress_tasks_lead_next_steps() {
        let dir = tempfile::tempdir().unwrap();
        let store = TaskStore::new(dir.path());
        store
            .create(NewTask { title: "low prio todo".into(), priority: 0, ..Default::default() })
            .unwrap();
        let b = store
            .create(NewTask { title: "active work".into(), priority: 3, ..Default::default() })
            .unwrap();
        store.update_status(&b.id, TaskStatus::InProgress, None).unwrap();

        let md = render(&store.list().unwrap(), &[], &[]);
        let active = md.find("active work").unwrap();
        let todo = md.find("low prio todo").unwrap();
        assert!(active < todo, "in-progress task must be listed before todos");
    }

    #[test]
    fn unverified_done_work_is_listed_explicitly() {
        let dir = tempfile::tempdir().unwrap();
        let store = TaskStore::new(dir.path());
        let claimed = store
            .create(NewTask { title: "claimed done".into(), priority: 0, ..Default::default() })
            .unwrap();
        let checked = store
            .create(NewTask { title: "checked done".into(), priority: 0, ..Default::default() })
            .unwrap();
        store.update_status(&claimed.id, TaskStatus::Done, None).unwrap();
        store.update_status(&checked.id, TaskStatus::Done, None).unwrap();
        store.set_verification(&checked.id, true, Some("live run observed".into())).unwrap();

        let mut ctx = sample_context();
        ctx.milestones.push(crate::workspace::context::Milestone {
            id: "M-0001".into(),
            title: "beta".into(),
            done: true,
            verified: false,
        });

        let md = render_handoff(&HandoffInput {
            context: &ctx,
            tasks: &store.list().unwrap(),
            recent_events: &[],
            decisions: &[],
            progress: &[],
            workflow: None,
            app_version: "0.1.0",
            generated_at: "2026-07-07T00:00:00Z".into(),
        });

        assert!(md.contains("2 done (1 done but unverified)"));
        assert!(md.contains("**Unverified done work**"));
        assert!(md.contains(&format!("- {} — claimed done", claimed.id)));
        assert!(!md.contains(&format!("- {} — checked done", checked.id)));
        assert!(md.contains("- M-0001 — beta (milestone)"));
        assert!(md.contains("(M-0001, unverified)"));
    }

    #[test]
    fn no_unverified_work_renders_none() {
        let md = render(&[], &[], &[]);
        assert!(md.contains("**Unverified done work:** none."));
    }

    #[test]
    fn noise_kinds_are_filtered_from_recent() {
        let refresh = LedgerEvent::new(LedgerKind::HandoffGenerated, "handoff refreshed", None);
        let legacy_open =
            LedgerEvent::new(LedgerKind::WorkspaceOpened, "workspace opened in Agent NextUp", None);
        let real = LedgerEvent::new(LedgerKind::TaskCreated, "created T-0001", Some("T-0001".into()));
        let md = render(&[], &[refresh, legacy_open, real], &[]);
        assert!(md.contains("created T-0001"));
        assert!(!md.contains("handoff refreshed"));
        assert!(!md.contains("workspace opened"));
    }

    #[test]
    fn workflow_phase_directives_and_gates_are_rendered() {
        use crate::workspace::workflow::{
            Gate, GateEval, Phase, PhaseTransition, Workflow, WorkflowState, WorkflowStatus,
            VIA_START, WORKFLOW_SCHEMA_VERSION,
        };
        let workflow = Workflow {
            schema_version: WORKFLOW_SCHEMA_VERSION,
            template_id: "generic-v1".into(),
            template_name: "Generic flow".into(),
            phases: vec![
                Phase {
                    id: "plan".into(),
                    title: "Plan".into(),
                    description: "Break down tasks".into(),
                    ai_instructions: vec!["Read the handoff first to align on the goal".into()],
                    exit_gates: vec![Gate::MinTasks { count: 1 }],
                },
                Phase {
                    id: "execute".into(),
                    title: "Execute".into(),
                    description: String::new(),
                    ai_instructions: vec![],
                    exit_gates: vec![],
                },
            ],
            state: WorkflowState {
                current_phase: "plan".into(),
                completed: false,
                history: vec![PhaseTransition {
                    phase: "plan".into(),
                    entered_at: "2026-07-06T00:00:00Z".into(),
                    via: VIA_START.into(),
                    reason: None,
                }],
                confirmations: vec![],
            },
        };
        let status = WorkflowStatus {
            current_index: 0,
            total_phases: 2,
            gates: vec![GateEval {
                gate: Gate::MinTasks { count: 1 },
                passed: false,
                observed: "0/1".into(),
            }],
            can_advance: false,
            workflow,
        };
        let md = render_handoff(&HandoffInput {
            context: &sample_context(),
            tasks: &[],
            recent_events: &[],
            decisions: &[],
            progress: &[],
            workflow: Some(&status),
            app_version: "0.1.0",
            generated_at: "2026-07-06T00:00:00Z".into(),
        });
        assert!(md.contains("**Workflow phase:** Plan (1/2"));
        assert!(md.contains("Phase directives"));
        assert!(md.contains("Read the handoff first to align on the goal"));
        assert!(md.contains("- [ ] min_tasks(1) — 0/1"));
    }

    #[test]
    fn generate_writes_file_and_logs_event() {
        let dir = tempfile::tempdir().unwrap();
        let paths = WorkspacePaths::new(dir.path());
        std::fs::create_dir_all(paths.nextup_dir()).unwrap();
        crate::workspace::context::save_context(&paths.context_file(), &sample_context()).unwrap();

        let md = generate_handoff(&paths, "0.1.0").unwrap();
        assert!(paths.handoff_file().is_file());
        assert_eq!(std::fs::read_to_string(paths.handoff_file()).unwrap(), md);

        let events = Ledger::new(paths.ledger_file())
            .recent_of_kind(LedgerKind::HandoffGenerated, 5)
            .unwrap();
        assert_eq!(events.len(), 1);
    }
}
