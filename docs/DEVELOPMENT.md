# Developing Modpack Doctor

Build, test and release notes for the people working on the app. The user-facing README is
`README.md` at the repository root.

## Build from source

### Prerequisites

| | |
|---|---|
| Rust | stable, 1.90 or newer (`rustup`) |
| Node.js | 22.12 or newer (CI uses 24) |
| Windows | Visual Studio Build Tools with "Desktop development with C++" (MSVC); WebView2 (included in Windows 10 and 11) |
| macOS | Xcode Command Line Tools (`xcode-select --install`) |
| Linux (Debian/Ubuntu) | `sudo apt install libwebkit2gtk-4.1-dev librsvg2-dev patchelf build-essential libssl-dev libxdo-dev` |

See the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) for other distributions.

### Run and build

```sh
npm ci
npm run tauri dev      # the app with hot reload
npx tauri build        # installers in src-tauri/target/release/bundle/
```

`npm run dev` serves the UI alone in a browser at `http://localhost:1420` with a built-in mock
backend (dev builds only), which is useful for UI work. Add `?scenario=` to the URL to see other
states, for example `?scenario=empty`, `?scenario=offline`, `?scenario=crash` or
`?scenario=update` (see `src/ui/app/mockIpc.ts`).

### Tests and checks

```sh
npm run typecheck                    # app and the pure rules core
npx vitest run                       # TypeScript tests, including the design lint
cd src-tauri && cargo test           # Rust tests; also regenerates src/bindings.ts
cd src-tauri && cargo clippy --all-targets -- -D warnings
```

`src/bindings.ts` is generated from the Rust types by tauri-specta (`npm run bindings`). Don't edit
it by hand; CI fails if regenerating it produces a diff.

## Architecture

| Part | Location | Role |
|---|---|---|
| Rust backend | `src-tauri/src/` | all I/O: discovery, parallel jar scanning and hashing, log digests and watch mode, Modrinth client and cache, fix execution, backups, settings |
| Path guard | `src-tauri/src/guard/` | every file access is checked against the instance folders found or added |
| Bindings | `src/bindings.ts` | generated TypeScript types and commands |
| Rules core | `src/core/` | pure TypeScript (no DOM, no Tauri, no network): pack identity, version ranges, static checks, crash analysis, Modrinth enrichment, reports |
| UI | `src/ui/` | React 19 and Tailwind with the design tokens in `DESIGN.md` |

Rust extracts facts; TypeScript interprets them. A scan returns a `ScanResult`, and the UI runs
`resolvePack` → `buildJarIndex` → `runChecks` from `src/core`. The shared types and invariants are in
`docs/CONTRACTS.md`; the visual rules are in `DESIGN.md`.

## Adding a check

Checks live in `src/core/checks/`, one file per check, registered in `CHECKS` in
`src/core/checks/index.ts`. They receive the scan result and the resolved pack and return
`Finding`s with a code, severity, culprit jars, explanation, evidence and fix actions. They must stay
pure and work without Modrinth data. `src/core/checks/README.md` describes the shared helpers, the
fixtures and the rule that severity mirrors what the loader really does.

## Releasing

1. Set the version in `package.json`, `src-tauri/tauri.conf.json` and `src-tauri/Cargo.toml`.
2. Push a tag `v<version>` (for example `v0.2.0`). The release workflow
   (`.github/workflows/release.yml`) builds Windows (`.msi`, `.exe`), macOS universal (`.dmg`) and
   Linux (`.AppImage`, `.deb`), signs the update bundles, and uploads everything with `latest.json`
   to a draft GitHub Release. It stops early if the tag doesn't match the version in all three
   files, or if the release for that tag is already published. Its last job checks `latest.json`:
   every platform present, every download URL a `github.com` release download of this tag, and
   every updater signature verified against the public key and bound to this version
   (`src-tauri/examples/verify_update_sig.rs`).
3. Review the draft and publish it. Installed apps see the update the next time someone clicks
   "Check for updates".

**Updater signing key.** The updater checks every update against the public key in
`src-tauri/tauri.conf.json` (`plugins.updater.pubkey`). The matching private key:

- never goes in the repository (`*.key` is in `.gitignore`), in logs or in build artifacts;
- is kept by the owner outside the repository, at `%USERPROFILE%\.tauri\modpack-doctor.key`, with
  a backup somewhere safe (losing it means existing installs can no longer verify updates);
- is given to CI as the repository secrets `TAURI_SIGNING_PRIVATE_KEY` (the key file's contents) and
  `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` (only for a password-protected key; the current key has none,
  so it stays unset and the workflow passes an empty value).

OS code signing (Windows Authenticode, Apple notarization) is optional and not set up. Without it,
SmartScreen and Gatekeeper warn on first launch, as described under "Install" in the README.

