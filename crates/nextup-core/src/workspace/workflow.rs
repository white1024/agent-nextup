//! Execution harness: the phase state machine in `.nextup/workflow.json`.
//!
//! Instantiated from a template, evaluated by the engine against the *real*
//! workspace state (files, tasks, ledger) — gates are never self-reported by
//! the AI (invariant 4: any bypass is explicit `force`+reason and ledgered).
//! Transitions (`advance_phase`, `adopt`) are mutations: they run under the
//! cross-process lock and finish with one `sync::sync_after_mutation` pass
//! that refreshes every takeover surface and returns the fresh status.

use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::error::{NextUpError, Result};
use crate::workspace::atomic::atomic_write_json;
use crate::workspace::context::now_rfc3339;
use crate::workspace::layout::WorkspacePaths;
use crate::workspace::ledger::{ledger_for, LedgerEvent, LedgerKind};
use crate::workspace::lock::with_mutation_lock;
use crate::workspace::tasks::{Task, TaskStatus, TaskStore};
use crate::workspace::templates::{all_templates, validate_template, TemplateLang, WorkflowTemplate};

pub const WORKFLOW_SCHEMA_VERSION: u32 = 1;

/// One phase of the execution harness. `ai_instructions` are the concrete
/// directives an AI session must follow while this phase is active; they are
/// surfaced verbatim in the handoff snapshot.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Phase {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub ai_instructions: Vec<String>,
    #[serde(default)]
    pub exit_gates: Vec<Gate>,
}

/// Declarative exit conditions. Evaluated by the engine against the actual
/// workspace state (files, tasks, ledger) — never self-reported by the AI.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Gate {
    /// At least `count` tasks exist in the workspace.
    MinTasks { count: usize },
    /// Every task is `done` (an empty task list does NOT pass — nothing was done).
    AllTasksDone,
    /// No task is currently `blocked`.
    NoBlockedTasks,
    /// A file/directory exists at this workspace-relative path.
    ArtifactExists { path: String },
    /// At least `count` Decision ledger entries recorded since entering the phase.
    MinDecisions { count: usize },
    /// A human pressed "confirm" on this prompt (recorded in workflow state).
    ManualConfirm { prompt: String },
    /// The workspace doctor reports zero errors (warnings still pass; see
    /// doctor::DoctorReport::is_clean).
    DoctorClean,
}

impl Gate {
    /// The wire tag (`kind`) alone — for surfaces that draw a gate's *shape*
    /// (engine-checked vs. a person confirms) without its parameters. Kept
    /// honest by a test against the actual serialization.
    pub fn kind(&self) -> &'static str {
        match self {
            Gate::MinTasks { .. } => "min_tasks",
            Gate::AllTasksDone => "all_tasks_done",
            Gate::NoBlockedTasks => "no_blocked_tasks",
            Gate::ArtifactExists { .. } => "artifact_exists",
            Gate::MinDecisions { .. } => "min_decisions",
            Gate::ManualConfirm { .. } => "manual_confirm",
            Gate::DoctorClean => "doctor_clean",
        }
    }
}

/// How a project runs its template (D171).
///
/// `Staged` is the original harness: phases in order, each closed by exit
/// gates. `Ongoing` is the same method without the phases — the work is a
/// stream of tasks with no finish line, so there is nothing to advance and
/// no gate to wait on. A workflow.json written before D171 has no `mode` and
/// reads as staged.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkflowMode {
    #[default]
    Staged,
    Ongoing,
}

impl WorkflowMode {
    pub fn is_staged(&self) -> bool {
        *self == WorkflowMode::Staged
    }

    /// The product default for a new project (D171 ②): ongoing whenever the
    /// template can run that way, staged otherwise.
    pub fn default_for(template: &WorkflowTemplate) -> Self {
        if template.supports_ongoing() {
            WorkflowMode::Ongoing
        } else {
            WorkflowMode::Staged
        }
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            WorkflowMode::Staged => "staged",
            WorkflowMode::Ongoing => "ongoing",
        }
    }
}

/// `.nextup/workflow.json` — the instantiated harness: template phases plus
/// live position, transition history and human confirmations.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Workflow {
    pub schema_version: u32,
    pub template_id: String,
    pub template_name: String,
    /// Omitted while staged, so an older app reads a staged project the way
    /// it always did, and a workflow.json written before D171 is rewritten
    /// unchanged. (A new staged project still carries the ongoing copy below,
    /// which an older app ignores and drops if it rewrites the file.)
    #[serde(default, skip_serializing_if = "WorkflowMode::is_staged")]
    pub mode: WorkflowMode,
    pub phases: Vec<Phase>,
    /// The template's ongoing instructions, copied at instantiation like the
    /// phases are, so switching to ongoing later needs no template lookup.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub ongoing_instructions: Vec<String>,
    pub state: WorkflowState,
}

impl Workflow {
    pub fn is_ongoing(&self) -> bool {
        self.mode == WorkflowMode::Ongoing
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowState {
    pub current_phase: String,
    pub completed: bool,
    #[serde(default)]
    pub history: Vec<PhaseTransition>,
    #[serde(default)]
    pub confirmations: Vec<GateConfirmation>,
}

pub const VIA_START: &str = "start";
pub const VIA_ADVANCE: &str = "advance";
pub const VIA_OVERRIDE: &str = "override";
/// A person stepped back one phase (D171 ⑤).
pub const VIA_ROLLBACK: &str = "rollback";
/// A person switched the project to ongoing; the entry's phase is where the
/// staged position stood, kept for a later switch back (D171 ③).
pub const VIA_MODE_ONGOING: &str = "ongoing";
/// A person switched the project back to staged: the phase is re-entered at
/// that moment, so gates and the stall clock count from there.
pub const VIA_MODE_STAGED: &str = "staged";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PhaseTransition {
    pub phase: String,
    pub entered_at: String,
    #[serde(default)]
    pub via: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GateConfirmation {
    pub phase: String,
    pub prompt: String,
    pub at: String,
}

/// Result of evaluating one gate against reality.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GateEval {
    pub gate: Gate,
    pub passed: bool,
    /// Terse observation ("3/1 tasks", "2 open", "missing") — the UI renders
    /// the gate label itself from `gate.kind` for i18n.
    pub observed: String,
}

/// Full harness status for the UI and the handoff serializer.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowStatus {
    pub workflow: Workflow,
    pub current_index: usize,
    pub total_phases: usize,
    pub gates: Vec<GateEval>,
    pub can_advance: bool,
}

impl WorkflowStatus {
    pub fn is_ongoing(&self) -> bool {
        self.workflow.is_ongoing()
    }

    /// Display title of the current phase (falls back to the raw phase id if
    /// the state points at an unknown phase).
    pub fn current_phase_title(&self) -> String {
        self.workflow
            .phases
            .get(self.current_index)
            .map(|p| p.title.clone())
            .unwrap_or_else(|| self.workflow.state.current_phase.clone())
    }

    /// When the current phase was (last) entered, if the history says (D169).
    /// The surfaces print the date rather than "N days ago": the state block
    /// is rewritten only on a mutation, and an age would go stale on its own.
    pub fn current_phase_entered_at(&self) -> Option<String> {
        let at = entered_at(&self.workflow, &self.workflow.state.current_phase);
        (!at.is_empty()).then_some(at)
    }

