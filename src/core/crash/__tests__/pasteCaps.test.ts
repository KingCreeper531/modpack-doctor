/**
 * `digestPastedText` slices a long paste to its last PASTE_MAX_CHARS characters before it splits
 * it into lines (review L7). The result must match the plain rule (split everything, then keep
 * whole lines from the end within the caps). It must also never split a surrogate pair.
 */
import { describe, expect, it } from 'vitest';

import { digestPastedText, PASTE_MAX_CHARS, PASTE_MAX_LINES } from '../digest';

const SRC = { id: 'pasted', modifiedMs: 0, size: 0 };

/** The rule before the slice-first optimisation: lines kept and lines cut. */
function reference(text: string): { kept: string[]; cut: number; total: number } {
  let lines = text.split('\n').map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  const total = lines.length;
  let cut = Math.max(0, lines.length - PASTE_MAX_LINES);
  lines = lines.slice(cut);
  let chars = 0;
  let keepFrom = lines.length;
  while (keepFrom > 0) {
    const len = (lines[keepFrom - 1]?.length ?? 0) + 1;
    if (chars + len > PASTE_MAX_CHARS) break;
    chars += len;
    keepFrom--;
  }
  if (keepFrom === lines.length && lines.length > 0) {
    const last = lines[lines.length - 1] ?? '';
    return { kept: [last.slice(last.length - (PASTE_MAX_CHARS - 1))], cut: total - 1, total };
  }
  cut += keepFrom;
  return { kept: lines.slice(keepFrom), cut, total };
}

function kept(text: string): { kept: string[]; cut: number; total: number } {
  // A huge `tail` keeps every line, so the chunks are exactly the kept lines.
  const r = digestPastedText(text, [], SRC, { head: 0, tail: PASTE_MAX_LINES, context: 0, maxLines: PASTE_MAX_LINES + 1, maxLineChars: PASTE_MAX_CHARS });
  return { kept: r.digest.chunks.flatMap((c) => c.lines), cut: r.cutLines, total: r.totalLines };
}

describe('paste caps applied before the split', () => {
  const line = (n: number, len: number) => `${String(n).padStart(8, '0')} ${'x'.repeat(len - 9)}`;

  it.each([
    ['lines that end exactly at the slice', 1000, 0],
    ['a slice in the middle of a line', 1000, 37],
    ['a trailing newline', 999, 1],
    ['CRLF line ends', 777, 3],
  ])('%s: same lines as the plain rule', (_name, len, extra) => {
    const n = Math.ceil((2 * PASTE_MAX_CHARS) / (len + 1)) + 20;
    const sep = _name === 'CRLF line ends' ? '\r\n' : '\n';
    let text = Array.from({ length: n }, (_, i) => line(i + 1, len)).join(sep);
    text += _name === 'a trailing newline' ? '\n' : 'y'.repeat(extra);
    const want = reference(text);
    const got = kept(text);
    expect(got.total).toBe(want.total);
    expect(got.cut).toBe(want.cut);
    expect(got.kept.length).toBe(want.kept.length);
    expect(got.kept[0]).toBe(want.kept[0]);
    expect(got.kept[got.kept.length - 1]).toBe(want.kept[want.kept.length - 1]);
  });

  it('a line that starts before the slice is never kept as if it were whole', () => {
    // One short line at the end and one long line that straddles the slice start.
    const text = `${'a'.repeat(10)}\n${'b'.repeat(2 * PASTE_MAX_CHARS)}\nend\n`;
    const got = kept(text);
    expect(got.kept).toEqual(['end']);
    expect(got.cut).toBe(2);
    expect(got.total).toBe(3);
  });

  it('one huge line keeps its end without splitting a surrogate pair', () => {
    const emoji = '\u{1F525}'; // two UTF-16 code units
    const text = emoji.repeat(PASTE_MAX_CHARS + 10); // over 2 × the cap in UTF-16 units, no line break
    const got = kept(text);
    expect(got.kept).toHaveLength(1);
    const kept0 = got.kept[0] ?? '';
    expect(kept0.length).toBeLessThanOrEqual(PASTE_MAX_CHARS - 1);
    const first = kept0.charCodeAt(0);
    expect(first >= 0xdc00 && first <= 0xdfff).toBe(false);
    expect(got.cut).toBe(0);
    expect(got.total).toBe(1);
  });

  it('the line cap still applies to many short lines', () => {
    const text = Array.from({ length: PASTE_MAX_LINES + 5 }, (_, i) => `l${i + 1}`).join('\n');
    const r = digestPastedText(text, [], SRC);
    expect(r.totalLines).toBe(PASTE_MAX_LINES + 5);
    expect(r.cutLines).toBe(5);
    expect(r.digest.chunks[0]?.startLine).toBe(6);
    expect(r.digest.chunks[0]?.lines[0]).toBe('l6');
  });
});
