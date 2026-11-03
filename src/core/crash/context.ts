/**
 * Shared per-input analysis state (flattened lines, traces, crash signals) and the helpers every
 * pattern uses to gate severity, build evidence and assemble findings.
 */
import type { FixAction, JarRecord } from '../../bindings';
import type { CrashAnchor, CrashInput, Evidence, FindingCode, Finding, JarIndex, JarRef, LogLine, Severity } from '../model';
import { blameFrame, parseFrame, type FrameHit } from './frames';
import { contextual, fatal } from './tiers';
import { findingId } from './id';
import { jarRef, topLevel } from './jars';
import { contiguous, findTraces, flatten, isFrameLine, logLevel, type Level, type Line, type Trace } from './text';

/**
 * Lines that mean the game (or loading) actually failed, with their watch-mode tier. They are in
 * the anchor list so the digest and watch mode see them. Fatal = the game cannot continue.
 */
export const CRASH_SIGNALS: readonly CrashAnchor[] = [
  // Owner's fatal list: a crash report is only written for a crash.
  ...fatal('---- Minecraft Crash Report ----', '#@!@# Game crashed!'),
  // Forge/NeoForge log this (at FATAL) right after writing a crash report; vanilla prepares one
  // only when crashing.
  ...fatal('Crash report saved to', 'Preparing crash report with UUID'),
  // The JVM's main thread died: nothing else keeps the game running.
  ...fatal('Exception in thread "main"'),
  // Fabric loader's top-level failure handler (FabricLoaderImpl/FabricGuiEntry): it exits.
  ...fatal('A critical error occurred'),
  // FML mod-loading failure and the NeoForge loading-error screen (owner's list).
  ...fatal(
    'Mod Loading has failed',
    'Mod loading has failed',
    'Mod loading error has occurred',
    'Mod loading failures have occurred',
    'Loading errors encountered',
  ),
  ...fatal('Missing or unsupported mandatory dependencies'),
  // Fabric/Quilt incompatible-mod-set headers, all wordings (owner's list).
  ...fatal('Incompatible mods found!', 'Incompatible mod set!', 'Some of your mods are incompatible', 'Mod resolution encountered an incompatible mod set'),
  // Fabric loader GUI titles; each is shown only when the game is stopping.
  ...fatal('Failed to start Minecraft', 'Minecraft has crashed', 'A mod crashed on startup'),
  // A Fabric/Quilt entrypoint threw: the loader aborts the launch.
  ...fatal('Could not execute entrypoint stage'),
  // Vanilla server/client crash handlers (each is followed by a crash report).
  ...fatal('Encountered an unexpected exception', 'Unreported exception thrown'),
  // Quilt loader-phase failure report (header, its `Crashed!` title, and the report file name
  // Quilt logs to latest.log): the Quilt equivalents of the incompatible-mod-set header.
  ...fatal('---- Quilt Loader', '---- Crashed! ----', '-quilt_loader.txt'),
  // hs_err: the JVM is dead (owner's list), also when it could not even reserve memory.
  ...fatal('A fatal error has been detected by the Java Runtime Environment', 'There is insufficient memory for the Java Runtime Environment'),
  // Owner's list: ResolutionException means the module layer could not be built.
  ...fatal('java.lang.module.ResolutionException'),
  // Mentions of these are common in healthy logs (heap-dump flags, optional class probes).
  ...contextual('java.lang.OutOfMemoryError', 'UnsupportedClassVersionError'),
];

/** Signals that are exception class names: they count only where the exception is thrown. */
const THROWN_SIGNAL = /^[\w$.]*(?:OutOfMemoryError|ResolutionException|UnsupportedClassVersionError)\b/;
const THROWN_PREFIX = /^\s*(?:Exception in thread "[^"]*" |Caused by(?: \d+)?: |Exception message: )?/;
const TEXT_SIGNALS = CRASH_SIGNALS.map((s) => s.text).filter((s) => !THROWN_SIGNAL.test(s));

/** A normal shutdown: a crash marker on the far side of it belongs to another part of the session. */
const CLEAN_SHUTDOWN = /\bStopping!|\bStopping server\b/;

function isSignal(text: string): boolean {
  if (logLevel(text) === 'FATAL') return true;
  if (TEXT_SIGNALS.some((s) => text.includes(s))) return true;
  return THROWN_SIGNAL.test(text.replace(THROWN_PREFIX, ''));
}

/** Crash-report categories whose `\tKey: value` lines the loader itself writes about the failure. */
const LOADER_SECTION = /^-- (?:MOD |Mod loading issue|NO MOD INFO|Head --)/;
const SECTION_HEADER = /^-- .+ --\s*$/;
const DETAIL_VALUE = /^\t[A-Za-z][^\t:]*: /;

/**
 * Indices of crash-report details values: `\tKey: value` lines (and their `\t\t` continuations) in
 * `-- System Details --` and every other non-loader category. They describe the environment, so an
 * exception name inside one (a mod's config dump, `lastError=…`) is not a thrown exception.
 */
