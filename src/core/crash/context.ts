/**
 * Shared per-input analysis state (flattened lines, traces, crash signals) and the helpers every
 * pattern uses to gate severity, build evidence and assemble findings.
 */
import type { FixAction, JarRecord } from '../../bindings';
import type { CrashInput, Evidence, FindingCode, Finding, JarIndex, JarRef, LogLine, Severity } from '../model';
import { blameFrame, parseFrame, type FrameHit } from './frames';
import { findingId } from './id';
import { jarRef, topLevel } from './jars';
import { contiguous, findTraces, flatten, isFrameLine, logLevel, type Level, type Line, type Trace } from './text';

/**
 * Lines that mean the game (or loading) actually failed. Kept in the anchor list so the digest
 * and watch mode see them.
 */
export const CRASH_SIGNALS: readonly string[] = [
  '---- Minecraft Crash Report ----',
  '#@!@# Game crashed!',
  'Crash report saved to',
  'Preparing crash report with UUID',
  'Exception in thread "main"',
  'A critical error occurred',
  'Mod Loading has failed',
  'Mod loading has failed',
  'Mod loading error has occurred',
  'Mod loading failures have occurred',
  'Loading errors encountered',
  'Missing or unsupported mandatory dependencies',
  'Incompatible mods found!',
  'Incompatible mod set!',
  'Some of your mods are incompatible',
  'Mod resolution encountered an incompatible mod set',
  'Failed to start Minecraft',
  'Minecraft has crashed',
  'A mod crashed on startup',
  'Could not execute entrypoint stage',
  'Encountered an unexpected exception',
  'Unreported exception thrown',
  '---- Quilt Loader',
  '---- Crashed! ----',
  'A fatal error has been detected by the Java Runtime Environment',
  'There is insufficient memory for the Java Runtime Environment',
  'java.lang.OutOfMemoryError',
  'java.lang.module.ResolutionException',
  'UnsupportedClassVersionError',
];

export interface Ctx {
  input: CrashInput;
  index: JarIndex | undefined;
  lines: Line[];
  traces: Trace[];
  /** The source is a crash report or hs_err file: crashed by definition. */
  crashFile: boolean;
  /** Indices of lines carrying a crash signal (or FATAL level). */
  signalIdx: number[];
  mcVersion: string | null;
}

const cache = new WeakMap<CrashInput, Ctx>();

export function ctxOf(input: CrashInput): Ctx {
  const cached = cache.get(input);
  if (cached) return cached;
  const lines = flatten(input.digest);
  const signalIdx: number[] = [];
  lines.forEach((l, i) => {
    if (logLevel(l.text) === 'FATAL' || CRASH_SIGNALS.some((s) => l.text.includes(s))) signalIdx.push(i);
  });
  const kind = input.digest.source.kind;
  const ctx: Ctx = {
    input,
    index: input.index,
    lines,
    traces: findTraces(lines),
    crashFile: kind === 'crashReport' || kind === 'hsErr',
    signalIdx,
    mcVersion: input.pack?.mcVersion ?? mcVersionFromLines(lines),
  };
  cache.set(input, ctx);
  return ctx;
}

function mcVersionFromLines(lines: readonly Line[]): string | null {
  for (const { text } of lines) {
    const m =
      /^\tMinecraft Version: (\S+)/.exec(text) ??
      /Loading Minecraft (\S+) with (?:Fabric|Quilt) Loader/.exec(text) ??
      /--fml\.mcVersion, ([\w.-]+)/.exec(text);
    if (m?.[1]) return m[1];
  }
  return null;
}

export function crashed(ctx: Ctx): boolean {
  return ctx.crashFile || ctx.signalIdx.length > 0;
}

/** Log level of the record line `i` belongs to (walks back over stack-trace lines); null if none. */
export function levelAt(ctx: Ctx, i: number): Level | null {
  for (let j = i, steps = 0; j >= 0 && steps < 600; j--, steps++) {
    const lvl = logLevel(ctx.lines[j]?.text ?? '');
    if (lvl) return lvl;
    if (j > 0 && !contiguous(ctx.lines, j - 1, j)) return null;
  }
  return null;
}

