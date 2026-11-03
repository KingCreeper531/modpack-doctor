/** Regression samples for the M2 review items (own samples). */
import { describe, expect, it } from 'vitest';
import { ctxOf } from '../context';
import { blameFrame, parseFrame } from '../frames';
import { digestFromText } from '../text';
import { analyze, buildIndex, codes, culpritIds, jar, only, source, text } from './helpers';

function filler(n: number, from = 0): string[] {
  return Array.from({ length: n }, (_, k) => `[10:0${(k % 6) + 1}:00] [Render thread/INFO] [net.minecraft.client.Minecraft/]: tick ${from + k}`);
}

describe('item 1: crash markers only explain nearby errors', () => {
  const lamp = jar({ file: 'lamplighter-1.0.jar', mods: [['lamplighter']], packages: ['dev.lamp'] });
  const crates = jar({ file: 'crates-2.2.jar', mods: [['crates']], packages: ['org.crates.logic'] });

  it('an early optional-compat NoClassDefFoundError is not blamed for a late crash elsewhere', () => {
    const body = text(
      '[10:00:00] [modloading-worker-1/ERROR] [dev.lamp.Compat/]: Optional compat failed to load',
      'java.lang.NoClassDefFoundError: org/absent/api/Plugin',
      '\tat dev.lamp.Compat.init(Compat.java:9) ~[lamplighter-1.0.jar%2311!/:1.0] {re:classloading}',
      ...filler(400),
      '[10:09:00] [Render thread/FATAL] [net.minecraft.client.Minecraft/]: Unreported exception thrown!',
      'net.minecraft.ReportedException: Ticking block entity',
      '\tat net.minecraft.world.level.Level.tick(Level.java:1) ~[client-1.20.1-20230612.114412-srg.jar%23186!/:?] {}',
      'Caused by: java.lang.IllegalStateException: crate 7 lost its owner',
      '\tat org.crates.logic.Crate.tick(Crate.java:42) ~[crates-2.2.jar%23190!/:2.2] {re:classloading}',
      '[10:09:01] [Render thread/INFO] [STDOUT/]: #@!@# Game crashed! Crash report saved to: #@!@# crash.txt',
    );
    const findings = analyze(body, 'latestLog', [lamp, crates]);
    expect(codes(findings)).toEqual(['C-ROOT-CAUSE']);
    expect(culpritIds(findings[0])).toEqual(['mods/crates-2.2.jar']);
  });

  it('a clean shutdown between an ERROR and a later crash marker breaks the link', () => {
    const body = text(
      '[10:00:00] [Render thread/ERROR] [dev.lamp.Compat/]: Optional compat failed',
      'java.lang.NoClassDefFoundError: org/absent/api/Plugin',
      '\tat dev.lamp.Compat.init(Compat.java:9)',
      '[10:00:01] [Render thread/INFO] [net.minecraft.client.Minecraft/]: Stopping!',
      '[10:00:05] [main/FATAL] [x/]: Preparing crash report with UUID 1234',
    );
    expect(only(analyze(body, 'latestLog', [lamp]), 'C-NOCLASSDEF')).toEqual([]);
  });

  it('still adds and ranks first the root cause when the only error does not cite the crash trace', () => {
    const body = text(
      '[10:00:00] [Render thread/ERROR] [mixin/]: Mixin apply failed lamp.mixins.json:HudMixin -> net.minecraft.client.gui.Gui: org.spongepowered.asm.mixin.injection.throwables.InvalidInjectionException Critical injection failure',
      ...filler(10),
      '[10:01:00] [Render thread/FATAL] [net.minecraft.client.Minecraft/]: Unreported exception thrown!',
      'java.lang.IllegalStateException: crate 7 lost its owner',
      '\tat org.crates.logic.Crate.tick(Crate.java:42) ~[crates-2.2.jar%23190!/:2.2] {re:classloading}',
    );
    const lampMixin = jar({ file: 'lamplighter-1.0.jar', mods: [['lamplighter']], mixins: ['lamp.mixins.json'] });
    const findings = analyze(body, 'latestLog', [lampMixin, crates]);
    expect(findings.map((f) => `${f.severity}:${f.code}`)).toEqual(['error:C-ROOT-CAUSE', 'error:C-MIXIN']);
    expect(culpritIds(findings[0])).toEqual(['mods/crates-2.2.jar']);
  });
});

describe('item 2: exception class names are crash markers only where thrown', () => {
  it('an INFO line mentioning OutOfMemoryError does not make a clean session a crash', () => {
    const body = text(
      '[10:00:00] [main/INFO] [dev.lamp.Lamp/]: Will dump heap on java.lang.OutOfMemoryError (HeapDumpOnOutOfMemoryError)',
      '[10:00:01] [Render thread/ERROR] [x/]: Failed to parse recipe lamp:glow',
      'java.lang.IllegalArgumentException: Unknown item tag',
      '\tat dev.lamp.Recipes.parse(Recipes.java:3)',
      '[10:05:00] [Render thread/INFO] [net.minecraft.client.Minecraft/]: Stopping!',
    );
    const findings = analyze(body, 'latestLog');
    expect(findings.filter((f) => f.severity === 'error')).toEqual([]);
    expect(only(findings, 'C-ROOT-CAUSE')).toEqual([]);
  });
});

