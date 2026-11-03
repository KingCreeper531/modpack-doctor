import { describe, expect, it } from 'vitest';
import { CRASH_ANCHOR_TEXTS } from '../anchors';
import { analyzeCrash, CRASH_PATTERNS } from '../analyze';
import { blameFrame, mixinOwners, parseFrame } from '../frames';
import { findingId, fnv1a32 } from '../id';
import { javaForClassMajor, minJavaForMinecraft } from '../javaVersions';
import { automaticModuleName } from '../jars';
import { digestFromText } from '../text';
import { analyze, buildIndex, codes, culpritIds, jar, only, source, text } from './helpers';

/** A healthy Forge launch, including the harmless noise real logs contain. */
const CLEAN_LATEST = text(
  '[30Oct2026 18:00:00.001] [main/INFO] [cpw.mods.modlauncher.Launcher/MODLAUNCHER]: ModLauncher running: args [--fml.mcVersion, 1.20.1, --launchTarget, forgeclient]',
  '[30Oct2026 18:00:01.000] [main/WARN] [mixin/]: Reference map \'coolmod.refmap.json\' for coolmod.mixins.json could not be read. If this is a development environment you can ignore this message',
  '[30Oct2026 18:00:02.000] [main/DEBUG] [net.minecraftforge.fml.loading.moddiscovery.ModDiscoverer/SCAN]: Probing optional integration: java.lang.ClassNotFoundException: com.optional.api.Thing',
  '[30Oct2026 18:00:03.000] [Worker-Main-2/WARN] [com.example.coolmod.Compat/]: JEI not found, skipping integration',
  'java.lang.ClassNotFoundException: mezz.jei.api.IModPlugin',
  '\tat java.base/jdk.internal.loader.BuiltinClassLoader.loadClass(BuiltinClassLoader.java:641)',
  '\tat TRANSFORMER/coolmod@1.0.0/com.example.coolmod.Compat.init(Compat.java:20)',
  'Caused by: java.lang.ClassNotFoundException: mezz.jei.api.IModPlugin',
  '\t... 5 more',
  '[30Oct2026 18:00:05.000] [Render thread/INFO] [net.minecraft.client.Minecraft/]: Setting user: Alex',
  '[30Oct2026 18:00:09.000] [Render thread/INFO] [net.minecraft.server.MinecraftServer/]: Stopping server',
  '[30Oct2026 18:00:09.500] [Render thread/INFO] [net.minecraft.client.Minecraft/]: Stopping!',
);

describe('negative cases', () => {
  const coolmod = jar({ file: 'coolmod-1.0.0.jar', mods: [['coolmod']], packages: ['com.example.coolmod'] });

  it('a clean latest.log yields nothing', () => {
    expect(analyze(CLEAN_LATEST, 'latestLog', [coolmod])).toEqual([]);
    expect(analyze(CLEAN_LATEST, 'latestLog')).toEqual([]);
  });

  it('an empty digest yields nothing', () => {
    expect(analyze('', 'latestLog')).toEqual([]);
    expect(analyze('', 'crashReport')).toEqual([]);
  });

  it('an ERROR-level ClassNotFoundException without a crash is only a warning', () => {
    const body = text(
      '[12:00:00] [main/ERROR]: Failed to load optional compat',
      'java.lang.NoClassDefFoundError: com/missing/Api',
      '\tat TRANSFORMER/coolmod@1.0.0/com.example.coolmod.Compat.init(Compat.java:20)',
      '[12:00:10] [Render thread/INFO]: Stopping!',
    );
    const findings = analyze(body, 'latestLog', [coolmod]);
    expect(findings.map((f) => [f.code, f.severity])).toEqual([['C-NOCLASSDEF', 'warning']]);
  });

  it('every pattern is silent on the clean log', () => {
    const input = { digest: digestFromText(CLEAN_LATEST, source('latestLog')), index: buildIndex([coolmod]) };
    for (const p of CRASH_PATTERNS) expect(p.match(input), p.id).toEqual([]);
  });
});

