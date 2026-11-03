# Modpack Doctor — original brief (verbatim from the project owner)

> This is the source specification. Amendments the owner approved during planning are folded
> into the plan and `docs/CONTRACTS.md`. Where they differ, CONTRACTS.md and DESIGN.md win.
> Approved deviations: native window decorations on every OS (Windows title bar themed via DWM;
> no custom title bar); React 19; the webview has no fs/dialog/store permissions (Rust opens
> dialogs); the asset protocol is scoped to `$APPCACHE/icons/**`; replace/install use the
> version's `primary` file, else its sole file, else fail; the 1 GB log test is `#[ignore]` and a
> ~50 MB variant runs in CI; Modrinth `app.db` is read-only with a SQLITE_BUSY retry and falls back
> to jar-inferred metadata on a schema mismatch.

## Goal
Build a cross-platform desktop app (Windows, macOS, Linux) that:
- automatically finds the user's Minecraft instances,
- diagnoses why a modpack crashes, before or after launch,
- pinpoints the broken jar(s), and
- applies safe, reversible fixes.

It uses the Modrinth API to identify mods and find compatible versions. All analysis runs locally. The only network calls go to the public Modrinth API (api.modrinth.com/v2), and every static check must still work offline.

## Tech stack
- Tauri 2
- Rust backend: `zip` (jars), `sha1`/`sha2` (hashing), `rayon` (parallel scanning), `notify` (file watching), `reqwest` (API calls), `serde`, `toml`, `json5` (lenient Fabric JSON), `tokio`, `thiserror` (typed errors)
- Frontend: Vite + React + TypeScript (strict) + Tailwind, configured with the custom tokens from `DESIGN.md` rather than Tailwind's default palette
- Tests: `cargo test` for Rust, Vitest for TypeScript
- Tauri plugins: dialog, updater (GitHub Releases), store (settings), opener (external links), notification
- Tauri 2 capabilities: grant only the permissions actually used, scoped to the instance folders the user has added or that were auto-detected. No blanket filesystem access.

## Architecture
- The Rust side owns all I/O and heavy work: instance discovery and filesystem access; parallel jar scanning (including nested jars); SHA-1/SHA-512 hashing; log tailing and crash detection; Modrinth API calls, sent with the User-Agent `KingCreeper531/modpack-doctor/<version> (github.com/KingCreeper531/modpack-doctor)`; all file mutations.
- Bindings: Rust exposes typed Tauri commands and emits progress events. Generate the TypeScript bindings with `tauri-specta` so the types can never drift.
- Rules core: `src/core/` holds the pure diagnostic rules (no DOM, no Tauri imports), fed with the JSON scan results from Rust, so a CLI can reuse it later. The UI lives separately.

## Instance discovery
Auto-detect instances on all three operating systems:
- Modrinth App: its `profiles/<name>/` directory. Check both the current `ModrinthApp` data directory and the legacy `com.modrinth.theseus` one. Read each profile's metadata (Minecraft version and loader) where available.
- Prism Launcher / MultiMC: `instances/<name>/` (the game dir may be `.minecraft/` or `minecraft/`). Read `mmc-pack.json` for the Minecraft version and loader.
- CurseForge: its `Instances/<name>/` directory, reading `minecraftinstance.json`.
- Vanilla: the `.minecraft` directory.
- Manual: the user can add any custom folder. Persist the list in settings.

Also accept `.mrpack` files (drag-and-drop or "Open file"):
- Parse `modrinth.index.json`: `files[]` (with path, sha1/sha512 hashes, and env) and `dependencies` (minecraft, forge, neoforge, fabric-loader, quilt-loader).
- Diagnose the declared files by hash without downloading them.
- Scan jars in `overrides/`, `client-overrides/`, and `server-overrides/`.

