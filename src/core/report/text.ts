/**
 * Report text helpers: home-folder scrubbing, Markdown escaping, evidence and fix rendering.
 * Pure (CONTRACTS invariant 3).
 */
import type { FixAction } from '../../bindings';
import type { Evidence } from '../model';

// ---- home folder → `~` -------------------------------------------------------------------------

/** Characters that must be escaped in a `u`-flag RegExp outside a class. */
function escapeRe(ch: string): string {
  return /[\\^$.*+?()[\]{}|/]/.test(ch) ? `\\${ch}` : ch;
}

/**
 * A function replacing the home folder with `~` wherever it appears in a string:
 * - separators match `\`, `/` or a run of them (`C:\Users\Bob`, `C:/Users/Bob`, `C:\\Users\\Bob`
 *   as Java escapes it, `file:///C:/Users/Bob`);
 * - case-insensitive (Windows drive letters and folder names, `c:\users\bob` in logs);
 * - a space also matches `%20` (file URLs);
 * - only whole folder names: `/home/bob` is not replaced inside `/home/bobby`.
 * An empty, root-only (`/`, `\`) or drive-only (`C:`, `C:\`) home replaces nothing.
 */
export function homeScrubber(homeDir: string): (text: string) => string {
  const home = (typeof homeDir === 'string' ? homeDir : '').trim().replace(/[\\/]+$/, '');
  if (home.length === 0 || /^[A-Za-z]:$/.test(home)) return (text) => text;
  let pattern = '';
  for (const part of home.split(/([\\/]+)/)) {
    if (part.length === 0) continue;
    if (/^[\\/]+$/.test(part)) {
      pattern += '[\\\\/]+';
      continue;
    }
    for (const ch of part) pattern += ch === ' ' ? '(?: |%20)' : escapeRe(ch);
  }
  const re = new RegExp(`${pattern}(?![\\p{L}\\p{N}_-])`, 'giu');
  return (text) => text.replace(re, '~');
}

// ---- Markdown ----------------------------------------------------------------------------------

/**
 * Inline Markdown text (headings, table cells, the middle of a line): one line, with the
 * characters GFM could read as markup escaped (`\ ` * _ [ ] < > | ~ # &`). `#` too, since a
 * trailing `#` would close an ATX heading.
 */
