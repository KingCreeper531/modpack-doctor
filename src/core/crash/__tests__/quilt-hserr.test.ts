import { describe, expect, it } from 'vitest';
import { analyze, codes, culpritIds, jar, text } from './helpers';

const QUILT_REPORT = text(
  '---- Quilt Loader: Load Error Report ----',
  'Date/Time: 2026/10/30 18:44:22.1635',
  'Quilt Loader Version: 0.26.0',
  '',
  '-- Error 1 --',
  'Cool Mod requires any version of Quilted Fabric API, which is missing!',
  '',
  '-- Error 2 --',
  'Duplicate mod: Sodium',
  '- <mods>/sodium-0.5.8.jar',
  '- <mods>/sodium-0.5.11.jar',
  'Remove all but one.',
  '',
  '-- Error 3 --',
  'Shiny Things breaks with all versions of Cool Mod, but an incompatible version is present: 1.0.0',
  '',
  '-- Mod Table --',
  '| Index | Mod | ID | Version | Plugin | File(s) |',
  '| 0 | Cool Mod | coolmod | 1.0.0 | | <mods>/coolmod-1.0.0.jar |',
  '---- end of report ----',
);

describe('Quilt loader report', () => {
  const jars = [
    jar({ file: 'coolmod-1.0.0.jar', mods: [['coolmod', 'Cool Mod']], loader: 'quilt' }),
    jar({ file: 'sodium-0.5.8.jar', mods: [['sodium', 'Sodium']], loader: 'fabric' }),
    jar({ file: 'sodium-0.5.11.jar', mods: [['sodium', 'Sodium']], loader: 'fabric' }),
    jar({ file: 'shiny-2.0.jar', mods: [['shiny', 'Shiny Things']], loader: 'quilt' }),
  ];

  it('reads missing, duplicate and breaks problems by display name', () => {
    const findings = analyze(QUILT_REPORT, 'crashReport', jars);
    expect(codes(findings)).toEqual(['C-FABRIC-INCOMPAT', 'C-FABRIC-INCOMPAT', 'C-FABRIC-INCOMPAT']);
    const [missing, dup, breaks] = findings;
    expect(missing?.title).toBe('Cool Mod needs Quilted Fabric API, which is missing');
    expect(culpritIds(missing)).toEqual(['mods/coolmod-1.0.0.jar']);
    expect(dup?.title).toBe('Sodium is installed more than once');
    expect(culpritIds(dup)).toEqual(['mods/sodium-0.5.8.jar', 'mods/sodium-0.5.11.jar']);
    // Quilt lists every copy without choosing: no automatic disable.
    expect(dup?.fixes.map((f) => f.kind)).toEqual(['manual']);
    expect(culpritIds(breaks)).toEqual(['mods/shiny-2.0.jar', 'mods/coolmod-1.0.0.jar']);
  });
});

const hsErr = (frame: string, header = '# A fatal error has been detected by the Java Runtime Environment:') =>
  text(
    '#',
    header,
    '#',
    '#  EXCEPTION_ACCESS_VIOLATION (0xc0000005) at pc=0x00007ffb1b3e4f00, pid=12345, tid=6789',
    '#',
    '# JRE version: OpenJDK Runtime Environment Temurin-17.0.8+7 (17.0.8+7) (build 17.0.8+7)',
    '# Java VM: OpenJDK 64-Bit Server VM Temurin-17.0.8+7 (17.0.8+7, mixed mode, sharing, tiered, compressed oops, g1 gc, windows-amd64)',
    '# Problematic frame:',
    frame,
    '#',
    '# The crash happened outside the Java Virtual Machine in native code.',
    '# See problematic frame for where to report the bug.',
    '#',
    '',
    '---------------  S U M M A R Y ------------',
    '',
    'Command Line: -Xmx6G -Djava.library.path=natives net.minecraft.client.main.Main --username Alex',
  );

describe('hs_err native crashes', () => {
  it.each([
    ['# C  [atio6axx.dll+0x1b3e4f]', 'AMD'],
    ['# C  [nvoglv64.dll+0x9a2f1]', 'NVIDIA'],
    ['# C  [ig9icd64.dll+0x11223]', 'Intel'],
    ['# C  [libGL.so.1+0x2a1f0]', 'Mesa'],
  ])('names the GPU driver for %s', (frame, vendor) => {
    const findings = analyze(hsErr(frame), 'hsErr');
    expect(codes(findings)).toEqual(['C-NATIVE']);
    const f = findings[0];
    expect(f?.severity).toBe('error');
    expect(f?.title).toContain(vendor);
    expect(f?.explanation).toContain('EXCEPTION_ACCESS_VIOLATION');
    expect(f?.culprits).toEqual([]);
    expect(f?.fixes[0]?.kind).toBe('manual');
  });

  it('distinguishes a JVM frame', () => {
    const [f] = analyze(hsErr('# V  [jvm.dll+0x3c2a10]'), 'hsErr');
    expect(f?.title).toBe('Native crash in jvm.dll (the Java virtual machine itself)');
  });

  it('names an overlay hook', () => {
    const [f] = analyze(hsErr('# C  [RTSSHooks64.dll+0x1234]'), 'hsErr');
    expect(f?.title).toContain('overlay');
  });

  it('reports native out-of-memory as C-OOM, not C-NATIVE', () => {
    const body = text(
      '#',
      '# There is insufficient memory for the Java Runtime Environment to continue.',
      '# Native memory allocation (mmap) failed to map 8589934592 bytes for G1 virtual space',
      '# Possible reasons:',
      '#   The system is out of physical RAM or swap space',
      '#  Out of Memory Error (os_windows.cpp:3618), pid=4242, tid=1',
      '',
      'Command Line: -Xmx16G net.minecraft.client.main.Main',
    );
    const findings = analyze(body, 'hsErr');
    expect(codes(findings)).toEqual(['C-OOM']);
    expect(findings[0]?.title).toBe('The system could not give Java enough memory');
    expect(findings[0]?.explanation).toContain('-Xmx 16 GB');
  });
});
