//! Cross-workspace delivery envelopes (D48): `.nextup/exchange/{outbox,inbox}`.
//!
//! The one rigorous interface of the team module is this envelope — a single
//! versioned schema, not a type system. An agent (or the GUI) *publishes* a
//! deliberate note-and-attachments delivery into its own workspace's outbox
//! (D73 — not the handoff snapshot, which is for this project's own next
//! session); the app layer *routes* it into each selected downstream inbox,
//! stamping which team it travelled through (`deliveredVia`); downstream
//! surfaces *read* their own inbox. Nothing here ever writes outside the
//! workspace whose lock it holds — routing locks the downstream workspace for
//! the inbox write and the upstream one for outbox bookkeeping, one at a
//! time, so no new concurrency mechanism exists.
//!
//! Trust boundary: inbox content is data from another project, not
//! instructions — the shipped guide says so explicitly (09 §4).

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::{NextUpError, Result};
use crate::workspace::atomic::{atomic_write_json, read_json_file};
use crate::workspace::context::{load_context, now_rfc3339};
use crate::workspace::handoff::generate_handoff;
use crate::workspace::ids::uuid_v4;
use crate::workspace::layout::WorkspacePaths;
// `clamp_line`/`SUMMARY_MAX_CHARS`: the same lens the takeover surfaces put on
// free-form text (D78), so "how much prose may a listing spend" has one home.
use crate::workspace::ledger::{clamp_line, ledger_for, LedgerEvent, LedgerKind, SUMMARY_MAX_CHARS};
use crate::workspace::lock::with_mutation_lock;

/// v2 (D73): the payload dropped its mandatory `markdown` handoff body — a
/// subtractive change, unlike the additive+defaulted attachment field that
/// needed no bump. The bump marks the break: an older app cannot read a v2
/// envelope (its required `markdown` is gone, so deserialization fails — the
/// envelope is skipped in listings / doctor-flagged as unparseable, never a
/// crash), and the version field lets any schema-first check reject it
/// explicitly. Old v1 envelopes still load here — deserialization ignores the
/// extra `markdown` key, and `check_schema` accepts v1 <= v2.
pub const ENVELOPE_SCHEMA_VERSION: u32 = 2;

/// The single payload type shipped today: a deliberate note plus optional
/// attachments (D73 — no longer the auto-generated handoff snapshot). The field
/// exists so new types are an enum addition, never an envelope redesign (09 §4).
pub const PAYLOAD_NOTE: &str = "note";

/// Attachment guardrails (D71 Batch B) — the exchange is a local mailbox, not a
/// file server. Rejection is all-or-nothing so a delivery never lands half its
/// files.
pub const MAX_ATTACHMENTS: usize = 20;
pub const MAX_ATTACHMENT_TOTAL_BYTES: u64 = 50 * 1024 * 1024;

/// One file delivered alongside the note (D73). The bytes live in the envelope's
/// sibling directory (`<box>/<id>/<name>`); the manifest keeps only name+size
/// so the JSON stays small and — because it holds no absolute path — the
/// envelope stays portable as routing copies it inbox↔outbox across machines.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentRef {
    pub name: String,
    /// Where the file sat in the sender's workspace, `/`-separated — and where
    /// it sits inside the envelope directory. Absent when the file came from
    /// outside the workspace (a GUI file picker), where only a name exists.
    ///
    /// Storing the name alone flattened every delivery into one directory,
    /// with two costs that were never written down: the spec layer mandates
    /// `specs/<capability>/spec.md`, so delivering two capabilities' specs
    /// *always* collided on `spec.md` and could only be worked around by
    /// renaming copies that then drift; and the receiver's files no longer
    /// matched any path the accompanying documents referred to, silently, with
    /// the sender none the wiser. `#[serde(default)]` — pre-D86 envelopes load
    /// with `None` and keep their flat layout, no migration.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    pub size_bytes: u64,
}

impl AttachmentRef {
    /// Where these bytes live inside the envelope directory, as written.
    pub fn stored_path(&self) -> &str {
        self.path.as_deref().unwrap_or(&self.name)
    }

