fn main() {
    // On Windows, tauri-build normally embeds an app manifest (Common-Controls v6) into the
    // app binary only. Test binaries then fail to start with STATUS_ENTRYPOINT_NOT_FOUND
    // (TaskDialogIndirect is missing from comctl32 v5). Embed our own manifest into the app
    // AND the test binaries instead.
    let mut windows = tauri_build::WindowsAttributes::new();
    if std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc") {
        windows = tauri_build::WindowsAttributes::new_without_app_manifest();
        let manifest = std::path::Path::new(&std::env::var("CARGO_MANIFEST_DIR").unwrap_or_default())
            .join("windows-app-manifest.xml");
        println!("cargo:rerun-if-changed={}", manifest.display());
        // Plain `rustc-link-arg` covers the bin, lib unit-test binaries and the cdylib
        // (a manifest resource in the DLL is inert). `-tests` would skip lib unit tests.
        println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
        println!("cargo:rustc-link-arg=/MANIFESTINPUT:{}", manifest.display());
    }
    if let Err(e) = tauri_build::try_build(tauri_build::Attributes::new().windows_attributes(windows)) {
        panic!("tauri-build failed: {e}");
    }
}
