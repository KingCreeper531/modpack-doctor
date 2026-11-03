import { describe, expect, it } from 'vitest';
import { analyze, codes, culpritIds, culpritLines, jar, only, text } from './helpers';

const coolhud = jar({ file: 'coolhud-2.1.0.jar', mods: [['coolhud', 'Cool HUD']], packages: ['com.example.coolhud'] });

/** Forge 1.20.1 (FG-ML9) in-game crash with the Suspected Mods block. */
const FORGE_1201_SUSPECTED = text(
  '---- Minecraft Crash Report ----',
  "// Don't be sad, have a hug! <3",
  '',
  'Time: 2026-10-30 19:02:11',
  'Description: Rendering overlay',
  '',
  'java.lang.NullPointerException: Cannot invoke "net.minecraft.world.entity.player.Player.m_21223_()" because "player" is null',
  '\tat com.example.coolhud.HudRenderer.render(HudRenderer.java:88) ~[coolhud-2.1.0.jar%23187!/:2.1.0] {re:classloading}',
  '\tat net.minecraftforge.client.gui.overlay.ForgeGui.m_280421_(ForgeGui.java:211) ~[forge-1.20.1-47.2.0-universal.jar%23191!/:?] {re:mixin,re:classloading}',
  '\tat net.minecraft.client.renderer.GameRenderer.m_109093_(GameRenderer.java:954) ~[client-1.20.1-20230612.114412-srg.jar%23186!/:?] {re:mixin,pl:accesstransformer:B,pl:mixin:APP:embeddium.mixins.json:core.MinecraftMixin,pl:mixin:A}',
  '\tat java.lang.Thread.run(Thread.java:833) ~[?:?] {}',
  '',
  '',
  'A detailed walkthrough of the error, its code path and all known details is as follows:',
  '---------------------------------------------------------------------------------------',
  '',
  '-- Head --',
  'Thread: Render thread',
  'Suspected Mod: ',
  '\tCool HUD (coolhud), Version: 2.1.0',
  '\t\tIssue tracker URL: https://example.org/coolhud/issues',
  '\t\tat TRANSFORMER/coolhud@2.1.0/com.example.coolhud.HudRenderer.render(HudRenderer.java:88)',
  'Stacktrace:',
  '\tat com.example.coolhud.HudRenderer.render(HudRenderer.java:88) ~[coolhud-2.1.0.jar%23187!/:2.1.0] {re:classloading}',
  '',
  '-- System Details --',
  'Details:',
  '\tMinecraft Version: 1.20.1',
  '\tJava Version: 17.0.8, Eclipse Adoptium',
  '\tMemory: 1073741824 bytes (1024 MiB) / 4294967296 bytes (4096 MiB) up to 8589934592 bytes (8192 MiB)',
  '\tJVM Flags: 1 total; -Xmx8G',
  '\tMod List: ',
  '\t\tcoolhud-2.1.0.jar                                 |Cool HUD                      |coolhud                       |2.1.0               |DONE      |Manifest: NOSIGNATURE',
  '\tForge: net.minecraftforge:47.2.0',
);

describe('Forge 1.18–1.20.1 (FG-ML9)', () => {
  it('reports the Suspected Mod and suppresses the root-cause fallback', () => {
    const findings = analyze(FORGE_1201_SUSPECTED, 'crashReport', [coolhud]);
    expect(codes(findings)).toEqual(['C-SUSPECTED']);
    const f = findings[0];
    expect(f?.severity).toBe('error');
    expect(culpritIds(f)).toEqual(['mods/coolhud-2.1.0.jar']);
    expect(f?.fixes[0]).toEqual({ kind: 'disable', jarId: 'mods/coolhud-2.1.0.jar' });
    expect(f?.title).toContain('Cool HUD (coolhud)');
    expect(f?.explanation).toContain('NullPointerException');
    expect(culpritLines(f)).toContain(20);
    const log = f?.evidence.find((e) => e.kind === 'log');
    expect(log?.kind === 'log' && log.frames).toEqual([{ line: 22, jarId: 'mods/coolhud-2.1.0.jar' }]);
  });

  it('without an index still names the mod, with no culprits and a note', () => {
    const [f] = analyze(FORGE_1201_SUSPECTED, 'crashReport');
    expect(f?.code).toBe('C-SUSPECTED');
    expect(f?.title).toContain('coolhud');
    expect(f?.culprits).toEqual([]);
    expect(f?.fixes[0]?.kind).toBe('manual');
    expect(f?.evidence.some((e) => e.kind === 'note')).toBe(true);
  });

  it('ignores "Suspected Mods: NONE"', () => {
    const body = FORGE_1201_SUSPECTED.replace(
      'Suspected Mod: \n\tCool HUD (coolhud), Version: 2.1.0\n\t\tIssue tracker URL: https://example.org/coolhud/issues\n\t\tat TRANSFORMER/coolhud@2.1.0/com.example.coolhud.HudRenderer.render(HudRenderer.java:88)\n',
      'Suspected Mods: NONE\n',
    );
    const findings = analyze(body, 'crashReport', [coolhud]);
    // Falls back to the root cause, which maps the first mod frame through the jar name.
    expect(codes(findings)).toEqual(['C-ROOT-CAUSE']);
    expect(culpritIds(findings[0])).toEqual(['mods/coolhud-2.1.0.jar']);
  });
});