export interface GateOptions {
  /** What a WARN-level record yields (default: nothing). */
  warn?: 'skip' | 'warning';
  /**
   * The message itself means loading stopped (missing deps, incompatible set, JPMS conflict):
   * ERROR/FATAL/headerless → error even without a later crash marker.
   */
  fatal?: boolean;
}

/**
 * Severity for an occurrence at line `i`, or null when it must not be reported:
 * TRACE/DEBUG/INFO → null; WARN → `opts.warn`; ERROR/FATAL or no log header (crash report,
 * raw stack trace) → error when the log shows a crash at or after it (or it is inherently fatal),
 * else warning.
 */
export function gate(ctx: Ctx, i: number, opts: GateOptions = {}): Severity | null {
  const lvl = levelAt(ctx, i);
  if (lvl === 'TRACE' || lvl === 'DEBUG' || lvl === 'INFO') return null;
  if (lvl === 'WARN') return opts.warn === 'warning' ? 'warning' : null;
  if (ctx.crashFile || opts.fatal) return 'error';
  // "Followed by a crash": a signal after the line, or just before it (a header such as
  // `A critical error occurred` precedes its trace).
  return ctx.signalIdx.some((s) => s >= i - 40) ? 'error' : 'warning';
}

export function worst(a: Severity | null, b: Severity | null): Severity | null {
  const rank = (s: Severity | null): number => (s === 'error' ? 3 : s === 'warning' ? 2 : s === 'info' ? 1 : 0);
  return rank(a) >= rank(b) ? a : b;
}

/** The trace containing line `i`, if any. */
export function traceAt(ctx: Ctx, i: number): Trace | undefined {
  return ctx.traces.find((t) => i >= t.start && i < t.end);
}

export interface MappedFrame {
  idx: number;
  hit: FrameHit;
}

/** Maps frame lines to mods, skipping JDK/loader/Minecraft frames and `exclude`d jars. */
export function mapFrames(ctx: Ctx, frameIdx: readonly number[], exclude: ReadonlySet<string> = new Set()): MappedFrame[] {
  const out: MappedFrame[] = [];
  for (const idx of frameIdx) {
    const text = ctx.lines[idx]?.text ?? '';
    if (!isFrameLine(text)) continue;
    const frame = parseFrame(text);
    if (!frame) continue;
    const hit = blameFrame(frame, ctx.index);
    if (!hit) continue;
    if (hit.jar && ctx.index && exclude.has(topLevel(hit.jar, ctx.index).id)) continue;
    out.push({ idx, hit });
  }
  return out;
}

/** Frame lines following `i` (contiguous, indented `at …`), up to `max`. */
export function framesAfter(ctx: Ctx, i: number, max = 40): number[] {
  const out: number[] = [];
  for (let j = i + 1; j < ctx.lines.length && out.length < max && contiguous(ctx.lines, j - 1, j); j++) {
    const t = ctx.lines[j]?.text ?? '';
    if (isFrameLine(t)) out.push(j);
    else if (!/^\s/.test(t) || t.trim() === '') break;
  }
  return out;
}

export interface EvidenceOptions {
  /** Context lines on each side of a culprit line (default 2). */
  context?: number;
  frames?: readonly MappedFrame[];
  /** Extra lines shown as context (e.g. a block header). */
  contextIdx?: readonly number[];
  /** Hard cap on lines (default 40). */
  max?: number;
}

