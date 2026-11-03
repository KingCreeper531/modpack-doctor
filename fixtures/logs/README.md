# Crash and log fixture corpus

Acceptance corpus for the crash/log analysis in `src/core/crash`. Every case is a realistic crash
report, `latest.log`, `debug.log` or `hs_err_pid*.log`, written to match the formats documented in
[`docs/research/crash-formats.md`](../../docs/research/crash-formats.md) (header lines, section
markers, log prefixes, stack-frame shapes per loader and era), plus a machine-readable
`.expected.json`.

The corpus was written **independently of the analyzer implementation**, as an acceptance test. Do
not edit an expectation to make an implementation pass; if you think an expectation is wrong, say why
in review, citing crash-formats.md or a real report.

Mod names, packages, versions, paths and user names are invented. Loader, JDK, Mixin and Minecraft
strings follow the real formats.

## Layout

```
fixtures/logs/
  index.json                         [{ "file": "forge/x.txt", "expected": "forge/x.expected.json" }, ...]
  <group>/<case>.<txt|log>           the log file exactly as the game would write it
  <group>/<case>.expected.json       expectations for that file
```

Groups: `forge`, `neoforge`, `fabric`, `quilt`, `jvm`. `.txt` = a `crash-reports/` file
(including Forge/NeoForge `-fml.txt` and Quilt `-quilt_loader.txt` shapes); `.log` = `latest.log`,
`debug.log` or `hs_err_pid*.log` (see `kind`). Files are UTF-8; all are below 300 KB.
`fixtures/logs/.gitattributes` sets `-text` so git stores every file byte-exact (the CRLF case
stays CRLF despite the repo-wide `eol=lf`).

## `expected.json` schema

```jsonc
{
  "kind": "crashReport" | "latestLog" | "debugLog" | "hsErr",   // LogKind (src-tauri/src/model/logs.rs)
  "loader": "forge" | "neoforge" | "fabric" | "quilt" | "vanilla" | "unknown",
  "mcVersion": "1.20.1" | null,          // version the file itself reveals; null if it does not say
  "jars": [                              // simulated mods/ folder, for building a JarIndex
    { "fileName": "examplemod-1.2.0.jar",
      "modIds": ["examplemod"],
      "packages": ["com.example.mod"],    // packages of the jar's own classes (exact package names)
      "mixinConfigs": ["examplemod.mixins.json"] }
  ],
  "expect": [                            // findings that MUST be produced
    { "code": "C-MIXIN",                 // a C-* code from FINDING_CODES (src/core/model.ts)
      "culpritFileNames": ["examplemod-1.2.0.jar"],   // optional
      "culpritModIds": ["examplemod"],                // optional
      "lineContains": "exact substring" }             // optional
  ],
  "forbid": ["C-OOM"],                   // codes that must NOT be produced
  "notes": "one or two sentences"
}
```

All keys are required except the three optional fields inside an `expect` entry.

How a harness should evaluate a case:

- Build the digest from the log file with `kind` as the `LogKind`, and a `JarIndex` from `jars`
  (each entry is one top-level jar; `packages` feed `byPackage`/`byPackageAnyDepth`,
  `mixinConfigs` feed `byMixinConfig`, `modIds` feed `byModId`).
- **expect**: for every entry, at least one finding with that `code` must exist such that
  - every name in `culpritFileNames` is among that finding's `culprits[].fileName` (subset, not
    equality: an analyzer may name additional jars);
  - every id in `culpritModIds` is among the culprits' `modId` (or among the `modIds` of the
    culprit jars in `jars`);
  - if `lineContains` is given, one of the finding's `log` evidence lines with
    `role: 'culprit'` contains it. Lines are compared without their line terminator (`\r` is
    stripped for the CRLF case); the substring is matched against the full, uncut line.
- **forbid**: no finding may have any of these codes.
- An empty `expect` with a populated `forbid` is a negative case.
- Codes not mentioned in either list are unconstrained (for example, a `C-ROOT-CAUSE` fallback next
  to a specific finding is allowed unless forbidden).

Conventions used when writing expectations:

- **C-SUSPECTED** is expected wherever the loader itself attributes the failure to a mod: the Forge
  `Suspected Mod(s):` block, and the Forge/NeoForge `-- MOD <id> --` / `-- Mod loading issue for: <id> --`
  sections with their `Mod File:`/`Mod file:` line, when no more specific code describes the failure.
  `Suspected Mods: NONE` must not produce it.
