/**
 * The Rust log digest (`src-tauri/src/logs/digest.rs`) for text the user pasted, in pure TS: the
 * same `LogDigest` shape, defaults and selection rules, so pasted console output goes through the
 * same crash pipeline as a file. Pasted text never leaves the webview and is never stored.
 *
 * - Input is capped at {@link PASTE_MAX_CHARS} characters and {@link PASTE_MAX_LINES} lines; when
 *   it is longer the **end** is kept (crashes are at the end) and the cut is reported, with the
 *   original line numbers.
 * - Selection, as in Rust: the first `head` lines; the last `tail` lines; `context` lines on each
 *   side of every line containing an anchor; structural blocks (crash-report head, suspected
 *   mods, `Caused by` chains, system details, mod lists, the hs_err header) kept whole up to a
 *   per-block cap. `maxLines` is a hard cap: head and tail are reserved, anchors and blocks share
 *   the rest, and when it is full the oldest anchor-only window is dropped first (then the oldest
 *   block window), so the crash near the end survives a noisy log.
 * - Lines longer than `maxLineChars` are cut and suffixed with ` …[+N chars]`.
 */
import type { ChunkReason, DigestOptions, LogBlock, LogChunk, LogDigest, LogKind, LogSource } from '../../bindings';

/** Pasted text beyond this many characters (about 5 MB) is cut from the start. */
export const PASTE_MAX_CHARS = 5_000_000;
/** Pasted text beyond this many lines is cut from the start. */
export const PASTE_MAX_LINES = 100_000;

/** The Rust defaults (`logs::digest::default_options`). */
export const DEFAULT_DIGEST_OPTIONS: DigestOptions = { head: 120, tail: 400, context: 12, maxLines: 6000, maxLineChars: 2000 };

type Shape = 'crashHead' | 'suspected' | 'loadingSection' | 'causedBy' | 'systemDetails' | 'tabbedModList' | 'quiltModTable' | 'loadingModsLine' | 'hsErr';

const BLOCK: Record<Shape, LogBlock> = {
  crashHead: 'crashHead',
  suspected: 'suspectedMods',
  loadingSection: 'suspectedMods',
  causedBy: 'causedByChain',
  systemDetails: 'systemDetails',
  tabbedModList: 'modList',
  quiltModTable: 'modList',
  loadingModsLine: 'modList',
  hsErr: 'hsErrHeader',
};

const CAP: Record<Shape, number> = {
  crashHead: 300,
  suspected: 200,
  loadingSection: 150,
  causedBy: 60,
  systemDetails: 2000,
  tabbedModList: 1500,
  quiltModTable: 1500,
  loadingModsLine: 1500,
  hsErr: 80,
};

const isBlank = (l: string): boolean => l.trim() === '';
const trimIndent = (l: string): string => l.replace(/^[\t ]+/, '');

function startsBlock(line: string): Shape | null {
  const t = trimIndent(line);
  if (line.startsWith('---- Minecraft Crash Report ----')) return 'crashHead';
  if (line.startsWith('Suspected Mod')) return 'suspected';
  if (line.startsWith('-- MOD ') || line.startsWith('-- Mod loading issue')) return 'loadingSection';
  if (t.startsWith('Caused by')) return 'causedBy';
  if (line.startsWith('-- System Details --')) return 'systemDetails';
  if (t.startsWith('Mod List:') || t.startsWith('Fabric Mods:') || t.startsWith('Quilt Mods:')) return 'tabbedModList';
  if (line.startsWith('-- Mod Table --') || line.startsWith('-- Mods --')) return 'quiltModTable';
  if (/Loading \d+ mods:$/.test(line)) return 'loadingModsLine';
  if (
    line.startsWith('# A fatal error has been detected by the Java Runtime Environment') ||
    line.startsWith('# There is insufficient memory for the Java Runtime Environment')
  ) {
    return 'hsErr';
  }
  return null;
}

