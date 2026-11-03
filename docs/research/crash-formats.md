# Crash report & log formats (R2)

Research for the Modpack Doctor parser. Researched 2026-11-02 against loader source on GitHub and real pasted reports.
The examples are representative shapes rebuilt in our own words. Mod names, paths and numbers are invented. **Literal markers are exact**: they were copied from source code or real reports. `\t` means a literal tab.

Version eras used below:

| Tag | Loader / MC | Notes |
|---|---|---|
| FG-LEGACY | Forge 1.12.2 and older (LaunchWrapper) | not the focus; see the Uncertain list |
| FG-ML8 | Forge 1.13–1.16.5 (ModLauncher 8, no JPMS) | |
| FG-ML9 | Forge 1.17–1.20.1 (ModLauncher 9/10, SecureJarHandler union FS) | |
| FG-BOOT | Forge 1.20.2+ (ForgeBootstrap, ML 10.1+) | |
| NEO-ML | NeoForge 20.2–21.x (FML 1–4+, ModLauncher 10/11) | |
| NEO-11 | NeoForge 26.1+ (FML 11, ModLauncher removed, "Class Processors") | |
| FAB | Fabric Loader 0.14–0.20 | |
| QLT | Quilt Loader 0.17+ | |

---

## 1. `crash-reports/` files

### 1.1 File names
- Vanilla, Fabric, Quilt, Forge and NeoForge in-game crashes: `crash-YYYY-MM-DD_HH.mm.ss-client.txt` or `-server.txt`.
- **Forge and NeoForge mod-loading failures** use `crash-YYYY-MM-DD_HH.mm.ss-fml.txt`. They are written by `CrashReportExtender.dumpModLoadingCrashReport`. The log line is `Crash report saved to {}` at FATAL level.
- **Quilt loader-phase failures** use `crash-YYYY-MM-DD_HH.mm.ss.SSSS-quilt_loader.txt`. This file has its own format; see 1.6.
- Vanilla also logs `#@!@# Game crashed! Crash report saved to: #@!@# <path>`, which launchers grep for. Treat this as uncertain on very new versions. 1.19+ also logs `Preparing crash report with UUID <uuid>`.

### 1.2 Common vanilla skeleton (all loaders except a Quilt loader report)
```
---- Minecraft Crash Report ----
// <random witty comment>

Time: 2026-05-16 21:27:12            (1.18+ ISO; older: dd/MM/yy HH:mm)
Description: Ticking block entity

java.lang.SomeException: message     <- top-level throwable, printStackTrace style
\tat <frame>
Caused by: ...
\t... 13 more


A detailed walkthrough of the error, its code path and all known details is as follows:
---------------------------------------------------------------------------------------

-- Head --                            <- only present if there is an "uncategorized" stack
Thread: Render thread
Stacktrace:
\tat <frame>

-- Block entity being ticked --       <- 0..n categories: "-- <Name> --", then "Details:", then "\t<Key>: <value>"
Details:
\tName: ...
Stacktrace:
\tat ...

-- System Details --
Details:
\tMinecraft Version: 1.21.11
\tMinecraft Version ID: 1.21.11
\tOperating System: Windows 10 (amd64) version 10.0
\tJava Version: 21.0.9, Azul Systems, Inc.
\tJava VM Version: OpenJDK 64-Bit Server VM (mixed mode, sharing), Azul Systems, Inc.
\tMemory: 2835165416 bytes (2703 MiB) / 5519704064 bytes (5264 MiB) up to 25769803776 bytes (24576 MiB)
\tCPUs: 20 ... Graphics card #0 name: ... Memory slot #0 ... Virtual memory max (MiB): ...
\tJVM Flags: 2 total; -XX:HeapDumpPath=... -Xmx24576M
\tDebug Flags: 0 total;
\t<loader-specific keys>
\tIs Modded: Definitely; Client brand changed to 'fabric'
\tType: Integrated Server (map_client.txt) | Dedicated Server | Client (map_client.txt)
\tLaunched Version: <profile name>
```
Parser notes:
- **Memory line**: `Memory: <free> bytes (<n> MiB) / <total> bytes (<n> MiB) up to <max> bytes (<n> MiB)`. The value after `up to` is `-Xmx`. Older versions use `MB` instead of `MiB`. Regex: `^\tMemory: (\d+) bytes \((\d+) Mi?B\) / (\d+) bytes \((\d+) Mi?B\) up to (\d+) bytes \((\d+) Mi?B\)`.
- **JVM Flags**: `JVM Flags: <N> total; <space-separated flags>`. Look for `-Xmx\d+[kKmMgG]` and `-Xms`.
- **Java Version**: `Java Version: <version>, <vendor>`. On 1.8 it looks like `1.8.0_51`, otherwise `17.0.15`, `21.0.3` or `25.0.2`.
- The lines from `Details:` onward are a tab-indented `Key: value` map. Multi-line values (mod lists, services) continue with `\t\t`.
- Nested causes in the top block use the standard Java format: `Caused by: <fqcn>: <msg>`, frames `\tat ...`, `\t... N more`, `\tSuppressed: ...`.

### 1.3 Forge additions (FG-ML8 → FG-BOOT)
- **Suspected Mods** come from `CrashReportAnalyser`. They were added and backported on 2023-11-02 to 1.18.2, 1.19.2, 1.19.4 and 1.20.1, so they appear in Forge 47.2.x-era builds and later. The block is inserted in `-- Head --` **between `Thread:` and `Stacktrace:`**. Source: `buildSuspectedModsSection`.
```
-- Head --
Thread: Render thread
Suspected Mod:                        <- "Suspected Mod: " when 1, "Suspected Mods: " when 0 or >1
\tCoolMod (coolmod), Version: 1.2.3
\t\tIssue tracker URL: https://example.org/issues           <- only if issueTrackerURL is in mods.toml
\t\tat TRANSFORMER/coolmod@1.2.3/com.example.cool.Foo.bar(Foo.java:24)
Stacktrace:
```
  - With no suspects the line is `Suspected Mods: NONE`.
  - Each entry is `\t<DisplayName> (<modid>), Version: <ver>`. When the match came from a mixin, the position lines are `\t\tMixin class: <fqcn>` / `\t\tTarget: <fqcn>` (or `Targets: [a, b]`) / `\t\tat <frame>`.
  - Regex for an entry: `^\t(.+) \(([a-z0-9_.-]+)\), Version: (.+)$`.
