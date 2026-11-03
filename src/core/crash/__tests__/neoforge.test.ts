import { describe, expect, it } from 'vitest';
import { analyze, codes, culpritIds, culpritLines, jar, only, text } from './helpers';

const coolmod = jar({
  file: 'coolmod-1.0.0.jar',
  mods: [['coolmod', 'CoolMod']],
  packages: ['com.example.cool', 'com.example.cool.client'],
  mixins: ['coolmod.mixins.json'],
  loader: 'neoforge',
});

/** NeoForge 20.4 / 21.0 (before PR #1479): `-- MOD x --` sections with raw translation keys. */
const NEO_OLD = text(
  '---- Minecraft Crash Report ----',
  '// Embeddium instance tainted',
  '',
  'Time: 2026-10-30 18:00:00',
  'Description: Mod loading error has occurred',
  '',
  'java.lang.Exception: Mod Loading has failed',
  '\tat net.neoforged.neoforge.logging.CrashReportExtender.dumpModLoadingCrashReport(CrashReportExtender.java:58) ~[neoforge-21.0.10-beta-universal.jar%23236!/:?] {re:classloading}',
  '',
  '',
  'A detailed walkthrough of the error, its code path and all known details is as follows:',
  '---------------------------------------------------------------------------------------',
  '',
  '-- MOD coolmod --',
  'Details:',
  '\tCaused by 0: java.lang.IllegalStateException: Registry is frozen',
  '\t\tat TRANSFORMER/coolmod@1.0.0/com.example.cool.Registration.register(Registration.java:20) ~[coolmod-1.0.0.jar%23240!/:1.0.0] {re:classloading}',
  '\tMod File: /C:/Users/alex/curseforge/Instances/Pack/mods/coolmod-1.0.0.jar',
  '\tFailure message: fml.modloading.errorduringevent',
  '\tFailure message arg 1: net.neoforged.neoforge.registries.RegisterEvent',
  '\tMod Version: 1.0.0',
  '\tMod Issue URL: NOT PROVIDED',
  '\tException message: java.lang.IllegalStateException: Registry is frozen',
  'Stacktrace:',
  '\tat TRANSFORMER/coolmod@1.0.0/com.example.cool.Registration.register(Registration.java:20) ~[coolmod-1.0.0.jar%23240!/:1.0.0] {re:classloading}',
  '\tat MC-BOOTSTRAP/net.neoforged.bus/net.neoforged.bus.EventBus.post(EventBus.java:350) ~[bus-8.0.1.jar%23111!/:?] {}',
  '',
  '-- System Details --',
  'Details:',
  '\tMinecraft Version: 1.21',
);

/** NeoForge 21.1+ (PR #1479 and later): `-- Mod loading issue for: x --`. */
const NEO_121 = text(
  '---- Minecraft Crash Report ----',
  '// Hey, that tickles! Hehehe!',
  '',
  'Time: 2026-10-30 18:30:00',
  'Description: Mod loading failures have occurred; consult the issue messages for more details',
  '',
  'net.neoforged.neoforge.logging.CrashReportExtender$ModLoadingCrashException: Mod loading has failed',
  '',
  '',
  'A detailed walkthrough of the error, its code path and all known details is as follows:',
  '---------------------------------------------------------------------------------------',
  '',
  '-- Mod loading issue for: coolmod --',
  'Details:',
  '\tCaused by 0: java.lang.ExceptionInInitializerError: null',
  '\t\tat TRANSFORMER/coolmod@1.0.0/com.example.cool.CoolMod.<init>(CoolMod.java:12) ~[coolmod-1.0.0.jar%23236!/:1.0.0] {re:classloading}',
  '\tMod file: /home/u/server/mods/coolmod-1.0.0.jar',
  '\tFailure message: CoolMod (coolmod) encountered an error while dispatching the net.neoforged.neoforge.registries.RegisterEvent event',
  '\t\tjava.lang.ExceptionInInitializerError: null',
  '\tMod version: 1.0.0',
  '\tMod issues URL: <No issues URL found>',
  '\tException message: java.lang.IllegalStateException: Duplicate registration coolmod:gem',
  'Stacktrace:',
  '\tat TRANSFORMER/coolmod@1.0.0/com.example.cool.Items.<clinit>(Items.java:30) ~[coolmod-1.0.0.jar%23236!/:1.0.0] {re:classloading}',
  '',
  '-- System Details --',
  'Details:',
  '\tMinecraft Version: 1.21.1',
);

