import { describe, expect, it } from 'vitest';
import { analyze, codes, culpritIds, jar, only, text } from './helpers';

const fabric = (file: string, id: string, name: string, packages: string[] = [], mixins: string[] = []) =>
  jar({ file, mods: [[id, name]], packages, mixins, loader: 'fabric' });

const INCOMPATIBLE = text(
  '[12:00:00] [main/INFO]: Loading Minecraft 1.21.1 with Fabric Loader 0.16.5',
  '[12:00:01] [main/ERROR]: A critical error occurred',
  'net.fabricmc.loader.impl.FormattedException: Some of your mods are incompatible with the game or each other!',
  'A potential solution has been determined, this may resolve your problem:',
  '\t - Install fabric-api, any version.',
  "\t - Replace mod 'Sodium Extra' (sodium-extra) 0.4.0 with version 0.6.0 or later.",
  "\t - Remove mod 'Cool Mod' (coolmod) 1.0.0 (C:\\Users\\alex\\AppData\\Roaming\\.minecraft\\mods\\coolmod-1.0.0-copy.jar).",
  'More details:',
  "\t - Mod 'Cool Mod' (coolmod) 1.0.0 requires any version of fabric-api, which is missing!",
  "\t - Mod 'Sodium Extra' (sodium-extra) 0.4.0 requires version 0.5.0 or later of 'Sodium' (sodium), but only the wrong version is present: 0.6.0!",
  "\t - Mod 'Old Thing' (oldthing) 2.0 requires version 1.20.1 of 'Minecraft' (minecraft), but only the wrong version is present: 1.21.1!",
  '\tat net.fabricmc.loader.impl.FormattedException.ofLocalized(FormattedException.java:51) ~[fabric-loader-0.16.5.jar:?]',
  '\tat net.fabricmc.loader.impl.FabricLoaderImpl.load(FabricLoaderImpl.java:202) ~[fabric-loader-0.16.5.jar:?]',
);

describe('Fabric incompatible mod set', () => {
  const jars = [
    fabric('coolmod-1.0.0.jar', 'coolmod', 'Cool Mod'),
    fabric('coolmod-1.0.0-copy.jar', 'coolmod', 'Cool Mod'),
    fabric('sodium-extra-0.4.0.jar', 'sodium-extra', 'Sodium Extra'),
    fabric('sodium-fabric-0.6.0.jar', 'sodium', 'Sodium'),
    fabric('oldthing-2.0.jar', 'oldthing', 'Old Thing'),
  ];

  it('produces one finding per problem with the loader’s own solutions', () => {
    const findings = analyze(INCOMPATIBLE, 'latestLog', jars);
    expect(codes(findings).every((c) => c === 'C-FABRIC-INCOMPAT')).toBe(true);
    expect(findings).toHaveLength(4);
    expect(findings.every((f) => f.severity === 'error')).toBe(true);
    const byTitle = (s: string) => findings.find((f) => f.title.includes(s));

    const missing = byTitle('fabric-api');
    expect(missing?.title).toBe('Cool Mod (coolmod) needs fabric-api, which is missing');
    expect(missing?.fixes[0]).toEqual({ kind: 'manual', steps: ['Install fabric-api, any version.', 'Or remove Cool Mod (coolmod).'] });

    const wrong = byTitle('Sodium Extra');
    expect(culpritIds(wrong)).toEqual(['mods/sodium-extra-0.4.0.jar', 'mods/sodium-fabric-0.6.0.jar']);
    expect(wrong?.fixes[0]).toEqual({ kind: 'manual', steps: ['Replace Sodium Extra 0.4.0 with version 0.6.0 or later.'] });

    const mc = byTitle('Old Thing');
    expect(mc?.title).toContain('built for Minecraft version 1.20.1');
    expect(mc?.fixes[0]).toEqual({ kind: 'disable', jarId: 'mods/oldthing-2.0.jar' });

    const dup = byTitle('more than once');
    expect(dup?.fixes).toEqual([{ kind: 'disable', jarId: 'mods/coolmod-1.0.0-copy.jar' }]);
  });

  it('falls back to a generic finding for the bare GUI title', () => {
    const findings = analyze(text('[12:00:01] [main/ERROR]: Incompatible mods found!'), 'latestLog');
    expect(codes(findings)).toEqual(['C-FABRIC-INCOMPAT']);
    expect(findings[0]?.culprits).toEqual([]);
  });

  it('routes the builtin java dependency to C-JAVA-VERSION', () => {
    const body = text(
      '[12:00:01] [main/ERROR]: A critical error occurred',
      'net.fabricmc.loader.impl.FormattedException: Some of your mods are incompatible with the game or each other!',
      'More details:',
      "\t - 'Minecraft' (minecraft) 1.21.1 requires version 21 or later of 'OpenJDK 64-Bit Server VM' (java), but only the wrong version is present: 17!",
    );
    const findings = analyze(body, 'latestLog', []);
    expect(codes(findings)).toEqual(['C-JAVA-VERSION']);
    expect(findings[0]?.title).toBe('The game needs Java 21 but runs on Java 17');
    expect(findings[0]?.fixes[0]?.kind).toBe('manual');
  });
});

