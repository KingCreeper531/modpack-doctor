/** Regression samples for the behaviour fixed after the fixtures/logs corpus run (own samples). */
import { describe, expect, it } from 'vitest';
import { analyze, codes, culpritIds, culpritLines, jar, only, text } from './helpers';

describe('JVM stderr appended to latest.log / debug.log', () => {
  it('a ResolutionException after an INFO line is its own record and fatal', () => {
    const jars = [
      jar({ file: 'gizmolib-2.0.jar', mods: [['gizmolib']], packages: ['org.gizmo.core'] }),
      jar({ file: 'widgetry-1.1.jar', mods: [['widgetry']], packages: ['net.widgetry', 'org.gizmo.core'] }),
      jar({ file: 'innocent-1.0.jar', mods: [['innocent']], packages: ['dev.innocent'] }),
    ];
    const body = text(
      '[01Jan2026 10:00:00.000] [main/INFO] [mixin/]: Compatibility level set to JAVA_17',
      'Exception in thread "main" java.lang.module.ResolutionException: Modules gizmolib and widgetry export package org.gizmo.core to module innocent',
      '\tat java.base/java.lang.module.Resolver.resolveFail(Resolver.java:901)',
    );
    const findings = analyze(body, 'latestLog', jars);
    expect(codes(findings)).toEqual(['C-RESOLUTION']);
    expect(findings[0]?.severity).toBe('error');
    expect([...culpritIds(findings[0])].sort()).toEqual(['mods/gizmolib-2.0.jar', 'mods/widgetry-1.1.jar']);
    expect(culpritLines(findings[0])).toEqual([2]);
  });
});

describe('C-OOM needs a thrown OutOfMemoryError', () => {
  it('ignores OOM words in a details value and in JVM flags', () => {
    const body = text(
      '---- Minecraft Crash Report ----',
      '// Hi.',
      '',
      'Time: 2026-01-01 10:00:00',
      'Description: Ticking entity',
      '',
      'java.lang.IllegalStateException: boom',
      '\tat com.example.gadget.Tick.run(Tick.java:3)',
      '',
      '-- Gadget Settings --',
      'Details:',
      '\twarnText: "Ran out of memory (java.lang.OutOfMemoryError: Java heap space)"',
      "\tgcHint: 'GC overhead limit exceeded' means lower settings",
      '',
      '-- System Details --',
      'Details:',
      '\tJVM Flags: 3 total; -Xmx6G -XX:+HeapDumpOnOutOfMemoryError -XX:MaxMetaspaceSize=512M',
    );
    expect(only(analyze(body, 'crashReport'), 'C-OOM')).toEqual([]);
  });

  it('still reports a Caused by / Exception in thread OutOfMemoryError', () => {
    const body = text(
      'Exception in thread "Server thread" java.lang.OutOfMemoryError: Java heap space',
      '\tat java.base/java.util.Arrays.copyOf(Arrays.java:3537)',
    );
    expect(codes(analyze(body, 'latestLog'))).toEqual(['C-OOM']);
  });
});

describe('C-MIXIN marks the innermost cause', () => {
  it('flags the @Shadow / InvalidMixinException line below the MixinApplyError wrapper', () => {
    const gadget = jar({ file: 'gadget-1.0.jar', mods: [['gadget']], mixins: ['gadget.mixins.json'], loader: 'fabric' });
    const body = text(
      '---- Minecraft Crash Report ----',
      '// Oops.',
      '',
      'Time: 2026-01-01 10:00:00',
      'Description: Unexpected error',
      '',
      'org.spongepowered.asm.mixin.transformer.throwables.MixinTransformerError: An unexpected critical error was encountered',
      '\tat org.spongepowered.asm.mixin.transformer.MixinProcessor.applyMixins(MixinProcessor.java:392)',
      'Caused by: org.spongepowered.asm.mixin.throwables.MixinApplyError: Mixin [gadget.mixins.json:EntityMixin from mod gadget] from phase [DEFAULT] in config [gadget.mixins.json] FAILED during APPLY',
      '\t... 12 more',
      'Caused by: org.spongepowered.asm.mixin.transformer.throwables.InvalidMixinException: @Shadow field ticks was not located in the target class net.minecraft.class_1297.',
      '\t... 12 more',
    );
    const [f] = analyze(body, 'crashReport', [gadget]);
    expect(f?.code).toBe('C-MIXIN');
    expect(culpritLines(f)).toEqual([9, 11]);
    expect(f?.explanation).toContain('@Shadow field ticks');
  });
});