    /// The date half of [`Self::current_phase_entered_at`] (`YYYY-MM-DD`).
    pub fn current_phase_entered_on(&self) -> Option<String> {
        self.current_phase_entered_at().map(|at| at.chars().take(10).collect())
    }
}

// ── Persistence ─────────────────────────────────────────────────────────────

pub fn load_workflow(path: &Path) -> Result<Workflow> {
    if !path.exists() {
        return Err(NextUpError::NotFound(format!(
            "no workflow harness: {} is missing",
            path.display()
        )));
    }
    let workflow: Workflow = super::atomic::read_json_file(path)?;
    if workflow.schema_version > WORKFLOW_SCHEMA_VERSION {
        return Err(NextUpError::Workspace(format!(
            "workflow schema v{} is newer than this app supports (v{})",
            workflow.schema_version, WORKFLOW_SCHEMA_VERSION
        )));
    }
    Ok(workflow)
}

pub fn save_workflow(path: &Path, workflow: &Workflow) -> Result<()> {
    atomic_write_json(path, workflow)
}

/// Turn a template into a live harness positioned at its first phase.
/// `mode: None` takes the product default ([`WorkflowMode::default_for`]);
/// asking for ongoing on a template without ongoing instructions is refused
/// rather than quietly running it staged.
pub fn instantiate(template: &WorkflowTemplate, mode: Option<WorkflowMode>) -> Result<Workflow> {
    validate_template(template)?;
    let mode = mode.unwrap_or_else(|| WorkflowMode::default_for(template));
    if mode == WorkflowMode::Ongoing && !template.supports_ongoing() {
        return Err(no_ongoing_instructions(&template.id));
    }
    let first = &template.phases[0];
    Ok(Workflow {
        schema_version: WORKFLOW_SCHEMA_VERSION,
        template_id: template.id.clone(),
        template_name: template.name.clone(),
        mode,
        phases: template.phases.clone(),
        ongoing_instructions: template.ongoing_instructions.clone(),
        state: WorkflowState {
            current_phase: first.id.clone(),
            completed: false,
            history: vec![PhaseTransition {
                phase: first.id.clone(),
                entered_at: now_rfc3339(),
                via: VIA_START.into(),
                reason: None,
            }],
            confirmations: Vec::new(),
        },
    })
}

// ── Evaluation ──────────────────────────────────────────────────────────────

/// Evaluate the harness against the live workspace. `NotFound` when the
/// workspace has no workflow.json (legacy workspaces — see `adopt`).
pub fn evaluate(paths: &WorkspacePaths) -> Result<WorkflowStatus> {
    let workflow = load_workflow(&paths.workflow_file())?;
    status_of(paths, workflow)
}

/// What a `doctor_clean` gate reads. The doctor evaluates the workflow itself
/// (the D169 stall check), so when it does, it hands over the verdict it has
/// already reached — the gate running the doctor again would recurse until
/// the stack ran out.
#[derive(Debug, Clone, Copy)]
enum DoctorVerdict {
    Run,
    Known { errors: usize, warnings: usize },
}

/// [`try_evaluate`] for the doctor: `doctor_clean` gates take the counts the
/// doctor has reached so far instead of running it again.
pub fn try_evaluate_for_doctor(
    paths: &WorkspacePaths,
    errors: usize,
    warnings: usize,
) -> Result<Option<WorkflowStatus>> {
    match load_workflow(&paths.workflow_file()) {
        Ok(workflow) => status_with(paths, workflow, DoctorVerdict::Known { errors, warnings }).map(Some),
        Err(NextUpError::NotFound(_)) => Ok(None),
        Err(e) => Err(e),
    }
}

/// Like [`evaluate`] but maps "no harness" to `None` for callers where the
/// harness is optional (handoff generation, status endpoints).
pub fn try_evaluate(paths: &WorkspacePaths) -> Result<Option<WorkflowStatus>> {
    match evaluate(paths) {
        Ok(status) => Ok(Some(status)),
        Err(NextUpError::NotFound(_)) => Ok(None),
        Err(e) => Err(e),
    }
}

fn status_of(paths: &WorkspacePaths, workflow: Workflow) -> Result<WorkflowStatus> {
    status_with(paths, workflow, DoctorVerdict::Run)
}

fn status_with(
    paths: &WorkspacePaths,
    workflow: Workflow,
    doctor: DoctorVerdict,
) -> Result<WorkflowStatus> {
    let (current_index, phase) = current_phase(&workflow)?;
    // Ongoing has no exit gates to evaluate and nothing to advance to
    // (D171): `can_advance` stays false, which is also what keeps the D169
    // ready-but-idle warning and the "ready to advance" lines away.
    let gates = if workflow.state.completed || workflow.is_ongoing() {
        Vec::new()
    } else {
        let tasks = TaskStore::new(paths.tasks_dir()).list()?;
        let entered_at = entered_at(&workflow, &workflow.state.current_phase);
        let decisions_since = count_decisions_since(paths, &entered_at)?;
        phase
            .exit_gates
            .iter()
            .map(|gate| eval_gate(gate, paths, &tasks, decisions_since, &workflow, doctor))
            .collect()
    };
    let can_advance =
        !workflow.state.completed && !workflow.is_ongoing() && gates.iter().all(|g| g.passed);
    Ok(WorkflowStatus {
        current_index,
        total_phases: workflow.phases.len(),
        gates,
        can_advance,
        workflow,
    })
}

fn current_phase(workflow: &Workflow) -> Result<(usize, &Phase)> {
    workflow
        .phases
        .iter()
        .enumerate()
        .find(|(_, p)| p.id == workflow.state.current_phase)
        .ok_or_else(|| {
            NextUpError::Workspace(format!(
                "workflow state points at unknown phase '{}'",
                workflow.state.current_phase
            ))
        })
}

/// When the current phase was (last) entered. RFC3339 UTC strings compare
/// lexicographically; an empty string (hand-edited file without history)
/// makes "since" checks count everything, which is the lenient right answer.
fn entered_at(workflow: &Workflow, phase_id: &str) -> String {
    workflow
        .state
        .history
        .iter()
        .rev()
        .find(|t| t.phase == phase_id)
        .map(|t| t.entered_at.clone())
        .unwrap_or_default()
}

/// Scan window for `MinDecisions` gates. Gate semantics promise "evaluated
/// against real state", so keep this far above any plausible single-phase
/// decision volume (a phase would need 500+ decisions before undercounting).
const DECISION_SCAN_LIMIT: usize = 500;

fn count_decisions_since(paths: &WorkspacePaths, since: &str) -> Result<usize> {
    let decisions = ledger_for(paths).recent_of_kind(LedgerKind::Decision, DECISION_SCAN_LIMIT)?;
    // A provisional decision is an agent's assumption, not the decision the
    // gate asks for (D170).
    Ok(decisions.iter().filter(|e| e.at.as_str() >= since && !e.provisional).count())
}

fn eval_gate(
    gate: &Gate,
    paths: &WorkspacePaths,
    tasks: &[Task],
    decisions_since: usize,
    workflow: &Workflow,
    doctor: DoctorVerdict,
) -> GateEval {
    let (passed, observed) = match gate {
        // A cancelled task is planned work that will not happen (D169): it
        // neither counts towards "enough tasks" nor stays open forever.
        Gate::MinTasks { count } => {
            let live = tasks.iter().filter(|t| t.status != TaskStatus::Cancelled).count();
            (live >= *count, format!("{live}/{count}"))
        }
        Gate::AllTasksDone => {
            let open = tasks.iter().filter(|t| !t.status.is_closed()).count();
            if tasks.is_empty() {
                (false, "no tasks".into())
            } else if tasks.iter().all(|t| t.status == TaskStatus::Cancelled) {
                (false, "every task cancelled".into())
            } else {
                (open == 0, format!("{} open", open))
            }
        }
        Gate::NoBlockedTasks => {
            let blocked = tasks.iter().filter(|t| t.status == TaskStatus::Blocked).count();
            (blocked == 0, format!("{blocked} blocked"))
        }
        Gate::ArtifactExists { path } => {
            let rel = Path::new(path);
            let escapes = rel.is_absolute()
                || rel.components().any(|c| matches!(c, std::path::Component::ParentDir));
            if escapes {
                (false, "unsafe path".into())
            } else {
                let exists = paths.root().join(rel).exists();
                (exists, if exists { "exists".into() } else { "missing".into() })
            }
        }
        Gate::MinDecisions { count } => {
            (decisions_since >= *count, format!("{decisions_since}/{count}"))
        }
        Gate::ManualConfirm { prompt } => {
            let confirmed = workflow
                .state
                .confirmations
                .iter()
                .any(|c| c.phase == workflow.state.current_phase && c.prompt == *prompt);
            // "human only" rides on the observed value, not on the surfaces
            // (D104): on a handoff line an unconfirmed manual_confirm reads
            // exactly like a gate the session can go and clear itself, and
            // "you may not press this" was only ever written in the guide —
            // which is not the file that gets re-read every session.
            (confirmed, if confirmed { "confirmed".into() } else { "pending (human only)".into() })
        }
        Gate::DoctorClean => match doctor {
            DoctorVerdict::Known { errors, warnings } => {
                (errors == 0, format!("{errors} error(s), {warnings} warning(s)"))
            }
            DoctorVerdict::Run => match crate::workspace::doctor::run_doctor(paths.root()) {
                Ok(report) => (
                    report.is_clean(),
                    format!("{} error(s), {} warning(s)", report.errors, report.warnings),
                ),
                // The doctor failing to run is itself a health problem: fail
                // closed with the reason visible instead of waving work through.
                Err(e) => (false, format!("doctor failed to run: {e}")),
            },
        },
    };
    GateEval { gate: gate.clone(), passed, observed }
}

/// Compact single-line label used in error messages and the handoff.
pub fn gate_label(gate: &Gate) -> String {
    match gate {
        Gate::MinTasks { count } => format!("min_tasks({count})"),
        Gate::AllTasksDone => "all_tasks_done".into(),
        Gate::NoBlockedTasks => "no_blocked_tasks".into(),
        Gate::ArtifactExists { path } => format!("artifact_exists({path})"),
        Gate::MinDecisions { count } => format!("min_decisions({count})"),
        Gate::ManualConfirm { prompt } => format!("manual_confirm(\"{prompt}\")"),
        Gate::DoctorClean => "doctor_clean".into(),
    }
}

// ── Transitions ─────────────────────────────────────────────────────────────

/// Advance to the next phase. **Enforced**: fails unless every exit gate of
/// the current phase passes — unless `force` is set, which requires a reason
/// and is recorded as an override in both history and ledger. Every
/// successful transition regenerates the handoff snapshot (a phase change is
/// exactly the kind of state a new session must inherit).
pub fn advance_phase(
    paths: &WorkspacePaths,
    app_version: &str,
    force: bool,
    reason: Option<String>,
) -> Result<WorkflowStatus> {
    with_mutation_lock(paths, || advance_phase_locked(paths, app_version, force, reason))
}

fn advance_phase_locked(
    paths: &WorkspacePaths,
    app_version: &str,
    force: bool,
    reason: Option<String>,
) -> Result<WorkflowStatus> {
    let status = evaluate(paths)?;
    if status.is_ongoing() {
        return Err(ongoing_has_no_phases());
    }
    if status.workflow.state.completed {
        return Err(NextUpError::Workflow("workflow is already completed".into()));
    }

    let reason = reason.map(|r| r.trim().to_string()).filter(|r| !r.is_empty());
    if force && reason.is_none() {
        return Err(NextUpError::InvalidInput(
            "forcing past unmet gates requires a reason (it is written to the ledger)".into(),
        ));
    }
    if !force && !status.can_advance {
        let failed: Vec<String> = status
            .gates
            .iter()
            .filter(|g| !g.passed)
            .map(|g| format!("{} [{}]", gate_label(&g.gate), g.observed))
            .collect();
        return Err(NextUpError::Workflow(format!(
            "exit gates not satisfied: {}",
            failed.join(", ")
        )));
    }

    let mut workflow = status.workflow;
    let from_index = status.current_index;
    let from_title = workflow.phases[from_index].title.clone();
    let via = if force && !status.can_advance { VIA_OVERRIDE } else { VIA_ADVANCE };

    let message = if from_index + 1 >= workflow.phases.len() {
        workflow.state.completed = true;
        match (&reason, via) {
            (Some(r), VIA_OVERRIDE) => {
                format!("workflow completed after \"{from_title}\" (OVERRIDE: {r})")
            }
            _ => format!("workflow completed after \"{from_title}\""),
        }
    } else {
        let next = workflow.phases[from_index + 1].clone();
        workflow.state.current_phase = next.id.clone();
        workflow.state.history.push(PhaseTransition {
            phase: next.id,
            entered_at: now_rfc3339(),
            via: via.into(),
            reason: if via == VIA_OVERRIDE { reason.clone() } else { None },
        });
        match (&reason, via) {
            (Some(r), VIA_OVERRIDE) => {
                format!("phase \"{from_title}\" → \"{}\" (OVERRIDE: {r})", next_title(&workflow))
            }
            _ => format!("phase \"{from_title}\" → \"{}\"", next_title(&workflow)),
        }
    };

    save_workflow(&paths.workflow_file(), &workflow)?;
    // Structured transition fields (D75), same values PhaseTransition stores
    // in workflow.json — the flywheel's override signal reads these, not the
    // "(OVERRIDE: …)" prose.
    ledger_for(paths).append(
        &LedgerEvent::new(LedgerKind::PhaseAdvanced, message, None)
            .with_via(via)
            .with_reason(if via == VIA_OVERRIDE { reason } else { None }),
    )?;
    // One sync pass refreshes every takeover surface and hands back the
    // freshly evaluated status — the gates run once here, not three times.
    let outcome = crate::workspace::sync::sync_after_mutation(paths, app_version)?;
    outcome.workflow.ok_or_else(|| {
        NextUpError::Workspace("workflow.json vanished during phase advance".into())
    })
}

fn next_title(workflow: &Workflow) -> String {
    workflow
        .phases
        .iter()
        .find(|p| p.id == workflow.state.current_phase)
        .map(|p| p.title.clone())
        .unwrap_or_else(|| workflow.state.current_phase.clone())
}

/// Record a human confirmation for a `manual_confirm` gate of the *current*
/// phase. Idempotent; the confirmation is also logged to the ledger.
pub fn confirm_gate(paths: &WorkspacePaths, phase_id: &str, prompt: &str) -> Result<WorkflowStatus> {
    with_mutation_lock(paths, || confirm_gate_locked(paths, phase_id, prompt))
}

fn confirm_gate_locked(paths: &WorkspacePaths, phase_id: &str, prompt: &str) -> Result<WorkflowStatus> {
    let mut workflow = load_workflow(&paths.workflow_file())?;
    if workflow.is_ongoing() {
        return Err(ongoing_has_no_phases());
    }
    if workflow.state.completed {
        return Err(NextUpError::Workflow("workflow is already completed".into()));
    }
    if workflow.state.current_phase != phase_id {
        return Err(NextUpError::InvalidInput(format!(
            "can only confirm gates of the current phase '{}'",
            workflow.state.current_phase
        )));
    }
    let (_, phase) = current_phase(&workflow)?;
    let is_known = phase
        .exit_gates
        .iter()
        .any(|g| matches!(g, Gate::ManualConfirm { prompt: p } if p == prompt));
    if !is_known {
        return Err(NextUpError::InvalidInput(format!(
            "phase '{phase_id}' has no manual_confirm gate with that prompt"
        )));
    }

    let already = workflow
        .state
        .confirmations
        .iter()
        .any(|c| c.phase == phase_id && c.prompt == prompt);
    if !already {
        workflow.state.confirmations.push(GateConfirmation {
            phase: phase_id.to_string(),
            prompt: prompt.to_string(),
            at: now_rfc3339(),
        });
        save_workflow(&paths.workflow_file(), &workflow)?;
        ledger_for(paths).append(&LedgerEvent::new(
            LedgerKind::GateConfirmed,
            format!("confirmed: {prompt}"),
            None,
        ))?;
    }
    evaluate(paths)
}

/// The refusal every phase operation gives on an ongoing project (D171). It
/// is an agent that most often meets it, so it says what to do instead.
fn ongoing_has_no_phases() -> NextUpError {
    NextUpError::Workflow(
        "this project runs ongoing: it has no phases to advance or gates to confirm — keep \
         working the tasks; only a person can switch it to staged, in project settings"
            .into(),
    )
}

fn no_ongoing_instructions(template_id: &str) -> NextUpError {
    NextUpError::InvalidInput(format!(
        "template '{template_id}' has no ongoing instructions, so this project can only run staged"
    ))
}

/// Switch a project between staged and ongoing (D171 ③). A person's call,
/// reached from project settings only — there is no hub tool, the same line
/// phase advancement sits behind. Both directions keep the history; a no-op
/// switch writes nothing.
///
/// Going ongoing on a workflow.json from before D171 (no copy of the ongoing
/// instructions) fetches them from the template with the same id; when that
/// template is gone or has none, the switch is refused.
pub fn set_mode(
    paths: &WorkspacePaths,
    app_version: &str,
    mode: WorkflowMode,
    custom_dir: Option<&Path>,
    lang: TemplateLang,
) -> Result<WorkflowStatus> {
    with_mutation_lock(paths, || {
        let mut workflow = load_workflow(&paths.workflow_file())?;
        if workflow.mode == mode {
            return evaluate(paths);
        }
        if mode == WorkflowMode::Ongoing && workflow.ongoing_instructions.is_empty() {
            match template_for(&workflow, custom_dir, lang)? {
                Some(t) if t.supports_ongoing() => {
                    workflow.ongoing_instructions = t.ongoing_instructions;
                }
                _ => return Err(no_ongoing_instructions(&workflow.template_id)),
            }
        }
        // Neither `current_phase` nor `completed` is touched by a mode switch:
        // they are the staged position, and a switch back resumes exactly
        // there — a finished workflow comes back finished. Every surface asks
        // `is_ongoing` before it reads them.
        workflow.mode = mode;
        let (index, phase) = current_phase(&workflow)?;
        let phase_title = phase.title.clone();
        // Switching back re-enters the current phase (the history entry below
        // restarts its min_decisions count and day counter), so its manual
        // confirmations — and any left on later phases — are asked for again,
        // the same rule a rollback follows. A finished workflow keeps its own.
        if mode == WorkflowMode::Staged && !workflow.state.completed {
            clear_confirmations_from(&mut workflow, index);
        }
        let via = match mode {
            WorkflowMode::Ongoing => VIA_MODE_ONGOING,
            WorkflowMode::Staged => VIA_MODE_STAGED,
        };
        workflow.state.history.push(PhaseTransition {
            phase: workflow.state.current_phase.clone(),
            entered_at: now_rfc3339(),
            via: via.into(),
            reason: None,
        });
        save_workflow(&paths.workflow_file(), &workflow)?;
        let message = match mode {
            WorkflowMode::Ongoing => "workflow switched to ongoing — no phases to advance".to_string(),
            WorkflowMode::Staged => format!("workflow switched to staged — in phase \"{phase_title}\""),
        };
        ledger_for(paths)
            .append(&LedgerEvent::new(LedgerKind::PhaseAdvanced, message, None).with_via(via))?;
        let outcome = crate::workspace::sync::sync_after_mutation(paths, app_version)?;
        outcome
            .workflow
            .ok_or_else(|| NextUpError::Workspace("workflow.json vanished during a mode switch".into()))
    })
}

/// Drop the manual confirmations of the phase at `from` and every later one.
fn clear_confirmations_from(workflow: &mut Workflow, from: usize) {
    let later: Vec<String> = workflow.phases.iter().skip(from).map(|p| p.id.clone()).collect();
    workflow.state.confirmations.retain(|c| !later.contains(&c.phase));
}

/// The template a workflow was made from, for the ongoing instructions a
/// workflow.json from before D171 lacks. Built-in content is per language, so
/// the one whose name matches what the project was created with wins; the UI
/// language is only the fallback (a zh project opened in an English UI should
/// not get English instructions copied in).
fn template_for(
    workflow: &Workflow,
    custom_dir: Option<&Path>,
    lang: TemplateLang,
) -> Result<Option<WorkflowTemplate>> {
    let other = match lang {
        TemplateLang::En => TemplateLang::ZhTw,
        TemplateLang::ZhTw => TemplateLang::En,
    };
    let mut fallback = None;
    for l in [lang, other] {
        for (t, _) in all_templates(custom_dir, l)? {
            if t.id != workflow.template_id {
                continue;
            }
            if t.name == workflow.template_name {
                return Ok(Some(t));
            }
            if fallback.is_none() {
                fallback = Some(t);
            }
        }
    }
    Ok(fallback)
}

/// Step a staged project back one phase (D171 ⑤) — a person's undo for an
/// advance pressed too early, reached from the GUI only. A finished workflow
/// reopens in its last phase. The phase stepped back into, and every phase
/// after it, lose their manual confirmations: that work is being redone.
pub fn rollback_phase(paths: &WorkspacePaths, app_version: &str) -> Result<WorkflowStatus> {
    with_mutation_lock(paths, || {
        let mut workflow = load_workflow(&paths.workflow_file())?;
        if workflow.is_ongoing() {
            return Err(ongoing_has_no_phases());
        }
        let (index, from) = current_phase(&workflow)?;
        let from_title = from.title.clone();
        let target = if workflow.state.completed {
            index
        } else if index == 0 {
            return Err(NextUpError::InvalidInput("already in the first phase".into()));
        } else {
            index - 1
        };
        let to = workflow.phases[target].clone();
        let message = if workflow.state.completed {
            format!("workflow reopened in phase \"{}\" (rolled back)", to.title)
        } else {
            format!("phase \"{from_title}\" → \"{}\" (rolled back)", to.title)
        };
        workflow.state.completed = false;
        workflow.state.current_phase = to.id.clone();
        // Everything from the target on is being redone, so it is confirmed
        // again — the phase stepped back from included, or advancing back
        // into it would find its old confirmation still standing.
        clear_confirmations_from(&mut workflow, target);
        workflow.state.history.push(PhaseTransition {
            phase: to.id,
            entered_at: now_rfc3339(),
            via: VIA_ROLLBACK.into(),
            reason: None,
        });
        save_workflow(&paths.workflow_file(), &workflow)?;
        ledger_for(paths).append(
            &LedgerEvent::new(LedgerKind::PhaseAdvanced, message, None).with_via(VIA_ROLLBACK),
        )?;
        let outcome = crate::workspace::sync::sync_after_mutation(paths, app_version)?;
        outcome
            .workflow
            .ok_or_else(|| NextUpError::Workspace("workflow.json vanished during a rollback".into()))
    })
}

/// Attach a harness to a legacy workspace that predates workflow.json.
pub fn adopt(
    paths: &WorkspacePaths,
    template: &WorkflowTemplate,
    mode: Option<WorkflowMode>,
    app_version: &str,
) -> Result<WorkflowStatus> {
    with_mutation_lock(paths, || {
        if paths.workflow_file().exists() {
            return Err(NextUpError::Workflow(
                "this workspace already has a workflow harness".into(),
            ));
        }
        let workflow = instantiate(template, mode)?;
        save_workflow(&paths.workflow_file(), &workflow)?;
        // The template's phases may call a skill pack (D148): ship it now, the
        // same moment the instructions that name it arrive, and fingerprint it
        // so a later engine change can still upgrade it untouched.
        if !crate::workspace::bootstrap::ensure_skills(paths)?.is_empty() {
            let ctx = crate::workspace::context::load_context(&paths.context_file())?;
            crate::workspace::assets::record_pristine(paths, &ctx)?;
        }
        ledger_for(paths).append(&LedgerEvent::new(
            LedgerKind::WorkflowAdopted,
            format!("workflow template \"{}\" adopted", template.name),
            None,
        ))?;
        let outcome = crate::workspace::sync::sync_after_mutation(paths, app_version)?;
        outcome
            .workflow
            .ok_or_else(|| NextUpError::Workspace("workflow.json vanished during adopt".into()))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::security::keystore::StaticKeyProvider;
    use crate::workspace::init::{initialize_project, InitProjectParams};
    use crate::workspace::ledger::Ledger;
    use crate::workspace::ops::{add_ledger_note, create_task, update_task_status, NoteChannel};
    use crate::workspace::tasks::NewTask;
    use crate::workspace::templates::resolve_template;

    /// Workspace initialized with the generic template:
    /// plan(min_tasks 1) → execute(all_done, no_blocked) → review → post_mortem.
    fn workspace() -> (tempfile::TempDir, WorkspacePaths) {
        let dir = tempfile::tempdir().unwrap();
        initialize_project(
            &InitProjectParams {
                root: dir.path().to_string_lossy().into_owned(),
                name: "harness-test".into(),
                domain: "coding".into(),
                description: String::new(),
                goals: vec![],
                boundaries: vec![],
                // These tests walk the phase harness (D171: staged is opt-in).
                mode: Some(WorkflowMode::Staged),
                ..Default::default()
            },
            &StaticKeyProvider([7u8; 32]),
            "0.1.0",
        )
        .unwrap();
        let paths = WorkspacePaths::new(dir.path());
        (dir, paths)
    }

    fn task(paths: &WorkspacePaths, title: &str) -> String {
        create_task(
            paths,
            "0.1.0",
            NewTask { title: title.into(), priority: 1, ..Default::default() },
        )
        .unwrap()
        .id
    }

    #[test]
    fn init_instantiates_harness_at_first_phase() {
        let (_g, paths) = workspace();
        let status = evaluate(&paths).unwrap();
        assert_eq!(status.workflow.state.current_phase, "plan");
        assert_eq!(status.current_index, 0);
        assert_eq!(status.total_phases, 4);
        assert!(!status.can_advance, "min_tasks(1) unmet on a fresh workspace");
        assert_eq!(status.workflow.state.history.len(), 1);
        assert_eq!(status.workflow.state.history[0].via, VIA_START);
    }

    #[test]
    fn advance_is_enforced_until_gates_pass() {
        let (_g, paths) = workspace();

        let err = advance_phase(&paths, "0.1.0", false, None).unwrap_err();
        assert_eq!(err.kind(), "workflow");
        assert!(err.to_string().contains("min_tasks"));

        task(&paths, "first atomic task");
        let status = advance_phase(&paths, "0.1.0", false, None).unwrap();
        assert_eq!(status.workflow.state.current_phase, "execute");
        assert_eq!(status.workflow.state.history.last().unwrap().via, VIA_ADVANCE);

        // Ledger recorded the transition and the handoff was refreshed.
        let events = Ledger::new(paths.ledger_file())
            .recent_of_kind(LedgerKind::PhaseAdvanced, 5)
            .unwrap();
        assert_eq!(events.len(), 1);
        let handoff = std::fs::read_to_string(paths.handoff_file()).unwrap();
        assert!(handoff.contains("**Workflow phase:** Execute"));
    }

    #[test]
    fn all_tasks_done_gate_blocks_open_and_blocked_tasks() {
        let (_g, paths) = workspace();
        let id = task(&paths, "only task");
        advance_phase(&paths, "0.1.0", false, None).unwrap(); // → execute

        // Open task: cannot advance.
        assert!(!evaluate(&paths).unwrap().can_advance);

        // Blocked task: both gates fail.
        update_task_status(&paths, "0.1.0", &id, TaskStatus::Blocked, Some("waiting".into()))
            .unwrap();
        let status = evaluate(&paths).unwrap();
        assert_eq!(status.gates.iter().filter(|g| !g.passed).count(), 2);

        // Done: both pass.
        update_task_status(&paths, "0.1.0", &id, TaskStatus::Done, None).unwrap();
        assert!(evaluate(&paths).unwrap().can_advance);
    }

    #[test]
    fn force_requires_reason_and_is_recorded_as_override() {
        let (_g, paths) = workspace();

        let err = advance_phase(&paths, "0.1.0", true, Some("  ".into())).unwrap_err();
        assert_eq!(err.kind(), "invalid_input");

        let status =
            advance_phase(&paths, "0.1.0", true, Some("demo bypass for kickoff".into())).unwrap();
        assert_eq!(status.workflow.state.current_phase, "execute");
        assert_eq!(status.workflow.state.history.last().unwrap().via, VIA_OVERRIDE);

        let events = Ledger::new(paths.ledger_file())
            .recent_of_kind(LedgerKind::PhaseAdvanced, 5)
            .unwrap();
        assert!(events[0].message.contains("OVERRIDE: demo bypass for kickoff"));
        // The ledger line carries the same structured via/reason the
        // workflow.json transition does (D75) — consumers read these, not
        // the prose.
        assert_eq!(events[0].via.as_deref(), Some(VIA_OVERRIDE));
        assert_eq!(events[0].reason.as_deref(), Some("demo bypass for kickoff"));
    }

    #[test]
    fn force_with_passing_gates_is_a_normal_advance() {
        let (_g, paths) = workspace();
        task(&paths, "t");
        let status = advance_phase(&paths, "0.1.0", true, Some("unnecessary force".into())).unwrap();
        assert_eq!(status.workflow.state.history.last().unwrap().via, VIA_ADVANCE);

        // The unnecessary force stays out of the structured fields too: a
        // normal advance records no reason (D75, same policy as history).
        let events = Ledger::new(paths.ledger_file())
            .recent_of_kind(LedgerKind::PhaseAdvanced, 5)
            .unwrap();
        assert_eq!(events[0].via.as_deref(), Some(VIA_ADVANCE));
        assert_eq!(events[0].reason, None);
    }

    #[test]
    fn manual_confirm_and_decision_gates_drive_review_phase() {
        let (_g, paths) = workspace();
        let id = task(&paths, "t");
        advance_phase(&paths, "0.1.0", false, None).unwrap(); // → execute
        update_task_status(&paths, "0.1.0", &id, TaskStatus::Done, None).unwrap();
        advance_phase(&paths, "0.1.0", false, None).unwrap(); // → review

        // An unconfirmed manual_confirm reads like any other open gate on a
        // handoff line, so the observed value is where "not yours to press"
        // has to be said (D104) — the guide is not re-read every session.
        let pending = evaluate(&paths).unwrap();
        assert!(!pending.can_advance);
        assert!(
            pending
                .gates
                .iter()
                .any(|g| !g.passed && g.observed.contains("human only")),
            "the human-only gate must say so where it is rendered: {:?}",
            pending.gates
        );

        // Wrong prompt / wrong phase are rejected.
        assert_eq!(
            confirm_gate(&paths, "review", "nonexistent prompt").unwrap_err().kind(),
            "invalid_input"
        );
        assert_eq!(
            confirm_gate(&paths, "plan", "Confirmed the output meets the project goals").unwrap_err().kind(),
            "invalid_input"
        );

        add_ledger_note(&paths, "0.1.0", NoteChannel::Decision, "acceptance passed: goals one and two both met").unwrap();
        let status = confirm_gate(&paths, "review", "Confirmed the output meets the project goals").unwrap();
        assert!(status.can_advance, "decision + confirmation satisfy review gates");

        // Idempotent confirm.
        let again = confirm_gate(&paths, "review", "Confirmed the output meets the project goals").unwrap();
        assert_eq!(again.workflow.state.confirmations.len(), 1);
    }

    #[test]
    fn min_decisions_counts_only_since_phase_entry() {
        let (_g, paths) = workspace();
        // Decision recorded during plan must NOT satisfy review's gate later.
        add_ledger_note(&paths, "0.1.0", NoteChannel::Decision, "early decision in plan").unwrap();
        task(&paths, "t");
        std::thread::sleep(std::time::Duration::from_millis(1100)); // second-resolution timestamps
        let id_status = advance_phase(&paths, "0.1.0", false, None).unwrap(); // → execute
        let id = TaskStore::new(paths.tasks_dir()).list().unwrap()[0].id.clone();
        assert_eq!(id_status.workflow.state.current_phase, "execute");
        update_task_status(&paths, "0.1.0", &id, TaskStatus::Done, None).unwrap();
        advance_phase(&paths, "0.1.0", false, None).unwrap(); // → review

        let status = evaluate(&paths).unwrap();
        let decisions_gate = status
            .gates
            .iter()
            .find(|g| matches!(g.gate, Gate::MinDecisions { .. }))
            .unwrap();
        assert!(!decisions_gate.passed, "pre-phase decision must not count");
    }

    /// Turning options down is not the same as deciding, and the gate must
    /// not accept it as such: while rejections shared the `Decision` kind, a
    /// phase demanding N decisions could be satisfied by N rejections — the
    /// cheapest possible way through, and the one an agent under gate
    /// pressure would find.
    #[test]
    fn rejections_do_not_satisfy_the_decision_gate() {
        let (_g, paths) = workspace();
        task(&paths, "t");
        advance_phase(&paths, "0.1.0", true, Some("to execute".into())).unwrap();
        let id = TaskStore::new(paths.tasks_dir()).list().unwrap()[0].id.clone();
        update_task_status(&paths, "0.1.0", &id, TaskStatus::Done, None).unwrap();
        advance_phase(&paths, "0.1.0", true, Some("to review".into())).unwrap();

        for i in 0..3 {
            crate::workspace::ops::add_rejected(
                &paths,
                "0.1.0",
                &format!("option {i}"),
                "too expensive",
            )
            .unwrap();
        }
        let gate = |paths: &WorkspacePaths| {
            evaluate(paths)
                .unwrap()
                .gates
                .into_iter()
                .find(|g| matches!(g.gate, Gate::MinDecisions { .. }))
                .unwrap()
        };
        assert!(!gate(&paths).passed, "three rejections are still zero decisions");

        add_ledger_note(&paths, "0.1.0", NoteChannel::Decision, "and this is the decision")
            .unwrap();
        assert!(gate(&paths).passed, "a real decision still counts");
    }

    #[test]
    fn completing_the_final_phase_marks_workflow_done() {
        let (_g, paths) = workspace();
        task(&paths, "t");
        // Walk to the end with overrides (gate mechanics tested elsewhere).
        for _ in 0..3 {
            advance_phase(&paths, "0.1.0", true, Some("walking to the end".into())).unwrap();
        }
        let status = advance_phase(&paths, "0.1.0", true, Some("finish".into())).unwrap();
        assert!(status.workflow.state.completed);
        assert!(!status.can_advance);
        assert!(status.gates.is_empty());

        let err = advance_phase(&paths, "0.1.0", false, None).unwrap_err();
        assert!(err.to_string().contains("already completed"));
    }

    #[test]
    fn artifact_gate_checks_workspace_relative_path() {
        let (_g, paths) = workspace();
        let template =
            resolve_template(Some("coding-v1"), None, Default::default()).unwrap();
        // Fresh workspace for the coding template (release phase artifact gate).
        let dir = tempfile::tempdir().unwrap();
        initialize_project(
            &InitProjectParams {
                root: dir.path().to_string_lossy().into_owned(),
                name: "artifact-test".into(),
                domain: "coding".into(),
                description: String::new(),
                goals: vec![],
                boundaries: vec![],
                template_id: Some(template.id.clone()),
                mode: Some(WorkflowMode::Staged),
                ..Default::default()
            },
            &StaticKeyProvider([7u8; 32]),
            "0.1.0",
        )
        .unwrap();
        let p2 = WorkspacePaths::new(dir.path());
        // Jump to release phase.
        for _ in 0..3 {
            advance_phase(&p2, "0.1.0", true, Some("jump".into())).unwrap();
        }
        let status = evaluate(&p2).unwrap();
        assert_eq!(status.workflow.state.current_phase, "release");
        let artifact_gate = status
            .gates
            .iter()
            .find(|g| matches!(g.gate, Gate::ArtifactExists { .. }))
            .unwrap();
        assert!(!artifact_gate.passed);

        std::fs::write(p2.artifacts_dir().join("release-notes.md"), b"v0.1").unwrap();
        let status = evaluate(&p2).unwrap();
        let artifact_gate = status
            .gates
            .iter()
            .find(|g| matches!(g.gate, Gate::ArtifactExists { .. }))
            .unwrap();
        assert!(artifact_gate.passed);
        drop(paths);
    }

    #[test]
    fn doctor_gate_follows_workspace_health() {
        let (_g, paths) = workspace();
        let mut wf = load_workflow(&paths.workflow_file()).unwrap();
        wf.phases[0].exit_gates = vec![Gate::DoctorClean];
        save_workflow(&paths.workflow_file(), &wf).unwrap();

        let status = evaluate(&paths).unwrap();
        let gate = &status.gates[0];
        assert!(gate.passed, "fresh workspace must be doctor-clean: {}", gate.observed);
        assert!(gate.observed.contains("0 error(s)"));

        // Break a takeover surface (corrupt task file) → gate closes.
        std::fs::create_dir_all(paths.tasks_dir()).unwrap();
        std::fs::write(paths.tasks_dir().join("T-0666.json"), b"{broken").unwrap();
        let status = evaluate(&paths).unwrap();
        assert!(!status.gates[0].passed);

        // Warnings alone do not close the gate.
        std::fs::remove_file(paths.tasks_dir().join("T-0666.json")).unwrap();
        let mut md = std::fs::read_to_string(paths.agents_md_file()).unwrap();
        md.push_str(&"x".repeat(crate::workspace::doctor::CLAUDE_MD_MAX_BYTES as usize));
        std::fs::write(paths.agents_md_file(), md).unwrap();
        let status = evaluate(&paths).unwrap();
        assert!(status.gates[0].passed, "warnings advise, only errors block");
        assert!(status.gates[0].observed.contains("1 warning(s)"));
    }

    #[test]
    fn adopt_attaches_harness_to_legacy_workspace() {
        let (_g, paths) = workspace();
        // Simulate legacy: remove workflow.json.
        std::fs::remove_file(paths.workflow_file()).unwrap();
        assert!(try_evaluate(&paths).unwrap().is_none());

        let template = resolve_template(Some("life-v1"), None, Default::default()).unwrap();
        let status = adopt(&paths, &template, None, "0.1.0").unwrap();
        assert_eq!(status.workflow.template_id, "life-v1");
        assert_eq!(status.workflow.state.current_phase, "clarify");

        // Second adopt refuses.
        assert_eq!(adopt(&paths, &template, None, "0.1.0").unwrap_err().kind(), "workflow");
    }

    #[test]
    fn cancelled_tasks_are_closed_for_gates_and_do_not_count_as_planned() {
        let (_g, paths) = workspace();
        let id = task(&paths, "only task");
        update_task_status(&paths, "0.1.0", &id, TaskStatus::Cancelled, Some("dropped".into())).unwrap();
        let status = evaluate(&paths).unwrap();
        let min_tasks = status.gates.iter().find(|g| matches!(g.gate, Gate::MinTasks { .. })).unwrap();
        assert!(!min_tasks.passed, "a cancelled task is not planned work: {}", min_tasks.observed);

        let live = task(&paths, "real task");
        let status = evaluate(&paths).unwrap();
        assert!(status.can_advance, "plan needs one live task");
        advance_phase(&paths, "0.1.0", false, None).unwrap();
        update_task_status(&paths, "0.1.0", &live, TaskStatus::Done, None).unwrap();
        let status = evaluate(&paths).unwrap();
        let all_done = status.gates.iter().find(|g| matches!(g.gate, Gate::AllTasksDone)).unwrap();
        assert!(all_done.passed, "cancelled counts as closed: {}", all_done.observed);
        assert!(status.current_phase_entered_on().is_some_and(|d| d.len() == 10));
    }

    #[test]
    fn a_provisional_decision_does_not_pass_a_decision_gate() {
        let (_g, paths) = workspace();
        crate::workspace::ops::add_decision_with(&paths, "0.1.0", "assumed", None, true).unwrap();
        let entered = entered_at(&load_workflow(&paths.workflow_file()).unwrap(), "plan");
        assert_eq!(count_decisions_since(&paths, &entered).unwrap(), 0);
        crate::workspace::ops::add_decision(&paths, "0.1.0", "settled", None).unwrap();
        assert_eq!(count_decisions_since(&paths, &entered).unwrap(), 1);
    }

    // ── D171: ongoing, switching modes, rolling back ──────────────────────

    /// A workspace left at the product default: ongoing.
    fn ongoing_workspace() -> (tempfile::TempDir, WorkspacePaths) {
        let dir = tempfile::tempdir().unwrap();
        initialize_project(
            &InitProjectParams {
                root: dir.path().to_string_lossy().into_owned(),
                name: "ongoing-test".into(),
                ..Default::default()
            },
            &StaticKeyProvider([7u8; 32]),
            "0.1.0",
        )
        .unwrap();
        let paths = WorkspacePaths::new(dir.path());
        (dir, paths)
    }

    fn phase_vias(paths: &WorkspacePaths) -> Vec<String> {
        Ledger::new(paths.ledger_file())
            .recent_of_kind(LedgerKind::PhaseAdvanced, 20)
            .unwrap()
            .into_iter()
            .filter_map(|e| e.via)
            .collect()
    }

    #[test]
    fn ongoing_has_no_gates_and_refuses_every_phase_operation() {
        let (_g, paths) = ongoing_workspace();
        task(&paths, "a task");
        let status = evaluate(&paths).unwrap();
        assert!(status.is_ongoing(), "the product default (D171)");
        assert!(status.gates.is_empty());
        assert!(!status.can_advance);
        for forced in [false, true] {
            let err = advance_phase(&paths, "0.1.0", forced, Some("x".into())).unwrap_err();
            assert_eq!(err.kind(), "workflow");
            assert!(err.to_string().contains("runs ongoing"), "{err}");
        }
        assert_eq!(confirm_gate(&paths, "plan", "anything").unwrap_err().kind(), "workflow");
        assert_eq!(rollback_phase(&paths, "0.1.0").unwrap_err().kind(), "workflow");
        // Nothing moved and nothing was ledgered.
        assert_eq!(evaluate(&paths).unwrap().workflow.state.history.len(), 1);
        assert!(phase_vias(&paths).is_empty());
    }

    #[test]
    fn switching_modes_keeps_the_position_and_reenters_the_phase() {
        let (_g, paths) = workspace(); // staged
        task(&paths, "t");
        advance_phase(&paths, "0.1.0", false, None).unwrap(); // → execute

        let ongoing = set_mode(&paths, "0.1.0", WorkflowMode::Ongoing, None, TemplateLang::En).unwrap();
        assert!(ongoing.is_ongoing());
        assert_eq!(ongoing.workflow.state.current_phase, "execute", "the staged position is kept");
        assert_eq!(ongoing.workflow.state.history.last().unwrap().via, VIA_MODE_ONGOING);
        let state = std::fs::read_to_string(paths.agents_md_file()).unwrap();
        assert!(state.contains("runs **ongoing**"), "{state}");
        let raw = std::fs::read_to_string(paths.workflow_file()).unwrap();
        assert!(raw.contains("\"mode\": \"ongoing\""), "{raw}");

        // A no-op switch writes nothing.
        set_mode(&paths, "0.1.0", WorkflowMode::Ongoing, None, TemplateLang::En).unwrap();
        assert_eq!(evaluate(&paths).unwrap().workflow.state.history.len(), 3);

        let staged = set_mode(&paths, "0.1.0", WorkflowMode::Staged, None, TemplateLang::En).unwrap();
        assert!(!staged.is_ongoing());
        assert_eq!(staged.workflow.state.current_phase, "execute", "resumes where it was");
        let last = staged.workflow.state.history.last().unwrap().clone();
        assert_eq!(last.via, VIA_MODE_STAGED);
        // Re-entered at the switch: gates and the stall clock count from here.
        assert_eq!(staged.current_phase_entered_at(), Some(last.entered_at));
        assert_eq!(phase_vias(&paths), [VIA_ADVANCE, VIA_MODE_ONGOING, VIA_MODE_STAGED]);
        let raw = std::fs::read_to_string(paths.workflow_file()).unwrap();
        assert!(!raw.contains("\"mode\""), "staged writes no mode: {raw}");
    }

    #[test]
    fn a_workflow_from_before_d171_fetches_ongoing_instructions_from_its_template() {
        let (_g, paths) = workspace();
        // Strip the copy: a workflow.json written before D171 has none.
        let mut wf = load_workflow(&paths.workflow_file()).unwrap();
        wf.ongoing_instructions.clear();
        save_workflow(&paths.workflow_file(), &wf).unwrap();
        let s = set_mode(&paths, "0.1.0", WorkflowMode::Ongoing, None, TemplateLang::En).unwrap();
        assert!(!s.workflow.ongoing_instructions.is_empty());

        // A template that is gone cannot supply them: the switch is refused.
        set_mode(&paths, "0.1.0", WorkflowMode::Staged, None, TemplateLang::En).unwrap();
        let mut wf = load_workflow(&paths.workflow_file()).unwrap();
        wf.ongoing_instructions.clear();
        wf.template_id = "vanished-v1".into();
        save_workflow(&paths.workflow_file(), &wf).unwrap();
        let err = set_mode(&paths, "0.1.0", WorkflowMode::Ongoing, None, TemplateLang::En).unwrap_err();
        assert_eq!(err.kind(), "invalid_input");
        assert!(!evaluate(&paths).unwrap().is_ongoing());
    }

    /// A round trip through ongoing must not lose a finished workflow: the
    /// switch leaves the staged position alone (review W2 of D171).
    #[test]
    fn a_finished_staged_workflow_comes_back_finished() {
        let (_g, paths) = workspace();
        task(&paths, "t");
        for _ in 0..4 {
            advance_phase(&paths, "0.1.0", true, Some("jump".into())).unwrap();
        }
        assert!(evaluate(&paths).unwrap().workflow.state.completed);
        let ongoing = set_mode(&paths, "0.1.0", WorkflowMode::Ongoing, None, TemplateLang::En).unwrap();
        assert!(ongoing.is_ongoing() && !ongoing.can_advance);
        let state = std::fs::read_to_string(paths.agents_md_file()).unwrap();
        assert!(state.contains("runs **ongoing**"), "{state}");
        assert!(!state.contains("workflow **complete**"), "{state}");
        let staged = set_mode(&paths, "0.1.0", WorkflowMode::Staged, None, TemplateLang::En).unwrap();
        assert!(staged.workflow.state.completed, "comes back finished");
    }

    /// Advancing back into a phase that was stepped back from must ask for
    /// its confirmation again (review E1 of D171): the rollback clears the
    /// target and every later phase, not the target alone.
    #[test]
    fn a_phase_stepped_back_from_is_confirmed_again() {
        let (_g, paths) = workspace();
        let id = task(&paths, "t");
        advance_phase(&paths, "0.1.0", false, None).unwrap(); // → execute
        update_task_status(&paths, "0.1.0", &id, TaskStatus::Done, None).unwrap();
        advance_phase(&paths, "0.1.0", false, None).unwrap(); // → review
        const PROMPT: &str = "Confirmed the output meets the project goals";
        confirm_gate(&paths, "review", PROMPT).unwrap();
        crate::workspace::ops::add_decision(&paths, "0.1.0", "looks right", None).unwrap();
        assert!(evaluate(&paths).unwrap().can_advance);

        rollback_phase(&paths, "0.1.0").unwrap(); // review → execute
        advance_phase(&paths, "0.1.0", false, None).unwrap(); // → review again
        crate::workspace::ops::add_decision(&paths, "0.1.0", "fixed and re-checked", None).unwrap();
        let back = evaluate(&paths).unwrap();
        assert!(back.workflow.state.confirmations.is_empty(), "the old confirmation is gone");
        assert!(!back.can_advance, "a person has to look at the redone work");
    }

    /// Switching back to staged re-enters the phase: its decision count and
    /// its confirmations start over, the same as a rollback.
    #[test]
    fn switching_back_to_staged_restarts_the_phase_gates() {
        let (_g, paths) = workspace();
        let id = task(&paths, "t");
        advance_phase(&paths, "0.1.0", false, None).unwrap(); // → execute
        update_task_status(&paths, "0.1.0", &id, TaskStatus::Done, None).unwrap();
        advance_phase(&paths, "0.1.0", false, None).unwrap(); // → review
        confirm_gate(&paths, "review", "Confirmed the output meets the project goals").unwrap();
        crate::workspace::ops::add_decision(&paths, "0.1.0", "looks right", None).unwrap();
        assert!(evaluate(&paths).unwrap().can_advance);

        set_mode(&paths, "0.1.0", WorkflowMode::Ongoing, None, TemplateLang::En).unwrap();
        let back = set_mode(&paths, "0.1.0", WorkflowMode::Staged, None, TemplateLang::En).unwrap();
        assert_eq!(back.workflow.state.current_phase, "review");
        assert!(back.workflow.state.confirmations.is_empty());
        // (min_decisions restarts too, but timestamps are whole seconds and a
        // decision from the same second as the switch still counts — the
        // re-entry itself is pinned by `entered_at` in the test above.)
        let unmet: Vec<&str> = back.gates.iter().filter(|g| !g.passed).map(|g| g.gate.kind()).collect();
        assert!(unmet.contains(&"manual_confirm"), "{unmet:?}");
        assert!(!back.can_advance);
    }

    /// The instructions copied into a pre-D171 workflow.json follow the
    /// language the project was created in, not the UI's (review N1).
    #[test]
    fn ongoing_instructions_come_in_the_projects_own_language() {
        let (_g, paths) = workspace(); // English generic template
        let mut wf = load_workflow(&paths.workflow_file()).unwrap();
        wf.ongoing_instructions.clear();
        save_workflow(&paths.workflow_file(), &wf).unwrap();
        let s = set_mode(&paths, "0.1.0", WorkflowMode::Ongoing, None, TemplateLang::ZhTw).unwrap();
        let en = crate::workspace::templates::built_in_templates(TemplateLang::En).unwrap();
        let generic = en.iter().find(|t| t.id == "generic-v1").unwrap();
        assert_eq!(s.workflow.ongoing_instructions, generic.ongoing_instructions);
    }

    #[test]
    fn rollback_steps_back_one_phase_and_clears_its_confirmations() {
        let (_g, paths) = workspace();
        let id = task(&paths, "t");
        advance_phase(&paths, "0.1.0", false, None).unwrap(); // → execute
        update_task_status(&paths, "0.1.0", &id, TaskStatus::Done, None).unwrap();
        advance_phase(&paths, "0.1.0", false, None).unwrap(); // → review
        const PROMPT: &str = "Confirmed the output meets the project goals";
        confirm_gate(&paths, "review", PROMPT).unwrap();
        crate::workspace::ops::add_decision(&paths, "0.1.0", "ok", None).unwrap();
        advance_phase(&paths, "0.1.0", false, None).unwrap(); // → post_mortem

        let back = rollback_phase(&paths, "0.1.0").unwrap();
        assert_eq!(back.workflow.state.current_phase, "review");
        assert_eq!(back.workflow.state.history.last().unwrap().via, VIA_ROLLBACK);
        assert!(
            back.workflow.state.confirmations.iter().all(|c| c.phase != "review"),
            "work being redone is confirmed again"
        );
        assert!(!back.can_advance);
        assert_eq!(phase_vias(&paths).last().map(String::as_str), Some(VIA_ROLLBACK));

        // Back to the first phase, then no further.
        rollback_phase(&paths, "0.1.0").unwrap();
        rollback_phase(&paths, "0.1.0").unwrap();
        assert_eq!(evaluate(&paths).unwrap().workflow.state.current_phase, "plan");
        assert_eq!(rollback_phase(&paths, "0.1.0").unwrap_err().kind(), "invalid_input");
    }

    #[test]
    fn rollback_reopens_a_finished_workflow_in_its_last_phase() {
        let (_g, paths) = workspace();
        task(&paths, "t");
        for _ in 0..4 {
            advance_phase(&paths, "0.1.0", true, Some("jump".into())).unwrap();
        }
        let reopened = rollback_phase(&paths, "0.1.0").unwrap();
        assert!(!reopened.workflow.state.completed);
        assert_eq!(reopened.workflow.state.current_phase, "post_mortem");
    }
}
