# When loaders actually refuse a mod (M3 research)

This research was triggered by the M3 end-to-end run. On a real NeoForge 21.1.235 / MC 1.21.1 pack
that loads fine, the checker reported E-MC-RANGE for mods declaring `[1.21,1.21.1)` and E-DUP-ID
for two `createdynlight` jars. The answers below come from loader source code, read at pinned
commits. Nothing was run.

## FML (Forge and NeoForge): dependency check
- **Where it happens:** `ModSorter.verifyDependencyVersions()`
  (FancyModLoader 4.0.45 for NeoForge 1.21.1, commit 44982c69). Any failure is a hard stop: only
  the system mods load, and the loading-error screen shows.
- **Which dependencies are checked:**
  - Filtered by side first (`mv.getSide().isCorrectSide()`). A `CLIENT` dependency is skipped on a
    dedicated server.
  - Required dependencies fail when missing or out of range.
  - **Optional** dependencies fail when the mod is present and out of range.
- **How ranges are compared:** plain Maven `VersionRange.containsVersion`. Installed version
  `0.0NONE` passes, and so does anything removed through `config/fml.toml` `dependencyOverrides`.
- **`VersionSupportMatrix` (the compatibility table):** if the plain check fails, the range also
  passes when it contains a listed fallback version.

  | Loader / MC | `minecraft` also accepts | loader mod also accepts |
  |---|---|---|
  | NeoForge, MC **1.21.1** (FML #190, 2024-08-08) | `1.21` | `neoforge` `21.0.166` |
  | NeoForge, MC **1.21.8** (FML 1.21.8 branch / 10.x / main) | `1.21.7` | `neoforge` `21.7.26-beta` |
  | NeoForge 20.x, 21.0, 21.2–21.5 | (nothing; strict) | (nothing; strict) |
  | Forge 47.x, MC **1.20.1** | (nothing; strict) | `forge` `47.1.79` |

  `loaderVersion` (the language loader) goes through the same table, but there are no language
  loader entries, so in practice it is strict.
- **`incompatible`** is an error; **`discouraged`** is a warning.

## Duplicate mod ids
- **FML (Forge 47.x, NeoForge 20.x/21.x):** `UniqueModListBuilder` groups files by their *first*
  mod id. Within a group the newest version is kept and the rest are dropped silently (DEBUG log).
  It is a hard error (`duplicate_mod`) only when the same id ends up in two different kept files,
  for example as a secondary mod inside a multi-mod jar.
- **Fabric:** the solver keeps exactly one mod per id, newest first, as a best effort. Read from
  source, not confirmed at runtime.
- **Quilt:** a hard error ("Duplicate mod: … Remove all but one").

## Fabric and Quilt `depends: minecraft`
Both are strict. The builtin `minecraft` mod is preselected, so a top-level mod whose predicate
doesn't match fails hard, unless `fabric_loader_dependencies.json` overrides it, or a schema-0/1
mod is softened by an environment-disabled dependency.

## Rules for the static checker
- **MC range:**
  - Report an error only when the range excludes the pack's MC version **and** every
    compatibility-table fallback for that loader and MC version.
  - When only a fallback admits it, report info ("loads through FML's compatibility override").
- **Loader range:** same rule with the loader fallbacks (`neoforge` 21.0.166 on 1.21.1, 21.7.26-beta
  on 1.21.8; `forge` 47.1.79 on 1.20.1).
- **Duplicate ids:**
  - FML, same first mod id: **warning** (older copy ignored, newest kept).
  - FML, same id across different kept files: **error**.
  - Fabric: **warning**.
  - Quilt: **error**.
- **Known gap (closed):** `config/fml.toml` `dependencyOverrides` are read now; see "Instance config files" below.

Sources are linked in the report preserved in the M3 commit message history, and in the research
agent's notes (FML 44982c69, Forge 1.20.1 d13dd327, fabric-loader cb9523bc, quilt-loader 35a644ed).

## Follow-up (M3 real-pack smoke scan): older FML branches, legacy FML, Sinytra Connector

### `VersionSupportMatrix` on every branch (Forge source + changelogs)
| Branch | Active on MC | Also accepts |
|---|---|---|
| Forge 1.16.x (35.x/36.x, all 36 builds) | `[1.16.4,1.16.5]` | minecraft `1.16.3`, `1.16.4`; forge `34.1.42`, `35.1.37`; javafml `34`, `35` |
| Forge 1.17.x, 1.18.x | — | nothing (block commented out) |
| Forge 1.19.2 | `[1.19.2]` | minecraft `1.19.1`; forge `42.0.9`; javafml `42` |
| Forge 1.19.3–1.20.4 (except 1.20.1) | — | nothing (1.19.2-only block) |
| Forge 1.20.1 from **47.2.16** | `1.20.1` | forge `47.1.79` (minecraft strict) |
| NeoForge 47.1, 20.2–20.6, 21.0, 21.3–21.5 | — | nothing |
| NeoForge 21.1 | `1.21.1` | minecraft `1.21`; neoforge `21.0.166` |
| NeoForge 1.21.8 / main | `1.21.8` | minecraft `1.21.7`; neoforge `21.7.26-beta` |

### Legacy FML (Forge 1.12.2, 1.7.10)
- **`META-INF/mods.toml` is never read.** A 1.13+ jar is detected through `@Mod(value=)` and rejected
  as wrong-MC.
- **mcmod.info `mcversion`** is not a field FML reads, so it is never enforced.
- **mcmod.info `requiredMods` / `dependencies` / `dependants`** are enforced **only** when
  `"useDependencyInformation": true` (default false).
- **What FML actually enforces** is the `@Mod(dependencies="required-after:id@[range];…",
  acceptedMinecraftVersions=…)` annotation strings, read with ASM. If empty, the MC default is exactly
  `[<mc>]`. On 1.12, `[1.12]` / `[1.12.1]` mean `[1.12,1.12.2]`. Failures read "Mod X (id) requires Y"
  and "The mod X does not wish to run in Minecraft version …".
- **Duplicate ids** are a hard error (`DuplicateModsFoundException`).
- **Checker gap:** parsing `@Mod` annotations needs a class-file reader (constant pool +
  `RuntimeVisibleAnnotations`). Until that exists, legacy dependency and MC checks report nothing.

### Sinytra Connector (Fabric mods on Forge 1.20.1 / NeoForge 1.21.x)
- **How it's identified:** mod id `connector` (NeoForge 1.21.x) or `connectormod` (Forge 1.20.1).
- **Which jars count as Fabric mods:** Fabric-only jars, meaning `fabric.mod.json` and no real
  (neo)forge `mods.toml`. Ids are normalised `-` → `_`.
- **Skipped silently:**
  - the upstream Fabric API jar (`fabric_api`) and, on 1.21.x, `mixinextras`;
  - ids already loaded as native mods;
  - ~~`hiddenMods` in `config/connector.json`~~ (wrong: it only hides native mods from Fabric mods at runtime; see "Instance config files" below).
- **Fabric `depends`:** resolved by Fabric's own solver against Fabric jars plus every FML mod. FFAPI
  `x_y` ids satisfy `x-y`.
  - `fabricloader` dependencies are dropped.
  - `minecraft` is matched strictly with Fabric semantics; FML's table does not apply.
  - Aliased ids (cloth_config ↔ cloth-config2, playeranimator ↔ player-animator) are widened to `*`.
  - `breaks` is enforced unless it targets an aliased id.
- **Mixin conflicts:** a runtime safeguard can still reject a mod; static checks can't predict it.

## Third round (M3 review): jars for another loader, metadata-less jars, `FMLModType`

| Situation | Forge 1.17–1.20.1 · NeoForge 47.1 / 20.2–20.4 / 20.6 before FML 3.0.19 | NeoForge 20.6 (FML ≥ 3.0.19) / 21.x | Fabric | Quilt | Forge 1.12 |
|---|---|---|---|---|---|
| (a) Fabric-only jar | ignored silently (DEBUG) | skipped + WARN screen `brokenfile.fabric` | — | — | put on classpath (INFO) |
| (b) neoforge.mods.toml-only jar on Forge | ignored silently | — | — | — | — |
| (c) mods.toml-only jar on NeoForge ≥ 20.5 | ignored silently | skipped + WARN `brokenfile.minecraft_forge` | — | — | — |
| (d) a read toml *requires* the other loader | **ERROR** (missing dependency) | **ERROR** | — | — | — |
| (e) Forge/NeoForge jar | — | — | ignored, one WARN log line | blocking WARN prompt (Exit/Continue) | — |
| No metadata, no `FMLModType` | ignored silently | skipped + WARN `brokenfile.unknown` | ignored | WARN | classpath |
| `FMLModType` present | loaded: MOD/GAMELIBRARY → GAME layer, LIBRARY/LANGPROVIDER → PLUGIN layer | same; `LANGPROVIDER` → WARN `unknownfmlmodtype`, skipped | — | — | — |

- **Jar-in-jar:** nested jars without metadata become `LIBRARY` on NeoForge 21.x. On Forge 1.20.1
  they default to `GAMELIBRARY`, or `LIBRARY` under a library parent. So nested libraries **are**
  loaded into module layers.
- **Split packages:** they are plain JPMS. Two jars in the same layer (or one visible from the other)
  sharing a package give a `ResolutionException`.
- **Corrupt zip:** ERROR on NeoForge 20.6+/21.x (`brokenfile.invalidzip`).
- **Uncertain:** the exact NeoForge 20.6 build that switched to FML 3.0.19.

## Instance config files (NeoForge `config/fml.toml`, Connector `config/connector.json`)

Read from source at the branch heads on 2026-11-07, and checked against the published FML jars.
Nothing was run.

### NeoForge `config/fml.toml` `dependencyOverrides`
- **Where:** `FMLConfig.load()` reads `<gameDir>/config/fml.toml` (`FMLPaths.FMLCONFIG`), and
  `ModSorter.verifyDependencyVersions()` applies the overrides
  ([FMLConfig.java](https://github.com/neoforged/FancyModLoader/blob/1.21.1/loader/src/main/java/net/neoforged/fml/loading/FMLConfig.java),
  [ModSorter.java](https://github.com/neoforged/FancyModLoader/blob/1.21.1/loader/src/main/java/net/neoforged/fml/loading/ModSorter.java);
  same code on `1.21.3`, `1.21.4`, `1.21.8` and `main`). Added by FML PR
  [#214](https://github.com/neoforged/FancyModLoader/pull/214) (2024-11-25), backported in #221.
- **Syntax** (the file's own comment): `dependencyOverrides.targetMod = ["-dep1", "+dep2"]`. Any
  TOML form works (dotted keys, `[dependencyOverrides]`, inline table, the default
  `dependencyOverrides = {}`). A value may be one string or a list of strings.
  - Keys are the *target* mod ids, matched exactly (case-sensitive).
  - `-dep`: every dependency entry of the target on `dep` is dropped before checking — required,
    optional, `incompatible` and `discouraged` alike. Nothing about `dep` is enforced for that
    mod any more. `minecraft` and `neoforge` are ordinary entries there, so `-minecraft` and
    `-neoforge` remove the MC and loader range checks too. The language loader
    (`loaderVersion`) is not a dependency and stays enforced.
  - `+dep`: only adds a load-order edge (target after `dep`); it changes no check.
  - An entry without `+`/`-`: logged as an error and ignored. `dependencyOverrides` that isn't a
    table: logged, and no overrides apply. A non-string entry (`ClassCastException`) or an empty
    string (`charAt(0)`) throws inside `FMLConfig.load`.
  - An override whose target or dependency isn't loaded shows a loading-screen *warning*
    (`fml.modloadingissue.depoverride.unknown_target` / `unknown_dependency`).
  - Only FML's own dependency check reads it. Fabric mods under Sinytra Connector are resolved by
    Fabric's solver, which doesn't.
- **Which versions have it.** Checked by downloading the
  `net.neoforged.fancymodloader:loader` jars and looking for `dependencyOverrides` in
  `FMLConfig.class`: absent in 4.0.33 and 5.0.5, present in 4.0.34, 5.0.6 and 6.0.4.

  | NeoForge | FML | Overrides |
  |---|---|---|
  | 1.21.1: **21.1.81**+ ([changelog](https://maven.neoforged.net/releases/net/neoforged/neoforge/21.1.100/neoforge-21.1.100-changelog.txt): "Update FML to v4.0.34 - add dependency overrides (#1705)") | 4.0.34 | yes |
  | 1.21.3: **21.3.41-beta**+ (NeoForge commit `3ddaffa705` bumped FML 5.0.1 → 5.0.6) | 5.0.6 | yes |
  | 1.21.4 and later, 26.x (21.4.0-beta used FML 6.0.4) | 6.0.4+ | yes |
  | 47.1 (1.20.1), 20.2–20.6, 21.0, 21.2, 21.1 < 81, 21.3 < 41 | — | no |
  | Forge (any branch; `FMLConfig` on `1.20.1`, `1.21.x`, `26.3` has no such key) | — | no |
- **Other `fml.toml` keys** (`disableConfigWatcher`, `earlyWindow*`, `maxThreads`, `versionCheck`,
  `defaultConfigPath`, `disableOptimizedDFU`, `debugOpenGl`, `earlyLoadingScreenTheme`) don't
  change dependency, range or loading decisions, so the checks don't model them.

### Sinytra Connector `config/connector.json`
- **Where:** `ConnectorConfig` (1.21.x: `org/sinytra/connector/util/ConnectorConfig.java`; 1.20.1:
  `org/sinytra/connector/locator/ConnectorConfig.java`; same on `26.2.x`), read from
  `FMLPaths.CONFIGDIR/connector.json`. Fields: `version` (must be 1), `hiddenMods` (string
  list), `globalModAliases` (`{ id: "alias" | ["alias", …] }`), `enableMixinSafeguard` (1.21.x+).
  When the file is missing, Connector writes its defaults (exactly what the real packs here have).
- **`hiddenMods`** ([ConnectorEarlyLoader.init](https://github.com/Sinytra/Connector/blob/1.21.x/src/main/java/org/sinytra/connector/ConnectorEarlyLoader.java)):
  FML mods whose id is listed are left out of `FabricLoaderImpl.addFmlMods`. This only hides
  *native* mods from Fabric mods' runtime view (`FabricLoader.isModLoaded`, `getModContainer`).
  Connector's dependency resolution (`DependencyResolver.resolveDependencies`) still gets every
  loaded FML mod file, and the duplicate skip (`handleDuplicateMods`) uses all FML mod ids. So
  `hiddenMods` changes no static finding. **This corrects the earlier note** ("Skipped silently: …
  `hiddenMods`"): it never skips a Fabric jar.
- **`globalModAliases`** ([DependencyResolver](https://github.com/Sinytra/Connector/blob/1.21.x/src/main/java/org/sinytra/connector/locator/DependencyResolver.java)):
  `FabricLoaderImpl.aliasMods(...)` is called before resolution, and
  `removeAliasedModDependencyConstraints` widens every Fabric dependency on a key or value to `*`
  and drops `breaks` on them. Default
  (`ConnectorUtil.DEFAULT_GLOBAL_MOD_ALIASES`): cloth_config → cloth-config2, playeranimator →
  player-animator.
  - **No file, or the file can't be parsed:** the defaults apply.
  - **Readable file without the key:** no aliases (`optionalFieldOf("globalModAliases",
    ImmutableMultimap.of())` defaults to an empty map, not to the defaults).
  - **Invalid field:** on 1.21.x (DFU 7+: strict `optionalFieldOf`, `getOrThrow()`) the whole
    decode fails, so the defaults apply. On 1.20.1 (DFU 6: lenient `optionalFieldOf`) the invalid
    field reads as absent.
- **Other files:** `config/fabric_loader_dependencies.json` is passed only to Connector's built-in
  `java` / `fabricloader` / `mixinextras` candidates, not to the Fabric mods' own metadata (not
  verified further). `enableMixinSafeguard` is runtime only.

### Rules for the static checker
- **Reading the files:** Rust reads both files next to every instance scan
  (`src-tauri/src/instance_config`), with a 256 KiB cap and through PathGuard. It reports raw facts
  as `ScanResult.loaderConfig`. A broken file is a `ScanIssue`, never a failed scan.
- **FML overrides** (`src/core/checks/fmlOverrides.ts`): a `-dep` override for an FML entry's mod
  id turns E-MISSING-DEP, E-DEP-RANGE, E-MC-RANGE (`-minecraft`), E-LOADER-RANGE (`-neoforge`)
  and E-INCOMPAT findings about that constraint into **info**. The finding says
  "overridden in config/fml.toml" and keeps no file-changing fixes.
  - Gated: NeoForge ≥ 21.1.81 (1.21.1), ≥ 21.3.41-beta (1.21.3), every 1.21.4+/26.x. With an
    unknown version on 1.21.1/1.21.3, the override is assumed to apply, and the wording says so.
  - Elsewhere, Forge and older NeoForge keep the finding plus a note that the override has no
    effect.
  - Fabric mods via Connector are never affected.
- **Connector** (`src/core/checks/connector.ts`): alias groups come from `globalModAliases`, using
  the rules above. `hiddenMods` is exposed but changes nothing.
- **Real packs on this machine (2026-11-07):** ATM10 and the two Modrinth NeoForge 1.21.1 packs
  have an `fml.toml` with `dependencyOverrides = {}` or no key. antarchy craft and Create
  Aeronautic have Connector's default `connector.json`. No real pack uses an override, so findings
  are unchanged.
- **Not modelled:** a `.mrpack`'s own `overrides/config/fml.toml`. The override `-forge` on the
  other-loader rule in E-WRONG-LOADER (case d) is not modelled either; that rule looks at entries
  the loader never loads.
