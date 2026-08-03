//! App-level agent CLI catalog (D50): which terminal-launchable agent CLIs
//! exist, at `~/.nextup/agents.json`.
//!
//! Presets (claude / codex / gemini) are compiled in and immutable — the
//! file stores only custom entries (name + command + args), mirroring the
//! template split (D43: built-ins read-only, customs on disk). `installed`
//! is *computed* at read time by a PATH probe, never stored: whether a CLI
//! exists is a property of the machine, not of the catalog.
//!
//! This catalog only feeds the embedded terminal's launch menu. It is not a
//! trust surface: launching remains human-initiated, and a catalog entry
//! grants nothing an installed CLI does not already have.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::{NextUpError, Result};
use crate::workspace::atomic::atomic_write_json;

pub const AGENT_CATALOG_SCHEMA_VERSION: u32 = 1;

/// Preset launch entries. `id` doubles as the terminal session's `agentId`,
/// so these must stay stable once shipped. Beside the three agent CLIs sits
/// `shell` (D70): not an agent but a plain interactive shell, so a user can
/// open a normal terminal in a workspace without leaving the app — same PTY
/// machinery, no resume, no hub-identity semantics. The command a built-in
/// runs comes from `builtin_command`, not from this table, because `shell`'s
/// program is resolved per-OS at runtime.
pub const BUILTIN_AGENTS: &[(&str, &str)] = &[
    ("claude", "Claude Code"),
    ("codex", "Codex CLI"),
    ("gemini", "Gemini CLI"),
    ("shell", "Shell"),
];

/// The program a built-in launches. A CLI agent runs a command matching its
/// id; `shell` (D70) resolves the platform's interactive shell at runtime —
/// the one place in the app that picks a program by operating system.
fn builtin_command(id: &str) -> String {
    match id {
        "shell" => default_shell(),
        cli => cli.to_string(),
    }
}

/// The interactive shell the built-in `shell` entry launches (D70). Respects
/// the user's environment where a convention for it exists: `$SHELL` on Unix
/// (their login shell, e.g. `/bin/zsh`) when it points to a real program,
/// PowerShell on Windows (`pwsh` if it is installed, else the always-present
/// Windows PowerShell). In every case it falls back to a shell guaranteed to
/// exist so the entry is never dead on arrival. The returned name is fed to
/// `resolve_program` like any other command, so both a bare name (`pwsh`) and
/// an absolute `$SHELL` path resolve correctly.
fn default_shell() -> String {
    if cfg!(windows) {
        if resolve_program("pwsh").is_some() {
            "pwsh".to_string()
        } else {
            "powershell".to_string()
        }
    } else {
        // Prefer the login shell, but only when it still resolves: a stale
        // `$SHELL` (login shell removed, or a value leaked in from another
        // machine) must fall back to a shell that exists rather than grey the
        // launch button out. This mirrors the Windows branch's probe of `pwsh`
        // before settling.
        std::env::var("SHELL")
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty() && resolve_program(s).is_some())
            .unwrap_or_else(|| "/bin/sh".to_string())
    }
}

/// Resume-launch args for the built-in agents (B16-B): the flag/subcommand
/// that makes the CLI reattach the most recent conversation in its cwd, from
/// disk, without the original process still running — so a terminal restored
/// read-only after an app restart can become live again (the Resume action). All
/// three are cwd-scoped, so no session id is needed (Agent NextUp already spawns
/// with cwd = workspace root). `None` = no known resume path (every custom
/// agent, and any unknown id), in which case resuming is simply not offered.
///
/// The forms differ (verified against each CLI's docs, 2026-07): claude and
/// gemini take a flag, but codex takes a `resume` *subcommand* that must come
/// first — which is exactly why a single "append this flag" field would not
/// cover all three (05 D67). These fully replace the (empty) preset args on a
/// resume launch rather than appending, so the subcommand lands in position.
pub fn builtin_resume_args(agent_id: &str) -> Option<Vec<String>> {
    let args: &[&str] = match agent_id {
        "claude" => &["--continue"],
        "codex" => &["resume", "--last"],
        "gemini" => &["--resume"],
        _ => return None,
    };
    Some(args.iter().map(|s| s.to_string()).collect())
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentCatalogFile {
    #[serde(default)]
    pub schema_version: u32,
    #[serde(default)]
    pub agents: Vec<CustomAgent>,
}

/// One user-defined agent CLI entry as stored on disk.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CustomAgent {
    pub id: String,
    pub title: String,
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    /// Extra environment variables handed to the CLI at launch (D56) — e.g.
    /// `ANTHROPIC_BASE_URL` / `OPENAI_BASE_URL` to point an agent CLI at a
    /// local LLM endpoint without touching the system environment. The PTY
    /// already inherits the app's environment; these override/augment it.
    /// Empty is not written to disk (sorted key order for a stable file).
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub env: BTreeMap<String, String>,
}

