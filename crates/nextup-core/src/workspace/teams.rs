//! App-level team graph (D48): named groups of managed workspaces plus the
//! directed "delivers to" edges between them, at `~/.nextup/teams.json`.
//!
//! Teams are the first app-level structure with real semantics (the registry
//! is pointers only). Members reference workspaces by their stable
//! `workspaceId` — root/name are display caches, so a moved folder breaks
//! nothing a re-link cannot fix. Edges must stay a DAG: on a cycle, "who is
//! downstream" has no answer, and routing expands deliveries along edges.
//!
//! Every mutation below reads the whole file, edits it and writes it back, so
//! each one runs inside [`with_app_lock`] — `atomic_write` keeps each *file*
//! valid, the lock keeps the *sequence* correct. Two writers really do overlap:
//! the GUI runs each `team_*` IPC on a blocking thread pool (a drag persisting
//! layout while an edge add lands), and since D116 the nextup-mcp hub writes
//! this file too. Without the lock both load the same snapshot and the second
//! save silently drops the first's change — the edge comes back on reload
//! because it was never written, not because the UI glitched.
//!
//! ⚠️ **Every mutating fn in this module must take it**, and must take it
//! itself rather than relying on a caller: `mutate` deliberately runs its
//! closure unlocked because callers touch workspace files first (see the
//! nesting warning in `lock.rs`).

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::{NextUpError, Result};
use crate::workspace::atomic::atomic_write_json;
use crate::workspace::context::now_rfc3339;
use crate::workspace::ids::uuid_v4;
use crate::workspace::lock::with_app_lock;

pub const TEAMS_SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamsFile {
    #[serde(default)]
    pub schema_version: u32,
    #[serde(default)]
    pub teams: Vec<Team>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Team {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub members: Vec<TeamMember>,
    #[serde(default)]
    pub edges: Vec<TeamEdge>,
    /// Saved canvas positions keyed by member workspaceId (D53). Presentation
    /// state, not semantics — absent entries are auto-placed by the GUI, and
    /// opening a team never writes this (only drags / auto-tidy do).
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub layout: HashMap<String, NodePos>,
    /// This team's prime workspace (D116, 21 §4.1): the workspace whose agent
    /// may edit *this* team's graph and route *this* team's deliveries.
    /// Authority is scoped per team, not per workspace — a workspace can be
    /// prime here and an ordinary member elsewhere.
    ///
    /// ⚠️ **The prime is deliberately not a member** (D117): it sits above the
    /// flow this team describes, so it has no node on the canvas and no edges.
    /// It carries the same display caches a member does because it is not in
    /// `members` to look them up from — and the registry cannot answer, being
    /// keyed by root with no workspaceId at all.
    ///
    /// `None` is the default and what every pre-D116 file loads as: no prime,
    /// humans drive the graph. Enabling the `prime` module is the other half —
    /// neither key alone grants anything (21 §4.2).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prime: Option<TeamMember>,
    pub created_at: String,
    pub updated_at: String,
}

/// One node position on the team canvas (D53), in canvas pixel coordinates.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
pub struct NodePos {
    pub x: f64,
    pub y: f64,
}

/// One member workspace. `workspace_id` is the identity key; `root` and
/// `name` are display caches — overview surfaces re-read reality and may
/// refresh them, but membership questions are answered by id only.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TeamMember {
    pub workspace_id: String,
    pub root: String,
    pub name: String,
}

/// Directed delivery edge: `from` delivers to `to` (both workspace ids).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TeamEdge {
    pub from: String,
    pub to: String,
    /// When set, the app routes new outbox envelopes along this edge without
    /// the manual send step (D71). Off by default — automation is opted into
    /// per edge, and pre-D71 files load unchanged.
    #[serde(default)]
    pub auto_route: bool,
}

pub fn default_teams_path() -> Option<PathBuf> {
    crate::workspace::layout::app_dir().map(|dir| dir.join("teams.json"))
}

/// The app-level store's path, or the one reason it cannot be resolved.
pub fn teams_file() -> Result<PathBuf> {
    default_teams_path().ok_or_else(|| {
        NextUpError::NotFound("cannot resolve the home directory for teams.json".into())
    })
}

/// The whole graph, reloaded from disk. Every team command answers with this —
/// the GUI keeps no local copy of the graph, so a mutation and a plain read
/// hand back the same shape (D52).
pub fn list_all() -> Result<Vec<Team>> {
    Ok(load_teams(&teams_file()?)?.teams)
}

/// Apply one change to the app-level store and answer with the reloaded graph.
/// The path is resolved *before* `change` runs, so a store we cannot even
/// locate fails without the caller's preflight work (minting a workspace id,
/// switching the team module on) having happened.
pub fn mutate<T>(change: impl FnOnce(&Path) -> Result<T>) -> Result<Vec<Team>> {
    let path = teams_file()?;
    change(&path)?;
    Ok(load_teams(&path)?.teams)
}

pub fn load_teams(path: &Path) -> Result<TeamsFile> {
    if !path.is_file() {
        return Ok(TeamsFile { schema_version: TEAMS_SCHEMA_VERSION, teams: Vec::new() });
    }
    super::atomic::read_json_file(path)
}