- **Mod-loading crash (`-fml.txt`)**: Description `Mod loading error has occurred`, top exception `java.lang.Exception: Mod Loading has failed`. Then one category per error:
```
-- MOD coolmod --                     ("-- NO MOD INFO AVAILABLE --" when unknown)
Details:
\tCaused by 0: java.lang.ExceptionInInitializerError     <- outermost first; 0..n
\t\tat ...
\tMod File: /C:/Users/x/AppData/Roaming/.minecraft/mods/coolmod-1.2.3.jar   <- URI path, leading "/" before drive
\tFailure message: CoolMod (coolmod) has failed to load correctly
\t\tjava.lang.NoSuchMethodError: '...'
\tMod Version: 1.2.3
\tMod Issue URL: https://...          ("NOT PROVIDED")
\tException message: java.lang.NoSuchMethodError: ...   <- innermost cause
Stacktrace:                           <- innermost cause's frames
\tat ...
```
- **System Details keys** (Forge):
```
\tModLauncher: 10.1.2                     (1.20.1 often "10.0.9+10.0.9+main.dcd20f30")
\tModLauncher launch target: forgeclient  (forge_client / forgeserver / fmlclient on 1.16)
\tModLauncher naming: srg
\tModLauncher services:
\t\tmixin-0.8.5.jar mixin PLUGINSERVICE     (FG-ML9: "<jar> <name> <TYPE>"; FG-BOOT: "/ mixin PLUGINSERVICE")
\tFML Language Providers:
\t\tminecraft@1.0
\t\tjavafml@null | javafml@47.2 | lowcodefml@...
\tMod List:
\t\tcoolmod-1.2.3.jar                 |CoolMod                       |coolmod                       |1.2.3               |DONE      |Manifest: NOSIGNATURE
\tCrash Report UUID: 3c3e...
\tFML: 47.2 | 0.0
\tForge: net.minecraftforge:47.2.0
```
  - Mod List columns are `file | display name | modid | version | STATE | Manifest: <NOSIGNATURE | aa:bb:...>`. They are pipe-separated and space-padded; the version is truncated at about 20 chars. STATE is one of `DONE`, `ERROR`, `COMMON_SET`, `SIDED_SETUP`, `VALIDATE`, and so on. **`ERROR` marks the failed mod.** FG-ML8 (1.16) uses the same layout.
  - Example source: https://github.com/Cadiboo/NoCubes/issues/127 (Forge 49.0.3).

### 1.4 NeoForge additions
NeoForge did **not** port Forge's CrashReportAnalyser, so there is no "Suspected Mods" block.
- **NEO-ML before 21.1.x (Aug 2024)**: Description `Mod loading error has occurred`, top exception `java.lang.Exception: Mod Loading has failed`. Sections use `-- MOD <modid> --` with `Mod File:`, `Failure message: fml.modloading.errorduringevent` (a raw translation key), `Failure message arg 1: <event class>`, `Mod Version:`, `Mod Issue URL:` and `Exception message:`. Source: https://gist.github.com/NielsPilgaard/28f2fabee7f8c7c23c9d36faa8646e65 (NeoForge 21.0.10).
- **NeoForge PR #1479 (2024-08-27) and later, including 26.x**: Description `Mod loading failures have occurred; consult the issue messages for more details`. Top exception is a `ModLoadingCrashException` with message `Mod loading has failed`. Sections look like this:
```
-- Mod loading issue for: coolmod --          ("-- Mod loading issue --" when no mod)
Details:
\tCaused by 0: ...
\tMod file: /home/u/server/mods/coolmod-1.2.3.jar   (lower-case "file")
\tFailure message: CoolMod (coolmod) encountered an error while dispatching the net.neoforged...RegisterEvent event
\t\tjava.lang.ExceptionInInitializerError: null
\tMod version: 1.2.3
\tMod issues URL: https://...                   ("<No issues URL found>")
\tException message: java.lang.IllegalStateException: ...
```
- **System Details**:
  - NEO-ML still prints `ModLauncher:`, `ModLauncher launch target:`, `ModLauncher services:` (lines like `\t\tloader-4.0.6.jar slf4jfixer PLUGINSERVICE`) and `FML Language Providers:`.
  - **NEO-11 (FML 11, MC 26.1) drops all ModLauncher lines** and adds `\tClass Processors:` with lines like `\t\t02.15%: neoforge:access_transformer`.
  - The Mod List has **5 columns, with no state column**: `file | name | modid | version | Manifest: <NOSIGNATURE | hex fingerprint>`.
  - The section ends with `\tCrash Report UUID:`, `\tFML: 11.0.13` and `\tNeoForge: 26.1.2.48-beta`.
  - Source: https://gist.github.com/McKitten/62582ae79b6fd40e2c0615c277e5dc6d.

### 1.5 Fabric additions
- The crash report is pure vanilla plus a `Fabric Mods:` key in System Details. It is a tree: top-level mods use 2 tabs, jar-in-jar children use 3 tabs, and the format is `<modid>: <Name> <version>`.
```
\tFabric Mods:
\t\tfabric-api: Fabric API 0.141.6+1.21.11
\t\t\tfabric-api-base: Fabric API Base 1.0.5+4ebb5c083e
\t\tfabricloader: Fabric Loader 0.20.1
\t\t\tmixinextras: MixinExtras 0.5.5
\t\tjava: OpenJDK 64-Bit Server VM 21
\t\tminecraft: Minecraft 1.21.11
```
  - The `Fabric Mods:` list **contains no file names**. You must map modid to jar by scanning `fabric.mod.json` in `mods/`. Source: https://github.com/xandergos/terrain-diffusion-mc/issues/259.
- There is **no "Suspected Mods" block in Fabric**. Third-party mods such as Not Enough Crashes and Crash Assistant may add their own.
- Loader-phase failures (incompatible mods, entrypoint crash) normally produce **no crash-reports file**. They are shown in a GUI and logged to latest.log (§3.5).
- Quilt in-game crashes use the same vanilla report. Quilt adds `Quilt Mods:` (assumed; see Uncertain) and the brand string `'quilt'`.

### 1.6 Quilt loader report (`-quilt_loader.txt`)
Source: `QuiltReport.writeInternal` and `QuiltPluginManagerImpl`.
```
---- Quilt Loader: Load Error Report ----   (also "Crashed!", "Quilt Loader: Crash Report", "Quilt Loader: Load Timeout Report",
                                              "Quilt Loader: Critial Error Report" [sic], "Quilt Loader: Failed to load")
Date/Time: 2024/03/21 18:44:22.1635
Quilt Loader Version: 0.26.0

-- Error 1 --
<title line, e.g. "CoolMod requires any version of Quilt Standard Libraries, which is missing!">
...
-- Plugin State --
-- Mod Table --      (older: "-- Mods --"; markdown table "| Index | Mod | ID | Version | Plugin | File(s) |",
                      files shown as "<mods>/coolmod-1.2.3.jar")
-- Mod Details --
---- end of report ----
```
The Quilt Mod Table **does map ID to file**, so use it directly. Examples: https://github.com/QuiltMC/quilt-loader/issues/415 and https://github.com/RealRTTV/malum-quilt/issues/24.

---

## 2. Log files

