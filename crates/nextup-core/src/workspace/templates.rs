use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use serde::{Deserialize, Serialize};

use crate::error::{NextUpError, Result};
use crate::workspace::workflow::{Gate, Phase};

/// A workflow template: the *shape* of an execution harness before it is
/// instantiated into a project. Templates are pure data (JSON) — new project
/// types plug in without recompiling (design principle 2). Built-ins are
/// embedded at compile time from `templates/*.json` using the exact same
/// schema user-provided templates use.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowTemplate {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub domain_hint: String,
    pub phases: Vec<Phase>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TemplateSource {
    BuiltIn,
    Custom,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TemplateSummary {
    pub id: String,
    pub name: String,
    pub description: String,
    pub domain_hint: String,
    pub phase_count: usize,
    pub source: TemplateSource,
}

pub const DEFAULT_TEMPLATE_ID: &str = "generic-v1";

/// Language of the built-in template *content* (names, phase descriptions,
/// AI instructions, gate prompts). Ids are language-invariant: `generic-v1`
/// is the same template in every language, so shadowing, the read-only-id
/// check and workflow.json instantiation all stay lang-agnostic. Custom
/// templates are user-authored in whatever language they wrote them in and
/// are never touched by this switch.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum TemplateLang {
    #[default]
    En,
    ZhTw,
}

impl TemplateLang {
    /// Map a UI language tag (i18next-style, e.g. "en", "zh-TW") to a
    /// template language. **Only an explicit zh tag selects zh-TW**; absent
    /// and unknown tags fall back to English, matching the app's own
    /// `fallbackLng` (D81).
    ///
    /// This fallback used to be zh-TW — the app's original content language —
    /// and it outlived the switch by two releases (D104). The workspace
    /// material an agent reads (protocol, guide, module guides) is
    /// English-only, so a caller that passed no tag produced a workspace
    /// whose phase instructions and gate prompts were the one thing in it not
    /// in the language of everything around them. Headless callers
    /// (`init_blank`, adoption, tests) are exactly the ones that pass no tag.
    pub fn from_tag(tag: Option<&str>) -> Self {
        match tag {
            Some(t) if t.trim().to_ascii_lowercase().starts_with("zh") => TemplateLang::ZhTw,
            _ => TemplateLang::En,
        }
    }
}

const BUILT_IN_SOURCES_ZH: [(&str, &str); 5] = [
    ("generic", include_str!("../../templates/generic.json")),
    ("coding", include_str!("../../templates/coding.json")),
    ("research", include_str!("../../templates/research.json")),
    ("business", include_str!("../../templates/business.json")),
    ("life", include_str!("../../templates/life.json")),
];

const BUILT_IN_SOURCES_EN: [(&str, &str); 5] = [
    ("en/generic", include_str!("../../templates/en/generic.json")),
    ("en/coding", include_str!("../../templates/en/coding.json")),
    ("en/research", include_str!("../../templates/en/research.json")),
    ("en/business", include_str!("../../templates/en/business.json")),
    ("en/life", include_str!("../../templates/en/life.json")),
];

/// Parse-once cache of the embedded templates for one language. Built-ins
/// failing to parse or validate is a build defect — surfaced as an error,
/// never a panic.
pub fn built_in_templates(lang: TemplateLang) -> Result<&'static [WorkflowTemplate]> {
    static CACHE_ZH: OnceLock<Vec<WorkflowTemplate>> = OnceLock::new();
    static CACHE_EN: OnceLock<Vec<WorkflowTemplate>> = OnceLock::new();
    let (cache, sources) = match lang {
        TemplateLang::ZhTw => (&CACHE_ZH, &BUILT_IN_SOURCES_ZH),
        TemplateLang::En => (&CACHE_EN, &BUILT_IN_SOURCES_EN),
    };
    if cache.get().is_none() {
        let mut parsed = Vec::with_capacity(sources.len());
        for (file, src) in sources {
            let template: WorkflowTemplate = serde_json::from_str(src).map_err(|e| {
                NextUpError::Workspace(format!("built-in template '{file}' is invalid JSON: {e}"))
            })?;
            validate_template(&template).map_err(|e| {
                NextUpError::Workspace(format!("built-in template '{file}' failed validation: {e}"))
            })?;
            parsed.push(template);
        }
        let _ = cache.set(parsed); // lost race with another thread is fine
    }
    Ok(cache.get().map(|v| v.as_slice()).unwrap_or(&[]))
}

