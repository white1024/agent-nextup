//! Post-mortem flywheel with an evidence rule (nextup_docs/04, D20).
//!
//! Three prototype generations independently invented anti-bloat mechanics
//! for their rule files, and the survey found the same failure everywhere:
//! lesson lists grow, nothing rotates out, and the lessons that matter most
//! (from failed sessions) never get written because distillation depended on
//! an LLM being in the mood. This module is the deterministic floor:
//!
//! - **Evidence rule**: a lesson must cite ledger events that actually
//!   happened (`Lesson::evidence` = event `at` timestamps, validated on
//!   entry). No citation → no entry.
//! - **Rule-based distillation**: [`distill_candidates`] proposes lessons
//!   from hard ledger signals (gate overrides, blocked tasks, failed agent
//!   calls) with the evidence attached — zero LLM involved.
//! - **Rotation, not deletion**: lessons unfired for [`LESSON_STALE_DAYS`]
//!   move to `archived_lessons`. Absence of firing is not proof of
//!   uselessness, so the engine never deletes — that is a human call.
//! - **Cap**: at most [`MAX_ACTIVE_LESSONS`] active lessons; past the cap,
//!   rotate stale ones out first.

use chrono::{DateTime, Duration, Utc};
use serde::Serialize;

use crate::error::{NextUpError, Result};
use crate::workspace::context::now_rfc3339;
use crate::workspace::ledger::{ledger_for, CallOutcome, LedgerEvent, LedgerKind};
use crate::workspace::layout::WorkspacePaths;
use crate::workspace::lock::with_mutation_lock;
use crate::workspace::rules::{load_rules, save_rules, Lesson, ProjectRules, RuleRevision};
use crate::workspace::tasks::TaskStatus;
use crate::workspace::workflow::VIA_OVERRIDE;

pub const MAX_ACTIVE_LESSONS: usize = 20;
pub const LESSON_STALE_DAYS: i64 = 30;

/// Record a lesson with its ledger evidence. Every evidence ref must match an
/// event that actually happened; an uncitable lesson is refused outright.
pub fn add_lesson(
    paths: &WorkspacePaths,
    app_version: &str,
    text: &str,
    evidence: &[String],
) -> Result<ProjectRules> {
    let text = text.trim();
    if text.is_empty() {
        return Err(NextUpError::InvalidInput("lesson text cannot be empty".into()));
    }
    if evidence.is_empty() {
        return Err(NextUpError::InvalidInput(
            "a lesson needs ledger evidence (event timestamps) — no citation, no entry".into(),
        ));
    }
    with_mutation_lock(paths, || {
        let known: std::collections::HashSet<String> =
            ledger_for(paths).all()?.into_iter().map(|e| e.at).collect();
        for at in evidence {
            if !known.contains(at) {
                return Err(NextUpError::InvalidInput(format!(
                    "evidence '{at}' matches no ledger event — lessons must cite what actually happened"
                )));
            }
        }

        let mut rules = load_rules(&paths.rules_file())?;
        if rules
            .lessons
            .iter()
            .chain(rules.archived_lessons.iter())
            .any(|l| l.text == text)
        {
            return Err(NextUpError::InvalidInput("this lesson is already recorded".into()));
        }
        if rules.lessons.len() >= MAX_ACTIVE_LESSONS {
            let stale = stale_ids(&rules, Utc::now());
            return Err(NextUpError::InvalidInput(format!(
                "active lessons are at the cap ({MAX_ACTIVE_LESSONS}); run archive_stale_lessons \
                 first ({} stale candidate(s))",
                stale.len()
            )));
        }

        let lesson = Lesson {
            id: next_lesson_id(&rules),
            text: text.to_string(),
            evidence: evidence.to_vec(),
            added_at: now_rfc3339(),
            last_fired: None,
            fired_count: 0,
        };
        rules.flywheel.revision_history.push(RuleRevision {
            at: now_rfc3339(),
            summary: format!("lesson {} recorded: {text}", lesson.id),
        });
        let message = format!("lesson {} recorded: {text}", lesson.id);
        rules.lessons.push(lesson);
        save_rules(&paths.rules_file(), &rules)?;
        ledger_for(paths).append(&LedgerEvent::new(LedgerKind::LessonUpdated, message, None))?;
        crate::workspace::handoff::generate_handoff(paths, app_version)?;
        Ok(rules)
    })
}

