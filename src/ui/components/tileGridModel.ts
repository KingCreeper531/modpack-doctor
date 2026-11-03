/**
 * Pure geometry, hit-testing, colour-state and easing maths for the scan grid (DESIGN.md §6.1).
 * No DOM access: TileGrid.tsx feeds it numbers and token values read from CSS at draw time.
 */

export const TILE = 12;
export const GAP = 2;
/** Tile pitch: one tile plus one gap. */
export const PITCH = TILE + GAP;
/** Fill cross-fade on state change (§6.1). 0 under prefers-reduced-motion. */
export const FADE_MS = 140;

export type TileState = 'unscanned' | 'ok' | 'warning' | 'error' | 'disabled';

/** CSS custom properties (without `--c-`) a tile can be painted with. */
export type TileToken = 'tile-empty' | 'ok-fill' | 'signal-fill' | 'err' | 'tile-off' | 'fg-faint' | 'fg' | 'signal' | 'panel';

export interface TileVisual {
  fill: TileToken;
  /** 1px inner outline (unscanned: hollow-looking square). */
  outline: TileToken | null;
  /** 2px notch cut from the top-right corner (error). */
  notch: boolean;
  /** 1px 45° hatch (disabled). */
  hatch: TileToken | null;
}

const VISUALS: Record<TileState, TileVisual> = {
  unscanned: { fill: 'tile-empty', outline: 'fg-faint', notch: false, hatch: null },
  ok: { fill: 'ok-fill', outline: null, notch: false, hatch: null },
  warning: { fill: 'signal-fill', outline: null, notch: false, hatch: null },
  error: { fill: 'err', outline: null, notch: true, hatch: null },
  disabled: { fill: 'tile-off', outline: null, notch: false, hatch: 'fg-faint' },
};

export function tileVisual(state: TileState): TileVisual {
  return VISUALS[state];
}

/** Every token the grid paints with; TileGrid reads exactly these from CSS each frame. */
export const TILE_TOKENS: readonly TileToken[] = [
  'tile-empty',
  'ok-fill',
  'signal-fill',
  'err',
  'tile-off',
  'fg-faint',
  'fg',
  'signal',
  'panel',
];

export type FrameKind = 'selected' | 'hover' | 'focus';

/**
 * One square band around a tile: its outer edge sits `out` px outside the tile edge and it is
 * `width` px thick (inward). `out: 0` paints over the tile's own outermost pixels.
 */
export interface FrameLayer {
  token: TileToken;
  out: number;
  width: number;
}

/**
 * Interaction frames, drawn in order. Every frame starts with a 1px `panel` keyline over the
 * tile's edge, so the ring never touches the tile fill: a `signal` ring on a `signal-fill`
 * (warning) tile would otherwise measure ~1:1 (dark) / ~1.6:1 (light). The ring then sits in
 * the 2px gutter, bounded by panel on its inside and panel or a neighbouring tile outside.
 */
const FRAMES: Record<FrameKind, readonly FrameLayer[]> = {
  selected: [
    { token: 'panel', out: 0, width: 1 },
    { token: 'signal', out: 1, width: 1 },
  ],
  hover: [
    { token: 'panel', out: 0, width: 1 },
    { token: 'fg', out: 1, width: 1 },
  ],
  focus: [
    { token: 'panel', out: 0, width: 1 },
    { token: 'signal', out: 2, width: 2 },
  ],
};

export function frameLayers(kind: FrameKind): readonly FrameLayer[] {
  return FRAMES[kind];
}

export interface GridLayout {
  cols: number;
  rows: number;
  /** CSS px; the last row has no trailing gap. 0 when there are no tiles. */
  width: number;
  height: number;
}

/** Fit as many 14px-pitch columns as `availableWidth` allows (the last column needs no gap). */
export function layoutGrid(count: number, availableWidth: number): GridLayout {
  const cols = Math.max(1, Math.floor((Math.max(0, availableWidth) + GAP) / PITCH));
  const rows = count > 0 ? Math.ceil(count / cols) : 0;
  const usedCols = Math.min(cols, Math.max(count, 1));
  return {
    cols,
    rows,
    width: count > 0 ? usedCols * PITCH - GAP : 0,
    height: rows > 0 ? rows * PITCH - GAP : 0,
  };
}

export function tileOrigin(index: number, cols: number): { x: number; y: number } {
  return { x: (index % cols) * PITCH, y: Math.floor(index / cols) * PITCH };
}

/**
 * Arithmetic hit-test (`col = x / pitch`). `strict` excludes the 2px gutters; the default
 * assigns each gutter to the tile on its left/top so the tooltip does not flicker between tiles.
 */
