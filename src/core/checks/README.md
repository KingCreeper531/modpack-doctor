# Static checks — how to add a check

Static checks turn a `ScanResult` (facts Rust extracted from every jar) plus the resolved pack
identity into `Finding`s. They are pure TypeScript: no I/O, no DOM, no network, no `any`
(`src/core/__tests__/purity.test.ts` and `tsc -p src/core` enforce it), and they must work offline —
Modrinth data (`CheckInput.modrinth`) is optional enrichment.

The UI runs `resolvePack` → `buildJarIndex` → `runChecks` synchronously after every scan
(docs/CONTRACTS.md, "Rules-core entry points").

## Layout

| File | Role |
|---|---|
| `index.ts` | `CHECKS` registry (run order) and `runChecks` (dedupe by id, sort). Frozen signatures. |
| `context.ts` | `contextFor(input)`: the per-input view every check shares — jar index, active/loaded jars, loader- and side-filtered metadata entries, nested-copy de-duplication, providers, pack note. Cached per input. |
| `evidence.ts` | Helpers: `makeFinding`, `jarRef`/`entryRef`, `metadataEvidence` + line finders (`dependencyLines`, `modIdLines`, `environmentLines`), `disable`/`manual` fixes, wording helpers. |
| `builtins.ts` | Dependency ids the game/loader provide (never "missing"). |
| `duplicates.ts` | Duplicate-id groups, loader mode and ranking; which copies the loader drops. |
| `connector.ts` | Sinytra Connector: which Fabric jars it loads or skips, id normalisation, aliases (incl. `config/connector.json`). |
| `fmlOverrides.ts` | NeoForge `config/fml.toml` `dependencyOverrides`: version gate and `relaxByOverride`. |
| `<name>.ts` | One file per check. Its header comment is the rule's specification. |
| `__tests__/fixtures.ts` | Realistic `JarRecord` builders (Forge, NeoForge, Fabric, Quilt, multi-loader, nested JarJar/JiJ, disabled, corrupt) with metadata excerpts in the real file formats. |
| `../pack/` | `resolvePack`, `buildJarIndex`, loader compatibility (`loaderAccepts`), FML compatibility table (`fmlCompat.ts`), pack description. |

## Report what the loader actually does

Severity mirrors real loader behaviour, read from loader source
(`docs/research/loader-enforcement.md` is the spec). A finding the game would shrug off must not be
an error.

- **Jars for another loader** (E-WRONG-LOADER, `wrongLoader.ts`; FML era from `fmlEra`):
  - metadata the loader doesn't read: **info** on Forge 1.13+ and NeoForge before 1.20.6 (ignored
    silently); **warning** on NeoForge 1.20.6+/21.x ("Warnings while loading mods" screen,
    `brokenfile.fabric` / `minecraft_forge` / `quilt` / `unknown`). The switch came with FML
    3.0.19 somewhere inside 1.20.6 — every 1.20.6 build (and NeoForge with an unknown MC) is
    treated as warning;
  - a file the loader reads *requires* the other FML loader (`neoforge` on Forge, `forge` on
    NeoForge ≥ 1.20.2, never on 1.20.1) → **error** naming the missing dependency. A read toml
    whose other-loader dependency is only *optional* is simply loaded (`loaderAccepts`) — e.g.
    Incendium/Nullscape declare `forge` and `neoforge` both optional and load on Forge 1.20.4;
  - FML only opens nested jars declared in `META-INF/jarjar/metadata.json` (a Fabric `jars`
    entry in a multi-loader jar is never loaded on Forge/NeoForge);
  - Forge/NeoForge jars on Fabric → **warning** (ignored); on Quilt → **warning** (blocking
    "unsupported mods" prompt);
  - legacy FML (Forge 1.12): non-mod jars go on the classpath → nothing (except a `mods.toml`
    whose minecraft range excludes the pack: "made for Minecraft 1.13+").