export function mdInline(text: string): string {
  const flat = text.replace(/\r\n|[\r\n\u2028\u2029]/g, ' ');
  return flat.replace(/[\\`*_[\]<>|~#&]/g, (c) => (c === '&' ? '&amp;' : `\\${c}`));
}

/**
 * Text that starts a block (a paragraph, a list item's content): `mdInline`, plus a leading block
 * marker (`>`, `-`, `+`, `=`, `1.`) escaped so it can never become a quote or a list.
 */
export function mdText(text: string): string {
  return mdInline(text).replace(/^(\s*)([>+=-])/, '$1\\$2').replace(/^(\s*\d+)([.)])/, '$1\\$2');
}

function longestRun(text: string, ch: string): number {
  let best = 0;
  let cur = 0;
  for (const c of text) {
    cur = c === ch ? cur + 1 : 0;
    if (cur > best) best = cur;
  }
  return best;
}

/** Inline code span that survives any backticks in `text`. */
export function mdCode(text: string): string {
  const flat = text.replace(/\r\n|[\r\n\u2028\u2029]/g, ' ');
  const fence = '`'.repeat(longestRun(flat, '`') + 1);
  const pad = flat.startsWith('`') || flat.endsWith('`') || flat.startsWith(' ') || flat.endsWith(' ') ? ' ' : '';
  return `${fence}${pad}${flat}${pad}${fence}`;
}

/** Inline code inside a GFM table cell: `|` must be escaped even in a code span. */
export function mdCellCode(text: string): string {
  return mdCode(text).replace(/\|/g, '\\|');
}

/** Fenced code block (```text) whose fence is longer than any backtick run in `text`. */
export function mdFence(text: string): string {
  const fence = '`'.repeat(Math.max(3, longestRun(text, '`') + 1));
  return `${fence}text\n${text.replace(/\r\n?/g, '\n')}\n${fence}`;
}

// ---- evidence ----------------------------------------------------------------------------------

/** Lines around each highlighted line shown in a metadata excerpt. */
const CONTEXT_LINES = 2;
/** Lines shown from an excerpt without highlights. */
const HEAD_LINES = 12;

function numbered(entries: readonly { n: number; text: string; mark: boolean }[]): string[] {
  const width = String(entries.reduce((m, e) => Math.max(m, e.n), 0)).length;
  const out: string[] = [];
  let prev: number | null = null;
  for (const e of entries) {
    if (prev !== null && e.n > prev + 1) out.push(`  ${' '.repeat(width)} | …`);
    out.push(`${e.mark ? '>' : ' '} ${String(e.n).padStart(width)} | ${e.text}`);
    prev = e.n;
  }
  return out;
}

/**
 * Evidence as text: one string per item (lines joined by `\n`).
 * - metadata: `<jar path>!/<file>`, then the highlighted lines (`>`) with two lines of context,
 *   numbered as in the file; without highlights, the first 12 lines;
 * - log: `<source>`, then its lines with their numbers (`>` = culprit line);
 * - note: the text.
 * `jarPath` maps a jar id to the path shown (relative to the game dir).
 */
export function evidenceText(e: Evidence, jarPath: (jarId: string) => string): string {
  switch (e.kind) {
    case 'note':
      return e.text;
    case 'metadata': {
      const lines = e.excerpt.split(/\r?\n/);
      const marked = new Set(e.highlight.filter((n) => Number.isInteger(n) && n >= 1 && n <= lines.length));
      const keep = new Set<number>();
      if (marked.size === 0) for (let n = 1; n <= Math.min(lines.length, HEAD_LINES); n++) keep.add(n);
      for (const h of marked) for (let n = h - CONTEXT_LINES; n <= h + CONTEXT_LINES; n++) if (n >= 1 && n <= lines.length) keep.add(n);
      const entries = [...keep].sort((a, b) => a - b).map((n) => ({ n, text: lines[n - 1] ?? '', mark: marked.has(n) }));
      const body = numbered(entries);
      const last = entries.at(-1)?.n ?? 0;
      if (last < lines.length && !(lines.length === last + 1 && lines[last] === '')) body.push('  …');
      return [`${jarPath(e.jarId)}!/${e.file}`, ...body].join('\n');
    }
    case 'log': {
      const entries = [...e.lines].sort((a, b) => a.n - b.n).map((l) => ({ n: l.n, text: l.text, mark: l.role === 'culprit' }));
      return [e.source, ...numbered(entries)].join('\n');
    }
  }
}

// ---- fixes -------------------------------------------------------------------------------------

/** What the labeler knows about a Modrinth version id. */
export interface VersionFacts {
  versionNumber: string;
  title: string | null;
  beta: boolean;
}

/**
 * Human label of a fix (the report never executes anything): `Disable sodium-0.5.8.jar`,
 * `Enable x.jar.disabled`, `Remove b.jar (moved to a backup), keep a.jar`,
 * `Replace sodium-0.5.8.jar with Sodium 0.5.11` / `… with version <id>`,
 * `Install Cloth Config API 11.1.136` / `Install cloth-config (version <id>)`,
 * `Manual: <steps>`.
 */
export function fixLabel(fix: FixAction, name: (jarId: string) => string, version: (versionId: string) => VersionFacts | undefined): string {
  const beta = (v: VersionFacts): string => (v.beta ? ' (beta)' : '');
  switch (fix.kind) {
    case 'disable':
      return `Disable ${name(fix.jarId)}`;
    case 'enable':
      return `Enable ${name(fix.jarId)}`;
    case 'removeDuplicate':
      return `Remove ${name(fix.remove)} (moved to a backup), keep ${name(fix.keep)}`;
    case 'replace': {
      const v = version(fix.versionId);
      return v
        ? `Replace ${name(fix.jarId)} with ${v.title ? `${v.title} ` : 'version '}${v.versionNumber}${beta(v)}`
        : `Replace ${name(fix.jarId)} with version ${fix.versionId}`;
    }
    case 'installDependency': {
      const v = version(fix.versionId);
      return v ? `Install ${v.title ?? fix.modId} ${v.versionNumber}${beta(v)}` : `Install ${fix.modId} (version ${fix.versionId})`;
    }
    case 'manual': {
      const steps = fix.steps.map((s) => s.trim()).filter((s) => s.length > 0);
      return steps.length > 0 ? `Manual: ${steps.join(' ')}` : 'Manual steps';
    }
  }
}