/// Default location for user-authored templates: `~/.nextup/templates/*.json`.
/// Dropping a JSON file there adds a project type — no recompile.
pub fn default_custom_dir() -> Option<PathBuf> {
    dirs::home_dir().map(|home| home.join(".nextup").join("templates"))
}

/// Load user templates from a directory. Invalid files are skipped (returned
/// in the second element for diagnostics) instead of failing the whole list.
pub fn load_custom_templates(dir: &Path) -> Result<(Vec<WorkflowTemplate>, Vec<String>)> {
    let mut templates = Vec::new();
    let mut skipped = Vec::new();
    if !dir.is_dir() {
        return Ok((templates, skipped));
    }
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let file_name = path.file_name().map(|n| n.to_string_lossy().into_owned());
        let file_name = file_name.unwrap_or_else(|| path.display().to_string());
        let Ok(raw) = std::fs::read_to_string(&path) else {
            skipped.push(format!("{file_name}: unreadable"));
            continue;
        };
        match serde_json::from_str::<WorkflowTemplate>(&raw) {
            Ok(template) => match validate_template(&template) {
                Ok(()) => templates.push(template),
                Err(e) => skipped.push(format!("{file_name}: {e}")),
            },
            Err(e) => skipped.push(format!("{file_name}: invalid JSON: {e}")),
        }
    }
    Ok((templates, skipped))
}

/// All available templates. Custom templates shadow built-ins with the same
/// id so users can override the defaults without touching the app.
pub fn all_templates(
    custom_dir: Option<&Path>,
    lang: TemplateLang,
) -> Result<Vec<(WorkflowTemplate, TemplateSource)>> {
    Ok(all_templates_with_diagnostics(custom_dir, lang)?.0)
}

/// Like [`all_templates`], but also returns the skipped-file diagnostics from
/// [`load_custom_templates`] so "why is my template missing" is answerable.
pub fn all_templates_with_diagnostics(
    custom_dir: Option<&Path>,
    lang: TemplateLang,
) -> Result<(Vec<(WorkflowTemplate, TemplateSource)>, Vec<String>)> {
    let (customs, skipped) = match custom_dir {
        Some(dir) => load_custom_templates(dir)?,
        None => (Vec::new(), Vec::new()),
    };
    let mut result: Vec<(WorkflowTemplate, TemplateSource)> = customs
        .into_iter()
        .map(|t| (t, TemplateSource::Custom))
        .collect();
    for template in built_in_templates(lang)? {
        if !result.iter().any(|(t, _)| t.id == template.id) {
            result.push((template.clone(), TemplateSource::BuiltIn));
        }
    }
    Ok((result, skipped))
}

pub fn template_summaries(
    custom_dir: Option<&Path>,
    lang: TemplateLang,
) -> Result<Vec<TemplateSummary>> {
    Ok(all_templates(custom_dir, lang)?
        .into_iter()
        .map(|(t, source)| TemplateSummary {
            id: t.id,
            name: t.name,
            description: t.description,
            domain_hint: t.domain_hint,
            phase_count: t.phases.len(),
            source,
        })
        .collect())
}

/// Resolve a template id (or the default) against built-ins + customs.
/// An unknown id reports any custom files that were skipped — the id the user
/// asked for is often in one of them, and "unknown template" alone would
/// point them the wrong way.
pub fn resolve_template(
    id: Option<&str>,
    custom_dir: Option<&Path>,
    lang: TemplateLang,
) -> Result<WorkflowTemplate> {
    let wanted = id.map(str::trim).filter(|s| !s.is_empty()).unwrap_or(DEFAULT_TEMPLATE_ID);
    let (available, skipped) = all_templates_with_diagnostics(custom_dir, lang)?;
    available
        .iter()
        .find(|(t, _)| t.id == wanted)
        .map(|(t, _)| t.clone())
        .ok_or_else(|| {
            let ids: Vec<&str> = available.iter().map(|(t, _)| t.id.as_str()).collect();
            let mut msg = format!(
                "unknown workflow template '{wanted}' (available: {})",
                ids.join(", ")
            );
            if !skipped.is_empty() {
                msg.push_str(&format!(
                    "; {} custom template file(s) were skipped: {}",
                    skipped.len(),
                    skipped.join("; ")
                ));
            }
            NextUpError::InvalidInput(msg)
        })
}

