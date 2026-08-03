//! Spec layer (D79): parse / delta / fold for the workspace's curated
//! "how things behave now" truth under `specs/<capability>/spec.md`.
//!
//! Format and algorithm are OpenSpec-compatible by decision (nextup_docs/15
//! §2-§3): requirement identity is the `### Requirement:` heading trimmed and
//! compared **case-sensitively**; deltas use four H2 sections (ADDED /
//! MODIFIED / REMOVED / RENAMED Requirements) where MODIFIED is a full-block
//! rewrite, never a diff; fold applies RENAMED→REMOVED→MODIFIED→ADDED,
//! hard-aborts on conflicts, and treats already-synced edits as no-ops
//! (files are the truth — humans may have edited the main spec first).
//!
//! The algorithm layer here is pure (no ledger, no locking, no writes);
//! the tail of the module adds the one thin **read-only** disk-discovery
//! face every consumer shares. Mutation wiring lives in ops: the archive
//! path dry-runs `fold_batch`, writes only when the whole bundle validates,
//! and wraps conflicts in `SpecFoldConflict` (batch ②).

use std::path::Path;

use crate::error::{NextUpError, Result};
use crate::workspace::ids::{is_valid_slug, SLUG_RULE};
use crate::workspace::layout::{WorkspacePaths, SPEC_FILE};

/// Capability directory names must be filesystem-safe on every platform;
/// same rule as custom template ids (ids::SLUG_RULE, D43/D79).
pub fn validate_capability_name(name: &str) -> Result<()> {
    if is_valid_slug(name) {
        Ok(())
    } else {
        Err(NextUpError::InvalidInput(format!("capability '{name}' must be {SLUG_RULE}")))
    }
}

// ---------------------------------------------------------------------------
// Parse model
// ---------------------------------------------------------------------------

/// One `### Requirement:` block: heading line through the line before the
/// next requirement heading / H2 / EOF. `body` is the exact source text
/// (heading included) so reassembly is lossless.
#[derive(Debug, Clone, PartialEq)]
pub struct RequirementBlock {
    pub name: String,
    pub body: String,
    /// `#### Scenario:` names in order (duplicates kept — the MODIFIED
    /// preservation check is multiplicity-aware, mirroring OpenSpec).
    pub scenarios: Vec<String>,
}

#[derive(Debug, Clone)]
enum Segment {
    /// Exact non-requirement text (preamble, section headings, trailing
    /// notes). Never rewritten — fold only touches requirement segments.
    Prose(String),
    Requirement(RequirementBlock),
}

/// A parsed main spec. Parsing is total: any markdown yields a document
/// (a file with no requirement headings is all prose). Reassembling an
/// untouched document reproduces the input byte-for-byte.
#[derive(Debug, Clone)]
pub struct SpecDoc {
    segments: Vec<Segment>,
    /// A ``` fence was opened but never closed — headings after it were
    /// masked to the end of file. A fold refuses such a main spec: masked
    /// requirements would turn every REMOVED/MODIFIED into a lying no-op.
    pub unclosed_fence: bool,
    /// The document carries a `## Requirements` heading somewhere unmasked
    /// — recorded at parse time (segment-local re-scans can't see fences
    /// that span segments).
    pub has_requirements_heading: bool,
}

impl SpecDoc {
    pub fn requirements(&self) -> impl Iterator<Item = &RequirementBlock> {
        self.segments.iter().filter_map(|s| match s {
            Segment::Requirement(b) => Some(b),
            Segment::Prose(_) => None,
        })
    }

    fn render(&self) -> String {
        let mut out = String::new();
        for seg in &self.segments {
            match seg {
                Segment::Prose(t) => out.push_str(t),
                Segment::Requirement(b) => out.push_str(&b.body),
            }
        }
        out
    }
}

/// Split into lines (terminators kept) with a code-fence mask: headings
/// inside ``` / ~~~ fences are literal text, not structure. The fence
/// delimiter lines themselves are masked too.
///
/// CommonMark closing rules matter here (batch ① review): a closer must use
/// the same marker character, be at least as long as the opener, and carry
/// no info string — so a ```` ```rust ```` line inside an open fence is
/// content, not a closer, and a ``` line inside a ~~~ fence stays masked.
fn masked_lines(content: &str) -> (Vec<(&str, bool)>, bool) {
    struct Fence {
        ch: char,
        len: usize,
    }
    let mut lines = Vec::new();
    let mut fence: Option<Fence> = None;
    for line in content.split_inclusive('\n') {
        let t = line.trim_start();
        let indent = line.len() - t.len();
        // CommonMark allows up to 3 leading spaces on a fence delimiter.
        let run_ch = t.chars().next().filter(|c| *c == '`' || *c == '~');
        let run_len = run_ch.map_or(0, |c| t.chars().take_while(|x| *x == c).count());
        let is_delim = indent <= 3 && run_len >= 3;
        if is_delim {
            let ch = run_ch.unwrap();
            let rest_blank = t[run_len..].trim().is_empty();
            match &fence {
                None => fence = Some(Fence { ch, len: run_len }),
                Some(f) if f.ch == ch && run_len >= f.len && rest_blank => fence = None,
                Some(_) => {} // a foreign/short/infoed delimiter is fence content
            }
            lines.push((line, true));
        } else {
            lines.push((line, fence.is_some()));
        }
    }
    let unclosed = fence.is_some();
    (lines, unclosed)
}

fn stripped(line: &str) -> &str {
    line.trim_end_matches(['\r', '\n'])
}

/// `### Requirement: <name>` at column 0 (heading outside a fence).
fn requirement_name(line: &str) -> Option<&str> {
    stripped(line).strip_prefix("### Requirement:").map(str::trim)
}

/// `#### Scenario: <name>` — exactly four hashes, per OpenSpec convention.
fn scenario_name(line: &str) -> Option<&str> {
    stripped(line).strip_prefix("#### Scenario:").map(str::trim)
}

/// An H2 line (`## …`), which terminates a requirement block. Whitespace
/// after the hashes is tolerated like OpenSpec's `^##\s+` (batch ① review:
/// exact-prefix matching made a trailing-space heading silently vanish).
fn is_h2(line: &str) -> bool {
    let s = stripped(line);
    match s.strip_prefix("##") {
        Some(rest) => !rest.starts_with('#') && rest.starts_with(char::is_whitespace),
        None => false,
    }
}

/// H2 text normalized for comparison: lowercased, inner/edge whitespace
/// collapsed — `##  ADDED   Requirements ` and `## added requirements`
/// are the same heading.
fn h2_normalized(line: &str) -> Option<String> {
    let s = stripped(line);
    let rest = s.strip_prefix("##")?;
    if rest.starts_with('#') || !rest.starts_with(char::is_whitespace) {
        return None;
    }
    Some(rest.split_whitespace().collect::<Vec<_>>().join(" ").to_ascii_lowercase())
}

pub fn parse_spec(content: &str) -> SpecDoc {
    let (lines, unclosed) = masked_lines(content);
    let has_requirements_heading = lines
        .iter()
        .any(|(l, masked)| !masked && h2_normalized(l).as_deref() == Some("requirements"));
    let mut segments: Vec<Segment> = Vec::new();
    let mut prose = String::new();
    let mut block: Option<RequirementBlock> = None;

    let flush_prose = |segments: &mut Vec<Segment>, prose: &mut String| {
        if !prose.is_empty() {
            segments.push(Segment::Prose(std::mem::take(prose)));
        }
    };
    let flush_block = |segments: &mut Vec<Segment>, block: &mut Option<RequirementBlock>| {
        if let Some(b) = block.take() {
            segments.push(Segment::Requirement(b));
        }
    };

    for (line, masked) in lines {
        if !masked {
            if let Some(name) = requirement_name(line) {
                flush_block(&mut segments, &mut block);
                flush_prose(&mut segments, &mut prose);
                block = Some(RequirementBlock {
                    name: name.to_string(),
                    body: line.to_string(),
                    scenarios: Vec::new(),
                });
                continue;
            }
            if is_h2(line) && block.is_some() {
                flush_block(&mut segments, &mut block);
                prose.push_str(line);
                continue;
            }
        }
        match &mut block {
            Some(b) => {
                b.body.push_str(line);
                if !masked {
                    if let Some(s) = scenario_name(line) {
                        b.scenarios.push(s.to_string());
                    }
                }
            }
            None => prose.push_str(line),
        }
    }
    flush_block(&mut segments, &mut block);
    flush_prose(&mut segments, &mut prose);
    SpecDoc { segments, unclosed_fence: unclosed, has_requirements_heading }
}

// ---------------------------------------------------------------------------
// Delta model
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq)]
pub struct RenamedRequirement {
    pub from: String,
    pub to: String,
}

/// A parsed delta file (`tasks/<id>/specs/<capability>/spec.md`).
#[derive(Debug, Clone, Default)]
pub struct DeltaSpec {
    /// `## Purpose` — carried into the main spec only when the capability
    /// is new; ignored (with a fold warning) for existing capabilities.
    pub purpose: Option<String>,
    pub added: Vec<RequirementBlock>,
    pub modified: Vec<RequirementBlock>,
    /// REMOVED blocks keep their body so lint can check for `**Reason**`.
    pub removed: Vec<RequirementBlock>,
    pub renamed: Vec<RenamedRequirement>,
    pub unclosed_fence: bool,
}

