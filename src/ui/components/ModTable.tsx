/**
 * Mod table (DESIGN.md §6.6). Columns: status rail 4 · icon 24 · name flex · version 120 ·
 * loader 80 · Modrinth 112 · status 96 · enabled 48. 24px rows, virtualised with
 * @tanstack/react-virtual. Nested jars expand under their parent with a 16px indent and `└`.
 * Sorting is controlled (`sort` / `onSort`) so the owner can persist it per instance.
 */
import { CaretDown, CaretRight } from '@phosphor-icons/react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';

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
  /** `beta`: the suggested version is not a release (labelled `beta`). */
  | { state: 'update'; version: string; beta?: boolean }
  | { state: 'missing' }
  /** Unknown: lookup off, offline, failed, or not run yet (`—`). */
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
  /** A file a `.mrpack` index declares (not inside the zip): no toggle, its path shown. */
  declared?: boolean;
  /** Path shown under the name for declared files (`mods/sodium.jar`). */
  path?: string;
  /** Pack table only: where the file runs, short (`c req · s opt`), with words in `envTitle`. */
  env?: string | null;
  envTitle?: string;
}

export type ModSortKey = 'name' | 'version' | 'loader' | 'modrinth' | 'status' | 'enabled' | 'env';

const COLUMNS = [
  { key: 'rail', label: '', srLabel: 'Severity', width: '4px', flush: true },
  { key: 'icon', label: '', srLabel: 'Icon', width: '24px', flush: true, align: 'center' as const },
  // 160px floor: below it the name collapsed to nothing in narrow windows (M3 review).
  { key: 'name', label: 'Name', width: 'minmax(160px,1fr)', sortable: true },
  { key: 'version', label: 'Version', width: '120px', sortable: true },
  { key: 'loader', label: 'Loader', width: '80px', sortable: true },
  { key: 'modrinth', label: 'Modrinth', width: '112px', sortable: true },
  { key: 'status', label: 'Status', width: '96px', sortable: true, align: 'right' as const },
  { key: 'enabled', label: 'On', srLabel: 'Enabled', width: '48px', sortable: true, align: 'center' as const },
] as const;

/**
 * An opened `.mrpack` is read-only (CONTRACTS invariant 15): no enable toggles; the last column
 * says where each file runs instead (the index's `env`, or the override folder).
 */
const PACK_COLUMNS = [...COLUMNS.slice(0, 7), { key: 'env', label: 'Env C/S', srLabel: 'Environment, client/server', width: '80px', sortable: true }] as const;

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
  env: (r) => r.env ?? null,
};

function ModrinthCell({ m }: { m: ModrinthMatch }) {
  switch (m.state) {
    case 'matched':
      return <span className="t-small text-ok">matched</span>;
    case 'update':
      return (
        <span className="flex min-w-0 items-baseline gap-1 text-signal" title={`update ${m.version}${m.beta ? ' (beta)' : ''}`}>
          <span className="t-small">update</span>
          <span className="truncate t-mono">{m.version}</span>
          {m.beta ? <span className="shrink-0 t-small">beta</span> : null}
        </span>
      );
    case 'missing':
      return <span className="truncate t-small text-fg-faint">not on Modrinth</span>;
    case 'offline':
      return (
        <span className="t-mono text-fg-faint" title="Modrinth status unknown">
          —
        </span>
      );
  }
}

/** The 16px Modrinth icon, or the loader glyph when there is none or it fails to load. */
function RowIcon({ url, loader }: { url: string | null; loader: LoaderKind | null }) {
  const [failed, setFailed] = useState<string | null>(null);
  if (url && failed !== url) {
    return <img src={url} alt="" width={16} height={16} className="size-4 rounded-1" onError={() => setFailed(url)} data-testid="mod-icon" />;
  }
  return <LoaderGlyph kind={loader} size={16} />;
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
  /**
   * Scroll viewport height: px, or `'fill'` to take the remaining height of a flex parent via
   * CSS. Prefer `'fill'` in layouts: it never depends on ResizeObserver timing (hidden or
   * background windows don't deliver observer callbacks, which left the table at a stale size).
   */
  height?: number | 'fill';
  className?: string;
  /** `pack`: a read-only `.mrpack` (no toggles, an Env column). */
  variant?: 'instance' | 'pack';
  /** Right-click / Menu key on a row. */
  onRowContextMenu?: (id: string, e: MouseEvent<HTMLElement>) => void;
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
  variant = 'instance',
  onRowContextMenu,
}: ModTableProps) {
  const pack = variant === 'pack';
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
    // Render a screenful before the virtualizer's own observer reports the real size.
    initialRect: { width: 0, height: height === 'fill' ? 1200 : height },
  });
  const fill = height === 'fill';

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

  const columns = pack ? PACK_COLUMNS : COLUMNS;
  const template = gridTemplate(columns);

  return (
    <TableRoleContext.Provider value="grid">
      <div
        role="grid"
        aria-label="Mods"
        aria-rowcount={flat.length + 1}
        className={cx('flex min-w-0 flex-col', fill && 'h-full min-h-0', className)}
      >
        <TableHeader<string> columns={columns} sort={sort} onSort={(s) => onSort(s as SortState<ModSortKey>)} />
        <div ref={scrollRef} className={cx('overflow-y-auto', fill && 'min-h-0 flex-1')} style={fill ? undefined : { height }}>
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
                  {...(onRowContextMenu ? { onContextMenu: (e: MouseEvent<HTMLDivElement>) => onRowContextMenu(r.id, e) } : {})}
                  data-row-id={r.id}
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
                    <RowIcon url={r.iconUrl ?? null} loader={r.loader} />
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
                      {/* A declared (.mrpack index) row shows only its name: the index path is in the
                          title and the inspector, so the name never truncates to a few letters. */}
                      <span
                        className={cx('truncate', r.enabled ? 'text-fg' : 'text-fg-dim')}
                        title={r.declared && r.path ? r.path : undefined}
                      >
                        {r.name}
                      </span>
                      {r.declared && r.path ? null : r.modId ? (
                        <span className="shrink-[2] truncate t-mono text-fg-faint">{r.modId}</span>
                      ) : null}
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
                  {pack ? (
                    <Cell>
                      <span className="truncate t-mono text-fg-dim" title={r.envTitle ?? undefined}>
                        {r.env ?? '—'}
                      </span>
                    </Cell>
                  ) : (
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
                  )}
                </TableRow>
              );
            })}
          </div>
        </div>
      </div>
    </TableRoleContext.Provider>
  );
}