/// Save (create or update) a user-authored template in `dir` (D43, the GUI
/// template editor's write path). Rules beyond [`validate_template`]:
/// - Built-in ids are rejected: built-ins are read-only in the GUI — a future
///   language switch swaps built-ins wholesale, so custom files must not sit
///   on their ids. (Hand-dropped files can still shadow; that power-user path
///   does not go through here.)
/// - The id doubles as the file name, so it must be filesystem-safe
///   ([`validate_custom_id`]).
/// - If some custom file already holds this id (under any file name), that
///   file is overwritten in place — never a second file for the same id.
pub fn save_custom_template(dir: &Path, template: &WorkflowTemplate) -> Result<()> {
    validate_template(template)?;
    validate_custom_id(&template.id)?;
    // Ids are language-invariant, so one language's id set speaks for all
    // (asserted by the built_in_ids_are_language_invariant test).
    if built_in_templates(TemplateLang::ZhTw)?.iter().any(|t| t.id == template.id) {
        return Err(NextUpError::InvalidInput(format!(
            "'{}' is a built-in template id — built-ins are read-only, save under a new id",
            template.id
        )));
    }
    std::fs::create_dir_all(dir)?;
    let target = custom_file_holding_id(dir, &template.id)?
        .unwrap_or_else(|| dir.join(format!("{}.json", template.id)));
    let mut body = serde_json::to_vec_pretty(template)?;
    body.push(b'\n');
    super::atomic::atomic_write(&target, &body)?;
    Ok(())
}

/// Delete the custom template holding `id`. Built-ins are not files and are
/// never deletable; an id found only among built-ins reports as such.
pub fn delete_custom_template(dir: &Path, id: &str) -> Result<()> {
    match custom_file_holding_id(dir, id)? {
        Some(path) => Ok(std::fs::remove_file(path)?),
        None => {
            if built_in_templates(TemplateLang::ZhTw)?.iter().any(|t| t.id == id) {
                return Err(NextUpError::InvalidInput(format!(
                    "'{id}' is a built-in template — it cannot be deleted"
                )));
            }
            Err(NextUpError::NotFound(format!("no custom template with id '{id}'")))
        }
    }
}

/// The file name is the load contract's public face: ids written by the GUI
/// must be safe as file names and stable across platforms. Hand-authored
/// files keep their freedom — this only gates the write API. Rule shared
/// with spec capability names via `ids::is_valid_slug` (D79).
fn validate_custom_id(id: &str) -> Result<()> {
    if crate::workspace::ids::is_valid_slug(id) {
        Ok(())
    } else {
        Err(NextUpError::InvalidInput(format!(
            "template id '{id}' must be {}",
            crate::workspace::ids::SLUG_RULE
        )))
    }
}

/// Locate the custom file whose *parsed* id matches — file names are not
/// trusted to equal ids (users may hand-author freely named files).
fn custom_file_holding_id(dir: &Path, id: &str) -> Result<Option<PathBuf>> {
    if !dir.is_dir() {
        return Ok(None);
    }
    for entry in std::fs::read_dir(dir)? {
        let path = entry?.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let Ok(raw) = std::fs::read_to_string(&path) else { continue };
        if let Ok(t) = serde_json::from_str::<WorkflowTemplate>(&raw) {
            if t.id == id {
                return Ok(Some(path));
            }
        }
    }
    Ok(None)
}

/// Structural validation shared by built-ins and user templates.
pub fn validate_template(template: &WorkflowTemplate) -> Result<()> {
    if template.id.trim().is_empty() {
        return Err(NextUpError::InvalidInput("template id cannot be empty".into()));
    }
    if template.name.trim().is_empty() {
        return Err(NextUpError::InvalidInput("template name cannot be empty".into()));
    }
    if template.phases.is_empty() {
        return Err(NextUpError::InvalidInput("template must define at least one phase".into()));
    }
    let mut seen = std::collections::BTreeSet::new();
    for phase in &template.phases {
        let id = phase.id.trim();
        if id.is_empty() {
            return Err(NextUpError::InvalidInput("phase id cannot be empty".into()));
        }
        if !seen.insert(id.to_string()) {
            return Err(NextUpError::InvalidInput(format!("duplicate phase id '{id}'")));
        }
        if phase.title.trim().is_empty() {
            return Err(NextUpError::InvalidInput(format!("phase '{id}' needs a title")));
        }
        for gate in &phase.exit_gates {
            validate_gate(id, gate)?;
        }
    }
    Ok(())
}

