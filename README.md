# Modpack Doctor

A desktop app for Windows, macOS and Linux that finds your Minecraft instances, works out why a
modpack crashes (before or after launch), names the jar or jars responsible, and applies fixes you
can undo.

It reads jar metadata and logs on your machine. The only network service it uses for diagnosis is
the public Modrinth API, and every static check also works offline.

Modpack Doctor is not affiliated with or endorsed by Modrinth, Mojang, Microsoft, Forge, NeoForge,
Fabric, or Quilt. Mod data comes from the Modrinth API.

## Contents

- [What it does](#what-it-does)
- [Screenshots](#screenshots)
- [Install](#install)
- [Privacy and network](#privacy-and-network)
- [Safety model](#safety-model)
- [Build from source](#build-from-source)
- [Architecture](#architecture)
- [Adding a check](#adding-a-check)
- [Releasing](#releasing)
- [Disclaimer](#disclaimer)
- [License](#license)

## What it does

### Finds instances

Instances are found automatically on all three operating systems:

| Source | Where it looks | Metadata read |
|---|---|---|
| Modrinth App | `profiles/<name>/` in the current and the legacy (`com.modrinth.theseus`) data folder | the app's profile database, read-only |
| Prism Launcher / MultiMC | `instances/<name>/` (game dir `.minecraft/` or `minecraft/`) | `mmc-pack.json` |
| CurseForge | `Instances/<name>/` | `minecraftinstance.json` |
| Vanilla | the `.minecraft` folder | `launcher_profiles.json` |
| Manual folders | any folder you add (kept in settings) | inferred from the jars |
| `.mrpack` files | opened from a file dialog or dropped on the window | `modrinth.index.json` |

A launcher installed somewhere unusual can be pointed at with "Add a launcher's data folder".
`.mrpack` files are opened read-only and never extracted: the files the index declares are checked
by hash without downloading them, and the jars directly in `overrides/mods/`,
`client-overrides/mods/` and `server-overrides/mods/` get every static check (other jars under the
override folders are listed as scan issues, not checked).

### Static checks

Every jar is scanned in parallel, nested jars included (Forge/NeoForge Jar-in-Jar, Fabric `jars`).
The scan reads the loader metadata (`mods.toml`, `neoforge.mods.toml`, `fabric.mod.json`,
`quilt.mod.json`, `mcmod.info`), mod ids and versions, declared Minecraft and loader ranges,
dependencies, mixin configs and Java packages. `*.jar.disabled` files are listed but not checked.

| Code | Severity | Meaning |
|---|---|---|
| `E-WRONG-LOADER` | error | jar targets a loader the pack doesn't run (NeoForge 1.20.1 counts as Forge 47.x) |
| `E-MC-RANGE` | error | declared Minecraft range excludes the pack's Minecraft version |
| `E-LOADER-RANGE` | error | declared loader range excludes the pack's loader version |
| `E-DEP-RANGE` | error | a dependency is present but outside the declared version range |
| `E-MISSING-DEP` | error | a required dependency is absent (built-ins, `provides` and nested jars count as present) |
| `E-DUP-ID` | error | two active jars declare the same mod id |
| `E-SPLIT-PKG` | error | the same Java package in two or more jars on Forge/NeoForge (`ResolutionException`) |
| `I-SPLIT-PKG` | info | the same, on Fabric/Quilt |
| `E-INCOMPAT` | error or warning | a declared incompatibility is present and in range |
| `W-CLIENT-ON-SERVER` | warning | client-only mod in a server instance |
| `W-CORRUPT-JAR` | warning | jar unreadable or its metadata invalid |
| `W-JAVA-CLASS` | warning | class files need a newer Java than the pack's Minecraft version ships with |
| `W-MRPACK-DOWNLOAD` | warning | a `.mrpack` lists a download outside Modrinth's allowed hosts |
| `I-NOT-ON-MODRINTH` | info | hash not found on Modrinth (possibly CurseForge or a manual download) |

Version ranges are evaluated the way the loaders do it: Maven ranges as FML compares them, and
Fabric predicates as fabric-loader does, including year-based Minecraft versions.

### Crash analysis

Crash reports (`crash-reports/*.txt`), `logs/latest.log` and HotSpot `hs_err_pid*.log` files from
Forge, NeoForge, Fabric and Quilt are parsed as streams, so large logs are never loaded whole. The
evidence view shows the relevant lines with line numbers, and stack frames that map to a jar link
to that mod.

| Code | Recognises |
|---|---|
| `C-SUSPECTED` | `Suspected Mod(s):` blocks and `Mod File:` lines |
| `C-MIXIN` | `Mixin apply failed` / `MixinTransformerError`, mapped to the jar that owns the mixin config |
| `C-RESOLUTION` | `ResolutionException … reads package … from both` |
| `C-MISSING-MANDATORY` | `Missing or unsupported mandatory dependencies` |
| `C-FABRIC-INCOMPAT` | Fabric's `Incompatible mods found!` |
| `C-NOCLASSDEF` | `NoClassDefFoundError` / `ClassNotFoundException`, mapped to a jar or a missing dependency |
| `C-OOM` | JVM out-of-memory errors |
| `C-JAVA-VERSION` | wrong Java version (class file major version mapped to a Java version) |
| `C-NATIVE` | native crashes from `hs_err` files (the problematic frame and library) |
| `C-ROOT-CAUSE` | fallback: the innermost `Caused by:`, mapped to a jar when possible |

**Watch mode** (per instance) follows `crash-reports/` and `logs/latest.log` while you play. When
the game crashes, the crash is analysed and a native notification names the likely cause. A normal
quit produces nothing.

### Modrinth identification and updates

Jars are identified on Modrinth by SHA-1 in batches. The mod table shows each mod's Modrinth match,
icon and side support, and offers a compatible newer version when one exists for the pack's loader
and Minecraft version. Release versions only, unless "Suggest beta updates" is on; alpha versions
are never suggested. Jars that aren't on Modrinth are labelled that way and still get every static
check. "Look up mods online" can be switched off at any time.

### Fixes

Fixes are offered next to the finding they address:

- disable a mod (rename to `.jar.disabled`, which Modrinth App and Prism respect) or enable it again;
- remove a duplicate (moved into the backup, never deleted);
- replace a mod with a compatible version from Modrinth;
- install a missing dependency from Modrinth.

Every fix is shown as a work order, a numbered list of the exact file operations, before anything
happens. See [Safety model](#safety-model).

### Other

- Command palette (Ctrl+K / Cmd+K), J/K to move through findings, Enter to expand, Ctrl+R / Cmd+R
  to rescan, right-click menus on mods and findings.
- Report export: Markdown (for Discord and GitHub issues) or JSON. Paths in the report are relative
  to the game folder, with your home folder shown as `~`.
- Dark and light themes, or follow the system.

## Screenshots

Screenshots are not committed to the repository. The visual review writes them to
`docs/screenshots/<milestone>/` when you run it locally, for example:

- `docs/screenshots/m7/default-1280-dark.png`: an instance with findings, scan grid and inspector
- `docs/screenshots/m7/crash-1280-dark.png`: crash analysis with the evidence view
- `docs/screenshots/m7/order-1280-dark.png`: a work order before Execute
- `docs/screenshots/m7/history-1280-dark.png`: backup history with Undo
- `docs/screenshots/m7/pack-1280-dark.png`: an opened `.mrpack`
- `docs/screenshots/m7/palette-1280-dark.png`: the command palette

Each exists in a `-light` variant and some at 1920 wide. They appear only after you build the app
and run the visual review.

## Install

Download the installer for your system from the
[GitHub Releases](https://github.com/KingCreeper531/modpack-doctor/releases) page:

| System | File |
|---|---|
| Windows | `.msi` or the `.exe` setup |
| macOS (Apple silicon and Intel) | universal `.dmg` |
| Linux | `.AppImage` or `.deb` |

The installers are not code-signed with an OS certificate yet. Windows SmartScreen and macOS
Gatekeeper will warn on first launch. On Windows choose "More info" then "Run anyway". On macOS 15
and newer, open the app once, dismiss the warning, then go to System Settings → Privacy & Security
and click "Open Anyway" next to Modpack Doctor (on older macOS, right-click the app and choose
Open).

**Updates** are checked only when you ask: About → "Check for updates", or "Check for updates" in
the command palette. If a newer release exists, About shows its version, date and notes; nothing is
downloaded until you click "Install <version> and restart". Every update is verified against the
app's updater signature before it is installed. Installing is refused while a work order is running.

## Privacy and network

- **Modrinth** (`api.modrinth.com`, `cdn.modrinth.com`): mod identification by file hash, update
  suggestions, project names and icons, and downloads you confirm in a work order. Requests send the
  User-Agent `KingCreeper531/modpack-doctor/<version> (github.com/KingCreeper531/modpack-doctor)`.
  Responses and icons are cached on disk. Switch off "Look up mods online" in the rail footer to
  stop all Modrinth requests; static checks keep working.
- **GitHub** (`github.com`, which redirects release downloads to `objects.githubusercontent.com` /
  `release-assets.githubusercontent.com`): only when you click "Check for updates" or "Install …
  and restart".
- Nothing else. There is no telemetry or analytics, and no account.
- **Offline:** discovery, scanning, every static check and crash analysis run without a network.
  Modrinth lookups then show `Modrinth unreachable — static checks only`.
- The app's web view has no file system, shell or HTTP access of its own. All file access happens in
  the Rust backend, which reads and writes only:
  - the instance folders it found or you added (fixes change files only through a work order);
  - its own data folder (settings, backups) and cache folder (Modrinth responses, icons);
  - `.mrpack` files you open, read-only;
  - the report file you choose in the save dialog;
  - when you install an update, the downloaded installer and the app's own install location.

## Safety model

- **Work orders.** Every change, including the enable/disable toggle in the mod table, is planned
  first and shown as a numbered list of file operations (rename, move to backup, download with size
  and source URL). Nothing runs until you press Execute. There are no silent batches.
- **Backups.** Before the first change, the affected files are recorded under
  `<app data>/backups/<instance>/<timestamp>/`. Files that a fix replaces or removes are moved there.
  Backups are never deleted automatically.
- **Undo.** Every executed action can be undone from the History tab, one action at a time or all
  remaining. Undo is itself a work order and refuses to overwrite a file you changed since.
- **Nothing is deleted.** "Remove" moves the file into the backup snapshot.
- **Rollback and recovery.** If an operation fails, the completed ones are reversed in order. An
  order interrupted by a crash or power loss is detected on the next start and can be recovered from
  the History tab.
- **Game guard.** Changes are refused while Minecraft is running for that instance, checked again
  right before anything is touched.
- **Downloads** come only from `cdn.modrinth.com` URLs returned by the API, are checked against the
  version's SHA-512, written to a temporary file, and renamed into place. A downloaded jar must
  declare the expected mod id.
- **`.mrpack` files** are read-only and never changed.

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
SmartScreen and Gatekeeper warn on first launch, as described under [Install](#install).

## Disclaimer

Modpack Doctor is not affiliated with or endorsed by Modrinth, Mojang, Microsoft, Forge, NeoForge,
Fabric, or Quilt. Mod data comes from the Modrinth API. The loader icons in the app are
original drawings, not the projects' logos, and the app does not use the Modrinth logo.

## License

License: TBD by the owner.