### 2.1 Line formats
| Loader | `logs/latest.log` pattern (log4j) | Example shape |
|---|---|---|
| Vanilla / Fabric / Quilt (MC log4j config) | `[%d{HH:mm:ss}] [%t/%level]: %msg` | `[13:16:42] [Render thread/ERROR]: Mixin apply for mod ...` |
| Fabric dev / some launch setups | `[%d{HH:mm:ss}] [%t/%level] (%logger) %msg` | `[21:44:58] [main/ERROR] (FabricLoader/Mixin) Mixin apply ...` |
| Fabric fallback ConsoleLogHandler (no log4j) | `[%tT] [LEVEL] [context/name]: msg` | `[12:00:01] [ERROR] [FabricLoader/Mixin]: ...` |
| Forge FG-ML8 → FG-BOOT, NeoForge all | `[%d{ddMMMyyyy HH:mm:ss.SSS}] [%t/%level] [%logger/%markerSimpleName]: %msg` | `[16May2026 21:41:59.415] [main/WARN] [mixin/]: Reference map ...` |
| Forge/NeoForge console (stdout) | `[%d{HH:mm:ss}] [%t/%level] [minecraft/%logger{1}]: ...` | |

- Universal line regex: `^\[(?<ts>[^\]]+)\] \[(?<thread>[^\]/]+(?:/[^\]/]+)*?)/(?<level>TRACE|DEBUG|INFO|WARN|ERROR|FATAL)\](?: \[(?<logger>[^\]]*)\]| \((?<logger2>[^)]*)\))?:? ?(?<msg>.*)$`. Thread names can contain spaces (`Render thread`, `Worker-Main-12`), and the marker may be empty (`[mixin/]`). Forge markers include `LOADING`, `SCAN`, `MODLAUNCHER`, `CORE`, `EVENTBUS` and `MIXIN`.
- A stack trace follows its log line, with no prefix, as `fqcn: msg` / `\tat ...` lines. **Any line that doesn't match the header regex continues the previous record.**
- Forge/NeoForge redirect stdout/stderr as logger `STDOUT`/`STDERR`, e.g. `[...] [main/INFO] [STDERR/]: [com.x.Y:method:12]: text`.
- Fabric startup anchor: `Loading Minecraft <ver> with Fabric Loader <ver>`, then `Loading N mods:` followed by a tree `\t- modid version` (with `|-- child`/`\-- child` for JiJ). NeoForge startup anchor: `Starting FancyModLoader version 11.0.13 (DEDICATED_SERVER in PROD)`. Forge startup anchor: `ModLauncher running: args [...]`.
- Sources: Forge log4j2.xml https://github.com/MinecraftForge/MinecraftForge/blob/1.20.1/fmlloader/src/main/resources/log4j2.xml, FML https://github.com/neoforged/FancyModLoader/blob/main/loader/src/main/resources/net/neoforged/fml/startup/log4j2.xml, Fabric ConsoleLogHandler.

### 2.2 `logs/debug.log`
- Only Forge and NeoForge write this file. It uses the same pattern as latest.log, but at DEBUG/TRACE level (`forge.logging.debugFile.level`, default `debug`), and rolls to `debug-N.log.gz`.
- It contains the full mod discovery, `Found N mod requirements`, the `Found N mods for first modid` selection and transformer details. Prefer it over latest.log when both exist, but expect it to be 5–20x larger.
- Vanilla, Fabric and Quilt write only `latest.log` plus gzipped dated logs.

---

## 3. Failure anchors

### 3.1 Root `Caused by:` chain (all loaders)
- Java format: `Caused by: <fqcn>(: <msg>)?`. The **innermost cause is the last `^Caused by:` at the same indentation** inside one contiguous trace. Ignore tab-indented `\tSuppressed:` and `\tCaused by:` lines, because those belong to suppressed exceptions.
- Wrapper exceptions to skip over when picking the "real" cause: `ReportedException`, `ExecutionException`, `CompletionException`, `InvocationTargetException`, `ExceptionInInitializerError` (look at its cause), `MixinTransformerError`, `ModLoadingException` and `FormattedException`.
- In Forge/NeoForge `-fml.txt` files the order is reversed: `Caused by 0` is the outermost, and the innermost is `Exception message:` plus the section `Stacktrace:`.
```
java.util.concurrent.CompletionException: java.lang.RuntimeException: boom
\tat java.base/...
Caused by: java.lang.RuntimeException: boom
\t... 5 more
Caused by: java.lang.NullPointerException: Cannot invoke "Object.toString()" because "x" is null   <- innermost
\tat knot//com.example.cool.Foo.bar(Foo.java:12)
```

### 3.2 Mixin failures (all loaders; strings from SpongePowered/Mixin `MixinProcessor`)
| String | Emitter |
|---|---|
| `Mixin apply failed <config>:<Mixin> -> <target>: <exClass> <msg>` | upstream Mixin (Forge, NeoForge), level ERROR, logger `mixin` |
| `Mixin apply for mod <modid> failed <config>:<Mixin> from mod <modid> -> <target>: <exClass> <msg>` | **FabricMC/Mixin fork (Fabric and Quilt)**, logger `FabricLoader/Mixin` |
| `Mixin prepare failed preparing <Mixin> in <config>: ...` | PREPARE phase |
| `org.spongepowered.asm.mixin.throwables.MixinApplyError: Mixin [<config>:<Mixin>( from mod <modid>)?] from phase [DEFAULT] in config [<config>] FAILED during APPLY` | all |
| `org.spongepowered.asm.mixin.transformer.throwables.MixinTransformerError: An unexpected critical error was encountered` | all (wrapper; read its cause) |
| `java.lang.RuntimeException: Mixin transformation of <class> failed` | Fabric Knot wrapper |
| `org.spongepowered.asm.mixin.injection.throwables.InvalidInjectionException: Critical injection failure: @Inject annotation on <handler> could not find any targets matching '<sel>' in <target>. Using refmap <x>-refmap.json [<PHASE> -> <config>:<Mixin>( from mod <modid>)? -> ...]` | all |
| `Critical injection failure: <ann> <handler><desc> in <config>:<Mixin> failed injection check, (0/1) succeeded. Scanned N target(s).` | `InjectionError` |
| `InvalidMixinException: @Shadow field <f> was not located in the target class <t>.` / `... method <m> in <mixin> was not located in the target class` | all |
| `Error encountered whilst initialising mixin config '<config>': ...` / `Mixin config <x>.mixins.json does not specify "minVersion"` (noise) / `Reference map '<x>' for <cfg> could not be read` (WARN, usually harmless) | all |

