/** Log viewer row model (DESIGN.md §6.3). Pure. */
import type { FrameRef, LogLine } from '../../core/model';

export type LogRow =
  | { kind: 'line'; n: number; text: string; culprit: boolean; jarIds: string[] }
  | { kind: 'gap'; count: number };

/**
 * Interleaves `⋯ N lines` dividers wherever consecutive line numbers skip, attaches mapped
 * jars to their frame lines, and optionally marks the head/tail elided against `totalLines`.
 */
export function buildLogRows(lines: readonly LogLine[], frames: readonly FrameRef[] = [], totalLines?: number): LogRow[] {
  const byLine = new Map<number, string[]>();
  for (const f of frames) {
    const list = byLine.get(f.line) ?? [];
    if (!list.includes(f.jarId)) list.push(f.jarId);
    byLine.set(f.line, list);
  }
  const sorted = [...lines].sort((a, b) => a.n - b.n);
  const rows: LogRow[] = [];
  let prev = 0;
  for (const l of sorted) {
    if (l.n === prev) continue;
    const skipped = l.n - prev - 1;
    if (skipped > 0 && (prev > 0 || totalLines !== undefined)) rows.push({ kind: 'gap', count: skipped });
    rows.push({ kind: 'line', n: l.n, text: l.text, culprit: l.role === 'culprit', jarIds: byLine.get(l.n) ?? [] });
    prev = l.n;
  }
  if (totalLines !== undefined && prev > 0 && totalLines > prev) rows.push({ kind: 'gap', count: totalLines - prev });
  return rows;
}

/** Metadata evidence: split an excerpt into numbered lines, highlighting the given 1-based lines. */
export function excerptLines(excerpt: string, highlight: readonly number[]): LogLine[] {
  const marks = new Set(highlight);
  return excerpt
    .replace(/\r\n/g, '\n')
    .replace(/\n$/, '')
    .split('\n')
    .map((text, i): LogLine => ({ n: i + 1, text, role: marks.has(i + 1) ? 'culprit' : 'context' }));
}

/** Gutter width in characters for the largest line number shown. */
export function gutterChars(rows: readonly LogRow[]): number {
  let max = 1;
  for (const r of rows) if (r.kind === 'line' && r.n > max) max = r.n;
  return Math.max(3, String(max).length);
}

/**
 * A window of at most `max` excerpt lines for a collapsed view: it starts a few lines above the
 * first highlighted line (or at the top) so the culprit stays visible. Returns every line, with
 * `clipped: false`, when the excerpt already fits.
 */
export function clipExcerpt(lines: readonly LogLine[], max: number, lead = 2): { lines: LogLine[]; clipped: boolean } {
  if (lines.length <= max) return { lines: [...lines], clipped: false };
  const first = lines.findIndex((l) => l.role === 'culprit');
  const start = Math.max(0, Math.min(first < 0 ? 0 : first - lead, lines.length - max));
  return { lines: lines.slice(start, start + max), clipped: true };
}