#[derive(Clone, Copy, PartialEq)]
enum DeltaSection {
    Added,
    Modified,
    Removed,
    Renamed,
    Purpose,
    /// An unrecognized H2 — its content is ignored (tolerated prose).
    Outside,
}

fn delta_section(line: &str) -> Option<DeltaSection> {
    match h2_normalized(line)?.as_str() {
        "added requirements" => Some(DeltaSection::Added),
        "modified requirements" => Some(DeltaSection::Modified),
        "removed requirements" => Some(DeltaSection::Removed),
        "renamed requirements" => Some(DeltaSection::Renamed),
        "purpose" => Some(DeltaSection::Purpose),
        _ => Some(DeltaSection::Outside),
    }
}

/// Extract the requirement name from a RENAMED bullet payload: accepts
/// `` `### Requirement: Name` ``, `### Requirement: Name`, or a bare name.
fn renamed_payload_name(raw: &str) -> String {
    let t = raw.trim().trim_matches('`').trim();
    t.strip_prefix("### Requirement:").map(str::trim).unwrap_or(t).to_string()
}

/// Parse a delta file. Structural problems (the grammar fold depends on)
/// are hard errors; style issues live in [`lint_delta`] instead.
pub fn parse_delta(content: &str) -> std::result::Result<DeltaSpec, Vec<String>> {
    let (lines, unclosed) = masked_lines(content);
    let mut delta = DeltaSpec { unclosed_fence: unclosed, ..DeltaSpec::default() };
    let mut errors: Vec<String> = Vec::new();
    let mut section: Option<DeltaSection> = None;
    let mut saw_op_section = false;
    let mut block: Option<RequirementBlock> = None;
    let mut purpose = String::new();
    let mut pending_from: Option<String> = None;

    fn flush(
        block: &mut Option<RequirementBlock>,
        section: Option<DeltaSection>,
        delta: &mut DeltaSpec,
    ) {
        if let Some(b) = block.take() {
            match section {
                Some(DeltaSection::Added) => delta.added.push(b),
                Some(DeltaSection::Modified) => delta.modified.push(b),
                Some(DeltaSection::Removed) => delta.removed.push(b),
                _ => {} // blocks outside op sections are tolerated prose
            }
        }
    }

    for (line, masked) in lines {
        if !masked {
            if let Some(next) = delta_section(line) {
                flush(&mut block, section, &mut delta);
                if pending_from.is_some() {
                    errors.push("RENAMED: FROM entry without a matching TO".into());
                    pending_from = None;
                }
                section = Some(next);
                if matches!(
                    next,
                    DeltaSection::Added
                        | DeltaSection::Modified
                        | DeltaSection::Removed
                        | DeltaSection::Renamed
                ) {
                    saw_op_section = true;
                }
                continue;
            }
            match section {
                Some(DeltaSection::Added) | Some(DeltaSection::Modified) | Some(DeltaSection::Removed) => {
                    if let Some(name) = requirement_name(line) {
                        flush(&mut block, section, &mut delta);
                        if name.is_empty() {
                            errors.push("requirement heading with empty name".into());
                        }
                        block = Some(RequirementBlock {
                            name: name.to_string(),
                            body: line.to_string(),
                            scenarios: Vec::new(),
                        });
                        continue;
                    }
                    // OpenSpec also accepts REMOVED as a bullet list:
                    // ``- `### Requirement: X` ``. Only lines naming a
                    // requirement heading count — a block's own bullets
                    // (`- **Reason**: …`) don't contain that marker.
                    if section == Some(DeltaSection::Removed) {
                        let s = stripped(line).trim_start();
                        if let Some(rest) = s.strip_prefix("- ") {
                            if rest.contains("### Requirement:") {
                                flush(&mut block, section, &mut delta);
                                delta.removed.push(RequirementBlock {
                                    name: renamed_payload_name(rest),
                                    body: line.to_string(),
                                    scenarios: Vec::new(),
                                });
                                continue;
                            }
                        }
                    }
                }
                Some(DeltaSection::Renamed) => {
                    let s = stripped(line).trim_start();
                    if let Some(rest) = s.strip_prefix("- FROM:") {
                        if pending_from.is_some() {
                            errors.push("RENAMED: FROM entry without a matching TO".into());
                        }
                        pending_from = Some(renamed_payload_name(rest));
                        continue;
                    }
                    if let Some(rest) = s.strip_prefix("- TO:") {
                        match pending_from.take() {
                            Some(from) => delta
                                .renamed
                                .push(RenamedRequirement { from, to: renamed_payload_name(rest) }),
                            None => errors.push("RENAMED: TO entry without a preceding FROM".into()),
                        }
                        continue;
                    }
                }
                _ => {}
            }
        }
        match &mut block {
            Some(b) => {
                b.body.push_str(line);
                if !masked {
                    if let Some(s) = scenario_name(line) {
                        b.scenarios.push(s.to_string());
                    }
                }
            }
            None => {
                if section == Some(DeltaSection::Purpose) {
                    purpose.push_str(line);
                }
            }
        }
    }
    flush(&mut block, section, &mut delta);
    if pending_from.is_some() {
        errors.push("RENAMED: FROM entry without a matching TO".into());
    }
    let purpose = purpose.trim();
    if !purpose.is_empty() {
        delta.purpose = Some(purpose.to_string());
    }

    if !saw_op_section {
        errors.push(
            "no delta sections found (expected ## ADDED / MODIFIED / REMOVED / RENAMED Requirements)"
                .into(),
        );
    }
    for (label, blocks) in
        [("ADDED", &delta.added), ("MODIFIED", &delta.modified), ("REMOVED", &delta.removed)]
    {
        let mut seen = std::collections::BTreeSet::new();
        for b in blocks {
            if !seen.insert(b.name.clone()) {
                errors.push(format!("duplicate requirement '{}' in {label} section", b.name));
            }
        }
    }
    for (label, empty, op) in [
        ("ADDED", delta.added.is_empty(), DeltaSection::Added),
        ("MODIFIED", delta.modified.is_empty(), DeltaSection::Modified),
        ("REMOVED", delta.removed.is_empty(), DeltaSection::Removed),
        ("RENAMED", delta.renamed.is_empty(), DeltaSection::Renamed),
    ] {
        // An op heading with nothing under it is authoring gone wrong, not
        // an empty intent — surface it before it silently folds to nothing.
        if empty && section_present(content, op) {
            errors.push(format!("{label} section is empty"));
        }
    }

    if errors.is_empty() { Ok(delta) } else { Err(errors) }
}

/// Single source with `delta_section` — a heading either counts for both
/// section routing and the empty-section guard, or for neither (batch ①
/// review: two hand-rolled matchers drifted into "one recognizes, one
/// doesn't" territory by construction).
fn section_present(content: &str, op: DeltaSection) -> bool {
    let (lines, _) = masked_lines(content);
    lines.iter().any(|(l, masked)| !masked && delta_section(l) == Some(op))
}

// ---------------------------------------------------------------------------
// Fold (merge)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Default)]
pub struct FoldOutcome {
    pub content: String,
    pub added: usize,
    pub modified: usize,
    pub removed: usize,
    pub renamed: usize,
    /// Early-synced operations that were skipped (the main spec already
    /// contained the edit — e.g. a human applied it by hand).
    pub noops: Vec<String>,
    pub warnings: Vec<String>,
}

/// Case/whitespace-folded name, used **only** to catch near-miss typos —
/// identity itself stays exact (OpenSpec parity).
fn fold_name(name: &str) -> String {
    name.split_whitespace().collect::<Vec<_>>().join(" ").to_lowercase()
}

/// Body comparison for the ADDED-already-exists no-op: line endings and
/// trailing whitespace are presentation, not content.
fn normalized_body(body: &str) -> String {
    let mut lines: Vec<&str> = body.lines().map(str::trim_end).collect();
    while lines.last().is_some_and(|l| l.is_empty()) {
        lines.pop();
    }
    lines.join("\n")
}

/// Multiplicity-aware scenario preservation: every scenario name of the old
/// block must appear in the new block at least as many times (OpenSpec's
/// guard against partial rewrites losing detail at fold time).
fn missing_scenarios<'a>(old: &'a RequirementBlock, new: &RequirementBlock) -> Vec<&'a str> {
    let mut have: std::collections::BTreeMap<&str, usize> = Default::default();
    for s in &new.scenarios {
        *have.entry(s.as_str()).or_default() += 1;
    }
    let mut missing = Vec::new();
    for s in &old.scenarios {
        match have.get_mut(s.as_str()) {
            Some(n) if *n > 0 => *n -= 1,
            _ => missing.push(s.as_str()),
        }
    }
    missing
}

/// Block text normalized for insertion: exactly one trailing blank line.
fn insertable(body: &str) -> String {
    format!("{}\n\n", body.trim_end())
}

fn segment_text_mut(seg: &mut Segment) -> &mut String {
    match seg {
        Segment::Prose(t) => t,
        Segment::Requirement(b) => &mut b.body,
    }
}

/// "…\n\n" (CRLF-aware): the text ends with a completed blank line.
fn ends_with_blank_line(s: &str) -> bool {
    let Some(t) = s.strip_suffix('\n') else { return false };
    let t = t.strip_suffix('\r').unwrap_or(t);
    t.ends_with('\n')
}