**Where the IDs are:**
- The config name always matches `[\w.-]+\.mixins?\.json`. The mixin's FQCN is the config `package` plus `<Mixin>`.
- Fabric and Quilt append ` from mod <modid>`, or `(unknown)` when unknown.
- On Forge/NeoForge you **must map config to mod** by scanning jars for the config file (listed in `META-INF/MANIFEST.MF` `MixinConfigs:` or `mods.toml [[mixins]]`).
- Forge frames also carry `pl:mixin:APP:<config>:<Mixin>` in `{...}`. NEO-11 frames carry `neoforge:mixin[APP:<config>:<Mixin> from mod <modid>,...]`.
- Fabric Mixin handler names embed the modid: `handler$znp000$<modid>$<method>` (seen in a Quilt report).
```
[21:44:58] [main/ERROR]: Mixin apply for mod coolmod failed coolmod.mixins.json:LoginMixin from mod coolmod -> net.minecraft.class_118: org.spongepowered.asm.mixin.injection.throwables.InvalidInjectionException Critical injection failure: ...
org.spongepowered.asm.mixin.injection.throwables.InvalidInjectionException: Critical injection failure: @ModifyConstant annotation on cool$limit could not find any targets matching 'read' in net.minecraft.class_118. Using refmap coolmod-refmap.json [PREINJECT Applicator Phase -> coolmod.mixins.json:LoginMixin from mod coolmod -> Prepare Injections -> ...]
\tat org.spongepowered.asm.mixin.injection.struct.InjectionInfo.validateTargets(InjectionInfo.java:...)
...
org.spongepowered.asm.mixin.transformer.throwables.MixinTransformerError: An unexpected critical error was encountered
Caused by: org.spongepowered.asm.mixin.throwables.MixinApplyError: Mixin [coolmod.mixins.json:LoginMixin from mod coolmod] from phase [DEFAULT] in config [coolmod.mixins.json] FAILED during APPLY
```
Sources: https://github.com/SpongePowered/Mixin/blob/master/src/main/java/org/spongepowered/asm/mixin/transformer/MixinProcessor.java, FabricMC fork https://github.com/FabricMC/Mixin (`MixinInfo.toString`, `MixinProcessor`), real log https://github.com/ModificationStation/StationAPI/issues/101.

### 3.3 JPMS split-package / module conflicts (FG-ML9, FG-BOOT, NEO-ML; not NEO-11, Fabric or Quilt)
These are the exact JDK strings (`java.lang.module.Resolver`, JDK 11/17/21):
- `java.lang.module.ResolutionException: Modules <A> and <B> export package <pkg> to module <C>`. This is the common one, usually caused by two jars shipping the same library package. `<C>` is often an innocent mod.
- `Module <A> contains package <pkg>, module <B> exports package <pkg> to <A>`
- `Module <A> reads more than one module named <B>` / `Module <A> reads another module named <B>`. These mean a duplicate jar or library (e.g. two `org.spongepowered.mixin`, OptiFine on a server).
- `java.lang.LayerInstantiationException: Package <pkg> in more than one module` / `... cannot be imported from multiple loaders`. These come from `jdk.internal.loader.Loader`.
- **"Module X reads package Y from both A and B" does not exist in JDK 11/17/21 source**; do not rely on it (see Uncertain).
- Module names are automatic-module names derived from jar names or `Automatic-Module-Name` (e.g. `coolmod`, `org.slf4j`), so map them back by jar scan.
```
Exception in thread "main" java.lang.module.ResolutionException: Modules libfoo and coolmod export package com.lib.foo to module othermod
\tat java.base/java.lang.module.Resolver.resolveFail(Resolver.java:901)
\tat java.base/java.lang.module.Resolver.failTwoSuppliers(Resolver.java:815)
\tat MC-BOOTSTRAP/cpw.mods.modlauncher@10.0.9/cpw.mods.modlauncher.ModuleLayerHandler.buildLayer(...)
```

### 3.4 Forge/NeoForge missing dependencies
The log line is emitted by `ModSorter` (Forge FG-ML8+ and FML) at ERROR, with logger `net.minecraftforge.fml.loading.ModSorter/LOADING` or `net.neoforged.fml.loading.ModSorter/LOADING`. It is the same on both:
```
[02Nov2026 10:00:01.000] [main/ERROR] [net.neoforged.fml.loading.ModSorter/LOADING]: Missing or unsupported mandatory dependencies:
\tMod ID: 'architectury', Requested by: 'coolmod', Expected range: '[13.0.0,)', Actual version: '[MISSING]'
\tMod ID: 'minecraft', Requested by: 'othermod', Expected range: '[1.20.1,1.20.2)', Actual version: '1.20.4'
```
- Line regex: `^\tMod ID: '([^']+)', Requested by: '([^']+)', Expected range: '([^']*)', Actual version: '([^']*)'$`. `[MISSING]` means the mod is not installed. The same line shape follows `Unsupported installed optional dependencies:`.
- FML also logs incompatibility lines with `... is incompatible with ...` or `discourages`.
- GUI/translated text (it appears in `-fml.txt` `Failure message:` and in NeoForge `Loading errors encountered:`):
  - Forge: `Mod coolmod requires architectury 13.0.0 or above` / `Currently, architectury is not installed`.
  - NeoForge: same, plus `Reason for the dependency: ...`.
  - Keys: Forge `fml.modloading.missingdependency`; NeoForge (newer FML) `fml.modloadingissue.missingdependency`, `fml.modloadingissue.incompatiblemod` (`Mod X is incompatible with Y ...`), `fml.modloadingissue.discouragedmod`.
- Cycles: `Mod Sorting failed.\nDetected Cycles: [...]` and `Detected a mod dependency cycle: ...`.

### 3.5 Fabric resolution errors (FAB ≥0.12; strings from `Messages.properties` and `ResultAnalyzer`)
```
[12:00:01] [main/ERROR]: A critical error occurred
net.fabricmc.loader.impl.FormattedException: Some of your mods are incompatible with the game or each other!
A potential solution has been determined, this may resolve your problem:
\t - Install fabric-api, any version.
\t - Replace mod 'Cool Mod' (coolmod) 1.0.0 with version 1.2.0 or later.
More details:
\t - Mod 'Cool Mod' (coolmod) 1.0.0 requires any version of fabric-api, which is missing!
\t - Mod 'Other' (other) 2.1 requires version 0.16.0 or later of 'Fabric Loader' (fabricloader), but only the wrong version is present: 0.15.7!
\tat net.fabricmc.loader.impl.FormattedException.ofLocalized(FormattedException.java:51) ~[fabric-loader-0.15.7.jar:?]
```
- GUI title (it may also appear in logs): `Incompatible mods found!` (`exception.incompatible`). Others: `A mod crashed on startup!`, `Failed to start Minecraft!`, `Minecraft has crashed!`, `Failed to launch!`.
- **Mod name format**: `mod '<Name>' (<id>)` for regular mods, and just `'<Name>' (<id>)` for builtins (`minecraft`, `java`, `fabricloader`). The sentence starts with the capitalised `Mod '...`. Regex: `(?:[Mm]od )?'([^']+)' \(([^)]+)\) (\S+)`.
- Explanation templates, where `{0}` is the name, `{1}` the version, `{2}` the dependency name and `{3}` the range text:
  - `{0} {1} requires {3} of {2}, which is missing!`
  - `{0} {1} requires {3} of {2}, but only the wrong version is present: {4}!` (or `versions are present`)
  - `{0} {1} requires {3} of {2}, which is disabled for this environment (client/server only)!`
  - `{0} {1} requires {3} of {2}, which can't be loaded due to other constraints!`
  - `{0} {1} is incompatible with {3} of {2}, yet a conflicting version is present: {4}!` (breaks)
  - `{0} {1} conflicts with ...` (warning only)
  - `recommends` variants
