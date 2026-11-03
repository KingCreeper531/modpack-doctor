import { describe, expect, it } from 'vitest';

import { clampSize, sizeFromDrag, sizeFromKey } from '../resize';
import { ariaSort, compareValues, flattenTree, nextSort, sortRows } from '../sort';

describe('compareValues', () => {
  it('compares naturally and case-insensitively', () => {
    expect(compareValues('mod2', 'mod10')).toBeLessThan(0);
    expect(compareValues('Sodium', 'sodium')).toBe(0);
    expect(compareValues('a', 'b', 'desc')).toBeGreaterThan(0);
    expect(compareValues(3, 20)).toBeLessThan(0);
    expect(compareValues(true, false)).toBeLessThan(0);
  });

  it('sorts blanks last in both directions', () => {
    expect(compareValues(null, 'a', 'asc')).toBeGreaterThan(0);
    expect(compareValues(null, 'a', 'desc')).toBeGreaterThan(0);
    expect(compareValues('', undefined)).toBe(0);
  });
});

describe('sortRows', () => {
  const rows = [
    { n: 'b', v: 2 },
    { n: 'a', v: 1 },
    { n: 'c', v: 2 },
    { n: 'd', v: null },
  ];
  it('is stable and puts nulls last', () => {
    expect(sortRows(rows, (r) => r.v, 'asc').map((r) => r.n)).toEqual(['a', 'b', 'c', 'd']);
    expect(sortRows(rows, (r) => r.v, 'desc').map((r) => r.n)).toEqual(['b', 'c', 'a', 'd']);
  });
  it('does not mutate input', () => {
    const copy = [...rows];
    sortRows(rows, (r) => r.n, 'desc');
    expect(rows).toEqual(copy);
  });
});

describe('nextSort / ariaSort', () => {
  it('flips on the same key and resets on a new one', () => {
    expect(nextSort(null, 'name')).toEqual({ key: 'name', dir: 'asc' });
    expect(nextSort({ key: 'name', dir: 'asc' }, 'name')).toEqual({ key: 'name', dir: 'desc' });
    expect(nextSort({ key: 'name', dir: 'desc' }, 'version')).toEqual({ key: 'version', dir: 'asc' });
    expect(ariaSort({ key: 'name', dir: 'desc' }, 'name')).toBe('descending');
    expect(ariaSort({ key: 'name', dir: 'desc' }, 'size')).toBe('none');
  });
});

describe('flattenTree', () => {
  const tree = [
    { id: 'p2', name: 'zeta', children: [{ id: 'c2', name: 'b' }, { id: 'c1', name: 'a' }] },
    { id: 'p1', name: 'alpha' },
  ];
  it('keeps children under their parent and sorts per level', () => {
    const flat = flattenTree(tree, new Set(['p2']), (r) => r.name, 'asc');
    expect(flat.map((f) => [f.row.id, f.depth])).toEqual([
      ['p1', 0],
      ['p2', 0],
      ['c1', 1],
      ['c2', 1],
    ]);
    expect(flat[1]).toMatchObject({ hasChildren: true, expanded: true });
  });
  it('hides children of collapsed parents', () => {
    const flat = flattenTree(tree, new Set(), null, 'asc');
    expect(flat.map((f) => f.row.id)).toEqual(['p2', 'p1']);
    expect(flat[0]).toMatchObject({ hasChildren: true, expanded: false });
  });
});

describe('resizer clamping', () => {
  it('clamps to bounds and rounds', () => {
    expect(clampSize(100, 280, 640)).toBe(280);
    expect(clampSize(900, 280, 640)).toBe(640);
    expect(clampSize(360.4, 280, 640)).toBe(360);
    expect(clampSize(Number.NaN, 280, 640)).toBe(280);
    expect(clampSize(500, 640, 280)).toBe(500);
  });

  it('grows a right-hand inspector when dragged left', () => {
    expect(sizeFromDrag(360, 1000, 900, 'start', 280, 640)).toBe(460);
    expect(sizeFromDrag(360, 1000, 1200, 'start', 280, 640)).toBe(280);
    expect(sizeFromDrag(240, 240, 300, 'end', 200, 400)).toBe(300);
  });

  it('resizes by keyboard in 8px steps (32px with Shift)', () => {
    expect(sizeFromKey(360, 'ArrowLeft', false, 'start', 280, 640)).toBe(368);
    expect(sizeFromKey(360, 'ArrowRight', true, 'start', 280, 640)).toBe(328);
    expect(sizeFromKey(284, 'ArrowRight', false, 'start', 280, 640)).toBe(280);
    expect(sizeFromKey(360, 'Home', false, 'start', 280, 640)).toBe(280);
    expect(sizeFromKey(360, 'End', false, 'start', 280, 640)).toBe(640);
    expect(sizeFromKey(360, 'ArrowRight', false, 'end', 280, 640)).toBe(368);
    expect(sizeFromKey(360, 'Enter', false, 'start', 280, 640)).toBeNull();
  });
});