describe('old Fabric resolver wording', () => {
  const jars = [jar({ file: 'glowmoss-0.3.jar', mods: [['glowmoss']], loader: 'fabric' })];

  it('`- Mod x requires mod y, version …` is C-FABRIC-INCOMPAT blaming x, not C-MISSING-MANDATORY', () => {
    const body = text(
      '[09:00:00] [main/ERROR]: Incompatible mods found!',
      'net.fabricmc.loader.discovery.ModResolutionException: Errors were found!',
      ' - Mod glowmoss requires mod fabric-networking-v0, version >=0.3.0 but only the wrong version is present: 0.2.1!',
      '\tat net.fabricmc.loader.discovery.ModResolver.findCompatibleSet(ModResolver.java:316) ~[fabric-loader-0.11.3.jar:?]',
    );
    const findings = analyze(body, 'latestLog', jars);
    expect(codes(findings)).toEqual(['C-FABRIC-INCOMPAT']);
    expect(culpritIds(findings[0])).toContain('mods/glowmoss-0.3.jar');
  });

  it('marks every resolver header line as culprit evidence', () => {
    const body = text(
      '[09:00:00] [main/ERROR]: Incompatible mod set!',
      'net.fabricmc.loader.impl.discovery.ModResolutionException: Mod resolution encountered an incompatible mod set!',
      'Unmet dependency listing:',
      "\t - Mod 'Glow Moss' (glowmoss) 0.3 requires any version of 'Fabric API' (fabric-api), which is missing!",
    );
    const [f] = analyze(body, 'latestLog', jars);
    expect(culpritLines(f)).toEqual([1, 2, 4]);
  });
});

describe('Quilt display names', () => {
  it('blames both sides of a breaks conflict, mapped through "is loaded from", with a disable each', () => {
    const jars = [
      jar({ file: 'pebble-quilt-2.0.jar', mods: [['pebbles']], loader: 'quilt' }),
      jar({ file: 'shiny-renderer-1.4.jar', mods: [['shinyrender']], loader: 'fabric' }),
    ];
    const body = text(
      '[10:00:00] [main/ERROR]: Pebble Path breaks with all versions of Shiny Renderer, but an incompatible version is present: 1.4!',
      '\t- Pebble Path 2.0 is loaded from <mods>/pebble-quilt-2.0.jar',
      '\t- Shiny Renderer 1.4 is loaded from <mods>/shiny-renderer-1.4.jar',
    );
    const findings = analyze(body, 'latestLog', jars);
    expect(codes(findings)).toEqual(['C-FABRIC-INCOMPAT']);
    expect(culpritIds(findings[0])).toEqual(['mods/pebble-quilt-2.0.jar', 'mods/shiny-renderer-1.4.jar']);
    expect(findings[0]?.fixes.slice(0, 2)).toEqual([
      { kind: 'disable', jarId: 'mods/pebble-quilt-2.0.jar' },
      { kind: 'disable', jarId: 'mods/shiny-renderer-1.4.jar' },
    ]);
  });

  it('maps a non-ASCII display name through the report Mod Table', () => {
    const jars = [jar({ file: 'zeta-core-1.0.jar', mods: [['zetacore']], loader: 'fabric' })];
    const body = text(
      '---- Quilt Loader: Load Error Report ----',
      '',
      '-- Error 1 --',
      'ζeta Core requires any version of Fabric API, which is missing!',
      '',
      '-- Mod Table --',
      '| Index | Mod       | ID       | Version | Plugin | File(s)                  |',
      '|------:|-----------|----------|---------|--------|--------------------------|',
      '|     0 | ζeta Core | zetacore | 1.0     | fabric | <mods>/zeta-core-1.0.jar |',
    );
    const findings = only(analyze(body, 'crashReport', jars), 'C-FABRIC-INCOMPAT');
    expect(culpritIds(findings[0])).toEqual(['mods/zeta-core-1.0.jar']);
  });
});