describe('C-NOCLASSDEF special cases', () => {
  it('flags a client-only class loaded on a dedicated server and disables the requester', () => {
    const client = jar({ file: 'fancyhud-1.0.jar', mods: [['fancyhud']], packages: ['com.example.fancyhud'] });
    const body = text(
      '[30Oct2026 18:00:05.000] [main/ERROR] [net.minecraftforge.fml.javafmlmod.FMLModContainer/LOADING]: Exception caught during event',
      'java.lang.RuntimeException: Attempted to load class net/minecraft/client/gui/screens/Screen for invalid dist DEDICATED_SERVER',
      '\tat net.minecraftforge.fml.loading.RuntimeDistCleaner.processClassWithFlags(RuntimeDistCleaner.java:57) ~[fmlloader-1.20.1-47.2.0.jar:1.0]',
      '\tat com.example.fancyhud.FancyHud.<init>(FancyHud.java:20) ~[fancyhud-1.0.jar%2380!/:1.0]',
      '[30Oct2026 18:00:06.000] [main/FATAL] [net.minecraftforge.server.loading.ServerModLoader/]: Crash report saved to ./crash-reports/crash.txt',
    );
    const [f] = only(analyze(body, 'latestLog', [client]), 'C-NOCLASSDEF');
    expect(f?.severity).toBe('error');
    expect(f?.title).toContain('client-only class Screen');
    expect(f?.fixes[0]).toEqual({ kind: 'disable', jarId: 'mods/fancyhud-1.0.jar' });
  });
});

describe('C-OOM', () => {
  const report = (memoryLine: string, error: string) =>
    text(
      '---- Minecraft Crash Report ----',
      '// Uh... Did I do that?',
      '',
      'Time: 2026-10-30 12:00:00',
      'Description: Unexpected error',
      '',
      `java.lang.OutOfMemoryError: ${error}`,
      '\tat java.base/java.util.Arrays.copyOf(Arrays.java:3537)',
      '',
      '-- System Details --',
      'Details:',
      memoryLine,
    );

  it('advises raising a small heap', () => {
    const findings = analyze(
      report('\tMemory: 1 bytes (0 MiB) / 2147483648 bytes (2048 MiB) up to 2147483648 bytes (2048 MiB)', 'Java heap space'),
      'crashReport',
    );
    expect(codes(findings)).toEqual(['C-OOM']);
    expect(findings[0]?.title).toBe('Java ran out of heap memory (2 GB allocated)');
    const fix = findings[0]?.fixes[0];
    expect(fix?.kind === 'manual' && fix.steps[0]).toContain('raise the instance memory');
  });

  it('suspects a leak with a huge heap', () => {
    const [f] = analyze(report('\tJVM Flags: 1 total; -Xmx16G', 'GC overhead limit exceeded'), 'crashReport');
    expect(f?.title).toBe('Java ran out of heap memory with 16 GB allocated');
  });

  it('handles Metaspace', () => {
    const [f] = analyze(report('\tJVM Flags: 0 total;', 'Metaspace'), 'crashReport');
    expect(f?.title).toContain('Metaspace');
  });
});

