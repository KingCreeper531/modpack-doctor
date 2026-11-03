/** Regression samples mirroring shapes seen in real logs (anonymised, shortened). */
import { describe, expect, it } from 'vitest';
import { analyze, codes, culpritIds, jar, only, text } from './helpers';

const REACHED = [
  '[19:00:10] [Render thread/INFO] [com.mojang.blaze3d.audio.Library/]: OpenAL initialized on device Speakers',
  '[19:00:10] [Render thread/INFO] [net.minecraft.client.sounds.SoundEngine/SOUNDS]: Sound engine started',
  '[19:00:11] [Render thread/INFO] [net.minecraft.client.renderer.texture.TextureAtlas/]: Created: 2048x1024x4 minecraft:textures/atlas/blocks.png-atlas',
];

describe('a FATAL log level is not a crash marker', () => {
  it('a mod logging at FATAL plus an ERROR trace in a session that ended normally is not an error', () => {
    const body = text(
      ...REACHED,
      '[19:05:00] [Thread-0/FATAL] [com.example.probe.Config/]: probe config just got changed on the file system!',
      '[19:05:01] [Thread-30/ERROR] [net.minecraftforge.eventbus.EventSubclassTransformer/EVENTBUS]: An error occurred building event handler',
      'java.lang.NullPointerException: Cannot invoke "java.lang.ClassLoader.loadClass(String)" because "loader" is null',
      '\tat net.minecraftforge.eventbus.EventSubclassTransformer.buildEvents(EventSubclassTransformer.java:62) ~[eventbus-6.0.3.jar%2387!/:?] {}',
      '\tat net.minecraftforge.eventbus.EventBus.register(EventBus.java:118) ~[eventbus-6.0.3.jar%2387!/:?] {}',
      '[19:30:00] [Render thread/INFO] [net.minecraft.client.Minecraft/]: Stopping!',
    );
    const findings = analyze(body, 'latestLog');
    expect(findings.filter((f) => f.severity !== 'info')).toEqual([]);
    expect(only(findings, 'C-ROOT-CAUSE')).toEqual([]);
  });

  it('even before the game is reached, FATAL + ERROR alone do not make a crash', () => {
    const body = text(
      '[19:00:00] [Thread-0/FATAL] [com.example.probe.Config/]: probe config just got changed on the file system!',
      '[19:00:01] [Thread-30/ERROR] [x/]: An error occurred building event handler',
      'java.lang.NullPointerException: boom',
      '\tat com.example.probe.Handler.run(Handler.java:3)',
    );
    expect(analyze(body, 'latestLog').filter((f) => f.severity === 'error')).toEqual([]);
  });
});

describe('logged errors in a session that kept running are informational', () => {
  const kff = jar({ file: 'kotlinforforge-4.11.0-all.jar', mods: [['kotlinforforge']], packages: ['kotlin.jvm.internal', 'thedarkcolour.kotlinforforge'] });

  it('optional-class probes after the game was reached become info', () => {
    const body = text(
      ...REACHED,
      '[19:01:00] [Worker-Main-4/ERROR] [com.example.compat.Probe/]: Optional feature unavailable',
      'java.lang.NoClassDefFoundError: kotlin/jvm/internal/Lambda',
      '\tat com.example.compat.Probe.check(Probe.java:9) ~[combatplus-1.0.jar%2390!/:1.0] {}',
      '[19:01:01] [Render thread/ERROR] [com.example.quests.Client/]: Quest client failed',
      'java.lang.NoClassDefFoundError: dev/ftb/mods/ftbquests/client/ClientQuestFile',
      '\tat com.example.quests.Client.init(Client.java:4) ~[xmodcompat-1.0.jar%2391!/:1.0] {}',
      '[19:40:00] [Render thread/INFO] [net.minecraft.client.Minecraft/]: Stopping!',
    );
    const findings = analyze(body, 'latestLog', [kff]);
    expect(findings.length).toBeGreaterThan(0);
    expect(findings.every((f) => f.severity === 'info')).toBe(true);
    expect(findings[0]?.explanation).toContain('kept running');
  });

  it('a crash after the game was reached stays an error when a crash marker follows', () => {
    const crates = jar({ file: 'crates-2.2.jar', mods: [['crates']], packages: ['org.crates.logic'] });
    const body = text(
      ...REACHED,
      '[19:20:00] [Render thread/FATAL] [net.minecraft.client.Minecraft/]: Unreported exception thrown!',
      'java.lang.IllegalStateException: crate lost its owner',
      '\tat org.crates.logic.Crate.tick(Crate.java:42) ~[crates-2.2.jar%2390!/:2.2] {}',
      '[19:20:01] [Render thread/INFO] [STDOUT/]: #@!@# Game crashed! Crash report saved to: #@!@# crash.txt',
    );
    const findings = analyze(body, 'latestLog', [crates]);
    expect(findings[0]?.severity).toBe('error');
    expect(culpritIds(findings[0])).toEqual(['mods/crates-2.2.jar']);
  });
});