/** Forge 1.16.5 (FG-ML8): `~[modid:version]` brackets, no Suspected Mods. */
const FORGE_1165 = text(
  '---- Minecraft Crash Report ----',
  '// Oops.',
  '',
  'Time: 30/10/26 19:02',
  'Description: Ticking entity',
  '',
  'java.lang.ArrayIndexOutOfBoundsException: Index 5 out of bounds for length 5',
  '\tat com.example.coolmod.entity.CoolEntity.func_70071_h_(CoolEntity.java:140) ~[coolmod:1.2.3] {re:classloading}',
  '\tat net.minecraft.world.World.func_217390_a(World.java:599) ~[?:?] {re:classloading,pl:accesstransformer:B}',
  '\tat net.minecraft.world.server.ServerWorld.func_217479_a(ServerWorld.java:653) ~[?:?] {re:classloading}',
  '\tat net.minecraftforge.fml.common.thread.EffectiveSide.get(EffectiveSide.java:1) ~[forge:?] {}',
  '',
  '',
  'A detailed walkthrough of the error, its code path and all known details is as follows:',
  '---------------------------------------------------------------------------------------',
  '',
  '-- System Details --',
  'Details:',
  '\tMinecraft Version: 1.16.5',
  '\tModLauncher launch target: fmlclient',
);

describe('Forge 1.16 (FG-ML8)', () => {
  it('maps the ~[modid:ver] frame for the root cause', () => {
    const coolmod = jar({ file: 'coolmod-1.16.5-1.2.3.jar', mods: [['coolmod', 'Cool Mod']], packages: ['com.example.coolmod'] });
    const findings = analyze(FORGE_1165, 'crashReport', [coolmod]);
    expect(codes(findings)).toEqual(['C-ROOT-CAUSE']);
    const f = findings[0];
    expect(f?.title).toContain('ArrayIndexOutOfBoundsException');
    expect(culpritIds(f)).toEqual(['mods/coolmod-1.16.5-1.2.3.jar']);
    expect(f?.fixes[0]).toEqual({ kind: 'disable', jarId: 'mods/coolmod-1.16.5-1.2.3.jar' });
  });
});

/** Forge 1.20.4 (FG-BOOT): `~[jar!/:ver]` frames and a Caused-by chain. */
const FORGE_1204 = text(
  '---- Minecraft Crash Report ----',
  '// I blame Dinnerbone.',
  '',
  'Time: 2026-10-30 20:10:00',
  'Description: Exception in server tick loop',
  '',
  'net.minecraft.ReportedException: Exception ticking world',
  '\tat net.minecraft.server.MinecraftServer.tickChildren(MinecraftServer.java:1007) ~[forge-1.20.4-49.0.3-universal.jar!/:?] {re:classloading}',
  '\tat java.lang.Thread.run(Thread.java:1583) ~[?:?] {}',
  'Caused by: java.lang.IllegalStateException: Duplicate key coolores:ruby',
  '\tat com.example.coolores.registry.OreRegistry.lookup(OreRegistry.java:42) ~[coolores-3.0.1.jar!/:3.0.1] {re:classloading}',
  '\tat com.example.coolores.world.OreFeature.place(OreFeature.java:17) ~[coolores-3.0.1.jar!/:3.0.1] {re:classloading}',
  '\t... 12 more',
  '',
  '',
  'A detailed walkthrough of the error, its code path and all known details is as follows:',
);