describe('C-JAVA-VERSION', () => {
  it('maps class-file versions to Java releases', () => {
    const body = text(
      'Exception in thread "main" java.lang.UnsupportedClassVersionError: net/minecraft/client/main/Main has been compiled by a more recent version of the Java Runtime (class file version 65.0), this version of the Java Runtime only recognizes class file versions up to 61.0',
      '\tat java.base/java.lang.ClassLoader.defineClass1(Native Method)',
    );
    const findings = analyze(body, 'latestLog');
    expect(codes(findings)).toEqual(['C-JAVA-VERSION']);
    expect(findings[0]?.title).toBe('The game needs Java 21 but runs on Java 17');
    const fix = findings[0]?.fixes[0];
    expect(fix?.kind === 'manual' && fix.steps[0]).toContain('Java 21');
  });

  it('blames a mod compiled for a newer Java than its Minecraft version', () => {
    const newer = jar({ file: 'shiny-1.21-2.0.jar', mods: [['shiny', 'Shiny']], packages: ['com.example.shiny'] });
    const body = text(
      '[12:00:00] [main/INFO] [x/]: ModLauncher running: args [--fml.mcVersion, 1.20.1]',
      '[12:00:01] [main/ERROR] [x/]: Failed to load class',
      'java.lang.UnsupportedClassVersionError: com/example/shiny/Shiny has been compiled by a more recent version of the Java Runtime (class file version 65.0), this version of the Java Runtime only recognizes class file versions up to 61.0',
    );
    const [f] = analyze(body, 'latestLog', [newer]);
    expect(f?.code).toBe('C-JAVA-VERSION');
    expect(f?.title).toContain('Shiny (shiny-1.21-2.0.jar) needs Java 21');
    expect(f?.fixes[0]).toEqual({ kind: 'disable', jarId: 'mods/shiny-1.21-2.0.jar' });
  });

  it('recognises LaunchWrapper on a too-new Java', () => {
    const body = text(
      'Exception in thread "main" java.lang.ClassCastException: class jdk.internal.loader.ClassLoaders$AppClassLoader cannot be cast to class java.net.URLClassLoader',
    );
    expect(analyze(body, 'latestLog')[0]?.title).toBe('This Minecraft version needs Java 8');
  });

  it('class-major and Minecraft tables', () => {
    expect([45, 48, 49, 52, 61, 65, 69, 70, 71].map(javaForClassMajor)).toEqual(['1.1', '1.4', '5', '8', '17', '21', '25', '26', '27']);
    expect(javaForClassMajor(44)).toBeNull();
    expect(['1.12.2', '1.16.5', '1.17.1', '1.18.2', '1.20.4', '1.20.5', '1.21.11', '26.1', '26.4-snapshot-6', '24w14a', '1.20.5-pre1', 'nope'].map(minJavaForMinecraft)).toEqual([
      8, 8, 16, 17, 17, 21, 21, 25, 25, 21, 21, null,
    ]);
  });
});

describe('root cause fallback in latest.log', () => {
  it('picks the trace next to the crash marker and maps it', () => {
    const coolmod = jar({ file: 'coolmod-1.0.0.jar', mods: [['coolmod']], packages: ['com.example.coolmod'] });
    const body = text(
      '[12:00:00] [Render thread/ERROR] [x/]: Unrelated earlier error',
      'java.lang.IllegalArgumentException: nope',
      '\tat com.other.Thing.run(Thing.java:1)',
      '[12:00:05] [Render thread/FATAL] [net.minecraft.client.Minecraft/]: Unreported exception thrown!',
      'java.lang.RuntimeException: Ticking screen',
      '\tat net.minecraft.client.Minecraft.tick(Minecraft.java:10)',
      'Caused by: java.lang.ArithmeticException: / by zero',
      '\tat TRANSFORMER/coolmod@1.0.0/com.example.coolmod.Gui.ratio(Gui.java:5)',
    );
    const findings = analyze(body, 'latestLog', [coolmod]);
    expect(codes(findings)).toEqual(['C-ROOT-CAUSE']);
    expect(findings[0]?.title).toBe('ArithmeticException: / by zero (in coolmod)');
    expect(culpritIds(findings[0])).toEqual(['mods/coolmod-1.0.0.jar']);
  });
});

