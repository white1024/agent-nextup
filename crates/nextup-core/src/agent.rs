//! Agent access control for the hub MCP server (nextup_docs/06, D14).
//!
//! Agent NextUp is the management hub; execution belongs to external professional
//! agents (Claude Code etc.) which reach the hub through the `nextup-mcp`
//! stdio binary. This module owns the per-workspace authorization registry
//! (`.nextup/agent_access.json`) and the single [`authorize`] gate the server
//! runs before touching any core operation.
//!
//! Two tiers, mirroring the client-side precedent in `mcp::config` where
//! discovery is always allowed:
//! - **Read tier** — observe-only tools, always allowed while access is
//!   enabled (`build_index` counts as read: it only writes the rebuildable
//!   `.nextup/index.sqlite` derivative).
//! - **Write tier** — an explicit per-tool allowlist. The *mechanism* stays
//!   default-deny (a name absent from the list is refused), but a workspace
//!   no longer starts empty: `initialize_project` applies
//!   [`DEFAULT_GRANTED_TOOLS`] (D63) so an agent can record and move work the
//!   moment it connects, while [`GUARDED_TOOLS`] stay off until a human turns
//!   them on. Gate overrides and manual confirmations are not tools at all:
//!   agents may advance work, never bypass a gate.

use std::path::Path;
use std::sync::LazyLock;

use serde::{Deserialize, Serialize};

use crate::error::{NextUpError, Result};
use crate::workspace::atomic::atomic_write_json;
use crate::workspace::layout::WorkspacePaths;
use crate::workspace::lock::with_mutation_lock;
use crate::workspace::modules::{WorkspaceModules, MODULE_COLLAB, MODULE_SPECS, MODULE_TEAM};

pub const AGENT_ACCESS_SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToolTier {
    Read,
    Write,
}

/// Tier, plus everything that used to live in a separate parallel list: which
/// semantic group the GUI files a write tool under, and whether day one grants
/// it (D63).
///
/// Modelling these as one enum makes four former invariants *unrepresentable*
/// rather than merely tested: a write tool cannot appear in both the granted
/// and the guarded list, a guarded tool cannot omit its reason, a granted tool
/// cannot carry one, and a read tool cannot have a group. The tests that used
/// to police those drifts are kept — they now assert the derived views.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Access {
    /// Read tier — observe-only, always allowed while access is enabled.
    /// Never authorized per-tool, so it has neither group nor grant state.
    Read,
    /// Write tier, granted on day one so an agent can record and move work the
    /// moment it connects.
    Granted { group: &'static str },
    /// Write tier, withheld from the day-one grant. Every one of these hands an
    /// agent a judgement call the harness exists to keep with the human, and
    /// `reason` is the stable slug the GUI maps to its own copy — it sits on the
    /// same row as the decision so "why is this one off?" cannot drift away from
    /// the rule that turned it off.
    Guarded { group: &'static str, reason: &'static str },
}

/// One row per hub tool — the single registry the entire tool surface derives
/// from. Adding a tool is **one row here** plus its `#[tool]` method on the hub;
/// every list below ([`READ_TOOLS`], [`WRITE_TOOLS`], [`DEFAULT_GRANTED_TOOLS`],
/// [`GUARDED_TOOLS`]) and every lookup ([`tool_tier`], [`tool_module`],
/// [`tool_group`], [`guarded_reason`]) is a view over this table. A tool absent
/// from it fails `authorize` with `NotFound`.
#[derive(Debug, Clone, Copy)]
pub struct ToolMeta {
    pub name: &'static str,
    /// Which capability module the tool belongs to; `None` means universal.
    /// Every exposure surface — the hub's tools/list, the GUI catalog,
    /// select-all — filters by this, so a workspace with the module off never
    /// advertises the tool at all. The ops-layer `require_module` guard stays
    /// as defense in depth for mid-session toggles.
    pub module: Option<&'static str>,
    pub access: Access,
}

const fn read(name: &'static str, module: Option<&'static str>) -> ToolMeta {
    ToolMeta { name, module, access: Access::Read }
}

const fn granted(name: &'static str, module: Option<&'static str>, group: &'static str) -> ToolMeta {
    ToolMeta { name, module, access: Access::Granted { group } }
}

const fn guarded(
    name: &'static str,
    module: Option<&'static str>,
    group: &'static str,
    reason: &'static str,
) -> ToolMeta {
    ToolMeta { name, module, access: Access::Guarded { group, reason } }
}

