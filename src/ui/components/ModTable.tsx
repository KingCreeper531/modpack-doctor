/**
 * Mod table (DESIGN.md §6.6). Columns: status rail 4 · icon 24 · name flex · version 120 ·
 * loader 80 · Modrinth 112 · status 96 · enabled 48. 24px rows, virtualised with
 * @tanstack/react-virtual. Nested jars expand under their parent with a 16px indent and `└`.
 * Sorting is controlled (`sort` / `onSort`) so the owner can persist it per instance.
 */
import { CaretDown, CaretRight } from '@phosphor-icons/react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useEffect, useMemo, useRef, useState } from 'react';

import type { LoaderKind } from '../../bindings';
import type { Severity } from '../../core/model';
import { LoaderGlyph } from '../glyphs/LoaderGlyph';
import { LOADER_ABBR, LOADER_NAME } from '../glyphs/loaders';
import { cx } from './cx';
import { SeverityRail } from './Severity';
import { flattenTree, type SortState, type SortValue } from './sort';
import { Cell, gridTemplate, TableHeader, TableRoleContext, TableRow } from './Table';
import { Toggle } from './Toggle';

export type ModrinthMatch =
  | { state: 'matched' }
  | { state: 'update'; version: string }
  | { state: 'missing' }
  /** Lookup unavailable (offline / failed). */
  | { state: 'offline' };

export interface ModRow {
  /** Jar id. */
  id: string;
  name: string;
  modId: string | null;
  version: string | null;
  loader: LoaderKind | null;
  /** Cached Modrinth icon (already converted with `convertFileSrc`), if any. */
  iconUrl?: string | null;
  modrinth: ModrinthMatch;
  findings: { error: number; warning: number; info: number };
  enabled: boolean;
  /** Nested jars (JarJar / JiJ). */
  children?: ModRow[];
}

export type ModSortKey = 'name' | 'version' | 'loader' | 'modrinth' | 'status' | 'enabled';

const COLUMNS = [
  { key: 'rail', label: '', srLabel: 'Severity', width: '4px', flush: true },
  { key: 'icon', label: '', srLabel: 'Icon', width: '24px', flush: true, align: 'center' as const },
  { key: 'name', label: 'Name', width: 'minmax(0,1fr)', sortable: true },
  { key: 'version', label: 'Version', width: '120px', sortable: true },
  { key: 'loader', label: 'Loader', width: '80px', sortable: true },
  { key: 'modrinth', label: 'Modrinth', width: '112px', sortable: true },
  { key: 'status', label: 'Status', width: '96px', sortable: true, align: 'right' as const },
  { key: 'enabled', label: 'On', srLabel: 'Enabled', width: '48px', sortable: true, align: 'center' as const },
] as const;

export function worstSeverity(f: ModRow['findings']): Severity | null {
  return f.error ? 'error' : f.warning ? 'warning' : f.info ? 'info' : null;
}

const MODRINTH_RANK: Record<ModrinthMatch['state'], number> = { update: 0, matched: 1, missing: 2, offline: 3 };

const ACCESSOR: Record<ModSortKey, (r: ModRow) => SortValue> = {
  name: (r) => r.name,
  version: (r) => r.version,
  loader: (r) => (r.loader ? LOADER_NAME[r.loader] : null),
  modrinth: (r) => MODRINTH_RANK[r.modrinth.state],
  // Worst first when ascending: errors dominate warnings dominate info.
  status: (r) => -(r.findings.error * 1e6 + r.findings.warning * 1e3 + r.findings.info),
  enabled: (r) => r.enabled,
};

function ModrinthCell({ m }: { m: ModrinthMatch }) {
  switch (m.state) {
    case 'matched':
      return <span className="t-small text-ok">matched</span>;
    case 'update':
      return (
        <span className="flex min-w-0 items-baseline gap-1 text-signal">
          <span className="t-small">update</span>
          <span className="truncate t-mono">{m.version}</span>
        </span>
      );
    case 'missing':
      return <span className="truncate t-small text-fg-faint">not on Modrinth</span>;
    case 'offline':
      return <span className="t-mono text-fg-faint">—</span>;
  }
}

function StatusCounts({ f }: { f: ModRow['findings'] }) {
  if (!f.error && !f.warning && !f.info) return <span className="t-mono text-fg-faint">—</span>;
  return (
    <span className="flex gap-2 t-mono">
      {f.error ? <span className="text-err-text">{f.error}E</span> : null}
      {f.warning ? <span className="text-signal">{f.warning}W</span> : null}
      {f.info ? <span className="text-info">{f.info}I</span> : null}
    </span>
  );
}

export interface ModTableProps {
  rows: readonly ModRow[];
  sort: SortState<ModSortKey> | null;
  onSort: (next: SortState<ModSortKey>) => void;
  selectedId?: string | null;
  onSelect?: (id: string) => void;
  onToggleEnabled?: (id: string, next: boolean) => void;
  /** Scrolls this row into view whenever it changes (e.g. after a tile click). */
  scrollToId?: string | null;
  defaultExpanded?: readonly string[];
  /** Scroll viewport height (px); the owner sizes it in the real layout. */
  height?: number;
  className?: string;
}