/** NeoForge 26.1 (FML 11): plain jar names, `neoforge:mixin[…]` audit, no ModLauncher. */
const NEO_261 = text(
  '---- Minecraft Crash Report ----',
  '// Ouch. That hurt :(',
  '',
  'Time: 2026-10-30 21:00:00',
  'Description: Ticking player',
  '',
  'java.lang.NullPointerException: Cannot invoke "Object.hashCode()" because "key" is null',
  '\tat java.base/java.util.HashMap.hash(HashMap.java:338)',
  '\tat TRANSFORMER/minecraft@26.1.2/net.minecraft.server.level.ServerPlayer.tick(ServerPlayer.java:700) ~[minecraft-26.1.2.jar:?] {neoforge:access_transformer,neoforge:mixin[APP:coolmod.mixins.json:PlayerMixin from mod coolmod]}',
  '\tat TRANSFORMER/coolmod@1.2.3/com.example.cool.client.Tracker.update(Tracker.java:12) ~[coolmod-26.1.2-1.2.3.jar:?] {neoforge:access_transformer}',
  '',
  '',
  'A detailed walkthrough of the error, its code path and all known details is as follows:',
  '',
  '-- System Details --',
  'Details:',
  '\tMinecraft Version: 26.1.2',
  '\tClass Processors:',
  '\t\t02.15%: neoforge:access_transformer',
  '\tFML: 11.0.13',
  '\tNeoForge: 26.1.2.48-beta',
);

describe('NeoForge mods.toml era (-- MOD x --)', () => {
  it('reports the failed mod and suppresses the root cause', () => {
    const findings = analyze(NEO_OLD, 'crashReport', [coolmod]);
    expect(codes(findings)).toEqual(['C-SUSPECTED']);
    const f = findings[0];
    expect(culpritIds(f)).toEqual(['mods/coolmod-1.0.0.jar']);
    expect(f?.explanation).toContain('Registry is frozen');
    const log = f?.evidence.find((e) => e.kind === 'log');
    expect(log?.kind === 'log' && log.frames.map((fr) => fr.jarId)).toEqual(['mods/coolmod-1.0.0.jar']);
  });
});

describe('NeoForge 1.21 (-- Mod loading issue for:)', () => {
  it('reports the failed mod with its failure and exception message', () => {
    const findings = analyze(NEO_121, 'crashReport', [coolmod]);
    expect(codes(findings)).toEqual(['C-SUSPECTED']);
    const f = findings[0];
    expect(f?.title).toBe('coolmod failed to load');
    expect(f?.explanation).toContain('encountered an error while dispatching');
    expect(f?.explanation).toContain('Duplicate registration coolmod:gem');
    expect(f?.fixes).toEqual([{ kind: 'disable', jarId: 'mods/coolmod-1.0.0.jar' }]);
    expect(culpritLines(f)).toEqual(expect.arrayContaining([13, 17, 18, 22]));
  });

  it('reads "Loading errors encountered" items in latest.log', () => {
    const body = text(
      '[30Oct2026 18:30:00.000] [main/FATAL] [net.neoforged.fml.ModLoader/]: Mod loading has failed',
      'net.neoforged.fml.ModLoadingException: Loading errors encountered:',
      '\t- CoolMod (coolmod) has failed to load correctly',
      '\t  java.lang.NullPointerException: Cannot invoke "String.length()" because "name" is null',
    );
    const [f] = only(analyze(body, 'latestLog', [coolmod]), 'C-SUSPECTED');
    expect(f?.severity).toBe('error');
    expect(culpritIds(f)).toEqual(['mods/coolmod-1.0.0.jar']);
    expect(f?.explanation).toContain('NullPointerException');
  });
});