describe('frames', () => {
  it('parses every era', () => {
    expect(parseFrame('\tat com.example.cool.Foo.bar(Foo.java:12) ~[coolmod-1.2.3.jar%23187!/:1.2.3] {re:mixin,pl:mixin:APP:coolmod.mixins.json:FooMixin,pl:mixin:A}')).toMatchObject({
      cls: 'com.example.cool.Foo',
      method: 'bar',
      jar: 'coolmod-1.2.3.jar',
    });
    expect(parseFrame('\tat a.B.c(B.java:1) ~[cool%20mod%2b-1.0.jar%2312!/:1.0]')?.jar).toBe('cool mod+-1.0.jar');
    expect(parseFrame('\tat a.B.c(B.java:1) ~[coolmod-1.2.3.jar!/:1.2.3] {re:classloading}')?.jar).toBe('coolmod-1.2.3.jar');
    expect(parseFrame('\tat a.B.c(B.java:1) ~[coolmod-1.2.3.jar:?]')?.jar).toBe('coolmod-1.2.3.jar');
    expect(parseFrame('\tat a.B.c(B.java:1) ~[coolmod:1.2.3] {re:classloading}')?.bracketModId).toBe('coolmod');
    expect(parseFrame('\tat TRANSFORMER/coolmod@1.2.3/com.example.cool.Foo.bar(Foo.java:12)')).toMatchObject({
      loader: 'TRANSFORMER',
      module: 'coolmod',
      moduleVersion: '1.2.3',
      cls: 'com.example.cool.Foo',
    });
    expect(parseFrame('\tat knot//com.example.cool.Foo.bar(Foo.java:12)')).toMatchObject({ loader: 'knot', cls: 'com.example.cool.Foo' });
    expect(parseFrame('\tat java.base/java.lang.Thread.run(Thread.java:840)')).toMatchObject({ module: 'java.base' });
    expect(parseFrame('not a frame')).toBeNull();
    expect(mixinOwners('neoforge:access_transformer,neoforge:mixin[APP:coolmod.mixins.json:FooMixin from mod coolmod,APP:b.mixins.json:B]')).toEqual([
      { config: 'coolmod.mixins.json', mixin: 'FooMixin', modId: 'coolmod' },
      { config: 'b.mixins.json', mixin: 'B' },
    ]);
  });

  it('never blames JDK, loader, Mixin or Minecraft frames', () => {
    const index = buildIndex([jar({ file: 'x.jar', mods: [['x']], packages: ['net.minecraft.client', 'cpw.mods.modlauncher'] })]);
    for (const f of [
      '\tat java.base/java.lang.Thread.run(Thread.java:840)',
      '\tat MC-BOOTSTRAP/cpw.mods.modlauncher@10.0.9/cpw.mods.modlauncher.Launcher.run(Launcher.java:1)',
      '\tat org.spongepowered.asm.mixin.transformer.MixinProcessor.applyMixins(MixinProcessor.java:1) ~[mixin-0.8.5.jar:?]',
      '\tat net.minecraft.client.Minecraft.run(Minecraft.java:1) ~[client-1.20.1-srg.jar%23186!/:?]',
      '\tat TRANSFORMER/minecraft@1.21.1/net.minecraft.server.Main.main(Main.java:1)',
      '\tat net.fabricmc.loader.impl.launch.knot.Knot.launch(Knot.java:1) ~[fabric-loader-0.16.5.jar:?]',
    ]) {
      const frame = parseFrame(f);
      expect(frame, f).not.toBeNull();
      expect(frame && blameFrame(frame, index), f).toBeNull();
    }
  });
});