fn save(path: &Path, mut file: TeamsFile) -> Result<()> {
    file.schema_version = TEAMS_SCHEMA_VERSION;
    atomic_write_json(path, &file)
}

fn team_mut<'a>(file: &'a mut TeamsFile, team_id: &str) -> Result<&'a mut Team> {
    file.teams
        .iter_mut()
        .find(|t| t.id == team_id)
        .ok_or_else(|| NextUpError::NotFound(format!("no team with id {team_id}")))
}

pub fn create_team(path: &Path, name: &str) -> Result<Team> {
    let name = name.trim();
    if name.is_empty() {
        return Err(NextUpError::InvalidInput("team name cannot be empty".into()));
    }
    with_app_lock(path, || {
        let mut file = load_teams(path)?;
        let now = now_rfc3339();
        let team = Team {
            id: uuid_v4(),
            name: name.to_string(),
            members: Vec::new(),
            edges: Vec::new(),
            layout: HashMap::new(),
            prime: None,
            created_at: now.clone(),
            updated_at: now,
        };
        file.teams.push(team.clone());
        save(path, file)?;
        Ok(team)
    })
}

pub fn rename_team(path: &Path, team_id: &str, name: &str) -> Result<()> {
    let name = name.trim();
    if name.is_empty() {
        return Err(NextUpError::InvalidInput("team name cannot be empty".into()));
    }
    with_app_lock(path, || {
        let mut file = load_teams(path)?;
        let team = team_mut(&mut file, team_id)?;
        team.name = name.to_string();
        team.updated_at = now_rfc3339();
        save(path, file)
    })
}

pub fn delete_team(path: &Path, team_id: &str) -> Result<()> {
    with_app_lock(path, || {
        let mut file = load_teams(path)?;
        let before = file.teams.len();
        file.teams.retain(|t| t.id != team_id);
        if file.teams.len() == before {
            return Err(NextUpError::NotFound(format!("no team with id {team_id}")));
        }
        save(path, file)
    })
}

/// Add a member. The caller passes a workspace with a minted stable id
/// (`ops::ensure_workspace_id`); joining twice is refused rather than deduped
/// silently so the UI can tell the user what actually happened.
pub fn add_member(path: &Path, team_id: &str, member: TeamMember) -> Result<()> {
    if member.workspace_id.trim().is_empty() {
        return Err(NextUpError::InvalidInput("member workspaceId cannot be empty".into()));
    }
    with_app_lock(path, || {
        let mut file = load_teams(path)?;
        let team = team_mut(&mut file, team_id)?;
        if team.members.iter().any(|m| m.workspace_id == member.workspace_id) {
            return Err(NextUpError::InvalidInput(format!(
                "workspace {} is already a member of team \"{}\"",
                member.workspace_id, team.name
            )));
        }
        // The other half of the rule `set_prime` enforces (D117): a workspace
        // holds one seat per team, above the flow or in it, never both.
        if team.prime.as_ref().is_some_and(|p| p.workspace_id == member.workspace_id) {
            return Err(NextUpError::InvalidInput(format!(
                "workspace {} is the prime of team \"{}\" — it coordinates the team from above and cannot also be a member; clear the prime designation first",
                member.workspace_id, team.name
            )));
        }
        team.members.push(member);
        team.updated_at = now_rfc3339();
        save(path, file)
    })
}

/// Remove a member and every edge touching it — a dangling edge would point
/// at a workspace the team no longer knows.
pub fn remove_member(path: &Path, team_id: &str, workspace_id: &str) -> Result<()> {
    with_app_lock(path, || {
        let mut file = load_teams(path)?;
        let team = team_mut(&mut file, team_id)?;
        let before = team.members.len();
        team.members.retain(|m| m.workspace_id != workspace_id);
        if team.members.len() == before {
            return Err(NextUpError::NotFound(format!(
                "workspace {workspace_id} is not a member of this team"
            )));
        }
        team.edges.retain(|e| e.from != workspace_id && e.to != workspace_id);
        team.layout.remove(workspace_id);
        // The prime is never a member (D117), so leaving a team cannot strip a
        // designation — that is `set_prime(None)`, a separate deliberate act.
        team.updated_at = now_rfc3339();
        save(path, file)
    })
}

/// Designate (or clear, with `None`) this team's prime workspace (D116/D117).
///
/// The prime must *not* be a member. It coordinates the flow this team
/// describes rather than taking part in it, so holding both seats would put it
/// back on the canvas as an ordinary node — the shape D117 exists to undo.
/// Identity is resolved by the caller exactly as [`add_member`] requires it:
/// this module answers membership questions, it never reads workspace files.
pub fn set_prime(path: &Path, team_id: &str, prime: Option<TeamMember>) -> Result<()> {
    if prime.as_ref().is_some_and(|p| p.workspace_id.trim().is_empty()) {
        return Err(NextUpError::InvalidInput("prime workspaceId cannot be empty".into()));
    }
    with_app_lock(path, || {
        let mut file = load_teams(path)?;
        let team = team_mut(&mut file, team_id)?;
        if let Some(p) = &prime {
            reject_member_as_prime(team, &p.workspace_id)?;
        }
        team.prime = prime;
        team.updated_at = now_rfc3339();
        save(path, file)
    })
}