describe('Forge 1.20.2+ (FG-BOOT)', () => {
  it('uses the innermost Caused by and the jar from ~[jar!/:ver]', () => {
    const coolores = jar({ file: 'coolores-3.0.1.jar', mods: [['coolores', 'Cool Ores']], packages: ['com.example.coolores.registry'] });
    const [f, ...rest] = analyze(FORGE_1204, 'crashReport', [coolores]);
    expect(rest).toEqual([]);
    expect(f?.code).toBe('C-ROOT-CAUSE');
    expect(f?.title).toBe('IllegalStateException: Duplicate key coolores:ruby (in coolores-3.0.1.jar)');
    expect(culpritIds(f)).toEqual(['mods/coolores-3.0.1.jar']);
    expect(culpritLines(f)).toContain(10);
  });
});

/** Forge 1.20.1 mod-loading report (`-fml.txt`) with a missing library class. */
const FORGE_FML = text(
  '---- Minecraft Crash Report ----',
  '// Why did you do that?',
  '',
  'Time: 2026-10-30 18:00:00',
  'Description: Mod loading error has occurred',
  '',
  'java.lang.Exception: Mod Loading has failed',
  '\tat net.minecraftforge.logging.CrashReportExtender.dumpModLoadingCrashReport(CrashReportExtender.java:60) ~[forge-1.20.1-47.2.0-universal.jar%23191!/:?] {re:classloading}',
  '',
  '',
  'A detailed walkthrough of the error, its code path and all known details is as follows:',
  '---------------------------------------------------------------------------------------',
  '',
  '-- MOD coolmod --',
  'Details:',
  '\tCaused by 0: java.lang.NoClassDefFoundError: dev/architectury/registry/registries/DeferredRegister',
  '\t\tat com.example.coolmod.CoolMod.<init>(CoolMod.java:31) ~[coolmod-1.4.0.jar%23188!/:1.4.0] {re:classloading}',
  '\t\tat java.lang.reflect.Constructor.newInstance(Constructor.java:490) ~[?:?] {}',
  '\tCaused by 1: java.lang.ClassNotFoundException: dev.architectury.registry.registries.DeferredRegister',
  '\t\tat cpw.mods.cl.ModuleClassLoader.loadClass(ModuleClassLoader.java:141) ~[securejarhandler-2.1.10.jar:?] {}',
  '\tMod File: /C:/Users/alex/AppData/Roaming/.minecraft/mods/coolmod-1.4.0.jar',
  '\tFailure message: Cool Mod (coolmod) has failed to load correctly',
  '\t\tjava.lang.reflect.InvocationTargetException: null',
  '\tMod Version: 1.4.0',
  '\tMod Issue URL: NOT PROVIDED',
  '\tException message: java.lang.ClassNotFoundException: dev.architectury.registry.registries.DeferredRegister',
  'Stacktrace:',
  '\tat cpw.mods.cl.ModuleClassLoader.loadClass(ModuleClassLoader.java:141) ~[securejarhandler-2.1.10.jar:?] {}',
  '\tat com.example.coolmod.CoolMod.<init>(CoolMod.java:31) ~[coolmod-1.4.0.jar%23188!/:1.4.0] {re:classloading}',
  '',
  '-- System Details --',
  'Details:',
  '\tMinecraft Version: 1.20.1',
);