- **C-ROOT-CAUSE** is the fallback; several cases with a specific diagnosis forbid it.
- **C-NOCLASSDEF**: when the missing class's package belongs to an installed jar, that jar is the
  expected culprit (outdated/mismatched library). When no jar contains the package, it is a missing
  dependency and the expected culprit is the mod whose code needs the class (`culpritModIds`).
- **C-RESOLUTION**: both supplier modules (the jars that ship the package) are expected culprits; the
  module the package is exported *to* is innocent and is not listed.
- **C-MISSING-MANDATORY / C-FABRIC-INCOMPAT**: the expected culprits are the mods that declare the
  unmet dependency (the dependency itself is usually not installed).
- **hs_err** cases have `jars: []` and no culprit expectations; `lineContains` points at the
  `# Problematic frame:` line that follows the header (or the insufficient-memory header).
- `index.json` lists every case; every file in the group folders is listed there.

## Cases

### Forge (16)

| File | Kind | Era imitated | Expect | What it represents |
|---|---|---|---|---|
| `forge/fg16-noclassdef-package.txt` | crashReport | FG-ML8 (Forge 36.2.39, MC 1.16.5, Java 8) | `C-NOCLASSDEF` | In-game crash report with `~[modid:version]` frame brackets (no jar names); NoClassDefFoundError (slashes) + Caused by ClassNotFoundException (dots). Package maps to animcore. Mossy Critters was built against an older AnimCore API; the missing class lives in package dev.quillwork.animcore.api, which belongs to the installed animcore jar (version mismatch). |
| `forge/fg17-resolution-reads-package.log` | latestLog | FG-ML9 early (Forge 37.1.1, MC 1.17.1, Java 16) | `C-RESOLUTION` | Short latest.log ending in `ResolutionException: Module X reads package Y from both A and B` (both suppliers are mod jars that bundle org.joml). The "reads package ... from both" phrasing named in SPEC.md. crash-formats.md Uncertain #1 says it is not in JDK 11/17/21 source; it is kept here as the soft anchor the spec asks for. |
| `forge/fg19-suspected-crlf.txt` | crashReport | FG-ML9 (Forge 43.3.5, MC 1.19.2, backported Suspected Mod) | `C-SUSPECTED` | CRLF-encoded in-game crash with single `Suspected Mod:` entry and EventBus `ASMEventHandler_NNN_...` frames. lineContains is matched per line after stripping \r. Robustness: the whole file uses CRLF line endings (as when a crash report is copied off Windows). NPE in an event handler; ASMEventHandler frames from the Forge EventBus. |
| `forge/fg20-clean-benign-cnfe-long.log` | latestLog | FG-ML9 (Forge 47.3.0, MC 1.20.1) latest.log, ~1.8k lines | _none (negative)_ | Long benign log: Mixin `Error loading class: ... (java.lang.ClassNotFoundException: ...)` WARNs, a WARN-level ClassNotFoundException stack trace from a compat loader, RecipeManager parse errors, normal shutdown. Negative case: a successful session that ends with a clean "Stopping!". ClassNotFoundExceptions are logged at WARN for optional integrations (EMI, Jade, Patchouli are not installed), plus recipe parsing errors and "Can't keep up!" noise. |
| `forge/fg20-java-version-mod-class.txt` | crashReport | FG-ML9 (Forge 47.3.0, MC 1.20.1, Java 17) | `C-JAVA-VERSION` | Forge `-fml.txt` with `has class loading errors` and UnsupportedClassVersionError naming class file versions 65.0 / 61.0. AuroraCraft was compiled for Java 21 (class file 65) but the game runs on Java 17 (61). Fix is a different AuroraCraft build or Java 21, not a missing class. |
| `forge/fg20-missing-mandatory.log` | latestLog | FG-ML9 (Forge 47.2.0, MC 1.20.1) latest.log | `C-MISSING-MANDATORY` | `[net.minecraftforge.fml.loading.ModSorter/LOADING]` ERROR "Missing or unsupported mandatory dependencies:" with tab-indented `Mod ID:` lines, then "Skipping lifecycle event" FATAL lines. Client launch that ends on the loading-error screen (no crash report). cloth_config is not installed; Saplings Plus wants MC 1.20.2+. |
| `forge/fg20-mixin-apply-failed.log` | latestLog | FG-ML9 (Forge 47.2.0, MC 1.20.1) latest.log | `C-MIXIN` | Full client latest.log: `[mixin/]` ERROR `Mixin apply failed <cfg>:<Mixin> -> <target>: ...InvalidInjectionException`, then ReportedException with MixinTransformerError/MixinApplyError causes and the `#@!@# Game crashed!` STDOUT line. Upstream Mixin wording (no "from mod"): the config tidyterrain.mixins.json must be mapped to its jar. A harmless "Reference map ... could not be read" WARN for hearthhud.mixins.json precedes it and must not be blamed. |
| `forge/fg20-mixin-transformer-error.txt` | crashReport | FG-ML9 (Forge 47.1.0, MC 1.20.1, Java 17) | `C-MIXIN` | Crash report "Initializing game": MixinTransformerError "An unexpected critical error was encountered" -> MixinApplyError -> InvalidInjectionException "Critical injection failure"; `~[jar%23NNN!/:ver]` frames, no Suspected Mods block. Forge 47.1.0 predates the Suspected Mods backport, so the only attribution is the mixin config emberforge.mixins.json, which must be mapped to its jar. The Initialization modules list mentions nvoglv64.dll; that is not a native crash. |
| `forge/fg20-oom-heap.txt` | crashReport | FG-ML9 (Forge 47.3.0 dedicated server, MC 1.20.1, Linux) | `C-OOM` | "Exception in server tick loop" with `java.lang.OutOfMemoryError: Java heap space`; small -Xmx in JVM Flags and an exhausted Memory line. Dedicated server ran out of heap with -Xmx2G (Memory line shows 12 MiB free of 2048 MiB max). Suspected Mods: NONE must not produce a suspect finding. |
| `forge/fg20-oom-text-in-config-dump.txt` | crashReport | FG-ML9 (Forge 47.3.0, MC 1.20.1) | `C-SUSPECTED` | In-game crash with a mod-added `-- Memory Hint --` details category quoting OOM strings; heap is 39% used. Negative for C-OOM: "OutOfMemoryError", "GC overhead limit exceeded" and "Metaspace" appear only in a mod's config dump category and in JVM flags (-XX:+HeapDumpOnOutOfMemoryError, MaxMetaspaceSize). The real crash is a ClassCastException in Saplings Plus. |
| `forge/fg20-resolution-export-package.log` | latestLog | FG-ML9 (Forge 47.2.0, MC 1.20.1, JPMS) | `C-RESOLUTION` | Very short latest.log ending with `Exception in thread "main" java.lang.module.ResolutionException: Modules A and B export package P to module C` and MC-BOOTSTRAP frames. Both QuarryLib and VoxelKit shade com.fasterxml.jackson.core; tidyterrain (module C) is innocent. The game dies while ModLauncher builds the GAME layer, so there is no crash report; the raw stderr trace was captured at the end of latest.log by the launcher. |
| `forge/fg20-root-cause-only.txt` | crashReport | FG-ML9 (Forge 47.3.0, MC 1.20.1) | `C-ROOT-CAUSE` | Two-level nested `Caused by:` chain through vanilla classes only, `... 10 more` elision, `Suspected Mods: NONE`. Only signal is a RuntimeException -> ExecutionException -> IllegalArgumentException chain inside vanilla worldgen (likely a bad datapack tree config). The innermost Caused by is the root cause; Suspected Mods: NONE. |
| `forge/fg20-server-missing-dep-fml.txt` | crashReport | FG-ML9 (Forge 47.2.20 dedicated server, MC 1.20.1, Linux) | `C-MISSING-MANDATORY` | Forge `-fml.txt` with `-- MOD <id> --` sections whose Failure message is the translated missing-dependency text; Mod List rows in ERROR state. Dedicated server mod-loading crash (-fml.txt). Emberforge needs cloth_config (not installed) and Saplings Plus needs MC 1.20.2+. No throwable; the wrapper "Mod Loading has failed" must not become a root-cause finding. |
| `forge/fg20-suspected-mod.txt` | crashReport | FG-ML9 (Forge 47.3.0, MC 1.20.1, backported CrashReportAnalyser) | `C-SUSPECTED` | In-game "Ticking block entity" crash with a single `Suspected Mod:` entry, issue tracker URL and TRANSFORMER/ position line. Ticking block entity NPE inside Pipeworks; Forge 47.3.0 prints a single "Suspected Mod:" entry between Thread: and Stacktrace:. |
| `forge/fg20-suspected-mods-mixin.txt` | crashReport | FG-ML9 (Forge 47.2.20, MC 1.20.1) | `C-SUSPECTED` | `Suspected Mods:` with two entries, the second attributed via `Mixin class:`/`Target:`; `pl:mixin:APP:` audit trail in frames. Two suspects: one from a direct frame, one from a mixin applied to Gui (Mixin class / Target lines). The crash is a runtime exception, not a mixin application failure, so C-MIXIN must not fire. |
| `forge/fgboot-1.20.4-noclassdef-missing-dep.txt` | crashReport | FG-BOOT (Forge 49.0.30, MC 1.20.4, ForgeBootstrap) | `C-NOCLASSDEF` | Forge `-fml.txt`: `Caused by 0/1` (outermost first), `Exception message: ...ClassNotFoundException`; `~[jar!/:ver]` frames; ModLauncher services shown as `/`. Stormvane references dev.windlib.*, a package no installed jar provides: a missing dependency, not a broken jar. The finding should name Stormvane as the mod that needs it. |