    /// [`stored_path`](Self::stored_path) checked before it is joined to a real
    /// directory. Manifests travel between workspaces, so by the time a reader
    /// sees one it is input, not something this process wrote: anything
    /// absolute, rooted, or containing `..` is refused rather than resolved.
    pub fn safe_relative(&self) -> Result<PathBuf> {
        let raw = self.stored_path();
        let candidate = Path::new(raw);
        let sane = !raw.is_empty()
            && !candidate.is_absolute()
            && candidate.components().all(|c| matches!(c, std::path::Component::Normal(_)));
        if sane {
            Ok(candidate.to_path_buf())
        } else {
            Err(NextUpError::InvalidInput(format!("unsafe attachment path in envelope: {raw}")))
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DeliveryEnvelope {
    pub schema_version: u32,
    /// UUID — envelopes cross workspaces, so per-workspace sequential ids
    /// (two upstreams both own a T-0001) cannot name them.
    pub id: String,
    pub from: DeliverySource,
    pub payload_type: String,
    pub payload: DeliveryPayload,
    pub published_at: String,
    /// The outbox envelope this one replaces, when the publisher is correcting
    /// itself. Nothing is deleted and nothing is rewritten: the replacement
    /// names its predecessor, and surfaces derive "this one is stale" from
    /// that. Absent on everything else. `#[serde(default)]` — pre-D86
    /// envelopes load unchanged.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub supersedes: Option<String>,
    /// The later envelope that replaced this one. Stamped onto the
    /// predecessor when the replacement is published — **stored, not derived**.
    ///
    /// Deriving it from the rest of the box was the first design and it read
    /// better: no second field to keep in step, and an envelope would be stale
    /// exactly while its replacement was present. But routing *moves the
    /// replacement out of the outbox*, so sending the correction made the
    /// wrong envelope look ordinary again — the warning disappeared at
    /// precisely the moment it started mattering.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub superseded_by: Option<String>,
    /// Stamped by routing on the inbox copy; the outbox original has neither.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub delivered_at: Option<String>,
    /// Which team the delivery travelled through — one workspace can sit in
    /// several teams, and downstream audit must tell the flows apart (09 §4).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub delivered_via: Option<DeliveredVia>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DeliverySource {
    pub workspace_id: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DeliveryPayload {
    /// The sender's deliberate cover note — what is being handed over and how to
    /// use it (D73). Optional at the type level, but `publish_delivery` requires
    /// either a note or at least one attachment so a delivery is never empty.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    /// Files delivered alongside the note; the bytes live in the envelope's
    /// sibling directory. `#[serde(default)]` — pre-attachment envelopes (D48)
    /// load with an empty list, no migration; empty lists are not re-serialized
    /// so those envelopes stay byte-identical on disk.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub attachments: Vec<AttachmentRef>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DeliveredVia {
    pub team_id: String,
    pub team_name: String,
}

/// How much of each cover note a listing carries. Named rather than a bare
/// bool because both call sites read as prose this way, and because the cheap
/// answer is the one a caller has to ask for on purpose.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NoteDetail {
    /// Whole note. What the GUI list renders, and its own layout bounds it.
    Full,
    /// First line only, capped — for "just tell me what is here".
    Brief,
}

/// Which side of the exchange to address.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DeliveryBox {
    Inbox,
    Outbox,
}

impl DeliveryBox {
    pub fn dir(self, paths: &WorkspacePaths) -> PathBuf {
        match self {
            DeliveryBox::Inbox => paths.inbox_dir(),
            DeliveryBox::Outbox => paths.outbox_dir(),
        }
    }

    /// Both edges name the box on the wire (the hub's `box` argument, the IPC
    /// layer's `mailbox`), so the accepted names and the rejection message live
    /// here rather than once per edge. Defaulting stays with the caller: the
    /// hub's argument is optional and means inbox when absent, the GUI always
    /// names the box it wants.
    pub fn parse(name: &str) -> Result<Self> {
        match name {
            "inbox" => Ok(DeliveryBox::Inbox),
            "outbox" => Ok(DeliveryBox::Outbox),
            other => Err(NextUpError::InvalidInput(format!(
                "box must be inbox or outbox, got {other}"
            ))),
        }
    }
}

/// Envelope ids come in over the wire (hub `get_delivery {id}`) and become
/// file names — accept nothing that could leave the exchange directory.
fn validate_envelope_id(id: &str) -> Result<()> {
    let shaped =
        !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_hexdigit() || c == '-');
    if shaped {
        Ok(())
    } else {
        Err(NextUpError::InvalidInput(format!("invalid delivery id: {id}")))
    }
}

fn envelope_file(paths: &WorkspacePaths, mailbox: DeliveryBox, id: &str) -> PathBuf {
    mailbox.dir(paths).join(format!("{id}.json"))
}

/// The envelope's sibling directory holding its attachment bytes. `id` is a
/// validated uuid (hex + dashes), safe as a path segment; it sits beside
/// `<id>.json`, and listings/doctor filter to `.json` so the folder never reads
/// as an envelope.
fn envelope_dir(paths: &WorkspacePaths, mailbox: DeliveryBox, id: &str) -> PathBuf {
    mailbox.dir(paths).join(id)
}

/// Where `src` sits inside the workspace, `/`-separated, or `None` when it is
/// not under the root at all. Both sides are canonicalized so the comparison
/// survives symlinks and Windows' verbatim prefixes.
///
/// Derived rather than passed in, so both callers get the same treatment
/// without a new argument: the hub resolves agent-supplied relative paths
/// under the root and keeps its layout, while a GUI pick from elsewhere on
/// disk has no workspace path to keep and falls back to its name.
fn workspace_relative(paths: &WorkspacePaths, src: &Path) -> Option<String> {
    let root = paths.root().canonicalize().ok()?;
    let full = src.canonicalize().ok()?;
    let rel = full.strip_prefix(&root).ok()?;
    let parts: Option<Vec<&str>> = rel.components().map(|c| c.as_os_str().to_str()).collect();
    let joined = parts?.join("/");
    (!joined.is_empty()).then_some(joined)
}

/// Validate an attachment batch *before* any byte is copied: every path must be
/// an existing regular file, storage locations must be unique, and the
/// count/total-size caps must hold. Returns the manifest in input order.
/// All-or-nothing — a rejected batch never reaches the copy step, so no
/// half-populated directory can survive it.
fn validate_attachments(paths: &WorkspacePaths, sources: &[PathBuf]) -> Result<Vec<AttachmentRef>> {
    if sources.len() > MAX_ATTACHMENTS {
        return Err(NextUpError::InvalidInput(format!(
            "too many attachments ({}, max {MAX_ATTACHMENTS})",
            sources.len()
        )));
    }
    let mut refs = Vec::with_capacity(sources.len());
    let mut seen = HashSet::new();
    let mut total: u64 = 0;
    for path in sources {
        let meta = std::fs::metadata(path)
            .map_err(|_| NextUpError::InvalidInput(format!("attachment not found: {}", path.display())))?;
        if !meta.is_file() {
            return Err(NextUpError::InvalidInput(format!(
                "attachment is not a regular file: {}",
                path.display()
            )));
        }
        let name = path
            .file_name()
            .and_then(|n| n.to_str())
            .ok_or_else(|| {
                NextUpError::InvalidInput(format!("attachment has no usable file name: {}", path.display()))
            })?
            .to_string();
        let att = AttachmentRef {
            path: workspace_relative(paths, path),
            name,
            size_bytes: meta.len(),
        };
        // Dedup case-insensitively on where the bytes will land, not on the
        // bare name: two files may legitimately share a name from different
        // directories, but they may not share a destination. The directory
        // reaches the downstream's filesystem too, and a case-insensitive one
        // (NTFS, APFS-default) would let a second `report.md` silently
        // overwrite `Report.md` — manifest and disk would disagree. Reject the
        // whole batch up front instead.
        if !seen.insert(att.stored_path().to_lowercase()) {
            return Err(NextUpError::InvalidInput(format!(
                "two attachments would be stored at the same place: {}",
                att.stored_path()
            )));
        }
        total = total.saturating_add(meta.len());
        if total > MAX_ATTACHMENT_TOTAL_BYTES {
            return Err(NextUpError::InvalidInput(format!(
                "attachments exceed the {MAX_ATTACHMENT_TOTAL_BYTES}-byte total limit"
            )));
        }
        refs.push(att);
    }
    Ok(refs)
}

/// Copy the validated source files into the envelope's attachment directory,
/// each under the workspace-relative path it came from. On any copy error the
/// partial directory is removed, so a failed publish leaves nothing behind.
fn copy_attachments(sources: &[PathBuf], refs: &[AttachmentRef], dest_dir: &Path) -> Result<()> {
    std::fs::create_dir_all(dest_dir)?;
    for (src, att) in sources.iter().zip(refs) {
        let copy = || -> Result<()> {
            let target = dest_dir.join(att.safe_relative()?);
            if let Some(parent) = target.parent() {
                std::fs::create_dir_all(parent)?;
            }
            std::fs::copy(src, target)?;
            Ok(())
        };
        if let Err(e) = copy() {
            let _ = std::fs::remove_dir_all(dest_dir);
            return Err(e);
        }
    }
    Ok(())
}

/// Copy an envelope's attachment directory into `dst`, overwriting. Routing
/// uses it to carry the bytes alongside the JSON. Recursive since attachments
/// keep their sender-side layout; it walks the directory rather than the
/// manifest, so no envelope-supplied string ever becomes a path here.
fn copy_envelope_dir(src: &Path, dst: &Path) -> Result<()> {
    // Open the source first: if it is missing (a torn envelope that lists
    // attachments), fail before creating an empty `dst` — otherwise a transient
    // failure would leave a doctor-flagged orphan directory in the inbox.
    let entries = std::fs::read_dir(src)?;
    std::fs::create_dir_all(dst)?;
    for entry in entries {
        let entry = entry?;
        let kind = entry.file_type()?;
        let target = dst.join(entry.file_name());
        if kind.is_file() {
            std::fs::copy(entry.path(), target)?;
        } else if kind.is_dir() {
            copy_envelope_dir(&entry.path(), &target)?;
        }
    }
    Ok(())
}

/// Resolve a hub-supplied *relative* attachment path against the workspace
/// root, rejecting anything that could escape it. Same defense-in-depth spirit
/// as [`validate_envelope_id`], but this one touches the filesystem: it rejects
/// absolute paths and `..` components up front, then canonicalizes the result
/// and re-checks containment so a symlink can't tunnel out either. GUI callers
/// pass absolute paths straight from the native picker and never come here.
pub fn resolve_workspace_relative(paths: &WorkspacePaths, rel: &str) -> Result<PathBuf> {
    let rel_path = Path::new(rel);
    if rel_path.is_absolute() {
        return Err(NextUpError::InvalidInput(format!("attachment path must be relative: {rel}")));
    }
    if rel_path.components().any(|c| matches!(c, std::path::Component::ParentDir)) {
        return Err(NextUpError::InvalidInput(format!("attachment path escapes the workspace: {rel}")));
    }
    let root_canonical = paths
        .root()
        .canonicalize()
        .map_err(|_| NextUpError::Workspace("workspace root is not accessible".into()))?;
    let canonical = paths
        .root()
        .join(rel_path)
        .canonicalize()
        .map_err(|_| NextUpError::InvalidInput(format!("attachment not found: {rel}")))?;
    if !canonical.starts_with(&root_canonical) {
        return Err(NextUpError::InvalidInput(format!("attachment path escapes the workspace: {rel}")));
    }
    Ok(canonical)
}

fn check_schema(envelope: &DeliveryEnvelope) -> Result<()> {
    if envelope.schema_version > ENVELOPE_SCHEMA_VERSION {
        return Err(NextUpError::Workspace(format!(
            "delivery envelope schema v{} is newer than this app supports (v{})",
            envelope.schema_version, ENVELOPE_SCHEMA_VERSION
        )));
    }
    Ok(())
}

/// What a publish may say beyond its content. Separate struct so the four
/// content arguments stay the shape of the call and occasional extras do not
/// keep widening it — the same reason [`RouteOptions`] exists.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct PublishOptions {
    /// Id of an outbox envelope this one corrects. Must still be in the
    /// outbox: once routed, the copies downstream cannot be recalled and
    /// claiming otherwise would be a lie.
    pub supersedes: Option<String>,
}

