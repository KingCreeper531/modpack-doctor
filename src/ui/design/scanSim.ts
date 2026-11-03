/**
 * /design-only scan simulator: resets N tiles to `unscanned`, then reports them done in a
 * shuffled completion order (like Rust's ScanProgress events) at a fixed rate.
 */
import { create } from 'zustand';

import type { Tile } from '../components/TileGrid';
import { JARS, rng, tilesFor } from './fixtures';

interface ScanSim {
  tiles: Tile[];
  done: number;
  running: boolean;
  startedAt: number;
  finishedAt: number;
  start: (count: number) => void;
}

const PER_TICK = 5;
const TICK_MS = 16;
let timer: number | undefined;

export const useScanSim = create<ScanSim>((set, get) => ({
  tiles: tilesFor(600, true),
  done: 600,
  running: false,
  startedAt: 0,
  finishedAt: performance.now() - 2100,
  start: (count) => {
    window.clearInterval(timer);
    const r = rng(count * 31 + Math.floor(performance.now()));
    const order = Array.from({ length: count }, (_, i) => i);
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(r() * (i + 1));
      [order[i], order[j]] = [order[j]!, order[i]!];
    }
    set({ tiles: tilesFor(count, false), done: 0, running: true, startedAt: performance.now() });
    timer = window.setInterval(() => {
      const { tiles, done } = get();
      const next = tiles.slice();
      const end = Math.min(count, done + PER_TICK);
      for (let k = done; k < end; k++) {
        const i = order[k]!;
        const jar = JARS[i]!;
        next[i] = { ...next[i]!, state: jar.final };
      }
      const finished = end >= count;
      set({ tiles: next, done: end, running: !finished, ...(finished ? { finishedAt: performance.now() } : {}) });
      if (finished) window.clearInterval(timer);
    }, TICK_MS);
  },
}));