/// The one rule [`set_prime`] enforces, shared with [`designate_prime`] so the
/// pre-flight question and the authoritative answer can never drift apart.
fn reject_member_as_prime(team: &Team, workspace_id: &str) -> Result<()> {
    if team.members.iter().any(|m| m.workspace_id == workspace_id) {
        return Err(NextUpError::InvalidInput(format!(
            "workspace {} is a member of team \"{}\" — a prime coordinates a team from above it and has no node in its flow, so it cannot also be a member; remove it as a member first",
            workspace_id, team.name
        )));
    }
    Ok(())
}

/// Persist the team-canvas node positions (D53). The GUI sends the full map;
/// ids that are not current members are dropped silently (tidies up after
/// departed members). Presentation state only — no ledger, no workspace I/O.
pub fn set_layout(path: &Path, team_id: &str, positions: HashMap<String, NodePos>) -> Result<()> {
    with_app_lock(path, || {
        let mut file = load_teams(path)?;
        let team = team_mut(&mut file, team_id)?;
        let kept: HashMap<String, NodePos> = positions
            .into_iter()
            .filter(|(id, _)| team.members.iter().any(|m| &m.workspace_id == id))
            .collect();
        team.layout = kept;
        team.updated_at = now_rfc3339();
        save(path, file)
    })
}

/// Add a directed edge `from → to`. Both endpoints must be members; self
/// loops, duplicates and anything that would close a cycle are refused — the
/// graph stays a DAG so "who is downstream" always has an answer (09 §3).
pub fn add_edge(path: &Path, team_id: &str, from: &str, to: &str) -> Result<()> {
    with_app_lock(path, || {
        let mut file = load_teams(path)?;
        let team = team_mut(&mut file, team_id)?;
        if from == to {
            return Err(NextUpError::InvalidInput(
                "an edge cannot point a workspace at itself".into(),
            ));
        }
        for endpoint in [from, to] {
            if !team.members.iter().any(|m| m.workspace_id == endpoint) {
                return Err(NextUpError::InvalidInput(format!(
                    "workspace {endpoint} is not a member of team \"{}\"",
                    team.name
                )));
            }
        }
        if team.edges.iter().any(|e| e.from == from && e.to == to) {
            return Err(NextUpError::InvalidInput("this edge already exists".into()));
        }
        if reaches(&team.edges, to, from) {
            return Err(NextUpError::InvalidInput(format!(
                "adding {from} → {to} would create a cycle — team flows must stay a DAG"
            )));
        }
        team.edges.push(TeamEdge { from: from.to_string(), to: to.to_string(), auto_route: false });
        team.updated_at = now_rfc3339();
        save(path, file)
    })
}

pub fn remove_edge(path: &Path, team_id: &str, from: &str, to: &str) -> Result<()> {
    with_app_lock(path, || {
        let mut file = load_teams(path)?;
        let team = team_mut(&mut file, team_id)?;
        let before = team.edges.len();
        team.edges.retain(|e| !(e.from == from && e.to == to));
        if team.edges.len() == before {
            return Err(NextUpError::NotFound(format!("no edge {from} → {to} in this team")));
        }
        team.updated_at = now_rfc3339();
        save(path, file)
    })
}

/// Set the auto-route policy on an existing edge (D71). Edges carry no id of
/// their own — the (from, to) pair names them, same as `remove_edge`.
pub fn set_edge_auto_route(
    path: &Path,
    team_id: &str,
    from: &str,
    to: &str,
    auto_route: bool,
) -> Result<()> {
    with_app_lock(path, || {
        let mut file = load_teams(path)?;
        let team = team_mut(&mut file, team_id)?;
        let edge = team
            .edges
            .iter_mut()
            .find(|e| e.from == from && e.to == to)
            .ok_or_else(|| NextUpError::NotFound(format!("no edge {from} → {to} in this team")))?;
        edge.auto_route = auto_route;
        team.updated_at = now_rfc3339();
        save(path, file)
    })
}

/// Identity gate for re-linking a moved member (D52, 09 §2): a folder is only
/// accepted as member `expected` when its context carries exactly that stable
/// id. `None` (a workspace that never joined a team — ids are minted on join)
/// is refused rather than trusted.
pub fn check_rebind_identity(expected: &str, actual: Option<&str>) -> Result<()> {
    match actual {
        Some(actual) if actual == expected => Ok(()),
        Some(actual) => Err(NextUpError::InvalidInput(format!(
            "this folder is workspace {actual}, not {expected} — pick the folder that belongs to this member"
        ))),
        None => Err(NextUpError::InvalidInput(
            "this folder has no stable workspace id — it is not the moved member (ids are minted on team join)"
                .into(),
        )),
    }
}

