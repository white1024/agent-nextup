//! Carrying the team graph between machines (D173).
//!
//! The graph lives at app level (`~/.nextup/teams.json`, D48) and travels with
//! nothing — not a project folder, a backup, or git. Yet everything in it is
//! keyed by the stable `workspaceId`, and that id *does* travel: it sits in
//! each project's `.nextup/context.json`. The one field bound to a machine is
//! each member's (and prime's) `root`, the absolute path on whichever machine
//! wrote it. So moving a graph is two separate problems, kept apart here:
//!
//! 1. **Finding the folders again** ([`relink`]): every entry whose path is not
//!    the workspace carrying its id is looked up by id among the paths already
//!    in the graph, the caller's candidates (this machine's project list, the
//!    folders right under a directory the person picked), in that order.
//! 2. **Moving the definition** ([`export_teams`] → [`preview_import`] →
//!    [`apply_import`]): a file the person carries however they like. Import
//!    never merges — per team, the person takes the file's version or keeps
//!    this machine's — and never deletes a team the file does not mention.
//!
//! ⚠️ **Neither path moves `updatedAt`.** A root is where a folder sits on
//! *this* machine, not part of the team, and `updatedAt` is what the import
//! preview compares to suggest which side is newer. Bumping it on a re-link
//! would make whichever machine re-linked last look newer forever.
//!
//! Nothing here writes into a workspace: the team and prime modules and the
//! tool grants live in each project's `.nextup/` and travel with its git.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::{NextUpError, Result};
use crate::workspace::atomic::{atomic_write_json, read_json_file};
use crate::workspace::context::{load_context, now_rfc3339};
use crate::workspace::layout::WorkspacePaths;
use crate::workspace::lock::with_app_lock;
use crate::workspace::teams::{load_teams, save, Team, TeamMember};

/// The marker that tells a team file from any other JSON the person picks.
pub const EXPORT_FORMAT: &str = "nextup-teams";
pub const EXPORT_SCHEMA_VERSION: u32 = 1;
/// The name the save dialog suggests. The dialog is the GUI's, so the GUI
/// carries its own copy (`FILE_NAME` in `views/teams/TeamTransfer.tsx`); this
/// one is what the disk contract page is checked against.
pub const DEFAULT_FILE_NAME: &str = "nextup-teams.json";

/// A team file (D173 ②): the chosen teams exactly as `teams.json` holds them.
/// Roots ride along as *hints* — the exporting machine's paths, which are
/// right on a machine laid out the same way and harmless where they are not.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TeamsExport {
    pub format: String,
    pub schema_version: u32,
    pub exported_at: String,
    #[serde(default)]
    pub app_version: String,
    #[serde(default)]
    pub teams: Vec<Team>,
}

/// Write the teams named by `team_ids` to `dest`. Answers how many went out.
pub fn export_teams(
    teams_path: &Path,
    team_ids: &[String],
    dest: &Path,
    app_version: &str,
) -> Result<usize> {
    if team_ids.is_empty() {
        return Err(NextUpError::InvalidInput("pick at least one team to export".into()));
    }
    let file = load_teams(teams_path)?;
    if let Some(unknown) = team_ids.iter().find(|id| !file.teams.iter().any(|t| &t.id == *id)) {
        return Err(NextUpError::NotFound(format!("no team with id {unknown}")));
    }
    let teams: Vec<Team> = file.teams.into_iter().filter(|t| team_ids.contains(&t.id)).collect();
    let count = teams.len();
    atomic_write_json(
        dest,
        &TeamsExport {
            format: EXPORT_FORMAT.into(),
            schema_version: EXPORT_SCHEMA_VERSION,
            exported_at: now_rfc3339(),
            app_version: app_version.into(),
            teams,
        },
    )?;
    Ok(count)
}