### NeoForge (9)

| File | Kind | Era imitated | Expect | What it represents |
|---|---|---|---|---|
| `neoforge/neo20.4-injection-check-failed.txt` | crashReport | NEO-ML (NeoForge 20.4.237, FML 2.0.17, MC 1.20.4, mods.toml era) | `C-MIXIN` | Crash report with `MC-BOOTSTRAP/` and `TRANSFORMER/minecraft@1.20.4/` frame prefixes plus `%23NNN!/` jars; Caused by `InjectionError: Critical injection failure: Redirector ... failed injection check, (0/1) succeeded`. No Suspected Mods block (NeoForge has none). InjectionError (post-injection check) wrapped in MixinTransformerError while GameRenderer loads. The mixin config skyward.mixins.json maps to the Skyward jar. atio6axx.dll in the modules list is not a native crash. |
| `neoforge/neo20.4-missing-mandatory.log` | latestLog | NEO-ML (NeoForge 20.4.237, FML 2.0.17, MC 1.20.4) latest.log | `C-MISSING-MANDATORY` | NeoForge ModSorter ERROR block with `Mod ID:` lines (one `[MISSING]`, one version too old) and `fml.modloading.missingdependency` keys. NeoForge 20.4 client stops on the loading-error screen: FerroLib is missing for Skyward, and Mossy Paths wants a newer NeoForge than the one reported. Same line shape as Forge, but the logger is net.neoforged.fml.loading.ModSorter. |
| `neoforge/neo21.0-errorduringevent-key.txt` | crashReport | NEO-ML (NeoForge 21.0.10-beta, FML 4.0.6, MC 1.21, pre-PR #1479 format) | `C-SUSPECTED` | `-fml.txt` with `-- MOD <id> --`, `Mod File:`, `Failure message: fml.modloading.errorduringevent` + `Failure message arg 1:`; NEO-ML frame prefixes `TRANSFORMER/glowgrove@0.5.0/`. Early NeoForge 21.0 mod-loading crash: the Failure message is the raw key fml.modloading.errorduringevent; the `-- MOD glowgrove --` section and its Mod File line name the culprit. |
| `neoforge/neo21.1-mod-loading-issue.txt` | crashReport | NEO-ML (NeoForge 21.1.77, FML 4.0.31, MC 1.21.1, post-PR #1479 format) | `C-SUSPECTED` | `ModLoadingCrashException: Mod loading has failed`, `-- Mod loading issue for: <id> --`, `Mod file:`, `Mod issues URL: <No issues URL found>`, `TRANSFORMER/modid@ver/` frames. Current NeoForge mod-loading crash format: the issue section header and lower-case "Mod file:" name Ashen Realms, which threw an NPE in FMLCommonSetupEvent. |
| `neoforge/neo21.1-resolution-contains-package.debug.log` | debugLog | NEO-ML (NeoForge 21.1.77, FML 4.0.31, MC 1.21.1) debug.log | `C-RESOLUTION` | debug.log (DEBUG/TRACE lines, mod discovery listing) ending in `ResolutionException: Module A contains package P, module B exports package P to A`. Ashen Realms shades part of CorvusLib (package com.corvus.lib.util) while CorvusLib is also installed. debug.log with DEBUG/TRACE discovery noise; the stderr trace was appended by the launcher. |
| `neoforge/neo21.1-server-loading-errors.log` | latestLog | NEO-ML (NeoForge 21.1.77, FML 4.0.31, MC 1.21.1 dedicated server, Linux) latest.log | `C-MISSING-MANDATORY` | Full (short) server latest.log ending in `net.neoforged.fml.ModLoadingException: Loading errors encountered:` with three missing/unsupported dependency issues, including `Reason for the dependency:`. Load-time failure that appears only in latest.log: the dedicated server prints "Failed to start the minecraft server" and a ModLoadingException listing issues as "\t- " entries with "\t  " continuation lines. No crash report file is written. |
| `neoforge/neo21.1-unicode-paths.txt` | crashReport | NEO-ML (NeoForge 21.1.77, MC 1.21.1) | `C-NOCLASSDEF` | Two `-- Mod loading issue for:` sections with UTF-8 paths (`Jürgen Ölçer`, `Füchse & Freunde`, `kōyō-leaves-....jar`, `紅葉`); `Caused by 1: NoClassDefFoundError` whose package maps to tidewaterlib. Robustness: user name, profile folder, a jar file name and an exception message contain non-ASCII text (German, Turkish, Japanese). Lumen Fox needs a class from net.tidewater.lib.fluids, a package of the installed (outdated) Tidewater Lib jar. |
| `neoforge/neo26.1-mixin-shadow-class-processors.txt` | crashReport | NEO-11 (NeoForge 26.1.2.48-beta, FML 11.0.13, MC 26.1.2, Java 25) | `C-MIXIN` | No ModLauncher lines; `Class Processors:` block; frames carry `{neoforge:access_transformer,neoforge:mixin[APP:<cfg>:<Mixin> from mod <id>]}` and plain jar names; `-- Uptime --` category. MixinTransformerError -> MixinApplyError ("from mod rainshadow") -> InvalidMixinException @Shadow. FerroLib only appears in an unrelated neoforge:mixin[...] audit entry on a frame and is not the culprit. |
| `neoforge/neo26.1-oom-gc-overhead.log` | latestLog | NEO-11 (NeoForge 26.1.2.48-beta, FML 11.0.13, MC 26.1.2, Java 25) latest.log | `C-OOM` | `Starting FancyModLoader version 11.0.13 (CLIENT in PROD)`, many "Can't keep up!" WARNs, then `[Render thread/ERROR] [net.minecraft.client.Minecraft/FATAL]: Out of memory` + `OutOfMemoryError: GC overhead limit exceeded`. Client hit the vanilla OutOfMemoryScreen path ("Out of memory" logged, no crash report) with -Xmx3G and ParallelGC. FML 11 startup anchor and no ModLauncher lines. |

### Fabric (11)

| File | Kind | Era imitated | Expect | What it represents |
|---|---|---|---|---|
| `fabric/fab16-incompatible-mods-found-server.log` | latestLog | FAB legacy (Fabric Loader 0.11.6, MC 1.16.5 dedicated server, Java 8) latest.log | `C-FABRIC-INCOMPAT` | `Incompatible mods found!` ERROR + `ModResolutionException: Errors were found!` with a bare ` - Mod <id> requires mod <dep>, version ...` line. Headless dedicated server, so the GUI title "Incompatible mods found!" is logged instead of shown. Pre-0.12 loader package names (net.fabricmc.loader.discovery). Uncertain #3: old wording from memory. |
| `fabric/fab18-incompatible-mod-set-old.log` | latestLog | FAB old (Fabric Loader 0.12.12, MC 1.18.1) latest.log | `C-FABRIC-INCOMPAT` | Two-line latest.log + ModResolutionException with "A potential solution has been determined:" and "Unmet dependency listing:". Older loader wording ("Incompatible mod set!", "Mod resolution encountered an incompatible mod set!", "Unmet dependency listing:"). crash-formats.md Uncertain #3: reconstructed from memory, not re-verified in source. |
| `fabric/fab20-incompatible-current.log` | latestLog | FAB (Fabric Loader 0.15.11, MC 1.20.1) latest.log | `C-FABRIC-INCOMPAT` | `A critical error occurred` + `FormattedException: Some of your mods are incompatible with the game or each other!` with solution and "More details" lists. Complete latest.log of a launch that fails during mod resolution (the loader shows its GUI; no crash report). fabric-api is not installed and Trinketry needs a newer Fabric Loader. |
| `fabric/fab20-long-lines-noclassdef.log` | latestLog | FAB (Fabric Loader 0.15.11, MC 1.20.1) latest.log | `C-NOCLASSDEF` | latest.log with ~22 KB and ~20 KB lines, then `Unreported exception thrown!` + NoClassDefFoundError with `~[jar:?]` brackets on knot// frames. Robustness: two single lines of ~20 KB (a mod dumping its JSON table, a tag-loading error listing hundreds of references) precede the real failure. Curio Bag needs com.pebble.trinketry.api.SlotType; that package belongs to the installed, older Trinketry jar. |
| `fabric/fab20-mixin-apply-for-mod.log` | latestLog | FAB (Fabric Loader 0.15.11, MC 1.20.1) latest.log | `C-MIXIN` | Client latest.log with `Loading N mods:` tree, `Mixin apply for mod <id> failed <cfg>:<Mixin> from mod <id> -> <target>`, then the Knot wrapper and `[STDOUT]: #@!@# Game crashed!`. Fabric-fork wording names the mod twice. A harmless "does not specify minVersion" WARN for stackcount.mixins.json appears earlier and must not be blamed. |
| `fabric/fab20-noclassdef-missing-dep.txt` | crashReport | FAB (Fabric Loader 0.15.11, MC 1.20.1) | `C-NOCLASSDEF` | "Could not execute entrypoint stage 'client' due to errors, provided by '<id>'" -> NoClassDefFoundError -> ClassNotFoundException for a package absent from every jar. Shoalbound uses ConfigKit but does not declare it; no installed jar contains dev.lumen.configkit, so this is a missing dependency. The entrypoint message names Shoalbound directly. |
| `fabric/fab20-oom-metaspace.txt` | crashReport | FAB (Fabric Loader 0.15.11, MC 1.20.1) | `C-OOM` | "Exception in server tick loop" with `java.lang.OutOfMemoryError: Metaspace` thrown from ClassLoader.defineClass1; no Head section. Metaspace exhausted while defining a class on the integrated server; JVM Flags cap it with -XX:MaxMetaspaceSize=256M while the heap itself is healthy (2960 MiB free). |
| `fabric/fab20.6-requires-java-21.log` | latestLog | FAB (Fabric Loader 0.15.11, MC 1.20.6, Java 17) latest.log | `C-JAVA-VERSION` | Resolution failure whose only problem is the builtin `java` dependency (`Replace 'OpenJDK 64-Bit Server VM' (java) 17 with version 21 or later.`). Loader-specific wrong-Java message: Fabric models Java as the builtin mod "java" and Minecraft 1.20.6 depends on java >= 21. No mod jar is at fault, so no culprit file is expected. |
| `fabric/fab21-clean-session-long.log` | latestLog | FAB (Fabric Loader 0.16.9, MC 1.21.1) latest.log | _none (negative)_ | Long clean log: large `Loading N mods:` tree with `\|--`/`\--` jar-in-jar children, resource reload, world join, chat and save noise, clean shutdown. Negative case: a ~3.5k-line successful play session (151 mods) ending with a normal "Stopping!". Only benign WARNs (refmap, missing sounds, shader sampler, "Can't keep up!"). |
| `fabric/fab21-mixin-transformation-failed.txt` | crashReport | FAB (Fabric Loader 0.16.9, MC 1.21.1, intermediary names) | `C-MIXIN` | Crash report with `knot//` frames (no jar brackets), `Fabric Mods:` tree including jar-in-jar children, Fabric-fork mixin wording with `from mod <id>`. Knot wrapper "Mixin transformation of net.minecraft.class_757 failed" -> MixinTransformerError -> MixinApplyError (Fabric fork adds "from mod glintful") -> InvalidInjectionException. The handler name also embeds the mod id. |
| `fabric/fab21-root-cause-chain.txt` | crashReport | FAB (Fabric Loader 0.16.9, MC 1.21.1) | `C-ROOT-CAUSE` | Two nested `Caused by:` with `... N more`, wrapper CompletionException on top; attribution only via package prefix of `knot//` frames. CompletionException -> IllegalStateException -> NullPointerException. The innermost cause is the root; its knot// frames carry no jar names, so the culprit is found by mapping package com.pebble.trinketry.slot to the Trinketry jar. |

### Quilt (3)

| File | Kind | Era imitated | Expect | What it represents |
|---|---|---|---|---|
| `quilt/qlt-loader-report-missing-dep.txt` | crashReport | QLT (Quilt Loader 0.26.0, MC 1.20.1) | `C-FABRIC-INCOMPAT` | `---- Quilt Loader: Load Error Report ----` with `-- Error N --` titles, `-- Plugin State --`, markdown `-- Mod Table --`, `-- Mod Details --`, `---- end of report ----`. Quilt loader-phase report (crash-...-quilt_loader.txt). The Mod Table maps IDs to files directly (<mods>/...). Quilted Fabric API is not installed; a Fabric mod (owo) also needs fabric-api. Non-ASCII mod name "oωo". |
| `quilt/qlt20-breaks-latest.log` | latestLog | QLT (Quilt Loader 0.26.0, MC 1.20.1) latest.log | `C-FABRIC-INCOMPAT` | Short latest.log with the Quilt "breaks with all versions of ..., but an incompatible version is present" title and the pointer to the -quilt_loader.txt report. Quilt resolution failure written to latest.log: Lumen Lanterns declares breaks on every Sodium version. The detailed lines map both mods to files via <mods>/. |
| `quilt/qlt20-mixin-shadow-crash.txt` | crashReport | QLT (Quilt Loader 0.26.0, MC 1.20.1) | `C-MIXIN` | MixinTransformerError -> MixinApplyError -> InvalidMixinException "@Shadow method ... was not located in the target class"; System Details carries a `Quilt Mods:` table with File(s). In-game (vanilla-format) crash report under Quilt: Fabric-fork mixin wording ("from mod tideglass"), org.quiltmc Knot frames, brand 'quilt'. The `Quilt Mods:` key and its table layout are assumptions (crash-formats.md Uncertain #6). |

### JVM (hs_err) (5)

| File | Kind | Era imitated | Expect | What it represents |
|---|---|---|---|---|
| `jvm/hs_err_pid14872-amd-atio6axx.log` | hsErr | HotSpot 17 hs_err, Windows 11, Forge 47.2.0 command line | `C-NATIVE` | hs_err with `# Problematic frame:` / `# C  [atio6axx.dll+0x1b3e4f]`, native + Java frames, EXCEPTION_ACCESS_VIOLATION siginfo, P R O C E S S and S Y S T E M sections. AMD OpenGL driver access violation in the render thread (glDrawElements). The heap summary mentions "Metaspace used ..." as normal hs_err content, which must not be read as an OOM. |
| `jvm/hs_err_pid20516-nvidia-nvoglv64.log` | hsErr | HotSpot 17 (Microsoft build) hs_err, Windows 11, Fabric Loader 0.15.11 | `C-NATIVE` | `# C  [nvoglv64.dll+0xcd2a7]`, intermediary-named Java frames (`net.minecraft.class_757`), "writing address" siginfo. NVIDIA OpenGL driver crash in glBufferData under Fabric (KnotClient in the command line). The MC version is only implied by the launcher profile name, so mcVersion is null. |
| `jvm/hs_err_pid48211-linux-libgl.log` | hsErr | HotSpot 21 hs_err, Arch Linux, vanilla 1.21.1 | `C-NATIVE` | `#  SIGSEGV (0xb)` header, `# C  [libGL.so.1+0x2a3b1]`, `siginfo: si_signo: 11 (SIGSEGV)`. Linux SIGSEGV inside Mesa libGL during glfwSwapBuffers on vanilla 1.21.1 (radeonsi). Linux siginfo and /proc-style library map. |
| `jvm/hs_err_pid9120-insufficient-memory.log` | hsErr | HotSpot 17 hs_err, Windows 10, Forge 47.2.0 command line | `C-OOM` | `# There is insufficient memory ...`, `# Native memory allocation (mmap) failed to map ... for G1 virtual space`, `#  Out of Memory Error (os_windows.cpp:3618)`. JVM could not reserve a 16 GB heap (-Xms16G -Xmx16G) on a machine with 16 GB RAM and 7 GB free; dies 0.02 s after start. No Problematic frame, only V frames in jvm.dll, so this is not a native driver crash. |
| `jvm/hs_err_pid9932-intel-ig9icd64.log` | hsErr | HotSpot 21 hs_err, Windows 10, NeoForge 21.1.77 | `C-NATIVE` | `# C  [ig9icd64.dll+0x4a0f3]` (Intel ICD, matches `ig\w*icd64.dll`), Java frames in GL20C.nglLinkProgram. Intel UHD 620 OpenGL driver (ig9icd64.dll) crashing while linking a shader at startup; NeoForge 21.1.77 on Java 21. |

## Negative and trap cases

- `fabric/fab21-clean-session-long.log`: clean ~3.5k-line session; forbids every C-* code.
- `forge/fg20-clean-benign-cnfe-long.log`: successful launch with ClassNotFoundExceptions logged at
  WARN (Mixin "Error loading class", a compat loader stack trace, a "not present" message), recipe
  parse errors and a normal shutdown; forbids C-NOCLASSDEF and C-ROOT-CAUSE among others.
- `forge/fg20-oom-text-in-config-dump.txt`: OOM strings only inside a mod's crash-report config dump
  and JVM flags (`-XX:+HeapDumpOnOutOfMemoryError`, `MaxMetaspaceSize`); forbids C-OOM.
- Traps inside positive cases: GPU driver DLLs in the crash-report `Modules:` list
  (`forge/fg20-mixin-transformer-error.txt`, `neoforge/neo20.4-injection-check-failed.txt`; C-NATIVE
  forbidden), `Suspected Mods: NONE` (C-SUSPECTED forbidden), harmless refmap/minVersion mixin WARNs
  before a real mixin failure, the "Metaspace used" line every hs_err heap summary contains (C-OOM
  forbidden in the native-crash hs_err cases), and a non-culprit mixin owner in a NEO-11 frame audit.

## Robustness cases

- CRLF line endings: `forge/fg19-suspected-crlf.txt` (every line ends in `\r\n`).
- Non-ASCII: `neoforge/neo21.1-unicode-paths.txt` (user `Jürgen Ölçer`, profile `Füchse & Freunde`,
  jar `kōyō-leaves-1.21.1-1.0.4.jar`, `紅葉` in a message); `quilt/qlt-loader-report-missing-dep.txt`
  (mod name `oωo`).
- Very long single lines (~20 KB each): `fabric/fab20-long-lines-noclassdef.log`.
- Long files with mostly benign noise: `fabric/fab21-clean-session-long.log` (~3.5k lines),
  `forge/fg20-clean-benign-cnfe-long.log` (~1.8k lines).

## Formats that are uncertain

These shapes follow crash-formats.md but the doc itself flags them as unverified ("Uncertain" list):

- `forge/fg17-resolution-reads-package.log`: "Module X reads package Y from both A and B" (Uncertain #1).
  Kept because SPEC.md names it; treat as a soft anchor.
- `fabric/fab18-incompatible-mod-set-old.log`, `fabric/fab16-incompatible-mods-found-server.log`: old
  Fabric Loader wording (Uncertain #3). The 0.11.x line shapes are reconstructed.
- Fabric/Quilt latest.log jar brackets such as `~[client-intermediary.jar:?]` (Uncertain #4).
- Forge latest.log frames with the `{audit}` suffix (Uncertain #5).
- `quilt/qlt20-mixin-shadow-crash.txt`: the `Quilt Mods:` key and table layout (Uncertain #6); the
  Quilt loader report's error-body lines and the Quilt latest.log lines are also reconstructed.
- `forge/fg16-noclassdef-package.txt`: FG-ML8 `~[modid:version]` brackets (Uncertain #7).
- `#@!@# Game crashed!` lines (Uncertain #8) and MC 26.1 on Java 25 (Uncertain #9).
- `neoforge/neo21.0-errorduringevent-key.txt`: raw `fml.modloading.*` key era (Uncertain #11).
- Also reconstructed, not taken from a verified source: the Forge/NeoForge `Error during pre-loading phase`
  / `Skipping lifecycle event` lines after a ModSorter failure, `Exception message: MISSING EXCEPTION MESSAGE`
  in a dependency-only `-fml.txt` section, the NEO-11 `fml_loader` frame class names, and launchers
  appending the raw `Exception in thread "main"` stderr trace to latest.log/debug.log for JPMS
  failures (log4j itself does not capture it).
