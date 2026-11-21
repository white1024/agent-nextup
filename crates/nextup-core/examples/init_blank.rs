//! Initialize a blank managed workspace (no demo content) for E2E agent tests.
//!
//! Usage: cargo run -p nextup-core --example init_blank -- <target-dir> [name] [template-id] [modules] [mode]
//! `modules` is comma-separated (e.g. `collab`); unknown ids abort before disk.
//! `mode` is `staged` (the default here) or `ongoing`. The product default is
//! ongoing (D171), but the e2e scripts walk the phase harness — advance,
//! gates, the manual_confirm refusal — so this fixture keeps them staged
//! unless asked.

use nextup_core::security::keystore::StaticKeyProvider;
use nextup_core::workspace::init::{initialize_project, InitProjectParams};
use nextup_core::workspace::workflow::WorkflowMode;

fn main() {
    let mut args = std::env::args().skip(1);
    let Some(dir) = args.next() else {
        eprintln!("usage: init_blank -- <target-dir> [name] [template-id] [modules,comma-separated]");
        std::process::exit(2);
    };
    let name = args.next().unwrap_or_else(|| "e2e-test".to_string());
    let template = args.next().unwrap_or_else(|| "generic-v1".to_string());
    let modules: Vec<String> = args
        .next()
        .map(|m| m.split(',').map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect())
        .unwrap_or_default();
    let mode = match args.next().as_deref() {
        None | Some("staged") => WorkflowMode::Staged,
        Some("ongoing") => WorkflowMode::Ongoing,
        Some(other) => {
            eprintln!("unknown mode '{other}' (staged | ongoing)");
            std::process::exit(2);
        }
    };

    let keys = StaticKeyProvider([1u8; 32]);
    let params = InitProjectParams {
        root: dir.clone(),
        name,
        // Blank, as the GUI wizard leaves it: the domain then follows the
        // template (D137), and with it the domain's skill pack (D148).
        domain: String::new(),
        description: "E2E agent-takeover test workspace".into(),
        goals: vec![],
        boundaries: vec![],
        template_id: Some(template),
        template_lang: None,
        modules,
        create_root: false,
        // The D63 day-one grant, as an unticked wizard gives it (D150): the
        // e2e runs open the guarded tools themselves, as a person would.
        grant_all_tools: false,
        own_method: false,
        mode: Some(mode),
    };

    match initialize_project(&params, &keys, "0.1.0") {
        Ok(_) => println!("blank workspace ready at {dir}"),
        Err(e) => {
            eprintln!("failed: {e}");
            std::process::exit(1);
        }
    }
}