- **Metadata-less jars** (no mods metadata the loader reads): modern FML loads a top-level one
  only with MANIFEST `FMLModType` MOD / GAMELIBRARY / LIBRARY (LANGPROVIDER on Forge only);
  otherwise it is not loaded (`metadataLessJarLoaded`), so it feeds neither E-SPLIT-PKG nor
  W-JAVA-CLASS, and on NeoForge 1.20.6+ one E-WRONG-LOADER warning per pack lists them ("not a
  mod file"). Container jars with nested jars (kotlinforforge, connector) and records without the
  `fmlModType` field (older scans) get the benefit of the doubt. Nested metadata-less jars *are*
  loaded (libraries), so the selected copy of a bundled library (copies linked by JarJar artifact
  name or mod id) takes part in split-package checks (`ctx.isEffectiveJar`), but only as
  **I-SPLIT-PKG**: real, loading packs have such overlaps.
- **Which metadata file counts** (`metadataFilesRead` / `entryRelevant` in `../pack/loaders.ts`,
  the single relevance rule): NeoForge ≥ 1.20.5 (and 26.x) reads only
  `META-INF/neoforge.mods.toml`; NeoForge 1.20.1–1.20.4 and Forge read `META-INF/mods.toml`
  (+ `mcmod.info` for legacy); Fabric `fabric.mod.json`; Quilt `quilt.mod.json`, else
  `fabric.mod.json`; unknown MC on NeoForge → both FML files. Entries from files the loader
  ignores never reach any check (`ctx.relevant`), and `metadataErrors` in ignored files are not
  W-CORRUPT-JAR. Many real jars ship a stale `mods.toml` next to `neoforge.mods.toml`.
- **FML compatibility table** (`../pack/fmlCompat.ts`, `VersionSupportMatrix`, every branch):
  Forge 1.16.4–1.16.5 (`minecraft` 1.16.3/1.16.4, `forge` 34.1.42/35.1.37), Forge 1.19.2
  (1.19.1, 42.0.9), Forge 1.20.1 from 47.2.16 (`forge` 47.1.79; assumed when the version is
  unknown, and the wording says so), NeoForge 1.21.1 (1.21, 21.0.166), NeoForge 1.21.8 (1.21.7,
  21.7.26-beta). Everything else is strict. Range checks call `evaluateRange`: `fail` → error,
  `fallback` → the same code at **info** naming the override, `pass`/`unknown` → nothing.
  Fabric/Quilt ranges are strict (also under Connector).
- **Legacy FML** (Forge on MC < 1.13): only `mcmod.info` is read; a jar with only a `mods.toml`
  whose `minecraft` range excludes the pack version is E-WRONG-LOADER ("made for Minecraft
  1.13+"). Without such a range it is not reported: real 1.12.2 mods ship leftover `mods.toml`
  templates and FML finds them by their `@Mod` class. `mcversion` is never enforced
  (FML doesn't read it); mcmod.info dependencies are checked only as far as the scanner emits them
  (it does so only under `useDependencyInformation`). Duplicate ids are errors.
- **Sinytra Connector** (`connector.ts`): with mod id `connector` / `connectormod` present on
  Forge/NeoForge, Fabric-only jars are loaded (no E-WRONG-LOADER). Skipped silently: upstream
  Fabric API, `mixinextras` on 1.21.x, ids (`-`→`_`) already loaded natively. Dependency ids
  of those Fabric jars (only — native FML deps stay exact) match with `-`→`_`
  (`ctx.providers(id, ctx.connector.via(jar))`); aliased ids are widened
  (`ctx.connector.aliasGroup`: `config/connector.json` `globalModAliases`, else Connector's
  defaults cloth_config ↔ cloth-config2 and playeranimator ↔ player-animator; a file without the
  key means no aliases); `fabricloader` deps ignored; `minecraft` strict (Fabric semantics); other
  depends/breaks stay errors. `hiddenMods` only hides native mods from Fabric mods at runtime and
  changes no finding.
- **NeoForge `config/fml.toml` `dependencyOverrides`** (`fmlOverrides.ts`, `ctx.fmlOverrides`,
  from `ScanResult.loaderConfig`): `dependencyOverrides.<mod> = ["-dep"]` removes every
  constraint of `<mod>` on `dep` (required, optional, incompatible, discouraged; `minecraft` and
  `neoforge` too). Checks wrap their finding in `relaxByOverride(ctx, entry, depId, finding)`:
  removed → the same finding at **info**, "— overridden in config/fml.toml", a note, no
  file-changing fixes. Only FML entries (never Fabric mods via Connector). NeoForge ≥ 21.1.81
  (1.21.1) / ≥ 21.3.41-beta (1.21.3) / all 1.21.4+ and 26.x. An unknown version on 1.21.1/1.21.3
  is assumed to have them, and the wording says so. On Forge and older NeoForge the finding stays,
  with a note that the override has no effect. `+dep` (ordering) never changes a check.
- **FML side filter**: dependencies with `side = "CLIENT"` are skipped on a server pack and
  `SERVER` on a client pack — including the `minecraft` and loader dependencies behind
  `mcRange` / `loaderRange`.
- **FML optional dependencies** are enforced when the mod is present (E-DEP-RANGE error);
  `discouraged` is a warning. A provider whose version is an unresolved `${…}` placeholder or
  `0.0NONE` passes (FML substitutes `0.0NONE`, which passes every check).
- **Duplicate ids** (`duplicates.ts`, computed once in the context): FML keeps the newest file per
  *first* mod id (warning); a duplicate that is a secondary mod in some file is an error; Fabric
  keeps one (warning); Quilt and legacy FML refuse (error). The copies FML/Fabric drop are not
  loaded: `ctx.isLoaded`, `effective` and `providers` exclude them, so no other check reports
  them (E-DUP-ID still does). Placeholder versions rank lowest, then file mtime.
- **Java class versions**: the top-level jar's own classes decide W-JAVA-CLASS (warning); a
  newer *bundled* module alone is info ("it may be optional").

### `.mrpack` packs (CONTRACTS invariant 15)

An opened `.mrpack` is scanned without extracting or downloading anything. Its override jars
(`overrides/`, `client-overrides/`, `server-overrides/`) are ordinary `JarRecord`s and get every
check above. The files its `modrinth.index.json` declares arrive as `ScanResult.declared` and are
checked from Modrinth data only, identified by sha1 like jars (`planQueries` includes them;
`declaredMatch` in `../modrinth` gives their state):

- `mrpackDeclared.ts`: E-WRONG-LOADER, E-MC-RANGE (mods under `mods/` only), E-MISSING-DEP (by
  Modrinth project id, per side; **warning** for declared files, since a jar Modrinth cannot see
  into may provide it; Quilted Fabric API counts as Fabric API; dependencies of another loader's
  build, and loader-family-only ones such as Fabric API on a Forge pack, are skipped),
  I-NOT-ON-MODRINTH (one aggregate for declared files, separate from the override jars' one).
  Needs a Modrinth context that is not offline; failed lookups are unknown, never "missing". Two
  index entries with one path: the last one counts. The header comment is the full rule.
- `mrpackDownload.ts`: W-MRPACK-DOWNLOAD (warning) for a download URL outside the allowlist
  (`cdn.modrinth.com`, `github.com`, `raw.githubusercontent.com`, `gitlab.com`, https only, no user
  info, no port but 443, exact host). Works offline. The URL parser is hand-written (no `URL`
  global in `src/core`); anything it cannot read counts as outside.

**Culprit of a declared file:** there is no `JarRecord`, so the `JarRef` is
`{ jarId: <index path>, fileName: <basename> }` with no `modId`, e.g.
`{ jarId: 'mods/sodium-fabric-0.5.8.jar', fileName: 'sodium-fabric-0.5.8.jar' }`
(`declaredRef`). Index paths are relative to the instance folder the pack installs into and never
collide with override jar ids (`overrides/…`). Finding ids: `findingId(code, [index path],
'declared…')`. **Declared-file findings carry no fixes and no `missingModIds`**: packs are
read-only, and `enrichFindings` finds no jar for the culprit, so it adds nothing either.

### Known gaps

- A `.mrpack`'s own `overrides/config/fml.toml` / `connector.json` are not read (instances only).
- Legacy FML `@Mod` annotation `dependencies` / `acceptedMinecraftVersions` are not read yet
  (they need a class-file reader), so legacy MC and dependency checks report nothing beyond the
  mcmod.info dependencies the scanner emits.
- Sinytra Connector: the runtime mixin safeguard is not modelled.
- Quilt "any of" dependency arrays are not reported when none is present (CONTRACTS invariant 13).

## Steps

1. **Pick a code.** Codes are frozen in `FINDING_CODES` (`src/core/model.ts`) and documented in
   the finding-code table in `docs/CONTRACTS.md`. A new code is a contract change: propose it to
   the integrator first. The prefix is the default severity (E/W/I); a check may lower it when the
   rule says so (e.g. Fabric `conflicts` → `E-INCOMPAT` as a warning) — document that.
2. **Create `src/core/checks/<name>.ts`** exporting a `Check`:
   ```ts
   export const fooCheck: Check = {
     id: 'foo',                    // kebab-case, unique
     codes: ['W-FOO'],             // every code it can emit
     run(input) {
       const ctx = contextFor(input);
       // …
       return findings;
     },
   };
   ```
   Start the file with a comment stating the rule precisely: what is reported, what is
   deliberately skipped, the severity, and the fixes in order.
3. **Use the shared view, don't re-derive it.** Iterate `ctx.topLevel` (active top-level jars),
   `ctx.loadedTopLevel`, `ctx.loadedJars` or `ctx.effective` (metadata entries the loader really
   loads, nested copies de-duplicated). Use `ctx.relevant(jar)` / `ctx.loaded(jar)` instead of
   `jar.mods` so multi-loader jars, Quilt-runs-Fabric and the NeoForge 1.20.1 ↔ Forge 47.x rule are
   handled the same way everywhere. Use `ctx.providers(id)` for presence and
   `ctx.versionProviders(id)` for "which version would the loader use".
4. **Never evaluate version ranges yourself.** Call `versionApi.satisfies/compare/parseRange`
   from `src/core/version` (subject `'minecraft'` for MC versions), or `evaluateRange` from
   `src/core/pack` for anything checked against the game or loader version (it adds the FML
   fallbacks). Treat `null` / `unknown` as unknown and report nothing. Never compare
   `languageRange` (`loaderVersion`) with the loader version.
5. **Build findings with `makeFinding`.** It derives the stable id from
   `findingId(code, sorted culprit jar ids, discriminator)` (`src/core/crash/id.ts`). Rules:
   - The discriminator distinguishes findings with the same culprits (mod id, `a->b` for a
     dependency). Never put line numbers, versions, file names or anything else that changes on
     rescan into it — ids must survive rescans and disable/enable renames (jar ids already do).
   - `title`: one line, plain English, names the mod/jar.
   - `explanation` (≤ ~600 chars): what is wrong, why it breaks the game, what to do.
   - `culprits`: `JarRef`s of **top-level** jars (what the grid shows and fixes act on), with the
     relevant `modId`. For a bundled mod, use `entryRef(entry)` — the top-level jar tagged with the
     nested mod id.
   - `evidence`: the `metadata` excerpt with 1-based `highlight` lines of the relevant entry (use
     the line finders) and always `ctx.packNote` ("Pack: Forge 47.3.0 on Minecraft 1.20.1 (from
     launcher metadata)") so the reader sees which identity the rule assumed.
   - `fixes`: ordered, first = recommended. `disable`/`enable`/`removeDuplicate` act on top-level
     jar ids; `manual` steps for advice. `replace`/`installDependency` need Modrinth versions (M5).
6. **Register** the check in `CHECKS` (`index.ts`). Order there only affects which of two
   same-id findings wins; output order is always severity → code → first culprit file name → id.
7. **Test it** in `__tests__/<name>.test.ts` (see below), then run `npx vitest run` and
   `npm run typecheck` from the repo root.

## Test expectations

- Build jars with `__tests__/fixtures.ts` (`forge`, `neoforge`, `fabric`, `quilt`, `jar` for
  multi-loader, `nested` for JarJar/JiJ, `disabled`/`status` options) and run with
  `run(jars, pack(loader, mc, loaderVersion, side), modrinth?)`.
- Prefer table-driven `it.each` cases. Cover at least:
  - a positive and a negative case for every code the check emits;
  - both range syntaxes when ranges are involved (Maven `[47,)`, `[1.20,1.20.2)`, soft `47.1.0`;
    Fabric `>=0.15`, `~1.20.1`, arrays, `1.21.x`);
  - loader edge cases: Quilt pack + Fabric mods, NeoForge/Forge on 1.20.1 both ways, a
    multi-loader jar, an unknown pack loader or MC version (must not guess);
  - disabled jars and nested jars (de-duplicated, never reported twice);
  - wording (title), culprits, fixes, and highlighted evidence lines (`highlighted(f)`).
- `runChecks.test.ts` asserts registry coverage of every static code, sort order, well-formed
  findings and id stability; extend its "messy pack" when a new check should fire there.