describe('NeoForge 26.1 (FML 11)', () => {
  const cool261 = jar({
    file: 'coolmod-26.1.2-1.2.3.jar',
    mods: [['coolmod', 'CoolMod']],
    packages: ['com.example.cool.client'],
    mixins: ['coolmod.mixins.json'],
    loader: 'neoforge',
  });

  it('skips JDK and minecraft@ frames and blames the TRANSFORMER/modid frame', () => {
    const findings = analyze(NEO_261, 'crashReport', [cool261]);
    expect(codes(findings)).toEqual(['C-ROOT-CAUSE']);
    expect(culpritIds(findings[0])).toEqual(['mods/coolmod-26.1.2-1.2.3.jar']);
    expect(findings[0]?.title).toContain('NullPointerException');
  });

  it('maps a mixin failure through byMixinConfig', () => {
    const body = text(
      '[02Nov2026 10:00:00.000] [main/INFO] [net.neoforged.fml.loading.FMLLoader/CORE]: Starting FancyModLoader version 11.0.13 (CLIENT in PROD)',
      "[02Nov2026 10:00:01.000] [main/ERROR] [mixin/]: Mixin apply failed coolmod.mixins.json:client.ScreenMixin -> net.minecraft.client.gui.screens.TitleScreen: org.spongepowered.asm.mixin.injection.throwables.InvalidInjectionException Critical injection failure: @Inject annotation on onInit could not find any targets matching 'init' in net.minecraft.client.gui.screens.TitleScreen. Using refmap coolmod.refmap.json [PREINJECT Applicator Phase -> coolmod.mixins.json:client.ScreenMixin -> Prepare Injections -> -> handler$abc000$onInit(Lorg/spongepowered/asm/mixin/injection/callback/CallbackInfo;)V -> Parse]",
      'org.spongepowered.asm.mixin.transformer.throwables.MixinTransformerError: An unexpected critical error was encountered',
      '\tat MC-BOOTSTRAP/org.spongepowered.mixin/org.spongepowered.asm.mixin.transformer.MixinProcessor.applyMixins(MixinProcessor.java:392)',
      'Caused by: org.spongepowered.asm.mixin.throwables.MixinApplyError: Mixin [coolmod.mixins.json:client.ScreenMixin] from phase [DEFAULT] in config [coolmod.mixins.json] FAILED during APPLY',
      '\t... 20 more',
      '[02Nov2026 10:00:02.000] [main/FATAL] [net.neoforged.fml.startup.FatalErrorReporting/]: Crash report saved to crash-reports/crash-2026-11-02_10.00.02-fml.txt',
    );
    const findings = analyze(body, 'latestLog', [cool261]);
    expect(codes(findings)).toEqual(['C-MIXIN']);
    const f = findings[0];
    expect(f?.severity).toBe('error');
    expect(culpritIds(f)).toEqual(['mods/coolmod-26.1.2-1.2.3.jar']);
    expect(f?.title).toBe('Mixin client.ScreenMixin from CoolMod failed on TitleScreen');
    expect(f?.fixes[0]).toEqual({ kind: 'disable', jarId: 'mods/coolmod-26.1.2-1.2.3.jar' });
    expect(culpritLines(f)).toEqual([2, 5]);
  });

  it('reports a mixin config shipped by two jars', () => {
    const body = text(
      '[02Nov2026 10:00:01.000] [main/ERROR] [net.neoforged.fml.loading.moddiscovery.ModDiscoverer/SCAN]: A mixin config named coolmod.mixins.json is provided by both coolmod-26.1.2-1.2.3.jar and coolmod-26.1.2-1.2.2.jar',
    );
    const old = jar({ file: 'coolmod-26.1.2-1.2.2.jar', mods: [['coolmod']], mixins: ['coolmod.mixins.json'] });
    const [f] = analyze(body, 'latestLog', [cool261, old]);
    expect(f?.code).toBe('C-MIXIN');
    expect(culpritIds(f)).toEqual(['mods/coolmod-26.1.2-1.2.3.jar', 'mods/coolmod-26.1.2-1.2.2.jar']);
  });
});