/// Package the sender's note and attachments as a delivery envelope in this
/// workspace's outbox (D73 — no longer the handoff snapshot). Requires a note
/// or at least one attachment. Where the delivery goes is decided later by
/// routing along the team graph, never here (09 §12 Q2).
pub fn publish_delivery(
    paths: &WorkspacePaths,
    app_version: &str,
    note: Option<String>,
    attachment_paths: &[PathBuf],
    options: PublishOptions,
) -> Result<DeliveryEnvelope> {
    // Defense in depth behind the exposure filter (D37 precedent: same rule
    // as collab's claim/assign) — covers mid-session module toggles.
    crate::workspace::modules::require_module(paths, crate::workspace::modules::MODULE_TEAM)?;
    // Validate the request up front — before locking or touching workspace
    // state — so an invalid publish acquires no lock and mints no workspace id.
    let note = note.map(|n| n.trim().to_string()).filter(|n| !n.is_empty());
    if let Some(target) = options.supersedes.as_deref() {
        validate_envelope_id(target)?;
        if !envelope_file(paths, DeliveryBox::Outbox, target).is_file() {
            return Err(NextUpError::InvalidInput(format!(
                "cannot supersede {target}: no such envelope is waiting in the outbox \
                 (an envelope that has already been sent cannot be recalled — \
                 publish the correction and tell the user what changed)"
            )));
        }
    }
    // All-or-nothing attachment check (reads only the given source files).
    let attachments = validate_attachments(paths, attachment_paths)?;
    // With the handoff body gone (D73), a note-less attachment-less publish is
    // an empty envelope — reject it so the GUI and an agent calling
    // publish_delivery hit the same guard.
    if note.is_none() && attachments.is_empty() {
        return Err(NextUpError::InvalidInput(
            "a delivery needs a note or at least one attachment".into(),
        ));
    }
    with_mutation_lock(paths, || {
        let workspace_id = crate::workspace::ops::ensure_workspace_id_locked(paths)?;
        let ctx = load_context(&paths.context_file())?;
        let id = uuid_v4();

        // Copy the bytes into the envelope directory *before* the JSON — the
        // envelope file is the commit marker.
        let dir = paths.outbox_dir();
        std::fs::create_dir_all(&dir)?;
        if !attachments.is_empty() {
            copy_attachments(
                attachment_paths,
                &attachments,
                &envelope_dir(paths, DeliveryBox::Outbox, &id),
            )?;
        }

        let envelope = DeliveryEnvelope {
            schema_version: ENVELOPE_SCHEMA_VERSION,
            id,
            from: DeliverySource { workspace_id, name: ctx.name },
            payload_type: PAYLOAD_NOTE.to_string(),
            payload: DeliveryPayload { note: note.clone(), attachments },
            published_at: now_rfc3339(),
            supersedes: options.supersedes.clone(),
            superseded_by: None,
            delivered_at: None,
            delivered_via: None,
        };
        atomic_write_json(&envelope_file(paths, DeliveryBox::Outbox, &envelope.id), &envelope)?;

        // Stamp the predecessor, all-or-nothing: a publish that leaves the
        // superseded envelope unmarked is the exact situation this exists to
        // prevent, so back the new envelope out rather than half-succeed.
        if let Some(target) = options.supersedes.as_deref() {
            let stamp = || -> Result<()> {
                let file = envelope_file(paths, DeliveryBox::Outbox, target);
                let mut old: DeliveryEnvelope = read_json_file(&file)?;
                old.superseded_by = Some(envelope.id.clone());
                atomic_write_json(&file, &old)
            };
            if let Err(e) = stamp() {
                let _ = std::fs::remove_file(envelope_file(paths, DeliveryBox::Outbox, &envelope.id));
                let _ = std::fs::remove_dir_all(envelope_dir(paths, DeliveryBox::Outbox, &envelope.id));
                return Err(e);
            }
        }
        let suffix = note.map(|n| format!(" — {n}")).unwrap_or_default();
        let replacing = options
            .supersedes
            .as_deref()
            .map(|t| format!(" (replaces {t})"))
            .unwrap_or_default();
        ledger_for(paths).append(&LedgerEvent::new(
            LedgerKind::DeliveryPublished,
            format!("delivery {} published to outbox{replacing}{suffix}", envelope.id),
            None,
        ))?;
        generate_handoff(paths, app_version)?;
        Ok(envelope)
    })
}

/// One selected routing target: a downstream member workspace plus the team
/// whose edge carries the delivery (stamped as `deliveredVia`).
#[derive(Debug, Clone)]
pub struct RouteDestination {
    pub root: PathBuf,
    pub team_id: String,
    pub team_name: String,
}

#[derive(Debug, Clone, Serialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RouteOutcome {
    /// Downstream project names that newly received the envelope.
    pub delivered: Vec<String>,
    /// Destinations skipped because their inbox already has this envelope
    /// (an earlier partially-failed send — retries never double-deliver).
    pub already_delivered: Vec<String>,
    pub failed: Vec<RouteFailure>,
    /// True when every requested destination has the envelope and the outbox
    /// original was therefore removed (the move completed).
    pub outbox_cleared: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RouteFailure {
    pub root: String,
    pub message: String,
}

/// How a routing run behaves beyond its destination list (D71).
#[derive(Debug, Clone, Copy, Default)]
pub struct RouteOptions {
    /// Marks the ledger lines on both sides — policy-triggered routing must
    /// stay distinguishable from a human send in the audit trail.
    pub auto: bool,
    /// Keep the outbox original even when every requested destination
    /// succeeds. Auto-routing covers only the auto edges of a workspace;
    /// clearing on that partial fan-out would orphan the manual edges'
    /// deliveries — nobody decided to skip them.
    pub keep_pending: bool,
}

