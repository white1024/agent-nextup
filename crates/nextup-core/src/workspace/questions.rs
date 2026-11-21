//! Questions for the user, and the "to decide" queue (D170).
//!
//! An external PM answered some fifty questions and signed off sixty-odd
//! decisions, every one of them in the chat: the agent stopped, the PM
//! answered, the agent went on. Nothing let a question wait for a convenient
//! moment, carry its recommended answer, say who should really answer it, or
//! name the work it holds up — so the PM built a register, discussion
//! documents and a sync hook by hand. This module is that register.
//!
//! One question = one JSON file under `.nextup/questions/` (`Q-0001.json`),
//! the same file-is-truth shape as tasks. Agents ask through the hub
//! (`ask_user`), the person answers in the app, and the answer is ledgered as
//! a decision — it *is* one, made by the person. Provisional decisions (taken
//! on a default, `record_decision { provisional }`) join the same queue as
//! "to review"; they live in the ledger, so this module only projects them.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::error::{NextUpError, Result};
use crate::workspace::atomic::atomic_write_json;
use crate::workspace::context::now_rfc3339;
use crate::workspace::layout::WorkspacePaths;
use crate::workspace::ledger::{Ledger, LedgerEvent, LedgerKind};
use crate::workspace::tasks::TaskStore;