/** `kind: 'log'` evidence: culprit lines, nearby context and mapped frames, with original numbers. */
export function logEvidence(ctx: Ctx, culpritIdx: readonly number[], opts: EvidenceOptions = {}): Evidence {
  const radius = opts.context ?? 2;
  const max = opts.max ?? 40;
  const culprit = new Set(culpritIdx.filter((i) => ctx.lines[i] !== undefined));
  const picked = new Set<number>(culprit);
  const frames = opts.frames ?? [];
  for (const f of frames) if (picked.size < max) picked.add(f.idx);
  for (const i of opts.contextIdx ?? []) if (picked.size < max && ctx.lines[i]) picked.add(i);
  for (const i of culprit) {
    for (let d = 1; d <= radius; d++) {
      if (picked.size >= max) break;
      if (contiguous(ctx.lines, i - d, i - d + 1)) picked.add(i - d);
      if (contiguous(ctx.lines, i + d - 1, i + d)) picked.add(i + d);
    }
  }
  const order = [...picked].sort((a, b) => a - b).slice(0, Math.max(max, culprit.size));
  const lines: LogLine[] = order.flatMap((i) => {
    const l = ctx.lines[i];
    return l ? [{ n: l.n, text: l.text, role: culprit.has(i) ? 'culprit' : 'context' }] : [];
  });
  const frameRefs = ctx.index
    ? frames.flatMap((f) => {
        const l = ctx.lines[f.idx];
        return l && f.hit.jar && ctx.index ? [{ line: l.n, jarId: topLevel(f.hit.jar, ctx.index).id }] : [];
      })
    : [];
  return { kind: 'log', source: ctx.input.digest.source.id, lines, frames: frameRefs };
}

export function note(text: string): Evidence {
  return { kind: 'note', text };
}

/** Top-level JarRefs for jars, de-duplicated. */
export function refs(ctx: Ctx, jars: readonly (JarRecord | undefined)[], modId?: string): JarRef[] {
  const index = ctx.index;
  if (!index) return [];
  const seen = new Set<string>();
  const out: JarRef[] = [];
  for (const jar of jars) {
    if (!jar) continue;
    const ref = jarRef(jar, index, modId && jar.mods.some((m) => m.modId === modId) ? modId : undefined);
    if (!seen.has(ref.jarId)) {
      seen.add(ref.jarId);
      out.push(ref);
    }
  }
  return out;
}

export function disable(ref: JarRef | undefined): FixAction[] {
  return ref ? [{ kind: 'disable', jarId: ref.jarId }] : [];
}

export function manual(...steps: string[]): FixAction {
  return { kind: 'manual', steps };
}

export interface FindingDraft {
  code: FindingCode;
  severity: Severity;
  title: string;
  explanation: string;
  culprits: JarRef[];
  evidence: Evidence[];
  fixes: FixAction[];
  /** Stable discriminator for the id (config, package, mod id…). */
  discriminator: string;
  /** Names the log mentions but the index could not resolve (mod ids, jar names). */
  unresolved?: string[];
}

export const NO_INDEX_NOTE =
  'The mods folder has not been scanned yet, so names from the log could not be matched to jar files.';

export function finding(ctx: Ctx, d: FindingDraft): Finding {
  const evidence = [...d.evidence];
  const unresolved = [...new Set(d.unresolved ?? [])].filter(Boolean);
  if (!ctx.index) evidence.push(note(NO_INDEX_NOTE));
  else if (unresolved.length > 0) {
    evidence.push(note(`Not found among the active jars in the mods folder: ${unresolved.join(', ')}.`));
  }
  const explanation = d.explanation.length > 600 ? `${d.explanation.slice(0, 599)}…` : d.explanation;
  return {
    id: findingId(d.code, d.culprits.map((c) => c.jarId), d.discriminator),
    code: d.code,
    severity: d.severity,
    title: d.title.length > 160 ? `${d.title.slice(0, 159)}…` : d.title,
    explanation,
    culprits: d.culprits,
    evidence,
    fixes: d.fixes,
  };
}

/** "a", "a and b", "a, b and c". */
export function listText(items: readonly string[]): string {
  const xs = [...new Set(items)];
  if (xs.length <= 1) return xs[0] ?? '';
  return `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`;
}
