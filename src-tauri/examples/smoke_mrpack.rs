//! Dev tool: open and scan real `.mrpack` files READ-ONLY, the way the app does (pack checks,
//! read-only guard rule, in-memory override scan), and print what was found and every issue.
//! Nothing is extracted or written.
//!
//!   cargo run --release --example smoke_mrpack -- <file.mrpack> [more.mrpack …]

use std::path::PathBuf;

use modpack_doctor_lib::guard::PathGuard;
use modpack_doctor_lib::mrpack::{check_pack_file, describe_pack, scan_pack};

fn main() {
    let files: Vec<PathBuf> = std::env::args().skip(1).map(PathBuf::from).collect();
    if files.is_empty() {
        eprintln!("usage: smoke_mrpack <file.mrpack> …");
        std::process::exit(2);
    }
    for file in files {
        println!("== {}", file.display());
        let canon = match check_pack_file(&file) {
            Ok(c) => c,
            Err(reason) => {
                println!("   refused: {reason}");
                continue;
            }
        };
        let inst = describe_pack(&canon);
        println!(
            "   {} · MC {} · {:?} · metadata {:?} · {} mods",
            inst.name,
            inst.mc_version.as_deref().unwrap_or("?"),
            inst.loader.as_ref().map(|l| (l.kind, l.version.clone())),
            inst.metadata_source,
            inst.mod_count
        );
        let guard = PathGuard::new();
        guard.set_read_only_files(std::slice::from_ref(&canon));
        match scan_pack(&guard, &canon, &inst.id, |_| {}, |_| {}) {
            Ok(scan) => {
                let top = scan.jars.iter().filter(|j| j.depth == 0).count();
                println!("   declared {} · override jars {} (all jars {}) · issues {}", scan.declared.len(), top, scan.jars.len(), scan.issues.len());
                for i in scan.issues.iter().take(25) {
                    println!("   issue {}: {}", i.subject, i.message);
                }
            }
            Err(e) => println!("   scan failed: {e}"),
        }
    }
}