/// Catalog entry as surfaced to the GUI and the terminal launcher:
/// preset/custom unified, with the machine-local install probe attached.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentInfo {
    pub id: String,
    pub title: String,
    pub command: String,
    pub args: Vec<String>,
    /// Launch-time env overrides (D56); empty for presets. Always serialized
    /// (unlike the on-disk form) so the GUI editor can round-trip it.
    pub env: BTreeMap<String, String>,
    pub builtin: bool,
    /// Whether `command` resolves on PATH right now (launch menus grey out
    /// uninstalled CLIs instead of failing after a click).
    pub installed: bool,
    /// Whether this agent has a known "resume the last conversation" launch
    /// (B16-B): the built-ins do, custom agents do not. Drives the "Resume"
    /// action offered on a restored or exited terminal tab.
    pub resumable: bool,
}

pub fn default_agent_catalog_path() -> Option<PathBuf> {
    dirs::home_dir().map(|home| home.join(".nextup").join("agents.json"))
}

pub fn load_catalog(path: &Path) -> Result<AgentCatalogFile> {
    if !path.is_file() {
        return Ok(AgentCatalogFile {
            schema_version: AGENT_CATALOG_SCHEMA_VERSION,
            agents: Vec::new(),
        });
    }
    super::atomic::read_json_file(path)
}

fn save(path: &Path, mut file: AgentCatalogFile) -> Result<()> {
    file.schema_version = AGENT_CATALOG_SCHEMA_VERSION;
    atomic_write_json(path, &file)
}

fn info(
    id: &str,
    title: &str,
    command: &str,
    args: Vec<String>,
    env: BTreeMap<String, String>,
    builtin: bool,
) -> AgentInfo {
    AgentInfo {
        id: id.to_string(),
        title: title.to_string(),
        command: command.to_string(),
        args,
        env,
        builtin,
        installed: resolve_program(command).is_some(),
        resumable: builtin_resume_args(id).is_some(),
    }
}

/// Presets first (stable order), then customs in file order.
pub fn list_agents(path: &Path) -> Result<Vec<AgentInfo>> {
    let mut agents: Vec<AgentInfo> = BUILTIN_AGENTS
        .iter()
        .map(|(id, title)| {
            info(id, title, &builtin_command(id), Vec::new(), BTreeMap::new(), true)
        })
        .collect();
    for custom in load_catalog(path)?.agents {
        agents.push(info(
            &custom.id,
            &custom.title,
            &custom.command,
            custom.args.clone(),
            custom.env.clone(),
            false,
        ));
    }
    Ok(agents)
}

pub fn find_agent(path: &Path, id: &str) -> Result<AgentInfo> {
    list_agents(path)?
        .into_iter()
        .find(|a| a.id == id)
        .ok_or_else(|| NextUpError::NotFound(format!("no agent with id {id}")))
}

fn is_builtin_id(id: &str) -> bool {
    BUILTIN_AGENTS.iter().any(|(builtin_id, _)| *builtin_id == id)
}

/// Same character set as custom template ids (D43): these ids end up in
/// session metadata and event payloads, so keep them boring.
fn validate_id(id: &str) -> Result<()> {
    let ok_charset = id.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
    if id.is_empty() || id.len() > 64 || !ok_charset {
        return Err(NextUpError::InvalidInput(format!(
            "agent id must be 1-64 chars of a-z, 0-9 or hyphen, got {id:?}"
        )));
    }
    Ok(())
}