/// The hub tool registry. **Row order is load-bearing**: [`READ_TOOLS`] and
/// [`WRITE_TOOLS`] derive in table order and both are substituted into the
/// shipped guide section 9 (`render_guide`), so reordering a row rewrites every
/// workspace's material and drops them all into the D38 upgrade state. Append,
/// do not reshuffle.
pub const TOOLS: &[ToolMeta] = &[
    // Read tier.
    read("workspace_status", None),
    read("list_tasks", None),
    read("get_task", None),
    read("workflow_status", None),
    read("search_workspace", None),
    // Counts as read: it only writes the rebuildable `.nextup/index.sqlite`.
    read("build_index", None),
    read("workspace_doctor", None),
    read("post_mortem_candidates", None),
    read("list_deliveries", Some(MODULE_TEAM)),
    read("get_delivery", Some(MODULE_TEAM)),
    read("list_specs", Some(MODULE_SPECS)),
    read("get_spec", Some(MODULE_SPECS)),
    read("validate_task_specs", Some(MODULE_SPECS)),
    // Write tier.
    granted("create_task", None, "tasks"),
    granted("update_task_status", None, "tasks"),
    guarded("set_task_verification", None, "tasks", "self_verify"),
    granted("claim_task", Some(MODULE_COLLAB), "collab"),
    granted("assign_task", Some(MODULE_COLLAB), "collab"),
    granted("record_decision", None, "knowledge"),
    granted("record_note", None, "knowledge"),
    granted("record_progress", None, "knowledge"),
    granted("record_rejected", None, "knowledge"),
    guarded("advance_phase", None, "flow", "gate_bypass"),
    granted("add_milestone", None, "flow"),
    granted("set_milestone_done", None, "flow"),
    guarded("set_milestone_verified", None, "flow", "self_verify"),
    granted("record_lesson", None, "knowledge"),
    granted("record_lesson_fired", None, "knowledge"),
    granted("archive_stale_lessons", None, "knowledge"),
    granted("generate_handoff", None, "maintenance"),
    guarded("upgrade_workspace_assets", None, "maintenance", "asset_rewrite"),
    guarded("publish_delivery", Some(MODULE_TEAM), "team", "cross_workspace"),
];

/// Display order of the write-tier semantic groups (D39). Presentation
/// metadata only — `authorize` stays strictly per-tool; groups exist so the
/// GUI catalog offers capability-level switches (a non-engineer grants a
/// human-readable label rather than `record_lesson_fired`). Not folded into
/// [`TOOLS`] because it orders the *groups*, which no single tool row owns.
pub const TOOL_GROUPS: &[&str] = &["tasks", "collab", "team", "knowledge", "flow", "maintenance"];

/// Display order of the guard reasons, and the sort key for [`GUARDED_TOOLS`].
///
/// This exists because the guarded list was never in `WRITE_TOOLS` order — it
/// was hand-grouped by reason (write-tier positions 2, 12, 9, 18, 17), a rule
/// the old doc comment narrated in prose ("declaring its own work verified,
/// moving a phase past its gate, publishing outside this workspace, or
/// rewriting the workspace's own assets") with nothing enforcing it. Deriving
/// the list in plain table order would therefore have silently reordered the
/// shipped guide, so the rule is written down here instead of left in prose.
pub const GUARD_REASONS: &[&str] =
    &["self_verify", "gate_bypass", "cross_workspace", "asset_rewrite"];

fn names_where(pred: impl Fn(&ToolMeta) -> bool) -> Vec<&'static str> {
    TOOLS.iter().filter(|t| pred(t)).map(|t| t.name).collect()
}

fn meta(tool: &str) -> Option<&'static ToolMeta> {
    TOOLS.iter().find(|t| t.name == tool)
}

/// Read-tier names, in table order.
pub static READ_TOOLS: LazyLock<Vec<&'static str>> =
    LazyLock::new(|| names_where(|t| matches!(t.access, Access::Read)));

/// Write-tier names, in table order.
pub static WRITE_TOOLS: LazyLock<Vec<&'static str>> =
    LazyLock::new(|| names_where(|t| !matches!(t.access, Access::Read)));

/// The write tools a new workspace grants on day one (D63), in table order.
///
/// This is a *default*, never a tier: `authorize` treats all write tools alike
/// and the catalog can grant or revoke any of them.
pub static DEFAULT_GRANTED_TOOLS: LazyLock<Vec<&'static str>> =
    LazyLock::new(|| names_where(|t| matches!(t.access, Access::Granted { .. })));

