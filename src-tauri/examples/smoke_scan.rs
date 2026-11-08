//! Dev tool: discover every instance on this machine and scan it READ-ONLY, writing one
//! `<instance id>.json` ({ instance, scan }) per instance into an output folder, for the
//! real-instance smoke test (`SMOKE_DIR=<dir> npx vitest run src/core/__tests__/real-smoke.test.ts`).
//!
//!   cargo run --release --example smoke_scan -- <out dir>
//!
//! Uses default settings (no manual folders). Nothing is written anywhere but `<out dir>`.

use std::path::PathBuf;
use std::time::Instant;

use modpack_doctor_lib::discovery::{discover, DiscoveryInput, Env};
use modpack_doctor_lib::guard::PathGuard;
use modpack_doctor_lib::instance_config;
use modpack_doctor_lib::model::{Launcher, Settings};
use modpack_doctor_lib::scan::scan_mods_dir;

fn main() {
    let Some(out) = std::env::args().nth(1).map(PathBuf::from) else {
        eprintln!("usage: smoke_scan <out dir>");
        std::process::exit(2);
    };
    if let Err(e) = std::fs::create_dir_all(&out) {
        eprintln!("cannot create {}: {e}", out.display());
        std::process::exit(1);
    }

    let t = Instant::now();
    let found = discover(&Env::current(), &DiscoveryInput::from(&Settings::default()));
    println!("discovered {} instances in {:?}", found.report.instances.len(), t.elapsed());

    let guard = PathGuard::new();
    for root in &found.roots {
        if let Err(e) = guard.add_root(root) {
            eprintln!("root {}: {e}", root.display());
        }
    }

    println!("{:<44} {:>5} {:>9} {:>6}", "instance", "jars", "ms", "issues");
    for inst in &found.report.instances {
        if inst.launcher == Launcher::Mrpack {
            continue;
        }
        let t = Instant::now();
        match scan_mods_dir(std::path::Path::new(&inst.game_dir), &inst.id, &guard, |_| {}, |_| {}) {
            Ok(mut scan) => {
                instance_config::attach(&mut scan, std::path::Path::new(&inst.game_dir), &guard);
                let top = scan.jars.iter().filter(|j| j.depth == 0).count();
                println!("{:<44} {:>5} {:>9} {:>6}", trunc(&inst.name, 44), top, t.elapsed().as_millis(), scan.issues.len());
                let json = serde_json::json!({ "instance": inst, "scan": scan });
                let file = out.join(format!("{}.json", inst.id));
                if let Err(e) = std::fs::write(&file, json.to_string()) {
                    eprintln!("write {}: {e}", file.display());
                }
            }
            Err(e) => println!("{:<44} scan failed: {e}", trunc(&inst.name, 44)),
        }
    }
}

fn trunc(s: &str, n: usize) -> String {
    if s.chars().count() <= n {
        s.to_string()
    } else {
        s.chars().take(n - 1).chain(std::iter::once('…')).collect()
    }
}
