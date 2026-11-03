/** Table sorting (DESIGN.md §6.5, §6.6). Pure; the owner persists `SortState` per instance. */

export type SortDir = 'asc' | 'desc';

export interface SortState<K extends string = string> {
  key: K;
  dir: SortDir;
}

export type SortValue = string | number | boolean | null | undefined;

const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

/**
 * Natural, case-insensitive comparison (`mod2` < `mod10`). Empty values (null / undefined / '')
 * always sort last, whichever the direction, so blanks never crowd the top of a column.
 */
export function compareValues(a: SortValue, b: SortValue, dir: SortDir = 'asc'): number {
  const ea = a === null || a === undefined || a === '';
  const eb = b === null || b === undefined || b === '';
  if (ea || eb) return ea === eb ? 0 : ea ? 1 : -1;
  let c: number;
  if (typeof a === 'number' && typeof b === 'number') c = a - b;
  else if (typeof a === 'boolean' && typeof b === 'boolean') c = a === b ? 0 : a ? -1 : 1;
  else c = collator.compare(String(a), String(b));
  return dir === 'asc' ? c : -c;
}

/** Stable sort by `accessor`; ties keep their input order. Returns a new array. */
export function sortRows<T>(rows: readonly T[], accessor: (row: T) => SortValue, dir: SortDir): T[] {
  return rows
    .map((row, i) => ({ row, i, v: accessor(row) }))
    .sort((x, y) => compareValues(x.v, y.v, dir) || x.i - y.i)
    .map((e) => e.row);
}

/** Header click: same column flips direction, a new column starts ascending. */
export function nextSort<K extends string>(current: SortState<K> | null, key: K): SortState<K> {
  if (current && current.key === key) return { key, dir: current.dir === 'asc' ? 'desc' : 'asc' };
  return { key, dir: 'asc' };
}

/** `aria-sort` value for a header cell. */
export function ariaSort(current: SortState | null, key: string): 'ascending' | 'descending' | 'none' {
  if (!current || current.key !== key) return 'none';
  return current.dir === 'asc' ? 'ascending' : 'descending';
}

export interface TreeRow {
  id: string;
  children?: readonly TreeRow[];
}

export interface FlatRow<T> {
  row: T;
  depth: number;
  hasChildren: boolean;
  expanded: boolean;
}

/**
 * Sorts each level independently (nested jars stay under their parent) and flattens the tree,
 * descending only into expanded parents.
 */
export function flattenTree<T extends TreeRow>(
  rows: readonly T[],
  expanded: ReadonlySet<string>,
  accessor: ((row: T) => SortValue) | null,
  dir: SortDir,
  depth = 0,
): FlatRow<T>[] {
  const level = accessor ? sortRows(rows, accessor, dir) : [...rows];
  const out: FlatRow<T>[] = [];
  for (const row of level) {
    const kids = (row.children ?? []) as readonly T[];
    const open = kids.length > 0 && expanded.has(row.id);
    out.push({ row, depth, hasChildren: kids.length > 0, expanded: open });
    if (open) out.push(...flattenTree(kids, expanded, accessor, dir, depth + 1));
  }
  return out;
}