## Static jar analysis (Rust, parallel)
Detect the loader from the files present:
- Forge: `META-INF/mods.toml`
- NeoForge: `META-INF/neoforge.mods.toml` (1.20.5+). NeoForge 1.20.2–1.20.4 used `mods.toml`, so also classify by dependency modIds: a `neoforge` dependency means NeoForge, `forge` means Forge. NeoForge for 1.20.1 is Forge-compatible, so treat it as compatible with Forge 47.x.
- Fabric: `fabric.mod.json` (parse leniently with json5)
- Quilt: `quilt.mod.json`
- Legacy Forge: `mcmod.info`
- Nested jars: `META-INF/jarjar/metadata.json` (Forge/NeoForge) and Fabric's `jars` field. Recurse into nested jars.

Extract from each jar: mod id(s) and version; declared Minecraft and loader version ranges; required, optional, and incompatible dependencies; mixin config names; Java packages (from `.class` paths, excluding META-INF).

Treat `*.jar.disabled` files as disabled mods: list them, but exclude them from checks.

## Checks (TypeScript, `src/core/`)
Each finding has a severity (error / warning / info), a short code (e.g. `E-SPLIT-PKG`), the culprit jar(s), a plain-English explanation, the evidence (exact metadata or log lines), and one or more fix actions.
1. Pack loader and version: taken from launcher metadata, the .mrpack index, or the majority across jars. The user can override it.
2. Wrong-loader jars.
3. Version range violations: support both Maven-style ranges (`[47,)`, `[1.20,1.20.2)`) and Fabric semver predicates (`>=0.15`, `~1.20.1`, arrays). Build a thoroughly tested range parser for both styles.
4. Missing required dependencies: exclude dependencies satisfied by nested jars and by built-in IDs (`minecraft`, `forge`, `neoforge`, `java`, `fabricloader`, and similar).
5. Duplicate mod IDs.
6. Split packages: the same Java package in two or more top-level jars. This causes `ResolutionException: Module X reads package Y from both A and B`. Name both jars and the package.
7. Declared incompatibilities: `incompatible` / `breaks` entries.
8. Client-only mods in a server instance.

## Crash and log analysis
Parse Forge, NeoForge, Fabric, and Quilt `crash-reports/*.txt`, `logs/latest.log`, and `hs_err_pid*.log`. Stream large files; never load them whole.

Recognize at least:
- `Suspected Mod(s):` blocks and `Mod File:` lines
- the root `Caused by:`
- `Mixin apply failed` / `MixinTransformerError` (map the mixin config to its jar)
- `ResolutionException ... reads package ... from both`
- `Missing or unsupported mandatory dependencies`
- Fabric `Incompatible mods found!`
- `NoClassDefFoundError` / `ClassNotFoundException` (map the package to a jar, or flag a missing dependency)
- JVM out-of-memory errors
- wrong Java version (map the class file major version to a Java version)

Live watch mode: while enabled for an instance, watch `crash-reports/` and `logs/latest.log` with `notify`. When a crash occurs, analyze it automatically and show a native notification ("Modpack crashed — likely cause: X").

## Modrinth integration (Rust)
- `POST /v2/version_files` with SHA-1 hashes for bulk identification.
- `POST /v2/version_files/update` with `loaders` and `game_versions` to find compatible replacements.
- `GET /v2/projects?ids=[...]` for names, icons, and client/server side support.
- Batch everything and respect the rate limit (300/min, with exponential backoff on 429). Cache responses on disk with a TTL.
- Jars not found on Modrinth: label them "Not on Modrinth (possibly CurseForge or manual)" and still run every static check.

## Fix actions
Every mutation must be safe and reversible.
- Before any change, snapshot the affected files into `<app data>/backups/<instance>/<timestamp>/`. Provide an Undo per action and a backup history view.
- Refuse to modify an instance while Minecraft is running. Detect Java processes using that game directory; on Windows, files will also be locked.
- Actions: disable a mod (rename to `.jar.disabled`, which Modrinth App and Prism both respect); re-enable a mod; remove a duplicate; replace with a compatible Modrinth version; install a missing dependency from Modrinth.
- Downloads: always confirm first, showing the mod name, version, file size, and source URL. Only download from Modrinth CDN URLs returned by the API. Verify the SHA-512 after download. Write to a temp file, then rename atomically.
- No silent batches. "Apply all suggested fixes" shows the full work order first.