/// A session applied this lesson (it prevented a mistake or shaped a call).
/// Firing is what keeps a lesson alive through rotation.
pub fn record_lesson_fired(
    paths: &WorkspacePaths,
    app_version: &str,
    id: &str,
) -> Result<ProjectRules> {
    with_mutation_lock(paths, || {
        let mut rules = load_rules(&paths.rules_file())?;
        let lesson = rules.lessons.iter_mut().find(|l| l.id == id).ok_or_else(|| {
            NextUpError::NotFound(format!("no active lesson '{id}' (archived ones cannot fire)"))
        })?;
        lesson.last_fired = Some(now_rfc3339());
        lesson.fired_count += 1;
        let message = format!("lesson {id} fired ({}x): {}", lesson.fired_count, lesson.text);
        save_rules(&paths.rules_file(), &rules)?;
        ledger_for(paths).append(&LedgerEvent::new(LedgerKind::LessonUpdated, message, None))?;
        crate::workspace::handoff::generate_handoff(paths, app_version)?;
        Ok(rules)
    })
}

/// Rotate lessons that have not fired for [`LESSON_STALE_DAYS`] into the
/// archive. Returns the rotated ids. Nothing is ever deleted.
pub fn archive_stale_lessons(
    paths: &WorkspacePaths,
    app_version: &str,
) -> Result<(ProjectRules, Vec<String>)> {
    archive_stale_lessons_at(paths, app_version, Utc::now())
}

pub fn archive_stale_lessons_at(
    paths: &WorkspacePaths,
    app_version: &str,
    now: DateTime<Utc>,
) -> Result<(ProjectRules, Vec<String>)> {
    with_mutation_lock(paths, || {
        let mut rules = load_rules(&paths.rules_file())?;
        let stale = stale_ids(&rules, now);
        if stale.is_empty() {
            return Ok((rules, Vec::new()));
        }
        let (rotate, keep): (Vec<Lesson>, Vec<Lesson>) =
            rules.lessons.into_iter().partition(|l| stale.contains(&l.id));
        rules.lessons = keep;
        rules.archived_lessons.extend(rotate);
        rules.flywheel.revision_history.push(RuleRevision {
            at: now_rfc3339(),
            summary: format!(
                "archived stale lesson(s) {} (unfired for {LESSON_STALE_DAYS}+ days; archived, not deleted)",
                stale.join(", ")
            ),
        });
        save_rules(&paths.rules_file(), &rules)?;
        ledger_for(paths).append(&LedgerEvent::new(
            LedgerKind::LessonUpdated,
            format!("lessons archived (stale): {}", stale.join(", ")),
            None,
        ))?;
        crate::workspace::handoff::generate_handoff(paths, app_version)?;
        Ok((rules, stale))
    })
}

fn stale_ids(rules: &ProjectRules, now: DateTime<Utc>) -> Vec<String> {
    let cutoff = now - Duration::days(LESSON_STALE_DAYS);
    rules
        .lessons
        .iter()
        .filter(|l| {
            let anchor = l.last_fired.as_deref().unwrap_or(l.added_at.as_str());
            DateTime::parse_from_rfc3339(anchor)
                .map(|t| t.with_timezone(&Utc) < cutoff)
                .unwrap_or(false)
        })
        .map(|l| l.id.clone())
        .collect()
}

fn next_lesson_id(rules: &ProjectRules) -> String {
    crate::workspace::ids::next_seq_id(
        "L-",
        rules.lessons.iter().chain(rules.archived_lessons.iter()).map(|l| l.id.as_str()),
    )
}

// ── Rule-based distillation (the deterministic floor) ───────────────────────

/// A machine-proposed lesson candidate. The engine only proposes — turning a
/// candidate into a lesson (possibly reworded) is the session's call, made
/// with the evidence already attached.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LessonCandidate {
    /// Stable signal id: gate_override | blocked_task | failed_agent_call
    pub signal: String,
    /// zh-TW prompt describing what happened and what to consider.
    pub suggestion: String,
    /// `at` timestamps of the ledger events behind this candidate.
    pub evidence: Vec<String>,
}

