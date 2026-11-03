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
| `<name>.ts` | One file per check. Its header comment is the rule's specification. |
| `__tests__/fixtures.ts` | Realistic `JarRecord` builders (Forge, NeoForge, Fabric, Quilt, multi-loader, nested JarJar/JiJ, disabled, corrupt) with metadata excerpts in the real file formats. |
| `../pack/` | `resolvePack`, `buildJarIndex`, loader compatibility (`loaderAccepts`), FML compatibility table (`fmlCompat.ts`), pack description. |

## Report what the loader actually does

Severity mirrors real loader behaviour, read from loader source
(`docs/research/loader-enforcement.md` is the spec). A finding the game would shrug off must not be
an error.

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
- **Legacy FML** (Forge on MC < 1.13): only `mcmod.info` is read; a jar with only a 1.13+
  `mods.toml` is E-WRONG-LOADER ("made for Minecraft 1.13+"). `mcversion` is never enforced
  (FML doesn't read it); mcmod.info dependencies are checked only as far as the scanner emits them
  (it does so only under `useDependencyInformation`). Duplicate ids are errors.
- **Sinytra Connector** (`connector.ts`): with mod id `connector` / `connectormod` present on
  Forge/NeoForge, Fabric-only jars are loaded (no E-WRONG-LOADER). Skipped silently: upstream
  Fabric API, `mixinextras` on 1.21.x, ids (`-`→`_`) already loaded natively. Dependency ids
  match with `-`→`_`; cloth_config ↔ cloth-config2 and playeranimator ↔ player-animator are
  widened; `fabricloader` deps ignored; `minecraft` strict (Fabric semantics); other
  depends/breaks stay errors.
- **FML side filter**: dependencies with `side = "CLIENT"` are skipped on a server pack and
  `SERVER` on a client pack — including the `minecraft` and loader dependencies behind
  `mcRange` / `loaderRange`.
- **FML optional dependencies** are enforced when the mod is present (E-DEP-RANGE error);
  `discouraged` is a warning.
- **Duplicate ids**: FML keeps the newest file per *first* mod id (warning); a duplicate that is a
  secondary mod in some file is an error; Fabric keeps one (warning); Quilt refuses (error).

### Known gaps

- `config/fml.toml` `dependencyOverrides` are not read: a dependency the user removed there is
  still reported.
- Legacy FML `@Mod` annotation `dependencies` / `acceptedMinecraftVersions` are not read yet
  (they need a class-file reader), so legacy MC and dependency checks report nothing beyond the
  mcmod.info dependencies the scanner emits.
- Sinytra Connector: `hiddenMods` in `config/connector.json` and the runtime mixin safeguard are
  not modelled.
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