function endsBefore(shape: Shape, line: string): boolean {
  switch (shape) {
    case 'crashHead':
      return false;
    case 'suspected':
      return isBlank(line) || line.startsWith('Stacktrace:') || line.startsWith('-- ');
    case 'loadingSection':
      return isBlank(line) || line.startsWith('-- ');
    case 'causedBy':
      return isBlank(line) || line.startsWith('[') || trimIndent(line).startsWith('Caused by');
    case 'systemDetails':
      return isBlank(line) || line.startsWith('#@!@#');
    case 'tabbedModList':
      return !line.startsWith('\t\t');
    case 'quiltModTable':
      return line.startsWith('-- ') || line.startsWith('----');
    case 'loadingModsLine':
      return !line.startsWith('\t');
    case 'hsErr':
      return !line.startsWith('#');
  }
}

function clip(text: string, maxChars: number): string {
  const chars = Array.from(text);
  if (chars.length <= maxChars) return text;
  return `${chars.slice(0, maxChars).join('')} …[+${chars.length - maxChars} chars]`;
}

function sameReason(a: ChunkReason, b: ChunkReason): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function addReason(list: ChunkReason[], r: ChunkReason): void {
  if (!list.some((x) => sameReason(x, r))) list.push(r);
}

interface Window {
  start: number;
  lines: string[];
  reasons: ChunkReason[];
  head: boolean;
  block: boolean;
  middle: number;
}

/**
 * Digest of `lines` (already split, CR-stripped). `firstLine` is the 1-based number of `lines[0]`
 * in the original text (> 1 when its start was cut); `totalLines` counts the whole text.
 */
export function digestLines(
  lines: readonly string[],
  source: LogSource,
  anchors: readonly string[],
  options: DigestOptions = DEFAULT_DIGEST_OPTIONS,
  firstLine = 1,
  totalLines = lines.length + firstLine - 1,
): LogDigest {
  const maxLines = Math.max(0, options.maxLines);
  const head = Math.min(options.head, maxLines);
  const tail = Math.min(options.tail, maxLines - head);
  const context = options.context;
  const maxChars = Math.max(1, options.maxLineChars);
  const middleBudget = maxLines - head - tail;
  const list = [...new Set(anchors.filter((a) => a.length > 0))];

  let truncated = firstLine > 1;
  let middleUsed = 0;
  let lastSelected = 0;
  const windows: Window[] = [];
  let blocks: { shape: Shape; remaining: number }[] = [];
  let countdown = 0;
  let openAnchors: ChunkReason[] = [];

  const evict = (): boolean => {
    truncated = true;
    const candidates = Math.max(0, windows.length - 1);
    let pick = windows.slice(0, candidates).findIndex((w) => !w.head && !w.block && w.middle > 0);
    if (pick < 0) pick = windows.slice(0, candidates).findIndex((w) => !w.head && w.middle > 0);
    if (pick < 0) return false;
    const [w] = windows.splice(pick, 1);
    middleUsed -= w?.middle ?? 0;
    return true;
  };

  const select = (no: number, text: string, reasons: readonly ChunkReason[], block: boolean): boolean => {
    if (no <= lastSelected) {
      const w = windows[windows.length - 1];
      if (w && no >= w.start) {
        for (const r of reasons) addReason(w.reasons, r);
        w.block ||= block;
      }
      return true;
    }
    const middle = no > head;
    if (middle) {
      while (middleUsed >= middleBudget) if (!evict()) return false;
      middleUsed++;
    }
    let w = windows[windows.length - 1];
    if (!w || w.start + w.lines.length !== no) {
      w = { start: no, lines: [], reasons: [], head: false, block: false, middle: 0 };
      windows.push(w);
    }
    w.lines.push(text);
    if (no <= head) {
      w.head = true;
      addReason(w.reasons, { kind: 'head' });
    }
    for (const r of reasons) addReason(w.reasons, r);
    w.block ||= block;
    if (middle) w.middle++;
    lastSelected = no;
    return true;
  };

  lines.forEach((raw, idx) => {
    const no = firstLine + idx;
    let want = no <= head;
    blocks = blocks.filter((b) => !endsBefore(b.shape, raw));
    const shape = startsBlock(raw);
    if (shape && !blocks.some((b) => b.shape === shape)) blocks.push({ shape, remaining: CAP[shape] });
    const inBlock = blocks.length > 0;
    want ||= inBlock;

    const hits = list.filter((a) => raw.includes(a));
    if (hits.length === 0) {
      if (countdown > 0) {
        countdown--;
        want = true;
      }
    } else {
      for (const a of hits) addReason(openAnchors, { kind: 'anchor', anchor: a });
      countdown = context;
      want = true;
      const from = Math.max(1, no - context);
      for (let j = Math.max(0, idx - context); j < idx; j++) {
        const n = firstLine + j;
        if (n < from || n <= lastSelected) continue;
        if (!select(n, clip(lines[j] ?? '', maxChars), openAnchors, false)) break;
      }
    }

    if (want) {
      const reasons = [...openAnchors];
      for (const b of blocks) addReason(reasons, { kind: 'block', block: BLOCK[b.shape] });
      select(no, clip(raw, maxChars), reasons, inBlock);
    }

    for (const b of blocks) b.remaining--;
    blocks = blocks.filter((b) => b.remaining > 0 && !(b.shape === 'crashHead' && raw.startsWith('A detailed walkthrough of the error')));
    if (countdown === 0) openAnchors = [];
  });

  // Tail lines not already selected.
  const last = firstLine + lines.length - 1;
  const tailFrom = tail > 0 && lines.length > 0 ? Math.max(firstLine, last - tail + 1) : null;
  if (tailFrom !== null) {
    const covered = (n: number) => windows.some((w) => n >= w.start && n < w.start + w.lines.length);
    for (let n = tailFrom; n <= last; n++) {
      if (!covered(n)) windows.push({ start: n, lines: [clip(lines[n - firstLine] ?? '', maxChars)], reasons: [], head: false, block: false, middle: 0 });
    }
    windows.sort((a, b) => a.start - b.start);
  }

  const chunks: LogChunk[] = [];
  for (const w of windows) {
    const c = chunks[chunks.length - 1];
    if (c && c.startLine + c.lines.length === w.start) {
      c.lines.push(...w.lines);
      for (const r of w.reasons) addReason(c.reasons, r);
    } else {
      chunks.push({ startLine: w.start, lines: [...w.lines], reasons: [...w.reasons] });
    }
  }
  if (tailFrom !== null) {
    for (let i = chunks.length - 1; i >= 0; i--) {
      const c = chunks[i]!;
      if (c.startLine + c.lines.length <= tailFrom) break;
      addReason(c.reasons, { kind: 'tail' });
    }
  }
  return { source, totalLines, truncated, chunks };
}

