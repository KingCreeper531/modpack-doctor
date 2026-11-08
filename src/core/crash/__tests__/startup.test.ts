/**
 * Java start-up failures (C-JVM-START, C-OOM `reserve`, C-JAVA-VERSION for Java 9+ options on
 * Java 8) from the console capture the Modrinth App writes per profile (`logs/launcher_log.txt`,
 * launchers.md §7). Fixtures: `fixtures/startup/*.txt`, JVM wording from OpenJDK.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { CRASH_ANCHORS } from '../anchors';
import { analyzeCrash } from '../analyze';
import { digestPastedText } from '../digest';
import { analyze, codes, culpritLines, text } from './helpers';
import type { Finding } from '../../model';

const fixture = (name: string): string => readFileSync(join(__dirname, 'fixtures', 'startup', name), 'utf8');

function run(name: string, mcVersion: string | null = null): Finding[] {
  return analyze(fixture(name), 'launcherLog', undefined, mcVersion ? { mcVersion } : undefined);
}

function manualSteps(f: Finding | undefined): string {
  return (f?.fixes ?? []).flatMap((x) => (x.kind === 'manual' ? x.steps : [])).join('\n');
}

describe('JVM start-up failures', () => {
  it('a removed -XX flag: names the argument, says how to remove it and where', () => {
    const fs = run('modrinth-removed-cms-flag.txt');
    expect(codes(fs)).toEqual(['C-JVM-START']);
    const f = fs[0];
    expect(f?.severity).toBe('error');
    expect(f?.title).toBe('Java does not accept the JVM argument -XX:+UseConcMarkSweepGC');
    expect(f?.explanation).toContain('Java 14 removed the CMS garbage collector');
    expect(culpritLines(f)).toEqual([4]);
    expect(manualSteps(f)).toContain('Remove -XX:+UseConcMarkSweepGC');
    expect(manualSteps(f)).toContain('Modrinth App');
    expect(manualSteps(f)).toContain('Prism Launcher');
  });

  it('a Java 9+ option on Java 8 is the wrong Java, with the version Minecraft needs', () => {
    const fs = run('modrinth-java8-add-modules.txt', '1.20.1');
    expect(codes(fs)).toEqual(['C-JAVA-VERSION']);
    expect(fs[0]?.title).toBe('The game is started with Java 8, but needs Java 17');
    expect(manualSteps(fs[0])).toContain('Install Java 17');
    // Without a version: a generic "17 or newer".
    expect(run('modrinth-java8-add-modules.txt')[0]?.title).toContain('Java 17 or newer');
  });

  it('a malformed -Xmx explains the syntax', () => {
    const [f, ...rest] = run('modrinth-invalid-xmx.txt');
    expect(rest).toEqual([]);
    expect(f?.code).toBe('C-JVM-START');
    expect(f?.title).toBe('Java does not accept the memory setting -Xmx8GB');
    expect(f?.explanation).toContain('-Xmx6G');
  });

  it('a heap too large for 32-bit Java asks for 64-bit Java', () => {
    const [f] = run('modrinth-32bit-xmx.txt');
    expect(f?.code).toBe('C-JVM-START');
    expect(f?.title).toBe('32-bit Java cannot use a -Xmx4G heap');
    expect(manualSteps(f)).toContain('64-bit Java');
  });

  it('a heap that cannot be reserved is C-OOM with the size', () => {
    const fs = run('modrinth-reserve-heap.txt');
    expect(codes(fs)).toEqual(['C-OOM']);
    expect(fs[0]?.title).toBe('Java could not reserve the 4 GB of memory set for the game');
    expect(culpritLines(fs[0])).toContain(5);
  });

  it('-Xms above -Xmx', () => {
    const [f] = run('modrinth-heap-order.txt');
    expect(f?.title).toBe('The minimum memory is set higher than the maximum');
  });

  it('main class: a stray word in the arguments vs a broken install', () => {
    const args = run('modrinth-main-class-args.txt');
    expect(codes(args)).toEqual(['C-JVM-START']);
    expect(args[0]?.title).toBe('Java took "4G" from the JVM arguments as the class to start');
    const install = run('modrinth-main-class-install.txt');
    expect(install[0]?.title).toBe("Java could not find the game's main class cpw.mods.bootstraplauncher.BootstrapLauncher");
    expect(manualSteps(install[0])).toContain('reinstall');
  });

  it('boot layer FindException', () => {
    const [f] = run('modrinth-boot-layer.txt');
    expect(f?.code).toBe('C-JVM-START');
    expect(f?.explanation).toContain('Two versions of module org.objectweb.asm');
  });

  it('an unexplained start failure gets the generic finding with the reason line as evidence', () => {
    const [f, ...rest] = run('modrinth-agent-generic.txt');
    expect(rest).toEqual([]);
    expect(f?.title).toBe('Java could not start the game');
    const lines = f?.evidence.flatMap((e) => (e.kind === 'log' ? e.lines.map((l) => l.text) : [])) ?? [];
    expect(lines).toContain('agent library failed to init: instrument');
  });

  it('a too-new game class stays C-JAVA-VERSION alone', () => {
    expect(codes(run('modrinth-linkage-java17.txt'))).toEqual(['C-JAVA-VERSION']);
  });

  it('the same words quoted by a running game are not a failed start', () => {
    const body = text(
      '[12:00:01] [main/INFO]: Setting user: Alex',
      "[12:00:02] [main/INFO]: [ExampleMod] tip: 'Invalid maximum heap size' means -Xmx is mistyped",
      '[12:00:03] [Render thread/INFO]: Error: Could not find or load main class demo (from a help text)',
      '[12:00:09] [Render thread/INFO]: Sound engine started',
    );
    expect(analyze(body, 'latestLog')).toEqual([]);
  });

  it('every start-up line is a fatal anchor, so the digest and watch mode keep it', () => {
    const fatal = new Set(CRASH_ANCHORS.filter((a) => a.tier === 'fatal').map((a) => a.text));
    for (const t of [
      'Error: Could not create the Java Virtual Machine',
      'Error occurred during initialization of VM',
      'Error occurred during initialization of boot layer',
      'Error: Could not find or load main class',
      'Could not reserve enough space for',
      'Unrecognized VM option',
      'Unrecognized option: ',
      'Invalid maximum heap size',
      'java.lang.module.FindException',
    ]) {
      expect(fatal.has(t), t).toBe(true);
    }
  });

  it('pasted console output goes through the same pipeline', () => {
    const { digest } = digestPastedText(
      fixture('modrinth-removed-cms-flag.txt'),
      CRASH_ANCHORS.map((a) => a.text),
      { id: 'pasted', modifiedMs: 0, size: 0 },
    );
    expect(codes(analyzeCrash({ digest }))).toEqual(['C-JVM-START']);
  });
});