/// Re-link a moved workspace (D52, team module design §2, added later): update the root/name display
/// caches of member `workspace_id` across **every** team — a folder move is a
/// fact about the workspace, not about one team. The caller has already
/// verified identity via `check_rebind_identity`. Returns how many teams were
/// touched.
pub fn rebind_workspace(
    path: &Path,
    workspace_id: &str,
    new_root: &str,
    new_name: &str,
) -> Result<usize> {
    let new_root = new_root.trim();
    if new_root.is_empty() {
        return Err(NextUpError::InvalidInput("new root cannot be empty".into()));
    }
    with_app_lock(path, || {
        let mut file = load_teams(path)?;
        let now = now_rfc3339();
        let mut touched = 0usize;
        for team in file.teams.iter_mut() {
            let mut hit = false;
            for member in team.members.iter_mut().filter(|m| m.workspace_id == workspace_id) {
                member.root = new_root.to_string();
                member.name = new_name.to_string();
                hit = true;
            }
            if hit {
                team.updated_at = now.clone();
                touched += 1;
            }
        }
        if touched == 0 {
            return Err(NextUpError::NotFound(format!(
                "workspace {workspace_id} is not a member of any team"
            )));
        }
        save(path, file)?;
        Ok(touched)
    })
}

/// Initialize a brand-new workspace and join it to `team_id` in one call
/// (D116 Q2, 21 §6) — the "spin up a project for this need and put it in the
/// flow" step, which until now only a human could perform across three
/// screens.
///
/// Composes three layers deliberately and **in this order**:
///
/// 1. the team is checked *before* anything touches the disk — a mistyped
///    team id must not leave an orphan workspace behind;
/// 2. `initialize_project` creates the folder (its own `create_root` contract
///    refuses a pre-existing one, D44) and mints the stable workspace id;
/// 3. the registry pointer, then the membership.
///
/// The `team` module is forced on regardless of `params.modules`: a member
/// without the inbox surface is the silent black hole that `team_add_member`
/// already guards against (09 landing delta ②).
///
/// ⚠️ Not atomic across the three, and deliberately so — each step takes its
/// own lock and they must never nest (`lock.rs`). If the last step fails the
/// workspace exists and is registered, just not joined: visible, and fixable
/// with a plain "add member". The reverse order would strand a folder nobody
/// listed.
pub fn create_member(
    teams_path: &Path,
    registry_path: &Path,
    team_id: &str,
    params: &crate::workspace::init::InitProjectParams,
    keys: &dyn crate::security::keystore::KeyProvider,
    app_version: &str,
) -> Result<TeamMember> {
    let known = load_teams(teams_path)?;
    if !known.teams.iter().any(|t| t.id == team_id) {
        return Err(NextUpError::NotFound(format!("no team with id {team_id}")));
    }

    let mut params = params.clone();
    if !params.modules.iter().any(|m| m == crate::workspace::modules::MODULE_TEAM) {
        params.modules.push(crate::workspace::modules::MODULE_TEAM.to_string());
    }
    params.create_root = true;

    let context = crate::workspace::init::initialize_project(&params, keys, app_version)?;
    let root = params.root.trim().to_string();
    let workspace_id = context.workspace_id.clone().ok_or_else(|| {
        NextUpError::Workspace("the new workspace was created without a stable id".into())
    })?;

    crate::workspace::registry::record_workspace(
        registry_path,
        &root,
        &context.name,
        &context.domain,
    )?;

    let member = TeamMember { workspace_id, root, name: context.name };
    add_member(teams_path, team_id, member.clone())?;
    Ok(member)
}

/// Designate `root` as this team's prime the way the app does (D116/D117):
/// resolve who it is, switch its `prime` module on (D119), then record it.
/// One function so the Tauri command and the test stand-in cannot diverge.
///
/// **The membership check runs before either side effect** — the same lesson
/// as [`create_member`]'s team check, learned again. [`set_prime`] refuses a
/// workspace that is already a member; a refusal that arrived *after* the
/// module flip would leave that member carrying a coordinator's surface it was
/// never granted — thirteen prime tools in its `tools/list`, plus the STATE
/// block line and the shipped guide the synced switch writes.
///
/// Membership is keyed by the stable id, so the check asks with the id the
/// workspace already has. One without an id cannot be a member — joining is
/// what mints it — so answering the question mints nothing either.
pub fn designate_prime(
    teams_path: &Path,
    team_id: &str,
    root: &str,
    app_version: &str,
) -> Result<TeamMember> {
    let root = root.trim();
    let paths = crate::workspace::layout::WorkspacePaths::new(root);
    let context = crate::workspace::init::open_workspace(paths.root())?;

    let known = load_teams(teams_path)?;
    let team = known
        .teams
        .iter()
        .find(|t| t.id == team_id)
        .ok_or_else(|| NextUpError::NotFound(format!("no team with id {team_id}")))?;
    if let Some(id) = &context.workspace_id {
        reject_member_as_prime(team, id)?;
    }

    let workspace_id = crate::workspace::ops::ensure_workspace_id(&paths, app_version)?;
    let modules = crate::workspace::modules::get_modules(&paths)?;
    if !modules.is_enabled(crate::workspace::modules::MODULE_PRIME) {
        // Synced variant (D82): a module switch changes the takeover surface.
        crate::workspace::modules::set_module_enabled_synced(
            &paths,
            crate::workspace::modules::MODULE_PRIME,
            true,
            app_version,
        )?;
    }

    let member = TeamMember { workspace_id, root: root.to_string(), name: context.name };
    set_prime(teams_path, team_id, Some(member.clone()))?;
    Ok(member)
}