/** What kind of log pasted text looks like (decides only whether it counts as a crash file). */
export function pastedKind(text: string): LogKind {
  if (/^---- Minecraft Crash Report ----/m.test(text)) return 'crashReport';
  if (/^# (?:A fatal error has been detected by|There is insufficient memory for) the Java Runtime Environment/m.test(text)) return 'hsErr';
  return 'latestLog';
}

export interface PastedDigest {
  digest: LogDigest;
  /** Lines of the pasted text (before any cut). */
  totalLines: number;
  /** Lines left out at the start to stay within the paste limits. */
  cutLines: number;
}

/**
 * Digest of pasted text. `source.id` is the caller's (it is never a file); `kind` comes from
 * {@link pastedKind} when not given.
 */
export function digestPastedText(
  text: string,
  anchors: readonly string[],
  source: Omit<LogSource, 'kind'> & { kind?: LogKind },
  options: DigestOptions = DEFAULT_DIGEST_OPTIONS,
): PastedDigest {
  let lines = text.split('\n').map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  const totalLines = lines.length;
  let cut = Math.max(0, lines.length - PASTE_MAX_LINES);
  lines = lines.slice(cut);
  // Character cap, keeping whole lines from the end.
  let chars = 0;
  let keepFrom = lines.length;
  while (keepFrom > 0) {
    const len = (lines[keepFrom - 1]?.length ?? 0) + 1;
    if (chars + len > PASTE_MAX_CHARS) break;
    chars += len;
    keepFrom--;
  }
  if (keepFrom === lines.length && lines.length > 0) {
    // One line longer than the cap: keep its end.
    const lastLine = lines[lines.length - 1] ?? '';
    lines = [lastLine.slice(lastLine.length - (PASTE_MAX_CHARS - 1))];
    cut = totalLines - 1;
  } else {
    cut += keepFrom;
    lines = lines.slice(keepFrom);
  }
  const src: LogSource = { ...source, kind: source.kind ?? pastedKind(text) };
  const digest = digestLines(lines, src, anchors, options, cut + 1, totalLines);
  return { digest, totalLines, cutLines: cut };
}