describe('Fabric mixin failures (FabricMC fork wording)', () => {
  const coolmod = fabric('coolmod-1.0.0.jar', 'coolmod', 'Cool Mod', ['com.example.cool'], ['coolmod.mixins.json']);
  const body = text(
    '[21:44:57] [main/INFO]: Loading Minecraft 1.21.1 with Fabric Loader 0.16.5',
    "[21:44:58] [main/ERROR]: Mixin apply for mod coolmod failed coolmod.mixins.json:LoginMixin from mod coolmod -> net.minecraft.class_118: org.spongepowered.asm.mixin.injection.throwables.InvalidInjectionException Critical injection failure: @ModifyConstant annotation on cool$limit could not find any targets matching 'read' in net.minecraft.class_118. Using refmap coolmod-refmap.json [PREINJECT Applicator Phase -> coolmod.mixins.json:LoginMixin from mod coolmod -> Prepare Injections -> -> constant$zza000$coolmod$limit(I)I -> Parse]",
    "org.spongepowered.asm.mixin.injection.throwables.InvalidInjectionException: Critical injection failure: @ModifyConstant annotation on cool$limit could not find any targets matching 'read' in net.minecraft.class_118. Using refmap coolmod-refmap.json [PREINJECT Applicator Phase -> coolmod.mixins.json:LoginMixin from mod coolmod -> Prepare Injections -> -> constant$zza000$coolmod$limit(I)I -> Parse]",
    '\tat org.spongepowered.asm.mixin.injection.struct.InjectionInfo.validateTargets(InjectionInfo.java:531) ~[sponge-mixin-0.15.3+mixin.0.8.7.jar:0.15.3+mixin.0.8.7]',
    'Exception in thread "main" java.lang.RuntimeException: Mixin transformation of net.minecraft.class_118 failed',
    '\tat net.fabricmc.loader.impl.launch.knot.KnotClassDelegate.getPostMixinClassByteArray(KnotClassDelegate.java:427) ~[fabric-loader-0.16.5.jar:?]',
    'Caused by: org.spongepowered.asm.mixin.transformer.throwables.MixinTransformerError: An unexpected critical error was encountered',
    '\t... 8 more',
    'Caused by: org.spongepowered.asm.mixin.throwables.MixinApplyError: Mixin [coolmod.mixins.json:LoginMixin from mod coolmod] from phase [DEFAULT] in config [coolmod.mixins.json] FAILED during APPLY',
    '\t... 9 more',
  );

  it('reports one C-MIXIN for the config, mapped to the jar', () => {
    const findings = analyze(body, 'latestLog', [coolmod]);
    expect(codes(findings)).toEqual(['C-MIXIN']);
    const f = findings[0];
    expect(f?.severity).toBe('error');
    expect(culpritIds(f)).toEqual(['mods/coolmod-1.0.0.jar']);
    expect(f?.title).toBe('Mixin LoginMixin from Cool Mod failed on class_118');
    expect(f?.explanation).toContain('coolmod.mixins.json');
  });

  it('uses the "from mod" id when the config is not indexed, and the config name when there is no index', () => {
    const noConfig = fabric('coolmod-1.0.0.jar', 'coolmod', 'Cool Mod');
    expect(culpritIds(analyze(body, 'latestLog', [noConfig])[0])).toEqual(['mods/coolmod-1.0.0.jar']);
    const [f] = analyze(body, 'latestLog');
    expect(f?.culprits).toEqual([]);
    expect(f?.title).toContain('coolmod');
  });

  it('ignores a non-required mixin failure logged at WARN', () => {
    const warn = text(
      '[21:44:58] [main/WARN]: Mixin apply for mod coolmod failed coolmod.mixins.json:compat.OptionalMixin from mod coolmod -> net.minecraft.class_118: org.spongepowered.asm.mixin.injection.throwables.InvalidInjectionException Critical injection failure',
    );
    expect(analyze(warn, 'latestLog', [coolmod])).toEqual([]);
  });

  it('is only a warning when the game did not crash', () => {
    const noCrash = text(
      "[21:44:58] [main/ERROR]: Mixin apply for mod coolmod failed coolmod.mixins.json:LoginMixin from mod coolmod -> net.minecraft.class_118: org.spongepowered.asm.mixin.injection.throwables.InvalidInjectionException Critical injection failure",
      '[21:45:10] [Render thread/INFO]: Stopping!',
    );
    expect(analyze(noCrash, 'latestLog', [coolmod]).map((f) => f.severity)).toEqual(['warning']);
  });
});