/// Read and check a team file. All or nothing: one bad team refuses the whole
/// file, because taking half of what someone carried over reads as success.
pub fn read_export(file: &Path) -> Result<TeamsExport> {
    let value: serde_json::Value = read_json_file(file).map_err(|e| {
        NextUpError::InvalidInput(format!("cannot read {} as a team file: {e}", file.display()))
    })?;
    if value.get("format").and_then(|v| v.as_str()) != Some(EXPORT_FORMAT) {
        return Err(NextUpError::InvalidInput(format!(
            "{} is not an Agent NextUp team file (no \"format\": \"{EXPORT_FORMAT}\")",
            file.display()
        )));
    }
    let version = value.get("schemaVersion").and_then(|v| v.as_u64()).unwrap_or(0);
    if version > u64::from(EXPORT_SCHEMA_VERSION) {
        return Err(NextUpError::Workspace(format!(
            "this team file is v{version}, newer than this app reads (v{EXPORT_SCHEMA_VERSION}) — update Agent NextUp on this machine first"
        )));
    }
    let mut export: TeamsExport = serde_json::from_value(value)
        .map_err(|e| NextUpError::InvalidInput(format!("the team file is damaged: {e}")))?;
    let mut seen = HashSet::new();
    for team in export.teams.iter_mut() {
        if !seen.insert(team.id.clone()) {
            return Err(NextUpError::InvalidInput(format!(
                "the team file lists team {} twice",
                team.id
            )));
        }
        validate_team(team)?;
    }
    Ok(export)
}

/// The rules the team commands enforce one write at a time, applied to a
/// whole team at once — a file is hand-editable, so nothing in it is trusted
/// for having come from the app. Canvas positions of non-members are dropped
/// silently, as `set_layout` does.
fn validate_team(team: &mut Team) -> Result<()> {
    let label = if team.name.trim().is_empty() { team.id.clone() } else { team.name.clone() };
    let bad = |why: String| NextUpError::InvalidInput(format!("team \"{label}\" in this file {why}"));
    if team.id.trim().is_empty() {
        return Err(bad("has no id".into()));
    }
    if team.name.trim().is_empty() {
        return Err(bad("has no name".into()));
    }
    let mut ids: HashSet<String> = HashSet::new();
    for member in &team.members {
        if member.workspace_id.trim().is_empty() {
            return Err(bad("has a member without a workspace id".into()));
        }
        if !ids.insert(member.workspace_id.clone()) {
            return Err(bad(format!("lists member {} twice", member.workspace_id)));
        }
    }
    if let Some(prime) = &team.prime {
        if prime.workspace_id.trim().is_empty() {
            return Err(bad("has a coordinator without a workspace id".into()));
        }
        if ids.contains(&prime.workspace_id) {
            return Err(bad(format!(
                "has {} as both coordinator and member — a coordinator is never a member (D117)",
                prime.workspace_id
            )));
        }
    }
    let mut edges = HashSet::new();
    for edge in &team.edges {
        if edge.from == edge.to {
            return Err(bad(format!("has an edge from {} to itself", edge.from)));
        }
        for end in [&edge.from, &edge.to] {
            if !ids.contains(end) {
                return Err(bad(format!("has an edge at {end}, which is not a member")));
            }
        }
        if !edges.insert((edge.from.clone(), edge.to.clone())) {
            return Err(bad(format!("lists the edge {} → {} twice", edge.from, edge.to)));
        }
    }
    team.layout.retain(|id, _| ids.contains(id));
    team.orbit_layout.retain(|id, _| ids.contains(id));
    Ok(())
}