/// Trim and validate env entries (D56): blank-key rows are dropped (like
/// blank args from empty form fields), and a name carrying whitespace, `=`
/// or control chars is rejected — it could never be a real variable and
/// would corrupt the child's environment block. Values keep their content
/// (only surrounding whitespace trimmed); a null byte is refused because it
/// terminates the env block early.
fn sanitize_env(env: BTreeMap<String, String>) -> Result<BTreeMap<String, String>> {
    let mut out = BTreeMap::new();
    for (key, value) in env {
        let key = key.trim().to_string();
        if key.is_empty() {
            continue;
        }
        if key.contains('=') || key.chars().any(|c| c.is_whitespace() || c.is_control()) {
            return Err(NextUpError::InvalidInput(format!(
                "env var name must have no spaces, '=' or control chars, got {key:?}"
            )));
        }
        if value.contains('\0') {
            return Err(NextUpError::InvalidInput(format!(
                "env value for {key} contains a null byte"
            )));
        }
        out.insert(key, value.trim().to_string());
    }
    Ok(out)
}

/// Insert or update a custom agent. Preset ids are reserved — presets are
/// immutable, and shadowing one would silently change what a launch button
/// does.
pub fn save_custom_agent(path: &Path, agent: CustomAgent) -> Result<()> {
    let agent = CustomAgent {
        id: agent.id.trim().to_string(),
        title: agent.title.trim().to_string(),
        command: agent.command.trim().to_string(),
        args: agent
            .args
            .into_iter()
            .map(|a| a.trim().to_string())
            .filter(|a| !a.is_empty())
            .collect(),
        env: sanitize_env(agent.env)?,
    };
    validate_id(&agent.id)?;
    if is_builtin_id(&agent.id) {
        return Err(NextUpError::InvalidInput(format!(
            "{} is a built-in agent and cannot be overridden",
            agent.id
        )));
    }
    if agent.title.is_empty() {
        return Err(NextUpError::InvalidInput("agent title cannot be empty".into()));
    }
    if agent.command.is_empty() {
        return Err(NextUpError::InvalidInput("agent command cannot be empty".into()));
    }
    let mut file = load_catalog(path)?;
    match file.agents.iter_mut().find(|a| a.id == agent.id) {
        Some(existing) => *existing = agent,
        None => file.agents.push(agent),
    }
    save(path, file)
}

pub fn delete_custom_agent(path: &Path, id: &str) -> Result<()> {
    if is_builtin_id(id) {
        return Err(NextUpError::InvalidInput(format!("built-in agent {id} cannot be removed")));
    }
    let mut file = load_catalog(path)?;
    let before = file.agents.len();
    file.agents.retain(|a| a.id != id);
    if file.agents.len() == before {
        return Err(NextUpError::NotFound(format!("no custom agent with id {id}")));
    }
    save(path, file)
}

/// Locate `name` the way a shell would: PATH walk plus Windows launcher
/// extensions. Returns the first existing file, so `.cmd` npm shims are
/// found even though they later need the cmd.exe host to run.
pub fn resolve_program(name: &str) -> Option<PathBuf> {
    let direct = Path::new(name);
    if direct.is_absolute() {
        return candidate_file(direct);
    }
    let path_var = std::env::var_os("PATH")?;
    std::env::split_paths(&path_var)
        .filter(|dir| !dir.as_os_str().is_empty())
        .find_map(|dir| candidate_file(&dir.join(name)))
}