export function ModTable({
  rows,
  sort,
  onSort,
  selectedId = null,
  onSelect,
  onToggleEnabled,
  scrollToId = null,
  defaultExpanded = [],
  height = 384,
  className,
}: ModTableProps) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set(defaultExpanded));
  const flat = useMemo(
    () => flattenTree(rows, expanded, sort ? ACCESSOR[sort.key] : null, sort?.dir ?? 'asc'),
    [rows, expanded, sort],
  );
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtual = useVirtualizer({
    count: flat.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 24,
    overscan: 16,
  });

  useEffect(() => {
    if (!scrollToId) return;
    const i = flat.findIndex((f) => f.row.id === scrollToId);
    if (i >= 0) virtual.scrollToIndex(i, { align: 'center' });
    // Only when the target changes, not on every re-sort, hence the narrow dependency list.
  }, [scrollToId]);

  const toggleOpen = (id: string, open?: boolean) =>
    setExpanded((s) => {
      const next = new Set(s);
      if (open ?? !next.has(id)) next.add(id);
      else next.delete(id);
      return next;
    });

  const template = gridTemplate(COLUMNS);

  return (
    <TableRoleContext.Provider value="grid">
      <div role="grid" aria-label="Mods" aria-rowcount={flat.length + 1} className={cx('flex min-w-0 flex-col', className)}>
        <TableHeader<string> columns={COLUMNS} sort={sort} onSort={(s) => onSort(s as SortState<ModSortKey>)} />
        <div ref={scrollRef} className="overflow-y-auto" style={{ height }}>
          <div role="rowgroup" className="relative w-full" style={{ height: virtual.getTotalSize() }}>
            {virtual.getVirtualItems().map((v) => {
              const f = flat[v.index]!;
              const r = f.row;
              const worst = worstSeverity(r.findings);
              return (
                <TableRow
                  key={r.id}
                  aria-label={r.name}
                  focusable
                  selected={selectedId === r.id}
                  onClick={() => onSelect?.(r.id)}
                  onKeyDown={(e) => {
                    if (e.target !== e.currentTarget) return;
                    if (e.key === 'Enter') onSelect?.(r.id);
                    else if (f.hasChildren && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) toggleOpen(r.id, e.key === 'ArrowRight');
                  }}
                  className="absolute top-0 left-0 w-full"
                  style={{ ...template, transform: `translateY(${v.start}px)` }}
                >
                  <Cell flush className="items-stretch">
                    <SeverityRail severity={worst} />
                  </Cell>
                  <Cell flush align="center" className={r.enabled ? 'text-fg-dim' : 'text-fg-faint'}>
                    {r.iconUrl ? (
                      <img src={r.iconUrl} alt="" width={16} height={16} className="size-4 rounded-1" />
                    ) : (
                      <LoaderGlyph kind={r.loader} size={16} />
                    )}
                  </Cell>
                  <Cell>
                    <span className="flex min-w-0 items-center gap-1" style={{ paddingLeft: f.depth * 16 }}>
                      {f.depth > 0 ? (
                        <span aria-hidden className="t-mono text-fg-faint">
                          └
                        </span>
                      ) : null}
                      {f.hasChildren ? (
                        <button
                          type="button"
                          aria-label={f.expanded ? `Collapse nested jars of ${r.name}` : `Expand nested jars of ${r.name}`}
                          aria-expanded={f.expanded}
                          onClick={(e) => {
                            e.stopPropagation();
                            toggleOpen(r.id);
                          }}
                          className="-ml-1 flex size-4 shrink-0 items-center justify-center text-fg-faint hover:text-fg"
                        >
                          {f.expanded ? <CaretDown size={12} /> : <CaretRight size={12} />}
                        </button>
                      ) : null}
                      <span className={cx('truncate', r.enabled ? 'text-fg' : 'text-fg-dim')}>{r.name}</span>
                      {r.modId ? <span className="shrink-[2] truncate t-mono text-fg-faint">{r.modId}</span> : null}
                      {f.hasChildren && !f.expanded ? (
                        <span className="shrink-0 t-mono text-fg-faint">+{r.children?.length}</span>
                      ) : null}
                    </span>
                  </Cell>
                  <Cell>
                    <span className="truncate t-mono text-fg-dim">{r.version ?? '—'}</span>
                  </Cell>
                  <Cell>
                    <span className="flex items-center gap-1 t-mono text-fg-dim" title={r.loader ? LOADER_NAME[r.loader] : 'No metadata'}>
                      <LoaderGlyph kind={r.loader} size={12} />
                      {r.loader ? LOADER_ABBR[r.loader] : '—'}
                    </span>
                  </Cell>
                  <Cell>
                    <ModrinthCell m={r.modrinth} />
                  </Cell>
                  <Cell align="right">
                    <StatusCounts f={r.findings} />
                  </Cell>
                  <Cell align="center" flush>
                    {f.depth === 0 ? (
                      <span onClick={(e) => e.stopPropagation()} className="flex">
                        <Toggle on={r.enabled} label={r.name} onChange={(next) => onToggleEnabled?.(r.id, next)} />
                      </span>
                    ) : (
                      <span className="t-mono text-fg-faint" title="Nested jars follow their parent">
                        ·
                      </span>
                    )}
                  </Cell>
                </TableRow>
              );
            })}
          </div>
        </div>
      </div>
    </TableRoleContext.Provider>
  );
}