/// How one team in the file relates to this machine's graph.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ImportStatus {
    /// Not on this machine: importing adds it.
    New,
    /// Same content apart from this machine's path caches: nothing to do.
    Same,
    /// Both sides have it and they differ: the person picks a side.
    Differs,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ImportRow {
    pub id: String,
    pub name: String,
    pub status: ImportStatus,
    pub members: usize,
    pub edges: usize,
    /// The coordinator's name, shown because importing it designates it here.
    pub prime: Option<String>,
    pub file_updated_at: String,
    pub local_name: Option<String>,
    pub local_updated_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ImportPreview {
    pub exported_at: String,
    pub app_version: String,
    pub teams: Vec<ImportRow>,
}

/// What importing `file` would do, team by team. Reads only.
pub fn preview_import(teams_path: &Path, file: &Path) -> Result<ImportPreview> {
    let export = read_export(file)?;
    let local = load_teams(teams_path)?;
    let teams = export
        .teams
        .iter()
        .map(|incoming| {
            let mine = local.teams.iter().find(|t| t.id == incoming.id);
            let status = match mine {
                None => ImportStatus::New,
                Some(mine) if same_content(mine, incoming) => ImportStatus::Same,
                Some(_) => ImportStatus::Differs,
            };
            ImportRow {
                id: incoming.id.clone(),
                name: incoming.name.clone(),
                status,
                members: incoming.members.len(),
                edges: incoming.edges.len(),
                prime: incoming.prime.as_ref().map(|p| p.name.clone()),
                file_updated_at: incoming.updated_at.clone(),
                local_name: mine.map(|t| t.name.clone()),
                local_updated_at: mine.map(|t| t.updated_at.clone()),
            }
        })
        .collect();
    Ok(ImportPreview { exported_at: export.exported_at, app_version: export.app_version, teams })
}

/// What a team *is*, leaving out this machine's caches (roots, display names)
/// and the timestamps: name, who is in it (as a set — join order is not a
/// decision), the edges with their auto-send switch, the coordinator, and
/// both canvas layouts. A dragged node counts — positions are carried too.
fn same_content(a: &Team, b: &Team) -> bool {
    fn ids(team: &Team) -> HashSet<&str> {
        team.members.iter().map(|m| m.workspace_id.as_str()).collect()
    }
    fn edges(team: &Team) -> HashSet<(&str, &str, bool)> {
        team.edges.iter().map(|e| (e.from.as_str(), e.to.as_str(), e.auto_route)).collect()
    }
    let prime = |t: &Team| t.prime.as_ref().map(|p| p.workspace_id.clone());
    a.name == b.name
        && ids(a) == ids(b)
        && edges(a) == edges(b)
        && prime(a) == prime(b)
        && a.layout == b.layout
        && a.orbit_layout == b.orbit_layout
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ImportOutcome {
    pub added: usize,
    pub replaced: usize,
    /// The re-link pass that runs right after, so the result line can say
    /// who is still missing.
    pub relink: RelinkReport,
}

/// Take the teams named in `take` from `file` — adding those this machine
/// lacks, replacing those it has — then run [`relink`] over the whole graph.
/// Teams not in `take`, and local teams the file does not mention, stay as
/// they are.
///
/// A replaced or added entry keeps the path this machine already knows for
/// that workspace when that path is still the workspace; otherwise the file's
/// path stands as a hint, and the re-link pass gets the last word.
pub fn apply_import(
    teams_path: &Path,
    file: &Path,
    take: &[String],
    extra_roots: &[PathBuf],
) -> Result<ImportOutcome> {
    let export = read_export(file)?;
    if let Some(stray) = take.iter().find(|id| !export.teams.iter().any(|t| &t.id == *id)) {
        return Err(NextUpError::InvalidInput(format!("team {stray} is not in this file")));
    }
    let (added, replaced) = with_app_lock(teams_path, || {
        let mut local = load_teams(teams_path)?;
        let mut probe = Probe::default();
        let mut known: HashMap<String, String> = HashMap::new();
        for entry in local.teams.iter().flat_map(entries) {
            if probe.id_at(&entry.root).as_deref() == Some(entry.workspace_id.as_str()) {
                known.entry(entry.workspace_id.clone()).or_insert_with(|| entry.root.clone());
            }
        }
        let (mut added, mut replaced) = (0usize, 0usize);
        for incoming in export.teams.iter().filter(|t| take.contains(&t.id)) {
            let mut team = incoming.clone();
            for entry in team.members.iter_mut().chain(team.prime.iter_mut()) {
                if let Some(root) = known.get(&entry.workspace_id) {
                    entry.root = root.clone();
                }
            }
            match local.teams.iter_mut().find(|t| t.id == team.id) {
                Some(slot) => {
                    *slot = team;
                    replaced += 1;
                }
                None => {
                    local.teams.push(team);
                    added += 1;
                }
            }
        }
        if added + replaced > 0 {
            save(teams_path, local)?;
        }
        Ok((added, replaced))
    })?;
    let relink = relink(teams_path, extra_roots)?;
    Ok(ImportOutcome { added, replaced, relink })
}

/// One workspace the re-link pointed at a new folder.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Relinked {
    pub workspace_id: String,
    pub name: String,
    pub root: String,
}

/// What [`relink`] did, per workspace (not per team entry — one folder found
/// fixes it in every team).
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RelinkReport {
    pub relinked: Vec<Relinked>,
    /// Still not found anywhere: the stale path and the cached name, so the
    /// result line can name them.
    pub missing: Vec<Relinked>,
}

/// Point every member and prime whose path is not the workspace carrying its
/// id at one that is (D173 ①), across every team. Candidates are tried in
/// order — the paths already in the graph first, then `extra_roots` as given —
/// and the first folder found for an id wins. An entry whose path is already
/// right is never touched, and nothing is written when nothing moved.
pub fn relink(teams_path: &Path, extra_roots: &[PathBuf]) -> Result<RelinkReport> {
    if !teams_path.is_file() {
        // No graph on this machine: nothing to find, and no reason to create one.
        return Ok(RelinkReport::default());
    }
    with_app_lock(teams_path, || {
        let mut file = load_teams(teams_path)?;
        let mut probe = Probe::default();

        let graph_roots: Vec<String> =
            file.teams.iter().flat_map(entries).map(|m| m.root.clone()).collect();
        let extra = extra_roots.iter().map(|p| p.display().to_string());
        let mut found: HashMap<String, (String, String)> = HashMap::new();
        for root in graph_roots.into_iter().chain(extra) {
            if let Some(hit) = probe.at(&root) {
                found.entry(hit.id).or_insert((root, hit.name));
            }
        }

        let mut report = RelinkReport::default();
        let mut reported: HashSet<String> = HashSet::new();
        let mut changed = false;
        for team in file.teams.iter_mut() {
            for entry in team.members.iter_mut().chain(team.prime.iter_mut()) {
                if probe.id_at(&entry.root).as_deref() == Some(entry.workspace_id.as_str()) {
                    continue;
                }
                let first = reported.insert(entry.workspace_id.clone());
                match found.get(&entry.workspace_id) {
                    Some((root, name)) => {
                        entry.root = root.clone();
                        entry.name = name.clone();
                        changed = true;
                        if first {
                            report.relinked.push(Relinked {
                                workspace_id: entry.workspace_id.clone(),
                                name: name.clone(),
                                root: root.clone(),
                            });
                        }
                    }
                    None if first => report.missing.push(Relinked {
                        workspace_id: entry.workspace_id.clone(),
                        name: entry.name.clone(),
                        root: entry.root.clone(),
                    }),
                    None => {}
                }
            }
        }
        if changed {
            save(teams_path, file)?;
        }
        Ok(report)
    })
}

/// `dir` itself when it is a workspace, then every direct subfolder that is,
/// sorted. One level down and no further: the person points at the folder
/// their projects sit in, not at a disk to crawl.
pub fn workspace_folders_in(dir: &Path) -> Result<Vec<PathBuf>> {
    let is_workspace = |p: &Path| WorkspacePaths::new(p).context_file().is_file();
    let entries = std::fs::read_dir(dir).map_err(|e| {
        NextUpError::InvalidInput(format!("cannot read folder {}: {e}", dir.display()))
    })?;
    let mut found: Vec<PathBuf> = entries
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.is_dir() && is_workspace(p))
        .collect();
    found.sort();
    if is_workspace(dir) {
        found.insert(0, dir.to_path_buf());
    }
    Ok(found)
}