describe('item 3: crash-report details values are not occurrences', () => {
  it('a ClassNotFoundException quoted in a System Details value is ignored', () => {
    const body = text(
      '---- Minecraft Crash Report ----',
      '// Hi.',
      '',
      'Time: 2026-01-01 10:00:00',
      'Description: Ticking entity',
      '',
      'java.lang.IllegalStateException: boom',
      '\tat org.crates.logic.Crate.tick(Crate.java:42)',
      '',
      '-- System Details --',
      'Details:',
      '\tMinecraft Version: 1.20.1',
      '\tLamplighter Config: lastError=java.lang.ClassNotFoundException: org.absent.api.Plugin',
      '\tCrates Diagnostics: java.lang.UnsupportedClassVersionError: x has been compiled by a more recent version of the Java Runtime (class file version 65.0), this version of the Java Runtime only recognizes class file versions up to 61.0',
      '\t\tModules: Modules a and b export package c.d to module e',
    );
    const findings = analyze(body, 'crashReport', [jar({ file: 'crates-2.2.jar', mods: [['crates']], packages: ['org.crates.logic'] })]);
    expect(codes(findings)).toEqual(['C-ROOT-CAUSE']);
  });

  it('keeps loader-written section values (-- MOD x -- Exception message)', () => {
    const body = text(
      '---- Minecraft Crash Report ----',
      'Description: Mod loading error has occurred',
      '',
      'java.lang.Exception: Mod Loading has failed',
      '',
      '-- MOD lamplighter --',
      'Details:',
      '\tMod File: /mods/lamplighter-1.0.jar',
      '\tFailure message: Lamplighter (lamplighter) has failed to load correctly',
      '\tException message: java.lang.ClassNotFoundException: org.absent.api.Plugin',
    );
    const lamp = jar({ file: 'lamplighter-1.0.jar', mods: [['lamplighter']], packages: ['dev.lamp'] });
    expect(codes(analyze(body, 'crashReport', [lamp]))).toEqual(['C-NOCLASSDEF', 'C-SUSPECTED']);
  });
});

describe('item 4: nits', () => {
  it('names a module that maps to no jar even when the package resolved', () => {
    const libA = jar({ file: 'liba-1.0.jar', packages: ['org.shared'] });
    const body = text('Exception in thread "main" java.lang.module.ResolutionException: Modules liba and ghostmod export package org.shared to module x');
    const [f] = analyze(body, 'latestLog', [libA]);
    expect(f?.code).toBe('C-RESOLUTION');
    expect(f?.evidence.some((e) => e.kind === 'note' && e.text.includes('ghostmod'))).toBe(true);
  });

  it('uses the declared JPMS module name before the file-name heuristic', () => {
    const named = jar({ file: 'shared-lib-forge-3.1.jar', moduleName: 'org.shared.lib', packages: ['org.shared'] });
    const other = jar({ file: 'other-1.0.jar', mods: [['other']], packages: ['org.shared'] });
    const body = text('java.lang.module.ResolutionException: Module other reads more than one module named org.shared.lib');
    const [f] = analyze(body, 'latestLog', [named, other]);
    expect(culpritIds(f)).toEqual(['mods/shared-lib-forge-3.1.jar']);
  });

  it('a mod whose jar name starts with "minecraft" or "client" is not treated as the game jar', () => {
    const mca = jar({ file: 'minecraft-comes-alive-7.5.jar', mods: [['mca']] });
    const index = buildIndex([mca]);
    const frame = parseFrame('\tat net.mca.Villager.tick(Villager.java:3) ~[minecraft-comes-alive-7.5.jar%2399!/:7.5] {}');
    expect(frame && blameFrame(frame, index)?.jar?.id).toBe('mods/minecraft-comes-alive-7.5.jar');
    const tweaks = parseFrame('\tat dev.tw.Tweaks.run(Tweaks.java:1) ~[client-tweaks-1.0.jar:?]');
    expect(tweaks && blameFrame(tweaks)?.label).toBe('client-tweaks-1.0.jar');
    const game = parseFrame('\tat a.B.c(B.java:1) ~[minecraft-26.1.2-client.jar:?]');
    expect(game && blameFrame(game)).toBeNull();
  });

  it('prefers Minecraft Version ID over the display name', () => {
    const body = text(
      '---- Minecraft Crash Report ----',
      '-- System Details --',
      'Details:',
      '\tMinecraft Version: 1.20.5 Pre-Release 1',
      '\tMinecraft Version ID: 1.20.5-pre1',
    );
    expect(ctxOf({ digest: digestFromText(body, source('crashReport')) }).mcVersion).toBe('1.20.5-pre1');
    const noId = body.replace(/\tMinecraft Version ID: .*\n/, '');
    expect(ctxOf({ digest: digestFromText(noId, source('crashReport')) }).mcVersion).toBe('1.20.5 Pre-Release 1');
  });
});
