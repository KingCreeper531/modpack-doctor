# Launcher instance discovery: research notes (R1)

Researched 2026-11-02. Primary sources are launcher source code read on GitHub on that date.
Commit and release dates are given for each so later readers can tell when a fact may be out of date.

| Source | State read |
|---|---|
| modrinth/code `main` (`packages/app-lib`) | last migration commit 2026-11-02; latest release **v0.22.1 (2026-10-29)** |
| PrismLauncher/PrismLauncher `develop` + tag `11.1.1` | latest release **11.1.1 (2026-09-28)**; `Application.cpp` last changed 2026-10-02 |
| MultiMC/Launcher `develop` | last commit 2026-11-03 |
| CurseForge app | closed source; official support articles (2025-11, 2026-10) + community importers |
| minecraft.wiki | `.minecraft` page edited 2026-10-30; `launcher_profiles.json` page edited 2026-09-18 |

Path notation: on Windows `%APPDATA%` = `C:\Users\<u>\AppData\Roaming`. On Linux, `$XDG_DATA_HOME` defaults to `~/.local/share` and `$XDG_CONFIG_HOME` defaults to `~/.config`. Rust's `dirs::data_dir()` returns `%APPDATA%` (Windows), `~/Library/Application Support` (macOS) and `$XDG_DATA_HOME` (Linux).

---

## 1. Modrinth App (formerly "Theseus")

### Paths

| OS | Current (`ModrinthApp`) | Legacy (`com.modrinth.theseus`, pre‑SQLite builds) |
|---|---|---|
| Windows | `%APPDATA%\ModrinthApp\` | `%APPDATA%\com.modrinth.theseus\` |
| macOS | `~/Library/Application Support/ModrinthApp/` | `~/Library/Application Support/com.modrinth.theseus/` |
| Linux | `$XDG_DATA_HOME/ModrinthApp/` | `$XDG_CONFIG_HOME/com.modrinth.theseus/` (note: **config** dir) |
| Linux Flatpak (`com.modrinth.ModrinthApp`, on Flathub at 0.22.1) | `~/.var/app/com.modrinth.ModrinthApp/data/ModrinthApp/` (inferred: Flatpak sets `XDG_DATA_HOME`) | — |

- The identifier `ModrinthApp` comes from `apps/app/tauri.conf.json` (`"identifier": "ModrinthApp"`). The settings dir is `dirs::data_dir()/<identifier>`, unless the env var `THESEUS_CONFIG_DIR` overrides it (`packages/app-lib/src/state/dirs.rs`, `initial_settings_dir_path`).
- Legacy location: `legacy_converter.rs` → `default_settings_dir()` = `dirs::config_dir()/com.modrinth.theseus`, reading `settings.json` and `profiles/<name>/profile.json`. The converter migrates this data into `app.db` once.
- There are **two roots**:
  - `settings_dir` always holds `app.db` (plus `app.db-wal`, `app.db-shm`) and `launcher_logs/`.
  - `config_dir` = `settings.custom_dir` if set, else the same as `settings_dir`. It holds `profiles/`, `meta/` (versions, libraries, assets, `java_versions`), `caches/`, `icons/`, `store/` (content store) and `synced-options/`.
- Instance dir: `<config_dir>/profiles/<path>/`. This *is* the game dir: `mods/`, `config/`, `logs/latest.log`, `crash-reports/` sit directly inside it (`dirs.rs`: `INSTANCES_FOLDER_NAME = "profiles"`, `crash_reports_dir`, `instance_logs_dir`).
- **Custom data directory**: the column `settings.custom_dir` (TEXT NULL) in `app.db`, with `prev_custom_dir` alongside it. `settings` is a single-row table with `id = 0` (`migrations/20240711194701_init.sql`). The app reads it during `State::init` → `DirectoryInfo::init(settings.custom_dir, …)` (`state/mod.rs`).

### Per-profile metadata: SQLite `app.db`, two schema generations

Old builds (theseus ≤ ~0.7, before mid‑2024) kept a `profile.json` in each profile folder. That file is gone now, so **metadata must be read from `app.db`.**

**Gen A: v0.8.x through v0.14.x** (`20240711194701_init.sql`, plus `20250428171350_add-profile-feature-version.sql`, `…protocol-versions.sql`, `20260529120000_profile-prerelease-updates.sql`)

```sql
-- table: profiles  (folder key = path, which is also the PK-like unique key)
SELECT path, name, game_version, mod_loader, mod_loader_version, install_stage,
       linked_project_id, linked_version_id
