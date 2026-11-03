/**
 * Scan grid, the hero (DESIGN.md §6.1). One canvas, one 12px tile per top-level jar, 2px gap.
 *
 * - Colours are read from the token CSS variables at draw time (cached until the theme changes,
 *   which a MutationObserver on `data-theme` and the colour-scheme media query detect).
 * - At most one draw per animation frame: every change marks the canvas dirty and requests a
 *   frame; frames keep coming only while a 140ms fill cross-fade is running.
 * - Static tiles are batched into one path per state (≈ 6 fill calls for 1,000 tiles), so a full
 *   redraw costs well under a millisecond. Hit-testing is arithmetic (tileGridModel.ts).
 * - devicePixelRatio-aware backing store; re-sized on DPR or width change.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

import { cx } from './cx';
import {
  easeOut,
  FADE_MS,
  hatchSegments,
  hitTest,
  isFocusKey,
  layoutGrid,
  mixColor,
  moveFocus,
  parseColor,
  PITCH,
  rgbaString,
  TILE,
  TILE_TOKENS,
  tileOrigin,
  tileTooltip,
  tileVisual,
  type Rgba,
  type TileState,
  type TileToken,
} from './tileGridModel';
import { TooltipBox } from './Tooltip';

export interface Tile {
  /** Jar id. */
  id: string;
  /** Mod id, or the file name for jars without metadata. */
  label: string;
  version: string | null;
  state: TileState;
  /** Number of findings at the tile's severity (tooltip `WARN 2`). */
  count: number;
}

export interface TileGridProps {
  tiles: readonly Tile[];
  selectedId?: string | null;
  onSelect?: (id: string) => void;
  /** Accessible name, e.g. `Scan grid, 214 jars`. */
  label?: string;
  className?: string;
}

/** Canvas inset so the 2px focus frame of edge tiles is not clipped. */
const PAD = 2;
const HATCH = hatchSegments(TILE, 4);
const STATES: readonly TileState[] = ['unscanned', 'ok', 'warning', 'error', 'disabled'];

type Palette = Record<TileToken, Rgba>;

interface Anim {
  from: Rgba;
  start: number;
}

interface Engine {
  tiles: readonly Tile[];
  shown: TileState[];
  ids: string[];
  anims: Map<number, Anim>;
  cols: number;
  cssW: number;
  cssH: number;
  dpr: number;
  hover: number | null;
  focus: number;
  showFocus: boolean;
  selected: number;
  palette: Palette | null;
  reduced: boolean;
  raf: number;
}

function readPalette(el: Element): Palette {
  const cs = getComputedStyle(el);
  const out = {} as Palette;
  for (const t of TILE_TOKENS) out[t] = parseColor(cs.getPropertyValue(`--c-${t}`)) ?? [128, 128, 128, 1];
  return out;
}

function tilePath(ctx: CanvasRenderingContext2D, x: number, y: number, notch: boolean) {
  if (!notch) {
    ctx.rect(x, y, TILE, TILE);
    return;
  }
  ctx.moveTo(x, y);
  ctx.lineTo(x + TILE - 2, y);
  ctx.lineTo(x + TILE - 2, y + 2);
  ctx.lineTo(x + TILE, y + 2);
  ctx.lineTo(x + TILE, y + TILE);
  ctx.lineTo(x, y + TILE);
  ctx.closePath();
}

/** A square frame `w` px thick drawn `out` px outside the tile (fills, so it stays crisp). */
function frame(ctx: CanvasRenderingContext2D, x: number, y: number, out: number, w: number) {
  const s = TILE + out * 2;
  const x0 = x - out;
  const y0 = y - out;
  ctx.rect(x0, y0, s, w);
  ctx.rect(x0, y0 + s - w, s, w);
  ctx.rect(x0, y0 + w, w, s - w * 2);
  ctx.rect(x0 + s - w, y0 + w, w, s - w * 2);
}