/// Ensure `s` terminates its last line and follows it with a blank one, so
/// a block appended after it starts on a fresh line with standard spacing.
fn bridge_blank(s: &mut String) {
    if !s.ends_with('\n') {
        s.push('\n');
    }
    if !ends_with_blank_line(s) {
        s.push('\n');
    }
}

const PURPOSE_TBD: &str = "TBD — fill in after the first fold.";

/// Skeleton for a brand-new capability file (current spec absent).
fn new_capability_content(capability: &str, delta: &DeltaSpec) -> String {
    let purpose = delta.purpose.as_deref().unwrap_or(PURPOSE_TBD);
    let mut out = format!("# {capability} Specification\n\n## Purpose\n{purpose}\n\n## Requirements\n\n");
    for b in &delta.added {
        out.push_str(&insertable(&b.body));
    }
    format!("{}\n", out.trim_end())
}

/// Apply one parsed delta to one capability's current spec (None = the
/// capability does not exist yet). Pure: returns the new file content or
/// the full conflict list — callers write nothing unless every fold in the
/// batch succeeds (nextup_docs/15 §4.2).
pub fn fold(
    capability: &str,
    current: Option<&str>,
    delta: &DeltaSpec,
) -> std::result::Result<FoldOutcome, Vec<String>> {
    let mut conflicts: Vec<String> = Vec::new();
    let mut outcome = FoldOutcome::default();

    // Cross-section sanity: one requirement, one intent per delta.
    let names = |blocks: &[RequirementBlock]| -> Vec<String> {
        blocks.iter().map(|b| b.name.clone()).collect()
    };
    let added_n = names(&delta.added);
    let modified_n = names(&delta.modified);
    let removed_n = names(&delta.removed);
    for n in &added_n {
        if modified_n.contains(n) {
            conflicts.push(format!("'{n}' appears in both ADDED and MODIFIED"));
        }
        if removed_n.contains(n) {
            conflicts.push(format!("'{n}' appears in both ADDED and REMOVED"));
        }
    }
    for n in &modified_n {
        if removed_n.contains(n) {
            conflicts.push(format!("'{n}' appears in both MODIFIED and REMOVED"));
        }
    }
    for r in &delta.renamed {
        if removed_n.iter().any(|n| fold_name(n) == fold_name(&r.from)) {
            conflicts.push(format!("RENAMED source '{}' also appears in REMOVED", r.from));
        }
        if modified_n.contains(&r.from) {
            conflicts.push(format!(
                "'{}' is RENAMED to '{}' but MODIFIED under the old name — modify under the new name",
                r.from, r.to
            ));
        }
        if added_n.contains(&r.to) {
            conflicts.push(format!("RENAMED target '{}' also appears in ADDED", r.to));
        }
    }

    let Some(current) = current else {
        if !delta.modified.is_empty() || !delta.removed.is_empty() || !delta.renamed.is_empty() {
            conflicts.push(format!(
                "capability '{capability}' does not exist yet — its delta may only contain ADDED"
            ));
        }
        if delta.added.is_empty() {
            conflicts.push(format!("capability '{capability}' delta adds nothing"));
        }
        if !conflicts.is_empty() {
            return Err(conflicts);
        }
        outcome.content = new_capability_content(capability, delta);
        outcome.added = delta.added.len();
        if delta.unclosed_fence {
            outcome.warnings.push("delta has an unclosed code fence".into());
        }
        return Ok(outcome);
    };

    let mut doc = parse_spec(current);
    if doc.unclosed_fence {
        // Masked-to-EOF requirements would make REMOVED/MODIFIED report
        // lying no-ops — refuse to fold over a structurally broken truth
        // file instead of warning past it (batch ① review).
        conflicts.push("main spec has an unclosed code fence — repair it before folding".into());
    }
    if delta.unclosed_fence {
        outcome.warnings.push("delta has an unclosed code fence".into());
    }
    let mut mutated = false;

    // A capability whose first fold carried no Purpose is left holding the
    // placeholder, and every later delta used to be told "ignored — the
    // capability already exists". Since MODIFIED only reaches requirements and
    // an agent has no business editing the main spec by hand, the workspace's
    // own source of truth opened on `TBD` forever. Filling the placeholder is
    // not the same authority as rewriting a Purpose someone actually wrote:
    // the match is against the exact engine-written string, so a real Purpose
    // is still untouchable.
    if let Some(purpose) = delta.purpose.as_deref() {
        let placeholder = doc.segments.iter_mut().find(
            |s| matches!(s, Segment::Prose(p) if p.contains(PURPOSE_TBD)),
        );
        match placeholder {
            Some(Segment::Prose(prose)) => {
                *prose = prose.replace(PURPOSE_TBD, purpose);
                mutated = true;
            }
            _ => outcome
                .warnings
                .push("delta Purpose ignored — the capability already exists".into()),
        }
    }

    let find = |doc: &SpecDoc, name: &str| -> Option<usize> {
        doc.segments.iter().position(
            |s| matches!(s, Segment::Requirement(b) if b.name == name),
        )
    };
    let find_near = |doc: &SpecDoc, name: &str| -> Option<String> {
        let folded = fold_name(name);
        doc.requirements()
            .find(|b| b.name != name && fold_name(&b.name) == folded)
            .map(|b| b.name.clone())
    };

    // 1. RENAMED
    for r in &delta.renamed {
        if r.from == r.to {
            outcome.noops.push(format!("RENAMED '{}' → itself: nothing to do", r.from));
            continue;
        }
        match find(&doc, &r.from) {
            Some(i) => {
                if find(&doc, &r.to).is_some() {
                    conflicts.push(format!(
                        "cannot rename '{}' to '{}': that requirement already exists",
                        r.from, r.to
                    ));
                    continue;
                }
                if let Segment::Requirement(b) = &mut doc.segments[i] {
                    let heading_len = b.body.find('\n').map(|i| i + 1).unwrap_or(b.body.len());
                    let ending = if b.body[..heading_len].ends_with("\r\n") {
                        "\r\n"
                    } else if b.body[..heading_len].ends_with('\n') {
                        "\n"
                    } else {
                        ""
                    };
                    b.body = format!(
                        "### Requirement: {}{}{}",
                        r.to,
                        ending,
                        &b.body[heading_len..]
                    );
                    b.name = r.to.clone();
                    outcome.renamed += 1;
                    mutated = true;
                }
            }
            None => {
                if find(&doc, &r.to).is_some() {
                    outcome.noops.push(format!("RENAMED '{}' → '{}': already renamed", r.from, r.to));
                } else if let Some(near) = find_near(&doc, &r.from) {
                    conflicts.push(format!(
                        "RENAMED source '{}' not found; '{near}' differs only in case/whitespace — fix the typo",
                        r.from
                    ));
                } else {
                    conflicts.push(format!(
                        "RENAMED source '{}' not found and target '{}' absent",
                        r.from, r.to
                    ));
                }
            }
        }
    }

    // 2. REMOVED
    for b in &delta.removed {
        match find(&doc, &b.name) {
            Some(i) => {
                doc.segments.remove(i);
                outcome.removed += 1;
                mutated = true;
            }
            None => {
                if let Some(near) = find_near(&doc, &b.name) {
                    conflicts.push(format!(
                        "REMOVED '{}' not found; '{near}' differs only in case/whitespace — fix the typo",
                        b.name
                    ));
                } else {
                    outcome.noops.push(format!("REMOVED '{}': already gone", b.name));
                }
            }
        }
    }

    // 3. MODIFIED (matched after renames — the documented pattern for
    //    rename-and-edit is MODIFIED under the *new* name).
    for b in &delta.modified {
        match find(&doc, &b.name) {
            Some(i) => {
                if let Segment::Requirement(old) = &doc.segments[i] {
                    for s in missing_scenarios(old, b) {
                        conflicts.push(format!(
                            "MODIFIED '{}' loses existing scenario '{s}' — MODIFIED is a full rewrite, keep every scenario",
                            b.name
                        ));
                    }
                }
                if conflicts.is_empty() {
                    let is_last = i + 1 == doc.segments.len();
                    if let Segment::Requirement(old) = &mut doc.segments[i] {
                        old.body = if is_last {
                            format!("{}\n", b.body.trim_end())
                        } else {
                            insertable(&b.body)
                        };
                        old.scenarios = b.scenarios.clone();
                        outcome.modified += 1;
                        mutated = true;
                    }
                }
            }
            None => {
                if let Some(near) = find_near(&doc, &b.name) {
                    conflicts.push(format!(
                        "MODIFIED '{}' not found; '{near}' differs only in case/whitespace — fix the typo",
                        b.name
                    ));
                } else {
                    conflicts.push(format!("MODIFIED target not found: '{}'", b.name));
                }
            }
        }
    }

    // 4. ADDED — appended after the last requirement, original order kept.
    for b in &delta.added {
        match find(&doc, &b.name) {
            Some(i) => {
                if let Segment::Requirement(old) = &doc.segments[i] {
                    if normalized_body(&old.body) == normalized_body(&b.body) {
                        outcome.noops.push(format!("ADDED '{}': already present", b.name));
                    } else {
                        conflicts.push(format!(
                            "ADDED '{}' already exists with different content",
                            b.name
                        ));
                    }
                }
            }
            None => {
                if let Some(near) = find_near(&doc, &b.name) {
                    conflicts.push(format!(
                        "ADDED '{}' near-misses existing '{near}' (case/whitespace only) — fix the typo",
                        b.name
                    ));
                    continue;
                }
                // First requirement of a requirement-less document: give it
                // a Requirements section instead of growing under whatever
                // heading happens to be last (batch ① review: the old
                // `at == 0` guard was dead code for any non-empty file).
                let has_req = doc.segments.iter().any(|s| matches!(s, Segment::Requirement(_)));
                if !has_req && !doc.has_requirements_heading {
                    if let Some(last) = doc.segments.last_mut() {
                        bridge_blank(segment_text_mut(last));
                    }
                    doc.segments.push(Segment::Prose("## Requirements\n\n".into()));
                    doc.has_requirements_heading = true;
                }
                let at = doc
                    .segments
                    .iter()
                    .rposition(|s| matches!(s, Segment::Requirement(_)))
                    .map(|i| i + 1)
                    .unwrap_or(doc.segments.len());
                // Bridge: the preceding text must end in a blank line, or a
                // file without a trailing newline glues the new heading onto
                // its last line — the re-parse then loses a block and every
                // re-fold duplicates content (batch ① review).
                if at > 0 {
                    bridge_blank(segment_text_mut(&mut doc.segments[at - 1]));
                }
                doc.segments.insert(
                    at,
                    Segment::Requirement(RequirementBlock {
                        name: b.name.clone(),
                        body: insertable(&b.body),
                        scenarios: b.scenarios.clone(),
                    }),
                );
                outcome.added += 1;
                mutated = true;
            }
        }
    }

    // Final duplicate check: identity must stay unique after every op.
    let mut seen = std::collections::BTreeSet::new();
    for b in doc.requirements() {
        if !seen.insert(b.name.clone()) {
            conflicts.push(format!("duplicate requirement name after fold: '{}'", b.name));
        }
    }

    if !conflicts.is_empty() {
        return Err(conflicts);
    }
    outcome.content = if mutated {
        // Structural edits may disturb end-of-file spacing; untouched
        // documents (all-no-op folds) must stay byte-identical instead.
        format!("{}\n", doc.render().trim_end())
    } else {
        doc.render()
    };
    Ok(outcome)
}