- Solutions: `Install {0}, {1}.` / `Remove {0} {1} ({2}).` (`{2}` is the jar path; this is how duplicates show) / `Replace {0} with {1}, {2}.` / `Replace {0} with {1}.` / `Replace {0} with {2} of {1} that can load in the current environment (...)`.
- Ranges: `any version`, `version X`, `version X or later`, `any version before X`, `any X.x version`, `any version between X (inclusive) and Y (exclusive)`, and so on.
- Older FAB (≈0.11–0.13): `net.fabricmc.loader.impl.discovery.ModResolutionException: Mod resolution encountered an incompatible mod set!` with `Unmet dependency listing:` (see Uncertain). Internal: `duplicate mod <id>`, `Mods share ID with builtin mod ...`.
- Entrypoint crash: `java.lang.RuntimeException: Could not execute entrypoint stage 'main' due to errors, provided by 'coolmod' at 'com.example.Cool'!` and `EntrypointException: Exception while loading entries for entrypoint 'client' provided by 'coolmod'`. **These name the mod directly.**
- Debug info in the log: `Mod resolution failed`, `Immediate reason: ...`, `Fix: add [...], remove [...], replace [...]`.

### 3.6 Quilt equivalents (strings from `quilt_loader.properties`, `SolverErrorHelper`)
- Titles:
  - `<ModName> requires any version of <dep>, which is missing!`
  - `... requires version 1.5.1 of <dep>, but only a different version is present: 1.4!`
  - `... requires at least version X or any newer version of <dep>, ...`
  - `transitively requires` variants
  - `<ModName> breaks with all versions of <dep>, but an incompatible version is present: X`
- Report text: `<ModName> requires any version of <depId>, which is missing!` or `..., but only wrong versions are present:` followed by `- version X` lines.
- Duplicates: `Duplicate mod: <name>` followed by `- <path>` lines, then `Remove all but one.` Report text: `Duplicate mandatory mod ids [...]`.
- Other: `Unknown mod: <file>` (Forge or other non-Quilt jar), `Found %s Forge mods.` / `Found %s Neoforge mods.`, `Broken zip file: <f>`, `Found a zero byte file!`, `Complex solver error; see the crash report for more information`.
- Quilt also runs Fabric mods through `quilted_fabric_loader`, so Fabric-style lines can appear too.

### 3.7 NoClassDefFoundError / ClassNotFoundException (all)
- `java.lang.NoClassDefFoundError: net/minecraft/client/renderer/RenderType` uses **slashes**. It is often followed by `Caused by: java.lang.ClassNotFoundException: net.minecraft.client.renderer.RenderType`, which uses **dots**. Normalize `/` to `.`.
- Related:
  - `NoSuchMethodError: 'void com.lib.Api.call(int)'` (Java 11+ quoted descriptor)
  - `NoSuchFieldError: FOO`
  - `AbstractMethodError`
  - `IncompatibleClassChangeError`
  - Forge: `Attempted to load class net/minecraft/client/player/LocalPlayer for invalid dist DEDICATED_SERVER`. This is the client-only-mod-on-server signature, raised from `RuntimeDistCleaner`.
- Diagnosis: a missing class in `net.minecraft.*` means wrong MC version or mapping. A missing class in a library package means a missing dependency; map the package prefix to a mod.

### 3.8 JVM out of memory (all)
- `java.lang.OutOfMemoryError: Java heap space`, `GC overhead limit exceeded`, `Metaspace`, `Compressed class space`, `Direct buffer memory`, `Requested array size exceeds VM limit`, `unable to create native thread: possibly out of memory or process/resource limits reached` (older: `unable to create new native thread`).
- Vanilla's in-game handling logs an `Out of memory` error and shows the OOM screen (see Uncertain).
- **Cross-check with the crash `Memory:` line and `JVM Flags: -Xmx`.** Heap space plus a small `-Xmx` (≤4G for big packs) means raise the RAM. Heap space plus a huge `-Xmx` means a memory leak or too much RAM for the GC. Metaspace usually means a huge pack or a leak.
- hs_err native OOM: `# There is insufficient memory for the Java Runtime Environment to continue.` then `# Native memory allocation (malloc) failed to allocate N bytes for <tag>` or `(mmap) failed to map N bytes for G1 virtual space`, then `# Possible reasons:` and `#  Out of Memory Error (os_windows.cpp:NNNN), pid=...`. This means the OS or pagefile is exhausted, often from `-Xmx` set larger than free RAM, or 32-bit Java (a `-Xmx` above about 1.5G fails at start on 32-bit).

### 3.9 Wrong Java version
- JVM, when classes are too new for the runtime: `java.lang.UnsupportedClassVersionError: net/minecraft/client/main/Main has been compiled by a more recent version of the Java Runtime (class file version 65.0), this version of the Java Runtime only recognizes class file versions up to 61.0`. Regex: `class file version (\d+)\.\d+\), this version of the Java Runtime only recognizes class file versions up to (\d+)\.\d+`. Java 7 and older print: `Unsupported major.minor version 52.0`.
- Fabric uses builtin `java` and `minecraft` mods. MC gets `depends java >=<classVersion-44>` (from `MinecraftGameProvider`), giving lines like: `'Minecraft' (minecraft) 1.20.5 requires version 21 or later of 'OpenJDK 64-Bit Server VM' (java), but only the wrong version is present: 17!`. Mods can declare `"java": ">=21"` too.
- Forge/NeoForge on too-old Java: the JVM-level error above, thrown on `cpw/mods/bootstraplauncher/BootstrapLauncher`, `net/minecraftforge/bootstrap/...` or a mod class.
- Forge 1.12.2 / LaunchWrapper on Java 9+: `java.lang.ClassCastException: class jdk.internal.loader.ClassLoaders$AppClassLoader cannot be cast to class java.net.URLClassLoader`.
- A Forge/FML-specific "requires Java 17" message was **not found** in current source (see Uncertain).

**Class-file major → Java version** (Java = major − 44 for major ≥ 49):

| major | Java | major | Java | major | Java | major | Java |
|---|---|---|---|---|---|---|---|
| 45 | 1.0/1.1 | 52 | 8 | 59 | 15 | 66 | 22 |
| 46 | 1.2 | 53 | 9 | 60 | 16 | 67 | 23 |
| 47 | 1.3 | 54 | 10 | 61 | 17 | 68 | 24 |
| 48 | 1.4 | 55 | 11 | 62 | 18 | 69 | 25 |
| 49 | 5 | 56 | 12 | 63 | 19 | 70 | 26 |
| 50 | 6 | 57 | 13 | 64 | 20 | 71 | 27 |
| 51 | 7 | 58 | 14 | 65 | 21 | 72+ | 28+ |

MC requirements:
- ≤1.16.5: Java 8 (Forge 1.16.5 works up to 36.2.x on newer Java)
- 1.17.x: 16
- 1.18–1.20.4: 17
- 1.20.5–1.21.x: 21
- 26.1+: 25 (observed `Java Version: 25.0.2` on NeoForge 26.1.2; treat as likely)