fn validate_gate(phase_id: &str, gate: &Gate) -> Result<()> {
    match gate {
        Gate::MinTasks { count } | Gate::MinDecisions { count } => {
            if *count == 0 {
                return Err(NextUpError::InvalidInput(format!(
                    "phase '{phase_id}': gate count must be >= 1"
                )));
            }
        }
        Gate::ArtifactExists { path } => {
            let p = Path::new(path);
            let unsafe_path = path.trim().is_empty()
                || p.is_absolute()
                || p.components().any(|c| matches!(c, std::path::Component::ParentDir));
            if unsafe_path {
                return Err(NextUpError::InvalidInput(format!(
                    "phase '{phase_id}': artifact path must be relative and stay inside the workspace"
                )));
            }
        }
        Gate::ManualConfirm { prompt } => {
            if prompt.trim().is_empty() {
                return Err(NextUpError::InvalidInput(format!(
                    "phase '{phase_id}': manual_confirm needs a prompt"
                )));
            }
        }
        Gate::AllTasksDone | Gate::NoBlockedTasks | Gate::DoctorClean => {}
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn built_ins_parse_and_validate() {
        for lang in [TemplateLang::ZhTw, TemplateLang::En] {
            let templates = built_in_templates(lang).unwrap();
            assert_eq!(templates.len(), 5);
            let ids: Vec<&str> = templates.iter().map(|t| t.id.as_str()).collect();
            assert!(ids.contains(&"generic-v1"));
            assert!(ids.contains(&"coding-v1"));
            for template in templates {
                assert!(!template.phases.is_empty());
            }
        }
    }

    /// The read-only-id check and shadowing rely on this invariance; gates
    /// must be semantically identical across languages — only display text
    /// (names, descriptions, instructions, manual_confirm prompts) may vary.
    #[test]
    fn built_in_ids_are_language_invariant() {
        // A gate with its human-facing prompt text blanked: what remains
        // (kind + structural params) must match across languages.
        fn gate_shape(g: &Gate) -> serde_json::Value {
            let mut v = serde_json::to_value(g).unwrap();
            if let Some(obj) = v.as_object_mut() {
                obj.remove("prompt");
            }
            v
        }
        let zh = built_in_templates(TemplateLang::ZhTw).unwrap();
        let en = built_in_templates(TemplateLang::En).unwrap();
        let zh_ids: Vec<&str> = zh.iter().map(|t| t.id.as_str()).collect();
        let en_ids: Vec<&str> = en.iter().map(|t| t.id.as_str()).collect();
        assert_eq!(zh_ids, en_ids);
        for (z, e) in zh.iter().zip(en.iter()) {
            let z_phases: Vec<&str> = z.phases.iter().map(|p| p.id.as_str()).collect();
            let e_phases: Vec<&str> = e.phases.iter().map(|p| p.id.as_str()).collect();
            assert_eq!(z_phases, e_phases, "phase ids of '{}' must match across languages", z.id);
            assert_eq!(z.domain_hint, e.domain_hint);
            for (zp, ep) in z.phases.iter().zip(e.phases.iter()) {
                let z_gates: Vec<_> = zp.exit_gates.iter().map(gate_shape).collect();
                let e_gates: Vec<_> = ep.exit_gates.iter().map(gate_shape).collect();
                assert_eq!(
                    z_gates, e_gates,
                    "gates of '{}/{}' must match across languages (prompt text aside)",
                    z.id, zp.id
                );
                // Wording is free to differ; the number of directives is not.
                // Adding an instruction to one language and forgetting the
                // other is the exact upkeep cost 15 §9 named as the blocker
                // for wiring the spec workflow in here (D105) — so it is
                // machine-checked rather than left to the next editor.
                assert_eq!(
                    zp.ai_instructions.len(),
                    ep.ai_instructions.len(),
                    "aiInstructions of '{}/{}' must match in count across languages",
                    z.id,
                    zp.id
                );
            }
        }
    }

    /// The spec layer's *entry* rests on this prompt and nothing else (D105):
    /// no gate, no doctor check and no archive step ever asks whether a delta
    /// was written. So the three domains whose work can change how something
    /// behaves must name `validate_task_specs` in the phase where the work
    /// actually happens — in both languages, or half the users lose it.
    /// (`research` and `life` are deliberately absent: no system behaviour.)
    #[test]
    fn behaviour_domains_prompt_for_the_spec_delta() {
        const HOOKED: [(&str, &str); 3] =
            [("coding-v1", "implement"), ("generic-v1", "execute"), ("business-v1", "execute")];
        for lang in [TemplateLang::ZhTw, TemplateLang::En] {
            let templates = built_in_templates(lang).unwrap();
            for (id, phase_id) in HOOKED {
                let phase = templates
                    .iter()
                    .find(|t| t.id == id)
                    .and_then(|t| t.phases.iter().find(|p| p.id == phase_id))
                    .unwrap_or_else(|| panic!("{id} must keep its '{phase_id}' phase"));
                assert!(
                    phase.ai_instructions.iter().any(|i| i.contains("validate_task_specs")),
                    "{id}/{phase_id} ({lang:?}) must prompt for the spec delta"
                );
            }
        }
    }

    /// Only an explicit zh tag opts into zh-TW content (D104). Everything
    /// else — including the headless callers that pass nothing — lands on
    /// English, the language the shipped workspace material is written in.
    #[test]
    fn lang_tag_mapping() {
        assert_eq!(TemplateLang::from_tag(Some("en")), TemplateLang::En);
        assert_eq!(TemplateLang::from_tag(Some("en-US")), TemplateLang::En);
        assert_eq!(TemplateLang::from_tag(Some("zh-TW")), TemplateLang::ZhTw);
        assert_eq!(TemplateLang::from_tag(Some("zh")), TemplateLang::ZhTw);
        assert_eq!(TemplateLang::from_tag(Some("ja")), TemplateLang::En);
        assert_eq!(TemplateLang::from_tag(None), TemplateLang::En);
        assert_eq!(TemplateLang::default(), TemplateLang::En);
    }

    #[test]
    fn resolve_defaults_to_generic() {
        let l = TemplateLang::ZhTw;
        assert_eq!(resolve_template(None, None, l).unwrap().id, "generic-v1");
        assert_eq!(resolve_template(Some("  "), None, l).unwrap().id, "generic-v1");
        assert_eq!(resolve_template(Some("coding-v1"), None, l).unwrap().id, "coding-v1");
        assert_eq!(
            resolve_template(Some("coding-v1"), None, TemplateLang::En).unwrap().name,
            "Software Development"
        );
    }

    #[test]
    fn unknown_template_lists_available() {
        let err = resolve_template(Some("nope"), None, TemplateLang::ZhTw).unwrap_err();
        assert_eq!(err.kind(), "invalid_input");
        assert!(err.to_string().contains("generic-v1"));
    }

    #[test]
    fn custom_templates_load_and_shadow_built_ins() {
        let dir = tempfile::tempdir().unwrap();
        // A valid custom template that shadows generic-v1.
        std::fs::write(
            dir.path().join("mine.json"),
            r#"{"id":"generic-v1","name":"My Generic","phases":[
                {"id":"only","title":"Only","exitGates":[{"kind":"min_tasks","count":2}]}
            ]}"#,
        )
        .unwrap();
        // An invalid one that must be skipped, not fatal.
        std::fs::write(dir.path().join("broken.json"), b"{nope").unwrap();

        let (templates, skipped) = load_custom_templates(dir.path()).unwrap();
        assert_eq!(templates.len(), 1);
        assert_eq!(skipped.len(), 1);

        let resolved =
            resolve_template(Some("generic-v1"), Some(dir.path()), TemplateLang::ZhTw).unwrap();
        assert_eq!(resolved.name, "My Generic", "custom template must shadow the built-in");
        // Custom shadowing is language-independent: the same file wins in en too.
        let resolved_en =
            resolve_template(Some("generic-v1"), Some(dir.path()), TemplateLang::En).unwrap();
        assert_eq!(resolved_en.name, "My Generic");

        let summaries = template_summaries(Some(dir.path()), TemplateLang::ZhTw).unwrap();
        assert_eq!(summaries.len(), 5, "shadowed built-in is not double-listed");

        // Unknown-id errors must surface the skipped file so the user learns
        // the real reason their template is missing.
        let err =
            resolve_template(Some("missing-v1"), Some(dir.path()), TemplateLang::ZhTw).unwrap_err();
        assert!(err.to_string().contains("broken.json"), "skipped file must be named: {err}");
    }

    #[test]
    fn validation_rejects_bad_templates() {
        let l = TemplateLang::ZhTw;
        let mut t = resolve_template(None, None, l).unwrap();
        t.phases[0].id = t.phases[1].id.clone();
        assert!(validate_template(&t).unwrap_err().to_string().contains("duplicate"));

        let mut t2 = resolve_template(None, None, l).unwrap();
        t2.phases[0].exit_gates = vec![Gate::ArtifactExists { path: "../escape.md".into() }];
        assert_eq!(validate_template(&t2).unwrap_err().kind(), "invalid_input");

        let mut t3 = resolve_template(None, None, l).unwrap();
        t3.phases.clear();
        assert!(validate_template(&t3).is_err());
    }

    fn sample_custom(id: &str) -> WorkflowTemplate {
        WorkflowTemplate {
            id: id.into(),
            name: "My flow".into(),
            description: "for tests".into(),
            domain_hint: "general".into(),
            phases: vec![Phase {
                id: "only".into(),
                title: "Only".into(),
                description: String::new(),
                ai_instructions: vec!["Do one thing".into()],
                exit_gates: vec![Gate::MinTasks { count: 1 }],
            }],
        }
    }

    #[test]
    fn save_edit_delete_custom_template_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let l = TemplateLang::ZhTw;
        let mut t = sample_custom("mine-v1");
        save_custom_template(dir.path(), &t).unwrap();
        assert!(dir.path().join("mine-v1.json").exists());
        assert_eq!(resolve_template(Some("mine-v1"), Some(dir.path()), l).unwrap().name, "My flow");

        // Same id again = update in place, never a second file.
        t.name = "Renamed".into();
        save_custom_template(dir.path(), &t).unwrap();
        let files: Vec<_> = std::fs::read_dir(dir.path()).unwrap().collect();
        assert_eq!(files.len(), 1);
        assert_eq!(resolve_template(Some("mine-v1"), Some(dir.path()), l).unwrap().name, "Renamed");

        delete_custom_template(dir.path(), "mine-v1").unwrap();
        assert!(resolve_template(Some("mine-v1"), Some(dir.path()), l).is_err());
        assert_eq!(delete_custom_template(dir.path(), "mine-v1").unwrap_err().kind(), "not_found");
    }

    #[test]
    fn save_updates_file_whose_name_differs_from_id() {
        let dir = tempfile::tempdir().unwrap();
        // Hand-authored file: name on disk unrelated to the id inside.
        std::fs::write(
            dir.path().join("weird-name.json"),
            serde_json::to_vec_pretty(&sample_custom("mine-v1")).unwrap(),
        )
        .unwrap();
        let mut t = sample_custom("mine-v1");
        t.name = "Updated".into();
        save_custom_template(dir.path(), &t).unwrap();
        assert!(!dir.path().join("mine-v1.json").exists(), "must overwrite the holding file, not fork");
        let resolved =
            resolve_template(Some("mine-v1"), Some(dir.path()), TemplateLang::ZhTw).unwrap();
        assert_eq!(resolved.name, "Updated");
    }

    #[test]
    fn save_rejects_built_in_ids_bad_ids_and_invalid_templates() {
        let dir = tempfile::tempdir().unwrap();
        // Built-in id: read-only surface (D43) — must not be shadow-written.
        let err = save_custom_template(dir.path(), &sample_custom("generic-v1")).unwrap_err();
        assert_eq!(err.kind(), "invalid_input");
        assert!(err.to_string().contains("built-in"));
        // Filesystem-unsafe / non-conforming ids.
        for bad in ["", "有中文", "UPPER", "a b", "../escape", "-lead"] {
            let err = save_custom_template(dir.path(), &sample_custom(bad)).unwrap_err();
            assert_eq!(err.kind(), "invalid_input", "id '{bad}' must be rejected");
        }
        // Structural validation still applies to the write path.
        let mut t = sample_custom("ok-v1");
        t.phases.clear();
        assert!(save_custom_template(dir.path(), &t).is_err());
        // Built-ins are never deletable.
        let err = delete_custom_template(dir.path(), "generic-v1").unwrap_err();
        assert_eq!(err.kind(), "invalid_input");
    }

    #[test]
    fn missing_custom_dir_is_empty_not_error() {
        let dir = tempfile::tempdir().unwrap();
        let (templates, skipped) =
            load_custom_templates(&dir.path().join("does-not-exist")).unwrap();
        assert!(templates.is_empty());
        assert!(skipped.is_empty());
    }
}