/// One capability's fold job inside a batch. Internal: every caller builds a
/// whole task bundle's worth at once, which is what [`plan_task_fold`] does.
struct FoldInput<'a> {
    capability: &'a str,
    /// Current main-spec content, None when the capability is new.
    current: Option<&'a str>,
    /// Raw delta file content.
    delta: &'a str,
}

/// What a planned fold would do: every capability's outcome, or every problem
/// (prepare-all, so it is one or the other — never a half-applied batch).
pub type FoldPlan = std::result::Result<Vec<(String, FoldOutcome)>, Vec<String>>;

/// Prepare-all: parse and fold every capability, return every outcome or
/// every problem (capability-prefixed). Nothing is written here — batch ②
/// writes only when the whole batch validates (D71B precedent).
fn fold_batch(items: &[FoldInput<'_>]) -> FoldPlan {
    let mut outcomes = Vec::new();
    let mut problems = Vec::new();
    for item in items {
        if let Err(e) = validate_capability_name(item.capability) {
            problems.push(format!("[{}] {e}", item.capability));
            continue;
        }
        match parse_delta(item.delta) {
            Err(errs) => {
                problems.extend(errs.into_iter().map(|e| format!("[{}] {e}", item.capability)))
            }
            Ok(delta) => match fold(item.capability, item.current, &delta) {
                Ok(mut outcome) => {
                    outcome.warnings.extend(lint_delta(&delta));
                    outcomes.push((item.capability.to_string(), outcome));
                }
                Err(errs) => {
                    problems.extend(errs.into_iter().map(|e| format!("[{}] {e}", item.capability)))
                }
            },
        }
    }
    if problems.is_empty() { Ok(outcomes) } else { Err(problems) }
}

// ---------------------------------------------------------------------------
// Lint (style warnings — never block a fold)
// ---------------------------------------------------------------------------

/// Style checks, deliberately softer than OpenSpec's validator: SHALL/MUST
/// wording and scenario presence are conventions worth nudging, but this is
/// a localized product — Chinese workspaces write 必須 (nextup_docs/15 §2).
pub fn lint_delta(delta: &DeltaSpec) -> Vec<String> {
    let mut warnings = Vec::new();
    for b in delta.added.iter().chain(delta.modified.iter()) {
        if b.scenarios.is_empty() {
            warnings.push(format!("'{}' has no #### Scenario: block", b.name));
        }
        if !["SHALL", "MUST", "必須"].iter().any(|w| b.body.contains(w)) {
            warnings.push(format!(
                "'{}' statement has no SHALL / MUST / 必須 wording",
                b.name
            ));
        }
        if b.name.chars().count() > 50 {
            warnings.push(format!("'{}' name is over 50 chars", b.name));
        }
        // The classic silent failure: a scenario heading with the wrong
        // hash count parses as plain text and simply vanishes.
        for line in b.body.lines() {
            let t = line.trim_start_matches('#');
            let hashes = line.len() - t.len();
            if t.trim_start().starts_with("Scenario:") && hashes != 4 && hashes > 0 {
                warnings.push(format!(
                    "'{}' has a Scenario heading with {hashes} #'s — must be exactly 4",
                    b.name
                ));
            }
        }
    }
    for b in &delta.removed {
        if !b.body.contains("**Reason**") {
            warnings.push(format!("REMOVED '{}' has no **Reason**: line", b.name));
        }
    }
    warnings
}

// ---------------------------------------------------------------------------
// Disk discovery (read-only)
// ---------------------------------------------------------------------------
// Shared by every consumer (archive fold, doctor, sync's STATE line, the
// hub read tools) so capability discovery can never drift between them.

/// One task delta bundle entry: `tasks/<id>/specs/<capability>/spec.md`.
#[derive(Debug, Clone)]
pub struct DeltaFile {
    pub capability: String,
    pub content: String,
}

/// Capability names under `specs/` (directories holding a spec.md), sorted.
pub fn list_capabilities(paths: &WorkspacePaths) -> Result<Vec<String>> {
    capability_dirs(&paths.specs_dir())
}

/// A task's delta specs, sorted by capability. No bundle dir = empty.
pub fn read_task_deltas(paths: &WorkspacePaths, task_id: &str) -> Result<Vec<DeltaFile>> {
    let dir = paths.task_delta_specs_dir(task_id);
    let mut out = Vec::new();
    for capability in capability_dirs(&dir)? {
        let file = dir.join(&capability).join(SPEC_FILE);
        out.push(DeltaFile { capability, content: read_text(&file)? });
    }
    Ok(out)
}

/// Current main-spec content for one capability, `None` when absent.
/// Validates the name here — this is the one choke point every external
/// capability string (hub `get_spec`, IPC `spec_content`) flows through, and
/// the slug rule is what keeps `../`-style traversal out of the path join
/// (D79 batch 4 review, W2).
pub fn read_current_spec(paths: &WorkspacePaths, capability: &str) -> Result<Option<String>> {
    validate_capability_name(capability)?;
    let file = paths.spec_file(capability);
    if !file.is_file() {
        return Ok(None);
    }
    read_text(&file).map(Some)
}

/// Strict UTF-8 — a fold rewrites the file, and a lossy read would silently
/// alter bytes it never meant to touch.
fn read_text(file: &Path) -> Result<String> {
    let bytes = crate::workspace::atomic::read_file(file)?;
    String::from_utf8(bytes)
        .map_err(|_| NextUpError::InvalidInput(format!("{} is not valid UTF-8", file.display())))
}

/// One capability row for the hub `list_specs` tool (batch ③).
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpecOverview {
    pub capability: String,
    pub requirements: usize,
    /// Why this row could not be read (non-UTF-8 etc.) — the row still lists
    /// so one broken file never hides the rest of the rail (D79 batch 4 review, W3,
    /// same containment rule as doctor's per-file spec_parse).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub problem: Option<String>,
}

/// Overview of the whole spec layer, sorted by capability.
pub fn specs_overview(paths: &WorkspacePaths) -> Result<Vec<SpecOverview>> {
    let mut out = Vec::new();
    for capability in list_capabilities(paths)? {
        let (requirements, problem) = match read_current_spec(paths, &capability) {
            Ok(Some(content)) => (parse_spec(&content).requirements().count(), None),
            Ok(None) => (0, None),
            Err(e) => (0, Some(e.to_string())),
        };
        out.push(SpecOverview { capability, requirements, problem });
    }
    Ok(out)
}

/// Dry-run fold report for one task's delta bundle — the agent's self-check
/// before marking done: a problem listed here is the same one that will
/// refuse the archive later.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskSpecsReport {
    pub task_id: String,
    pub capabilities: Vec<String>,
    /// True when every capability folds cleanly against today's specs.
    pub ok: bool,
    /// Fold-blocking problems (conflicts, delta parse errors), prefixed by
    /// capability.
    pub problems: Vec<String>,
    /// Style lint and fold warnings — never blocking.
    pub warnings: Vec<String>,
    /// Early-synced edits the fold would skip (already applied by hand) —
    /// informational, neither a problem nor a style warning.
    pub already_synced: Vec<String>,
    pub added: usize,
    pub modified: usize,
    pub removed: usize,
    pub renamed: usize,
}