/// Route one outbox envelope to the selected destinations (app layer only —
/// the hub has no tool for this; 09 §5). Per destination: lock the downstream
/// workspace, write the stamped copy into its inbox (idempotent by id) and
/// ledger `delivery_received` there. Afterwards, under the upstream lock:
/// ledger `delivery_routed` per new delivery and remove the outbox original
/// once no destination failed — an unreachable destination keeps the envelope
/// pending so the user can retry (09 §5), and `opts.keep_pending` keeps it
/// even on success (D71 partial fan-out).
pub fn route_delivery(
    upstream: &WorkspacePaths,
    app_version: &str,
    id: &str,
    destinations: &[RouteDestination],
    opts: RouteOptions,
) -> Result<RouteOutcome> {
    validate_envelope_id(id)?;
    if destinations.is_empty() {
        return Err(NextUpError::InvalidInput("no destinations selected".into()));
    }
    let out_path = envelope_file(upstream, DeliveryBox::Outbox, id);
    if !out_path.is_file() {
        return Err(NextUpError::NotFound(format!("delivery {id} is not in the outbox")));
    }
    let envelope: DeliveryEnvelope = read_json_file(&out_path)?;
    check_schema(&envelope)?;

    let auto_suffix = if opts.auto { " (auto)" } else { "" };
    let mut outcome = RouteOutcome::default();
    for dest in destinations {
        let down = WorkspacePaths::new(&dest.root);
        // Guard before locking: taking the lock would create `.nextup/` inside
        // an arbitrary folder (offline drive mount points, typos).
        if !down.is_initialized() {
            outcome.failed.push(RouteFailure {
                root: dest.root.display().to_string(),
                message: "not an initialized Agent NextUp workspace (folder missing or offline?)".into(),
            });
            continue;
        }
        let delivered = with_mutation_lock(&down, || {
            let target = envelope_file(&down, DeliveryBox::Inbox, &envelope.id);
            if target.is_file() {
                let ctx = load_context(&down.context_file())?;
                return Ok((false, ctx.name));
            }
            std::fs::create_dir_all(down.inbox_dir())?;
            // Carry the attachment bytes across *before* writing the inbox JSON.
            // The JSON is the commit marker: a crash after the copy but before
            // the write leaves an orphan directory the next retry overwrites,
            // never an envelope pointing at missing files. The already-delivered
            // early-return above means this runs only for a genuinely new copy,
            // so an existing inbox directory is never clobbered.
            if !envelope.payload.attachments.is_empty() {
                copy_envelope_dir(
                    &envelope_dir(upstream, DeliveryBox::Outbox, &envelope.id),
                    &envelope_dir(&down, DeliveryBox::Inbox, &envelope.id),
                )?;
            }
            let mut copy = envelope.clone();
            copy.delivered_at = Some(now_rfc3339());
            copy.delivered_via =
                Some(DeliveredVia { team_id: dest.team_id.clone(), team_name: dest.team_name.clone() });
            atomic_write_json(&target, &copy)?;
            ledger_for(&down).append(&LedgerEvent::new(
                LedgerKind::DeliveryReceived,
                format!(
                    "delivery {} received from {} via team {}{auto_suffix}",
                    envelope.id, envelope.from.name, dest.team_name
                ),
                None,
            ))?;
            generate_handoff(&down, app_version)?;
            let ctx = load_context(&down.context_file())?;
            Ok((true, ctx.name))
        });
        match delivered {
            Ok((true, name)) => outcome.delivered.push(name),
            Ok((false, name)) => outcome.already_delivered.push(name),
            Err(e) => outcome
                .failed
                .push(RouteFailure { root: dest.root.display().to_string(), message: e.to_string() }),
        }
    }

    let clear = outcome.failed.is_empty() && !opts.keep_pending;
    with_mutation_lock(upstream, || {
        for name in &outcome.delivered {
            ledger_for(upstream).append(&LedgerEvent::new(
                LedgerKind::DeliveryRouted,
                format!("delivery {} routed to {name}{auto_suffix}", envelope.id),
                None,
            ))?;
        }
        if clear {
            std::fs::remove_file(&out_path)?;
            // Remove the attachment bytes *after* the JSON. Reversing the order
            // would leave the envelope pending in the outbox with its files
            // already gone, so a later manual send would silently deliver an
            // attachment-less envelope.
            let out_dir = envelope_dir(upstream, DeliveryBox::Outbox, id);
            if out_dir.is_dir() {
                std::fs::remove_dir_all(&out_dir)?;
            }
        }
        if clear || !outcome.delivered.is_empty() {
            generate_handoff(upstream, app_version)?;
        }
        Ok(())
    })?;
    outcome.outbox_cleared = clear;
    Ok(outcome)
}

/// Listing row: the envelope's headline fields (note + attachment count) without
/// the full attachment manifest.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DeliverySummary {
    pub id: String,
    pub from: DeliverySource,
    pub payload_type: String,
    /// How many files ride with this envelope — drives the 📎 chip without the
    /// list having to fetch each full payload.
    pub attachment_count: usize,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    /// Set when `note` was clamped for a brief listing, so a reader knows the
    /// text continues and which call returns the rest (`get_delivery`).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub note_truncated: bool,
    /// The envelope this one replaces, and the one that replaced it — both
    /// straight from the manifest (see `DeliveryEnvelope::superseded_by` for
    /// why the back-reference is stored rather than derived).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub supersedes: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub superseded_by: Option<String>,
    pub published_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub delivered_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub delivered_via: Option<DeliveredVia>,
}

/// List one box, newest first. Unparsable files are skipped — hiding the
/// healthy envelopes behind one torn file would help nobody; the doctor is
/// the surface that names broken envelopes.
///
/// [`NoteDetail::Brief`] clamps each cover note to its first line. Full notes
/// are unbounded prose, so "which deliveries do I have?" was answered with the
/// entire text of every one of them — during the D86 run an auditor wanting a
/// list of two envelopes was handed 10 KB. The rows are otherwise identical,
/// and `noteTruncated` marks every note that continues.
pub fn list_deliveries(
    paths: &WorkspacePaths,
    mailbox: DeliveryBox,
    detail: NoteDetail,
) -> Result<Vec<DeliverySummary>> {
    let dir = mailbox.dir(paths);
    if !dir.is_dir() {
        return Ok(Vec::new());
    }
    let mut rows: Vec<DeliverySummary> = Vec::new();
    for entry in std::fs::read_dir(&dir)? {
        let path = entry?.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let Ok(envelope) = read_json_file::<DeliveryEnvelope>(&path) else { continue };
        if check_schema(&envelope).is_err() {
            continue;
        }
        let (note, note_truncated) = match (detail, envelope.payload.note) {
            (NoteDetail::Brief, Some(note)) => {
                let (head, cut) = clamp_line(&note, SUMMARY_MAX_CHARS);
                (Some(head.to_string()), cut)
            }
            (_, note) => (note, false),
        };
        rows.push(DeliverySummary {
            id: envelope.id,
            from: envelope.from,
            payload_type: envelope.payload_type,
            attachment_count: envelope.payload.attachments.len(),
            note,
            note_truncated,
            supersedes: envelope.supersedes,
            superseded_by: envelope.superseded_by,
            published_at: envelope.published_at,
            delivered_at: envelope.delivered_at,
            delivered_via: envelope.delivered_via,
        });
    }
    rows.sort_by(|a, b| {
        let ka = a.delivered_at.as_deref().unwrap_or(&a.published_at);
        let kb = b.delivered_at.as_deref().unwrap_or(&b.published_at);
        kb.cmp(ka).then_with(|| b.id.cmp(&a.id))
    });
    Ok(rows)
}