describe('Forge mod-loading report (-fml.txt)', () => {
  const coolmod = jar({ file: 'coolmod-1.4.0.jar', mods: [['coolmod', 'Cool Mod']], packages: ['com.example.coolmod'] });

  it('reports the missing library class first, then the failed mod from Mod File:', () => {
    const findings = analyze(FORGE_FML, 'crashReport', [coolmod]);
    expect(codes(findings)).toEqual(['C-NOCLASSDEF', 'C-SUSPECTED']);
    const [missing, suspected] = findings;
    expect(missing?.title).toContain('Architectury API (architectury)');
    expect(missing?.title).toContain('Cool Mod (coolmod-1.4.0.jar)');
    expect(missing?.fixes[0]?.kind).toBe('manual');
    expect(missing?.fixes[1]).toEqual({ kind: 'disable', jarId: 'mods/coolmod-1.4.0.jar' });
    expect(culpritIds(suspected)).toEqual(['mods/coolmod-1.4.0.jar']);
    expect(suspected?.title).toBe('coolmod failed to load');
    expect(suspected?.explanation).toContain('has failed to load correctly');
    expect(suspected?.explanation).toContain('ClassNotFoundException');
  });

  it('a stray "Mod file:" line maps by file name', () => {
    const body = text('[18:00:00] [main/ERROR] [x/]: Mod loading has failed', '\tMod file: /home/u/mods/coolmod-1.4.0.jar');
    const findings = only(analyze(body, 'latestLog', [coolmod]), 'C-SUSPECTED');
    expect(culpritIds(findings[0])).toEqual(['mods/coolmod-1.4.0.jar']);
  });
});

/** Forge/NeoForge ModSorter output in latest.log. */
const MISSING_DEPS = text(
  '[30Oct2026 18:00:00.001] [main/INFO] [cpw.mods.modlauncher.Launcher/MODLAUNCHER]: ModLauncher running: args [--username, Alex, --version, 1.20.1-forge-47.2.0, --fml.forgeVersion, 47.2.0, --fml.mcVersion, 1.20.1, --launchTarget, forgeclient]',
  '[30Oct2026 18:00:05.112] [main/ERROR] [net.minecraftforge.fml.loading.ModSorter/LOADING]: Missing or unsupported mandatory dependencies:',
  "\tMod ID: 'architectury', Requested by: 'coolmod', Expected range: '[9.1.12,)', Actual version: '[MISSING]'",
  "\tMod ID: 'architectury', Requested by: 'otherthing', Expected range: '[9.0,)', Actual version: '[MISSING]'",
  "\tMod ID: 'minecraft', Requested by: 'oldmod', Expected range: '[1.19.2,1.19.3)', Actual version: '1.20.1'",
  "\tMod ID: 'geckolib', Requested by: 'mobsplus', Expected range: '[4.4,)', Actual version: '4.2.1'",
  '[30Oct2026 18:00:05.120] [main/ERROR] [net.minecraftforge.fml.loading.ModSorter/LOADING]: Unsupported installed optional dependencies:',
  "\tMod ID: 'jei', Requested by: 'coolmod', Expected range: '[15.3,)', Actual version: '15.2.0'",
  '[30Oct2026 18:00:09.500] [main/INFO] [net.minecraftforge.fml.loading.ModLoader/LOADING]: Loading errors will be shown on screen',
);

describe('missing mandatory dependencies', () => {
  const jars = [
    jar({ file: 'coolmod-1.0.jar', mods: [['coolmod', 'Cool Mod']] }),
    jar({ file: 'otherthing-2.0.jar', mods: [['otherthing']] }),
    jar({ file: 'oldmod-1.19.2-1.0.jar', mods: [['oldmod']] }),
    jar({ file: 'mobsplus-3.0.jar', mods: [['mobsplus']] }),
    jar({ file: 'geckolib-forge-1.20.1-4.2.1.jar', mods: [['geckolib', 'GeckoLib 4']] }),
    jar({ file: 'jei-1.20.1-15.2.0.jar', mods: [['jei']] }),
  ];

  it('groups requesters per missing mod, flags wrong-MC mods and wrong versions; ignores optional deps', () => {
    const findings = analyze(MISSING_DEPS, 'latestLog', jars);
    expect(codes(findings)).toEqual(['C-MISSING-MANDATORY', 'C-MISSING-MANDATORY', 'C-MISSING-MANDATORY']);
    expect(findings.every((f) => f.severity === 'error')).toBe(true);
    const [arch, oldmc, gecko] = findings;
    expect(arch?.title).toBe('coolmod and otherthing need architectury, which is not installed');
    expect(arch?.explanation).toContain('9.1.12 or newer ([9.1.12,))');
    expect(culpritIds(arch)).toEqual(['mods/coolmod-1.0.jar', 'mods/otherthing-2.0.jar']);
    expect(arch?.fixes[0]?.kind).toBe('manual');
    expect(oldmc?.title).toContain('built for Minecraft');
    expect(oldmc?.fixes[0]).toEqual({ kind: 'disable', jarId: 'mods/oldmod-1.19.2-1.0.jar' });
    expect(culpritIds(gecko)).toEqual(['mods/geckolib-forge-1.20.1-4.2.1.jar', 'mods/mobsplus-3.0.jar']);
    expect(findings.some((f) => f.title.includes('jei'))).toBe(false);
  });

  it('reads CRLF logs the same way', () => {
    const lf = analyze(MISSING_DEPS, 'latestLog', jars);
    const crlf = analyze(MISSING_DEPS.replace(/\n/g, '\r\n'), 'latestLog', jars);
    expect(crlf.map((f) => f.id)).toEqual(lf.map((f) => f.id));
    expect(crlf.map((f) => f.title)).toEqual(lf.map((f) => f.title));
  });

  it('reads the translated GUI text', () => {
    const body = text(
      '[18:00:05] [main/FATAL] [x/]: Mod loading has failed',
      'net.neoforged.fml.ModLoadingException: Loading errors encountered:',
      '\t- Mod coolmod requires architectury 13.0.0 or above',
      '\t  Currently, architectury is not installed',
    );
    const f = only(analyze(body, 'latestLog', jars), 'C-MISSING-MANDATORY');
    expect(f).toHaveLength(1);
    expect(f[0]?.title).toBe('coolmod needs architectury, which is not installed');
    // The same text is not also reported as a failed mod.
    expect(only(analyze(body, 'latestLog', jars), 'C-SUSPECTED')).toEqual([]);
  });
});