describe('one C-SUSPECTED per mod', () => {
  const body = text(
    '---- Minecraft Crash Report ----',
    'Description: Mod loading error has occurred',
    '',
    'java.lang.Exception: Mod Loading has failed',
    '',
    '-- Mod loading issue --',
    'Details:',
    '\tMod file: /C:/Users/u/curseforge/Instances/Pack/mods/decoblocks-2.0.3-1.20.1-forge.jar',
    '\tException message: java.lang.IllegalStateException: duplicate registry entry',
    '',
    '-- Loading errors --',
    'Details:',
    '\t- Deco Blocks (decoblocks) has failed to load correctly',
  );

  it('merges the file-level and the mod-level entry for the same jar (with an index)', () => {
    const deco = jar({ file: 'decoblocks-2.0.3-1.20.1-forge.jar', mods: [['decoblocks', 'Deco Blocks']] });
    const found = only(analyze(body, 'crashReport', [deco]), 'C-SUSPECTED');
    expect(found).toHaveLength(1);
    expect(found[0]?.title).toBe('Deco Blocks (decoblocks) failed to load');
    expect(culpritIds(found[0])).toEqual(['mods/decoblocks-2.0.3-1.20.1-forge.jar']);
  });

  it('merges them by file name when there is no index', () => {
    const found = only(analyze(body, 'crashReport'), 'C-SUSPECTED');
    expect(found).toHaveLength(1);
    expect(found[0]?.title).toBe('Deco Blocks (decoblocks) failed to load');
  });
});

describe('culprit lookup for mods named by a report', () => {
  const body = text(
    '---- Minecraft Crash Report ----',
    'Description: Mod loading error has occurred',
    '',
    'java.lang.Exception: Mod Loading has failed',
    '',
    '-- Mod loading issue for: yungscavebiomes --',
    'Details:',
    "\tFailure message: YUNG's Cave Biomes (yungscavebiomes) encountered an error during the common_setup event phase",
    '\tException message: java.util.ConcurrentModificationException',
  );

  it('falls back to the jar file name when the jar did not declare the id', () => {
    const noMeta = jar({ file: 'YungsCaveBiomes-1.20.1-Forge-2.1.4.jar' });
    const [f] = only(analyze(body, 'crashReport', [noMeta]), 'C-SUSPECTED');
    expect(culpritIds(f)).toEqual(['mods/YungsCaveBiomes-1.20.1-Forge-2.1.4.jar']);
    expect(f?.fixes[0]).toEqual({ kind: 'disable', jarId: 'mods/YungsCaveBiomes-1.20.1-Forge-2.1.4.jar' });
  });

  it('says so when the mod is no longer installed', () => {
    const [f] = only(analyze(body, 'crashReport', [jar({ file: 'other-1.0.jar', mods: [['other']] })]), 'C-SUSPECTED');
    expect(f?.culprits).toEqual([]);
    expect(f?.explanation).toContain('No jar for yungscavebiomes is in the mods folder now');
  });

  it('maps a TRANSFORMER/modid frame through the same lookup for the root cause', () => {
    const noMeta = jar({ file: 'YungsCaveBiomes-1.20.1-Forge-2.1.4.jar' });
    const report = text(
      '---- Minecraft Crash Report ----',
      'Description: Ticking world',
      '',
      'java.lang.IllegalStateException: biome lookup failed',
      '\tat TRANSFORMER/yungscavebiomes@2.1.4/com.yungnickyoung.cavebiomes.Lookup.get(Lookup.java:5)',
    );
    expect(codes(analyze(report, 'crashReport', [noMeta]))).toEqual(['C-ROOT-CAUSE']);
    expect(culpritIds(analyze(report, 'crashReport', [noMeta])[0])).toEqual(['mods/YungsCaveBiomes-1.20.1-Forge-2.1.4.jar']);
  });
});
