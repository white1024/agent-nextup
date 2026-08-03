//! Run the workspace doctor from the command line — works on managed
//! workspaces AND plain document repos (docs-only mode). The Agent NextUp dev repo
//! itself is checked with:
//!
//! Usage: cargo run -p nextup-core --example doctor -- [dir]   (default ".")
//!
//! Exit code: 0 = no errors (warnings allowed), 1 = errors found.

use std::path::Path;

use nextup_core::workspace::doctor::{run_doctor, DoctorMode, DoctorSeverity};

fn main() {
    let dir = std::env::args().nth(1).unwrap_or_else(|| ".".to_string());
    let report = match run_doctor(Path::new(&dir)) {
        Ok(r) => r,
        Err(e) => {
            eprintln!("doctor failed to run: {e}");
            std::process::exit(2);
        }
    };

    let mode = match report.mode {
        DoctorMode::Managed => "managed workspace",
        DoctorMode::DocsOnly => "docs-only",
    };
    println!("workspace doctor — {dir} ({mode}, checked {})", report.checked_at);

    if report.findings.is_empty() {
        println!("all clear: the takeover layer is healthy");
        return;
    }
    for f in &report.findings {
        let icon = match f.severity {
            DoctorSeverity::Error => "ERROR",
            DoctorSeverity::Warning => "warn ",
        };
        println!("  [{icon}] {} ({}): {}", f.target, f.check, f.message);
    }
    println!("{} error(s), {} warning(s)", report.errors, report.warnings);
    if !report.is_clean() {
        std::process::exit(1);
    }
}