fn candidate_file(candidate: &Path) -> Option<PathBuf> {
    if candidate.is_file() {
        return Some(candidate.to_path_buf());
    }
    for ext in ["exe", "cmd", "bat", "com"] {
        let with_ext = candidate.with_extension(ext);
        if with_ext.is_file() {
            return Some(with_ext);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn catalog_path(dir: &tempfile::TempDir) -> PathBuf {
        dir.path().join("agents.json")
    }

    fn custom(id: &str) -> CustomAgent {
        CustomAgent {
            id: id.into(),
            title: format!("Agent {id}"),
            command: "some-cli".into(),
            args: vec!["--flag".into()],
            env: BTreeMap::new(),
        }
    }

    #[test]
    fn missing_file_lists_exactly_the_presets() {
        let dir = tempfile::tempdir().unwrap();
        let agents = list_agents(&catalog_path(&dir)).unwrap();
        assert_eq!(agents.len(), BUILTIN_AGENTS.len());
        assert!(agents.iter().all(|a| a.builtin));
        assert!(agents.iter().all(|a| a.env.is_empty()), "presets carry no env");
        assert_eq!(agents[0].id, "claude");
    }

    /// B16-B: each built-in resumes with its own form — claude/gemini a flag,
    /// codex a `resume` subcommand that must come first — and unknown/custom
    /// ids have no resume path.
    #[test]
    fn builtin_resume_args_are_per_agent_and_none_for_others() {
        assert_eq!(builtin_resume_args("claude"), Some(vec!["--continue".to_string()]));
        assert_eq!(
            builtin_resume_args("codex"),
            Some(vec!["resume".to_string(), "--last".to_string()]),
            "codex resume is a subcommand, positioned first"
        );
        assert_eq!(builtin_resume_args("gemini"), Some(vec!["--resume".to_string()]));
        assert_eq!(builtin_resume_args("mytool"), None, "custom/unknown agents have no resume");
    }

    /// B16-B / D70: `resumable` is computed, so the GUI reads one source of
    /// truth instead of re-listing the built-in ids (which has drifted before,
    /// D63). The three CLI presets resume; the built-in `shell` (a plain
    /// terminal, no conversation to reattach) and every custom agent do not —
    /// so "built-in" alone no longer implies "resumable".
    #[test]
    fn cli_presets_resume_shell_and_customs_do_not() {
        let dir = tempfile::tempdir().unwrap();
        let path = catalog_path(&dir);
        save_custom_agent(&path, custom("mytool")).unwrap();
        let agents = list_agents(&path).unwrap();
        for id in ["claude", "codex", "gemini"] {
            assert!(
                agents.iter().find(|a| a.id == id).unwrap().resumable,
                "CLI preset {id} is resumable"
            );
        }
        assert!(
            !agents.iter().find(|a| a.id == "shell").unwrap().resumable,
            "the built-in shell has no conversation to resume"
        );
        assert!(
            !agents.iter().find(|a| a.id == "mytool").unwrap().resumable,
            "a custom agent is not resumable"
        );
    }

    /// D70: the built-in shell is always listed, is a plain terminal (not
    /// resumable), and resolves to a real program on this machine so its
    /// launch button is never greyed out. Its command is filled in per-OS at
    /// read time rather than stored in `BUILTIN_AGENTS`.
    #[test]
    fn builtin_shell_is_present_installed_and_not_resumable() {
        let dir = tempfile::tempdir().unwrap();
        let shell = list_agents(&catalog_path(&dir))
            .unwrap()
            .into_iter()
            .find(|a| a.id == "shell")
            .expect("shell is a built-in");
        assert!(shell.builtin);
        assert!(!shell.resumable, "a shell has no conversation to resume");
        assert!(!shell.command.is_empty(), "command is resolved per-OS, not blank");
        assert!(shell.installed, "the resolved default shell must exist on this machine");
    }

    #[test]
    fn custom_env_roundtrips_trimmed_and_empty_is_not_written() {
        let dir = tempfile::tempdir().unwrap();
        let path = catalog_path(&dir);

        // No env → the on-disk file must not carry an "env" key at all.
        save_custom_agent(&path, custom("plain")).unwrap();
        let raw = std::fs::read_to_string(&path).unwrap();
        assert!(!raw.contains("\"env\""), "empty env must not be serialized, got: {raw}");
        assert!(find_agent(&path, "plain").unwrap().env.is_empty());

        // With env → survives the roundtrip, trimmed; blank-key rows dropped.
        let mut withenv = custom("local-claude");
        withenv.env = BTreeMap::from([
            ("ANTHROPIC_BASE_URL".to_string(), "  http://localhost:8080 ".to_string()),
            ("   ".to_string(), "orphan".to_string()),
        ]);
        save_custom_agent(&path, withenv).unwrap();
        let got = find_agent(&path, "local-claude").unwrap();
        assert_eq!(got.env.len(), 1, "blank-key row is dropped");
        assert_eq!(got.env.get("ANTHROPIC_BASE_URL").unwrap(), "http://localhost:8080");
    }

    #[test]
    fn invalid_env_names_are_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let path = catalog_path(&dir);
        for bad in ["HAS SPACE", "HAS=EQ", "tab\tname"] {
            let mut agent = custom("ok");
            agent.env = BTreeMap::from([(bad.to_string(), "v".to_string())]);
            assert_eq!(
                save_custom_agent(&path, agent).unwrap_err().kind(),
                "invalid_input",
                "should reject env name {bad:?}"
            );
        }
    }

    #[test]
    fn custom_agent_roundtrip_upsert_and_delete() {
        let dir = tempfile::tempdir().unwrap();
        let path = catalog_path(&dir);
        save_custom_agent(&path, custom("my-cli")).unwrap();

        let agents = list_agents(&path).unwrap();
        assert_eq!(agents.len(), BUILTIN_AGENTS.len() + 1);
        let mine = agents.iter().find(|a| a.id == "my-cli").unwrap();
        assert!(!mine.builtin);
        assert_eq!(mine.args, vec!["--flag".to_string()]);

        // Upsert edits in place — no duplicate entry.
        let mut edited = custom("my-cli");
        edited.title = "Renamed".into();
        save_custom_agent(&path, edited).unwrap();
        let agents = list_agents(&path).unwrap();
        assert_eq!(agents.len(), BUILTIN_AGENTS.len() + 1);
        assert_eq!(find_agent(&path, "my-cli").unwrap().title, "Renamed");

        delete_custom_agent(&path, "my-cli").unwrap();
        assert_eq!(list_agents(&path).unwrap().len(), BUILTIN_AGENTS.len());
        assert_eq!(delete_custom_agent(&path, "my-cli").unwrap_err().kind(), "not_found");
    }

    #[test]
    fn presets_cannot_be_shadowed_or_removed() {
        let dir = tempfile::tempdir().unwrap();
        let path = catalog_path(&dir);
        let err = save_custom_agent(&path, custom("claude")).unwrap_err();
        assert_eq!(err.kind(), "invalid_input");
        let err = delete_custom_agent(&path, "claude").unwrap_err();
        assert_eq!(err.kind(), "invalid_input");
    }

    #[test]
    fn ids_and_fields_are_validated() {
        let dir = tempfile::tempdir().unwrap();
        let path = catalog_path(&dir);
        for bad_id in ["", "Has Space", "UPPER", "läuft", &"x".repeat(65)] {
            let mut agent = custom("ok");
            agent.id = bad_id.to_string();
            assert_eq!(save_custom_agent(&path, agent).unwrap_err().kind(), "invalid_input");
        }
        let mut untitled = custom("ok");
        untitled.title = "  ".into();
        assert_eq!(save_custom_agent(&path, untitled).unwrap_err().kind(), "invalid_input");
        let mut no_command = custom("ok");
        no_command.command = "".into();
        assert_eq!(save_custom_agent(&path, no_command).unwrap_err().kind(), "invalid_input");
        // Blank arg entries (empty form fields) are dropped, not stored.
        let mut gappy = custom("ok");
        gappy.args = vec!["  ".into(), "--real".into()];
        save_custom_agent(&path, gappy).unwrap();
        assert_eq!(find_agent(&path, "ok").unwrap().args, vec!["--real".to_string()]);
    }

    #[test]
    fn install_probe_reflects_path_reality() {
        let dir = tempfile::tempdir().unwrap();
        let path = catalog_path(&dir);
        let mut real = custom("real-cli");
        // A command that exists on every supported platform's PATH.
        real.command = if cfg!(windows) { "cmd" } else { "sh" }.to_string();
        save_custom_agent(&path, real).unwrap();
        let mut ghost = custom("ghost-cli");
        ghost.command = "definitely-not-a-real-command-nextup".into();
        save_custom_agent(&path, ghost).unwrap();

        let agents = list_agents(&path).unwrap();
        assert!(agents.iter().find(|a| a.id == "real-cli").unwrap().installed);
        assert!(!agents.iter().find(|a| a.id == "ghost-cli").unwrap().installed);
    }
}
