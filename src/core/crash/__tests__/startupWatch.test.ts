/**
 * JVM start-up anchors in watch mode (CONTRACTS invariant 11). Watch mode tails only
 * `latest.log`. A JVM that fails to start never writes that file, but a running game can quote
 * the start-up phrases in a WARN/INFO line. Such a line must not be a fatal hit: it would emit a
 * false `CrashDetected` and suppress the session's real crash. The generic reasons are
 * contextual. Only the Java launcher's closing lines are fatal.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { CRASH_ANCHORS } from '../anchors';
import { digestFromText } from '../text';
import { classifyWatchLines } from '../tiers';
import { analyze, source, text } from './helpers';

const fixture = (name: string): string => readFileSync(join(__dirname, 'fixtures', 'startup', name), 'utf8');

function lines(body: string): string[] {
  return digestFromText(body, source('latestLog')).chunks.flatMap((c) => c.lines);
}

describe('JVM start-up anchors in a running game’s latest.log', () => {
  const RUNNING = text(
    '[12:00:00] [main/INFO]: Loading Minecraft 1.20.1 with Fabric Loader 0.15.11',
    '[12:00:01] [main/WARN]: Unrecognized option: foo',
    "[12:00:01] [main/WARN]: [JvmTweaks] Unrecognized VM option 'UseFastJNIAccessors' ignored",
    '[12:00:02] [main/WARN]: [MemoryHelper] Could not reserve enough space for the texture atlas; retrying smaller',
    '[12:00:02] [main/INFO]: [ExampleMod] tip: "Invalid maximum heap size" or "Invalid initial heap size" means -Xmx is mistyped',
    '[12:00:03] [main/INFO]: [ExampleMod] "Initial heap size set to a larger value than the maximum heap size" means -Xms > -Xmx',
    '[12:00:03] [main/INFO]: [ExampleMod] "The specified size exceeds the maximum representable size" means 32-bit Java',
    '[12:00:04] [Worker-Main-2/WARN]: Optional module skipped: java.lang.module.FindException: Module foo not found',
    '[12:00:05] [Render thread/INFO]: Error: Could not find or load main class demo (from a help text)',
    '[12:00:09] [Render thread/INFO]: Sound engine started',
  );

  it('quoting the generic start-up reasons is never a fatal hit', () => {
    const hits = classifyWatchLines(lines(RUNNING), CRASH_ANCHORS);
    expect(hits.fatal).toEqual([]);
    // Recorded silently: they count only if the game exits within the context window.
    expect(hits.contextual.map((h) => h.line)).toEqual([2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('a running game quoting them gets no error finding either', () => {
    expect(analyze(RUNNING, 'latestLog').filter((f) => f.severity === 'error')).toEqual([]);
  });

  it.each([
    'modrinth-removed-cms-flag.txt',
    'modrinth-invalid-xmx.txt',
    'modrinth-heap-order.txt',
    'modrinth-boot-layer.txt',
    'modrinth-reserve-heap.txt',
  ])('a real failed start (%s) still has a fatal hit from the JVM’s closing lines', (name) => {
    expect(classifyWatchLines(lines(fixture(name)), CRASH_ANCHORS).fatal.length).toBeGreaterThan(0);
  });
});
