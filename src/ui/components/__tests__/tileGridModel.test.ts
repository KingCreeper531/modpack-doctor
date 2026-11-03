import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  easeOut,
  frameLayers,
  GAP,
  hatchSegments,
  hitTest,
  layoutGrid,
  mixColor,
  moveFocus,
  parseColor,
  PITCH,
  TILE,
  tileOrigin,
  tileTooltip,
  tileVisual,
  type FrameKind,
  type Rgba,
  type TileToken,
} from '../tileGridModel';

describe('layoutGrid', () => {
  it('uses a 14px pitch with no trailing gap', () => {
    expect(TILE).toBe(12);
    expect(GAP).toBe(2);
    expect(PITCH).toBe(14);
    // 10 columns need 10*14 - 2 = 138px.
    expect(layoutGrid(100, 138).cols).toBe(10);
    expect(layoutGrid(100, 137).cols).toBe(9);
  });

  it('computes rows and pixel size', () => {
    const l = layoutGrid(25, 138);
    expect(l).toEqual({ cols: 10, rows: 3, width: 138, height: 3 * 14 - 2 });
  });

  it('handles empty and tiny widths', () => {
    expect(layoutGrid(0, 500)).toMatchObject({ rows: 0, width: 0, height: 0 });
    expect(layoutGrid(5, 0).cols).toBe(1);
    expect(layoutGrid(3, 1000).width).toBe(3 * 14 - 2);
  });

  it('lays out 1000 tiles', () => {
    const l = layoutGrid(1000, 896);
    expect(l.cols).toBe(64);
    expect(l.rows).toBe(16);
  });
});

describe('tileOrigin / hitTest', () => {
  it('round-trips every tile', () => {
    const cols = 7;
    for (let i = 0; i < 50; i++) {
      const { x, y } = tileOrigin(i, cols);
      expect(hitTest(x, y, cols, 50)).toBe(i);
      expect(hitTest(x + TILE - 0.01, y + TILE - 0.01, cols, 50, true)).toBe(i);
    }
  });

  it('assigns gutters to the left/top tile unless strict', () => {
    expect(hitTest(12.5, 3, 5, 10)).toBe(0);
    expect(hitTest(12.5, 3, 5, 10, true)).toBeNull();
    expect(hitTest(3, 13, 5, 10, true)).toBeNull();
  });

  it('rejects points outside the grid', () => {
    expect(hitTest(-1, 0, 5, 10)).toBeNull();
    expect(hitTest(5 * 14 + 1, 0, 5, 10)).toBeNull();
    // Row 2 col 0 would be index 10, past the last tile.
    expect(hitTest(1, 2 * 14 + 1, 5, 10)).toBeNull();
  });
});

describe('moveFocus', () => {
  const cols = 4;
  const count = 10; // rows: 0-3, 4-7, 8-9
  it('moves within rows and stops at edges', () => {
    expect(moveFocus(5, 'ArrowRight', cols, count)).toBe(6);
    expect(moveFocus(7, 'ArrowRight', cols, count)).toBe(7);
    expect(moveFocus(4, 'ArrowLeft', cols, count)).toBe(4);
    expect(moveFocus(9, 'ArrowRight', cols, count)).toBe(9);
  });
  it('moves between rows and never past the last tile', () => {
    expect(moveFocus(1, 'ArrowDown', cols, count)).toBe(5);
    expect(moveFocus(6, 'ArrowDown', cols, count)).toBe(6);
    expect(moveFocus(5, 'ArrowUp', cols, count)).toBe(1);
    expect(moveFocus(1, 'ArrowUp', cols, count)).toBe(1);
  });
  it('jumps with Home/End and clamps stale indexes', () => {
    expect(moveFocus(5, 'Home', cols, count)).toBe(0);
    expect(moveFocus(5, 'End', cols, count)).toBe(9);
    expect(moveFocus(42, 'ArrowLeft', cols, count)).toBe(8);
    expect(moveFocus(0, 'End', cols, 0)).toBe(-1);
  });
});

describe('tile visuals (state → tokens and shape)', () => {
  it('maps each state to its token and distinguishing shape', () => {
    expect(tileVisual('unscanned')).toEqual({ fill: 'tile-empty', outline: 'fg-faint', notch: false, hatch: null });
    expect(tileVisual('ok')).toEqual({ fill: 'ok-fill', outline: null, notch: false, hatch: null });
    expect(tileVisual('warning')).toEqual({ fill: 'signal-fill', outline: null, notch: false, hatch: null });
    expect(tileVisual('error')).toEqual({ fill: 'err', outline: null, notch: true, hatch: null });
    expect(tileVisual('disabled')).toEqual({ fill: 'tile-off', outline: null, notch: false, hatch: 'fg-faint' });
  });

  it('gives every non-colour state a distinct shape cue', () => {
    const shapes = (['unscanned', 'error', 'disabled'] as const).map((s) => {
      const v = tileVisual(s);
      return `${!!v.outline}${v.notch}${!!v.hatch}`;
    });
    expect(new Set(shapes).size).toBe(3);
  });
});

describe('hatchSegments', () => {
  it('produces 45° segments clipped to the square', () => {
    const segs = hatchSegments(12, 4);
    expect(segs).toHaveLength(5);
    for (const [x0, y0, x1, y1] of segs) {
      for (const v of [x0, y0, x1, y1]) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(12);
      }
      expect(x0 + y0).toBeCloseTo(x1 + y1);
      expect(Math.abs(x1 - x0)).toBeCloseTo(Math.abs(y1 - y0));
    }
    expect(segs[0]).toEqual([0, 4, 4, 0]);
    expect(segs[2]).toEqual([0, 12, 12, 0]);
  });
});

