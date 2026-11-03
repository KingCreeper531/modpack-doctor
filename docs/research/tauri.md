# Tauri 2 research (R4): versions, ACL, asset protocol, updater, CI, Rust APIs

Researched 2026-11-02. Versions come from the crates.io API and the npm registry. The API behaviour described here comes from the published crate sources (downloaded tarballs). I did not guess any of it. Tauri 3.0.0-alpha.x is published as `next`, so ignore it and stay on 2.x.

## Pinned versions

| Package | Version | Notes |
|---|---|---|
| `tauri` (crate) | **2.12.5** (2026-10-21) | edition 2024, `rust-version = 1.90`. Needs `tauri-build ^2.7.4`, `windows ^0.62` |
| `tauri-build` | **2.7.4** | |
| `@tauri-apps/cli` | **2.12.4** | npm `latest`. There is no 2.12.5 on npm, and the CLI version check compares major.minor only |
| `@tauri-apps/api` | **2.12.4** | |
| `tauri-plugin-dialog` | **2.8.4** | Rust-only use, no JS package needed. Depends on `tauri-plugin-fs ^2.7.1` (for `FilePath`) |
| `tauri-plugin-updater` | **2.14.1** | Rust-only use |
| `tauri-plugin-store` | **2.5.0** | Rust-only use |
| `tauri-plugin-opener` | **2.7.2** | JS: `@tauri-apps/plugin-opener` **2.7.2** |
| `tauri-plugin-notification` | **2.8.0** | JS: `@tauri-apps/plugin-notification` **2.8.0** |
| `tauri-specta` | **=2.0.0-rc.26** (2026-10-21) | Still RC. No stable 2.x exists (the only stable release is 1.0.2, for Tauri v1) |
| `specta` | **=2.0.0-rc.26** | **Must** be rc.26. tauri-specta rc.26 depends on `specta = "=2.0.0-rc.26"`. specta **rc.27** also exists (same day), so do NOT let it float |
| `specta-typescript` | **=0.0.13** | 0.0.13 needs specta `=rc.26`. **0.0.14 needs rc.27, which conflicts** |
| (transitive) `specta-serde` / `specta-util` | 0.0.13 / 0.0.13 | pulled in by tauri-specta |
| `windows` (crate) | **0.62.2** | Same major as Tauri's own `windows ^0.62`, so there is no duplicate and `HWND` types match |
| `ts-rs` (fallback only) | 12.0.1 | not needed |
| `react` | 19.3.1 (latest) | |
| `@phosphor-icons/react` | 2.1.10 | peer `react >=16.8`, React 19 OK |
| `@tanstack/react-virtual` | 3.14.25 | peer `^16.8 \|\| ^17 \|\| ^18 \|\| ^19`, OK |
| `zustand` | 5.0.16 | peer `react >=18` (optional peers: immer, use-sync-external-store), OK |
| `cmdk` | 1.1.1 | peer `react ^18 \|\| ^19`, OK |
| `tailwindcss` + `@tailwindcss/vite` | 4.3.4 / 4.3.4 | `@tailwindcss/vite` peer `vite ^5.2 \|\| ^6 \|\| ^7 \|\| ^8` |
| `@fontsource/ibm-plex-sans-condensed` | 5.3.0 | |
| `@fontsource/ibm-plex-mono` | 5.3.0 | |
| `tauri-apps/tauri-action` | **v1** (v1.0.0, 2026-06-29) | runs on node24. v1 drops Tauri v1 and pre-release v2 support |

Sources: `https://crates.io/api/v1/crates/<name>/<ver>/dependencies`, `npm view <pkg> version peerDependencies`, https://github.com/tauri-apps/tauri-action/releases/tag/action-v1.0.0

**Verdict: a working tauri-specta set exists.** It is tauri 2.12.5 + tauri-specta =2.0.0-rc.26 + specta =2.0.0-rc.26 + specta-typescript =0.0.13. The checks behind it:
- Tauri's `specta` feature declares `specta ^2.0.0-rc.16`, and rc.26 satisfies that.
- Tauri's integration code uses `specta::TypeMap`, which is still in rc.26 as a deprecated alias for `Types`, so it compiles.
- The crate's packaged Cargo.lock was built against tauri 2.11.6.
- The upstream repo bumped to tauri 2.12.5 on 2026-11-02.

You don't need the ts-rs fallback.

### Cargo.toml (`src-tauri/Cargo.toml`)

