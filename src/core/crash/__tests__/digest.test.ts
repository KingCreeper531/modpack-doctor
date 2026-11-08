/** The pasted-text digest: the Rust digest's shape, bounds and selection rules in TS. */
import { describe, expect, it } from 'vitest';

import type { LogDigest } from '../../../bindings';
import { CRASH_ANCHOR_TEXTS } from '../anchors';
import { analyzeCrash } from '../analyze';
import { DEFAULT_DIGEST_OPTIONS, digestLines, digestPastedText, PASTE_MAX_CHARS, PASTE_MAX_LINES, pastedKind } from '../digest';
import { codes, source } from './helpers';

const SRC = { id: 'pasted', modifiedMs: 0, size: 0 };

function filler(from: number, to: number): string[] {
  const out: string[] = [];
  for (let i = from; i <= to; i++) out.push(`[12:00:00] [main/INFO]: filler line ${i}`);
  return out;
}

function kept(d: LogDigest): number[] {
  return d.chunks.flatMap((c) => c.lines.map((_, i) => c.startLine + i));
}

function line(d: LogDigest, n: number): string | undefined {
  for (const c of d.chunks) if (n >= c.startLine && n < c.startLine + c.lines.length) return c.lines[n - c.startLine];
  return undefined;
}

describe('digestLines', () => {
  it('keeps everything of a short log in one chunk, head and tail', () => {
    const d = digestLines(filler(1, 50), source('latestLog'), []);
    expect(d.totalLines).toBe(50);
    expect(d.truncated).toBe(false);
    expect(d.chunks).toHaveLength(1);
    expect(d.chunks[0]?.reasons).toEqual([{ kind: 'head' }, { kind: 'tail' }]);
  });

  it('keeps head, tail and context around anchors in a long log', () => {
    const lines = filler(1, 3000);
    lines[1499] = '[12:00:00] [main/ERROR]: Mod loading has failed';
    const d = digestLines(lines, source('latestLog'), ['Mod loading has failed'], { ...DEFAULT_DIGEST_OPTIONS, head: 10, tail: 10, context: 3 });
    expect(kept(d)).toEqual([...range(1, 10), ...range(1497, 1503), ...range(2991, 3000)]);
    expect(d.chunks[1]?.reasons).toEqual([{ kind: 'anchor', anchor: 'Mod loading has failed' }]);
    expect(d.truncated).toBe(false);
  });

  it('keeps a Caused by chain as a block', () => {
    const lines = [...filler(1, 500), 'Caused by: java.lang.IllegalStateException: boom', '\tat a.b.C.d(C.java:1)', '\tat a.b.C.e(C.java:2)', '', ...filler(505, 1500)];
    const d = digestLines(lines, source('latestLog'), [], { ...DEFAULT_DIGEST_OPTIONS, head: 5, tail: 5 });
    expect(kept(d)).toEqual(expect.arrayContaining([501, 502, 503]));
    expect(kept(d)).not.toContain(504);
    expect(d.chunks.find((c) => c.startLine === 501)?.reasons).toEqual([{ kind: 'block', block: 'causedByChain' }]);
  });

  it('evicts the oldest anchor window first when maxLines is reached, never the crash at the end', () => {
    const lines = filler(1, 5000);
    for (let n = 200; n <= 4000; n += 200) lines[n - 1] = `[12:00:00] [main/WARN]: Mixin apply failed ${n}`;
    lines[4899] = '---- Minecraft Crash Report ----';
    const d = digestLines(lines, source('latestLog'), ['Mixin apply failed', '---- Minecraft Crash Report ----'], {
      head: 10,
      tail: 10,
      context: 2,
      maxLines: 60,
      maxLineChars: 2000,
    });
    expect(d.truncated).toBe(true);
    expect(kept(d).length).toBeLessThanOrEqual(60);
    expect(line(d, 4900)).toBe('---- Minecraft Crash Report ----');
    expect(line(d, 200)).toBeUndefined();
  });

  it('cuts long lines like Rust', () => {
    const d = digestLines(['x'.repeat(2050)], source('latestLog'), [], DEFAULT_DIGEST_OPTIONS);
    expect(line(d, 1)).toBe(`${'x'.repeat(2000)} …[+50 chars]`);
  });
});

describe('digestPastedText', () => {
  it('strips CR, numbers lines from 1 and detects the kind', () => {
    const r = digestPastedText('---- Minecraft Crash Report ----\r\nDescription: x\r\n', CRASH_ANCHOR_TEXTS, SRC);
    expect(r.digest.source).toEqual({ ...SRC, kind: 'crashReport' });
    expect(r.digest.chunks[0]?.lines).toEqual(['---- Minecraft Crash Report ----', 'Description: x']);
    expect(r.cutLines).toBe(0);
    expect(pastedKind('# A fatal error has been detected by the Java Runtime Environment:\n')).toBe('hsErr');
    expect(pastedKind('[12:00:00] [main/INFO]: x\n')).toBe('latestLog');
  });

  it('keeps the end of text over the line limit, with the original line numbers', () => {
    const lines = filler(1, PASTE_MAX_LINES + 10);
    lines.push('Error: Could not create the Java Virtual Machine.');
    const r = digestPastedText(lines.join('\n'), CRASH_ANCHOR_TEXTS, SRC);
    expect(r.totalLines).toBe(PASTE_MAX_LINES + 11);
    expect(r.cutLines).toBe(11);
    expect(r.digest.truncated).toBe(true);
    expect(r.digest.totalLines).toBe(PASTE_MAX_LINES + 11);
    expect(line(r.digest, PASTE_MAX_LINES + 11)).toBe('Error: Could not create the Java Virtual Machine.');
    expect(r.digest.chunks[0]?.startLine).toBe(12);
    expect(codes(analyzeCrash({ digest: r.digest }))).toEqual(['C-JVM-START']);
  });

  it('keeps the end of text over the character limit', () => {
    const big = 'y'.repeat(1000);
    const n = Math.ceil(PASTE_MAX_CHARS / 1001) + 5;
    const r = digestPastedText(`${Array.from({ length: n }, () => big).join('\n')}\nlast line\n`, [], SRC);
    expect(r.cutLines).toBeGreaterThan(0);
    expect(line(r.digest, n + 1)).toBe('last line');
  });
});

function range(a: number, b: number): number[] {
  return Array.from({ length: b - a + 1 }, (_, i) => a + i);
}