/// Pair a task's delta bundle with today's main specs and fold-plan the whole
/// batch. The three callers — the archive fold (ops), the dry-run report and
/// the doctor — differ in what they do with the answer, never in how the plan
/// is built, so the pairing lives here: capability by capability, each delta
/// against *its own* current spec (a crossed pair would fold a MODIFIED
/// requirement into a document that never declared it).
///
/// The outer `Result` is "could we read today's specs at all"; the inner one
/// is "does this bundle fold" — the doctor reports those two as different
/// findings.
pub fn plan_task_fold(paths: &WorkspacePaths, deltas: &[DeltaFile]) -> Result<FoldPlan> {
    let currents = deltas
        .iter()
        .map(|d| read_current_spec(paths, &d.capability))
        .collect::<Result<Vec<_>>>()?;
    let items: Vec<FoldInput<'_>> = deltas
        .iter()
        .zip(currents.iter())
        .map(|(d, c)| FoldInput {
            capability: &d.capability,
            current: c.as_deref(),
            delta: &d.content,
        })
        .collect();
    Ok(fold_batch(&items))
}

/// Pure read: nothing is written, no marker is consulted — the report says
/// what a fold would do *right now*.
pub fn dry_run_task_specs(paths: &WorkspacePaths, task_id: &str) -> Result<TaskSpecsReport> {
    let deltas = read_task_deltas(paths, task_id)?;
    let mut report = TaskSpecsReport {
        task_id: task_id.to_string(),
        capabilities: deltas.iter().map(|d| d.capability.clone()).collect(),
        ok: true,
        problems: Vec::new(),
        warnings: Vec::new(),
        already_synced: Vec::new(),
        added: 0,
        modified: 0,
        removed: 0,
        renamed: 0,
    };
    if deltas.is_empty() {
        return Ok(report);
    }
    match plan_task_fold(paths, &deltas)? {
        Ok(outcomes) => {
            for (_capability, out) in &outcomes {
                report.added += out.added;
                report.modified += out.modified;
                report.removed += out.removed;
                report.renamed += out.renamed;
                report.already_synced.extend(out.noops.iter().cloned());
                report.warnings.extend(out.warnings.iter().cloned());
            }
        }
        Err(problems) => {
            report.ok = false;
            report.problems = problems;
        }
    }
    Ok(report)
}