```toml
[build-dependencies]
tauri-build = { version = "2.7.4", features = [] }

[dependencies]
tauri = { version = "2.12.5", features = ["protocol-asset"] }
tauri-plugin-dialog = "2.8.4"
tauri-plugin-store = "2.5.0"
tauri-plugin-opener = "2.7.2"
tauri-plugin-notification = "2.8.0"
serde = { version = "1", features = ["derive"] }
serde_json = "1"
# Exact pins are REQUIRED for the specta family (pre-release APIs, `=` deps between them)
specta = { version = "=2.0.0-rc.26", features = ["derive"] }        # add "chrono"/"serde_json" if needed
specta-typescript = "=0.0.13"
tauri-specta = { version = "=2.0.0-rc.26", features = ["derive", "typescript"] }

[target.'cfg(any(target_os = "macos", windows, target_os = "linux"))'.dependencies]
tauri-plugin-updater = "2.14.1"

[target.'cfg(windows)'.dependencies]
windows = { version = "0.62", features = ["Win32_Foundation", "Win32_Graphics_Dwm"] }
```
For the tauri/plugin crates, caret versions plus a committed `Cargo.lock` work fine; `=` also works. The specta trio must use `=`. tauri-specta features are `derive` (the `Event` derive), `typescript`, and `javascript` (JSDoc). It also enables `tauri/specta` and `specta/{derive,function}` for you.

npm: `"@tauri-apps/api": "2.12.4"`, `"@tauri-apps/cli": "2.12.4"` (dev), `"@tauri-apps/plugin-notification": "2.8.0"`, `"@tauri-apps/plugin-opener": "2.7.2"`. Keep each JS guest package on the same major.minor as its crate, because `tauri build/dev` warns or fails on a mismatch.

## 1. tauri-specta usage (rc.26 API, verified from `src/lib.rs`, `builder.rs`)

```rust
use serde::{Deserialize, Serialize};
use specta::Type;
use tauri_specta::{collect_commands, collect_events, Builder, Event};

#[derive(Serialize, Type)]
pub struct ScanResult { pub mods: Vec<String>, pub size_mb: f64 }   // no u64/usize!

#[derive(Serialize, Type, Debug)]
#[serde(tag = "kind", content = "message")]
pub enum AppError { Io(String), Parse(String) }

#[tauri::command]
#[specta::specta]
async fn scan_pack(path: String) -> Result<ScanResult, AppError> { /* ... */ todo!() }

#[derive(Serialize, Deserialize, Debug, Clone, Type, Event)]
pub struct ScanProgress { pub done: u32, pub total: u32 }   // wire name: "scan-progress" (kebab of type name)

pub fn run() {
    let builder = Builder::<tauri::Wry>::new()
        .commands(collect_commands![scan_pack])
        .events(collect_events![ScanProgress]);

    #[cfg(debug_assertions)]
    builder
        .export(specta_typescript::Typescript::default(), "../src/bindings.ts")
        .expect("failed to export TS bindings");

    tauri::Builder::default()
        .invoke_handler(builder.invoke_handler())
        .setup(move |app| {
            builder.mount_events(app);                         // required for typed events
            ScanProgress { done: 0, total: 1 }.emit(app)?;     // `Event` trait: emit / emit_to / listen / once
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running app");
}
```
- `invoke_handler(&self)`, `mount_events(&self, &impl Manager)` and `export(&self, lang, path)` all borrow. That's why the builder can be exported first and then moved into `setup`.
- Commands that are generic over `R: Runtime` must be listed as `my_cmd::<tauri::Wry>` in `collect_commands!`.
- Builder knobs:
  - `.error_handling(ErrorHandlingMode::{Result (default), Throw, ResultUnknown})`
  - `.function_casing(Casing::…)`: the default is camelCase accessors
  - `.typ::<T>()`: exports extra types
  - `.constant(k, v)`
  - `.dangerously_cast_bigints_to_number()`
  - `.disable_serde_phases()`
  - `.semantic_types(...)`

Generated TS shape:
```ts
import { commands, events } from "./bindings";
const r = await commands.scanPack("C:/pack");          // Promise<Result<ScanResult, AppError>>
if (r.status === "ok") r.data.mods; else r.error.kind;  // { status:"ok"; data:T } | { status:"error"; error:E }
// infallible commands return Promise<T> directly
const unlisten = await events.scanProgress.listen((e) => e.payload.done);
await events.scanProgress(getCurrentWebviewWindow()).listen(...);       // window-scoped
```
- With serde phases on (the default), a type whose serialize and deserialize shapes differ is emitted as `T_Serialize` / `T_Deserialize`, plus `T = T_Serialize`.
- `Result` mode **rethrows** when the rejection is a JS `Error` instance. ACL denials and bad-argument failures reject with plain strings, and those land in `error` untyped. Use `ResultUnknown` if you need every error handled exhaustively.
- `tauri::ipc::Channel<T>` works as a top-level command argument and comes out as `Channel<T>` in TS. It can't be nested inside a struct.