/// Scan the ledger for hard failure/friction signals and propose lesson
/// candidates with evidence attached. Deterministic — no LLM: the sessions
/// that most need a post-mortem are exactly the ones where an LLM-dependent
/// distiller failed to produce one.
pub fn distill_candidates(paths: &WorkspacePaths) -> Result<Vec<LessonCandidate>> {
    let events = ledger_for(paths).all()?;
    let mut candidates = Vec::new();

    // Each signal reads the structured field first (D75); the message-parse
    // arm exists only for pre-D75 lines, which never carry the field. New
    // lines always do, so prose wording is no longer load-bearing here.
    let overrides: Vec<&LedgerEvent> = events
        .iter()
        .filter(|e| {
            e.kind == LedgerKind::PhaseAdvanced
                && match e.via.as_deref() {
                    Some(via) => via == VIA_OVERRIDE,
                    None => e.message.contains("OVERRIDE:"),
                }
        })
        .collect();
    if !overrides.is_empty() {
        candidates.push(LessonCandidate {
            signal: "gate_override".into(),
            suggestion: format!(
                "This cycle had {} forced advances (override). Review each reason: is the gate badly designed (change the template), or was the process rushed (add a lesson)?",
                overrides.len()
            ),
            evidence: overrides.iter().map(|e| e.at.clone()).collect(),
        });
    }

    let blocked: Vec<&LedgerEvent> = events
        .iter()
        .filter(|e| {
            e.kind == LedgerKind::TaskStatusChanged
                && match e.to {
                    Some(to) => to == TaskStatus::Blocked,
                    None => e.message.contains("→ blocked"),
                }
        })
        .collect();
    if !blocked.is_empty() {
        candidates.push(LessonCandidate {
            signal: "blocked_task".into(),
            suggestion: format!(
                "This cycle had {} blocked tasks. Is there a pattern in the reasons that could have been avoided up front — an unconfirmed dependency, an unverified environment?",
                blocked.len()
            ),
            evidence: blocked.iter().map(|e| e.at.clone()).collect(),
        });
    }

    let failed_calls: Vec<&LedgerEvent> = events
        .iter()
        .filter(|e| {
            e.kind == LedgerKind::AgentToolCalled
                && match e.outcome {
                    Some(outcome) => outcome == CallOutcome::Failed,
                    None => e.message.contains(" failed: "),
                }
        })
        .collect();
    if !failed_calls.is_empty() {
        candidates.push(LessonCandidate {
            signal: "failed_agent_call".into(),
            suggestion: format!(
                "This cycle had {} failed hub tool calls. Do the error messages show a recurring trap — argument format, an unmet precondition — worth writing down as a lesson?",
                failed_calls.len()
            ),
            evidence: failed_calls.iter().map(|e| e.at.clone()).collect(),
        });
    }

    // Denial is its own signal, not a flavour of failure. `failed` means the
    // agent got something wrong; `denied` means it reached for authority it
    // does not have — the moment most worth a lesson, and the one the
    // distiller used to drop because `denied != failed`.
    let denied_calls: Vec<&LedgerEvent> = events
        .iter()
        .filter(|e| {
            e.kind == LedgerKind::AgentToolCalled
                && match e.outcome {
                    Some(outcome) => outcome == CallOutcome::Denied,
                    None => e.message.ends_with(" denied"),
                }
        })
        .collect();
    if !denied_calls.is_empty() {
        candidates.push(LessonCandidate {
            signal: "denied_agent_call".into(),
            suggestion: format!(
                "This cycle had {} hub tool calls refused for lack of authorization. Was the work planned around a tool the agent was never going to be allowed to use — and should that boundary be written down so the next session stops earlier?",
                denied_calls.len()
            ),
            evidence: denied_calls.iter().map(|e| e.at.clone()).collect(),
        });
    }

    Ok(candidates)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::security::keystore::StaticKeyProvider;
    use crate::workspace::init::{initialize_project, InitProjectParams};
    use crate::workspace::ledger::Ledger;
    use crate::workspace::ops::{create_task, update_task_status};
    use crate::workspace::tasks::{NewTask, TaskStatus};
    use crate::workspace::workflow::advance_phase;

    fn workspace() -> (tempfile::TempDir, WorkspacePaths) {
        let dir = tempfile::tempdir().unwrap();
        initialize_project(
            &InitProjectParams {
                root: dir.path().to_string_lossy().into_owned(),
                name: "flywheel-test".into(),
                domain: "coding".into(),
                description: String::new(),
                goals: vec![],
                boundaries: vec![],
                ..Default::default()
            },
            &StaticKeyProvider([5u8; 32]),
            "0.0.0-test",
        )
        .unwrap();
        let paths = WorkspacePaths::new(dir.path());
        (dir, paths)
    }

    fn some_evidence(paths: &WorkspacePaths) -> Vec<String> {
        vec![ledger_for(paths).recent(1).unwrap()[0].at.clone()]
    }

    #[test]
    fn lesson_requires_real_ledger_evidence() {
        let (_g, paths) = workspace();

        // No evidence → refused.
        let err = add_lesson(&paths, "0.1.0", "always pin versions", &[]).unwrap_err();
        assert_eq!(err.kind(), "invalid_input");

        // Fabricated evidence → refused (no citation, no entry).
        let err = add_lesson(
            &paths,
            "0.1.0",
            "always pin versions",
            &["2020-01-01T00:00:00Z".to_string()],
        )
        .unwrap_err();
        assert_eq!(err.kind(), "invalid_input");
        assert!(err.to_string().contains("no ledger event"));

        // Real evidence → recorded with id, revision history and ledger trail.
        let evidence = some_evidence(&paths);
        let rules = add_lesson(&paths, "0.1.0", "always pin versions", &evidence).unwrap();
        assert_eq!(rules.lessons.len(), 1);
        assert_eq!(rules.lessons[0].id, "L-0001");
        assert_eq!(rules.lessons[0].evidence, evidence);
        assert!(rules
            .flywheel
            .revision_history
            .last()
            .unwrap()
            .summary
            .contains("L-0001"));
        let trail = Ledger::new(paths.ledger_file())
            .recent_of_kind(LedgerKind::LessonUpdated, 5)
            .unwrap();
        assert_eq!(trail.len(), 1);

        // Duplicate text → refused.
        let err = add_lesson(&paths, "0.1.0", "always pin versions", &some_evidence(&paths)).unwrap_err();
        assert_eq!(err.kind(), "invalid_input");
    }

    #[test]
    fn firing_updates_metadata_and_archived_lessons_cannot_fire() {
        let (_g, paths) = workspace();
        add_lesson(&paths, "0.1.0", "verify before claiming done", &some_evidence(&paths)).unwrap();

        let rules = record_lesson_fired(&paths, "0.1.0", "L-0001").unwrap();
        assert_eq!(rules.lessons[0].fired_count, 1);
        assert!(rules.lessons[0].last_fired.is_some());

        assert_eq!(record_lesson_fired(&paths, "0.1.0", "L-9999").unwrap_err().kind(), "not_found");
    }

    #[test]
    fn stale_lessons_rotate_to_archive_never_deleted() {
        let (_g, paths) = workspace();
        add_lesson(&paths, "0.1.0", "old unused lesson", &some_evidence(&paths)).unwrap();
        add_lesson(&paths, "0.1.0", "freshly fired lesson", &some_evidence(&paths)).unwrap();
        record_lesson_fired(&paths, "0.1.0", "L-0002").unwrap();

        // Nothing stale yet.
        let (_, rotated) = archive_stale_lessons(&paths, "0.1.0").unwrap();
        assert!(rotated.is_empty());

        // Far in the future: L-0001 never fired → stale; L-0002 fired long ago → also stale.
        let later = Utc::now() + Duration::days(LESSON_STALE_DAYS + 1);
        let (rules, rotated) = archive_stale_lessons_at(&paths, "0.1.0", later).unwrap();
        assert_eq!(rotated, vec!["L-0001".to_string(), "L-0002".to_string()]);
        assert!(rules.lessons.is_empty());
        assert_eq!(rules.archived_lessons.len(), 2, "archived, not deleted");

        // Ids never recycle after archiving.
        let rules = add_lesson(&paths, "0.1.0", "new lesson", &some_evidence(&paths)).unwrap();
        assert_eq!(rules.lessons[0].id, "L-0003");
    }

    #[test]
    fn cap_forces_rotation_before_new_lessons() {
        let (_g, paths) = workspace();
        for i in 0..MAX_ACTIVE_LESSONS {
            add_lesson(&paths, "0.1.0", &format!("lesson number {i}"), &some_evidence(&paths)).unwrap();
        }
        let err = add_lesson(&paths, "0.1.0", "one too many", &some_evidence(&paths)).unwrap_err();
        assert_eq!(err.kind(), "invalid_input");
        assert!(err.to_string().contains("archive_stale_lessons"));
    }

    #[test]
    fn distillation_finds_hard_signals_with_evidence() {
        let (_g, paths) = workspace();
        // Signal 1: a gate override.
        advance_phase(&paths, "0.1.0", true, Some("rushing the demo".into())).unwrap();
        // Signal 2: a blocked task.
        let t = create_task(&paths, "0.1.0", NewTask { title: "b".into(), priority: 1, ..Default::default() },
        )
        .unwrap();
        update_task_status(&paths, "0.1.0", &t.id, TaskStatus::Blocked, Some("waiting on API".into()))
            .unwrap();

        let candidates = distill_candidates(&paths).unwrap();
        let signals: Vec<&str> = candidates.iter().map(|c| c.signal.as_str()).collect();
        assert!(signals.contains(&"gate_override"));
        assert!(signals.contains(&"blocked_task"));

        // Every candidate's evidence must be replayable — accepted by add_lesson.
        let ov = candidates.iter().find(|c| c.signal == "gate_override").unwrap();
        let rules = add_lesson(&paths, "0.1.0", "review override reasons each cycle", &ov.evidence).unwrap();
        assert_eq!(rules.lessons[0].evidence, ov.evidence);

        // A quiet ledger proposes nothing.
        let (_g2, calm) = workspace();
        assert!(distill_candidates(&calm).unwrap().is_empty());
    }

    /// A refused call is the retrospective's most valuable input and used to
    /// be invisible to it: the distiller only looked for `failed`, so
    /// "you were denied the tool your whole plan depended on" produced no
    /// candidate at all.
    #[test]
    fn distillation_surfaces_denied_calls_separately_from_failures() {
        let (_g, paths) = workspace();
        let ledger = ledger_for(&paths);
        ledger
            .append(
                &LedgerEvent::new(LedgerKind::AgentToolCalled, "set_task_verification denied", None)
                    .with_call("set_task_verification", CallOutcome::Denied)
                    .with_reason(Some("not authorized".into())),
            )
            .unwrap();

        let candidates = distill_candidates(&paths).unwrap();
        let denied = candidates
            .iter()
            .find(|c| c.signal == "denied_agent_call")
            .expect("a denial must propose a lesson");
        assert_eq!(denied.evidence.len(), 1);
        assert!(
            !candidates.iter().any(|c| c.signal == "failed_agent_call"),
            "a denial is not a failure — merging them loses why it stopped"
        );
        // Evidence must be replayable, like every other signal.
        add_lesson(&paths, "0.1.0", "check the allowlist before planning", &denied.evidence)
            .unwrap();
    }

    /// Pre-D75 lines carry no structured fields — the message-parse fallback
    /// must keep finding all three signals in a historical ledger.
    #[test]
    fn distillation_reads_pre_d75_lines_via_message_fallback() {
        let (_g, paths) = workspace();
        let ledger = ledger_for(&paths);
        // `LedgerEvent::new` leaves every D75 field None — exactly the shape
        // of a line written before the fields existed.
        ledger
            .append(&LedgerEvent::new(
                LedgerKind::PhaseAdvanced,
                "phase \"a\" → \"b\" (OVERRIDE: rushed)",
                None,
            ))
            .unwrap();
        ledger
            .append(&LedgerEvent::new(
                LedgerKind::TaskStatusChanged,
                "\"t\": in_progress → blocked",
                Some("T-0001".into()),
            ))
            .unwrap();
        ledger
            .append(&LedgerEvent::new(
                LedgerKind::AgentToolCalled,
                "create_task failed: invalid input: empty title",
                None,
            ))
            .unwrap();

        let signals: Vec<String> =
            distill_candidates(&paths).unwrap().into_iter().map(|c| c.signal).collect();
        assert!(signals.contains(&"gate_override".to_string()));
        assert!(signals.contains(&"blocked_task".to_string()));
        assert!(signals.contains(&"failed_agent_call".to_string()));
    }

    /// On lines that do carry the structured fields, the fields decide and
    /// the prose is ignored — a phase titled "OVERRIDE: drill" or an error
    /// text quoting " failed: " can no longer fake a signal (D75).
    #[test]
    fn distillation_prefers_structured_fields_over_prose() {
        let (_g, paths) = workspace();
        let ledger = ledger_for(&paths);
        ledger
            .append(
                &LedgerEvent::new(
                    LedgerKind::PhaseAdvanced,
                    "phase \"OVERRIDE: drill\" → \"next\"",
                    None,
                )
                .with_via(crate::workspace::workflow::VIA_ADVANCE),
            )
            .unwrap();
        ledger
            .append(
                &LedgerEvent::new(
                    LedgerKind::TaskStatusChanged,
                    "\"escape → blocked path\": blocked → done",
                    Some("T-0001".into()),
                )
                .with_transition(TaskStatus::Blocked, TaskStatus::Done),
            )
            .unwrap();
        ledger
            .append(
                &LedgerEvent::new(
                    LedgerKind::AgentToolCalled,
                    "add_note ok (2 ms) — noted: previous run failed: timeout",
                    None,
                )
                .with_call("add_note", CallOutcome::Ok),
            )
            .unwrap();

        assert!(
            distill_candidates(&paths).unwrap().is_empty(),
            "structured fields must beat prose look-alikes"
        );
    }
}