fn capability_dirs(dir: &Path) -> Result<Vec<String>> {
    if !dir.is_dir() {
        return Ok(Vec::new());
    }
    let mut out = Vec::new();
    for entry in std::fs::read_dir(dir)? {
        let path = entry?.path();
        if path.is_dir() && path.join(SPEC_FILE).is_file() {
            if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                out.push(name.to_string());
            }
        }
    }
    out.sort();
    Ok(out)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    const SPEC: &str = "# demo Specification\n\n## Purpose\nWhat this does today.\n\n## Requirements\n\n### Requirement: 匯出格式\n系統必須支援 Markdown 與 JSON。\n\n#### Scenario: 使用者選 JSON\n- **WHEN** 選 JSON\n- **THEN** 產出 UTF-8 JSON\n\n### Requirement: Session timeout\nThe system SHALL expire sessions after 30 minutes.\n\n#### Scenario: Idle session\n- **WHEN** idle 30 min\n- **THEN** logged out\n\n## Why These Decisions\nTrailing prose stays put.\n";

    fn delta(body: &str) -> DeltaSpec {
        parse_delta(body).expect("delta parses")
    }

    /// D79 batch 4 review, W3: one unreadable spec.md must degrade to a per-row problem,
    /// never take down the whole overview (rail) — same containment rule the
    /// doctor's spec checks follow.
    #[test]
    fn specs_overview_contains_broken_file_per_row() {
        let dir = tempfile::tempdir().unwrap();
        let paths = WorkspacePaths::new(dir.path());
        std::fs::create_dir_all(paths.specs_dir().join("alpha")).unwrap();
        std::fs::write(paths.spec_file("alpha"), SPEC).unwrap();
        std::fs::create_dir_all(paths.specs_dir().join("broken")).unwrap();
        std::fs::write(paths.spec_file("broken"), [0xffu8, 0xfe, 0x00]).unwrap();

        let rows = specs_overview(&paths).unwrap();
        assert_eq!(rows.len(), 2, "broken row must still list");
        assert_eq!(rows[0].capability, "alpha");
        assert_eq!(rows[0].requirements, 2);
        assert!(rows[0].problem.is_none());
        assert_eq!(rows[1].capability, "broken");
        assert_eq!(rows[1].requirements, 0);
        assert!(rows[1].problem.as_deref().unwrap_or_default().contains("UTF-8"));
    }

    /// D79 batch 4 review, W2: the read choke point must reject traversal-shaped names
    /// before any path join — hub `get_spec` and IPC `spec_content` hand the
    /// raw string straight here.
    #[test]
    fn read_current_spec_rejects_traversal_names() {
        let dir = tempfile::tempdir().unwrap();
        let paths = WorkspacePaths::new(dir.path());
        for bad in ["../escape", "..", "a/b", "a\\b", "UPPER", ""] {
            let err = read_current_spec(&paths, bad).unwrap_err();
            assert_eq!(err.kind(), "invalid_input", "{bad:?} must be rejected");
        }
    }

    // ---- parse_spec ----

    #[test]
    fn parse_finds_blocks_scenarios_and_keeps_prose() {
        let doc = parse_spec(SPEC);
        let names: Vec<_> = doc.requirements().map(|b| b.name.clone()).collect();
        assert_eq!(names, vec!["匯出格式", "Session timeout"]);
        assert_eq!(doc.requirements().next().unwrap().scenarios, vec!["使用者選 JSON"]);
        assert!(!doc.unclosed_fence);
    }

    #[test]
    fn parse_render_roundtrip_is_lossless() {
        // Fold's no-op path returns the untouched render — it must be
        // byte-identical or every no-op fold would dirty the file.
        assert_eq!(parse_spec(SPEC).render(), SPEC);
        let crlf = SPEC.replace('\n', "\r\n");
        assert_eq!(parse_spec(&crlf).render(), crlf);
    }

    #[test]
    fn headings_inside_code_fences_are_masked() {
        let s = "# X\n\n```md\n### Requirement: Fake\n## ADDED Requirements\n```\n\n### Requirement: Real\nBody. SHALL.\n";
        let doc = parse_spec(s);
        let names: Vec<_> = doc.requirements().map(|b| b.name.clone()).collect();
        assert_eq!(names, vec!["Real"], "fenced headings are literal text");
    }

    #[test]
    fn unclosed_fence_masks_to_eof_and_is_flagged() {
        let s = "# X\n\n```\n### Requirement: Swallowed\n";
        let doc = parse_spec(s);
        assert_eq!(doc.requirements().count(), 0);
        assert!(doc.unclosed_fence);
    }

    // ---- parse_delta ----

    #[test]
    fn delta_parses_all_four_sections() {
        let d = delta(
            "## ADDED Requirements\n\n### Requirement: New one\nMUST do.\n\n#### Scenario: s\n- **WHEN** x\n\n## MODIFIED Requirements\n\n### Requirement: Session timeout\nThe system SHALL expire sessions after 15 minutes.\n\n#### Scenario: Idle session\n- **WHEN** idle 15 min\n\n## REMOVED Requirements\n\n### Requirement: Old junk\n**Reason**: obsolete\n**Migration**: none\n\n## RENAMED Requirements\n- FROM: `### Requirement: 匯出格式`\n- TO: `### Requirement: 匯出能力`\n",
        );
        assert_eq!(d.added.len(), 1);
        assert_eq!(d.modified.len(), 1);
        assert_eq!(d.removed.len(), 1);
        assert_eq!(
            d.renamed,
            vec![RenamedRequirement { from: "匯出格式".into(), to: "匯出能力".into() }]
        );
    }

    #[test]
    fn delta_renamed_accepts_bare_names_too() {
        let d = delta("## RENAMED Requirements\n- FROM: Old Name\n- TO: New Name\n");
        assert_eq!(d.renamed[0].from, "Old Name");
        assert_eq!(d.renamed[0].to, "New Name");
    }

    #[test]
    fn delta_purpose_is_captured() {
        let d = delta("## Purpose\n新能力域的用途。\n\n## ADDED Requirements\n\n### Requirement: A\n必須。\n\n#### Scenario: s\n- **WHEN** x\n");
        assert_eq!(d.purpose.as_deref(), Some("新能力域的用途。"));
    }

    #[test]
    fn delta_without_op_sections_is_an_error() {
        let errs = parse_delta("### Requirement: Looks like a main spec\nBody.\n").unwrap_err();
        assert!(errs.iter().any(|e| e.contains("no delta sections")), "{errs:?}");
    }

    #[test]
    fn delta_empty_op_section_is_an_error() {
        let errs = parse_delta("## ADDED Requirements\n\nprose only\n").unwrap_err();
        assert!(errs.iter().any(|e| e.contains("ADDED section is empty")), "{errs:?}");
    }

    #[test]
    fn delta_duplicate_name_in_section_is_an_error() {
        let errs = parse_delta(
            "## ADDED Requirements\n\n### Requirement: A\nx\n\n### Requirement: A\ny\n",
        )
        .unwrap_err();
        assert!(errs.iter().any(|e| e.contains("duplicate requirement 'A'")), "{errs:?}");
    }

    #[test]
    fn delta_unpaired_renamed_entries_are_errors() {
        let errs =
            parse_delta("## RENAMED Requirements\n- FROM: `### Requirement: A`\n").unwrap_err();
        assert!(errs.iter().any(|e| e.contains("FROM entry without a matching TO")), "{errs:?}");
        let errs = parse_delta("## RENAMED Requirements\n- TO: `### Requirement: B`\n").unwrap_err();
        assert!(errs.iter().any(|e| e.contains("TO entry without a preceding FROM")), "{errs:?}");
    }

    #[test]
    fn delta_op_heading_inside_fence_is_ignored() {
        let errs = parse_delta("```\n## ADDED Requirements\n```\nprose\n").unwrap_err();
        assert!(errs.iter().any(|e| e.contains("no delta sections")), "{errs:?}");
    }

    // ---- fold: success paths ----

    #[test]
    fn fold_added_appends_after_last_requirement() {
        let d = delta("## ADDED Requirements\n\n### Requirement: Rate limit\nThe system MUST rate-limit.\n\n#### Scenario: burst\n- **WHEN** burst\n- **THEN** 429\n");
        let out = fold("demo", Some(SPEC), &d).unwrap();
        assert_eq!((out.added, out.modified, out.removed, out.renamed), (1, 0, 0, 0));
        let doc = parse_spec(&out.content);
        let names: Vec<_> = doc.requirements().map(|b| b.name.clone()).collect();
        assert_eq!(names, vec!["匯出格式", "Session timeout", "Rate limit"], "order kept, new at tail");
        assert!(out.content.contains("## Why These Decisions"), "trailing prose survives");
        let why = out.content.find("## Why These Decisions").unwrap();
        assert!(out.content.find("Rate limit").unwrap() < why, "appended before trailing section");
    }

    #[test]
    fn fold_modified_replaces_in_place() {
        let d = delta("## MODIFIED Requirements\n\n### Requirement: Session timeout\nThe system SHALL expire sessions after 15 minutes.\n\n#### Scenario: Idle session\n- **WHEN** idle 15 min\n- **THEN** logged out\n");
        let out = fold("demo", Some(SPEC), &d).unwrap();
        assert_eq!(out.modified, 1);
        assert!(out.content.contains("15 minutes"));
        assert!(!out.content.contains("30 minutes"));
        let names: Vec<_> =
            parse_spec(&out.content).requirements().map(|b| b.name.clone()).collect();
        assert_eq!(names, vec!["匯出格式", "Session timeout"], "position unchanged");
    }

    #[test]
    fn fold_removed_removes() {
        let d = delta("## REMOVED Requirements\n\n### Requirement: Session timeout\n**Reason**: moved to auth capability\n");
        let out = fold("demo", Some(SPEC), &d).unwrap();
        assert_eq!(out.removed, 1);
        assert!(!out.content.contains("Session timeout"));
        assert!(out.content.contains("匯出格式"), "other blocks intact");
    }

    #[test]
    fn fold_renamed_renames_and_keeps_content() {
        let d = delta("## RENAMED Requirements\n- FROM: `### Requirement: 匯出格式`\n- TO: `### Requirement: 匯出能力`\n");
        let out = fold("demo", Some(SPEC), &d).unwrap();
        assert_eq!(out.renamed, 1);
        assert!(out.content.contains("### Requirement: 匯出能力"));
        assert!(!out.content.contains("### Requirement: 匯出格式"));
        assert!(out.content.contains("系統必須支援 Markdown 與 JSON。"), "body preserved");
    }

    #[test]
    fn fold_rename_then_modify_under_new_name() {
        // The documented pattern: content change rides MODIFIED with the
        // *new* title, in the same delta.
        let d = delta("## MODIFIED Requirements\n\n### Requirement: 匯出能力\n系統必須支援 Markdown、JSON 與 CSV。\n\n#### Scenario: 使用者選 JSON\n- **WHEN** 選 JSON\n- **THEN** 產出 UTF-8 JSON\n\n## RENAMED Requirements\n- FROM: `### Requirement: 匯出格式`\n- TO: `### Requirement: 匯出能力`\n");
        let out = fold("demo", Some(SPEC), &d).unwrap();
        assert_eq!((out.renamed, out.modified), (1, 1));
        assert!(out.content.contains("CSV"));
    }

    #[test]
    fn fold_new_capability_builds_skeleton_with_purpose() {
        let d = delta("## Purpose\n匯出報告能力。\n\n## ADDED Requirements\n\n### Requirement: A\n必須。\n\n#### Scenario: s\n- **WHEN** x\n");
        let out = fold("export-report", None, &d).unwrap();
        assert!(out.content.starts_with("# export-report Specification\n"));
        assert!(out.content.contains("## Purpose\n匯出報告能力。"));
        assert!(out.content.contains("### Requirement: A"));
    }

    #[test]
    fn fold_new_capability_without_purpose_gets_tbd() {
        let d = delta("## ADDED Requirements\n\n### Requirement: A\n必須。\n\n#### Scenario: s\n- **WHEN** x\n");
        let out = fold("export-report", None, &d).unwrap();
        assert!(out.content.contains(PURPOSE_TBD));
    }

    #[test]
    fn fold_purpose_on_existing_capability_warns() {
        let d = delta("## Purpose\nnew purpose\n\n## ADDED Requirements\n\n### Requirement: R\nMUST.\n\n#### Scenario: s\n- **WHEN** x\n");
        let out = fold("demo", Some(SPEC), &d).unwrap();
        assert!(out.warnings.iter().any(|w| w.contains("Purpose ignored")), "{:?}", out.warnings);
        assert!(out.content.contains("What this does today."), "purpose untouched");
    }

    /// The escape hatch from a permanent `TBD`: a later delta may fill the
    /// placeholder the first fold left behind, and only that.
    #[test]
    fn fold_purpose_fills_the_placeholder_left_by_an_earlier_fold() {
        let first = delta("## ADDED Requirements\n\n### Requirement: A\n必須。\n\n#### Scenario: s\n- **WHEN** x\n");
        let skeleton = fold("export-report", None, &first).unwrap().content;
        assert!(skeleton.contains(PURPOSE_TBD), "precondition");

        let second = delta("## Purpose\n把報告匯出成 CSV。\n\n## ADDED Requirements\n\n### Requirement: B\n必須。\n\n#### Scenario: s\n- **WHEN** y\n");
        let out = fold("export-report", Some(&skeleton), &second).unwrap();
        assert!(out.content.contains("## Purpose\n把報告匯出成 CSV。"), "{}", out.content);
        assert!(!out.content.contains(PURPOSE_TBD));
        assert!(
            !out.warnings.iter().any(|w| w.contains("Purpose ignored")),
            "filling a placeholder is not an ignored write: {:?}",
            out.warnings
        );
        assert!(out.content.contains("### Requirement: A"), "existing requirements survive");

        // And it is a one-time door: the next delta cannot rewrite it.
        let third = delta("## Purpose\n改寫別人的用途。\n\n## ADDED Requirements\n\n### Requirement: C\n必須。\n\n#### Scenario: s\n- **WHEN** z\n");
        let out = fold("export-report", Some(&out.content), &third).unwrap();
        assert!(out.content.contains("把報告匯出成 CSV。"), "a real Purpose stays untouchable");
        assert!(out.warnings.iter().any(|w| w.contains("Purpose ignored")), "{:?}", out.warnings);
    }

    // ---- fold: early-sync no-ops ----

    #[test]
    fn fold_all_noop_delta_leaves_file_byte_identical() {
        let d = delta("## REMOVED Requirements\n\n### Requirement: Never existed\n**Reason**: gone\n\n## RENAMED Requirements\n- FROM: `### Requirement: 舊名`\n- TO: `### Requirement: Session timeout`\n");
        let out = fold("demo", Some(SPEC), &d).unwrap();
        assert_eq!(out.content, SPEC, "no mutation → exact original bytes");
        assert_eq!(out.noops.len(), 2, "{:?}", out.noops);
        assert_eq!((out.added, out.modified, out.removed, out.renamed), (0, 0, 0, 0));
    }

    #[test]
    fn fold_added_identical_is_noop_even_with_whitespace_drift() {
        let block = "## ADDED Requirements\n\n### Requirement: Session timeout\nThe system SHALL expire sessions after 30 minutes.  \n\n#### Scenario: Idle session\n- **WHEN** idle 30 min\n- **THEN** logged out\n";
        let out = fold("demo", Some(SPEC), &delta(block)).unwrap();
        assert!(out.noops.iter().any(|n| n.contains("already present")), "{:?}", out.noops);
        assert_eq!(out.content, SPEC);
    }

    // ---- fold: conflict matrix ----

    fn fold_err(delta_src: &str) -> Vec<String> {
        fold("demo", Some(SPEC), &delta(delta_src)).unwrap_err()
    }

    #[test]
    fn conflict_modified_target_missing() {
        let errs = fold_err("## MODIFIED Requirements\n\n### Requirement: Ghost\nMUST.\n\n#### Scenario: s\n- **WHEN** x\n");
        assert!(errs.iter().any(|e| e.contains("MODIFIED target not found: 'Ghost'")), "{errs:?}");
    }

    #[test]
    fn conflict_added_exists_with_different_content() {
        let errs = fold_err("## ADDED Requirements\n\n### Requirement: Session timeout\nSomething entirely different. MUST.\n\n#### Scenario: s\n- **WHEN** x\n");
        assert!(
            errs.iter().any(|e| e.contains("already exists with different content")),
            "{errs:?}"
        );
    }

    #[test]
    fn conflict_same_name_across_sections() {
        let errs = fold_err("## ADDED Requirements\n\n### Requirement: X\nMUST.\n\n#### Scenario: s\n- **WHEN** x\n\n## REMOVED Requirements\n\n### Requirement: X\n**Reason**: r\n");
        assert!(errs.iter().any(|e| e.contains("both ADDED and REMOVED")), "{errs:?}");
        let errs = fold_err("## MODIFIED Requirements\n\n### Requirement: Session timeout\nMUST.\n\n#### Scenario: Idle session\n- **WHEN** x\n\n## REMOVED Requirements\n\n### Requirement: Session timeout\n**Reason**: r\n");
        assert!(errs.iter().any(|e| e.contains("both MODIFIED and REMOVED")), "{errs:?}");
    }

    #[test]
    fn conflict_renamed_from_also_removed_and_modified_under_old_name() {
        let errs = fold_err("## RENAMED Requirements\n- FROM: `### Requirement: Session timeout`\n- TO: `### Requirement: Session expiry`\n\n## REMOVED Requirements\n\n### Requirement: Session Timeout\n**Reason**: r\n");
        assert!(errs.iter().any(|e| e.contains("also appears in REMOVED")), "case-folded cross-check: {errs:?}");
        let errs = fold_err("## RENAMED Requirements\n- FROM: `### Requirement: Session timeout`\n- TO: `### Requirement: Session expiry`\n\n## MODIFIED Requirements\n\n### Requirement: Session timeout\nMUST.\n\n#### Scenario: Idle session\n- **WHEN** x\n");
        assert!(errs.iter().any(|e| e.contains("modify under the new name")), "{errs:?}");
    }

    #[test]
    fn conflict_rename_target_already_exists() {
        let errs = fold_err("## RENAMED Requirements\n- FROM: `### Requirement: 匯出格式`\n- TO: `### Requirement: Session timeout`\n");
        assert!(errs.iter().any(|e| e.contains("already exists")), "{errs:?}");
    }

    #[test]
    fn conflict_renamed_source_and_target_both_absent() {
        let errs = fold_err("## RENAMED Requirements\n- FROM: `### Requirement: A`\n- TO: `### Requirement: B`\n");
        assert!(errs.iter().any(|e| e.contains("source 'A' not found and target 'B' absent")), "{errs:?}");
    }

    #[test]
    fn conflict_near_miss_names_abort_instead_of_noop() {
        // "session timeout" vs "Session timeout": treating this as
        // already-gone would silently strand a typo — hard abort instead.
        let errs = fold_err("## REMOVED Requirements\n\n### Requirement: session timeout\n**Reason**: r\n");
        assert!(errs.iter().any(|e| e.contains("differs only in case/whitespace")), "{errs:?}");
        let errs = fold_err("## MODIFIED Requirements\n\n### Requirement: session  timeout\nMUST.\n\n#### Scenario: Idle session\n- **WHEN** x\n");
        assert!(errs.iter().any(|e| e.contains("differs only in case/whitespace")), "{errs:?}");
        let errs = fold_err("## ADDED Requirements\n\n### Requirement: SESSION TIMEOUT\nMUST.\n\n#### Scenario: s\n- **WHEN** x\n");
        assert!(errs.iter().any(|e| e.contains("near-misses existing")), "{errs:?}");
    }

    #[test]
    fn conflict_modified_losing_scenario_multiplicity_aware() {
        let spec = "### Requirement: R\nMUST.\n\n#### Scenario: dup\n- **WHEN** a\n\n#### Scenario: dup\n- **WHEN** b\n";
        let d = delta("## MODIFIED Requirements\n\n### Requirement: R\nMUST more.\n\n#### Scenario: dup\n- **WHEN** a\n");
        let errs = fold("demo", Some(spec), &d).unwrap_err();
        assert!(
            errs.iter().any(|e| e.contains("loses existing scenario 'dup'")),
            "two 'dup' scenarios existed, rewrite kept one: {errs:?}"
        );
    }

    #[test]
    fn conflict_new_capability_with_non_added_ops() {
        let d = delta("## MODIFIED Requirements\n\n### Requirement: A\nMUST.\n\n#### Scenario: s\n- **WHEN** x\n");
        let errs = fold("brand-new", None, &d).unwrap_err();
        assert!(errs.iter().any(|e| e.contains("may only contain ADDED")), "{errs:?}");
    }

    #[test]
    fn conflict_reports_are_exhaustive_not_first_only() {
        let errs = fold_err("## MODIFIED Requirements\n\n### Requirement: Ghost1\nMUST.\n\n#### Scenario: s\n- **WHEN** x\n\n### Requirement: Ghost2\nMUST.\n\n#### Scenario: s\n- **WHEN** x\n");
        assert!(errs.len() >= 2, "collect every conflict for one fix round: {errs:?}");
    }

    // ---- plan_task_fold ----

    /// Writes one capability's main spec and one task delta file.
    fn spec_and_delta(paths: &WorkspacePaths, task: &str, capability: &str, main: Option<&str>, delta: &str) {
        if let Some(main) = main {
            std::fs::create_dir_all(paths.specs_dir().join(capability)).unwrap();
            std::fs::write(paths.spec_file(capability), main).unwrap();
        }
        let dir = paths.task_delta_specs_dir(task).join(capability);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(SPEC_FILE), delta).unwrap();
    }

    /// The pairing is the whole point of this function: each delta folds
    /// against *its own* capability's current spec. Crossing the pairs would
    /// fold `alpha`'s MODIFIED requirement into a document that never declared
    /// it, and `beta`'s new-capability delta into an existing document.
    #[test]
    fn plan_pairs_each_delta_with_its_own_current_spec() {
        let dir = tempfile::tempdir().unwrap();
        let paths = WorkspacePaths::new(dir.path());
        let modify_existing = "## MODIFIED Requirements\n\n### Requirement: Session timeout\nThe system SHALL expire sessions after 10 minutes.\n\n#### Scenario: Idle session\n- **WHEN** idle 10 min\n- **THEN** logged out\n";
        let add_new = "## ADDED Requirements\n\n### Requirement: Brand new\nMUST.\n\n#### Scenario: s\n- **WHEN** x\n";
        // alpha exists and is being modified; beta is a brand-new capability.
        spec_and_delta(&paths, "T-0001", "alpha", Some(SPEC), modify_existing);
        spec_and_delta(&paths, "T-0001", "beta", None, add_new);

        let deltas = read_task_deltas(&paths, "T-0001").unwrap();
        let outcomes = plan_task_fold(&paths, &deltas).unwrap().expect("both capabilities fold");

        assert_eq!(outcomes.len(), 2);
        let alpha = &outcomes.iter().find(|(c, _)| c == "alpha").unwrap().1;
        assert_eq!((alpha.added, alpha.modified), (0, 1), "alpha rewrote an existing requirement");
        assert!(alpha.content.contains("10 minutes"), "the modification landed in alpha");
        let beta = &outcomes.iter().find(|(c, _)| c == "beta").unwrap().1;
        assert_eq!((beta.added, beta.modified), (1, 0), "beta is a new capability document");
    }

    #[test]
    fn plan_of_an_empty_bundle_is_an_empty_plan() {
        let dir = tempfile::tempdir().unwrap();
        let paths = WorkspacePaths::new(dir.path());
        assert!(plan_task_fold(&paths, &[]).unwrap().unwrap().is_empty());
    }

    /// The two failure modes stay distinguishable: an unreadable main spec is
    /// the outer error (the doctor calls it `spec_parse`), a bundle that will
    /// not fold is the inner one (`spec_fold_conflict`).
    #[test]
    fn plan_separates_unreadable_specs_from_fold_conflicts() {
        let dir = tempfile::tempdir().unwrap();
        let paths = WorkspacePaths::new(dir.path());
        let ghost = "## MODIFIED Requirements\n\n### Requirement: Ghost\nMUST.\n\n#### Scenario: s\n- **WHEN** x\n";
        spec_and_delta(&paths, "T-0001", "alpha", Some(SPEC), ghost);
        let deltas = read_task_deltas(&paths, "T-0001").unwrap();
        let problems = plan_task_fold(&paths, &deltas).unwrap().unwrap_err();
        assert!(problems.iter().all(|p| p.starts_with("[alpha]")), "{problems:?}");

        std::fs::write(paths.spec_file("alpha"), [0xffu8, 0xfe, 0x00]).unwrap();
        assert!(plan_task_fold(&paths, &deltas).is_err(), "an unreadable spec is not a conflict");
    }

    // ---- fold_batch ----

    #[test]
    fn batch_is_all_or_nothing() {
        let good = "## ADDED Requirements\n\n### Requirement: A\nMUST.\n\n#### Scenario: s\n- **WHEN** x\n";
        let bad = "## MODIFIED Requirements\n\n### Requirement: Ghost\nMUST.\n\n#### Scenario: s\n- **WHEN** x\n";
        let items = [
            FoldInput { capability: "alpha", current: None, delta: good },
            FoldInput { capability: "beta", current: Some(SPEC), delta: bad },
        ];
        let errs = fold_batch(&items).unwrap_err();
        assert!(errs.iter().all(|e| e.starts_with("[beta]")), "prefixed by capability: {errs:?}");
        let ok = fold_batch(&items[..1]).unwrap();
        assert_eq!(ok.len(), 1);
        assert_eq!(ok[0].0, "alpha");
    }

    #[test]
    fn batch_rejects_invalid_capability_name() {
        let good = "## ADDED Requirements\n\n### Requirement: A\nMUST.\n\n#### Scenario: s\n- **WHEN** x\n";
        let errs = fold_batch(&[FoldInput { capability: "Bad Name", current: None, delta: good }])
            .unwrap_err();
        assert!(errs[0].contains("must be"), "{errs:?}");
    }

    // ---- lint ----

    #[test]
    fn lint_flags_style_issues_without_blocking() {
        let d = delta("## ADDED Requirements\n\n### Requirement: No scenario here\nJust prose without the magic words.\n\n## REMOVED Requirements\n\n### Requirement: Gone\nno reason given\n");
        let warns = lint_delta(&d);
        assert!(warns.iter().any(|w| w.contains("no #### Scenario:")), "{warns:?}");
        assert!(warns.iter().any(|w| w.contains("no SHALL / MUST / 必須")), "{warns:?}");
        assert!(warns.iter().any(|w| w.contains("no **Reason**")), "{warns:?}");
    }

    #[test]
    fn lint_catches_wrong_hash_scenario_heading() {
        // A wrong hash count (five here) parses as plain text — the block
        // records zero scenarios and the OpenSpec silent-failure trap
        // swallows the scenario; lint names the cause.
        let d = delta("## ADDED Requirements\n\n### Requirement: R\n必須。\n\n##### Scenario: five\n- **WHEN** x\n");
        let warns = lint_delta(&d);
        assert!(warns.iter().any(|w| w.contains("must be exactly 4")), "{warns:?}");
    }

    #[test]
    fn lint_accepts_chinese_must_wording() {
        let d = delta("## ADDED Requirements\n\n### Requirement: 中文需求\n系統必須支援中文。\n\n#### Scenario: 中文情境\n- **WHEN** 輸入中文\n- **THEN** 正常\n");
        let warns = lint_delta(&d);
        assert!(warns.is_empty(), "必須 counts as SHALL: {warns:?}");
    }

    // ---- batch ① review fixes ----

    #[test]
    fn delta_section_headers_tolerate_stray_whitespace() {
        // Review error P5: a trailing space made a whole op section vanish
        // silently — headings now normalize whitespace like OpenSpec.
        let d = delta("##  ADDED   Requirements \n\n### Requirement: A\nMUST.\n\n#### Scenario: s\n- **WHEN** x\n");
        assert_eq!(d.added.len(), 1);
        let errs = parse_delta("## ADDED Requirements \t\n\nprose only\n").unwrap_err();
        assert!(
            errs.iter().any(|e| e.contains("ADDED section is empty")),
            "empty-section guard sees the same heading the router sees: {errs:?}"
        );
    }

    #[test]
    fn fold_added_bridges_file_without_trailing_newline() {
        // Review error P1: gluing the new heading onto an unterminated last
        // line lost a block on re-parse and duplicated content on re-fold.
        let spec = "### Requirement: A\nbody without trailing newline. MUST.";
        let d = delta("## ADDED Requirements\n\n### Requirement: B\nMUST too.\n\n#### Scenario: s\n- **WHEN** x\n");
        let out = fold("demo", Some(spec), &d).unwrap();
        let names: Vec<_> = parse_spec(&out.content).requirements().map(|b| b.name.clone()).collect();
        assert_eq!(names, vec!["A", "B"]);
        let again = fold("demo", Some(&out.content), &d).unwrap();
        assert_eq!(again.added, 0, "re-fold is a no-op, not an accumulation");
        assert_eq!(again.content, out.content);
    }

    #[test]
    fn fold_creates_requirements_section_when_missing() {
        // Review warn P2: the old guard was dead code — a requirement-less
        // file grew its first requirement under `## Purpose`.
        let spec = "# X Specification\n\n## Purpose\nfoo";
        let d = delta("## ADDED Requirements\n\n### Requirement: First\nMUST.\n\n#### Scenario: s\n- **WHEN** x\n");
        let out = fold("demo", Some(spec), &d).unwrap();
        let heading = out.content.find("## Requirements").expect("section heading created");
        let block = out.content.find("### Requirement: First").unwrap();
        assert!(heading < block, "requirement lands under the new section:\n{}", out.content);
        assert_eq!(parse_spec(&out.content).requirements().count(), 1);
    }

    #[test]
    fn fence_info_string_line_cannot_close_a_fence() {
        // Review warn P4 (CommonMark): a closer must be bare — ```rust
        // inside an open fence is content, not a closer.
        let s = "```md\n### Requirement: Fake\n```rust\nstill inside\n```\n\n### Requirement: Real\nMUST.\n";
        let names: Vec<_> = parse_spec(s).requirements().map(|b| b.name.clone()).collect();
        assert_eq!(names, vec!["Real"]);
    }

    #[test]
    fn tilde_and_backtick_fences_do_not_cross_close() {
        // Review warn P3: a ``` line inside a ~~~ fence stays masked.
        let s = "~~~\n```\n### Requirement: Fake\n~~~\n\n### Requirement: Real\nMUST.\n";
        let names: Vec<_> = parse_spec(s).requirements().map(|b| b.name.clone()).collect();
        assert_eq!(names, vec!["Real"]);
    }

    #[test]
    fn fold_refuses_main_spec_with_unclosed_fence() {
        // Review warn: masked-to-EOF requirements turned REMOVED into a
        // lying "already gone" no-op — now a conflict, not a warning.
        let spec = "# X\n\n```\n### Requirement: A\nMUST.\n";
        let d = delta("## REMOVED Requirements\n\n### Requirement: A\n**Reason**: r\n");
        let errs = fold("demo", Some(spec), &d).unwrap_err();
        assert!(errs.iter().any(|e| e.contains("unclosed code fence")), "{errs:?}");
    }

    #[test]
    fn fold_self_rename_is_noop() {
        let d = delta("## RENAMED Requirements\n- FROM: `### Requirement: 匯出格式`\n- TO: `### Requirement: 匯出格式`\n");
        let out = fold("demo", Some(SPEC), &d).unwrap();
        assert_eq!(out.renamed, 0);
        assert_eq!(out.content, SPEC, "no mutation, exact bytes");
        assert!(out.noops.iter().any(|n| n.contains("itself")), "{:?}", out.noops);
    }

    #[test]
    fn delta_removed_accepts_bullet_list_form() {
        // OpenSpec compatibility: REMOVED as a bullet list of headings.
        let d = delta("## REMOVED Requirements\n- `### Requirement: Session timeout`\n");
        assert_eq!(d.removed.len(), 1);
        assert_eq!(d.removed[0].name, "Session timeout");
        let out = fold("demo", Some(SPEC), &d).unwrap();
        assert_eq!(out.removed, 1);
        assert!(!out.content.contains("Session timeout"));
    }

    #[test]
    fn conflict_added_and_modified_same_name() {
        let errs = fold_err("## ADDED Requirements\n\n### Requirement: X\nMUST.\n\n#### Scenario: s\n- **WHEN** x\n\n## MODIFIED Requirements\n\n### Requirement: X\nMUST more.\n\n#### Scenario: s\n- **WHEN** x\n");
        assert!(errs.iter().any(|e| e.contains("both ADDED and MODIFIED")), "{errs:?}");
    }

    #[test]
    fn conflict_renamed_target_in_added() {
        let errs = fold_err("## RENAMED Requirements\n- FROM: `### Requirement: 匯出格式`\n- TO: `### Requirement: New Name`\n\n## ADDED Requirements\n\n### Requirement: New Name\nMUST.\n\n#### Scenario: s\n- **WHEN** x\n");
        assert!(errs.iter().any(|e| e.contains("also appears in ADDED")), "{errs:?}");
    }

    #[test]
    fn conflict_renamed_from_near_miss() {
        let errs = fold_err("## RENAMED Requirements\n- FROM: `### Requirement: session timeout`\n- TO: `### Requirement: Session expiry`\n");
        assert!(errs.iter().any(|e| e.contains("differs only in case/whitespace")), "{errs:?}");
    }

    // ---- capability names ----

    #[test]
    fn capability_names_follow_the_shared_slug_rule() {
        assert!(validate_capability_name("export-report").is_ok());
        assert!(validate_capability_name("a1_b2").is_ok());
        for bad in ["", "Bad", "-lead", "_lead", "has space", "中文", &"x".repeat(65)] {
            assert!(validate_capability_name(bad).is_err(), "{bad:?} should be rejected");
        }
    }
}