## 2. Capabilities / ACL

The file is `src-tauri/capabilities/default.json`. Every file in that directory is enabled automatically, unless `app.security.capabilities` lists them explicitly.
```json
{
  "$schema": "../gen/schemas/desktop-schema.json",
  "identifier": "default",
  "description": "Main window",
  "windows": ["main"],
  "platforms": ["windows", "macOS", "linux"],
  "permissions": [
    "core:default",
    "notification:allow-notify",
    "notification:allow-is-permission-granted",
    "notification:allow-request-permission",
    { "identifier": "opener:allow-open-url",
      "allow": [ { "url": "https://modrinth.com/*" }, { "url": "https://www.curseforge.com/*" } ] }
  ]
}
```
- `core:default` already includes `core:event:default` and `core:menu:default` (plus window, webview, app, path, resources and image). If you want to be minimal, list `core:event:default` and `core:menu:default` explicitly, and also `core:resources:default`, because menu objects are Rust resources that JS closes when finished.
- **Opener scope.** Entries take the form `{ "url": "<glob>" }`, compiled with the `glob` crate's `Pattern::matches`, which uses default options, so `*` also matches `/`. That makes `https://modrinth.com/*` cover every path, and `https://modrinth.com/**` behaves the same. **Do not add `opener:default`.** It pulls in `allow-default-urls`, which allows every `http://*`, `https://*`, `mailto:*` and `tel:*` URL and defeats the scoping (source: `tauri-plugin-opener-2.7.2/permissions/allow-default-urls.toml`, `src/scope.rs`). Also, `https://modrinth.com/*` does not match `https://cdn.modrinth.com/...`, so add hosts explicitly.
- `notification:default` grants everything: notify, is/request permission, channels, actions and so on. The three listed above are enough for `isPermissionGranted` / `requestPermission` / `sendNotification`.
- **App-defined commands** are allowed by default, with no permission entry needed. This holds as long as the app has no app ACL manifest and the request comes from a local origin. In Tauri 2.12.5 `src/webview/mod.rs`, the ACL is checked only when `plugin_command.is_some() || has_app_acl_manifest || !is_local`. If you opt in with `tauri_build::try_build(Attributes::new().app_manifest(AppManifest::new().commands(&["scan_pack", ...])))`, each command needs `allow-<cmd>` in a capability. A plain `tauri_build::build()` is fine here.
- Rust-only plugins (dialog, store, updater) need **no** JS permissions. Their IPC commands simply stay denied to the webview, which is what we want.

## 3. Asset protocol

```jsonc
// tauri.conf.json
"app": { "security": {
  "csp": "default-src 'self' ipc: http://ipc.localhost; img-src 'self' asset: http://asset.localhost data: https://cdn.modrinth.com; style-src 'self' 'unsafe-inline'; font-src 'self' data:",
  "assetProtocol": { "enable": true, "scope": ["$APPCACHE/icons/**"] }
}}
```
- **Cargo feature:** `tauri` needs `features = ["protocol-asset"]` (`protocol-asset = ["http-range"]`). The config struct is `AssetProtocolConfig { scope: FsScope, enable: bool }`, from `tauri-utils-2.10.2/src/config.rs:2715`. `scope` also accepts `{ "allow": [...], "deny": [...], "requireLiteralLeadingDot": bool }`.
- **`convertFileSrc(path)`:**
  - Windows and Android: `http://asset.localhost/<percent-encoded path>`. For example, `C:\Users\me\a (1).png` becomes `http://asset.localhost/C%3A%5CUsers%5Cme%5Ca%20(1).png`.
  - macOS and Linux: `asset://localhost/<encoded>`.
  - If `use_https_scheme` is set, the Windows/Android form uses `https://asset.localhost/`.
  - Source: tests in `tauri-2.12.5/src/webview/mod.rs:2680-2705`. The Rust equivalent is `WebviewWindow::convert_file_src(path, None)`.
