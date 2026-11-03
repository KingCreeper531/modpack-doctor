/** C-ROOT-CAUSE: innermost `Caused by:` of the crash, mapped to a jar (fallback only). */
import type { CrashInput, CrashPattern } from '../../model';
import {
  crashed,
  ctxOf,
  disable,
  finding,
  framesAfter,
  levelAt,
  logEvidence,
  mapFrames,
  refs,
  signalCovers,
  type Ctx,
} from '../context';
import { contiguous, simpleName, truncate, type Trace } from '../text';
import { contextual } from '../tiers';

export interface RootCause {
  cls: string;
  message: string;
  /** Line index of the innermost cause. */
  idx: number;
  /** Header lines of every segment (outermost first) for evidence. */
  segmentIdx: number[];
  /** Frames of the innermost cause first, then of the enclosing exceptions (inner → outer). */
  frameIdx: number[];
  /** Index range [start, end) of the whole trace (or the `Exception message:` line). */
  span: [number, number];
  /** This is the trace of the crash itself (crash report, or next to the log's crash marker). */
  tied: boolean;
}

const EXCEPTION_MESSAGE = /^\s*Exception message: ((?:[\w$]+\.)+[\w$]+)(?::\s?(.*))?$/;

/** Loader wrappers that only say "loading failed"; the specific findings carry the reason. */
const LOADER_WRAPPER =
  /(?:ModLoadingException|ModLoadingCrashException|FormattedException|ModResolutionException)$|^java\.lang\.Exception$/;

function fromTrace(t: Trace, tied: boolean): RootCause | null {
  const inner = t.segments[t.segments.length - 1];
  if (!inner) return null;
  const frameIdx = [...t.segments].reverse().flatMap((s) => s.frames);
  return {
    cls: inner.cls,
    message: inner.message,
    idx: inner.idx,
    segmentIdx: t.segments.map((s) => s.idx),
    frameIdx,
    span: [t.start, t.end],
    tied,
  };
}

/** First signal of the last cluster of crash markers (markers ≤ 60 lines apart). */
function lastSignalCluster(ctx: Ctx): number | undefined {
  const sig = ctx.signalIdx;
  let k = sig.length - 1;
  if (k < 0) return undefined;
  while (k > 0 && (sig[k] ?? 0) - (sig[k - 1] ?? 0) <= 60) k--;
  return sig[k];
}

function lowLevel(ctx: Ctx, i: number): boolean {
  const lvl = levelAt(ctx, i);
  return lvl === 'TRACE' || lvl === 'DEBUG' || lvl === 'INFO' || lvl === 'WARN';
}

/** The innermost cause of the crash this digest shows, or null. */
export function innermostCause(ctx: Ctx): RootCause | null {
  const kind = ctx.input.digest.source.kind;
  if (kind === 'hsErr') return null;

  // Forge/NeoForge mod-loading reports: `Exception message:` is the innermost cause.
  for (let i = 0; i < ctx.lines.length; i++) {
    const m = EXCEPTION_MESSAGE.exec(ctx.lines[i]?.text ?? '');
    if (!m) continue;
    let frameIdx: number[] = [];
    for (let j = i + 1; j < ctx.lines.length && j < i + 80 && contiguous(ctx.lines, j - 1, j); j++) {
      if ((ctx.lines[j]?.text ?? '').startsWith('Stacktrace:')) {
        frameIdx = framesAfter(ctx, j);
        break;
      }
    }
    const crashFile = kind === 'crashReport';
    return { cls: m[1] ?? '', message: (m[2] ?? '').trim(), idx: i, segmentIdx: [i], frameIdx, span: [i, i + 1], tied: crashFile };
  }

  if (kind === 'crashReport') {
    const desc = ctx.lines.findIndex((l) => l.text.startsWith('Description:'));
    const t = ctx.traces.find((tr) => tr.start > desc && !ctx.details.has(tr.start)) ?? ctx.traces[0];
    return t ? fromTrace(t, true) : null;
  }

  const candidates = ctx.traces.filter((t) => !lowLevel(ctx, t.start));
  if (candidates.length === 0) return null;
  const s = lastSignalCluster(ctx);
  if (s === undefined) {
    const last = candidates[candidates.length - 1];
    return last ? fromTrace(last, false) : null;
  }
  const near = candidates.find((t) => t.start >= s - 1 && t.start <= s + 5);
  if (near) return fromTrace(near, true);
  const before = [...candidates].reverse().find((t) => t.start < s);
  const after = candidates.find((t) => t.start > s);
  const chosen = before ?? after;
  if (!chosen) return null;
  const tied = signalCovers(ctx, s, chosen.start) || signalCovers(ctx, s, chosen.end - 1);
  return fromTrace(chosen, tied);
}