export function TileGrid({ tiles, selectedId = null, onSelect, label, className }: TileGridProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [width, setWidth] = useState(0);
  const [tip, setTip] = useState<number | null>(null);
  const [announce, setAnnounce] = useState('');
  const eng = useRef<Engine>({
    tiles,
    shown: [],
    ids: [],
    anims: new Map(),
    cols: 1,
    cssW: 0,
    cssH: 0,
    dpr: 1,
    hover: null,
    focus: -1,
    showFocus: false,
    selected: -1,
    palette: null,
    reduced: false,
    raf: 0,
  });

  const draw = useCallback((now: number) => {
    const e = eng.current;
    e.raf = 0;
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    if (!e.palette) e.palette = readPalette(canvas);
    const p = e.palette;
    const color = (t: TileToken) => rgbaString(p[t]);

    ctx.setTransform(e.dpr, 0, 0, e.dpr, 0, 0);
    ctx.clearRect(0, 0, e.cssW, e.cssH);
    ctx.translate(PAD, PAD);

    const n = e.tiles.length;
    const cols = e.cols;
    let animating = false;

    // 1. Static fills, one path per state.
    for (const state of STATES) {
      const v = tileVisual(state);
      ctx.beginPath();
      let any = false;
      for (let i = 0; i < n; i++) {
        if (e.shown[i] !== state || e.anims.has(i)) continue;
        const { x, y } = tileOrigin(i, cols);
        tilePath(ctx, x, y, v.notch);
        any = true;
      }
      if (any) {
        ctx.fillStyle = color(v.fill);
        ctx.fill();
      }
    }

    // 2. Cross-fading fills (shape switches immediately; only the fill colour fades).
    for (const [i, a] of e.anims) {
      const state = e.shown[i];
      if (state === undefined || i >= n) {
        e.anims.delete(i);
        continue;
      }
      const v = tileVisual(state);
      const t = (now - a.start) / FADE_MS;
      if (t >= 1) e.anims.delete(i);
      else animating = true;
      const { x, y } = tileOrigin(i, cols);
      ctx.beginPath();
      tilePath(ctx, x, y, v.notch);
      ctx.fillStyle = rgbaString(mixColor(a.from, p[v.fill], easeOut(Math.max(0, t))));
      ctx.fill();
    }

    // 3. Shape marks: unscanned outline, disabled hatch.
    ctx.beginPath();
    let outlined = false;
    for (let i = 0; i < n; i++) {
      if (e.shown[i] !== 'unscanned') continue;
      const { x, y } = tileOrigin(i, cols);
      frame(ctx, x, y, 0, 1);
      outlined = true;
    }
    if (outlined) {
      ctx.fillStyle = color('fg-faint');
      ctx.fill();
    }
    const hatched: number[] = [];
    for (let i = 0; i < n; i++) if (e.shown[i] === 'disabled') hatched.push(i);
    if (hatched.length) {
      ctx.save();
      ctx.beginPath();
      for (const i of hatched) {
        const { x, y } = tileOrigin(i, cols);
        ctx.rect(x, y, TILE, TILE);
      }
      ctx.clip();
      ctx.beginPath();
      for (const i of hatched) {
        const { x, y } = tileOrigin(i, cols);
        for (const [x0, y0, x1, y1] of HATCH) {
          ctx.moveTo(x + x0, y + y0);
          ctx.lineTo(x + x1, y + y1);
        }
      }
      ctx.lineWidth = 1;
      ctx.strokeStyle = color('fg-faint');
      ctx.stroke();
      ctx.restore();
    }

    // 4. Interaction frames: selected (1px signal), hover (1px fg), keyboard focus (2px signal).
    const ring = (i: number, out: number, w: number, token: TileToken) => {
      if (i < 0 || i >= n) return;
      const { x, y } = tileOrigin(i, cols);
      ctx.beginPath();
      frame(ctx, x, y, out, w);
      ctx.fillStyle = color(token);
      ctx.fill();
    };
    ring(e.selected, 1, 1, 'signal');
    if (e.hover !== null) ring(e.hover, 1, 1, 'fg');
    if (e.showFocus) ring(e.focus, 2, 2, 'signal');

    if (animating) e.raf = requestAnimationFrame(draw);
  }, []);

  const schedule = useCallback(() => {
    const e = eng.current;
    if (!e.raf) e.raf = requestAnimationFrame(draw);
  }, [draw]);

  // Width tracking.
  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? el.clientWidth;
      setWidth(Math.floor(w));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Theme, reduced-motion and DPR listeners; cancel the frame on unmount.
  useEffect(() => {
    const e = eng.current;
    const invalidate = () => {
      e.palette = null;
      e.anims.clear();
      schedule();
    };
    const mo = new MutationObserver(invalidate);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class', 'style'] });
    const scheme = window.matchMedia('(prefers-color-scheme: dark)');
    scheme.addEventListener('change', invalidate);
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onMotion = () => {
      e.reduced = motion.matches;
      if (e.reduced) e.anims.clear();
      schedule();
    };
    onMotion();
    motion.addEventListener('change', onMotion);
    return () => {
      mo.disconnect();
      scheme.removeEventListener('change', invalidate);
      motion.removeEventListener('change', onMotion);
      if (e.raf) cancelAnimationFrame(e.raf);
      e.raf = 0;
    };
  }, [schedule]);

  const [dpr, setDpr] = useState(() => (typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1));
  useEffect(() => {
    const mq = window.matchMedia(`(resolution: ${dpr}dppx)`);
    const onChange = () => setDpr(window.devicePixelRatio || 1);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [dpr]);

  const layout = layoutGrid(tiles.length, Math.max(0, width - PAD * 2));

  // Tile diffing: start a fade for every tile whose state changed since the last render.
  useLayoutEffect(() => {
    const e = eng.current;
    const now = performance.now();
    const sameSet = e.ids.length === tiles.length && tiles.every((t, i) => e.ids[i] === t.id);
    if (!sameSet) {
      e.anims.clear();
      e.hover = null;
      e.focus = Math.min(e.focus, tiles.length - 1);
    }
    const p = e.palette;
    for (let i = 0; i < tiles.length; i++) {
      const next = tiles[i]!.state;
      const prev = sameSet ? e.shown[i] : undefined;
      if (prev !== undefined && prev !== next && !e.reduced && p) {
        const a = e.anims.get(i);
        const prevFill = p[tileVisual(prev).fill];
        const from = a ? mixColor(a.from, prevFill, easeOut(Math.min(1, (now - a.start) / FADE_MS))) : prevFill;
        e.anims.set(i, { from, start: now });
      }
      e.shown[i] = next;
    }
    e.shown.length = tiles.length;
    e.ids = tiles.map((t) => t.id);
    e.tiles = tiles;
    e.selected = selectedId === null ? -1 : e.ids.indexOf(selectedId);
    schedule();
  }, [tiles, selectedId, schedule]);

  // Backing-store size.
  useLayoutEffect(() => {
    const e = eng.current;
    const canvas = canvasRef.current;
    if (!canvas) return;
    e.cols = layout.cols;
    e.dpr = dpr;
    e.cssW = layout.width + PAD * 2;
    e.cssH = layout.height + PAD * 2;
    canvas.width = Math.round(e.cssW * dpr);
    canvas.height = Math.round(e.cssH * dpr);
    canvas.style.width = `${e.cssW}px`;
    canvas.style.height = `${e.cssH}px`;
    schedule();
  }, [layout.cols, layout.width, layout.height, dpr, schedule]);

  const indexAt = (clientX: number, clientY: number) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return null;
    return hitTest(clientX - rect.left - PAD, clientY - rect.top - PAD, eng.current.cols, eng.current.tiles.length);
  };

  const setHover = (i: number | null) => {
    const e = eng.current;
    if (e.hover === i) return;
    e.hover = i;
    setTip(i ?? (e.showFocus ? e.focus : null));
    schedule();
  };

  const tipTile = tip !== null ? tiles[tip] : undefined;
  const tipPos = tip !== null ? tileOrigin(tip, layout.cols) : null;

  return (
    <div ref={wrapRef} className={cx('relative min-w-0', className)}>
      <canvas
        ref={canvasRef}
        tabIndex={0}
        role="img"
        aria-label={label ?? `Scan grid, ${tiles.length} jars`}
        className="block"
        onPointerMove={(ev) => setHover(indexAt(ev.clientX, ev.clientY))}
        onPointerLeave={() => setHover(null)}
        onPointerDown={() => {
          eng.current.showFocus = false;
        }}
        onClick={(ev) => {
          const i = indexAt(ev.clientX, ev.clientY);
          if (i === null) return;
          eng.current.focus = i;
          schedule();
          const t = tiles[i];
          if (t) onSelect?.(t.id);
        }}
        onFocus={() => {
          const e = eng.current;
          if (e.focus < 0 && tiles.length) e.focus = Math.max(0, e.selected);
        }}
        onBlur={() => {
          eng.current.showFocus = false;
          setTip(eng.current.hover);
          schedule();
        }}
        onKeyDown={(ev) => {
          const e = eng.current;
          if (!tiles.length) return;
          if (isFocusKey(ev.key)) {
            ev.preventDefault();
            e.focus = e.showFocus ? moveFocus(e.focus, ev.key, e.cols, tiles.length) : Math.max(0, e.focus);
            e.showFocus = true;
            const t = tiles[e.focus];
            if (t) setAnnounce(tileTooltip(t));
            setTip(e.focus);
            schedule();
          } else if ((ev.key === 'Enter' || ev.key === ' ') && e.focus >= 0) {
            ev.preventDefault();
            const t = tiles[e.focus];
            if (t) onSelect?.(t.id);
          } else if (ev.key === 'Escape') {
            e.showFocus = false;
            setTip(null);
            schedule();
          }
        }}
      />
      {tipTile && tipPos ? (
        <TooltipBox
          className="absolute"
          style={
            tipPos.x > layout.width / 2
              ? { right: width - (tipPos.x + PAD + TILE), top: tipPos.y + PAD + PITCH + 2 }
              : { left: tipPos.x + PAD, top: tipPos.y + PAD + PITCH + 2 }
          }
        >
          {tileTooltip(tipTile)}
        </TooltipBox>
      ) : null}
      <div className="sr-only" aria-live="polite">
        {announce}
      </div>
    </div>
  );
}