describe('Fabric crash report frames (knot//)', () => {
  const coolmap = fabric('coolmap-3.2.jar', 'coolmap', 'Cool Map', ['com.example.coolmap', 'com.example.coolmap.render']);
  const report = (frames: string[]) =>
    text(
      '---- Minecraft Crash Report ----',
      '// Surprise! Haha. Well, this is awkward.',
      '',
      'Time: 2026-10-30 12:00:00',
      'Description: Rendering screen',
      '',
      'java.lang.NullPointerException: Cannot read field "value" because "this.cache" is null',
      ...frames,
      '',
      '',
      'A detailed walkthrough of the error, its code path and all known details is as follows:',
    );

  it('maps a knot frame by package prefix', () => {
    const [f] = analyze(
      report([
        '\tat knot//com.example.coolmap.render.MapRenderer.draw(MapRenderer.java:77)',
        '\tat knot//net.minecraft.class_329.method_1753(class_329.java:200)',
      ]),
      'crashReport',
      [coolmap],
    );
    expect(f?.code).toBe('C-ROOT-CAUSE');
    expect(culpritIds(f)).toEqual(['mods/coolmap-3.2.jar']);
  });

  it('maps a mixin handler frame inside a Minecraft class by the embedded mod id', () => {
    const [f] = analyze(
      report([
        '\tat knot//net.minecraft.class_329.handler$zza000$coolmap$onRender(class_329.java:1500)',
        '\tat knot//net.minecraft.class_329.method_1753(class_329.java:200)',
      ]),
      'crashReport',
      [coolmap],
    );
    expect(culpritIds(f)).toEqual(['mods/coolmap-3.2.jar']);
    const log = f?.evidence.find((e) => e.kind === 'log');
    expect(log?.kind === 'log' && log.frames).toEqual([{ line: 8, jarId: 'mods/coolmap-3.2.jar' }]);
  });

  it('maps a frame in a jar-in-jar library to its top-level jar', () => {
    const parent = fabric('bigmod-1.0.jar', 'bigmod', 'Big Mod', ['com.example.big']);
    const lib = jar({ file: 'tinylib-0.3.jar', mods: [['tinylib']], packages: ['dev.tiny.lib'], parent: parent.id, loader: 'fabric' });
    const [f] = analyze(report(['\tat knot//dev.tiny.lib.Cache.get(Cache.java:3)']), 'crashReport', [parent, lib]);
    expect(culpritIds(f)).toEqual(['mods/bigmod-1.0.jar']);
    expect(f?.fixes[0]).toEqual({ kind: 'disable', jarId: 'mods/bigmod-1.0.jar' });
  });

  it('reports an entrypoint failure as the named mod', () => {
    const coolmod = fabric('coolmod-1.0.0.jar', 'coolmod', 'Cool Mod', ['com.example.cool']);
    const body = text(
      '[12:00:01] [main/ERROR]: A critical error occurred',
      "java.lang.RuntimeException: Could not execute entrypoint stage 'main' due to errors, provided by 'coolmod' at 'com.example.cool.CoolMod'!",
      '\tat net.fabricmc.loader.impl.FabricLoaderImpl.lambda$invokeEntrypoints$2(FabricLoaderImpl.java:403) ~[fabric-loader-0.16.5.jar:?]',
      'Caused by: java.lang.IllegalArgumentException: bad config value',
      '\tat com.example.cool.Config.load(Config.java:9) ~[coolmod-1.0.0.jar:?]',
    );
    const findings = analyze(body, 'latestLog', [coolmod]);
    expect(codes(findings)).toEqual(['C-SUSPECTED']);
    expect(findings[0]?.title).toBe("coolmod crashed while starting (main entrypoint)");
    expect(culpritIds(findings[0])).toEqual(['mods/coolmod-1.0.0.jar']);
    expect(findings[0]?.explanation).toContain('bad config value');
  });
});