FROM profiles;
-- mod_loader ∈ 'vanilla','forge','fabric','quilt','neoforge'; mod_loader_version NULL for vanilla
-- groups / override_* columns are JSONB (binary): wrap with json(col) to read as text
```

**Gen B: v0.15.0 (2026-06-26) and later, current through v0.22.1.**

`20260611120000_instances-content-foundation.sql` copies `profiles` into new tables. Then `20260619120000_finish-instance-profile-migration.sql` runs **`DROP TABLE profiles`**. The Minecraft version and loader now live on a "content set":

```sql
SELECT i.id, i.path, i.name, i.install_stage,
       cs.game_version, cs.loader, cs.loader_version, cs.source_kind
FROM instances i
JOIN instance_content_sets cs ON cs.id = i.applied_content_set_id;
-- instances:   id TEXT PK (migrated rows: 'legacy:<path>'), path TEXT UNIQUE (= folder name under profiles/),
--              name, icon_path, install_stage, launcher_feature_version, update_channel, created, modified, last_played
-- instance_content_sets: id, instance_id, name, source_kind ('local'|'modrinth_modpack'|'server_project'),
--              status, game_version, protocol_version, loader, loader_version
-- install_stage ∈ installed | minecraft_installing | pack_installed | pack_installing | not_installed
```

Other tables a diagnoser may find useful:

- `instance_files(instance_id, relative_path, file_name, enabled, sha1, size, missing)` is the launcher's own index of the files in `mods/` and other content folders.
- `instance_content_entries(project_id, version_id, file_id, enabled, …)` links those files to Modrinth projects.
- `instance_links(link_kind, modrinth_project_id, modrinth_version_id, …)` records the modpack origin.
- `instance_quarantines(instance_id)` was added 2026-07-23.
- `hidden_instances(user_id, instance_id)` was added 2026-10-27.
- `processes(pid, instance_id, …)` lists running games.

To find out which schema a database uses, check `SELECT name FROM sqlite_master WHERE type='table' AND name IN ('instances','profiles')`.

- **Loader strings**: lowercase `vanilla|forge|fabric|quilt|neoforge` (`state/instance_types.rs`, `ModLoader::as_str`).
- **`.jar.disabled`**: **yes, Modrinth respects it.** The scanner sets `enabled: !file_name.ends_with(".disabled")` and strips `.disabled` before checking the extension (`state/instances/adapters/filesystem.rs`, `content_store/domain/paths.rs`). Mods are `.jar` files. Resource packs, shader packs and data packs are `.zip` or `.jar`.
- Ignore temp files named `.modrinth-<uuid>.tmp` in content folders. They are written during installs (`content_store/adapters/filesystem.rs`).
- **Content store** (`20260910120000_shared-content-store.sql`, released by v0.22): files are deduplicated under `<config_dir>/store/content`. The `materialization_kind` column allows `'reflink' | 'hardlink' | 'copy'`. Current `main` writes copies (`FileStorageKind::Copy`), but future builds may hardlink. Treat mod jars as possibly hardlinked: never modify them in place.

---

## 2. Prism Launcher and MultiMC

### Paths

| Variant | Data dir (contains `prismlauncher.cfg` / `multimc.cfg`) |
|---|---|
| Prism, Windows | `%APPDATA%\PrismLauncher\` |
| Prism, Windows Scoop | `%USERPROFILE%\scoop\persist\prismlauncher\` (Prism wiki) |
| Prism, macOS | `~/Library/Application Support/PrismLauncher/` |
| Prism, Linux | `$XDG_DATA_HOME/PrismLauncher/` |
| Prism, Flatpak | `~/.var/app/org.prismlauncher.PrismLauncher/data/PrismLauncher/` |
| Prism, Snap (`prismlauncher`, beta channel) | `$SNAP_USER_COMMON` = `~/snap/prismlauncher/common/` (inferred from code) |
| Prism, portable (Win/Linux only) | `<root>/UserData/` if it exists, else `<root>/` if `<root>/portable.txt` exists. `<root>` is the exe dir on Windows, or `bin/..` on Linux |
| Prism, any OS | `--dir <path>` or env `PRISMLAUNCHER_DATA_DIR` override everything |
| MultiMC, Windows / Linux tarball | always portable: the folder containing the binary (`applicationDirPath()`), e.g. `C:\MultiMC\`, `~/MultiMC/` |
| MultiMC, Linux deb/AUR bootstrap | commonly `~/.local/share/multimc/` (packaging, not upstream) |
| MultiMC, macOS | `MultiMC.app/Data/` (`applicationDirPath()/../../Data`), e.g. `/Applications/MultiMC.app/Data` |

Sources:
- Prism `launcher/Application.cpp` (develop and 11.1.1). The order is: `--dir`, then `<NAME>_DATA_DIR`, then Snap, then `AppDataLocation/..`, then portable checks.
- https://prismlauncher.org/wiki/getting-started/data-location
- MultiMC `launcher/Application.cpp` (develop, about lines 306–328).
- Prism also migrates data from PolyMC (`polymc.cfg`) and MultiMC (`multimc.cfg`) on first run, and its settings loader still accepts those names.

### `InstanceDir` and the instance layout

- `InstanceDir` is set in `prismlauncher.cfg` or `multimc.cfg` (INI). The default is `instances`.
- The launcher runs `QDir::setCurrent(dataPath)`, so a **relative value is resolved against the data dir** and an absolute value is used as-is.
- Values are Qt-style. Expect forward slashes even on Windows (`D:/Games/Instances`). There may or may not be a `[General]` section header; Modrinth's importer handles both forms (`api/pack/import/mmc.rs`, `get_instances_subpath`).
- Unreleased: Prism `develop` adds `AdditionalInstanceDirs` (a string list). It is not in 11.1.1. macOS builds also store `InstanceDirBookmark` (a security-scoped bookmark for a possible sandboxed build).
- An instance is **any subfolder of the instance dir that contains `instance.cfg`** (`InstanceList.cpp`). The instance ID is the folder name.
- Skip dot-folders: `.LAUNCHER_TEMP`, `.tmp` staging and similar.
- Groups are stored in `instgroups.json`. In develop it lives in the data dir; the legacy location is the instance dir.
- Game dir (`MinecraftInstance::gameRoot`): use `<inst>/.minecraft` **only if it exists and `<inst>/minecraft` does not**; otherwise use `<inst>/minecraft`. MultiMC follows the same rule.
- `instance.cfg` (INI) keys:
  - `InstanceType=OneSix`
  - `name`
  - `iconKey`
  - `ManagedPack`, `ManagedPackType` (`modrinth` / `flame` / …), `ManagedPackID`, `ManagedPackVersionID`
  - `OverrideJavaLocation`, `JavaPath`
  - `OverrideMemory`, `MaxMemAlloc`
  - `JvmArgs`
- Prism keeps packwiz-style metadata in `<game>/mods/.index/*.pw.toml`, with a hash and the Modrinth/CurseForge IDs. Read it if you need project IDs.

### `mmc-pack.json` (`launcher/minecraft/PackProfile.cpp`, `Component.cpp`)

```json
{ "formatVersion": 1,
  "components": [
    { "uid": "org.lwjgl3", "version": "3.3.1", "dependencyOnly": true },
    { "uid": "net.minecraft", "version": "1.20.1", "important": true },
    { "uid": "net.fabricmc.intermediary", "version": "1.20.1", "dependencyOnly": true },
    { "uid": "net.fabricmc.fabric-loader", "version": "0.16.5", "cachedName": "Fabric Loader" },
    { "uid": "net.minecraftforge", "version": "47.3.0", "disabled": true } ] }
```

- Minecraft version: `version` of the `net.minecraft` component. `cachedVersion` is a fallback if `version` is empty.
- Loader: Prism's `Component::KNOWN_MODLOADERS` map lists the loader UIDs.

  | Loader | `uid` | Example `version` |
  |---|---|---|
  | Forge | `net.minecraftforge` | `47.3.0` (no MC prefix) |
  | NeoForge | `net.neoforged` | `21.1.77`, or `47.1.x` on 1.20.1 |
  | Fabric | `net.fabricmc.fabric-loader` | `0.16.5` |
  | Quilt | `org.quiltmc.quilt-loader` | `0.26.4` |
  | LiteLoader | `com.mumfrey.liteloader` | — |

  No loader UID means vanilla.
- **Skip components with `"disabled": true`.** Prism only counts loaders where `isEnabled()` is true.
- Ignore `dependencyOnly` helper components: `net.fabricmc.intermediary`, `org.lwjgl*`, and Java runtime UIDs such as `net.minecraft.java` and `net.adoptium.java`.
- Both `meta.multimc.org` and `meta.prismlauncher.org` currently list the forge, neoforged, fabric-loader and quilt-loader UIDs, so MultiMC instances can carry all of them too. This was checked live on 2026-11-02.
- **`.jar.disabled`**: **yes for Prism and MultiMC.** Prism's `Resource.cpp` treats a `*.disabled` suffix as disabled and appends `.disabled` when the user disables a file.

---

## 3. CurseForge app (closed source)

| OS | Default "Minecraft modding folder" root | Instances |
|---|---|---|
| Windows | `%USERPROFILE%\curseforge\minecraft\` | `…\Instances\<name>\` |
| macOS | `~/Documents/curseforge/minecraft/` (community-reported) | `…/Instances/<name>/` |
| Linux | official client: AppImage + `.deb` ("Ubuntu officially supported", Minecraft Java + WoW only). Root is likely `~/curseforge/minecraft/` or `~/Documents/curseforge/minecraft/` (unverified) | `…/Instances/<name>/` |

- Modrinth's own CurseForge importer checks `home/curseforge/minecraft` first, then falls back to `documents/curseforge/minecraft`, and uses `<root>/Instances` (`api/pack/import/mod.rs`). NoRisk launcher's importer checks the same two roots and accepts `Instances` or `instances`. So the community consensus is: probe both roots on every OS.
- **Custom location**: the user can change it in Settings → Minecraft → "Minecraft Modding Folder" → Change (support article updated 2026-10-13: https://support.curseforge.com/support/solutions/articles/9000238895). **Where this setting is persisted is undocumented.** I could not verify it; see "Uncertain".
- `<root>/Install/` holds the shared versions, libraries and assets. Each `Instances/<name>/` folder **is the game dir**: `mods/`, `config/`, `logs/`, `crash-reports/`.
- Linux client article: https://support.curseforge.com/support/solutions/articles/9000265088 (updated 2025-11-16).

### JVM working directory (where `hs_err_pid<pid>.log` lands) — verified 2026-11-07

CurseForge does not start Java itself. It runs Mojang's native launcher (`Install/minecraft.exe`)
with `<root>/Install` as the launcher's `--workDir`, and that launcher starts the game. Evidence,
gathered read-only on the owner's Windows 11 machine (CurseForge root
`%USERPROFILE%\curseforge\minecraft`, 10+ instances, launcher core 3.12.30 in 2025-04 and 3.22.20
in 2025-11):

1. `Install/launcher_log.txt`, `LauncherMain.cpp(424)`: `workDir: %USERPROFILE%\curseforge\minecraft\Install`.
   So `Install` is the *launcher's* working dir. It also holds `launcher_accounts.json`,
   `launcher_msa_credentials.bin`, `launcher_profiles.json` and the `launcher_log*.txt` files,
   which is why it must never become a PathGuard root.
2. Every game start in all ten `launcher_log*.txt` files (8 starts, 3 instances, both launcher
   versions) is logged by `MinecraftJavaRunningContext.cpp(158)` as `Starting game in folder
   %USERPROFILE%\curseforge\minecraft\Instances\<name> using java executable …`, i.e. the
   instance folder, the same path the game gets as `--gameDir` and
   `-Dminecraft.applet.TargetDirectory`.
3. Independent check through a relative path: Forge's `log4j2.xml` (inside
   `Install/libraries/net/minecraftforge/fmlloader/1.20.1-47.4.0/fmlloader-1.20.1-47.4.0.jar`)
   writes `fileName="logs/latest.log"` and `logs/debug.log`, relative to the JVM's working
   dir. Those files exist in `Instances/<name>/logs/` (e.g. a 1 MB `latest.log` from the
   2025-11-16 session), and `Install/` has **no** `logs/` or `crash-reports/` folder.
4. No `hs_err_pid*.log` exists anywhere under the CurseForge root on this machine (no native
   crash has happened), so the location could not be observed directly.

**Conclusion:** with current CurseForge (vanilla launcher core ≥ 3.12) the JVM runs **in the
instance folder**, so its hs_err files land in the game dir and are already listed with plain
`hs_err_pid<pid>.log` ids. The `Install` folder is *not* the JVM's working dir today. The
read-only PathGuard hs_err rule for `Install` (CONTRACTS invariant 11, owner decision
2026-11-07) is kept as a defensive measure, for older or future launcher builds or a JVM that
reports `Install` as its working dir. It reads only `hs_err_pid<pid>.log` files directly in
`Install`, attributed by the `--gameDir` in their `Command Line:`.

The same launcher binary logs "Starting game in folder <game dir>", so the vanilla launcher
itself most likely runs a profile with a custom `gameDir` in that folder too, not in
`.minecraft`. The `.minecraft` launcher logs on this machine contain no game start, so this is
unverified for vanilla; the `.minecraft` rule stays as it is.

### `minecraftinstance.json` (community-derived key names)

Key names are confirmed by Modrinth `api/pack/import/curseforge.rs`, NoRisk `curseforge_app.rs` and Pandora `launcher_import/curseforge.rs`. Values in this example are illustrative.

```json
{ "name": "All the Mods 9", "gameVersion": "1.20.1",
  "baseModLoader": { "name": "forge-47.3.0", "forgeVersion": "47.3.0",
                     "minecraftVersion": "1.20.1", "type": 1 },
  "installedModpack": { "addonID": 715572, "thumbnailUrl": "…", "installedFile": { "id": 5800000, "fileName": "…zip" } },
  "installedAddons": [
    { "addonID": 238222, "installedFile": { "id": 4712866, "fileName": "jei-1.20.1-forge-15.2.0.27.jar",
        "fileFingerprint": 1234567890, "hashes": [ { "type": 1, "value": "<sha1>" } ], "gameVersion": ["1.20.1","Forge"] } } ],
  "isMemoryOverride": false, "allocatedMemory": 8192, "profileImagePath": null }
```

- **Loader**: `baseModLoader` is `null` or absent for vanilla. Split `baseModLoader.name` on `-`:

  | Loader | `name` format |
  |---|---|
  | Forge | `forge-47.3.0` |
  | NeoForge | `neoforge-21.1.256` |
  | Fabric | `fabric-0.15.11-1.20.1` (loader version, then MC version) |
  | Quilt | `quilt-<ver>-<mc>` (by analogy with Fabric; verify) |

- `forgeVersion` holds the loader version **for every loader**, not just Forge.
- `type` follows the CurseForge API `ModLoaderType` enum: 0 Any, 1 Forge, 2 Cauldron, 3 LiteLoader, 4 Fabric, 5 Quilt, 6 NeoForge. See https://docs.curseforge.com/rest-api/#tocS_ModLoaderType.
- Modrinth's importer only parses `forge-` and `fabric-`, so don't copy it blindly.
- **Mods list**: `installedAddons[].installedFile.fileName` is the jar name. Also read:
  - `fileFingerprint`: CurseForge **MurmurHash2** (seed 1, whitespace bytes stripped). It can be used with the CF `/v1/fingerprints` API.
  - `hashes[]`: `type` 1 = SHA‑1, 2 = MD5, per the CF `HashAlgo` enum.
  - `addonID` (project ID) and `installedFile.id` (file ID).
- Older files spell the disk name as `FileNameOnDisk` / `fileNameOnDisk` (a 2017 Curse client gist). Accept both spellings, case-insensitively.
- `installedAddons` lists only CF-managed files. Always also scan `mods/`, because manually added jars are missing from the JSON.
- **`.jar.disabled`**: CurseForge disables a mod by renaming it to `*.jar.disabled`. The JSON may still list it, so trust the filesystem suffix. This is community knowledge; verify it against a real install.

---

## 4. Vanilla launcher

| OS | Default game dir |
|---|---|
| Windows (classic installer *and* MS Store/Xbox app) | `%APPDATA%\.minecraft\` |
| macOS | `~/Library/Application Support/minecraft/` (no dot) |
| Linux | `~/.minecraft/` |
| Linux Flatpak `com.mojang.Minecraft` (exists on Flathub) | likely `~/.var/app/com.mojang.Minecraft/.minecraft/` (unverified) |

Source: https://minecraft.wiki/w/.minecraft (edited 2026-10-30).

- **Vanilla signals**: the root contains `launcher_profiles.json` (or `launcher_profiles_microsoft_store.json`), `versions/<id>/<id>.json`, `libraries/`, `assets/`, and `launcher_accounts*.json`. **None** of `instance.cfg`, `mmc-pack.json` or `minecraftinstance.json` is present, and it is not a Modrinth `profiles/` child.
- `launcher_profiles.json` (https://minecraft.wiki/w/Launcher_profiles.json, edited 2026-09-18):

```json
{ "profiles": { "a1b2…": { "name": "Fabric 1.20.1", "type": "custom",
      "lastVersionId": "fabric-loader-0.15.11-1.20.1",
      "gameDir": "D:\\Packs\\MyPack", "javaArgs": "-Xmx6G", "lastUsed": "2026-10-01T…Z" } } }
```

- `type` is `custom`, `latest-release` or `latest-snapshot`.
- **`gameDir` absent** means the profile uses the `.minecraft` root. If present, treat each distinct `gameDir` as a separate instance (it may be relative; resolve it against `.minecraft`).
- **Loader** comes from `lastVersionId` (`fabric-loader-<lv>-<mc>`, `quilt-loader-<lv>-<mc>`, `1.20.1-forge-47.3.0`, `neoforge-21.1.77`). Confirm it via `versions/<id>/<id>.json`, which gives `inheritsFrom` (the MC version) and the loader in `libraries[]`/`mainClass`.
- Never read `launcher_accounts*.json` or the auth fields. They contain tokens.

---

## 5. Server instances: detection signals

A folder is a server only if it has **strong** signals; weak signals only add confidence.

| Signal | Strength | Notes |
|---|---|---|
| `server.properties` | strong | created on first start |
| `eula.txt` | strong | created on first start |
| `user_jvm_args.txt` + `run.bat`/`run.sh` | strong | Forge ≥ 1.17 (37.x) and NeoForge installer output |
| `libraries/net/minecraftforge/forge/<mc>-<ver>/{win,unix}_args.txt` | strong (Forge) | gives MC version and Forge version |
| `libraries/net/neoforged/neoforge/<ver>/{win,unix}_args.txt` | strong (NeoForge) | 1.20.1 NeoForge uses `libraries/net/neoforged/forge/1.20.1-47.1.x/` |
| `fabric-server-launch.jar`, `fabric-server-launcher.properties`, `fabric-server-mc.*-loader.*-launcher.*.jar`, `.fabric/server/` | strong (Fabric) | |
| `quilt-server-launch.jar` / `quilt-server-launcher.properties` | strong (Quilt) | verify the exact names |
| `forge-<mc>-<ver>(-universal).jar` + `minecraft_server.<mc>.jar` | strong (old Forge ≤ 1.16) | |
| `server.jar`, `banned-players.json`, `ops.json`, `whitelist.json`, `usercache.json`, `world/level.dat` | weak | |
| `plugins/`, `bukkit.yml`, `spigot.yml`, `config/paper-global.yml` | Paper/Spigot (or a hybrid if `mods/` is also present) | |

- Client signals that contradict "server": `options.txt`, `servers.dat`, `instance.cfg`, `minecraftinstance.json`.
- `logs/latest.log` lines are a confirmation on servers: `Starting minecraft server version 1.20.1` and `[ServerMain/INFO]` on newer versions.
- Crash reports from servers contain `-- System Details --` with `Is Modded:` and `Type: Dedicated Server`.

---

## 6. Gotchas

- **Symlinks / junctions**:
  - Users commonly symlink `mods/` or whole instances, and Prism has a "symlink" copy option.
  - Modrinth's scanner records `is_symlink` and `has_linked_parent`.
  - Follow at most one level. Detect cycles by canonical path, and use `dunce::canonicalize` on Windows to avoid `\\?\` prefixes in the UI.
  - On Windows a symlink needs Developer Mode, but junctions do not. Treat both as links.
- **Hardlinks**: Modrinth's content store may hardlink or reflink jars. Read-only access is safe; never edit in place.
- **Non-ASCII usernames** (Windows `C:\Users\Jürgen`, Cyrillic, CJK):
  - Use `std::path`/`OsString` end to end. The `dirs` crate uses `SHGetKnownFolderPath`, which is Unicode-safe.
  - Never round-trip paths through `String::from_utf8_lossy` for I/O.
  - Launcher log and crash files may be in the ANSI code page. Modrinth uses `read_any_encoding_to_string` (`encoding_rs`) for `instance.cfg` and JSON; do the same.
  - Java itself breaks on some non-ASCII and `!` paths. Prism warns on `!` (`checkProblemticPathJava`), which makes a good diagnostic.
- **OneDrive‑redirected Documents (Windows)**:
  - `FOLDERID_Documents` may resolve to `C:\Users\<u>\OneDrive\Documents` (or a localized name such as `OneDrive - Contoso\Dokumente`). Always ask the Known Folder API instead of building `%USERPROFILE%\Documents`.
  - Files On-Demand placeholders (`FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS` / `OFFLINE`) trigger downloads when read. Skip hashing them, or warn about them.
  - OneDrive sync also locks files and is a known cause of corrupted instances. Flag instance roots that are under OneDrive.
- **Case sensitivity**:
  - Linux is case-sensitive: `Instances` and `instances`, `MultiMC` and `multimc` can both exist, so probe both.
  - macOS (APFS default) and Windows are case-insensitive but case-preserving. De-duplicate discovered roots by canonical path, not by string.
  - Compare `.jar`, `.disabled`, `.JAR` case-insensitively (Modrinth uses `eq_ignore_ascii_case`).
- **SQLite (Modrinth)**:
  - The database uses WAL mode (`db.rs`), so open it read-only (`SQLITE_OPEN_READ_ONLY`) without `immutable=1`; that flag would ignore the `-wal` file and miss recent rows.
  - If the app holds locks, copy `app.db`, `app.db-wal` and `app.db-shm` to a temp dir and open the copy.
  - `JSONB` columns need SQLite ≥ 3.45 for `json()`. Bundle a current SQLite (rusqlite `bundled`).
- **Flatpak/Snap sandboxes**: the same launcher can exist both natively and as a Flatpak, so report both. Paths under `~/.var/app/*` are readable from a native Tauri app.
- **Prism INI quirks**: values may be quoted, and backslashes may be doubled (QSettings escaping).

---

## Recommendations for the discovery module

1. Model this as a `LauncherProbe` trait: `candidate_roots() -> Vec<PathBuf>`, `probe(root) -> Option<LauncherRoot>`, `list_instances(root) -> Vec<Instance>`. Run all probes, then de-duplicate by canonical game-dir path.
2. **Modrinth**:
   - Root candidates: `$THESEUS_CONFIG_DIR`, `data_dir/ModrinthApp`, the Flatpak path, and legacy `config_dir/com.modrinth.theseus`.
   - Open `app.db` read-only and read `settings.custom_dir`. The instances root is `custom_dir ?? settings_dir` + `/profiles`.
   - Detect the schema (`instances` vs `profiles`) and use the matching query from §1.
   - Fallback when the DB is unreadable: list `profiles/*/`, mark the loader "unknown", and infer it from jars (`fabric.mod.json`, `META-INF/mods.toml`, `META-INF/neoforge.mods.toml`, `quilt.mod.json`).
   - Legacy only: read `profiles/<name>/profile.json`.
3. **Prism/MultiMC**:
   - Root candidates: `$PRISMLAUNCHER_DATA_DIR`, `data_dir/PrismLauncher`, the Flatpak and Snap paths, Scoop, and `data_dir/{multimc,MultiMC}`.
   - On Windows also try `~/MultiMC`, `~/Desktop/MultiMC`, `~/Downloads/MultiMC`, `C:\MultiMC` and `%ProgramFiles%\MultiMC`. On macOS try `/Applications/MultiMC.app/Data` and `~/Applications/MultiMC.app/Data`.
   - Let the user add a portable root manually.
   - Parse `InstanceDir`, resolving it relative to the root. Each child with `instance.cfg` is an instance. Pick the game dir with the `minecraft` / `.minecraft` rule. Read MC and loader versions from `mmc-pack.json`, skipping disabled components.
4. **CurseForge**:
   - Probe `~/curseforge/minecraft` and `<KnownFolder Documents>/curseforge/minecraft` on every OS, accepting `Instances` or `instances`.
   - Expose a "custom CurseForge folder" setting because the custom location cannot be auto-discovered reliably.
   - Parse `minecraftinstance.json` leniently (all fields optional, camelCase with case-insensitive aliases). Use `baseModLoader.name` first, then `type` + `forgeVersion` as a fallback.
5. **Vanilla**: parse `launcher_profiles.json` and emit one instance per distinct resolved `gameDir`, plus the root itself if any profile lacks `gameDir`.
6. **Generic fallback scan** (opt-in, depth ≤ 3, under user-chosen folders): a directory qualifies as a game dir if it has `mods/` plus one of `logs/`, `crash-reports/` or `config/`. Classify it with the §5 server signals.
7. **Running-process hint**: also inspect running `java`/`javaw` command lines for `--gameDir` and `-Dfml.*`. This finds instances from any launcher, including custom locations. Treat it as optional and gate it behind permission.
8. Always treat `*.jar.disabled` (case-insensitive) as present-but-disabled for all four launchers. Ignore `.modrinth-*.tmp`, `*.tmp` and `.index/`.
9. Never read account or auth files: `launcher_accounts*.json`, Modrinth `minecraft_users`, `accounts.json`.
10. Keep every probe read-only, and never take locks on launcher files.

## Uncertain / verify later

- **CurseForge custom-folder persistence**: where the app stores the "Minecraft Modding Folder" setting. A blog mentions an unlocated `settings.json` under AppData. Verify on a real install on Windows, macOS and Linux.
- **CurseForge default roots**: the macOS default (`~/Documents/curseforge/minecraft`?) and the Linux default for both the AppImage and the `.deb`. Also the exact `baseModLoader.name` format for Quilt.
- **CurseForge `.jar.disabled`**: whether the app really disables mods that way, and whether it updates `installedAddons` when it does.
- **Modrinth Flatpak**: the data path (`~/.var/app/com.modrinth.ModrinthApp/data/ModrinthApp`) is inferred and was not observed.
- **Modrinth release history**: the exact first release that introduced `app.db` and the `ModrinthApp` folder (believed 0.8.x, mid‑2024; init migration dated 2024‑07‑11).
- **Modrinth storage**: whether future releases switch the content store to hardlinks/reflinks by default. Also whether `instances.path` can ever be absolute; the code joins it to `profiles/`, and only relative names have been seen.
- **Prism `AdditionalInstanceDirs`**: only on `develop`. Re-check the next Prism release (12.x?).
- **Prism on macOS**: whether a sandboxed build ships, which would mean a `~/Library/Containers/org.prismlauncher.PrismLauncher/...` path.
- **MultiMC**: the Linux data dir for the official tarball's launcher script, and whether it passes `-d`.
- **Mojang Flatpak**: the game dir of `com.mojang.Minecraft` on Flathub.
- **Fabric/Quilt servers**: the exact Quilt server launcher filenames. Also the Fabric server `.fabric/` layout across versions.
- **CurseForge fingerprint**: confirm the MurmurHash2 details (seed 1, stripping bytes 9, 10, 13 and 32) against the CF docs before relying on them.