- **`$APPCACHE` resolution:**
  - `BaseDirectory::from_variable("$APPCACHE")` maps to `AppCache`, which `resolve_path` turns into `resolver.app_cache_dir()` (`tauri-2.12.5/src/path/mod.rs:238,338`). Scope globs are expanded through `manager.path().parse(...)` (`src/scope/fs.rs:201`).
  - `app_cache_dir()` is `dirs::cache_dir().join(config.identifier)` (`src/path/desktop.rs:278-284`), unless the new `app.appDirectoriesOverride` config is set. So it **does include the bundle identifier**, and it is **identical to `app.path().app_cache_dir()`**:
    - Windows: `%LOCALAPPDATA%\<identifier>` (`cache_dir` = `{FOLDERID_LocalAppData}`)
    - macOS: `~/Library/Caches/<identifier>`
    - Linux: `$XDG_CACHE_HOME/<identifier>` or `~/.cache/<identifier>`
  - **Windows gotcha:** on Windows this is the same folder as `app_local_data_dir()`, which is WebView2's user-data dir (`EBWebView\`). Scope the asset protocol to a subfolder like `$APPCACHE/icons/**`, never `$APPCACHE/**`. Never `remove_dir_all(app_cache_dir())` on Windows.

## 4. Updater + release CI

```jsonc
// tauri.conf.json
"bundle": { "active": true, "targets": "all", "createUpdaterArtifacts": true },
"plugins": { "updater": {
  "pubkey": "<CONTENT of the .key.pub file, not a path>",
  "endpoints": ["https://github.com/<owner>/<repo>/releases/latest/download/latest.json"],
  "windows": { "installMode": "passive" }        // passive (default) | basicUi | quiet
}}
```
- **Updater config:**
  - Generate keys with `npm run tauri signer generate -- -w ~/.tauri/modpack-doctor.key`. Losing the private key means installed users can never update.
  - At build time set `TAURI_SIGNING_PRIVATE_KEY` (key content or file path) and optionally `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. Set them as shell env or CI secrets, because `.env` files are not read.
  - `createUpdaterArtifacts: true` is the v2 format. `"v1Compatible"` is legacy only.
  - New options in 2.14: `requireSignedVersion` (default false; rejects downgrade-replay of old signed artifacts) and `allowDowngrades`. Endpoint URLs may use `{{current_version}}`, `{{target}}` and `{{arch}}`.
- Rust (plugin init: `.plugin(tauri_plugin_updater::Builder::new().build())` inside `#[cfg(desktop)]`):
```rust
use tauri_plugin_updater::UpdaterExt;
async fn update(app: tauri::AppHandle) -> tauri_plugin_updater::Result<()> {
    if let Some(update) = app.updater()?.check().await? {          // Result<Option<Update>>
        let mut got = 0usize;
        update.download_and_install(
            |chunk, total: Option<u64>| { got += chunk; /* emit progress */ },
            || { /* download finished */ },
        ).await?;
        app.restart();                                              // -> ! ; on Windows the installer exits the app itself
    }
    Ok(())
}
```
`update.version`, `update.body` and `update.date` are available for a "what's new" UI. You can also call `download()` and `install(bytes)` separately.