describe('Fabric NoClassDefFoundError', () => {
  const coolmod = fabric('coolmod-1.0.0.jar', 'coolmod', 'Cool Mod', ['com.example.cool.config']);
  const body = text(
    '[12:00:01] [main/ERROR]: A critical error occurred',
    'java.lang.NoClassDefFoundError: me/shedaniel/clothconfig2/api/ConfigBuilder',
    '\tat knot//com.example.cool.config.ModMenuIntegration.screen(ModMenuIntegration.java:14) ~[coolmod-1.0.0.jar:?]',
    '\tat net.fabricmc.loader.impl.entrypoint.EntrypointUtils.invoke0(EntrypointUtils.java:47) ~[fabric-loader-0.16.5.jar:?]',
    'Caused by: java.lang.ClassNotFoundException: me.shedaniel.clothconfig2.api.ConfigBuilder',
    '\tat net.fabricmc.loader.impl.launch.knot.KnotClassLoader.loadClass(KnotClassLoader.java:226) ~[fabric-loader-0.16.5.jar:?]',
    '\t... 3 more',
  );

  it('flags a missing dependency and names the requester', () => {
    const findings = only(analyze(body, 'latestLog', [coolmod]), 'C-NOCLASSDEF');
    expect(findings).toHaveLength(1);
    const f = findings[0];
    expect(f?.severity).toBe('error');
    expect(f?.title).toBe('Cool Mod (coolmod-1.0.0.jar) needs ConfigBuilder, which is not installed (likely Cloth Config API (cloth-config))');
    expect(culpritIds(f)).toEqual(['mods/coolmod-1.0.0.jar']);
    expect(f?.fixes[0]).toEqual({ kind: 'manual', steps: ['Install Cloth Config API (cloth-config) for this Minecraft version and loader.'] });
  });

  it('blames a version mismatch when the package exists in an installed jar', () => {
    const cloth = fabric('cloth-config-11.0.jar', 'cloth-config', 'Cloth Config', ['me.shedaniel.clothconfig2.api']);
    const [f] = only(analyze(body, 'latestLog', [coolmod, cloth]), 'C-NOCLASSDEF');
    expect(f?.title).toBe('Cool Mod (coolmod-1.0.0.jar) needs ConfigBuilder, which Cloth Config (cloth-config-11.0.jar) does not have');
    expect(culpritIds(f)).toEqual(['mods/cloth-config-11.0.jar', 'mods/coolmod-1.0.0.jar']);
  });
});

describe('Fabric negatives', () => {
  it('a clean Fabric launch yields nothing', () => {
    const body = text(
      '[12:00:00] [main/INFO]: Loading Minecraft 1.21.1 with Fabric Loader 0.16.5',
      '[12:00:00] [main/INFO]: Loading 3 mods:',
      '\t- coolmod 1.0.0',
      '\t- fabricloader 0.16.5',
      '\t- minecraft 1.21.1',
      "[12:00:01] [main/WARN]: Mod 'Cool Mod' (coolmod) 1.0.0 recommends any version of modmenu, which is missing!",
      '[12:00:02] [Render thread/INFO]: Backend library: LWJGL version 3.3.3',
      '[12:00:30] [Render thread/INFO]: Stopping!',
    );
    expect(analyze(body, 'latestLog', [fabric('coolmod-1.0.0.jar', 'coolmod', 'Cool Mod')])).toEqual([]);
  });
});