### 3.10 Forge/NeoForge mod-loading failures, duplicates, events
- Translated issue text, Forge `fml.modloading.*` (NeoForge FML 4 / 1.21.0 still used `fml.modloading.*` keys; later FML uses `fml.modloadingissue.*`):
  - `<Name> (<id>) has failed to load correctly` + `\n<exception msg>`
  - `<Name> (<id>) has class loading errors`
  - Forge: `<Name> (<id>) encountered an error during the <phase> event phase`
  - NeoForge: `<Name> (<id>) encountered an error while dispatching the <EventClass> event`
  - `An uncaught parallel processing error has occurred.`
  - Broken files: `File <f> is not a valid mod file`, `... is a Fabric mod and cannot be loaded`, `... is a Quilt mod ...`, `... is for Minecraft Forge or an older version of NeoForge, and cannot be loaded`, `... is for an older version of Forge ...`, `... is an incompatible version of OptiFine`, `... is not a jar file`
  - NeoForge only: `A mixin config named <x> is provided by both <f1> and <f2>`
- **NeoForge `ModLoadingException.getMessage()`** (FML 4+):
```
net.neoforged.fml.ModLoadingException: Loading errors encountered:
\t- CoolMod (coolmod) has failed to load correctly
\t  java.lang.NullPointerException: ...
\t- Mod coolmod requires architectury 13.0.0 or above
\t  Currently, architectury is not installed
Loading warnings encountered:            (optional)
```
  Each issue starts with `\t- ` and continuation lines start with `\t  `. The `§x` color codes are stripped.
- **Duplicates**:
  - Forge (FG-ML9+): log `Found duplicate mods:` then `\tMod ID: 'jei' from mod files: jei-1.20.1-15.2.jar, jei-1.20.1-15.3.jar`. Exception message: `Duplicate mods found`. Libraries: `Found duplicate plugins or libraries:` with `\tLibrary: '<id>' from files: a.jar, b.jar`.
  - NeoForge: log `Found duplicate mods:` and issue text `Mod <id> is present in multiple files: a.jar, b.jar`. Also `Found duplicate plugins or libraries:`.
  - Both log benign same-id selection at INFO/DEBUG: Forge `Found N mods for first modid X, selecting most recent based on version data`; NeoForge `Found N mod files for modid X, selecting Y as it is the most recent based on version data:`.
  - FG-LEGACY: `net.minecraftforge.fml.common.DuplicateModsFoundException`.
  - Fabric: `Remove mod '<Name>' (<id>) <ver> (<path>).` solutions.
  - Quilt: `Duplicate mod:`.
- **EventBus** (Forge `net.minecraftforge.eventbus`, NeoForge `net.neoforged.bus`), logged at ERROR with marker `EVENTBUS`. The listener string usually contains the mod's class or package and sometimes `ASMEventHandler_N_<Class>_<method>`:
```
[...] [Render thread/ERROR] [net.minecraftforge.eventbus.EventBus/EVENTBUS]: Exception caught during firing event: Cannot invoke "..." because "..." is null
\tIndex: 2
\tListeners:
\t\t0: NORMAL
\t\t1: net.minecraftforge.eventbus.EventBus$$Lambda$4512/0x...@1a2b3c
\t\t2: ASM: com.example.cool.ClientEvents@5d6e handleRender(Lnet/minecraftforge/client/event/RenderGuiEvent;)V
java.lang.NullPointerException: ...
```
- "Mod X requires Y" lines: see §3.4 (Forge/NeoForge) and §3.5 (Fabric `requires ... of ...`).

---

## 4. `hs_err_pid<pid>.log` (written to the game/instance working dir; JIT crashes also produce `replay_pid<pid>.log`)
Strings verified in HotSpot `vmError.cpp` (jdk21u).
```
#
# A fatal error has been detected by the Java Runtime Environment:
#
#  EXCEPTION_ACCESS_VIOLATION (0xc0000005) at pc=0x00007ffb..., pid=12345, tid=6789     (Linux/mac: "#  SIGSEGV (0xb) at pc=...")
#
# JRE version: OpenJDK Runtime Environment Temurin-17.0.8+7 (17.0.8+7) (build 17.0.8+7)
# Java VM: OpenJDK 64-Bit Server VM Temurin-17.0.8+7 (17.0.8+7, mixed mode, sharing, tiered, compressed oops, g1 gc, windows-amd64)
# Problematic frame:
# C  [atio6axx.dll+0x1b3e4f]
#
# The crash happened outside the Java Virtual Machine in native code.
# See problematic frame for where to report the bug.
#
---------------  S U M M A R Y ------------
Command Line: ... (contains -Xmx, main class, instance paths)
Host: <CPU>, 16 cores, 31G,  Windows 11 , 64 bit Build 26100
Time: ... elapsed time: 123.4 seconds
---------------  T H R E A D  ---------------
Current thread (0x...):  JavaThread "Render thread" [_thread_in_native, id=6789, stack(...)]
Stack: [...],  sp=..., free space=...k
Native frames: (J=compiled Java code, j=interpreted, Vv=VM code, C=native code)
C  [atio6axx.dll+0x1b3e4f]
C  [lwjgl_opengl.dll+0x...]
Java frames: (J=compiled Java code, j=interpreted, Vv=VM code)
j  org.lwjgl.opengl.GL11C.nglDrawElements(IIJ)V+0
J 1234 c2 net.minecraft.client.renderer...  (code cache addr)
siginfo: EXCEPTION_ACCESS_VIOLATION (0xc0000005), reading address 0x0000000000000000   (Linux: "siginfo: si_signo: 11 (SIGSEGV), si_code: 1 (SEGV_MAPERR), si_addr: ...")
Registers: ...
---------------  P R O C E S S  ---------------
Heap: ... garbage-first heap total ..., used ...
---------------  S Y S T E M  ---------------
OS: ... / Memory: 4k page, system-wide physical 16310M (2017M free) / TotalPageFile size ... / vm_info: ...
END.
```
- **Native crash vs OOM**:
  - A native crash has the header `A fatal error has been detected` and a `# Problematic frame:`. The summary line names `Internal Error (...)` or the signal.
  - Native OOM has the header `There is insufficient memory for the Java Runtime Environment to continue.` and the summary `Out of Memory Error (<file>.cpp:<line>)`. It usually has **no** Problematic frame.
- **Frame type letter** (first char after `# `): `C` = native lib (a driver or another DLL), `V` = JVM itself (`jvm.dll`/`libjvm.so`; JVM bug or bad flags), `J`/`j` = Java code (JIT or interpreter), `v` = VM stub.
- **Graphics-driver frames** (classify as GPU driver crash; advise a driver update or rollback):
  - AMD: `atio6axx.dll`, `atioglxx.dll`, `amdxc64.dll`, `atiumd*`
  - NVIDIA: `nvoglv64.dll`, `nvoglv32.dll`, `nvd3dumx.dll`, `libnvidia-glcore.so`, `libGLX_nvidia.so`
  - Intel: `ig7icd64.dll`, `ig75icd64.dll`, `ig8icd64.dll`, `ig9icd64.dll`, `igxelpicd64.dll`, `ig*icd32.dll` (regex `ig\w*icd(32|64)\.dll`)
  - Mesa/Linux: `libGL.so.1`, `radeonsi_dri.so`, `iris_dri.so`, `libgallium*.so`
  - macOS: `libGL.dylib`, `GLEngine`, `AppleIntel*`
  - Also LWJGL glue (`lwjgl*.dll`, `liblwjgl*.so`, `glfw*.dll`)
  - Overlays/hooks: `RTSSHooks64.dll`, `DiscordHook64.dll`, `obs-vulkan64.dll`, `gameoverlayrenderer64.dll`