## UI and UX: distinctive, not "AI-generated"
The app must not look like a generic AI-built dashboard. The design tokens and principles go in `DESIGN.md` as part of the frozen contracts (milestone 1). Build a dev-only `/design` route showing every component and state, then stop and show me screenshots before building the real screens.

### Banned defaults (these are what make an app look vibecoded)
- Purple/blue/indigo gradients, glassmorphism, frosted blur, glowing borders, neon
- Inter, Geist, or system-ui as the primary font
- The stock shadcn/ui look: big `rounded-2xl` cards everywhere, soft drop shadows, everything floating on gray
- Centered hero layouts, oversized empty headings, "Get started" splash screens
- Emoji as icons, sparkle ✨ motifs, gradient text
- Lucide icons (the default everyone uses)
- Every list rendered as a grid of identical cards
- Bouncy spring animations, fade-in-on-everything

### Art direction: "diagnostic instrument"
The app should feel like a precise piece of test equipment crossed with a field-repair manual: dense, calm, technical, confident. It shows lots of information at once without feeling cluttered. Think oscilloscope UI or aircraft maintenance log, not SaaS landing page.
- Color (dark default): warm charcoal base `#14130F`, slightly lifted panel surfaces (`#1C1A16`, `#24221D`), warm off-white text `#E9E4D8`; one signal accent, phosphor amber `#F2A93B`, used for focus, selection, and warnings; errors in red oxide `#D2553A`, OK states in muted moss `#7FA36B`, info in a desaturated slate. Color carries meaning only, never decoration.
- Color (light mode): warm paper `#F4F0E6` with ink `#1E1C18`, using the same semantic hues darkened for contrast. Must pass WCAG AA in both themes.
- Typography: bundle the fonts locally (no CDN). IBM Plex Sans Condensed for UI and headings. IBM Plex Mono for everything technical: versions, hashes, file paths, mod IDs, log lines. Use a tight type scale, letterspaced uppercase for section labels, and tabular numerals wherever numbers align.
- Shape and structure: corner radius 2–4px max; 1px hairline borders instead of shadows; a strict 8px spacing grid; content in ruled panels and tables, not floating cards.
- Icons: Phosphor Icons, regular weight, used sparingly. Custom SVG glyphs for the loaders (Forge, NeoForge, Fabric, Quilt) are welcome, but they must be original designs, not copies of the official logos.

### Signature elements
1. Scan grid: every jar is shown as a small square tile in a dense grid, like inventory slots. Tiles fill in live as Rust reports scan progress. Tiles are colored by status: unscanned, OK, warning, error, disabled. Hovering shows the mod name and status; clicking jumps to that mod. This is the hero visual of the app. It must stay smooth with 500+ tiles (canvas or virtualized).
2. Triage list: findings are shown like a medical chart. Each row has a thick severity rail on its left edge, a monospace finding code, a one-line diagnosis, and the culprit jar(s). Rows expand inline to show the explanation, the highlighted evidence, and fix buttons.
3. Evidence view: crash log excerpts are rendered as a proper log viewer. Line numbers, with culprit lines highlighted in amber. Stack frames that map to a jar are shown as clickable chips.
4. Work-order confirmations: fix confirmations show a checklist of exact file operations, e.g. `rename X → X.disabled` or `download Y 1.4.2 (312 KB) from cdn.modrinth.com`. Each operation shows its status live as it executes. Never a generic "Are you sure?" modal.

