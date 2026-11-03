/** Line-level helpers over a `LogDigest`: flattening, log4j headers, exception traces. */
import type { LogDigest, LogSource } from '../../bindings';

export interface Line {
  /** 1-based line number in the original file. */
  n: number;
  text: string;
}

export type Level = 'TRACE' | 'DEBUG' | 'INFO' | 'WARN' | 'ERROR' | 'FATAL';

/**
 * Pure stand-in for the Rust digest: the whole text as one chunk with 1-based line numbers.
 * Splits on `\n` and strips one trailing `\r` per line (same as Rust).
 */
export function digestFromText(text: string, source: LogSource): LogDigest {
  const lines = text.split('\n').map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return {
    source,
    totalLines: lines.length,
    truncated: false,
    chunks: lines.length > 0 ? [{ startLine: 1, lines, reasons: [{ kind: 'head' }] }] : [],
  };
}

/** All digest lines in file order (CR-stripped defensively). */
export function flatten(digest: LogDigest): Line[] {
  const out: Line[] = [];
  for (const chunk of [...digest.chunks].sort((a, b) => a.startLine - b.startLine)) {
    chunk.lines.forEach((text, i) => {
      out.push({ n: chunk.startLine + i, text: text.endsWith('\r') ? text.slice(0, -1) : text });
    });
  }
  return out;
}

/** `[ts] [thread/LEVEL]…` (log4j, all loaders) and `[ts] [LEVEL] [ctx]:` (Fabric fallback). */
const HEADER = /^\[[^\]]*\] \[(?:[^\]]*\/)?(TRACE|DEBUG|INFO|WARN|ERROR|FATAL)\]/;

export function logLevel(text: string): Level | null {
  const m = HEADER.exec(text);
  return m ? (m[1] as Level) : null;
}

export function isLogHeader(text: string): boolean {
  return HEADER.test(text);
}

/** Message part of a log4j line (after the header and logger), or the whole line. */
export function logMessage(text: string): string {
  const m = /^\[[^\]]*\] \[[^\]]*\](?: \[[^\]]*\]| \([^)]*\))?:? ?(.*)$/.exec(text);
  return m ? (m[1] ?? '') : text;
}

const EXCEPTION_SIMPLE = /(?:Exception|Error|Throwable|Failure)$/;
const EXCEPTION_LINE = /^(?:Exception in thread "[^"]*" )?((?:[a-zA-Z_$][\w$]*\.)+[A-Z][\w$]*)(?::\s?(.*))?$/;
const CAUSED_BY = /^Caused by: ((?:[a-zA-Z_$][\w$]*\.)+[A-Za-z_$][\w$]*)(?::\s?(.*))?$/;
const FRAME_LINE = /^\s+at \S/;
const MORE_LINE = /^\s+\.\.\. \d+ (?:more|common frames omitted)/;

export interface ThrowableLine {
  cls: string;
  message: string;
}

/** A top-level (column 0) exception line, e.g. `java.lang.RuntimeException: boom`. */
export function parseExceptionLine(text: string): ThrowableLine | null {
  const m = EXCEPTION_LINE.exec(text);
  if (!m) return null;
  const cls = m[1] ?? '';
  const simple = cls.slice(cls.lastIndexOf('.') + 1);
  if (!EXCEPTION_SIMPLE.test(simple.slice(simple.lastIndexOf('$') + 1))) return null;
  return { cls, message: (m[2] ?? '').trim() };
}

/** A column-0 `Caused by: fqcn: msg` line (indented ones belong to suppressed exceptions). */
export function parseCausedBy(text: string): ThrowableLine | null {
  const m = CAUSED_BY.exec(text);
  return m ? { cls: m[1] ?? '', message: (m[2] ?? '').trim() } : null;
}

export function isFrameLine(text: string): boolean {
  return FRAME_LINE.test(text);
}

export interface Segment {
  /** Index into the flattened lines of the exception / `Caused by:` line. */
  idx: number;
  cls: string;
  message: string;
  /** Indices of this segment's `at …` frames. */
  frames: number[];
}

export interface Trace {
  /** Index of the first exception line. */
  start: number;
  /** Exclusive end index. */
  end: number;
  /** Outermost first; the last one is the innermost cause. */
  segments: Segment[];
}

/** Two flattened lines are adjacent in the original file. */
export function contiguous(lines: readonly Line[], a: number, b: number): boolean {
  const la = lines[a];
  const lb = lines[b];
  return la !== undefined && lb !== undefined && lb.n === la.n + 1;
}

/** Stack traces (Java `printStackTrace` shape) found in the flattened lines. */
export function findTraces(lines: readonly Line[]): Trace[] {
  const traces: Trace[] = [];
  let i = 0;
  while (i < lines.length) {
    const head = parseExceptionLine(lines[i]?.text ?? '');
    if (!head) {
      i++;
      continue;
    }
    const segments: Segment[] = [{ idx: i, cls: head.cls, message: head.message, frames: [] }];
    let inFrames = false;
    let j = i + 1;
    for (; j < lines.length && contiguous(lines, j - 1, j); j++) {
      const t = lines[j]?.text ?? '';
      if (t.trim() === '' || isLogHeader(t)) break;
      if (FRAME_LINE.test(t)) {
        segments[segments.length - 1]?.frames.push(j);
        inFrames = true;
        continue;
      }
      if (MORE_LINE.test(t)) {
        inFrames = true;
        continue;
      }
      const cause = parseCausedBy(t);
      if (cause) {
        segments.push({ idx: j, cls: cause.cls, message: cause.message, frames: [] });
        inFrames = false;
        continue;
      }
      if (/^\s/.test(t)) continue; // Suppressed:, nested causes, indented message lines
      if (inFrames) break; // a new column-0 line after frames: something else starts
    }
    traces.push({ start: i, end: j, segments });
    i = Math.max(j, i + 1);
  }
  return traces;
}

/** Strips Minecraft `§x` formatting codes. */
export function stripFormatting(text: string): string {
  return text.replace(/§./g, '');
}

export function simpleName(fqcn: string): string {
  return fqcn.slice(fqcn.lastIndexOf('.') + 1);
}

export function packageOf(fqcn: string): string {
  const i = fqcn.lastIndexOf('.');
  return i > 0 ? fqcn.slice(0, i) : '';
}

/** `a/b/C` → `a.b.C`; also drops a trailing `.class`/`;`. */
export function normalizeClassName(name: string): string {
  return name
    .replace(/^L(?=[\w$/]+;$)/, '')
    .replace(/;$/, '')
    .replace(/\.class$/, '')
    .replace(/\//g, '.');
}

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

export function basename(path: string): string {
  const p = path.trim().replace(/\\/g, '/');
  return p.slice(p.lastIndexOf('/') + 1);
}