---

## 5. Mapping stack frames to jars / mod ids

General frame grammar: `\tat [<loader>/][<module>@<ver>/]<fqcn>.<method>(<File>.java:<line>|Native Method|Unknown Source) [~][<jar>[!/]:<implVersion>] [{<transformer audit>}]`. The leading `~` means "inexact" (log4j). `?` means unknown.

| Era | Frame shape (exact) | jar / modid extraction |
|---|---|---|
| FG-ML8 (1.13–1.16) | `at com.example.cool.Foo.bar(Foo.java:12) ~[coolmod:1.2.3] {re:classloading,pl:runtimedistcleaner:A}`; MC: `~[forge:?]` / `~[?:?]` | `[` **modid** `:` version `]` (the code source is a `modjar://modid` URL), no jar name |
| FG-ML9 (1.17–1.20.1) crash report | `at com.example.cool.Foo.bar(Foo.java:12) ~[coolmod-1.2.3.jar%23187!/:1.2.3] {re:mixin,pl:accesstransformer:B,re:classloading,pl:mixin:APP:coolmod.mixins.json:FooMixin,pl:mixin:A}`; MC: `~[client-1.20.1-20230612.114412-srg.jar%23302!/:?]` | jar = the text before `%23NNN!/`. URL-decode it (`%23` → `#`, `%20` → space, `%2b` → `+`). Suspected-Mod lines additionally use `TRANSFORMER/coolmod@1.2.3/` |
| FG-BOOT (1.20.2+) | `~[coolmod-1.2.3.jar!/:1.2.3] {re:classloading}`; Forge itself `~[forge-1.20.4-49.0.3-universal.jar!/:?]`; libs `~[modlauncher-10.1.2.jar:?]` | jar = before `!/` or `:` |
| NEO-ML (20.2–21.x) | `at TRANSFORMER/coolmod@1.2.3/com.example.cool.Foo.bar(Foo.java:12) ~[coolmod-1.2.3.jar%23236!/:1.2.3] {re:classloading}`; boot layer `at MC-BOOTSTRAP/fml_loader@4.0.6/...`, `at java.base/...` | **modid@version from the prefix** plus the jar from the brackets |
| NEO-11 (26.1+) | `at TRANSFORMER/coolmod@1.2.3/com.example.cool.Foo.bar(Foo.java:12) ~[coolmod-26.1.2-1.2.3.jar:?] {neoforge:access_transformer,neoforge:mixin[APP:coolmod.mixins.json:FooMixin from mod coolmod,...]}` | modid prefix, plain jar name, and mixin owners in `{}` |
| Fabric/Quilt crash-report | `at knot//com.example.cool.Foo.bar(Foo.java:12)`; MC: `at knot//net.minecraft.class_310.method_1514(class_310.java:2413)`; loader: `at net.fabricmc.loader.impl...` | **No jar info.** Map by package prefix: build an index of `package → modid` from each mod jar's class entries (`fabric.mod.json` gives the id) |
| Fabric/Quilt latest.log (log4j `%xEx`) | `at knot//com.example.cool.Foo.bar(Foo.java:12) ~[coolmod-1.2.3.jar:?]`; loader `~[fabric-loader-0.15.7.jar:?]` | jar from brackets when present |
| Forge latest.log | same as the crash report, but the `{...}` audit trail may be absent and the `TRANSFORMER/mod@ver/` prefix present | handle both |

Regexes:
- Frame: `^\s*at (?:(?<layer>TRANSFORMER|MC-BOOTSTRAP|PLUGIN|knot|app|[\w.$-]+)/(?:(?<mod>[\w.$-]+)@(?<modver>[^/]+)/)?)?(?<cls>[\w$.<>/]+)\.(?<meth>[\w$<>]+)\((?<src>[^)]*)\)(?: ~?\[(?<jar>[^\]]*?)(?:%23\d+)?(?:!/)?:(?<jv>[^\]]*)\])?(?: \{(?<audit>[^}]*)\})?`. The `knot//` form has an empty module, hence the doubled slash.
- Mixin owners in the audit: Forge `pl:mixin:APP:(?<cfg>[\w.-]+\.json):(?<mixin>[\w.$]+)`; NEO-11 `APP:(?<cfg>[\w.-]+\.json):(?<mixin>[\w.$]+) from mod (?<modid>[\w-]+)`.
- Ignore system and loader layers when blaming: `java.base/`, `jdk.*`, `MC-BOOTSTRAP/`, `cpw.mods.*`, `net.minecraftforge.fml.*`, `net.neoforged.fml.*`, `net.fabricmc.loader.*`, `org.quiltmc.loader.*`, `org.spongepowered.asm.*`, and frames whose module is `minecraft@`, `neoforge@` or `forge@`.
- Mixin-injected handler frames inside MC classes: `net.minecraft.X.handler$abc000$<modid>$origName(...)`, `redirect$`, `modify$`, `wrapOperation$`, `localvar$`, `md<hex>$`. **In Fabric/Quilt the segment after the hash is the modid.** Forge/older Mixin omits it.
- Final fallback (all loaders): build a `package-prefix → (modid, jar)` index from the `mods/` folder and use the longest prefix match. This is what Forge's CrashReportAnalyser does internally with `PACKAGE_MOD_CACHE`.

---