/// Write tools withheld from the day-one grant (D63), grouped by reason in
/// [`GUARD_REASONS`] order — see that constant for why the order is explicit.
pub static GUARDED_TOOLS: LazyLock<Vec<&'static str>> = LazyLock::new(|| {
    GUARD_REASONS
        .iter()
        .flat_map(|r| {
            names_where(move |t| match t.access {
                Access::Guarded { reason, .. } => reason == *r,
                _ => false,
            })
        })
        .collect()
});

pub fn tool_tier(tool: &str) -> Option<ToolTier> {
    meta(tool).map(|t| match t.access {
        Access::Read => ToolTier::Read,
        _ => ToolTier::Write,
    })
}

/// Which capability module a tool belongs to; `None` means universal (or that
/// the name is not registered at all — callers reach this only after
/// `tool_tier` has vouched for it).
pub fn tool_module(tool: &str) -> Option<&'static str> {
    meta(tool).and_then(|t| t.module)
}

/// Which semantic group a write-tier tool belongs to. Read-tier tools have
/// no group — always allowed, never need a switch.
pub fn tool_group(tool: &str) -> Option<&'static str> {
    match meta(tool)?.access {
        Access::Read => None,
        Access::Granted { group } | Access::Guarded { group, .. } => Some(group),
    }
}

/// Why a guarded tool is off by default; `None` for everything else.
pub fn guarded_reason(tool: &str) -> Option<&'static str> {
    match meta(tool)?.access {
        Access::Guarded { reason, .. } => Some(reason),
        _ => None,
    }
}

/// The day-one grant filtered to what this workspace actually exposes — a
/// module-bound tool whose module is off must not be written into the
/// allowlist (`set_tools_allowed` would refuse it, and a grant for a tool the
/// hub never advertises only misleads audits).
pub fn default_granted_tools(modules: &WorkspaceModules) -> Vec<&'static str> {
    exposed_write_tools(modules)
        .into_iter()
        .filter(|t| DEFAULT_GRANTED_TOOLS.contains(t))
        .collect()
}

/// The write tools this workspace actually exposes: the registry minus tools
/// whose module is off.
pub fn exposed_write_tools(modules: &WorkspaceModules) -> Vec<&'static str> {
    WRITE_TOOLS
        .iter()
        .copied()
        .filter(|t| tool_module(t).is_none_or(|m| modules.is_enabled(m)))
        .collect()
}

/// Same exposure rule for the read tier — the team module contributes read
/// tools (D48), so "read tier is all universal" stopped being true. Read
/// tools still never need authorization; exposure only decides whether they
/// are advertised at all.
pub fn exposed_read_tools(modules: &WorkspaceModules) -> Vec<&'static str> {
    READ_TOOLS
        .iter()
        .copied()
        .filter(|t| tool_module(t).is_none_or(|m| modules.is_enabled(m)))
        .collect()
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentAccess {
    pub schema_version: u32,
    /// Master switch. `false` shuts the hub to agents entirely — even the
    /// read tier — so the user can cut the line with one click.
    pub enabled: bool,
    /// Write-tier allowlist — default deny, same contract as
    /// `McpServerEntry::allowed_tools`.
    #[serde(default)]
    pub allowed_tools: Vec<String>,
}

impl Default for AgentAccess {
    /// A missing file means this default: read tier open, write tier shut.
    /// Existing workspaces therefore need no migration.
    fn default() -> Self {
        Self {
            schema_version: AGENT_ACCESS_SCHEMA_VERSION,
            enabled: true,
            allowed_tools: Vec::new(),
        }
    }
}

impl AgentAccess {
    pub fn tool_allowed(&self, tool: &str) -> bool {
        self.allowed_tools.iter().any(|t| t == tool)
    }
}

/// The single gate: runs before any core operation is touched, so a denied
/// call never has side effects. Denials are still ledgered by the server —
/// inbound calls from an external agent deserve a complete audit trail
/// (deliberately stricter than the outbound client in mcp::ops).
pub fn authorize(access: &AgentAccess, tool: &str) -> Result<()> {
    if !access.enabled {
        return Err(NextUpError::Unauthorized(
            "agent access to this workspace is disabled — enable it in the Agent NextUp tool catalog"
                .into(),
        ));
    }
    match tool_tier(tool) {
        Some(ToolTier::Read) => Ok(()),
        Some(ToolTier::Write) if access.tool_allowed(tool) => Ok(()),
        Some(ToolTier::Write) => Err(NextUpError::Unauthorized(format!(
            "tool '{tool}' is not authorized — allow it in the Agent NextUp tool catalog first"
        ))),
        None => Err(NextUpError::NotFound(format!("unknown hub tool '{tool}'"))),
    }
}