/// The candidates the GUI hands [`relink`]: this machine's project list in its
/// own order (most recently opened first), then the folders found in
/// `search_dir` when the person picked one.
pub fn candidate_roots(registry_path: Option<&Path>, search_dir: Option<&Path>) -> Result<Vec<PathBuf>> {
    let mut roots = Vec::new();
    if let Some(registry) = registry_path {
        roots.extend(
            crate::workspace::registry::load_registry(registry)?
                .workspaces
                .into_iter()
                .map(|w| PathBuf::from(w.root)),
        );
    }
    if let Some(dir) = search_dir {
        roots.extend(workspace_folders_in(dir)?);
    }
    Ok(roots)
}

/// Every place a workspace sits in one team: its members, then its prime.
fn entries(team: &Team) -> impl Iterator<Item = &TeamMember> + '_ {
    team.members.iter().chain(team.prime.iter())
}

struct Hit {
    id: String,
    name: String,
}

/// Which workspace (if any) sits at a path, read once per path per call.
#[derive(Default)]
struct Probe {
    seen: HashMap<String, Option<(String, String)>>,
}

impl Probe {
    fn at(&mut self, root: &str) -> Option<Hit> {
        self.seen
            .entry(root.to_string())
            .or_insert_with(|| read_identity(root))
            .clone()
            .map(|(id, name)| Hit { id, name })
    }