/// Read one envelope in full (payload included). Errors carry the file path
/// (atomic read helpers) so a torn envelope names itself.
pub fn get_delivery(
    paths: &WorkspacePaths,
    mailbox: DeliveryBox,
    id: &str,
) -> Result<DeliveryEnvelope> {
    validate_envelope_id(id)?;
    let path = envelope_file(paths, mailbox, id);
    if !path.is_file() {
        return Err(NextUpError::NotFound(format!("no delivery {id} in this box")));
    }
    let envelope: DeliveryEnvelope = read_json_file(&path)?;
    check_schema(&envelope)?;
    Ok(envelope)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::security::keystore::StaticKeyProvider;
    use crate::workspace::context::save_context;
    use crate::workspace::init::{initialize_project, InitProjectParams};
    use crate::workspace::ledger::Ledger;

    fn workspace(name: &str) -> (tempfile::TempDir, WorkspacePaths) {
        let dir = tempfile::tempdir().unwrap();
        let params = InitProjectParams {
            root: dir.path().to_string_lossy().into_owned(),
            name: name.into(),
            domain: "coding".into(),
            modules: vec![crate::workspace::modules::MODULE_TEAM.into()],
            ..Default::default()
        };
        initialize_project(&params, &StaticKeyProvider([5u8; 32]), "0.1.0").unwrap();
        let paths = WorkspacePaths::new(dir.path());
        (dir, paths)
    }

    #[test]
    fn box_names_parse_and_anything_else_is_refused() {
        assert_eq!(DeliveryBox::parse("inbox").unwrap(), DeliveryBox::Inbox);
        assert_eq!(DeliveryBox::parse("outbox").unwrap(), DeliveryBox::Outbox);
        let err = DeliveryBox::parse("Inbox").unwrap_err();
        assert_eq!(err.kind(), "invalid_input", "the names are exact, not case-folded");
        assert!(err.to_string().contains("Inbox"), "the message quotes what was sent");
    }

    #[test]
    fn publish_requires_the_team_module() {
        let dir = tempfile::tempdir().unwrap();
        let params = InitProjectParams {
            root: dir.path().to_string_lossy().into_owned(),
            name: "no-team".into(),
            ..Default::default()
        };
        initialize_project(&params, &StaticKeyProvider([5u8; 32]), "0.1.0").unwrap();
        let paths = WorkspacePaths::new(dir.path());
        let err = publish_delivery(&paths, "0.1.0", None, &[], PublishOptions::default()).unwrap_err();
        assert_eq!(err.kind(), "invalid_input");
        assert!(err.to_string().contains("team"));
        assert!(!paths.outbox_dir().exists(), "a refused publish leaves no outbox behind");
    }

    fn dest(paths: &WorkspacePaths, team: &str) -> RouteDestination {
        RouteDestination {
            root: paths.root().to_path_buf(),
            team_id: "team-1".into(),
            team_name: team.into(),
        }
    }

    #[test]
    fn publish_packages_note_into_outbox() {
        let (_g, paths) = workspace("alpha");
        let envelope =
            publish_delivery(&paths, "0.1.0", Some("  wave one done  ".into()), &[], PublishOptions::default()).unwrap();

        assert_eq!(envelope.schema_version, ENVELOPE_SCHEMA_VERSION);
        assert_eq!(envelope.payload_type, PAYLOAD_NOTE);
        assert_eq!(envelope.from.name, "alpha");
        assert_eq!(envelope.payload.note.as_deref(), Some("wave one done"), "note is trimmed");
        assert!(envelope.payload.attachments.is_empty(), "no files were attached");
        assert!(envelope.delivered_at.is_none() && envelope.delivered_via.is_none());

        // On disk in the outbox, and ledgered.
        let listed = list_deliveries(&paths, DeliveryBox::Outbox, NoteDetail::Full).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, envelope.id);
        assert_eq!(listed[0].note.as_deref(), Some("wave one done"));
        let log = Ledger::new(paths.ledger_file())
            .recent_of_kind(LedgerKind::DeliveryPublished, 5)
            .unwrap();
        assert_eq!(log.len(), 1);

        // From-id matches the workspace's stable id.
        let ctx = load_context(&paths.context_file()).unwrap();
        assert_eq!(Some(envelope.from.workspace_id), ctx.workspace_id);
    }

    #[test]
    fn publish_rejects_an_empty_delivery() {
        // D73: with the handoff body gone, a note-less attachment-less publish
        // would be a contentless envelope — the core rejects it, no outbox residue.
        let (_g, paths) = workspace("alpha");
        let err = publish_delivery(&paths, "0.1.0", None, &[], PublishOptions::default()).unwrap_err();
        assert_eq!(err.kind(), "invalid_input");
        // A blank/whitespace-only note is trimmed to nothing and counts as absent.
        assert_eq!(
            publish_delivery(&paths, "0.1.0", Some("   ".into()), &[], PublishOptions::default()).unwrap_err().kind(),
            "invalid_input"
        );
        assert!(list_deliveries(&paths, DeliveryBox::Outbox, NoteDetail::Full).unwrap().is_empty(), "no envelope written");
    }

    #[test]
    fn publish_backfills_id_on_legacy_workspace() {
        let (_g, paths) = workspace("legacy");
        let mut ctx = load_context(&paths.context_file()).unwrap();
        ctx.workspace_id = None;
        save_context(&paths.context_file(), &ctx).unwrap();

        let envelope = publish_delivery(&paths, "0.1.0", Some("legacy publish".into()), &[], PublishOptions::default()).unwrap();
        let ctx = load_context(&paths.context_file()).unwrap();
        assert_eq!(ctx.workspace_id.as_deref(), Some(envelope.from.workspace_id.as_str()));
        let log = Ledger::new(paths.ledger_file())
            .recent_of_kind(LedgerKind::WorkspaceIdAssigned, 5)
            .unwrap();
        assert_eq!(log.len(), 1, "mint inside publish leaves the same audit line");
    }

    #[test]
    fn route_moves_stamped_copies_and_ledgers_both_sides() {
        let (_ga, up) = workspace("alpha");
        let (_gb, down) = workspace("beta");
        let envelope = publish_delivery(&up, "0.1.0", Some("hand-off note".into()), &[], PublishOptions::default()).unwrap();

        let outcome = route_delivery(
            &up,
            "0.1.0",
            &envelope.id,
            &[dest(&down, "research to dev")],
            RouteOptions::default(),
        )
        .unwrap();
        assert_eq!(outcome.delivered, vec!["beta".to_string()]);
        assert!(outcome.outbox_cleared);
        assert!(list_deliveries(&up, DeliveryBox::Outbox, NoteDetail::Full).unwrap().is_empty(), "moved out");

        let received = get_delivery(&down, DeliveryBox::Inbox, &envelope.id).unwrap();
        assert_eq!(received.payload.note, envelope.payload.note);
        assert!(received.delivered_at.is_some());
        assert_eq!(received.delivered_via.as_ref().unwrap().team_name, "research to dev");

        let up_log =
            Ledger::new(up.ledger_file()).recent_of_kind(LedgerKind::DeliveryRouted, 5).unwrap();
        assert_eq!(up_log.len(), 1);
        assert!(up_log[0].message.contains("beta"));
        assert!(!up_log[0].message.contains(" (auto)"), "a human send carries no auto mark");
        let down_log = Ledger::new(down.ledger_file())
            .recent_of_kind(LedgerKind::DeliveryReceived, 5)
            .unwrap();
        assert_eq!(down_log.len(), 1);
        assert!(down_log[0].message.contains("alpha"));
    }

    #[test]
    fn unreachable_destination_keeps_envelope_pending_and_retry_completes() {
        let (_ga, up) = workspace("alpha");
        let (_gb, down) = workspace("beta");
        let envelope = publish_delivery(&up, "0.1.0", Some("retry note".into()), &[], PublishOptions::default()).unwrap();

        let ghost = RouteDestination {
            root: up.root().join("no-such-workspace"),
            team_id: "team-1".into(),
            team_name: "t".into(),
        };
        let outcome = route_delivery(
            &up,
            "0.1.0",
            &envelope.id,
            &[dest(&down, "t"), ghost.clone()],
            RouteOptions::default(),
        )
        .unwrap();
        assert_eq!(outcome.delivered, vec!["beta".to_string()]);
        assert_eq!(outcome.failed.len(), 1);
        assert!(!outcome.outbox_cleared, "a failed destination keeps the envelope pending");
        assert!(!ghost.root.join(".nextup").exists(), "routing never scaffolds a bogus root");
        assert_eq!(list_deliveries(&up, DeliveryBox::Outbox, NoteDetail::Full).unwrap().len(), 1);

        // Retry to the good destination only: idempotent, then the move completes.
        let retry =
            route_delivery(&up, "0.1.0", &envelope.id, &[dest(&down, "t")], RouteOptions::default())
                .unwrap();
        assert_eq!(retry.already_delivered, vec!["beta".to_string()]);
        assert!(retry.delivered.is_empty());
        assert!(retry.outbox_cleared);
        assert!(list_deliveries(&up, DeliveryBox::Outbox, NoteDetail::Full).unwrap().is_empty());
        // No duplicate audit lines from the retry.
        let down_log = Ledger::new(down.ledger_file())
            .recent_of_kind(LedgerKind::DeliveryReceived, 5)
            .unwrap();
        assert_eq!(down_log.len(), 1);
        assert_eq!(
            Ledger::new(up.ledger_file())
                .recent_of_kind(LedgerKind::DeliveryRouted, 5)
                .unwrap()
                .len(),
            1
        );
    }

    /// Files from inside the workspace keep the layout they had there, all the
    /// way into the downstream inbox.
    ///
    /// Two things were wrong with flattening. The spec layer mandates
    /// `specs/<capability>/spec.md`, so delivering two capabilities was not
    /// merely awkward — it was impossible, every attempt colliding on
    /// `spec.md`. And when a delivery did go through, the receiver's files
    /// matched no path the accompanying documents named, with nothing to tell
    /// either side.
    #[test]
    fn attachments_keep_their_workspace_paths_through_routing() {
        let (_ga, up) = workspace("alpha");
        let (_gb, down) = workspace("beta");
        let root = up.root().to_path_buf();
        for cap in ["export-report", "import-csv"] {
            std::fs::create_dir_all(root.join("specs").join(cap)).unwrap();
            std::fs::write(root.join("specs").join(cap).join("spec.md"), cap.as_bytes()).unwrap();
        }

        let envelope = publish_delivery(
            &up,
            "0.1.0",
            Some("two capabilities".into()),
            &[root.join("specs/export-report/spec.md"), root.join("specs/import-csv/spec.md")],
            PublishOptions::default(),
        )
        .unwrap();

        let stored: Vec<&str> =
            envelope.payload.attachments.iter().map(|a| a.stored_path()).collect();
        assert_eq!(stored, ["specs/export-report/spec.md", "specs/import-csv/spec.md"]);
        assert!(
            envelope.payload.attachments.iter().all(|a| a.name == "spec.md"),
            "the name stays the file name; the path is what disambiguates"
        );
        let out_dir = up.outbox_dir().join(&envelope.id);
        assert_eq!(
            std::fs::read(out_dir.join("specs/export-report/spec.md")).unwrap(),
            b"export-report"
        );

        route_delivery(&up, "0.1.0", &envelope.id, &[dest(&down, "t")], RouteOptions::default())
            .unwrap();
        let in_dir = down.inbox_dir().join(&envelope.id);
        assert_eq!(std::fs::read(in_dir.join("specs/import-csv/spec.md")).unwrap(), b"import-csv");
        let received = get_delivery(&down, DeliveryBox::Inbox, &envelope.id).unwrap();
        assert_eq!(
            received.payload.attachments[0].path.as_deref(),
            Some("specs/export-report/spec.md")
        );

        // The doctor must find every one of them where the manifest says, not
        // merely by name.
        let report = crate::workspace::doctor::run_doctor(down.root()).unwrap();
        assert!(
            !report.findings.iter().any(|f| f.check == "delivery_attachment"),
            "{:?}",
            report.findings
        );
    }

    /// Two files may share a name; they may not share a destination. The check
    /// moved from the name to where the bytes land, so same-name files from
    /// different directories now pass and genuine clashes still do not.
    #[test]
    fn attachments_clash_only_when_they_would_land_in_the_same_place() {
        let (_g, paths) = workspace("alpha");
        let outside = tempfile::tempdir().unwrap();
        let a = outside.path().join("report.md");
        let nested = outside.path().join("sub");
        std::fs::write(&a, b"a").unwrap();
        std::fs::create_dir_all(&nested).unwrap();
        let b = nested.join("report.md");
        std::fs::write(&b, b"b").unwrap();

        // Both come from outside the workspace, so neither has a path and both
        // fall back to the same name — still a genuine clash.
        let err = publish_delivery(&paths, "0.1.0", None, &[a, b], PublishOptions::default()).unwrap_err();
        assert_eq!(err.kind(), "invalid_input");
        assert!(err.to_string().contains("same place"), "{err}");
    }

    /// Manifest paths arrive from another workspace, so they are input. A
    /// reader must refuse a traversal rather than resolve it.
    #[test]
    fn envelope_supplied_paths_that_escape_are_refused() {
        let with_path = |p: &str| AttachmentRef {
            name: "spec.md".into(),
            path: Some(p.into()),
            size_bytes: 1,
        };
        for bad in ["../outside.md", "specs/../../outside.md", "/etc/passwd", ""] {
            assert!(with_path(bad).safe_relative().is_err(), "must refuse {bad}");
        }
        assert!(with_path("specs/a/spec.md").safe_relative().is_ok());
        // No path at all is the pre-D86 envelope: the name is the location.
        let flat = AttachmentRef { name: "spec.md".into(), path: None, size_bytes: 1 };
        assert_eq!(flat.safe_relative().unwrap(), Path::new("spec.md"));
    }

    /// Correcting a published delivery must not leave the user guessing which
    /// of two envelopes to send. During the D86 run the only way to say "send
    /// the newer one" was to write it in the note and hope.
    #[test]
    fn a_replacement_marks_the_envelope_it_replaces() {
        let (_g, paths) = workspace("alpha");
        let first = publish_delivery(&paths, "0.1.0", Some("wrong figures".into()), &[], PublishOptions::default()).unwrap();
        let second = publish_delivery(
            &paths,
            "0.1.0",
            Some("corrected figures".into()),
            &[],
            PublishOptions { supersedes: Some(first.id.clone()) },
        )
        .unwrap();

        let rows = list_deliveries(&paths, DeliveryBox::Outbox, NoteDetail::Full).unwrap();
        let old = rows.iter().find(|r| r.id == first.id).unwrap();
        let new = rows.iter().find(|r| r.id == second.id).unwrap();
        assert_eq!(old.superseded_by.as_deref(), Some(second.id.as_str()));
        assert_eq!(new.supersedes.as_deref(), Some(first.id.as_str()));
        assert_eq!(new.superseded_by, None);
        assert_eq!(rows.len(), 2, "nothing is deleted — the user still chooses");

        // The mark is the publisher's own word that this envelope is wrong, so
        // it survives the replacement going away — by being sent, which is the
        // common case, or by being removed, as here. Deleting the correction
        // does not make the original correct again.
        std::fs::remove_file(paths.outbox_dir().join(format!("{}.json", second.id))).unwrap();
        let rows = list_deliveries(&paths, DeliveryBox::Outbox, NoteDetail::Full).unwrap();
        assert_eq!(rows[0].superseded_by.as_deref(), Some(second.id.as_str()));

        // The audit trail keeps the correction even though no file was touched.
        let published = Ledger::new(paths.ledger_file())
            .recent_of_kind(LedgerKind::DeliveryPublished, 5)
            .unwrap();
        assert!(published.iter().any(|e| e.message.contains(&format!("replaces {}", first.id))));
    }

    /// The mark has to outlive the replacement's departure, and that is the
    /// whole reason it is stored rather than derived.
    ///
    /// Deriving it from the rest of the box read well — an envelope is stale
    /// exactly while its replacement is present, nothing to keep in step — but
    /// routing *moves the replacement out of the outbox*. So the moment the
    /// user sent the correction, the wrong envelope went back to looking
    /// perfectly ordinary, and the next glance at the outbox invites exactly
    /// the mistake this feature exists to prevent. Failing open at the
    /// dangerous moment beats any amount of elegance.
    #[test]
    fn the_replacement_mark_outlives_sending_the_replacement() {
        let (_ga, up) = workspace("alpha");
        let (_gb, down) = workspace("beta");
        let first = publish_delivery(&up, "0.1.0", Some("wrong".into()), &[], PublishOptions::default()).unwrap();
        let second = publish_delivery(
            &up,
            "0.1.0",
            Some("right".into()),
            &[],
            PublishOptions { supersedes: Some(first.id.clone()) },
        )
        .unwrap();

        route_delivery(&up, "0.1.0", &second.id, &[dest(&down, "t")], RouteOptions::default())
            .unwrap();

        let rows = list_deliveries(&up, DeliveryBox::Outbox, NoteDetail::Full).unwrap();
        assert_eq!(rows.len(), 1, "only the superseded original is left");
        assert_eq!(
            rows[0].superseded_by.as_deref(),
            Some(second.id.as_str()),
            "the replacement has been sent and is gone — the warning must remain"
        );
    }

    /// Superseding is only honest while the predecessor is still unsent —
    /// once routed, the downstream copy is beyond recall and claiming
    /// otherwise would be a lie the sender acts on.
    #[test]
    fn superseding_something_that_is_not_in_the_outbox_is_refused() {
        let (_ga, up) = workspace("alpha");
        let (_gb, down) = workspace("beta");
        let sent = publish_delivery(&up, "0.1.0", Some("gone".into()), &[], PublishOptions::default()).unwrap();
        route_delivery(&up, "0.1.0", &sent.id, &[dest(&down, "t")], RouteOptions::default())
            .unwrap();

        let err = publish_delivery(
            &up,
            "0.1.0",
            Some("too late".into()),
            &[],
            PublishOptions { supersedes: Some(sent.id.clone()) },
        )
        .unwrap_err();
        assert_eq!(err.kind(), "invalid_input");
        assert!(err.to_string().contains("cannot be recalled"), "{err}");
        assert!(
            list_deliveries(&up, DeliveryBox::Outbox, NoteDetail::Full).unwrap().is_empty(),
            "a refused publish writes nothing"
        );
    }

    #[test]
    fn auto_routing_marks_both_ledgers() {
        let (_ga, up) = workspace("alpha");
        let (_gb, down) = workspace("beta");
        let envelope = publish_delivery(&up, "0.1.0", Some("auto note".into()), &[], PublishOptions::default()).unwrap();

        route_delivery(
            &up,
            "0.1.0",
            &envelope.id,
            &[dest(&down, "t")],
            RouteOptions { auto: true, keep_pending: false },
        )
        .unwrap();
        let up_log =
            Ledger::new(up.ledger_file()).recent_of_kind(LedgerKind::DeliveryRouted, 5).unwrap();
        assert!(up_log[0].message.ends_with(" (auto)"));
        let down_log = Ledger::new(down.ledger_file())
            .recent_of_kind(LedgerKind::DeliveryReceived, 5)
            .unwrap();
        assert!(down_log[0].message.ends_with(" (auto)"));
    }

    #[test]
    fn keep_pending_leaves_the_outbox_original_for_manual_edges() {
        let (_ga, up) = workspace("alpha");
        let (_gb, down) = workspace("beta");
        let envelope = publish_delivery(&up, "0.1.0", Some("partial note".into()), &[], PublishOptions::default()).unwrap();

        // Auto-routing that covers only part of the edge fan-out must not
        // consume the envelope — the manual edges still need it.
        let outcome = route_delivery(
            &up,
            "0.1.0",
            &envelope.id,
            &[dest(&down, "t")],
            RouteOptions { auto: true, keep_pending: true },
        )
        .unwrap();
        assert_eq!(outcome.delivered, vec!["beta".to_string()]);
        assert!(!outcome.outbox_cleared);
        assert_eq!(list_deliveries(&up, DeliveryBox::Outbox, NoteDetail::Full).unwrap().len(), 1);

        // The later manual send completes the move; the destination that
        // already has the envelope is skipped, not re-delivered.
        let manual =
            route_delivery(&up, "0.1.0", &envelope.id, &[dest(&down, "t")], RouteOptions::default())
                .unwrap();
        assert_eq!(manual.already_delivered, vec!["beta".to_string()]);
        assert!(manual.outbox_cleared);
        assert!(list_deliveries(&up, DeliveryBox::Outbox, NoteDetail::Full).unwrap().is_empty());
        let down_log = Ledger::new(down.ledger_file())
            .recent_of_kind(LedgerKind::DeliveryReceived, 5)
            .unwrap();
        assert_eq!(down_log.len(), 1, "the idempotent skip leaves no duplicate audit line");
    }

    #[test]
    fn ids_are_validated_and_missing_envelopes_are_not_found() {
        let (_g, paths) = workspace("alpha");
        let traversal = get_delivery(&paths, DeliveryBox::Inbox, "..\\..\\context");
        assert_eq!(traversal.unwrap_err().kind(), "invalid_input");
        let missing = get_delivery(&paths, DeliveryBox::Inbox, &uuid_v4());
        assert_eq!(missing.unwrap_err().kind(), "not_found");
        let route =
            route_delivery(&paths, "0.1.0", &uuid_v4(), &[dest(&paths, "t")], RouteOptions::default());
        assert_eq!(route.unwrap_err().kind(), "not_found");
    }

    #[test]
    fn listing_skips_torn_envelopes_and_sorts_newest_first() {
        let (_g, paths) = workspace("alpha");
        let first = publish_delivery(&paths, "0.1.0", Some("older".into()), &[], PublishOptions::default()).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(1100)); // second-resolution stamps
        let second = publish_delivery(&paths, "0.1.0", Some("newer".into()), &[], PublishOptions::default()).unwrap();
        std::fs::write(paths.outbox_dir().join("torn.json"), b"{not json").unwrap();

        let rows = list_deliveries(&paths, DeliveryBox::Outbox, NoteDetail::Full).unwrap();
        assert_eq!(rows.len(), 2, "torn file skipped, healthy ones listed");
        assert_eq!(rows[0].id, second.id);
        assert_eq!(rows[1].id, first.id);
    }

    /// Asking what is in a box must not cost the whole of it. Notes are
    /// unbounded prose, and a reader who only wants the manifest was
    /// previously handed every word of every envelope.
    #[test]
    fn brief_listing_clamps_notes_and_says_so() {
        let (_g, paths) = workspace("alpha");
        // `publish_delivery` trims the note, so build one that survives it.
        let long = format!("headline\n{}", "detail ".repeat(2000)).trim().to_string();
        publish_delivery(&paths, "0.1.0", Some(long.clone()), &[], PublishOptions::default()).unwrap();
        publish_delivery(&paths, "0.1.0", Some("short one".into()), &[], PublishOptions::default()).unwrap();

        let full = list_deliveries(&paths, DeliveryBox::Outbox, NoteDetail::Full).unwrap();
        assert!(full.iter().any(|r| r.note.as_deref() == Some(long.as_str())));
        assert!(full.iter().all(|r| !r.note_truncated));

        let brief = list_deliveries(&paths, DeliveryBox::Outbox, NoteDetail::Brief).unwrap();
        assert_eq!(brief.len(), full.len(), "brief hides text, never envelopes");
        let clamped = brief.iter().find(|r| r.note_truncated).expect("the long note is marked");
        assert_eq!(clamped.note.as_deref(), Some("headline"));
        // A note that fits is untouched and unmarked — otherwise every reader
        // would go fetch a full copy that says the same thing.
        let intact = brief.iter().find(|r| !r.note_truncated).unwrap();
        assert_eq!(intact.note.as_deref(), Some("short one"));
        // Everything except the note is identical between the two modes.
        let ids = |rows: &[DeliverySummary]| rows.iter().map(|r| r.id.clone()).collect::<Vec<_>>();
        assert_eq!(ids(&brief), ids(&full));
    }

    #[test]
    fn publish_carries_attachments_into_the_outbox() {
        let (_g, paths) = workspace("alpha");
        let src = tempfile::tempdir().unwrap();
        let a = src.path().join("report.md");
        let b = src.path().join("data.csv");
        std::fs::write(&a, b"hello report").unwrap();
        std::fs::write(&b, b"1,2,3").unwrap();

        let envelope =
            publish_delivery(&paths, "0.1.0", Some("with files".into()), &[a, b], PublishOptions::default()).unwrap();

        assert_eq!(envelope.payload.attachments.len(), 2);
        assert_eq!(envelope.payload.attachments[0].name, "report.md");
        assert_eq!(envelope.payload.attachments[0].size_bytes, 12);
        assert_eq!(envelope.payload.attachments[1].name, "data.csv");

        // Bytes on disk in the envelope's sibling directory.
        let dir = paths.outbox_dir().join(&envelope.id);
        assert_eq!(std::fs::read(dir.join("report.md")).unwrap(), b"hello report");
        assert_eq!(std::fs::read(dir.join("data.csv")).unwrap(), b"1,2,3");

        // The listing surfaces the count without loading the payload.
        let listed = list_deliveries(&paths, DeliveryBox::Outbox, NoteDetail::Full).unwrap();
        assert_eq!(listed[0].attachment_count, 2);
    }

    #[test]
    fn route_carries_attachment_bytes_and_clears_both_sides() {
        let (_ga, up) = workspace("alpha");
        let (_gb, down) = workspace("beta");
        let src = tempfile::tempdir().unwrap();
        let f = src.path().join("bundle.zip");
        std::fs::write(&f, b"PK\x03\x04zip-bytes").unwrap();

        let envelope = publish_delivery(&up, "0.1.0", None, &[f], PublishOptions::default()).unwrap();
        let outcome =
            route_delivery(&up, "0.1.0", &envelope.id, &[dest(&down, "t")], RouteOptions::default())
                .unwrap();
        assert!(outcome.outbox_cleared);

        // Inbox has both the manifest and the actual bytes.
        let received = get_delivery(&down, DeliveryBox::Inbox, &envelope.id).unwrap();
        assert_eq!(received.payload.attachments.len(), 1);
        assert_eq!(received.payload.attachments[0].name, "bundle.zip");
        let inbox_file = down.inbox_dir().join(&envelope.id).join("bundle.zip");
        assert_eq!(std::fs::read(&inbox_file).unwrap(), b"PK\x03\x04zip-bytes");

        // The outbox original — JSON and its attachment directory — is gone.
        assert!(list_deliveries(&up, DeliveryBox::Outbox, NoteDetail::Full).unwrap().is_empty());
        assert!(
            !up.outbox_dir().join(&envelope.id).exists(),
            "outbox attachment dir removed with the completed move"
        );
    }

    #[test]
    fn partial_fail_keeps_the_outbox_attachment_dir() {
        let (_ga, up) = workspace("alpha");
        let (_gb, down) = workspace("beta");
        let src = tempfile::tempdir().unwrap();
        let f = src.path().join("notes.txt");
        std::fs::write(&f, b"notes").unwrap();
        let envelope = publish_delivery(&up, "0.1.0", None, &[f], PublishOptions::default()).unwrap();

        let ghost = RouteDestination {
            root: up.root().join("no-such-workspace"),
            team_id: "team-1".into(),
            team_name: "t".into(),
        };
        let outcome = route_delivery(
            &up,
            "0.1.0",
            &envelope.id,
            &[dest(&down, "t"), ghost],
            RouteOptions::default(),
        )
        .unwrap();
        assert!(!outcome.outbox_cleared);
        assert!(
            up.outbox_dir().join(&envelope.id).join("notes.txt").is_file(),
            "a failed destination keeps the outbox bytes for retry"
        );
    }

    #[test]
    fn already_delivered_does_not_reclobber_inbox_attachments() {
        let (_ga, up) = workspace("alpha");
        let (_gb, down) = workspace("beta");
        let src = tempfile::tempdir().unwrap();
        let f = src.path().join("x.bin");
        std::fs::write(&f, b"original").unwrap();
        let envelope = publish_delivery(&up, "0.1.0", None, &[f], PublishOptions::default()).unwrap();

        // keep_pending leaves the outbox original so a second route runs.
        route_delivery(
            &up,
            "0.1.0",
            &envelope.id,
            &[dest(&down, "t")],
            RouteOptions { auto: true, keep_pending: true },
        )
        .unwrap();
        let inbox_file = down.inbox_dir().join(&envelope.id).join("x.bin");
        std::fs::write(&inbox_file, b"USER-EDIT").unwrap();

        // The second route sees the inbox envelope already present and skips —
        // the edited attachment is left untouched, not re-copied from outbox.
        let retry =
            route_delivery(&up, "0.1.0", &envelope.id, &[dest(&down, "t")], RouteOptions::default())
                .unwrap();
        assert_eq!(retry.already_delivered, vec!["beta".to_string()]);
        assert_eq!(
            std::fs::read(&inbox_file).unwrap(),
            b"USER-EDIT",
            "the idempotent skip does not re-copy the attachment directory"
        );
    }

    #[test]
    fn invalid_attachments_are_rejected_without_residue() {
        let (_g, paths) = workspace("alpha");
        let src = tempfile::tempdir().unwrap();

        // Missing file.
        let err = publish_delivery(&paths, "0.1.0", None, &[src.path().join("ghost.txt")], PublishOptions::default())
            .unwrap_err();
        assert_eq!(err.kind(), "invalid_input");

        // Two different files sharing one base name — collide in the flat dir.
        let d1 = src.path().join("a");
        let d2 = src.path().join("b");
        std::fs::create_dir_all(&d1).unwrap();
        std::fs::create_dir_all(&d2).unwrap();
        let p1 = d1.join("dup.txt");
        let p2 = d2.join("dup.txt");
        std::fs::write(&p1, b"1").unwrap();
        std::fs::write(&p2, b"2").unwrap();
        assert_eq!(
            publish_delivery(&paths, "0.1.0", None, &[p1, p2], PublishOptions::default()).unwrap_err().kind(),
            "invalid_input"
        );

        // Names differing only in case collide on a case-insensitive downstream
        // filesystem — rejected up front, not silently overwritten.
        let up1 = d1.join("Case.txt");
        let up2 = d2.join("case.txt");
        std::fs::write(&up1, b"A").unwrap();
        std::fs::write(&up2, b"B").unwrap();
        assert_eq!(
            publish_delivery(&paths, "0.1.0", None, &[up1, up2], PublishOptions::default()).unwrap_err().kind(),
            "invalid_input"
        );

        // Over the count cap.
        let mut many = Vec::new();
        for i in 0..=MAX_ATTACHMENTS {
            let p = src.path().join(format!("f{i}.txt"));
            std::fs::write(&p, b"x").unwrap();
            many.push(p);
        }
        assert_eq!(
            publish_delivery(&paths, "0.1.0", None, &many, PublishOptions::default()).unwrap_err().kind(),
            "invalid_input"
        );

        // No envelope and no orphan attachment directory survive any rejection
        // (validation runs before the outbox dir is even created).
        assert!(list_deliveries(&paths, DeliveryBox::Outbox, NoteDetail::Full).unwrap().is_empty());
        let dirs: Vec<_> = std::fs::read_dir(paths.outbox_dir())
            .map(|rd| rd.flatten().filter(|e| e.path().is_dir()).collect())
            .unwrap_or_default();
        assert!(dirs.is_empty(), "a rejected batch leaves no attachment directory");
    }

    #[test]
    fn resolve_workspace_relative_rejects_escapes() {
        let (_g, paths) = workspace("alpha");
        let rel = "inside.txt";
        std::fs::write(paths.root().join(rel), b"ok").unwrap();
        assert!(resolve_workspace_relative(&paths, rel).unwrap().ends_with(rel));

        assert_eq!(
            resolve_workspace_relative(&paths, "../secret").unwrap_err().kind(),
            "invalid_input"
        );
        #[cfg(windows)]
        let abs = "C:\\Windows\\system32";
        #[cfg(not(windows))]
        let abs = "/etc/passwd";
        assert_eq!(resolve_workspace_relative(&paths, abs).unwrap_err().kind(), "invalid_input");
        assert_eq!(
            resolve_workspace_relative(&paths, "no/such/file").unwrap_err().kind(),
            "invalid_input"
        );
    }
}
