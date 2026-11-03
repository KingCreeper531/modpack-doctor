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