describe('colour maths', () => {
  it('parses token formats', () => {
    expect(parseColor(' #7fa36b')).toEqual([127, 163, 107, 1]);
    expect(parseColor('#f2a93b1f')?.[3]).toBeCloseTo(0x1f / 255);
    expect(parseColor('#fff')).toEqual([255, 255, 255, 1]);
    expect(parseColor('rgb(0 0 0 / 0.35)')).toEqual([0, 0, 0, 0.35]);
    expect(parseColor('rgba(1, 2, 3, 0.5)')).toEqual([1, 2, 3, 0.5]);
    expect(parseColor('nonsense')).toBeNull();
  });

  it('mixes linearly and clamps t', () => {
    expect(mixColor([0, 0, 0, 1], [100, 200, 50, 1], 0.5)).toEqual([50, 100, 25, 1]);
    expect(mixColor([0, 0, 0, 1], [100, 200, 50, 1], 2)).toEqual([100, 200, 50, 1]);
  });

  it('eases out monotonically from 0 to 1', () => {
    expect(easeOut(0)).toBe(0);
    expect(easeOut(1)).toBe(1);
    let prev = 0;
    for (let x = 0.05; x < 1; x += 0.05) {
      const y = easeOut(x);
      expect(y).toBeGreaterThanOrEqual(prev);
      prev = y;
    }
    // Ease-out: well past halfway at the midpoint.
    expect(easeOut(0.5)).toBeGreaterThan(0.75);
  });
});

describe('tileTooltip', () => {
  it('formats `modid  version  ·  STATUS n`', () => {
    expect(tileTooltip({ label: 'sodium', version: '1.4.2', state: 'warning', count: 2 })).toBe('sodium  1.4.2  ·  WARN 2');
    expect(tileTooltip({ label: 'jei', version: '15.2.0', state: 'error', count: 1 })).toBe('jei  15.2.0  ·  ERR 1');
    expect(tileTooltip({ label: 'ftb', version: null, state: 'ok', count: 0 })).toBe('ftb  —  ·  OK');
    expect(tileTooltip({ label: 'x', version: '1', state: 'disabled', count: 0 })).toBe('x  1  ·  disabled');
  });
});

/** Token values per theme, read from the frozen tokens.css. */
function themeTokens(theme: 'dark' | 'light'): Record<string, Rgba> {
  const css = readFileSync(join(__dirname, '..', '..', '..', 'styles', 'tokens.css'), 'utf8');
  const block = (re: RegExp) => re.exec(css)?.[1] ?? '';
  const dark = block(/:root\[data-theme='dark'\]\s*\{([^}]*)\}/);
  const light = block(/:root\[data-theme='light'\]\s*\{([^}]*)\}/);
  const out: Record<string, Rgba> = {};
  for (const src of theme === 'dark' ? [dark] : [dark, light]) {
    for (const m of src.matchAll(/--c-([\w-]+):\s*([^;]+);/g)) {
      const c = parseColor(m[2]!);
      if (c) out[m[1]!] = c;
    }
  }
  return out;
}

function luminance([r, g, b]: Rgba): number {
  const lin = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function contrast(a: Rgba, b: Rgba): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

describe('interaction frames', () => {
  const kinds: FrameKind[] = ['selected', 'hover', 'focus'];

  it('start with a 1px panel keyline over the tile edge', () => {
    for (const k of kinds) {
      expect(frameLayers(k)[0]).toEqual({ token: 'panel', out: 0, width: 1 });
    }
  });

  it('keep every ring in the 2px gutter, never on the tile fill', () => {
    for (const k of kinds) {
      for (const layer of frameLayers(k).slice(1)) {
        expect(layer.out - layer.width).toBeGreaterThanOrEqual(0);
        expect(layer.out).toBeLessThanOrEqual(GAP);
      }
    }
    expect(frameLayers('focus')[1]).toMatchObject({ token: 'signal', width: 2 });
    expect(frameLayers('selected')[1]).toMatchObject({ token: 'signal', width: 1 });
    expect(frameLayers('hover')[1]).toMatchObject({ token: 'fg', width: 1 });
  });

  it('measure >= 3:1 against the panel they touch, in both themes', () => {
    expect(themeTokens('light').panel).not.toEqual(themeTokens('dark').panel);
    for (const theme of ['dark', 'light'] as const) {
      const t = themeTokens(theme);
      for (const k of kinds) {
        for (const layer of frameLayers(k).slice(1)) {
          const ratio = contrast(t[layer.token as TileToken]!, t.panel!);
          expect(ratio, `${theme} ${k} ${layer.token} vs panel`).toBeGreaterThanOrEqual(3);
        }
      }
    }
  });

  it('documents why the keyline exists: signal against a warning tile fails 3:1', () => {
    for (const theme of ['dark', 'light'] as const) {
      const t = themeTokens(theme);
      expect(contrast(t.signal!, t['signal-fill']!)).toBeLessThan(3);
      // The keyline (panel) is what the warning tile meets instead.
      expect(contrast(t.panel!, t['signal-fill']!)).toBeGreaterThanOrEqual(3);
    }
  });
});