function detailLines(lines: readonly Line[]): Set<number> {
  const out = new Set<number>();
  let inSection = false;
  let inValue = false;
  lines.forEach((l, i) => {
    const t = l.text;
    if (i > 0 && !contiguous(lines, i - 1, i)) inSection = inValue = false;
    if (SECTION_HEADER.test(t) || t.startsWith('----')) {
      inSection = SECTION_HEADER.test(t) && !LOADER_SECTION.test(t);
      inValue = false;
      return;
    }
    if (!inSection) return;
    if (DETAIL_VALUE.test(t)) {
      out.add(i);
      inValue = true;
    } else if (inValue && t.startsWith('\t\t')) {
      out.add(i);
    } else {
      inValue = false;
    }
  });
  return out;
}

export interface Ctx {
  input: CrashInput;
  index: JarIndex | undefined;
  lines: Line[];
  traces: Trace[];
  /** The source is a crash report or hs_err file: crashed by definition. */
  crashFile: boolean;
  /** Indices of lines carrying a crash signal (or FATAL level). */
  signalIdx: number[];
  /** Indices of normal-shutdown lines (`Stopping!`). */
  shutdownIdx: number[];
  /** Crash-report details values (see `detailLines`); never read as occurrences. */
  details: ReadonlySet<number>;
  mcVersion: string | null;
}

const cache = new WeakMap<CrashInput, Ctx>();

export function ctxOf(input: CrashInput): Ctx {
  const cached = cache.get(input);
  if (cached) return cached;
  const lines = flatten(input.digest);
  const details = detailLines(lines);
  const signalIdx: number[] = [];
  const shutdownIdx: number[] = [];
  lines.forEach((l, i) => {
    if (details.has(i)) return;
    if (isSignal(l.text)) signalIdx.push(i);
    else if (CLEAN_SHUTDOWN.test(l.text)) shutdownIdx.push(i);
  });
  const kind = input.digest.source.kind;
  const ctx: Ctx = {
    input,
    index: input.index,
    lines,
    traces: findTraces(lines),
    crashFile: kind === 'crashReport' || kind === 'hsErr',
    signalIdx,
    shutdownIdx,
    details,
    mcVersion: input.pack?.mcVersion ?? mcVersionFromLines(lines),
  };
  cache.set(input, ctx);
  return ctx;
}

function mcVersionFromLines(lines: readonly Line[]): string | null {
  // `Minecraft Version ID: 1.20.5-pre1` is the canonical id; `Minecraft Version:` is the display
  // name ("1.20.5 Pre-Release 1"), so it is only a fallback and is kept whole.
  for (const { text } of lines) {
    const id = /^\tMinecraft Version ID: (\S+)/.exec(text);
    if (id?.[1]) return id[1];
  }
  for (const { text } of lines) {
    const m =
      /^\tMinecraft Version: (.+?)\s*$/.exec(text) ??
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
    const text = ctx.lines[j]?.text ?? '';
    const lvl = logLevel(text);
    if (lvl) return lvl;
    // The JVM's own uncaught-exception output (stderr appended to the log by the launcher) is a
    // record of its own, not a continuation of the log line before it.
    if (text.startsWith('Exception in thread "')) return null;
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
  if (ctx.details.has(i)) return null;
  const lvl = levelAt(ctx, i);
  if (lvl === 'TRACE' || lvl === 'DEBUG' || lvl === 'INFO') return null;
  if (lvl === 'WARN') return opts.warn === 'warning' ? 'warning' : null;
  if (ctx.crashFile || opts.fatal) return 'error';
  if (ctx.signalIdx.some((s) => signalCovers(ctx, s, i))) return 'error';
  // An ERROR the game survived: worth a warning in a log that did not crash, but noise next to
  // a real crash elsewhere in the same log (that crash gets its own finding).
  return ctx.signalIdx.length > 0 ? null : 'warning';
}

function startsRecord(text: string): boolean {
  return logLevel(text) !== null || text.startsWith('Exception in thread "');
}

/** Index range [start, end) of the log record (header line + continuation lines) containing `i`. */
export function recordRange(ctx: Ctx, i: number): [number, number] {
  let start = i;
  while (start > 0 && !startsRecord(ctx.lines[start]?.text ?? '') && contiguous(ctx.lines, start - 1, start)) start--;
  let end = i + 1;
  while (end < ctx.lines.length && contiguous(ctx.lines, end - 1, end) && !startsRecord(ctx.lines[end]?.text ?? '')) end++;
  return [start, end];
}

/** Max distance (lines) between an occurrence and a crash marker in another record. */
export const SIGNAL_REACH = 50;

/**
 * Crash marker `s` explains an occurrence at `i` when it is in the same record or stack trace,
 * or close by (`A critical error occurred` right before its trace, `Crash report saved` right
 * after) with no normal shutdown in between.
 */
export function signalCovers(ctx: Ctx, s: number, i: number): boolean {
  const [start, end] = recordRange(ctx, i);
  if (s >= start && s < end) return true;
  const trace = traceAt(ctx, i);
  if (trace && s >= trace.start && s < trace.end) return true;
  if (Math.abs(s - i) > SIGNAL_REACH) return false;
  const lo = Math.min(s, i);
  const hi = Math.max(s, i);
  return !ctx.shutdownIdx.some((d) => d > lo && d < hi);
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