/// Is `goal` reachable from `start` along the directed edges?
fn reaches(edges: &[TeamEdge], start: &str, goal: &str) -> bool {
    let mut stack = vec![start];
    let mut seen = std::collections::HashSet::new();
    while let Some(node) = stack.pop() {
        if node == goal {
            return true;
        }
        if !seen.insert(node) {
            continue;
        }
        for edge in edges.iter().filter(|e| e.from == node) {
            stack.push(&edge.to);
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::security::keystore::StaticKeyProvider;
    use crate::workspace::init::InitProjectParams;

    /// Params for a new workspace at `root`, which must not exist yet.
    fn new_params(root: &Path) -> InitProjectParams {
        InitProjectParams {
            root: root.to_string_lossy().into_owned(),
            name: "spun up".into(),
            domain: "research".into(),
            ..Default::default()
        }
    }

    fn member(id: &str) -> TeamMember {
        TeamMember {
            workspace_id: id.to_string(),
            root: format!("C:/ws/{id}"),
            name: id.to_string(),
        }
    }

    /// A team with members a, b, c and no edges.
    fn seeded() -> (tempfile::TempDir, PathBuf, Team) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("teams.json");
        let team = create_team(&path, "research to dev").unwrap();
        for id in ["a", "b", "c"] {
            add_member(&path, &team.id, member(id)).unwrap();
        }
        (dir, path, team)
    }

    /// The process-local `Mutex` this replaced (D116) already covered threads;
    /// what it could not cover is a second *process*, proven in `lock.rs`.
    /// Keeping a same-process case here pins the sequence for both.
    #[test]
    fn concurrent_member_adds_do_not_lose_entries() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("teams.json");
        let team = create_team(&path, "research to dev").unwrap();
        std::thread::scope(|scope| {
            for id in ["a", "b", "c", "d", "e", "f"] {
                let (path, team_id) = (path.clone(), team.id.clone());
                scope.spawn(move || add_member(&path, &team_id, member(id)).unwrap());
            }
        });
        let teams = load_teams(&path).unwrap().teams;
        assert_eq!(teams[0].members.len(), 6, "every concurrent write must survive");
    }

    #[test]
    fn create_member_initializes_registers_and_joins_in_one_call() {
        let (dir, path, team) = seeded();
        let reg = dir.path().join("registry.json");
        let root = dir.path().join("spun-up");

        let made = create_member(
            &path,
            &reg,
            &team.id,
            &new_params(&root),
            &StaticKeyProvider([7u8; 32]),
            "0.1.0",
        )
        .unwrap();

        assert!(root.join(".nextup").is_dir(), "the workspace is on disk");
        assert_eq!(
            crate::workspace::registry::load_registry(&reg).unwrap().workspaces.len(),
            1,
            "and listed in the registry"
        );
        let team = &load_teams(&path).unwrap().teams[0];
        assert!(team.members.iter().any(|m| m.workspace_id == made.workspace_id), "and joined");

        // Without the team module the new member would have no inbox surface.
        let modules =
            crate::workspace::modules::get_modules(&crate::workspace::layout::WorkspacePaths::new(
                &root,
            ))
            .unwrap();
        assert!(modules.is_enabled(crate::workspace::modules::MODULE_TEAM));
    }

    /// The refusal is not the point — leaving the target untouched is. An
    /// earlier ordering flipped the module first, so a designation the graph
    /// then refused still left that member with the prime surface switched on.
    #[test]
    fn designating_a_member_leaves_its_workspace_untouched() {
        let (dir, path, team) = seeded();
        let reg = dir.path().join("registry.json");
        let root = dir.path().join("joined");
        create_member(
            &path,
            &reg,
            &team.id,
            &new_params(&root),
            &StaticKeyProvider([7u8; 32]),
            "0.1.0",
        )
        .unwrap();

        let err = designate_prime(&path, &team.id, &root.to_string_lossy(), "0.1.0").unwrap_err();

        assert!(err.to_string().contains("cannot also be a member"), "got: {err}");
        let paths = crate::workspace::layout::WorkspacePaths::new(root.to_string_lossy().as_ref());
        assert!(
            !crate::workspace::modules::get_modules(&paths)
                .unwrap()
                .is_enabled(crate::workspace::modules::MODULE_PRIME),
            "a refused designation must not leave the prime module on"
        );
        let after = load_teams(&path).unwrap();
        assert!(after.teams.iter().all(|t| t.prime.is_none()), "and no prime is recorded");
    }

    #[test]
    fn designate_prime_switches_the_module_on_and_records_it() {
        let (dir, path, team) = seeded();
        let root = dir.path().join("coordinator");
        let mut params = new_params(&root);
        params.create_root = true;
        crate::workspace::init::initialize_project(
            &params,
            &StaticKeyProvider([7u8; 32]),
            "0.1.0",
        )
        .unwrap();

        let made = designate_prime(&path, &team.id, &root.to_string_lossy(), "0.1.0").unwrap();

        let paths = crate::workspace::layout::WorkspacePaths::new(root.to_string_lossy().as_ref());
        assert!(
            crate::workspace::modules::get_modules(&paths)
                .unwrap()
                .is_enabled(crate::workspace::modules::MODULE_PRIME),
            "D119: designating switches the prime module on"
        );
        let after = load_teams(&path).unwrap();
        let recorded = after.teams.iter().find(|t| t.id == team.id).unwrap().prime.clone();
        assert_eq!(recorded.unwrap().workspace_id, made.workspace_id);
    }

    /// A mistyped team id must not leave an orphan workspace on disk — the
    /// team is checked before anything is created.
    #[test]
    fn create_member_checks_the_team_before_touching_the_disk() {
        let (dir, path, _team) = seeded();
        let reg = dir.path().join("registry.json");
        let root = dir.path().join("never-made");

        let err = create_member(
            &path,
            &reg,
            "no-such-team",
            &new_params(&root),
            &StaticKeyProvider([7u8; 32]),
            "0.1.0",
        );

        assert!(err.is_err());
        assert!(!root.exists(), "no orphan folder left behind");
    }

    #[test]
    fn prime_defaults_to_none_and_pre_d116_files_load() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("teams.json");
        std::fs::write(
            &path,
            r#"{"schemaVersion":1,"teams":[{"id":"t1","name":"old","members":[],
               "edges":[],"createdAt":"2026-01-01T00:00:00Z","updatedAt":"2026-01-01T00:00:00Z"}]}"#,
        )
        .unwrap();
        let teams = load_teams(&path).unwrap().teams;
        assert_eq!(teams[0].prime, None, "a file written before D116 must load unchanged");
    }

    /// D117 inverted D116's rule: a prime sits *above* the flow, so a
    /// non-member is exactly who may hold the seat.
    #[test]
    fn prime_is_a_non_member_and_can_be_cleared() {
        let (_dir, path, team) = seeded();

        set_prime(&path, &team.id, Some(member("boss"))).unwrap();
        assert_eq!(
            load_teams(&path).unwrap().teams[0].prime.as_ref().unwrap().workspace_id,
            "boss",
            "a workspace outside the team is who coordinates it"
        );

        set_prime(&path, &team.id, None).unwrap();
        assert_eq!(load_teams(&path).unwrap().teams[0].prime, None);
    }

    /// The display caches are the point of storing a whole `TeamMember`: the
    /// prime is in no member row and the registry has no workspaceId at all,
    /// so nothing else on disk could answer "what is this prime called?".
    #[test]
    fn prime_carries_its_own_root_and_name() {
        let (_dir, path, team) = seeded();
        set_prime(&path, &team.id, Some(member("boss"))).unwrap();

        let stored = load_teams(&path).unwrap().teams[0].prime.clone().unwrap();
        assert_eq!(stored.root, "C:/ws/boss");
        assert_eq!(stored.name, "boss");
    }

    /// One seat per team, above the flow or in it — enforced from both sides,
    /// because either alone leaves the other order of operations open.
    #[test]
    fn a_workspace_cannot_be_both_prime_and_member() {
        let (_dir, path, team) = seeded();

        assert!(
            set_prime(&path, &team.id, Some(member("a"))).is_err(),
            "a member cannot be promoted in place — that is the shape D117 undid"
        );

        set_prime(&path, &team.id, Some(member("boss"))).unwrap();
        assert!(
            add_member(&path, &team.id, member("boss")).is_err(),
            "and the prime cannot join the team it coordinates"
        );
    }

    /// The prime is never a member (D117), so leaving cannot strip authority.
    /// Clearing a designation is `set_prime(None)` and nothing else.
    #[test]
    fn removing_a_member_leaves_the_prime_designation_alone() {
        let (_dir, path, team) = seeded();
        set_prime(&path, &team.id, Some(member("boss"))).unwrap();

        remove_member(&path, &team.id, "b").unwrap();

        let prime = load_teams(&path).unwrap().teams[0].prime.clone();
        assert_eq!(prime.unwrap().workspace_id, "boss");
    }

    #[test]
    fn prime_is_scoped_per_team_not_per_workspace() {
        let (_dir, path, first) = seeded();
        let second = create_team(&path, "other").unwrap();
        add_member(&path, &second.id, member("a")).unwrap();

        set_prime(&path, &first.id, Some(member("boss"))).unwrap();
        let teams = load_teams(&path).unwrap().teams;
        let other = teams.iter().find(|t| t.id == second.id).unwrap();
        assert_eq!(other.prime, None, "being prime of one team grants nothing in another");
    }

    /// The canvas draws `members`, so a prime that never lands there is the
    /// whole of "not a node in the flow" as far as core can express it.
    #[test]
    fn the_prime_gets_no_node_and_no_edges() {
        let (_dir, path, team) = seeded();
        set_prime(&path, &team.id, Some(member("boss"))).unwrap();

        let stored = load_teams(&path).unwrap().teams.remove(0);
        assert!(
            !stored.members.iter().any(|m| m.workspace_id == "boss"),
            "the prime is not drawn as a team node"
        );
        assert!(
            add_edge(&path, &team.id, "boss", "a").is_err(),
            "and edges refuse a non-member endpoint, so it cannot acquire one"
        );
    }

    #[test]
    fn missing_file_is_empty() {
        let dir = tempfile::tempdir().unwrap();
        let file = load_teams(&dir.path().join("nope.json")).unwrap();
        assert!(file.teams.is_empty());
        assert_eq!(file.schema_version, TEAMS_SCHEMA_VERSION);
    }

    #[test]
    fn create_rename_delete_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("teams.json");
        assert_eq!(create_team(&path, "  ").unwrap_err().kind(), "invalid_input");

        let team = create_team(&path, "  alpha  ").unwrap();
        assert_eq!(team.name, "alpha", "names are trimmed");
        assert_eq!(team.id.len(), 36);

        rename_team(&path, &team.id, "beta").unwrap();
        let loaded = load_teams(&path).unwrap();
        assert_eq!(loaded.schema_version, TEAMS_SCHEMA_VERSION);
        assert_eq!(loaded.teams[0].name, "beta");

        delete_team(&path, &team.id).unwrap();
        assert!(load_teams(&path).unwrap().teams.is_empty());
        assert_eq!(delete_team(&path, &team.id).unwrap_err().kind(), "not_found");
        assert_eq!(rename_team(&path, "ghost", "x").unwrap_err().kind(), "not_found");
    }

    #[test]
    fn membership_is_keyed_by_workspace_id() {
        let (_g, path, team) = seeded();
        // Same id, different display cache → still a duplicate.
        let mut dup = member("a");
        dup.root = "D:/moved/a".into();
        assert_eq!(add_member(&path, &team.id, dup).unwrap_err().kind(), "invalid_input");

        let mut blank = member("a");
        blank.workspace_id = "  ".into();
        assert_eq!(add_member(&path, &team.id, blank).unwrap_err().kind(), "invalid_input");
        assert_eq!(load_teams(&path).unwrap().teams[0].members.len(), 3);
    }

    #[test]
    fn edges_must_be_a_dag_between_members() {
        let (_g, path, team) = seeded();
        add_edge(&path, &team.id, "a", "b").unwrap();
        add_edge(&path, &team.id, "b", "c").unwrap();

        // Self loop, non-member endpoint, duplicate, cycle — all refused.
        assert_eq!(add_edge(&path, &team.id, "a", "a").unwrap_err().kind(), "invalid_input");
        assert_eq!(add_edge(&path, &team.id, "a", "zz").unwrap_err().kind(), "invalid_input");
        assert_eq!(add_edge(&path, &team.id, "a", "b").unwrap_err().kind(), "invalid_input");
        let cycle = add_edge(&path, &team.id, "c", "a").unwrap_err();
        assert_eq!(cycle.kind(), "invalid_input");
        assert!(cycle.to_string().contains("cycle"));

        // A diamond (a→b, a→c... here a→c alongside a→b→c) is NOT a cycle.
        add_edge(&path, &team.id, "a", "c").unwrap();
        assert_eq!(load_teams(&path).unwrap().teams[0].edges.len(), 3);
    }

    #[test]
    fn edges_default_to_manual_and_auto_route_flips_per_edge() {
        let (_g, path, team) = seeded();
        add_edge(&path, &team.id, "a", "b").unwrap();
        add_edge(&path, &team.id, "b", "c").unwrap();
        let loaded = load_teams(&path).unwrap();
        assert!(loaded.teams[0].edges.iter().all(|e| !e.auto_route), "manual is the default");

        set_edge_auto_route(&path, &team.id, "a", "b", true).unwrap();
        let edges = load_teams(&path).unwrap().teams[0].edges.clone();
        assert!(edges.iter().find(|e| e.from == "a").unwrap().auto_route);
        assert!(!edges.iter().find(|e| e.from == "b").unwrap().auto_route, "only that edge flips");

        set_edge_auto_route(&path, &team.id, "a", "b", false).unwrap();
        assert!(load_teams(&path).unwrap().teams[0].edges.iter().all(|e| !e.auto_route));
        assert_eq!(
            set_edge_auto_route(&path, &team.id, "a", "c", true).unwrap_err().kind(),
            "not_found"
        );
    }

    #[test]
    fn edges_without_auto_route_on_disk_load_as_manual() {
        // A pre-D71 teams.json has no autoRoute key — serde default must keep
        // it loadable with every edge treated as manual.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("teams.json");
        std::fs::write(
            &path,
            r#"{"schemaVersion":1,"teams":[{"id":"t1","name":"old","members":[{"workspaceId":"a","root":"C:/ws/a","name":"a"},{"workspaceId":"b","root":"C:/ws/b","name":"b"}],"edges":[{"from":"a","to":"b"}],"createdAt":"2026-01-01T00:00:00Z","updatedAt":"2026-01-01T00:00:00Z"}]}"#,
        )
        .unwrap();
        let file = load_teams(&path).unwrap();
        assert!(!file.teams[0].edges[0].auto_route);
    }

    #[test]
    fn removing_a_member_cleans_its_edges() {
        let (_g, path, team) = seeded();
        add_edge(&path, &team.id, "a", "b").unwrap();
        add_edge(&path, &team.id, "b", "c").unwrap();

        remove_member(&path, &team.id, "b").unwrap();
        let loaded = load_teams(&path).unwrap();
        assert_eq!(loaded.teams[0].members.len(), 2);
        assert!(loaded.teams[0].edges.is_empty(), "edges touching b are gone");
        assert_eq!(
            remove_member(&path, &team.id, "b").unwrap_err().kind(),
            "not_found"
        );
    }

    #[test]
    fn rebind_updates_caches_across_every_team() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("teams.json");
        let one = create_team(&path, "one").unwrap();
        let two = create_team(&path, "two").unwrap();
        add_member(&path, &one.id, member("a")).unwrap();
        add_member(&path, &one.id, member("b")).unwrap();
        add_member(&path, &two.id, member("a")).unwrap();

        let touched = rebind_workspace(&path, "a", "D:/moved/a", "a (new home)").unwrap();
        assert_eq!(touched, 2, "the move is global — both teams refresh");
        let loaded = load_teams(&path).unwrap();
        for team in &loaded.teams {
            let m = team.members.iter().find(|m| m.workspace_id == "a").unwrap();
            assert_eq!(m.root, "D:/moved/a");
            assert_eq!(m.name, "a (new home)");
        }
        let untouched = loaded.teams[0].members.iter().find(|m| m.workspace_id == "b").unwrap();
        assert_eq!(untouched.root, "C:/ws/b", "other members keep their caches");

        assert_eq!(
            rebind_workspace(&path, "ghost", "D:/x", "x").unwrap_err().kind(),
            "not_found"
        );
        assert_eq!(
            rebind_workspace(&path, "a", "  ", "x").unwrap_err().kind(),
            "invalid_input"
        );
    }

    #[test]
    fn layout_keeps_members_only_and_removal_tidies() {
        let (_g, path, team) = seeded();
        let mut pos = HashMap::new();
        pos.insert("a".to_string(), NodePos { x: 40.0, y: 80.0 });
        pos.insert("ghost".to_string(), NodePos { x: 1.0, y: 2.0 });
        set_layout(&path, &team.id, pos).unwrap();

        let layout = load_teams(&path).unwrap().teams[0].layout.clone();
        assert_eq!(layout.len(), 1, "unknown ids are dropped silently");
        assert_eq!(layout["a"], NodePos { x: 40.0, y: 80.0 });

        remove_member(&path, &team.id, "a").unwrap();
        assert!(
            load_teams(&path).unwrap().teams[0].layout.is_empty(),
            "removing a member tidies its saved position"
        );
        assert_eq!(
            set_layout(&path, "ghost-team", HashMap::new()).unwrap_err().kind(),
            "not_found"
        );
    }

    /// The GUI runs every `team_*` IPC on a blocking thread pool, so a canvas
    /// drag (set_layout) really can overlap an edge add. Both do load → mutate
    /// → save; unserialized, the layout save writes back a pre-edge snapshot
    /// and the edge vanishes — which reads as "the UI lost my flow line".
    #[test]
    fn concurrent_layout_writes_do_not_drop_a_concurrent_edge() {
        let (_g, path, team) = seeded();

        for round in 0..40 {
            let pos = HashMap::from([
                ("a".to_string(), NodePos { x: round as f64, y: 0.0 }),
                ("b".to_string(), NodePos { x: 0.0, y: round as f64 }),
            ]);
            std::thread::scope(|scope| {
                scope.spawn(|| add_edge(&path, &team.id, "a", "b").unwrap());
                scope.spawn(|| set_layout(&path, &team.id, pos.clone()).unwrap());
                scope.spawn(|| set_layout(&path, &team.id, pos.clone()).unwrap());
            });

            let loaded = load_teams(&path).unwrap();
            let current = &loaded.teams[0];
            assert!(
                current.edges.iter().any(|e| e.from == "a" && e.to == "b"),
                "round {round}: a layout save wrote back a snapshot taken before the edge landed"
            );
            assert!(!current.layout.is_empty(), "round {round}: the layout save was lost");
            remove_edge(&path, &team.id, "a", "b").unwrap();
        }
    }

    #[test]
    fn empty_layout_is_not_serialized() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("teams.json");
        let team = create_team(&path, "t").unwrap();
        assert!(team.layout.is_empty());
        let raw = std::fs::read_to_string(&path).unwrap();
        assert!(
            !raw.contains("layout"),
            "pre-D53 file shape is preserved until a layout is actually saved"
        );
    }

    #[test]
    fn rebind_identity_is_matched_by_id_only() {
        check_rebind_identity("ws-1", Some("ws-1")).unwrap();
        let wrong = check_rebind_identity("ws-1", Some("ws-2")).unwrap_err();
        assert_eq!(wrong.kind(), "invalid_input");
        assert!(wrong.to_string().contains("ws-2"), "error names the actual id");
        let none = check_rebind_identity("ws-1", None).unwrap_err();
        assert_eq!(none.kind(), "invalid_input");
    }

    #[test]
    fn remove_edge_only_removes_that_direction() {
        let (_g, path, team) = seeded();
        add_edge(&path, &team.id, "a", "b").unwrap();
        assert_eq!(remove_edge(&path, &team.id, "b", "a").unwrap_err().kind(), "not_found");
        remove_edge(&path, &team.id, "a", "b").unwrap();
        assert!(load_teams(&path).unwrap().teams[0].edges.is_empty());
    }
}