/**
 * Line-number range [first, last] of the crash's own trace when it should get a C-ROOT-CAUSE
 * unless a specific error finding already cites it; null when there is none, or when the
 * innermost cause is only a loader wrapper ("Mod loading has failed").
 */
export function crashTraceSpan(input: CrashInput): [number, number] | null {
  const ctx = ctxOf(input);
  if (!crashed(ctx)) return null;
  const rc = innermostCause(ctx);
  if (!rc || !rc.tied || LOADER_WRAPPER.test(rc.cls)) return null;
  let end = rc.span[1] - 1;
  // In a crash report the `-- Head --` category (Forge's Suspected Mods, the head stacktrace)
  // describes the same crash as the top trace.
  if (ctx.input.digest.source.kind === 'crashReport') {
    const head = ctx.lines.findIndex((l, i) => i >= rc.span[0] && l.text.startsWith('-- Head --'));
    if (head >= 0) {
      end = head;
      while (end + 1 < ctx.lines.length && !(ctx.lines[end + 1]?.text ?? '').startsWith('-- ')) end++;
    }
  }
  const first = ctx.lines[rc.span[0]]?.n;
  const last = ctx.lines[end]?.n;
  return first !== undefined && last !== undefined ? [first, last] : null;
}

export const rootCausePattern: CrashPattern = {
  id: 'root-cause',
  codes: ['C-ROOT-CAUSE'],
  anchors: contextual('Caused by: ', 'Exception message: ', 'Description: '),
  match(input) {
    const ctx = ctxOf(input);
    if (!crashed(ctx)) return [];
    const rc = innermostCause(ctx);
    // A trace far from (or on the far side of a clean shutdown from) the crash marker is not
    // the crash.
    if (!rc || !rc.tied) return [];
    const mapped = mapFrames(ctx, rc.frameIdx);
    const hit = mapped[0]?.hit;
    const culprits = refs(ctx, [hit?.jar]);
    const where = hit ? (hit.jar ? `${hit.label} (${hit.jar.fileName})` : hit.label) : null;
    const thrown = `${rc.cls}${rc.message ? `: ${truncate(rc.message, 200)}` : ''}`;
    // Method only: the bracket can carry per-launch numbers (`%23187`).
    const firstFrame = (ctx.lines[rc.frameIdx[0] ?? -1]?.text.trim() ?? '').replace(/\(.*$/, '');
    return [
      finding(ctx, {
        code: 'C-ROOT-CAUSE',
        severity: 'error',
        title: `${simpleName(rc.cls)}${rc.message ? `: ${truncate(rc.message, 90)}` : ''}${hit ? ` (in ${hit.label})` : ''}`,
        explanation:
          `The innermost cause of the crash is ${thrown}. ` +
          (where
            ? `The first stack frame outside Java, the loader and Minecraft belongs to ${where}, so that mod is the most likely cause.`
            : 'None of its stack frames could be attributed to a mod.'),
        culprits,
        evidence: [logEvidence(ctx, [rc.idx, ...rc.segmentIdx], { frames: mapped.slice(0, 5) })],
        fixes: disable(culprits[0]),
        discriminator: `${rc.cls}|${firstFrame}`,
        unresolved: hit && !hit.jar ? [hit.label] : [],
      }),
    ];
  },
};