export function hitTest(x: number, y: number, cols: number, count: number, strict = false): number | null {
  if (x < 0 || y < 0) return null;
  const col = Math.floor(x / PITCH);
  const row = Math.floor(y / PITCH);
  if (col >= cols) return null;
  if (strict && (x - col * PITCH >= TILE || y - row * PITCH >= TILE)) return null;
  const index = row * cols + col;
  return index < count ? index : null;
}

export type FocusKey = 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown' | 'Home' | 'End';

export function isFocusKey(key: string): key is FocusKey {
  return (
    key === 'ArrowLeft' ||
    key === 'ArrowRight' ||
    key === 'ArrowUp' ||
    key === 'ArrowDown' ||
    key === 'Home' ||
    key === 'End'
  );
}

/** Next focus tile for an arrow key. Moves that would leave the grid stay put. */
export function moveFocus(index: number, key: FocusKey, cols: number, count: number): number {
  if (count <= 0) return -1;
  const i = Math.min(Math.max(index, 0), count - 1);
  switch (key) {
    case 'ArrowLeft':
      return i % cols === 0 ? i : i - 1;
    case 'ArrowRight':
      return i % cols === cols - 1 || i + 1 >= count ? i : i + 1;
    case 'ArrowUp':
      return i - cols >= 0 ? i - cols : i;
    case 'ArrowDown':
      return i + cols < count ? i + cols : i;
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
  }
}

/** Segments of the 45° hatch (`/`, lines x + y = c) clipped to a `size` square, `spacing` apart. */
export function hatchSegments(size: number, spacing: number): Array<[number, number, number, number]> {
  const out: Array<[number, number, number, number]> = [];
  for (let c = spacing; c < size * 2; c += spacing) {
    const x0 = Math.max(0, c - size);
    const y0 = Math.min(c, size);
    const x1 = Math.min(c, size);
    const y1 = Math.max(0, c - size);
    out.push([x0, y0, x1, y1]);
  }
  return out;
}

export type Rgba = readonly [number, number, number, number];

/** Parses the token formats tokens.css uses: 3/4/6/8-digit hex and `rgb()`/`rgba()`. */
export function parseColor(input: string): Rgba | null {
  const s = input.trim();
  if (s.startsWith('#')) {
    const h = s.slice(1);
    if (!/^[0-9a-f]+$/i.test(h)) return null;
    const expand = h.length === 3 || h.length === 4 ? [...h].map((c) => c + c).join('') : h;
    if (expand.length !== 6 && expand.length !== 8) return null;
    const n = (i: number) => parseInt(expand.slice(i, i + 2), 16);
    return [n(0), n(2), n(4), expand.length === 8 ? n(6) / 255 : 1];
  }
  const m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/i.exec(s);
  if (!m) return null;
  const a = m[4] === undefined ? 1 : m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
  return [Number(m[1]), Number(m[2]), Number(m[3]), a];
}

export function mixColor(a: Rgba, b: Rgba, t: number): Rgba {
  const k = Math.min(1, Math.max(0, t));
  return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k, a[3] + (b[3] - a[3]) * k];
}

export function rgbaString(c: Rgba): string {
  return `rgba(${Math.round(c[0])}, ${Math.round(c[1])}, ${Math.round(c[2])}, ${Math.round(c[3] * 1000) / 1000})`;
}

/** `cubic-bezier(0.2, 0, 0, 1)` (the design's ease-out, §8) solved for y at time x ∈ [0, 1]. */
export function easeOut(x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const x1 = 0.2;
  const y1 = 0;
  const x2 = 0;
  const y2 = 1;
  const bez = (t: number, p1: number, p2: number) => 3 * (1 - t) * (1 - t) * t * p1 + 3 * (1 - t) * t * t * p2 + t * t * t;
  // Bisection on the monotonic x(t); 24 steps is well below a device pixel of error.
  let lo = 0;
  let hi = 1;
  let t = x;
  for (let i = 0; i < 24; i++) {
    t = (lo + hi) / 2;
    if (bez(t, x1, x2) < x) lo = t;
    else hi = t;
  }
  return bez(t, y1, y2);
}

export interface TileInfo {
  /** Mod id (or file name when the jar has no metadata). */
  label: string;
  version: string | null;
  state: TileState;
  /** Findings of the tile's worst severity. */
  count: number;
}

const STATE_WORD: Record<TileState, string> = {
  unscanned: 'unscanned',
  ok: 'OK',
  warning: 'WARN',
  error: 'ERR',
  disabled: 'disabled',
};

/** Canvas tooltip text: `modid  1.4.2  ·  WARN 2` (two-space separators, §6.1). */
export function tileTooltip(t: TileInfo): string {
  const word = STATE_WORD[t.state];
  const status = (t.state === 'warning' || t.state === 'error') && t.count > 0 ? `${word} ${t.count}` : word;
  return [t.label, t.version ?? '—', '·', status].join('  ');
}