### Layout
- Three zones: a narrow instance rail on the left (name, launcher, Minecraft version, loader, mod count, last-scan status); the main workspace: summary strip, then scan grid, then triage list; a resizable inspector panel on the right for the selected mod or finding.
- Summary strip: one dense line, not big stat cards. For example: `1.20.1 · Forge 47.3.0 · 214 mods · 3 errors · 5 warnings · scanned 2.1s ago`.
- Mod table: dense and sortable. Columns: icon, name, monospace version, loader, Modrinth match, status, and an inline enable toggle.
- Empty states are useful, not cute: show which launchers were checked, where the app looked, and a button to add a folder.
- Progress: scan progress streams from Rust events, and the UI never blocks.
- Report export: copy as Markdown (for Discord and GitHub issues) or save as JSON.
- No affiliation implied: no Modrinth logo; include a disclaimer in the About dialog.

### Motion
- 120–180ms ease-out, used only to show state change: tiles filling, rows expanding, panels resizing.
- No page transitions or entrance animations.
- Respect `prefers-reduced-motion`.

### Native feel
- Keyboard-first: `Ctrl/Cmd+K` opens a command palette for instances and actions; `J` / `K` move through findings; `Enter` expands; `Ctrl/Cmd+R` rescans.
- Right-click context menus on mods and findings.
- (Amended: native window decorations on all OSes.)

### Visual review loop
After building each major screen, take screenshots in both themes at 1280×800 and 1920×1080. Compare them against `DESIGN.md` and the banned list, and fix any drift before moving on. The independent review agent repeats this check at the end of each UI milestone.

## Distribution
- Release workflow: a GitHub Actions workflow builds on tag push and publishes to GitHub Releases with updater signatures. Targets: Windows (.msi and .exe); macOS (universal .dmg); Linux (.AppImage and .deb).
- Updater: the Tauri updater points at GitHub Releases. Generate the signing keypair and document storing the private key as a GitHub secret.
- OS code signing (Windows Authenticode, Apple notarization) is optional. Set up the config hooks via environment variables and document that unsigned builds trigger SmartScreen and Gatekeeper warnings.

## Quality bar
- TypeScript: strict, with no `any` in `src/core/`.
- Rust: passes `cargo clippy -- -D warnings`. No `unwrap()` outside tests. Errors are typed with `thiserror` and surfaced to the UI as readable messages.
- Rust tests: fixture jars generated in-test, covering: every loader's metadata; nested jars; hashing; launcher discovery (with temp-dir fakes of each launcher layout); backup and restore; atomic replace; the running-game guard.
- TypeScript tests: every check, both range syntaxes, NeoForge/Forge disambiguation, and crash-log samples for each loader.
- Robustness: handle corrupt jars, permission errors, missing launcher folders, symlinks, non-ASCII paths, huge logs, partial API failures, and offline mode.
- Performance: a 300-mod instance fully scanned in under 5 seconds on a mid-range laptop.
- README: features, a screenshots placeholder, dev setup (including the Rust and Tauri prerequisites per OS), architecture, how to add a check, the backup and safety model, and the release process.

## Milestones
Commit after each milestone, with all tests passing and an independent review agent's report addressed.
1. Research and contracts. Run the parallel research agents. Write and freeze the shared contracts: Rust↔TS types, Tauri commands, `Finding`/`FixAction`, and `DESIGN.md`. Scaffold Tauri with `tauri-specta` bindings. Stop for approval.
2. Foundations, in parallel. Work streams: the jar scanner and metadata parsers; launcher discovery; the version range parser; the crash log pattern library and fixtures; the Modrinth client and cache; the `/design` component sheet. Stop and show design screenshots.
3. Static checks, end to end. Instance rail, scan grid, triage list, inspector, and mod table, all wired to real scans.
4. Crash analysis. The crash/log analyzer, the evidence view, and live watch mode with notifications.
5. Modrinth in the UI. Identification, update suggestions, and project metadata surfaced in the UI.
6. Fix actions. Backups, undo, backup history, the running-game guard, and work-order confirmations.
7. Finishing features. .mrpack support, report export, the command palette and keyboard shortcuts, context menus, and the light theme.
8. Release. The release workflow, the updater, and the README.

Working-style rules (subagents, one owner per file, frozen contracts, independent reviewer per milestone, integrator runs all checks) apply to every milestone.