describe('JPMS resolution errors', () => {
  const jars = [
    jar({ file: 'libfoo-1.0.jar', packages: ['com.lib.foo', 'com.lib.bar'] }),
    jar({ file: 'coolmod-1.0.jar', mods: [['coolmod', 'Cool Mod']], packages: ['com.example.cool', 'com.lib.foo', 'com.lib.bar'] }),
    jar({ file: 'othermod-1.0.jar', mods: [['othermod']], packages: ['com.example.other'] }),
  ];
  const phrasings = [
    'Exception in thread "main" java.lang.module.ResolutionException: Modules libfoo and coolmod export package com.lib.foo to module othermod',
    'Exception in thread "main" java.lang.module.ResolutionException: Module coolmod contains package com.lib.foo, module libfoo exports package com.lib.foo to coolmod',
    'Exception in thread "main" java.lang.module.ResolutionException: Module othermod reads package com.lib.foo from both libfoo and coolmod',
  ];
  for (const first of phrasings) {
    it(`names both jars: ${first.slice(first.indexOf(': ') + 2, first.indexOf(': ') + 40)}…`, () => {
      const body = text(
        first,
        '\tat java.base/java.lang.module.Resolver.resolveFail(Resolver.java:901)',
        '\tat MC-BOOTSTRAP/cpw.mods.modlauncher@10.0.9/cpw.mods.modlauncher.ModuleLayerHandler.buildLayer(ModuleLayerHandler.java:75)',
      );
      const findings = analyze(body, 'latestLog', jars);
      expect(codes(findings)).toEqual(['C-RESOLUTION']);
      const f = findings[0];
      expect(f?.severity).toBe('error');
      expect([...culpritIds(f)].sort()).toEqual(['mods/coolmod-1.0.jar', 'mods/libfoo-1.0.jar']);
      expect(f?.title).toContain('com.lib.foo');
      expect(f?.fixes[0]?.kind).toBe('manual');
    });
  }

  it('reports a duplicate module', () => {
    const body = text('java.lang.module.ResolutionException: Module coolmod reads more than one module named libfoo');
    const dup = [jar({ file: 'libfoo-1.0.jar' }), jar({ file: 'libfoo-1.1.jar' }), ...jars.slice(1)];
    const [f] = analyze(body, 'latestLog', dup);
    expect(f?.code).toBe('C-RESOLUTION');
    expect(culpritIds(f)).toEqual(['mods/libfoo-1.0.jar', 'mods/libfoo-1.1.jar']);
  });

  it('does not match prose without the JDK phrasing', () => {
    expect(analyze(text('[12:00:00] [main/INFO] [x/]: Modules loaded: 42'), 'latestLog', jars)).toEqual([]);
  });
});
