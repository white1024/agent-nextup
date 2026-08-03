//! Initialize a blank managed workspace (no demo content) for E2E agent tests.
//!
//! Usage: cargo run -p nextup-core --example init_blank -- <target-dir> [name] [template-id] [modules]
//! `modules` is comma-separated (e.g. `collab`); unknown ids abort before disk.

use nextup_core::security::keystore::StaticKeyProvider;
use nextup_core::workspace::init::{initialize_project, InitProjectParams};

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

    let keys = StaticKeyProvider([1u8; 32]);
    let params = InitProjectParams {
        root: dir.clone(),
        name,
        domain: "general".into(),
        description: "E2E agent-takeover test workspace".into(),
        goals: vec![],
        boundaries: vec![],
        template_id: Some(template),
        template_lang: None,
        modules,
        create_root: false,
    };

    match initialize_project(&params, &keys, "0.1.0") {
        Ok(_) => println!("blank workspace ready at {dir}"),
        Err(e) => {
            eprintln!("failed: {e}");
            std::process::exit(1);
        }
    }
}
