//! Client vs dedicated-server detection (launchers.md §5).

use std::fs;
use std::path::Path;

use crate::model::Side;

use super::common::{is_dir, is_file};

/// Strong server signals found in `game_dir`.
pub(crate) fn server_signals(game_dir: &Path) -> u32 {
    let mut n = 0;
    for f in ["server.properties", "eula.txt", "fabric-server-launch.jar", "fabric-server-launcher.properties"] {
        if is_file(&game_dir.join(f)) {
            n += 1;
        }
    }
    for f in ["quilt-server-launch.jar", "quilt-server-launcher.properties"] {
        if is_file(&game_dir.join(f)) {
            n += 1;
        }
    }
    if is_dir(&game_dir.join(".fabric").join("server")) {
        n += 1;
    }
    if is_file(&game_dir.join("user_jvm_args.txt"))
        && (is_file(&game_dir.join("run.bat")) || is_file(&game_dir.join("run.sh")))
    {
        n += 1;
    }
    let libs = game_dir.join("libraries").join("net");
    for dir in [
        libs.join("minecraftforge").join("forge"),
        libs.join("neoforged").join("neoforge"),
        libs.join("neoforged").join("forge"),
    ] {
        if has_args_file(&dir) {
            n += 1;
        }
    }
    let names = top_level_names(game_dir);
    if names.iter().any(|f| f.starts_with("fabric-server-mc.") && f.ends_with(".jar")) {
        n += 1;
    }
    let old_forge = names.iter().any(|f| f.starts_with("forge-") && f.ends_with(".jar"));
    let vanilla_server = names.iter().any(|f| f.starts_with("minecraft_server.") && f.ends_with(".jar"));
    if old_forge && vanilla_server {
        n += 1;
    }
    n
}

/// Client signals that contradict "server".
pub(crate) fn client_signals(game_dir: &Path) -> u32 {
    let mut n = 0;
    for f in ["options.txt", "servers.dat", "minecraftinstance.json"] {
        if is_file(&game_dir.join(f)) {
            n += 1;
        }
    }
    if let Some(parent) = game_dir.parent() {
        if is_file(&game_dir.join("instance.cfg")) || is_file(&parent.join("instance.cfg")) {
            n += 1;
        }
    }
    n
}

/// Server when there is a strong server signal and it outweighs the client signals.
pub(crate) fn detect_side(game_dir: &Path) -> Side {
    let server = server_signals(game_dir);
    if server > 0 && server > client_signals(game_dir) {
        Side::Server
    } else {
        Side::Client
    }
}

fn has_args_file(dir: &Path) -> bool {
    let Ok(rd) = fs::read_dir(dir) else { return false };
    rd.flatten().any(|e| {
        let p = e.path();
        is_file(&p.join("win_args.txt")) || is_file(&p.join("unix_args.txt"))
    })
}

fn top_level_names(dir: &Path) -> Vec<String> {
    let Ok(rd) = fs::read_dir(dir) else { return Vec::new() };
    rd.flatten().map(|e| e.file_name().to_string_lossy().to_ascii_lowercase()).collect()
}
