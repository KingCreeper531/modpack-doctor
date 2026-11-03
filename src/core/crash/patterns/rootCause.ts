/** C-ROOT-CAUSE: innermost `Caused by:` of the crash, mapped to a jar (fallback only). */
import type { CrashPattern } from '../../model';
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
  type Ctx,
} from '../context';
import { contiguous, simpleName, truncate, type Trace } from '../text';

export interface RootCause {
  cls: string;
  message: string;
  /** Line index of the innermost cause. */
  idx: number;
  /** Header lines of every segment (outermost first) for evidence. */
  segmentIdx: number[];
  /** Frames of the innermost cause first, then of the enclosing exceptions (inner → outer). */
  frameIdx: number[];
}

const EXCEPTION_MESSAGE = /^\s*Exception message: ((?:[\w$]+\.)+[\w$]+)(?::\s?(.*))?$/;

function fromTrace(t: Trace): RootCause | null {
  const inner = t.segments[t.segments.length - 1];
  if (!inner) return null;
  const frameIdx = [...t.segments].reverse().flatMap((s) => s.frames);
  return { cls: inner.cls, message: inner.message, idx: inner.idx, segmentIdx: t.segments.map((s) => s.idx), frameIdx };
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
    return { cls: m[1] ?? '', message: (m[2] ?? '').trim(), idx: i, segmentIdx: [i], frameIdx };
  }

  if (kind === 'crashReport') {
    const desc = ctx.lines.findIndex((l) => l.text.startsWith('Description:'));
    const t = ctx.traces.find((tr) => tr.start > desc) ?? ctx.traces[0];
    return t ? fromTrace(t) : null;
  }

  const candidates = ctx.traces.filter((t) => !lowLevel(ctx, t.start));
  if (candidates.length === 0) return null;
  const s = ctx.signalIdx[0];
  let chosen: Trace | undefined;
  if (s === undefined) chosen = candidates[candidates.length - 1];
  else {
    chosen =
      candidates.find((t) => t.start >= s - 1 && t.start <= s + 5) ??
      [...candidates].reverse().find((t) => t.start < s) ??
      candidates.find((t) => t.start > s);
  }
  return chosen ? fromTrace(chosen) : null;
}

export const rootCausePattern: CrashPattern = {
  id: 'root-cause',
  codes: ['C-ROOT-CAUSE'],
  anchors: ['Caused by: ', 'Exception message: ', 'Description: '],
  match(input) {
    const ctx = ctxOf(input);
    if (!crashed(ctx)) return [];
    const rc = innermostCause(ctx);
    if (!rc) return [];
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
          `No more specific pattern matched, so this is the innermost cause of the crash: ${thrown}. ` +
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