    fn id_at(&mut self, root: &str) -> Option<String> {
        self.at(root).map(|hit| hit.id)
    }
}

/// The id and name of the workspace at `root`. Only an absolute path counts —
/// an empty or relative one would resolve against the process's working
/// directory — so the other platform's paths (`C:\…` read on macOS) are
/// simply "not here".
fn read_identity(root: &str) -> Option<(String, String)> {
    let root = root.trim();
    if root.is_empty() || !Path::new(root).is_absolute() {
        return None;
    }
    let context = load_context(&WorkspacePaths::new(root).context_file()).ok()?;
    Some((context.workspace_id?, context.name))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workspace::teams::{add_edge, add_member, create_team, set_layout, set_prime, LayoutSkin, NodePos};

    /// A minimal workspace at `dir/<folder>` carrying `id` — enough for
    /// `load_context`, which is all the re-link reads.
    fn workspace(dir: &Path, folder: &str, id: &str) -> PathBuf {
        let root = dir.join(folder);
        std::fs::create_dir_all(root.join(".nextup")).unwrap();
        std::fs::write(
            root.join(".nextup").join("context.json"),
            format!(
                r#"{{"schemaVersion":1,"workspaceId":"{id}","name":"{folder}","domain":"general","createdAt":"2026-01-01T00:00:00Z","updatedAt":"2026-01-01T00:00:00Z"}}"#
            ),
        )
        .unwrap();
        root
    }

    fn entry(id: &str, root: &str) -> TeamMember {
        TeamMember { workspace_id: id.into(), root: root.into(), name: id.into() }
    }

    fn root_of(path: &Path, team: usize, id: &str) -> String {
        let teams = load_teams(path).unwrap().teams;
        let root = entries(&teams[team]).find(|m| m.workspace_id == id).unwrap().root.clone();
        root
    }

    fn set_updated_at(path: &Path, stamp: &str) {
        let mut file = load_teams(path).unwrap();
        for team in file.teams.iter_mut() {
            team.updated_at = stamp.into();
        }
        save(path, file).unwrap();
    }

    /// The other machine's paths: nothing on this one answers to them.
    fn elsewhere(id: &str) -> String {
        if cfg!(windows) { format!(r"Z:\elsewhere\{id}") } else { format!("/elsewhere/{id}") }
    }

    #[test]
    fn relink_finds_moved_members_and_prime_by_id_and_leaves_updated_at() {
        let dir = tempfile::tempdir().unwrap();
        let teams = dir.path().join("teams.json");
        let projects = dir.path().join("code");
        let a = workspace(&projects, "a", "id-a");
        workspace(&projects, "boss", "id-boss");
        let team = create_team(&teams, "flow").unwrap();
        add_member(&teams, &team.id, entry("id-a", &elsewhere("a"))).unwrap();
        add_member(&teams, &team.id, entry("id-gone", &elsewhere("gone"))).unwrap();
        set_prime(&teams, &team.id, Some(entry("id-boss", &elsewhere("boss")))).unwrap();
        set_updated_at(&teams, "2000-01-01T00:00:00Z");

        let found = workspace_folders_in(&projects).unwrap();
        let report = relink(&teams, &found).unwrap();

        assert_eq!(root_of(&teams, 0, "id-a"), a.display().to_string());
        assert_eq!(root_of(&teams, 0, "id-boss"), projects.join("boss").display().to_string());
        let names: Vec<&str> = report.relinked.iter().map(|r| r.name.as_str()).collect();
        assert_eq!(names, vec!["a", "boss"], "names come from the found folder");
        assert_eq!(report.missing.len(), 1);
        assert_eq!(report.missing[0].workspace_id, "id-gone");
        assert_eq!(root_of(&teams, 0, "id-gone"), elsewhere("gone"), "not found: the old path stays");
        assert_eq!(
            load_teams(&teams).unwrap().teams[0].updated_at,
            "2000-01-01T00:00:00Z",
            "a path is this machine's cache, not a change to the team"
        );
    }

    /// The same workspace in two teams is one finding, fixed in both; and a
    /// path already in the graph is a candidate for the other entries.
    #[test]
    fn relink_reports_per_workspace_and_borrows_known_paths() {
        let dir = tempfile::tempdir().unwrap();
        let teams = dir.path().join("teams.json");
        let a = workspace(dir.path(), "a", "id-a");
        let one = create_team(&teams, "one").unwrap();
        let two = create_team(&teams, "two").unwrap();
        add_member(&teams, &one.id, entry("id-a", &a.display().to_string())).unwrap();
        add_member(&teams, &two.id, entry("id-a", &elsewhere("a"))).unwrap();

        let report = relink(&teams, &[]).unwrap();
        assert_eq!(report.relinked.len(), 1);
        assert_eq!(root_of(&teams, 1, "id-a"), a.display().to_string(), "found where team one has it");

        let before = std::fs::read_to_string(&teams).unwrap();
        let again = relink(&teams, &[]).unwrap();
        assert_eq!(again, RelinkReport::default(), "nothing left to do");
        assert_eq!(std::fs::read_to_string(&teams).unwrap(), before, "and nothing written");
    }

    /// A folder that holds a *different* workspace is not this member's, even
    /// at the very path the member points to.
    #[test]
    fn relink_matches_by_id_not_by_path() {
        let dir = tempfile::tempdir().unwrap();
        let teams = dir.path().join("teams.json");
        let squatter = workspace(dir.path(), "a", "someone-else");
        let real = workspace(&dir.path().join("moved"), "a", "id-a");
        let team = create_team(&teams, "flow").unwrap();
        add_member(&teams, &team.id, entry("id-a", &squatter.display().to_string())).unwrap();

        relink(&teams, &[squatter.clone(), real.clone()]).unwrap();
        assert_eq!(root_of(&teams, 0, "id-a"), real.display().to_string());
    }

    #[test]
    fn relink_without_a_graph_creates_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let teams = dir.path().join("teams.json");
        assert_eq!(relink(&teams, &[]).unwrap(), RelinkReport::default());
        assert!(!teams.exists());
    }

    #[test]
    fn folder_scan_is_one_level_deep_and_includes_the_folder_itself() {
        let dir = tempfile::tempdir().unwrap();
        workspace(dir.path(), "top", "id-top");
        workspace(&dir.path().join("top"), "nested", "id-nested");
        workspace(dir.path(), "b", "id-b");
        std::fs::create_dir_all(dir.path().join("plain")).unwrap();

        let names = |found: Vec<PathBuf>| -> Vec<String> {
            found.iter().map(|p| p.file_name().unwrap().to_string_lossy().into_owned()).collect()
        };
        assert_eq!(names(workspace_folders_in(dir.path()).unwrap()), vec!["b", "top"]);
        assert_eq!(
            names(workspace_folders_in(&dir.path().join("top")).unwrap()),
            vec!["top", "nested"],
            "the picked folder first, then what is directly under it"
        );
        assert!(workspace_folders_in(&dir.path().join("nope")).is_err());
    }

    /// The whole trip: machine A exports, machine B (empty, other paths)
    /// imports, and the members are found under B's own folder.
    #[test]
    fn export_then_import_on_another_machine_relinks_by_id() {
        let a_dir = tempfile::tempdir().unwrap();
        let a_teams = a_dir.path().join("teams.json");
        let team = create_team(&a_teams, "research to dev").unwrap();
        add_member(&a_teams, &team.id, entry("id-r", &elsewhere("r"))).unwrap();
        add_member(&a_teams, &team.id, entry("id-d", &elsewhere("d"))).unwrap();
        add_edge(&a_teams, &team.id, "id-r", "id-d").unwrap();
        let mut pos = HashMap::new();
        pos.insert("id-r".to_string(), NodePos { x: 10.0, y: 20.0 });
        set_layout(&a_teams, &team.id, LayoutSkin::Star, pos).unwrap();
        let carried = a_dir.path().join("nextup-teams.json");
        assert_eq!(export_teams(&a_teams, &[team.id.clone()], &carried, "9.9.9").unwrap(), 1);

        let b_dir = tempfile::tempdir().unwrap();
        let b_teams = b_dir.path().join("teams.json");
        let code = b_dir.path().join("code");
        let r = workspace(&code, "r", "id-r");
        let d = workspace(&code, "d", "id-d");

        let preview = preview_import(&b_teams, &carried).unwrap();
        assert_eq!(preview.app_version, "9.9.9");
        assert_eq!(preview.teams[0].status, ImportStatus::New);
        assert_eq!((preview.teams[0].members, preview.teams[0].edges), (2, 1));

        let roots = candidate_roots(None, Some(code.as_path())).unwrap();
        let outcome = apply_import(&b_teams, &carried, &[team.id.clone()], &roots).unwrap();
        assert_eq!((outcome.added, outcome.replaced), (1, 0));
        assert_eq!(outcome.relink.relinked.len(), 2);
        assert!(outcome.relink.missing.is_empty());

        let landed = &load_teams(&b_teams).unwrap().teams[0];
        assert_eq!(landed.id, team.id, "the same team, not a copy — the next import updates it");
        assert_eq!(landed.edges.len(), 1);
        assert_eq!(landed.layout.len(), 1);
        assert_eq!(root_of(&b_teams, 0, "id-r"), r.display().to_string());
        assert_eq!(root_of(&b_teams, 0, "id-d"), d.display().to_string());

        assert_eq!(preview_import(&b_teams, &carried).unwrap().teams[0].status, ImportStatus::Same);
    }

    /// Taking the file's version replaces the team but keeps this machine's
    /// working paths; leaving a team out of `take` leaves it alone; a local
    /// team the file never mentions survives.
    #[test]
    fn import_replaces_only_what_was_taken_and_keeps_local_paths() {
        let dir = tempfile::tempdir().unwrap();
        let teams = dir.path().join("teams.json");
        let a = workspace(dir.path(), "a", "id-a");
        let one = create_team(&teams, "one").unwrap();
        let two = create_team(&teams, "two").unwrap();
        let local_only = create_team(&teams, "mine").unwrap();
        // Team one is the only place this machine records where id-a lives, so
        // once it is replaced nothing but the keep-local-paths step can know.
        add_member(&teams, &one.id, entry("id-a", &a.display().to_string())).unwrap();
        for id in [&one.id, &two.id] {
            add_member(&teams, id, entry("id-b", &elsewhere("b"))).unwrap();
        }
        let carried = dir.path().join("carried.json");
        export_teams(&teams, &[one.id.clone(), two.id.clone()], &carried, "1").unwrap();

        // The other machine renamed both, added an edge, and has its own paths.
        let mut export = read_export(&carried).unwrap();
        for t in export.teams.iter_mut() {
            t.name.push_str(" (from B)");
            for m in t.members.iter_mut().filter(|m| m.workspace_id == "id-a") {
                m.root = elsewhere("a");
            }
        }
        export.teams[0].edges.push(crate::workspace::teams::TeamEdge {
            from: "id-a".into(),
            to: "id-b".into(),
            auto_route: true,
        });
        atomic_write_json(&carried, &export).unwrap();

        let preview = preview_import(&teams, &carried).unwrap();
        assert!(preview.teams.iter().all(|r| r.status == ImportStatus::Differs));

        let outcome = apply_import(&teams, &carried, &[one.id.clone()], &[]).unwrap();
        assert_eq!((outcome.added, outcome.replaced), (0, 1));

        let after = load_teams(&teams).unwrap().teams;
        let names: Vec<&str> = after.iter().map(|t| t.name.as_str()).collect();
        assert_eq!(names, vec!["one (from B)", "two", "mine"]);
        assert!(after[0].edges[0].auto_route, "the file's version, switch included");
        assert_eq!(root_of(&teams, 0, "id-a"), a.display().to_string(), "the path that works here stays");
        assert_eq!(after[2].id, local_only.id);
    }

    #[test]
    fn a_file_that_is_not_a_team_file_is_refused_whole() {
        let dir = tempfile::tempdir().unwrap();
        let teams = dir.path().join("teams.json");
        let file = dir.path().join("x.json");

        std::fs::write(&file, r#"{"schemaVersion":1,"teams":[]}"#).unwrap();
        assert!(read_export(&file).unwrap_err().to_string().contains("not an Agent NextUp team file"));

        std::fs::write(&file, "not json").unwrap();
        assert_eq!(read_export(&file).unwrap_err().kind(), "invalid_input");

        std::fs::write(&file, r#"{"format":"nextup-teams","schemaVersion":2,"exportedAt":"x","teams":[]}"#).unwrap();
        assert!(read_export(&file).unwrap_err().to_string().contains("newer than this app"));

        // A hand edit that breaks a rule the commands enforce one write at a time.
        let team = create_team(&teams, "t").unwrap();
        add_member(&teams, &team.id, entry("id-a", "/a")).unwrap();
        add_member(&teams, &team.id, entry("id-b", "/b")).unwrap();
        export_teams(&teams, &[team.id.clone()], &file, "1").unwrap();
        let good = read_export(&file).unwrap();
        let cases: Vec<(&str, Box<dyn Fn(&mut Team)>)> = vec![
            ("itself", Box::new(|t| t.edges.push(crate::workspace::teams::TeamEdge { from: "id-a".into(), to: "id-a".into(), auto_route: false }))),
            ("not a member", Box::new(|t| t.edges.push(crate::workspace::teams::TeamEdge { from: "id-a".into(), to: "ghost".into(), auto_route: false }))),
            ("coordinator and member", Box::new(|t| t.prime = Some(entry("id-a", "/a")))),
            ("twice", Box::new(|t| t.members.push(entry("id-a", "/a")))),
            ("no name", Box::new(|t| t.name = " ".into())),
        ];
        for (needle, break_it) in cases {
            let mut bad = good.clone();
            break_it(&mut bad.teams[0]);
            atomic_write_json(&file, &bad).unwrap();
            let err = read_export(&file).unwrap_err().to_string();
            assert!(err.contains(needle), "{needle}: {err}");
            assert!(apply_import(&teams, &file, &[team.id.clone()], &[]).is_err(), "{needle}: refused whole");
        }

        let mut twice = good.clone();
        twice.teams.push(good.teams[0].clone());
        atomic_write_json(&file, &twice).unwrap();
        assert!(read_export(&file).unwrap_err().to_string().contains("twice"));
    }

    #[test]
    fn export_needs_known_teams_and_import_needs_listed_ones() {
        let dir = tempfile::tempdir().unwrap();
        let teams = dir.path().join("teams.json");
        let file = dir.path().join("out.json");
        let team = create_team(&teams, "t").unwrap();
        assert_eq!(export_teams(&teams, &[], &file, "1").unwrap_err().kind(), "invalid_input");
        assert_eq!(export_teams(&teams, &["ghost".into()], &file, "1").unwrap_err().kind(), "not_found");
        export_teams(&teams, &[team.id.clone()], &file, "1").unwrap();
        assert!(apply_import(&teams, &file, &["ghost".into()], &[]).is_err());
    }

    /// Canvas positions of ids that are not members are dropped, as
    /// `set_layout` does — not a reason to refuse the file.
    #[test]
    fn stray_layout_entries_are_dropped_on_read() {
        let dir = tempfile::tempdir().unwrap();
        let teams = dir.path().join("teams.json");
        let file = dir.path().join("out.json");
        let team = create_team(&teams, "t").unwrap();
        add_member(&teams, &team.id, entry("id-a", "/a")).unwrap();
        export_teams(&teams, &[team.id.clone()], &file, "1").unwrap();
        let mut export = read_export(&file).unwrap();
        export.teams[0].layout.insert("ghost".into(), NodePos { x: 1.0, y: 1.0 });
        export.teams[0].orbit_layout.insert("ghost".into(), NodePos { x: 1.0, y: 1.0 });
        atomic_write_json(&file, &export).unwrap();
        let read = read_export(&file).unwrap();
        assert!(read.teams[0].layout.is_empty() && read.teams[0].orbit_layout.is_empty());
    }
}
