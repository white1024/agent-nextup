use std::collections::BTreeMap;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::index::scanner::ScannedFile;
use crate::workspace::tasks::NewTask;

/// Cap so a TODO-riddled legacy codebase doesn't drown the task list.
const MAX_SUGGESTED_TASKS: usize = 20;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TodoHit {
    pub path: String,
    pub line: u32,
    pub text: String,
}

/// Analysis to draft: everything a wizard needs to prefill adoption of a
/// legacy project. Generated text is zh-TW (D9); the user edits before
/// anything is written.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdoptionDraft {
    pub name: String,
    pub domain: String,
    pub description: String,
    pub languages: Vec<String>,
    pub suggested_tasks: Vec<NewTask>,
}

/// Collect TODO/FIXME markers from one file's content (called during the
/// index pass so files are read exactly once).
pub fn collect_todos(rel_path: &str, content: &str, sink: &mut Vec<TodoHit>) {
    for (i, line) in content.lines().enumerate() {
        if line.contains("TODO") || line.contains("FIXME") {
            sink.push(TodoHit {
                path: rel_path.to_string(),
                line: (i + 1) as u32,
                text: line.trim().chars().take(120).collect(),
            });
        }
    }
}

pub fn draft_adoption(root: &Path, files: &[ScannedFile], todos: &[TodoHit]) -> AdoptionDraft {
    let name = root
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "Untitled project".to_string());

    let mut counts: BTreeMap<&str, usize> = BTreeMap::new();
    for f in files {
        if let Some(lang) = &f.language {
            if lang != "markdown" && lang != "json" && lang != "yaml" && lang != "toml" {
                *counts.entry(lang).or_default() += 1;
            }
        }
    }
    let mut ranked: Vec<(&str, usize)> = counts.into_iter().collect();
    ranked.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(b.0)));
    let languages: Vec<String> = ranked.iter().take(3).map(|(l, _)| l.to_string()).collect();

    let domain = if languages.is_empty() { "generic" } else { "coding" }.to_string();
    let description = if languages.is_empty() {
        format!("Existing project (auto-drafted): {} text files scanned.", files.len())
    } else {
        format!(
            "Existing project (auto-drafted): {} text files scanned, mainly {}.",
            files.len(),
            languages.join(", ")
        )
    };

    let suggested_tasks = todos
        .iter()
        .take(MAX_SUGGESTED_TASKS)
        .map(|t| NewTask {
            title: format!("Handle marker: {}", t.text.chars().take(60).collect::<String>()),
            description: format!("{}:{}", t.path, t.line),
            priority: 2,
            tags: vec!["todo-scan".to_string()],
            ..Default::default()
        })
        .collect();

    AdoptionDraft { name, domain, description, languages, suggested_tasks }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn file(rel: &str, lang: Option<&str>) -> ScannedFile {
        ScannedFile {
            rel_path: rel.into(),
            size: 10,
            language: lang.map(str::to_string),
            is_markdown: false,
        }
    }

    #[test]
    fn collects_todo_and_fixme_lines() {
        let mut sink = Vec::new();
        collect_todos("src/a.rs", "ok line\n// TODO: refactor this\nlet x = 1; // FIXME later\n", &mut sink);
        assert_eq!(sink.len(), 2);
        assert_eq!(sink[0].line, 2);
        assert!(sink[0].text.contains("TODO"));
    }

    #[test]
    fn draft_names_dominant_languages_and_caps_tasks() {
        let files = vec![
            file("a.rs", Some("rust")),
            file("b.rs", Some("rust")),
            file("c.ts", Some("typescript")),
            file("README.md", Some("markdown")), // config/prose don't count
        ];
        let todos: Vec<TodoHit> = (0..30)
            .map(|i| TodoHit { path: format!("f{i}.rs"), line: 1, text: format!("TODO {i}") })
            .collect();
        // Forward slashes on purpose: Windows accepts them as separators, Unix
        // does not accept backslashes. A `C:\work\legacy-app` literal here made
        // `file_name()` return the whole string on Linux and macOS, so this test
        // failed on both — invisibly, because the CI step that would have caught
        // it never ran (see the sidecar step in release.yml).
        let draft = draft_adoption(Path::new("/work/legacy-app"), &files, &todos);
        assert_eq!(draft.name, "legacy-app");
        assert_eq!(draft.domain, "coding");
        assert_eq!(draft.languages, vec!["rust", "typescript"]);
        assert!(draft.description.contains("4 text files"));
        assert_eq!(draft.suggested_tasks.len(), MAX_SUGGESTED_TASKS);
        assert_eq!(draft.suggested_tasks[0].tags, vec!["todo-scan"]);
    }

    #[test]
    fn prose_only_project_is_generic() {
        let files = vec![file("notes.md", Some("markdown"))];
        let draft = draft_adoption(Path::new("/tmp/notes"), &files, &[]);
        assert_eq!(draft.domain, "generic");
        assert!(draft.languages.is_empty());
        assert!(draft.suggested_tasks.is_empty());
    }
}
