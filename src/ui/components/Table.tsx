/**
 * Ruled table (DESIGN.md §6.5): 24px `t-label` header over a line-strong rule, 24px body rows
 * split by hairlines, sortable headers with ▲/▼ in fg-faint, numbers right-aligned and tabular.
 * Columns are a CSS grid so the virtualised ModTable can share the header exactly.
 */
import { createContext, useContext, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react';

import { cx } from './cx';
import { ariaSort, nextSort, type SortState } from './sort';

export interface Column<T, K extends string = string> {
  key: K;
  /** Header text; empty for rail / icon columns. */
  label: string;
  /** CSS grid track, e.g. `120px` or `minmax(0,1fr)`. */
  width: string;
  align?: 'left' | 'right' | 'center';
  sortable?: boolean;
  /** Accessible header name when `label` is empty. */
  srLabel?: string;
  /** Remove cell padding (rails, toggles). */
  flush?: boolean;
  render: (row: T) => ReactNode;
}

export function gridTemplate(columns: ReadonlyArray<{ width: string }>): CSSProperties {
  return { gridTemplateColumns: columns.map((c) => c.width).join(' ') };
}

/**
 * `table` for read-only lists; `grid` when rows are selectable (ARIA only allows `aria-selected`
 * on rows of a grid). Rows and cells read it to pick `aria-selected` and `cell` / `gridcell`.
 */
export type TableRole = 'table' | 'grid';
export const TableRoleContext = createContext<TableRole>('table');

const ALIGN = { left: 'justify-start text-left', right: 'justify-end text-right', center: 'justify-center text-center' };

export function SortGlyph({ dir }: { dir: 'asc' | 'desc' | null }) {
  return (
    <span aria-hidden className={cx('w-2 t-label text-fg-faint', !dir && 'invisible')}>
      {dir === 'desc' ? '▼' : '▲'}
    </span>
  );
}

export interface TableHeaderProps<K extends string> {
  columns: ReadonlyArray<Pick<Column<unknown, K>, 'key' | 'label' | 'width' | 'align' | 'sortable' | 'srLabel' | 'flush'>>;
  sort?: SortState<K> | null;
  onSort?: (next: SortState<K>) => void;
  className?: string;
}

export function TableHeader<K extends string>({ columns, sort = null, onSort, className }: TableHeaderProps<K>) {
  return (
    <div role="row" className={cx('grid h-6 shrink-0 border-b border-line-strong bg-panel', className)} style={gridTemplate(columns)}>
      {columns.map((c) => {
        const dir = sort && sort.key === c.key ? sort.dir : null;
        const align = ALIGN[c.align ?? 'left'];
        const label = c.label || <span className="sr-only">{c.srLabel ?? c.key}</span>;
        return (
          <div
            key={c.key}
            role="columnheader"
            aria-sort={c.sortable ? ariaSort(sort, c.key) : undefined}
            className={cx('flex min-w-0 items-center', !c.flush && 'px-2', align)}
          >
            {c.sortable && onSort ? (
              <button
                type="button"
                onClick={() => onSort(nextSort(sort, c.key))}
                className={cx(
                  'flex h-6 min-w-0 items-center gap-1 t-label text-fg-faint hover:text-fg-dim',
                  c.align === 'right' && 'flex-row-reverse',
                  dir && 'text-fg-dim',
                )}
              >
                <span className="truncate">{label}</span>
                <SortGlyph dir={dir} />
              </button>
            ) : (
              <span className="truncate t-label text-fg-faint">{label}</span>
            )}
          </div>
        );
      })}
    </div>
  );
}

export interface TableRowProps {
  style?: CSSProperties;
  selected?: boolean;
  onClick?: () => void;
  onKeyDown?: (e: KeyboardEvent<HTMLDivElement>) => void;
  focusable?: boolean;
  className?: string;
  children: ReactNode;
  'aria-label'?: string;
}

/**
 * A 24px body row. Dense rows can't fit the offset focus ring, so they use the §6.5 inset 1px
 * signal outline plus `raised` instead (utilities beat the base-layer `:focus-visible` rule).
 */
export function TableRow({ style, selected = false, onClick, onKeyDown, focusable = false, className, children, ...aria }: TableRowProps) {
  const isGrid = useContext(TableRoleContext) === 'grid';
  return (
    <div
      role="row"
      tabIndex={focusable ? 0 : undefined}
      aria-selected={isGrid ? selected : undefined}
      onClick={onClick}
      onKeyDown={onKeyDown}
      style={style}
      className={cx(
        'grid h-6 items-center border-b border-line t-body text-fg-dim',
        'hover:bg-raised focus-visible:bg-raised focus-visible:outline-1 focus-visible:-outline-offset-1 focus-visible:outline-signal',
        selected && 'bg-raised text-fg outline-1 -outline-offset-1 outline-signal',
        onClick && 'cursor-default',
        className,
      )}
      {...aria}
    >
      {children}
    </div>
  );
}

export function Cell({ align = 'left', flush = false, className, children }: { align?: Column<unknown>['align']; flush?: boolean; className?: string; children: ReactNode }) {
  const role = useContext(TableRoleContext) === 'grid' ? 'gridcell' : 'cell';
  return (
    <div role={role} className={cx('flex h-full min-w-0 items-center', !flush && 'px-2', ALIGN[align], align === 'right' && 'tabular-nums', className)}>
      {children}
    </div>
  );
}

export interface TableProps<T, K extends string> {
  columns: ReadonlyArray<Column<T, K>>;
  rows: readonly T[];
  rowKey: (row: T) => string;
  sort?: SortState<K> | null;
  onSort?: (next: SortState<K>) => void;
  selectedKey?: string | null;
  onRowClick?: (row: T) => void;
  label: string;
  className?: string;
}

/** Non-virtual table for short lists (probes, data plates). Long lists: ModTable. */
export function Table<T, K extends string>({ columns, rows, rowKey, sort, onSort, selectedKey, onRowClick, label, className }: TableProps<T, K>) {
  const style = gridTemplate(columns);
  const role: TableRole = onRowClick ? 'grid' : 'table';
  return (
    <TableRoleContext.Provider value={role}>
      <div role={role} aria-label={label} className={cx('min-w-0', className)}>
        <TableHeader columns={columns} sort={sort ?? null} {...(onSort ? { onSort } : {})} />
        <div role="rowgroup">
          {rows.map((row) => {
            const key = rowKey(row);
            return (
              <TableRow
                key={key}
                style={style}
                selected={selectedKey === key}
                {...(onRowClick ? { onClick: () => onRowClick(row), focusable: true } : {})}
                onKeyDown={(e) => {
                  if (onRowClick && (e.key === 'Enter' || e.key === ' ')) {
                    e.preventDefault();
                    onRowClick(row);
                  }
                }}
              >
                {columns.map((c) => (
                  <Cell key={c.key} align={c.align ?? 'left'} flush={c.flush ?? false}>
                    {c.render(row)}
                  </Cell>
                ))}
              </TableRow>
            );
          })}
        </div>
      </div>
    </TableRoleContext.Provider>
  );
}