**GitHub Actions** (`tauri-apps/tauri-action@v1`), tag-triggered:
```yaml
on: { push: { tags: ["v*"] } }
jobs:
  release:
    permissions: { contents: write }
    strategy:
      fail-fast: false
      matrix:
        include:
          - { platform: macos-latest,  args: "--target universal-apple-darwin" }
          - { platform: ubuntu-22.04,  args: "" }
          - { platform: windows-latest, args: "" }
    runs-on: ${{ matrix.platform }}
    steps:
      - uses: actions/checkout@v4
      - if: startsWith(matrix.platform, 'ubuntu')
        run: |
          sudo apt-get update
          sudo apt-get install -y libwebkit2gtk-4.1-dev librsvg2-dev patchelf libayatana-appindicator3-dev libxdo-dev libssl-dev build-essential file
      - uses: actions/setup-node@v4
        with: { node-version: lts/*, cache: npm }
      - uses: dtolnay/rust-toolchain@stable
        with: { targets: "${{ matrix.platform == 'macos-latest' && 'aarch64-apple-darwin,x86_64-apple-darwin' || '' }}" }
      - uses: swatinem/rust-cache@v2
        with: { workspaces: "./src-tauri -> target" }
      - run: npm ci
      - uses: tauri-apps/tauri-action@v1
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          TAURI_SIGNING_PRIVATE_KEY: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}
          TAURI_SIGNING_PRIVATE_KEY_PASSWORD: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY_PASSWORD }}
          # optional macOS signing/notarization:
          # APPLE_CERTIFICATE, APPLE_CERTIFICATE_PASSWORD, APPLE_SIGNING_IDENTITY,
          # APPLE_ID, APPLE_PASSWORD (app-specific), APPLE_TEAM_ID
          # or API-key notarization: APPLE_API_ISSUER, APPLE_API_KEY, APPLE_API_KEY_PATH
        with:
          tagName: ${{ github.ref_name }}
          releaseName: "Modpack Doctor ${{ github.ref_name }}"
          releaseBody: "See assets below."
          releaseDraft: true
          prerelease: false
          args: ${{ matrix.args }}
          # uploadUpdaterJson: true (default) ; updaterJsonPreferNsis: true to point Windows at setup.exe instead of .msi
```
- **Universal macOS build:** use `--target universal-apple-darwin`. It needs **both** `aarch64-apple-darwin` and `x86_64-apple-darwin` rustup targets. The official docs example builds two separate arch jobs instead, which also works. tauri-action v1 handles universal signatures in `latest.json` (fix #1186).
- **Linux packages:**
  - ubuntu-22.04: the tauri-action README uses `libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf xdg-utils`.
  - ubuntu-24.04: `libappindicator3-dev` is gone, so use `libayatana-appindicator3-dev`. That is the package the v2 prerequisites page lists (https://v2.tauri.app/start/prerequisites/). The apt line above works on both 22.04 and 24.04.
  - We use no tray, so the appindicator package is optional either way.
  - Build on 22.04 for the widest glibc compatibility of the AppImage/deb.
- **Draft releases:** `releases/latest/download/latest.json` only resolves once the release is **published**, because drafts and prereleases are never "latest". Publish the draft manually after all three jobs finish.
- **Windows signing** goes in `bundle.windows` and is optional:
  - `certificateThumbprint`, `digestAlgorithm: "sha256"`, `timestampUrl`, or
  - `signCommand`: a string where `%1` is the file path, or `{ "cmd": "...", "args": ["...", "%1"] }` for args containing spaces (for example Azure Trusted Signing / `trusted-signing-cli`).
  - Unsigned builds trigger SmartScreen warnings but update fine. The updater signature is separate from Authenticode.
- **macOS signing:** ad-hoc signing (`"signingIdentity": "-"`) avoids the "damaged app" error on Apple Silicon but still needs Gatekeeper approval (https://v2.tauri.app/distribute/sign/macos/).

Docs: https://v2.tauri.app/plugin/updater/, https://v2.tauri.app/distribute/pipelines/github/, https://github.com/tauri-apps/tauri-action

## 5. Dialog from Rust (tauri-plugin-dialog 2.8.4)

API (`src/lib.rs`):
- `app.dialog().file()` returns a `FileDialogBuilder`, with `add_filter(name, &[ext])`, `set_directory`, `set_file_name`, `set_title` and `set_parent(&window)`.
- Callback forms: `pick_file`, `pick_files`, `pick_folder` and `save_file(FnOnce(Option<FilePath>) + Send + 'static)`.
- Blocking forms: `blocking_pick_file`, `blocking_pick_folder` and `blocking_save_file`. They are implemented as `sync_channel(0)` + `rx.recv()`, which blocks the calling thread.

Rules:
- **Never** call `blocking_*` from the main thread. That includes a non-async `#[tauri::command]`, because sync commands run on the main thread, so it deadlocks.
- Inside an `async` command (which runs on the Tokio pool), `blocking_*` is allowed and the plugin docs show it. It does tie up a runtime worker, though.
- The cleanest pattern is the callback plus a `tokio::sync::oneshot`:
```rust
use tauri_plugin_dialog::DialogExt;
#[tauri::command] #[specta::specta]
async fn pick_pack_folder(app: tauri::AppHandle) -> Result<Option<String>, AppError> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog().file().set_title("Select modpack folder").pick_folder(move |p| { let _ = tx.send(p); });
    let path = rx.await.map_err(|_| AppError::Io("dialog closed".into()))?;
    Ok(path.and_then(|p| p.into_path().ok()).map(|pb| pb.to_string_lossy().into_owned()))
}
// file with filter:  .add_filter("Modpack", &["mrpack", "zip"]).pick_file(cb)
// save path:         .set_file_name("report.html").add_filter("HTML", &["html"]).save_file(cb)
```
- `FilePath` is re-exported from `tauri_plugin_fs`: `enum FilePath { Url(url::Url), Path(PathBuf) }`, with `into_path() -> Result<PathBuf>`, `as_path() -> Option<&Path>` and `Display`. On desktop it is always `Path`.
- `FilePath` does not implement `specta::Type`, so return `String`/`PathBuf` from commands. `PathBuf` is typed as `string` by specta.
- Use `tokio` (already in Tauri's tree) via `tokio = { version = "1", features = ["sync"] }`, or use `tauri::async_runtime`.

## 6. Drag-and-drop (Rust)

`WindowEvent::DragDrop(DragDropEvent::{Enter{paths,position}, Over{position}, Drop{paths,position}, Leave})`. `position` is `PhysicalPosition<f64>` (`tauri-runtime-2.12.2/src/window.rs:99`).
```rust
use tauri::{DragDropEvent, WindowEvent, Emitter};
tauri::Builder::default().on_window_event(|window, event| {
    if let WindowEvent::DragDrop(DragDropEvent::Drop { paths, position: _ }) = event {
        let _ = window.emit("pack-dropped", paths.clone());   // or a typed tauri-specta Event
    }
})
```
- Config: `app.windows[].dragDropEnabled` defaults to `true`. Keep it `true` to get native OS file paths.
- Set it to `false` only if you need HTML5 DnD inside the page. On Windows, Tauri replaces WebView2's drop handler, so HTML5 drag/drop of DOM elements breaks while it is enabled.
- The frontend can also use `getCurrentWebview().onDragDropEvent(...)` from `@tauri-apps/api/webview`, which is covered by `core:default`.

## 7. Store from Rust only

```rust
use tauri_plugin_store::StoreExt;
.plugin(tauri_plugin_store::Builder::new().build())
// later (AppHandle / App / Window):
let store = app.store("settings.json")?;            // Arc<Store<R>>, path relative to $APPDATA (app_data_dir)
let theme = store.get("theme");                     // Option<serde_json::Value> (cloned)
store.set("theme", serde_json::json!("dark"));
store.save()?;                                      // auto-save also on by default (100 ms debounce)
```
- No JS permission is needed. Leaving `store:default` out of capabilities only blocks the webview from calling `plugin:store|*`, and Rust access is never ACL-gated.
- Relative paths resolve via `BaseDirectory::AppData` (`store.rs:44`). Note that this is `$APPDATA`, not `$APPLOCALDATA`.

## 8. Native context menu from JS

```ts
import { Menu, MenuItem, PredefinedMenuItem } from "@tauri-apps/api/menu";
const menu = await Menu.new({ items: [
  { id: "open", text: "Open on Modrinth", action: () => openUrl(url) },
  await PredefinedMenuItem.new({ item: "Separator" }),
  { id: "remove", text: "Remove mod", action: () => remove(id) },
]});
await menu.popup();                 // popup(at?: Position, window?: Window); default = cursor pos, current window
```
- Calls `plugin:menu|new` / `plugin:menu|popup`, which `core:menu:default` covers (`allow-new`, `allow-popup` and so on). Item `action` callbacks use IPC channels and need no extra permission.
- Releasing resources uses `core:resources:*`. `core:default` covers everything here.
- Call `e.preventDefault()` in the `contextmenu` handler to suppress the WebView menu.

## 9. Platform config files

`tauri.windows.conf.json`, `tauri.macos.conf.json` and `tauri.linux.conf.json` (or `.json5`, or `Tauri.<platform>.toml`) sit next to `tauri.conf.json` and are merged on top of it with **JSON Merge Patch (RFC 7396)** (`tauri-utils-2.10.2/src/config/parse.rs:168-187`).
- Objects merge recursively, and `null` deletes a key.
- **Arrays replace whole.** A `windows` array in the platform file replaces the full list, so restate every window field you need.
- CLI `--config <file|json>` is merged the same way on top of that.

## 10. Windows title-bar theming

- **What Tauri exposes:**
  - `WebviewWindow::set_theme(Option<Theme>)`, `theme()`, the window config `"theme": "Dark"` and `AppHandle::set_theme`. On Windows these toggle light/dark (immersive dark) for the caption.
  - `set_background_color`.
  - **No API for caption/text/border color.** Use DWM directly.
- **Which crate:**
  - Tauri 2.12.5 depends on `windows ^0.62` (features `Win32_Foundation`, `Win32_UI_WindowsAndMessaging`, …), and `window.hwnd()` returns `windows::Win32::Foundation::HWND` **from 0.62**.
  - Use `windows = "0.62"` (latest 0.62.2) with `Win32_Foundation` and `Win32_Graphics_Dwm`. It unifies with Tauri's copy, so no second build and no type mismatch.
  - A different major (0.61/0.63) would give a distinct `HWND` type. You could rewrap it via `.0`, but it would compile twice.
- **0.62 API** (verified in `windows-0.62.2/src/Windows/Win32/Graphics/Dwm/mod.rs`):
  - `unsafe fn DwmSetWindowAttribute(hwnd: HWND, attr: DWMWINDOWATTRIBUTE, pv: *const c_void, cb: u32) -> windows_core::Result<()>`
  - Constants: `DWMWA_USE_IMMERSIVE_DARK_MODE` = 20, `DWMWA_BORDER_COLOR` = 34, `DWMWA_CAPTION_COLOR` = 35, `DWMWA_TEXT_COLOR` = 36, `DWMWA_COLOR_DEFAULT` = 0xFFFFFFFF, `DWMWA_COLOR_NONE` = 0xFFFFFFFE.
  - `COLORREF(pub u32)` lives in `Win32::Foundation`.
```rust
#[cfg(windows)]
fn paint_titlebar(win: &tauri::WebviewWindow, caption_rgb: u32, text_rgb: u32) {
    use windows::{core::BOOL, Win32::Foundation::COLORREF};   // BOOL lives in windows_core in 0.62
    use windows::Win32::Graphics::Dwm::*;
    let Ok(hwnd) = win.hwnd() else { return };
    let bgr = |rgb: u32| COLORREF(((rgb & 0xFF) << 16) | (rgb & 0xFF00) | ((rgb >> 16) & 0xFF)); // COLORREF is 0x00BBGGRR
    unsafe {
        let dark = BOOL(1);
        let _ = DwmSetWindowAttribute(hwnd, DWMWA_USE_IMMERSIVE_DARK_MODE, &dark as *const _ as _, 4);
        for (attr, c) in [(DWMWA_CAPTION_COLOR, bgr(caption_rgb)), (DWMWA_BORDER_COLOR, bgr(caption_rgb)), (DWMWA_TEXT_COLOR, bgr(text_rgb))] {
            let _ = DwmSetWindowAttribute(hwnd, attr, &c as *const _ as _, std::mem::size_of::<COLORREF>() as u32);
        }
    }
}
```
- Attributes 34, 35 and 36 need Windows 11 (build 22000+). On Windows 10 the call returns an error HRESULT, so ignore it; immersive dark mode (20) still works on 10 20H1+.
- Call this in `setup` after the window exists, and again on theme change.
- In 0.62 `BOOL` is `windows::core::BOOL`, not `Win32::Foundation::BOOL` (verified in the 0.62.2 source). Using an `i32` value of 1 with size 4 is equivalent.

## 11. Frontend libs and Tailwind

All four React libraries accept React 19 (see the table). **Tailwind recommendation: v4.3.4 with `@tailwindcss/vite`**. There's no `tailwind.config.js` and no PostCSS config, and v4 is the simplest way to get a palette with only your own colors:
```ts
// vite.config.ts
import tailwindcss from "@tailwindcss/vite";
export default defineConfig({ plugins: [react(), tailwindcss()] });
```
```css
/* src/index.css */
@import "tailwindcss";
@theme {
  --color-*: initial;            /* wipe ALL default colors (also bg-red-500 etc. disappear) */
  --font-*: initial;
  --color-bg: #0f1114;  --color-surface: #171a1f;  --color-ink: #e6e8eb;  --color-accent: #3ddc84;
  --font-sans: "IBM Plex Sans Condensed", sans-serif;  --font-mono: "IBM Plex Mono", monospace;
}
```
- Import the fonts with `import "@fontsource/ibm-plex-sans-condensed/400.css"` (one per weight) and `"@fontsource/ibm-plex-mono/400.css"`. They are bundled locally, so the CSP `font-src 'self'` is enough.
- v4 needs modern WebViews (Safari 16.4+, Chromium 111+). That's fine for WebView2 and recent macOS, but **old Linux WebKitGTK (Ubuntu 22.04 ships 2.4x) supports `@property` and `color-mix` only from about 2.42+**. Pick v3.4 only if you must support old distros.
- Source: https://tailwindcss.com/docs/theme

## Pitfalls

1. **specta version drift.** `cargo add specta` or `specta-typescript` now picks rc.27 / 0.0.14, which conflicts with tauri-specta rc.26 (`=` requirement), so always pin `=2.0.0-rc.26` / `=0.0.13`. When upgrading, bump all three together, after tauri-specta publishes a release that depends on rc.27.
2. **BigInt guard.** specta-typescript refuses to export **`usize`, `isize`, `i64`, `u64`, `i128`, `u128`, `f128`** and fails at export with `BigIntForbidden`. Options:
   - Use `u32`/`i32`/`f64` for sizes, counts and byte totals. `f64` is exact to 2^53.
   - Use `#[specta(type = String)]` + `serde(with=...)`.
   - Use `#[specta(type = specta_typescript::Number)]` per field (accepts precision loss).
   - Use `Builder::dangerously_cast_bigints_to_number()`.

   Watch for `usize` from `Vec::len()` in DTOs and `u64` file sizes from `fs::metadata().len()`.
3. **`serde_json::Value`** (specta feature `serde_json`) contains `serde_json::Number`, which keeps its i64/u64 variants, so it **also triggers the BigInt guard**. Annotate fields with `#[specta(type = specta_typescript::Unknown)]` (or `Any`), or use the cast option.
4. **`chrono`** needs specta feature `"chrono"`. `DateTime<T>`, `NaiveDate` and the rest become `string`. Same for `uuid`, `url`, `semver` and others, which are all specta features.
5. **When the export runs.**
   - In `#[cfg(debug_assertions)]` the export runs on every `tauri dev` start, with the path relative to the process CWD (`src-tauri/`), so `../src/bindings.ts` is correct.
   - Release CI never regenerates the file, so **commit `src/bindings.ts`**. Optionally add a `#[test]` that calls the same export, then `git diff --exit-code src/bindings.ts` in CI. `cargo test` runs with CWD = crate root, so the same relative path works.
   - Don't export from both places concurrently.
   - Vite HMR reloads the page when bindings change.
6. **Missing `mount_events(app)`.** Typed `Event::emit` / `listen` panic or fail to resolve the event name. Also note the wire event name is the kebab-cased type name (`ScanProgress` becomes `"scan-progress"`), overridable with `#[tauri_specta(event_name = "...")]`.
7. Every exported command needs **both** `#[tauri::command]` and `#[specta::specta]`. Error types need `Serialize + specta::Type`. `tauri::State`, `AppHandle`, `Window` and `WebviewWindow` arguments are skipped automatically (via Tauri's `specta` feature).
8. **Opener.** `opener:default` silently allows all http(s) URLs. Use only the scoped `opener:allow-open-url`. Host globs don't cover subdomains.
9. **`$APPCACHE` on Windows** = `%LOCALAPPDATA%\<identifier>` = WebView2 profile dir. Scope the asset protocol to a subfolder and never wipe the root.
10. **CSP.** Once you set a CSP you must keep `ipc: http://ipc.localhost` (default-src/connect-src) or IPC breaks. Add `asset: http://asset.localhost` to `img-src` (both forms, to cover Windows and macOS/Linux). React `style={{}}` needs `style-src 'unsafe-inline'`.
11. **Never call dialog `blocking_*` in sync commands** (main thread). Use callback + oneshot.
12. **Updater `latest.json`.**
    - It is validated as a whole: every platform entry needs `url` + `signature`.
    - It only resolves from a **published, non-prerelease** GitHub release.
    - A Windows update quits the app during install, so call `restart()` only on macOS/Linux, though calling it is harmless.
13. **tauri-action v1 breaking renames.** `includeUpdaterJson` became `uploadUpdaterJson`, and `assetNamePattern` became `releaseAssetNamePattern`. `includeDebug` / `includeRelease` were removed. The `.app.tar.gz` names now include the version.
14. `dragDropEnabled: true` (the default) disables HTML5 element drag-and-drop on Windows. Use pointer-event based reordering (or dnd-kit with pointer sensors) inside lists.
15. Keep `@tauri-apps/api` / `@tauri-apps/cli` on the same **major.minor** as the `tauri` crate (2.12). The CLI errors on a mismatch.

## Uncertain

- tauri-specta rc.26 has not been compile-tested here against tauri 2.12.5 + plugins. It was checked by dependency resolution and API inspection only. Upstream `main` bumped to tauri 2.12.5 on 2026-11-02. Run `cargo check` early.
- Whether `libayatana-appindicator3-dev` is needed at all without a tray. It is probably not, but it's harmless to install.
- The exact Linux WebKitGTK version cutoff for Tailwind v4 features is approximate.
- `events.x(window).listen` in TS takes a `WebviewWindow`/`Window` handle. The doc example uses the v1-style `appWindow`, so in v2 pass `getCurrentWebviewWindow()`.
