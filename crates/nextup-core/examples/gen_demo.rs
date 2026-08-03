//! Generate a demo workspace to inspect the AI-session bootstrap output.
//!
//! Usage: cargo run -p nextup-core --example gen_demo -- <target-dir>

use nextup_core::security::keystore::StaticKeyProvider;
use nextup_core::workspace::init::{initialize_project, InitProjectParams};
use nextup_core::workspace::layout::WorkspacePaths;
use nextup_core::workspace::ops::{add_ledger_note, create_task, update_task_status, NoteChannel};
use nextup_core::workspace::tasks::{NewTask, TaskStatus};

fn main() {
    let dir = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "nextup-demo".to_string());
    let keys = StaticKeyProvider([1u8; 32]);
    let params = InitProjectParams {
        root: dir.clone(),
        name: "Demo project".into(),
        domain: "coding".into(),
        description: "A sample workspace for inspecting the AI handoff layer output".into(),
        goals: vec!["Core features complete".into(), "Documentation good enough to hand over".into()],
        boundaries: vec!["Never touch production data".into(), "No paid dependencies".into()],
        template_id: Some("coding-v1".into()),
        template_lang: std::env::args().nth(2),
        ..Default::default()
    };

    let run = || -> nextup_core::Result<()> {
        initialize_project(&params, &keys, "0.1.0")?;
        let paths = WorkspacePaths::new(&dir);
        let t1 = create_task(
            &paths,
            "0.1.0",
            NewTask {
                title: "Design the data model".into(),
                description: "Define the core entities and their relations".into(),
                priority: 0,
                ..Default::default()
            },
        )?;
        create_task(
            &paths,
            "0.1.0",
            NewTask {
                title: "Write the user documentation".into(),
                priority: 2,
                ..Default::default()
            },
        )?;
        update_task_status(&paths, "0.1.0", &t1.id, TaskStatus::InProgress, None)?;
        add_ledger_note(&paths, "0.1.0", NoteChannel::Decision, "Files are the source of truth; the index can always be rebuilt")?;
        Ok(())
    };

    match run() {
        Ok(()) => println!("demo workspace ready at {dir}"),
        Err(e) => {
            eprintln!("failed: {e}");
            std::process::exit(1);
        }
    }
}