pub const QUESTION_SCHEMA_VERSION: u32 = 1;
/// Longest question or answer the store keeps. A question past this is a
/// discussion document, and belongs in one.
pub const MAX_QUESTION_CHARS: usize = 4000;
/// Most answer choices one question may offer.
pub const MAX_QUESTION_OPTIONS: usize = 10;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum QuestionStatus {
    Open,
    Answered,
    /// No longer needs an answer — the person said so, or it was overtaken.
    Withdrawn,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Question {
    pub schema_version: u32,
    pub id: String,
    pub question: String,
    /// What the asker would do; the app offers it as the one-press answer.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recommendation: Option<String>,
    /// Answer choices, when the question has a closed set.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub options: Vec<String>,
    /// Who should really answer it, when that is not the user (legal, the
    /// vendor, a manager). The user still records the answer — but sees at a
    /// glance which questions are theirs to forward rather than to decide.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ask: Option<String>,
    /// Tasks this question holds up.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub blocks: Vec<String>,
    /// What the asker proceeds on if nobody answers.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_answer: Option<String>,
    pub status: QuestionStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub answer: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub answered_at: Option<String>,
    /// The decision id the answer was ledgered under.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub decision_id: Option<String>,
    /// When an agent last read the answer through the hub. Until then the
    /// takeover surfaces list it as an answer nobody has picked up.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub seen_at: Option<String>,
    /// The hub identity that asked, when it declared one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub asked_by: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

/// What an agent sends to ask (`ask_user`).
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewQuestion {
    pub question: String,
    #[serde(default)]
    pub recommendation: Option<String>,
    #[serde(default)]
    pub options: Vec<String>,
    #[serde(default)]
    pub ask: Option<String>,
    #[serde(default)]
    pub blocks: Vec<String>,
    #[serde(default)]
    pub default_answer: Option<String>,
}

pub struct QuestionStore {
    dir: PathBuf,
}

impl QuestionStore {
    pub fn new(paths: &WorkspacePaths) -> Self {
        Self { dir: paths.questions_dir() }
    }

    fn file(&self, id: &str) -> Result<PathBuf> {
        validate_question_id(id)?;
        Ok(self.dir.join(format!("{id}.json")))
    }

    /// Every question, oldest first. Unparsable files are skipped, the way
    /// task listing skips them.
    pub fn list(&self) -> Result<Vec<Question>> {
        let mut out = Vec::new();
        if !self.dir.is_dir() {
            return Ok(out);
        }
        for entry in std::fs::read_dir(&self.dir)? {
            let path = entry?.path();
            if path.extension().and_then(|e| e.to_str()) != Some("json") {
                continue;
            }
            let Ok(raw) = std::fs::read(&path) else { continue };
            if let Ok(q) = serde_json::from_slice::<Question>(&raw) {
                if path.file_stem().and_then(|s| s.to_str()) == Some(q.id.as_str()) {
                    out.push(q);
                }
            }
        }
        out.sort_by(|a, b| a.id.cmp(&b.id));
        Ok(out)
    }

    pub fn get(&self, id: &str) -> Result<Question> {
        let path = self.file(id)?;
        if !path.is_file() {
            return Err(NextUpError::NotFound(format!("question {id} does not exist")));
        }
        crate::workspace::atomic::read_json_file(&path)
    }

    pub fn create(&self, input: NewQuestion, asked_by: Option<String>, tasks: &TaskStore) -> Result<Question> {
        let question = required_text("question", input.question)?;
        let options: Vec<String> =
            input.options.into_iter().map(|o| o.trim().to_string()).filter(|o| !o.is_empty()).collect();
        if options.len() > MAX_QUESTION_OPTIONS {
            return Err(NextUpError::InvalidInput(format!(
                "a question may offer at most {MAX_QUESTION_OPTIONS} options"
            )));
        }
        let mut blocks = Vec::new();
        for id in input.blocks {
            let id = id.trim().to_string();
            if id.is_empty() || blocks.contains(&id) {
                continue;
            }
            tasks.get(&id).map_err(|_| {
                NextUpError::InvalidInput(format!("blocks names {id}, which is not a task here"))
            })?;
            blocks.push(id);
        }
        std::fs::create_dir_all(&self.dir)?;
        let now = now_rfc3339();
        let q = Question {
            schema_version: QUESTION_SCHEMA_VERSION,
            id: self.next_id()?,
            question,
            recommendation: optional_text(input.recommendation)?,
            options,
            ask: optional_text(input.ask)?,
            blocks,
            default_answer: optional_text(input.default_answer)?,
            status: QuestionStatus::Open,
            answer: None,
            answered_at: None,
            decision_id: None,
            seen_at: None,
            asked_by: asked_by.map(|a| a.trim().to_string()).filter(|a| !a.is_empty()),
            created_at: now.clone(),
            updated_at: now,
        };
        atomic_write_json(&self.file(&q.id)?, &q)?;
        Ok(q)
    }

    /// Record the answer. Only an open question takes one — answering twice
    /// would leave two decisions claiming to be the answer.
    pub fn answer(&self, id: &str, answer: String, decision_id: String) -> Result<Question> {
        let mut q = self.get(id)?;
        if q.status != QuestionStatus::Open {
            return Err(NextUpError::InvalidInput(format!("{id} is not open")));
        }
        let now = now_rfc3339();
        q.answer = Some(required_text("answer", answer)?);
        q.status = QuestionStatus::Answered;
        q.answered_at = Some(now.clone());
        q.decision_id = Some(decision_id);
        q.updated_at = now;
        atomic_write_json(&self.file(id)?, &q)?;
        Ok(q)
    }

    pub fn withdraw(&self, id: &str) -> Result<Question> {
        let mut q = self.get(id)?;
        if q.status != QuestionStatus::Open {
            return Err(NextUpError::InvalidInput(format!("{id} is not open")));
        }
        q.status = QuestionStatus::Withdrawn;
        q.updated_at = now_rfc3339();
        atomic_write_json(&self.file(id)?, &q)?;
        Ok(q)
    }

    /// Stamp `seen_at` on the answered questions in `ids` that have none.
    /// Returns whether anything changed.
    pub fn mark_seen(&self, ids: &[String]) -> Result<bool> {
        let now = now_rfc3339();
        let mut changed = false;
        for id in ids {
            let mut q = self.get(id)?;
            if q.status == QuestionStatus::Answered && q.seen_at.is_none() {
                q.seen_at = Some(now.clone());
                atomic_write_json(&self.file(id)?, &q)?;
                changed = true;
            }
        }
        Ok(changed)
    }

    fn next_id(&self) -> Result<String> {
        let mut stems = Vec::new();
        if self.dir.is_dir() {
            for entry in std::fs::read_dir(&self.dir)? {
                let name = entry?.file_name();
                if let Some(stem) = name.to_string_lossy().strip_suffix(".json") {
                    stems.push(stem.to_string());
                }
            }
        }
        Ok(super::ids::next_seq_id("Q-", stems.iter().map(String::as_str)))
    }
}

/// `Q-` and digits — the only shape the store mints, checked before an id
/// becomes a path (the task-id rule, for the same reason).
pub fn validate_question_id(id: &str) -> Result<()> {
    let digits = id.strip_prefix("Q-").unwrap_or("");
    if !digits.is_empty() && digits.len() <= 9 && digits.bytes().all(|b| b.is_ascii_digit()) {
        return Ok(());
    }
    let shown: String = id.chars().take(40).collect();
    Err(NextUpError::InvalidInput(format!("question id must look like Q-0001 — got '{shown}'")))
}

fn required_text(field: &str, text: String) -> Result<String> {
    let text = text.trim().to_string();
    if text.is_empty() {
        return Err(NextUpError::InvalidInput(format!("{field} cannot be empty")));
    }
    if text.chars().count() > MAX_QUESTION_CHARS {
        return Err(NextUpError::InvalidInput(format!(
            "{field} is longer than {MAX_QUESTION_CHARS} characters — put the long version in a document and link it"
        )));
    }
    Ok(text)
}

fn optional_text(text: Option<String>) -> Result<Option<String>> {
    match text.map(|t| t.trim().to_string()).filter(|t| !t.is_empty()) {
        Some(t) if t.chars().count() > MAX_QUESTION_CHARS => Err(NextUpError::InvalidInput(format!(
            "a field is longer than {MAX_QUESTION_CHARS} characters"
        ))),
        other => Ok(other),
    }
}

/// Provisional decisions nobody has reviewed yet: a provisional `Decision`
/// whose id no later decision supersedes. Oldest first.
pub fn pending_provisional(ledger: &Ledger) -> Result<Vec<LedgerEvent>> {
    let decisions: Vec<LedgerEvent> =
        ledger.all()?.into_iter().filter(|e| e.kind == LedgerKind::Decision).collect();
    let overturned: std::collections::HashSet<&str> =
        decisions.iter().filter_map(|e| e.supersedes.as_deref()).collect();
    Ok(decisions
        .iter()
        .filter(|e| e.provisional && e.id.as_deref().is_some_and(|id| !overturned.contains(id)))
        .cloned()
        .collect())
}

/// What is waiting on the person, for the takeover surfaces (D170).
#[derive(Debug, Clone, Default)]
pub struct AskSummary {
    pub open: Vec<Question>,
    /// Answered, and no agent has read the answer through the hub yet.
    pub unread_answers: Vec<Question>,
    pub to_review: Vec<LedgerEvent>,
}

pub fn ask_summary(paths: &WorkspacePaths) -> Result<AskSummary> {
    let questions = QuestionStore::new(paths).list()?;
    Ok(AskSummary {
        open: questions.iter().filter(|q| q.status == QuestionStatus::Open).cloned().collect(),
        unread_answers: questions
            .iter()
            .filter(|q| q.status == QuestionStatus::Answered && q.seen_at.is_none())
            .cloned()
            .collect(),
        to_review: pending_provisional(&Ledger::new(paths.ledger_file()))?,
    })
}

impl AskSummary {
    /// The lines both takeover surfaces print (D170), or nothing at all when
    /// nothing waits — a workspace that never asks anything reads as it did.
    /// Answers come first: they are what the next session must act on.
    pub fn render(&self, clamp: impl Fn(&str) -> String) -> String {
        let mut md = String::new();
        if !self.unread_answers.is_empty() {
            md.push_str("\n**Answered — read these first** (call `list_questions` to pick them up):\n");
            for q in &self.unread_answers {
                md.push_str(&format!(
                    "- {} {} → **{}**\n",
                    q.id,
                    clamp(&q.question),
                    clamp(q.answer.as_deref().unwrap_or_default())
                ));
            }
        }
        if !self.open.is_empty() || !self.to_review.is_empty() {
            md.push_str("\n**Waiting on the user** (in the app's To decide page; carry on with other work):\n");
            for q in &self.open {
                let whom = q.ask.as_deref().map(|a| format!(" (to forward to {a})")).unwrap_or_default();
                let holds = if q.blocks.is_empty() {
                    String::new()
                } else {
                    format!(" — holds {}", q.blocks.join(", "))
                };
                md.push_str(&format!("- {}{whom} {}{holds}\n", q.id, clamp(&q.question)));
            }
            for d in &self.to_review {
                md.push_str(&format!(
                    "- {} provisional, awaiting review: {}\n",
                    d.id.as_deref().unwrap_or("decision"),
                    clamp(&d.message)
                ));
            }
        }
        md
    }
}

/// The two numbers the sidebar badge and the project card show (D170).
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct YouCounts {
    pub questions: usize,
    pub decisions: usize,
}

/// Best-effort for display surfaces: a workspace whose ledger cannot be read
/// still shows its card, just without these numbers.
pub fn you_counts(paths: &WorkspacePaths) -> YouCounts {
    let questions = QuestionStore::new(paths)
        .list()
        .map(|qs| qs.iter().filter(|q| q.status == QuestionStatus::Open).count())
        .unwrap_or(0);
    let decisions = pending_provisional(&Ledger::new(paths.ledger_file())).map(|d| d.len()).unwrap_or(0);
    YouCounts { questions, decisions }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::security::keystore::StaticKeyProvider;
    use crate::workspace::init::{initialize_project, InitProjectParams};
    use crate::workspace::ops;
    use crate::workspace::tasks::NewTask;

    fn workspace() -> (tempfile::TempDir, WorkspacePaths) {
        let dir = tempfile::tempdir().unwrap();
        initialize_project(
            &InitProjectParams {
                root: dir.path().to_string_lossy().into_owned(),
                name: "ask".into(),
                ..Default::default()
            },
            &StaticKeyProvider([3u8; 32]),
            "0.1.0",
        )
        .unwrap();
        let paths = WorkspacePaths::new(dir.path());
        (dir, paths)
    }

    #[test]
    fn a_question_waits_is_answered_as_a_decision_and_is_read_once() {
        let (_g, paths) = workspace();
        let t = ops::create_task(&paths, "0.1.0", NewTask { title: "pay rules".into(), ..Default::default() })
            .unwrap();
        let bad = NewQuestion { question: "?".into(), blocks: vec!["T-9999".into()], ..Default::default() };
        assert_eq!(ops::ask_user(&paths, "0.1.0", bad, None).unwrap_err().kind(), "invalid_input");

        let q = ops::ask_user(
            &paths,
            "0.1.0",
            NewQuestion {
                question: "Round seniority per segment or once at the end?".into(),
                recommendation: Some("Once at the end, as 1.0 does".into()),
                ask: Some("legal".into()),
                blocks: vec![t.id.clone()],
                ..Default::default()
            },
            Some("agent-a".into()),
        )
        .unwrap();
        assert_eq!(q.id, "Q-0001");
        let summary = ask_summary(&paths).unwrap();
        assert_eq!(summary.open.len(), 1);
        let agents = std::fs::read_to_string(paths.agents_md_file()).unwrap();
        assert!(agents.contains("**Waiting on the user**"), "{agents}");
        assert!(agents.contains("Q-0001 (to forward to legal)"));
        assert_eq!(you_counts(&paths), YouCounts { questions: 1, decisions: 0 });

        let answered = ops::answer_question(&paths, "0.1.0", "Q-0001", "Once at the end").unwrap();
        let decision = Ledger::new(paths.ledger_file()).decision(answered.decision_id.as_deref().unwrap()).unwrap().unwrap();
        assert!(decision.message.starts_with("Q-0001 Round seniority"), "{}", decision.message);
        assert!(!decision.provisional);
        assert_eq!(ops::answer_question(&paths, "0.1.0", "Q-0001", "again").unwrap_err().kind(), "invalid_input");

        let agents = std::fs::read_to_string(paths.agents_md_file()).unwrap();
        assert!(agents.contains("**Answered — read these first**"));
        // The agent reads it once; the surfaces stop listing it.
        let read = ops::read_questions_as_agent(&paths, "0.1.0", false).unwrap();
        assert_eq!(read.len(), 1);
        assert!(read[0].seen_at.is_some());
        assert!(ops::read_questions_as_agent(&paths, "0.1.0", false).unwrap().is_empty());
        let agents = std::fs::read_to_string(paths.agents_md_file()).unwrap();
        assert!(!agents.contains("read these first"));
    }

    #[test]
    fn a_provisional_decision_waits_for_review_and_does_not_feed_the_decision_gate() {
        let (_g, paths) = workspace();
        let d = ops::add_decision_with(&paths, "0.1.0", "Use 1.0's rounding", None, true).unwrap();
        let id = d.id.clone().unwrap();
        assert_eq!(you_counts(&paths).decisions, 1);
        let agents = std::fs::read_to_string(paths.agents_md_file()).unwrap();
        assert!(agents.contains("provisional, awaiting review"), "{agents}");
        assert!(agents.contains("(provisional) Use 1.0"));

        // Confirming supersedes it with a settled copy.
        let confirmed = ops::review_decision(&paths, "0.1.0", &id, None).unwrap();
        assert_eq!(confirmed.supersedes.as_deref(), Some(id.as_str()));
        assert!(!confirmed.provisional);
        assert!(confirmed.message.starts_with("Use 1.0's rounding"));
        assert_eq!(you_counts(&paths).decisions, 0);
        assert_eq!(ops::review_decision(&paths, "0.1.0", &id, None).unwrap_err().kind(), "invalid_input");

        // A revision replaces the text.
        let d2 = ops::add_decision_with(&paths, "0.1.0", "Show codes on the meeting page", None, true).unwrap();
        let revised = ops::review_decision(&paths, "0.1.0", d2.id.as_deref().unwrap(), Some("No codes on the meeting page")).unwrap();
        assert_eq!(revised.message, "No codes on the meeting page");
    }
}