pub fn load_access(path: &Path) -> Result<AgentAccess> {
    if !path.is_file() {
        return Ok(AgentAccess::default());
    }
    crate::workspace::atomic::read_json_file(path)
}

pub fn save_access(path: &Path, access: &AgentAccess) -> Result<()> {
    atomic_write_json(path, access)
}

pub fn get_access(paths: &WorkspacePaths) -> Result<AgentAccess> {
    load_access(&paths.agent_access_file())
}

pub fn set_enabled(paths: &WorkspacePaths, enabled: bool) -> Result<AgentAccess> {
    with_mutation_lock(paths, || {
        let mut access = load_access(&paths.agent_access_file())?;
        access.enabled = enabled;
        save_access(&paths.agent_access_file(), &access)?;
        Ok(access)
    })
}

/// Toggle one write-tier tool. Read-tier names are rejected: they are always
/// allowed by design and a stale allowlist entry would only mislead audits.
/// Granting a module-bound tool needs its module on — the catalog hides
/// unexposed tools, so such a grant is a stale GUI or a typo'd script.
/// Revoking is always accepted (cleanup of grants that predate a module
/// being switched off).
pub fn set_tool_allowed(paths: &WorkspacePaths, tool: &str, allowed: bool) -> Result<AgentAccess> {
    match tool_tier(tool) {
        Some(ToolTier::Write) => {}
        Some(ToolTier::Read) => {
            return Err(NextUpError::InvalidInput(format!(
                "'{tool}' is a read-tier tool and is always allowed"
            )))
        }
        None => return Err(NextUpError::NotFound(format!("unknown hub tool '{tool}'"))),
    }
    with_mutation_lock(paths, || {
        if allowed {
            if let Some(module) = tool_module(tool) {
                crate::workspace::modules::require_module(paths, module)?;
            }
        }
        let mut access = load_access(&paths.agent_access_file())?;
        access.allowed_tools.retain(|t| t != tool);
        if allowed {
            access.allowed_tools.push(tool.to_string());
        }
        save_access(&paths.agent_access_file(), &access)?;
        Ok(access)
    })
}

/// Toggle several write-tier tools in one lock and one file write (the GUI
/// group switch, D39). Per-tool rules are identical to [`set_tool_allowed`]:
/// read-tier or unknown names are rejected, granting a module-bound tool
/// needs its module on, revoking is always accepted. All names are validated
/// before anything mutates, so one bad name means nothing changes.
pub fn set_tools_allowed(
    paths: &WorkspacePaths,
    tools: &[String],
    allowed: bool,
) -> Result<AgentAccess> {
    for tool in tools {
        match tool_tier(tool) {
            Some(ToolTier::Write) => {}
            Some(ToolTier::Read) => {
                return Err(NextUpError::InvalidInput(format!(
                    "'{tool}' is a read-tier tool and is always allowed"
                )))
            }
            None => return Err(NextUpError::NotFound(format!("unknown hub tool '{tool}'"))),
        }
    }
    with_mutation_lock(paths, || {
        if allowed {
            for tool in tools {
                if let Some(module) = tool_module(tool) {
                    crate::workspace::modules::require_module(paths, module)?;
                }
            }
        }
        let mut access = load_access(&paths.agent_access_file())?;
        access.allowed_tools.retain(|t| !tools.iter().any(|x| x == t));
        if allowed {
            access.allowed_tools.extend(tools.iter().cloned());
        }
        save_access(&paths.agent_access_file(), &access)?;
        Ok(access)
    })
}

