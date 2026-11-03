/** Tiered watch anchors: contract tests for `CRASH_ANCHORS` and the TS model of watch tailing. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { LogKind } from '../../../bindings';
import { CRASH_ANCHORS, CRASH_ANCHOR_TEXTS } from '../anchors';
import { analyzeCrash, CRASH_PATTERNS } from '../analyze';
import { digestFromText } from '../text';
import { classifyWatchLines } from '../tiers';
import { source, text } from './helpers';

const FIXTURES = join(__dirname, '..', '..', '..', '..', 'fixtures', 'logs');

function fixture(path: string): string {
  return readFileSync(join(FIXTURES, path), 'utf8');
}

function lines(body: string): string[] {
  return digestFromText(body, source('latestLog')).chunks.flatMap((c) => c.lines);
}

function hasError(body: string, kind: LogKind = 'latestLog'): boolean {
  return analyzeCrash({ digest: digestFromText(body, source(kind)) }).some((f) => f.severity === 'error');
}

const OWNER_FATAL = [
  '---- Minecraft Crash Report ----',
  '#@!@# Game crashed!',
  'java.lang.module.ResolutionException',
  'Missing or unsupported mandatory dependencies',
  'Incompatible mods found!',
  'Incompatible mod set!',
  'Some of your mods are incompatible',
  'Mod resolution encountered an incompatible mod set',
  '---- Quilt Loader',
  'Mod loading has failed',
  'Loading errors encountered',
  'A fatal error has been detected by the Java Runtime Environment',
];

describe('anchor tiers', () => {
  it('every anchor has a tier, texts are unique and match CRASH_ANCHOR_TEXTS', () => {
    for (const a of CRASH_ANCHORS) expect(['fatal', 'contextual'], a.text).toContain(a.tier);
    expect(new Set(CRASH_ANCHORS.map((a) => a.text)).size).toBe(CRASH_ANCHORS.length);
    expect(CRASH_ANCHOR_TEXTS).toEqual(CRASH_ANCHORS.map((a) => a.text));
    for (const p of CRASH_PATTERNS) for (const a of p.anchors) expect(['fatal', 'contextual']).toContain(a.tier);
  });

  it("the owner's fatal list is present and fatal; everyday exception text is contextual", () => {
    const tier = new Map(CRASH_ANCHORS.map((a) => [a.text, a.tier]));
    for (const t of OWNER_FATAL) expect(tier.get(t), t).toBe('fatal');
    // Every ResolutionException phrasing the resolution pattern matches is fatal.
    const resolution = CRASH_PATTERNS.find((p) => p.id === 'jpms-resolution');
    expect(resolution?.anchors.every((a) => tier.get(a.text) === 'fatal')).toBe(true);
    for (const t of ['Caused by: ', 'ClassNotFoundException', 'NoClassDefFoundError', 'Mixin apply failed', 'java.lang.OutOfMemoryError', '/FATAL]']) {
      expect(tier.get(t), t).toBe('contextual');
    }
  });
});

describe('watch-mode simulation', () => {
  const HEALTHY = text(
    '[12:00:00] [main/INFO]: Loading Minecraft 1.21.1 with Fabric Loader 0.16.9',
    "[12:00:01] [main/WARN]: Mod 'Lantern Glow' (lanternglow) 1.0 recommends any version of modmenu, which is missing!",
    "[12:00:02] [main/WARN]: Reference map 'lanternglow-refmap.json' for lanternglow.mixins.json could not be read. If this is a development environment you can ignore this message",
    '[12:00:03] [main/WARN]: Error loading class: dev/emi/emi/api/EmiPlugin (java.lang.ClassNotFoundException: dev/emi/emi/api/EmiPlugin)',
    '[12:00:04] [Worker-Main-3/WARN]: Optional compat skipped',
    'java.lang.ClassNotFoundException: mezz.jei.api.IModPlugin',
    '\tat dev.lantern.Compat.load(Compat.java:7)',
    'Caused by: java.lang.ClassNotFoundException: mezz.jei.api.IModPlugin',
    '\t... 4 more',
    '[12:00:05] [main/INFO]: JVM flags include -XX:+HeapDumpOnOutOfMemoryError (java.lang.OutOfMemoryError dumps enabled)',
    '[12:30:00] [Render thread/INFO]: Stopping!',
  );

  it('a healthy log with logged exceptions has zero fatal hits and no error finding', () => {
    const hits = classifyWatchLines(lines(HEALTHY), CRASH_ANCHORS);
    expect(hits.fatal).toEqual([]);
    expect(hits.contextual.length).toBeGreaterThan(0);
    expect(hasError(HEALTHY)).toBe(false);
  });

  it.each(['fabric/fab21-clean-session-long.log', 'forge/fg20-clean-benign-cnfe-long.log'])('corpus clean log %s: no fatal hit, no error', (path) => {
    const body = fixture(path);
    expect(classifyWatchLines(lines(body), CRASH_ANCHORS).fatal).toEqual([]);
    expect(hasError(body)).toBe(false);
  });

  it.each([
    'fabric/fab20-incompatible-current.log',
    'neoforge/neo21.1-server-loading-errors.log',
  ])('corpus load-time failure %s: fatal hit and an error finding', (path) => {
    const body = fixture(path);
    expect(classifyWatchLines(lines(body), CRASH_ANCHORS).fatal.length).toBeGreaterThan(0);
    expect(hasError(body)).toBe(true);
  });

  it('own samples: Fabric incompatible set and NeoForge loading errors appear only in latest.log', () => {
    const fabric = text(
      '[12:00:00] [main/INFO]: Loading Minecraft 1.21.1 with Fabric Loader 0.16.9',
      '[12:00:01] [main/ERROR]: Incompatible mods found!',
      'net.fabricmc.loader.impl.FormattedException: Some of your mods are incompatible with the game or each other!',
      'More details:',
      "\t - Mod 'Lantern Glow' (lanternglow) 1.0 requires any version of fabric-api, which is missing!",
    );
    const neo = text(
      '[02Nov2026 10:00:00.000] [main/INFO] [net.neoforged.fml.loading.FMLLoader/CORE]: Starting FancyModLoader version 4.0.31',
      '[02Nov2026 10:00:05.000] [main/FATAL] [net.neoforged.fml.ModLoader/]: Mod loading has failed',
      'net.neoforged.fml.ModLoadingException: Loading errors encountered:',
      '\t- Mod lanternglow requires ferrolib 2.0 or above',
      '\t  Currently, ferrolib is not installed',
    );
    for (const body of [fabric, neo]) {
      const hits = classifyWatchLines(lines(body), CRASH_ANCHORS);
      expect(hits.fatal.length).toBeGreaterThan(0);
      expect(hasError(body)).toBe(true);
    }
    expect(classifyWatchLines(lines(fabric), CRASH_ANCHORS).fatal[0]).toEqual({ line: 2, anchor: 'Incompatible mods found!' });
  });

  it('a line with both tiers counts as fatal once', () => {
    const hits = classifyWatchLines(['Exception in thread "main" java.lang.module.ResolutionException: Caused by: x'], CRASH_ANCHORS);
    expect(hits.fatal).toHaveLength(1);
    expect(hits.contextual).toEqual([]);
  });
});