## Anchor substring list
```
---- Minecraft Crash Report ----
A detailed walkthrough of the error
-- Head --
-- System Details --
Description: 
Suspected Mod: 
Suspected Mods: 
Issue tracker URL: 
Mod File: 
Mod file: 
Failure message: 
Exception message: 
-- MOD 
-- Mod loading issue
Mod Loading has failed
Mod loading has failed
Mod loading error has occurred
Mod loading failures have occurred
Mod List: 
Fabric Mods: 
Crash report saved to
#@!@# Game crashed!
Preparing crash report with UUID
Caused by: 
Exception in thread "main"
---- Quilt Loader
---- Crashed! ----
-- Mod Table --
Quilt Loader Version: 
Mixin apply failed
Mixin apply for mod 
Mixin prepare failed
FAILED during APPLY
FAILED during PREPARE
MixinTransformerError
MixinApplyError
MixinPrepareError
InvalidInjectionException
InvalidMixinException
InjectionError
Critical injection failure
An unexpected critical error was encountered
Mixin transformation of 
was not located in the target class
Error encountered whilst initialising mixin config
java.lang.module.ResolutionException
LayerInstantiationException
export package 
reads more than one module named
reads another module named
in more than one module
Missing or unsupported mandatory dependencies
Unsupported installed optional dependencies
\tMod ID: '
Detected a mod dependency cycle
Mod Sorting failed
Loading errors encountered
has failed to load correctly
has class loading errors
encountered an error
is present in multiple files
Found duplicate mods
Duplicate mods found
Found duplicate plugins or libraries
DuplicateModsFoundException
is not a valid mod file
and cannot be loaded
Attempted to load class
for invalid dist
Exception caught during firing event
Incompatible mods found!
Some of your mods are incompatible
Mod resolution encountered an incompatible mod set
A potential solution has been determined
More details:
, which is missing!
but only the wrong version
which is disabled for this environment
can't be loaded due to other constraints
is incompatible with
Could not execute entrypoint stage
Exception while loading entries for entrypoint
A critical error occurred
transitively requires
Duplicate mod: 
Unknown mod: 
NoClassDefFoundError
ClassNotFoundException
NoSuchMethodError
NoSuchFieldError
AbstractMethodError
IncompatibleClassChangeError
UnsupportedClassVersionError
class file version
Unsupported major.minor version
cannot be cast to class java.net.URLClassLoader
java.lang.OutOfMemoryError
Java heap space
GC overhead limit exceeded
Metaspace
Direct buffer memory
unable to create native thread
A fatal error has been detected by the Java Runtime Environment
There is insufficient memory for the Java Runtime Environment
Native memory allocation
# Problematic frame:
EXCEPTION_ACCESS_VIOLATION
SIGSEGV
atio6axx.dll
atioglxx.dll
nvoglv64.dll
nvoglv32.dll
icd64.dll
libGL.so
_dri.so
libnvidia-glcore
```

## Uncertain
1. **"Module X reads package Y from both A and B"** was not found in JDK 11/17/21 `Resolver.java`. The real strings are `Modules A and B export package P to module C` and `Module A contains package P, module B exports package P to A`. The phrase may come from very old JDK 9/10 builds or be a misremembering; keep it as a soft anchor only.
2. A Forge/FML text saying "requires Java 17", or NeoForge FML Java-version issue keys, were not found in current lang files. Wrong-Java detection should rely on `UnsupportedClassVersionError` and the Fabric `java` builtin dependency.
3. The old Fabric (≈0.11–0.13) wording `Mod resolution encountered an incompatible mod set!` / `Unmet dependency listing:` is from memory and not re-verified in source. The current wording was verified.
4. Fabric/Quilt `latest.log` frames: the exact bracket for jar-in-jar mods (whether it shows the nested jar name, an outer jar or `?`) and for the MC jar name was not verified.
5. Whether the Forge FG-ML9 **latest.log** (as opposed to the crash report) prints the `{audit}` suffix and the `TRANSFORMER/` prefix varies by version and was not verified per version.
6. Quilt in-game crash reports: the key name (`Quilt Mods:` versus reusing `Fabric Mods:`) was not verified.
7. The FG-ML8 bracket form `~[modid:version]` comes from memory of 1.16 reports and was not re-fetched. The FG-LEGACY (1.12.2) FML state table (`| State | ID | Version | Source | Signature |`, states `LCHIJ`/`E`) also comes from memory.
8. The vanilla `#@!@# Game crashed! Crash report saved to: #@!@#` marker and the vanilla `Out of memory` log line come from memory. Their exact form may differ in 1.21+/26.x.
9. MC 26.1 requiring Java 25 is inferred from one NeoForge 26.1.2 report running Java 25.0.2. Class-file 70 = Java 26 and 71 = Java 27 follow the +44 rule.
10. The Mixin handler-name modid segment (`handler$xxx000$<modid>$...`) is confirmed for the Fabric fork. Its presence in Forge/NeoForge Mixin (0.8.5+/MixinExtras) is unverified.
11. The FML key-prefix switch `fml.modloading.*` → `fml.modloadingissue.*` happened somewhere between FML 4.0.6 (NeoForge 21.0.10) and FML 11. The exact version is unknown.

## Sources
- Forge: https://github.com/MinecraftForge/MinecraftForge/blob/1.20.1/src/main/java/net/minecraftforge/logging/CrashReportAnalyser.java , .../logging/CrashReportExtender.java , .../patches/minecraft/net/minecraft/CrashReport.java.patch , .../fmlloader/src/main/java/net/minecraftforge/fml/loading/ModSorter.java , .../UniqueModListBuilder.java , .../src/main/resources/assets/forge/lang/en_us.json , .../fmlloader/src/main/resources/log4j2.xml
- NeoForge/FML: https://github.com/neoforged/NeoForge/blob/26.1.x/src/main/java/net/neoforged/neoforge/logging/CrashReportExtender.java , https://github.com/neoforged/FancyModLoader/blob/main/loader/src/main/java/net/neoforged/fml/loading/ModSorter.java , .../fml/ModLoadingException.java , .../loading/UniqueModListBuilder.java , .../resources/lang/en_us.json
- EventBus: https://github.com/MinecraftForge/EventBus/blob/6.0/src/main/java/net/minecraftforge/eventbus/EventBusErrorMessage.java , https://github.com/neoforged/Bus/blob/main/src/main/java/net/neoforged/bus/EventBusErrorMessage.java
- Fabric: https://github.com/FabricMC/fabric-loader/blob/master/src/main/resources/net/fabricmc/loader/Messages.properties , .../impl/discovery/ResultAnalyzer.java , .../ModResolver.java , .../impl/FabricLoaderImpl.java , .../impl/gui/FabricGuiEntry.java , .../launch/knot/KnotClassDelegate.java , .../minecraft/.../MinecraftGameProvider.java , .../util/log/ConsoleLogHandler.java
- Quilt: https://github.com/QuiltMC/quilt-loader/blob/develop/src/main/resources/lang/quilt_loader.properties , .../impl/report/QuiltReport.java , .../impl/plugin/QuiltPluginManagerImpl.java , .../impl/plugin/SolverErrorHelper.java
- Mixin: https://github.com/SpongePowered/Mixin (MixinProcessor, InjectionInfo, MixinPreProcessorStandard, ReferenceMapper), https://github.com/FabricMC/Mixin (MixinInfo, MixinProcessor)
- JDK/HotSpot: https://github.com/openjdk/jdk21u/blob/master/src/java.base/share/classes/java/lang/module/Resolver.java , .../jdk/internal/loader/Loader.java , .../src/hotspot/share/utilities/vmError.cpp
- Real reports: https://gist.github.com/NielsPilgaard/28f2fabee7f8c7c23c9d36faa8646e65 (NeoForge 21.0) · https://gist.github.com/McKitten/62582ae79b6fd40e2c0615c277e5dc6d and https://gist.github.com/McKitten/b70648375c813ddcfb6b7a0c170f0379 (NeoForge 26.1) · https://github.com/Cadiboo/NoCubes/issues/127 (Forge 49) · https://github.com/xandergos/terrain-diffusion-mc/issues/259 (Fabric 1.21.11) · https://github.com/QuiltMC/quilt-loader/issues/415 · https://github.com/RealRTTV/malum-quilt/issues/24 · https://github.com/ModificationStation/StationAPI/issues/101 (Fabric mixin)
