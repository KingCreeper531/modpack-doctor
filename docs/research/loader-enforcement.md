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
- **Known gap:** `config/fml.toml` `dependencyOverrides` is not read yet.

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
  - `hiddenMods` in `config/connector.json`.
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