/// Allow or deny every *exposed* write-tier tool at once (the GUI "select
/// all" box). Granting rewrites the list to exactly the exposed set — no
/// duplicates, no stale names, and module-bound tools whose module is off
/// stay out (a pre-existing grant for one is dropped; re-enabling the module
/// means re-granting, which keeps the allowlist canonical). Clearing empties
/// it. Read-tier tools never enter the list — always allowed by design.
pub fn set_all_tools_allowed(paths: &WorkspacePaths, allowed: bool) -> Result<AgentAccess> {
    with_mutation_lock(paths, || {
        let mut access = load_access(&paths.agent_access_file())?;
        access.allowed_tools = if allowed {
            let modules = crate::workspace::modules::get_modules(paths)?;
            exposed_write_tools(&modules).iter().map(|t| t.to_string()).collect()
        } else {
            Vec::new()
        };
        save_access(&paths.agent_access_file(), &access)?;
        Ok(access)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn read_tier_is_open_by_default_write_tier_is_shut() {
        let access = AgentAccess::default();
        assert!(authorize(&access, "workspace_status").is_ok());
        assert!(authorize(&access, "search_workspace").is_ok());
        assert_eq!(authorize(&access, "create_task").unwrap_err().kind(), "unauthorized");
        assert_eq!(authorize(&access, "advance_phase").unwrap_err().kind(), "unauthorized");
    }

    #[test]
    fn disabled_shuts_everything_including_reads() {
        let access = AgentAccess { enabled: false, ..AgentAccess::default() };
        assert_eq!(authorize(&access, "workspace_status").unwrap_err().kind(), "unauthorized");
        assert_eq!(authorize(&access, "create_task").unwrap_err().kind(), "unauthorized");
    }

    #[test]
    fn allowlisted_write_tool_passes() {
        let mut access = AgentAccess::default();
        access.allowed_tools.push("create_task".into());
        assert!(authorize(&access, "create_task").is_ok());
        assert_eq!(authorize(&access, "update_task_status").unwrap_err().kind(), "unauthorized");
    }

    #[test]
    fn unknown_tool_is_not_found() {
        let access = AgentAccess::default();
        assert_eq!(authorize(&access, "drop_database").unwrap_err().kind(), "not_found");
    }

    /// Table-level guards for the things deriving the four views cannot make
    /// impossible on its own. Each of these failures is silent without a test:
    /// the build stays green and only the *shipped* material changes.
    #[test]
    fn the_registry_table_is_well_formed() {
        // A duplicate row would shadow silently: `meta` finds the first, while
        // the derived lists would carry the name twice into guide section 9.
        let mut seen = std::collections::HashSet::new();
        for t in TOOLS {
            assert!(seen.insert(t.name), "tool '{}' is registered twice", t.name);
        }

        // The two tiers partition the table — no row can be missing from both.
        assert_eq!(
            READ_TOOLS.len() + WRITE_TOOLS.len(),
            TOOLS.len(),
            "every row must derive into exactly one tier"
        );

        // GUARD_REASONS is a *filter*, so a guarded tool carrying a reason
        // absent from it would vanish from GUARDED_TOOLS entirely: still
        // withheld from the day-one grant (that derives from the enum), but
        // silently dropped from the shipped guide's guarded list and from
        // every "why is this off?" surface. This is the one failure mode the
        // reason-ordered derivation introduces, so it is pinned here.
        let guarded_rows = TOOLS.iter().filter(|t| matches!(t.access, Access::Guarded { .. }));
        assert_eq!(
            GUARDED_TOOLS.len(),
            guarded_rows.clone().count(),
            "a guarded tool was dropped — its reason is missing from GUARD_REASONS"
        );
        for t in guarded_rows {
            let Access::Guarded { reason, .. } = t.access else { unreachable!() };
            assert!(
                GUARD_REASONS.contains(&reason),
                "tool '{}' states reason '{reason}', which is not in GUARD_REASONS",
                t.name
            );
        }
        for r in GUARD_REASONS {
            assert!(
                GUARDED_TOOLS.iter().any(|t| guarded_reason(t) == Some(r)),
                "guard reason '{r}' has no tools"
            );
        }

    }

    /// The four derived lists, pinned verbatim.
    ///
    /// Order is not an internal detail: `READ_TOOLS`, `WRITE_TOOLS` and
    /// `GUARDED_TOOLS` are substituted straight into the shipped guide section
    /// 9, so reordering a row in [`TOOLS`] rewrites the material in every
    /// existing workspace and drops them all into the D38 upgrade state.
    ///
    /// Nothing else catches that. Every other check — here, in `bootstrap`, in
    /// the hub — asks only whether each tool *appears*, which a reshuffle keeps
    /// true. An "assert positions are increasing" guard cannot work either: the
    /// positions are read from the same table that was reordered, so it holds
    /// by construction. Pinning the output is the only version that fails.
    ///
    /// **When this test fails, that is the signal, not the problem**: you are
    /// changing shipped material. Update the strings deliberately, and expect
    /// every existing workspace to show an asset upgrade.
    #[test]
    fn the_derived_lists_are_pinned() {
        assert_eq!(
            READ_TOOLS.join(" "),
            "workspace_status list_tasks get_task workflow_status search_workspace build_index \
             workspace_doctor post_mortem_candidates list_deliveries get_delivery list_specs \
             get_spec validate_task_specs"
        );
        assert_eq!(
            WRITE_TOOLS.join(" "),
            "create_task update_task_status set_task_verification claim_task assign_task \
             record_decision record_note record_progress record_rejected advance_phase \
             add_milestone set_milestone_done set_milestone_verified record_lesson \
             record_lesson_fired archive_stale_lessons generate_handoff \
             upgrade_workspace_assets publish_delivery"
        );
        assert_eq!(
            DEFAULT_GRANTED_TOOLS.join(" "),
            "create_task update_task_status claim_task assign_task record_decision record_note \
             record_progress record_rejected add_milestone set_milestone_done record_lesson \
             record_lesson_fired archive_stale_lessons generate_handoff"
        );
        // Reason-ordered, not table-ordered — see GUARD_REASONS.
        assert_eq!(
            GUARDED_TOOLS.join(" "),
            "set_task_verification set_milestone_verified advance_phase publish_delivery \
             upgrade_workspace_assets"
        );
    }

    #[test]
    fn every_registered_tool_has_a_tier_and_no_overlap() {
        for t in READ_TOOLS.iter() {
            assert_eq!(tool_tier(t), Some(ToolTier::Read));
            if let Some(m) = tool_module(t) {
                assert!(
                    crate::workspace::modules::KNOWN_MODULES.contains(&m),
                    "read tool '{t}' binds unknown module '{m}'"
                );
            }
        }
        for t in WRITE_TOOLS.iter() {
            assert_eq!(tool_tier(t), Some(ToolTier::Write));
            assert!(!READ_TOOLS.contains(t), "tool '{t}' cannot be in both tiers");
            if let Some(m) = tool_module(t) {
                assert!(
                    crate::workspace::modules::KNOWN_MODULES.contains(&m),
                    "tool '{t}' binds unknown module '{m}'"
                );
            }
        }
    }

    #[test]
    fn every_write_tool_has_a_registered_group_and_no_group_is_empty() {
        for t in WRITE_TOOLS.iter() {
            let g = tool_group(t).unwrap_or_else(|| panic!("write tool '{t}' has no group"));
            assert!(TOOL_GROUPS.contains(&g), "tool '{t}' maps to unknown group '{g}'");
        }
        for t in READ_TOOLS.iter() {
            assert!(tool_group(t).is_none(), "read tool '{t}' must not have a group");
        }
        for g in TOOL_GROUPS {
            assert!(
                WRITE_TOOLS.iter().any(|t| tool_group(t) == Some(g)),
                "group '{g}' has no tools"
            );
        }
    }

    /// The day-one grant and the guarded list must together account for every
    /// write tool, with nothing in both. A tool added to WRITE_TOOLS and to
    /// neither list is the drift this catches: it would be silently withheld
    /// from new workspaces with no stated reason.
    #[test]
    fn every_write_tool_is_granted_or_guarded() {
        for t in WRITE_TOOLS.iter() {
            let granted = DEFAULT_GRANTED_TOOLS.contains(t);
            let guarded = GUARDED_TOOLS.contains(t);
            assert!(
                granted != guarded,
                "write tool '{t}' must be in exactly one of DEFAULT_GRANTED_TOOLS / GUARDED_TOOLS"
            );
        }
        for t in DEFAULT_GRANTED_TOOLS.iter() {
            assert!(WRITE_TOOLS.contains(t), "granted '{t}' is not a write tool");
        }
        for t in GUARDED_TOOLS.iter() {
            assert!(WRITE_TOOLS.contains(t), "guarded '{t}' is not a write tool");
            assert!(guarded_reason(t).is_some(), "guarded '{t}' states no reason");
        }
        // The reason is only meaningful for withheld tools — a granted tool
        // carrying one would render a "why is this off?" note next to an
        // switch that is on.
        for t in DEFAULT_GRANTED_TOOLS.iter() {
            assert!(guarded_reason(t).is_none(), "granted '{t}' must not state a guard reason");
        }
    }

    /// The day-one grant never names a tool the workspace does not expose:
    /// collab is off here, so `claim_task`/`assign_task` stay out even though
    /// both are in DEFAULT_GRANTED_TOOLS.
    #[test]
    fn default_grant_drops_tools_whose_module_is_off() {
        let none = WorkspaceModules::default();
        let granted = default_granted_tools(&none);
        assert!(granted.contains(&"create_task"));
        assert!(!granted.contains(&"claim_task"), "collab is off — claim_task must not be granted");
        assert!(!granted.contains(&"assign_task"));
        assert!(!granted.contains(&"advance_phase"), "guarded tools are never in the day-one grant");

        let collab = WorkspaceModules {
            enabled: vec![crate::workspace::modules::MODULE_COLLAB.to_string()],
            ..WorkspaceModules::default()
        };
        let granted = default_granted_tools(&collab);
        assert!(granted.contains(&"claim_task"));
        assert!(granted.contains(&"assign_task"));
        // team is still off, and publish_delivery is guarded regardless.
        assert!(!granted.contains(&"publish_delivery"));
    }

    #[test]
    fn batch_toggle_is_one_write_and_follows_per_tool_rules() {
        let dir = tempfile::tempdir().unwrap();
        let paths = WorkspacePaths::new(dir.path());
        std::fs::create_dir_all(paths.nextup_dir()).unwrap();

        let knowledge: Vec<String> = WRITE_TOOLS
            .iter()
            .filter(|t| tool_group(t) == Some("knowledge"))
            .map(|t| t.to_string())
            .collect();

        let access = set_tools_allowed(&paths, &knowledge, true).unwrap();
        assert_eq!(access.allowed_tools.len(), knowledge.len());
        // Idempotent: re-granting the same group does not duplicate.
        let access = set_tools_allowed(&paths, &knowledge, true).unwrap();
        assert_eq!(access.allowed_tools.len(), knowledge.len());
        // Revoking the group clears exactly its tools.
        let access = set_tools_allowed(&paths, &knowledge, false).unwrap();
        assert!(access.allowed_tools.is_empty());

        // Granting a batch containing a module-bound tool needs the module on,
        // and the refusal leaves the allowlist untouched.
        let collab = vec!["claim_task".to_string(), "assign_task".to_string()];
        let err = set_tools_allowed(&paths, &collab, true).unwrap_err();
        assert_eq!(err.kind(), "invalid_input");
        assert!(get_access(&paths).unwrap().allowed_tools.is_empty());
        // Revoking module-bound tools stays fine with the module off.
        assert!(set_tools_allowed(&paths, &collab, false).is_ok());

        // Read-tier and unknown names are rejected before any mutation.
        let bad = vec!["record_note".to_string(), "list_tasks".to_string()];
        assert_eq!(set_tools_allowed(&paths, &bad, true).unwrap_err().kind(), "invalid_input");
        let bad = vec!["record_note".to_string(), "nope".to_string()];
        assert_eq!(set_tools_allowed(&paths, &bad, true).unwrap_err().kind(), "not_found");
        assert!(get_access(&paths).unwrap().allowed_tools.is_empty());
    }

    /// Rows of one tier whose module is off for `modules` — what exposure
    /// hides. Counted straight off the table rather than written as a literal
    /// `- 3`, so registering a module-bound tool cannot leave a stale
    /// expectation behind. Not circular: this reads [`TOOLS`], while the
    /// assertions below exercise `exposed_*`.
    fn hidden(modules: &WorkspaceModules, read_tier: bool) -> usize {
        TOOLS
            .iter()
            .filter(|t| matches!(t.access, Access::Read) == read_tier)
            .filter(|t| t.module.is_some_and(|m| !modules.is_enabled(m)))
            .count()
    }

    #[test]
    fn exposure_follows_the_module_switch() {
        let off = WorkspaceModules::default();
        let exposed = exposed_write_tools(&off);
        assert!(!exposed.contains(&"claim_task") && !exposed.contains(&"assign_task"));
        assert!(!exposed.contains(&"publish_delivery"));
        assert_eq!(exposed.len(), WRITE_TOOLS.len() - hidden(&off, false));
        let readable = exposed_read_tools(&off);
        assert!(!readable.contains(&"list_deliveries") && !readable.contains(&"get_delivery"));
        assert!(
            !readable.contains(&"list_specs")
                && !readable.contains(&"get_spec")
                && !readable.contains(&"validate_task_specs"),
            "spec read tools follow their module switch (D79)"
        );
        assert_eq!(readable.len(), READ_TOOLS.len() - hidden(&off, true));

        let collab_only = WorkspaceModules {
            enabled: vec![crate::workspace::modules::MODULE_COLLAB.into()],
            ..WorkspaceModules::default()
        };
        let exposed = exposed_write_tools(&collab_only);
        assert!(exposed.contains(&"claim_task"));
        assert!(!exposed.contains(&"publish_delivery"), "team tools follow their own switch");
        assert_eq!(exposed.len(), WRITE_TOOLS.len() - hidden(&collab_only, false));

        let all = WorkspaceModules {
            enabled: vec![
                crate::workspace::modules::MODULE_COLLAB.into(),
                crate::workspace::modules::MODULE_SPECS.into(),
                crate::workspace::modules::MODULE_TEAM.into(),
            ],
            ..WorkspaceModules::default()
        };
        assert_eq!(exposed_write_tools(&all), WRITE_TOOLS.to_vec());
        assert_eq!(exposed_read_tools(&all), READ_TOOLS.to_vec());
    }

    #[test]
    fn file_roundtrip_and_toggle() {
        let dir = tempfile::tempdir().unwrap();
        let paths = WorkspacePaths::new(dir.path());
        std::fs::create_dir_all(paths.nextup_dir()).unwrap();

        // Missing file behaves as the default (no migration for old workspaces).
        let access = get_access(&paths).unwrap();
        assert!(access.enabled);
        assert!(access.allowed_tools.is_empty());

        let access = set_tool_allowed(&paths, "record_decision", true).unwrap();
        assert!(access.tool_allowed("record_decision"));
        // Toggling twice does not duplicate.
        let access = set_tool_allowed(&paths, "record_decision", true).unwrap();
        assert_eq!(access.allowed_tools.len(), 1);
        let access = set_tool_allowed(&paths, "record_decision", false).unwrap();
        assert!(access.allowed_tools.is_empty());

        let raw: serde_json::Value =
            serde_json::from_slice(&std::fs::read(paths.agent_access_file()).unwrap()).unwrap();
        assert_eq!(raw["schemaVersion"], AGENT_ACCESS_SCHEMA_VERSION);
        assert_eq!(raw["enabled"], true);

        let access = set_enabled(&paths, false).unwrap();
        assert!(!access.enabled);

        // Read-tier and unknown names are rejected outright.
        assert_eq!(set_tool_allowed(&paths, "list_tasks", true).unwrap_err().kind(), "invalid_input");
        assert_eq!(set_tool_allowed(&paths, "nope", true).unwrap_err().kind(), "not_found");
    }

    #[test]
    fn set_all_tools_covers_the_exposed_write_tier_and_clears() {
        let dir = tempfile::tempdir().unwrap();
        let paths = WorkspacePaths::new(dir.path());
        std::fs::create_dir_all(paths.nextup_dir()).unwrap();

        // Modules off (no modules.json): select-all grants everything except
        // the module-bound tools.
        let access = set_all_tools_allowed(&paths, true).unwrap();
        assert_eq!(
            access.allowed_tools.len(),
            WRITE_TOOLS.len() - hidden(&WorkspaceModules::default(), false)
        );
        assert!(!access.tool_allowed("claim_task") && !access.tool_allowed("assign_task"));
        assert!(!access.tool_allowed("publish_delivery"));

        // Every module on: select-all now covers the full write tier.
        for module in crate::workspace::modules::KNOWN_MODULES {
            crate::workspace::modules::set_module_enabled(&paths, module, true).unwrap();
        }
        let access = set_all_tools_allowed(&paths, true).unwrap();
        assert_eq!(access.allowed_tools.len(), WRITE_TOOLS.len());
        for t in WRITE_TOOLS.iter() {
            assert!(access.tool_allowed(t), "'{t}' must be allowed after select-all");
        }
        // Idempotent: no duplicates on a second call.
        let access = set_all_tools_allowed(&paths, true).unwrap();
        assert_eq!(access.allowed_tools.len(), WRITE_TOOLS.len());

        // Module back off: select-all rewrites canonically, dropping the
        // now-unexposed grants.
        crate::workspace::modules::set_module_enabled(
            &paths,
            crate::workspace::modules::MODULE_COLLAB,
            false,
        )
        .unwrap();
        let access = set_all_tools_allowed(&paths, true).unwrap();
        assert!(!access.tool_allowed("claim_task"));

        let access = set_all_tools_allowed(&paths, false).unwrap();
        assert!(access.allowed_tools.is_empty());
    }

    #[test]
    fn module_bound_grants_need_the_module_on() {
        let dir = tempfile::tempdir().unwrap();
        let paths = WorkspacePaths::new(dir.path());
        std::fs::create_dir_all(paths.nextup_dir()).unwrap();

        // Off: granting refuses with a pointer to the switch…
        let err = set_tool_allowed(&paths, "claim_task", true).unwrap_err();
        assert_eq!(err.kind(), "invalid_input");
        assert!(err.to_string().contains("module"));

        // …but revoking is fine (cleanup of grants predating a switch-off).
        crate::workspace::modules::set_module_enabled(
            &paths,
            crate::workspace::modules::MODULE_COLLAB,
            true,
        )
        .unwrap();
        let access = set_tool_allowed(&paths, "assign_task", true).unwrap();
        assert!(access.tool_allowed("assign_task"));
        crate::workspace::modules::set_module_enabled(
            &paths,
            crate::workspace::modules::MODULE_COLLAB,
            false,
        )
        .unwrap();
        let access = set_tool_allowed(&paths, "assign_task", false).unwrap();
        assert!(!access.tool_allowed("assign_task"));
    }
}