describe('ids, anchors and digests', () => {
  it('finding ids are stable and independent of line numbers', () => {
    const body = text(
      '[12:00:01] [main/ERROR]: Mixin apply failed a.mixins.json:M -> net.minecraft.X: java.lang.RuntimeException boom',
      '[12:00:02] [main/FATAL]: Crash report saved to crash.txt',
    );
    const a = analyze(body, 'latestLog');
    const b = analyze(`[12:00:00] [main/INFO]: hello\n${body}`, 'latestLog');
    expect(a.map((f) => f.id)).toEqual(b.map((f) => f.id));
    expect(findingId('C-MIXIN', ['b', 'a', 'a'], 'x')).toBe(findingId('C-MIXIN', ['a', 'b'], 'x'));
    expect(findingId('C-MIXIN', ['a'], 'x')).not.toBe(findingId('C-MIXIN', ['a'], 'y'));
    expect(fnv1a32('')).toBe('811c9dc5');
    expect(fnv1a32('a')).toBe('e40c292c');
  });

  it('dedupes and orders findings: error before warning, specific before suspected', () => {
    const coolmod = jar({ file: 'coolmod-1.0.0.jar', mods: [['coolmod']], packages: ['com.example.coolmod'], mixins: ['coolmod.mixins.json'] });
    const body = text(
      '[12:00:00] [main/WARN]: Unsupported thing: java.lang.OutOfMemoryError: Direct buffer memory',
      '[12:00:01] [main/ERROR]: A critical error occurred',
      "java.lang.RuntimeException: Could not execute entrypoint stage 'main' due to errors, provided by 'coolmod' at 'x'!",
      'Caused by: java.lang.NoClassDefFoundError: dev/architectury/event/Event',
      '\tat knot//com.example.coolmod.Init.run(Init.java:3)',
    );
    const findings = analyzeCrash({ digest: digestFromText(body, source('latestLog')), index: buildIndex([coolmod]) });
    expect(findings.map((f) => `${f.severity}:${f.code}`)).toEqual(['error:C-NOCLASSDEF', 'error:C-SUSPECTED', 'warning:C-OOM']);
    expect(new Set(findings.map((f) => f.id)).size).toBe(findings.length);
  });

  it('anchors are a deduped literal list of a reasonable size', () => {
    expect(CRASH_ANCHOR_TEXTS.length).toBeGreaterThan(60);
    expect(CRASH_ANCHOR_TEXTS.length).toBeLessThanOrEqual(150);
    expect(new Set(CRASH_ANCHOR_TEXTS).size).toBe(CRASH_ANCHOR_TEXTS.length);
    expect(CRASH_ANCHOR_TEXTS.every((a) => a.length >= 4)).toBe(true);
    for (const must of [
      'Suspected Mods: ',
      'Mixin apply failed',
      'Missing or unsupported mandatory dependencies',
      'Incompatible mods found!',
      'NoClassDefFoundError',
      'java.lang.OutOfMemoryError',
      'UnsupportedClassVersionError',
      '# Problematic frame:',
      'Caused by: ',
      'Crash report saved to',
      'A critical error occurred',
    ]) {
      expect(CRASH_ANCHOR_TEXTS).toContain(must);
    }
    // Every pattern's anchors are included.
    for (const p of CRASH_PATTERNS) for (const a of p.anchors) expect(CRASH_ANCHOR_TEXTS).toContain(a.text);
  });

  it('digestFromText numbers lines from 1 and strips CR', () => {
    const d = digestFromText('a\r\nb\n\nc', source('latestLog'));
    expect(d.totalLines).toBe(4);
    expect(d.chunks).toEqual([{ startLine: 1, lines: ['a', 'b', '', 'c'], reasons: [{ kind: 'head' }] }]);
    expect(digestFromText('', source('latestLog')).chunks).toEqual([]);
  });

  it('respects digest gaps: line numbers come from the chunks', () => {
    const coolmod = jar({ file: 'coolmod-1.0.0.jar', mods: [['coolmod']] });
    const digest = {
      source: source('latestLog'),
      totalLines: 50_000,
      truncated: false,
      chunks: [
        { startLine: 1, lines: ['[12:00:00] [main/INFO]: start'], reasons: [{ kind: 'head' as const }] },
        {
          startLine: 40_001,
          lines: [
            '[13:00:00] [main/ERROR] [net.minecraftforge.fml.loading.ModSorter/LOADING]: Missing or unsupported mandatory dependencies:',
            "\tMod ID: 'architectury', Requested by: 'coolmod', Expected range: '[9,)', Actual version: '[MISSING]'",
          ],
          reasons: [{ kind: 'anchor' as const, anchor: 'Missing or unsupported mandatory dependencies' }],
        },
      ],
    };
    const [f] = analyzeCrash({ digest, index: buildIndex([coolmod]) });
    const log = f?.evidence.find((e) => e.kind === 'log');
    expect(log?.kind === 'log' && log.lines.find((l) => l.role === 'culprit')?.n).toBe(40_002);
  });

  it('derives JDK automatic module names', () => {
    expect(automaticModuleName('libfoo-1.0.jar')).toBe('libfoo');
    expect(automaticModuleName('kotlin-stdlib-1.9.0.jar')).toBe('kotlin.stdlib');
    expect(automaticModuleName('night_config-toml-3.6.0.jar')).toBe('night.config.toml');
  });
});
