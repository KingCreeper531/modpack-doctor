/**
 * Ruled panel (DESIGN.md §4): a full-bleed region with an 11px uppercase legend in a 32px header
 * row and right-aligned mono meta. Panels share edges with neighbours; they never float.
 *
 * `tabs` turns the legend into a row of legends that switch the panel body (FINDINGS / CRASHES).
 * The active legend reads `fg` over a 2px `signal` rule at the header's bottom edge (amber means
 * selection); the others stay `fg-faint`. Left/Right move between them.
 */
import type { HTMLAttributes, KeyboardEvent, ReactNode } from 'react';

import { cx } from './cx';

export interface PanelTab {
  id: string;
  label: string;
  /** Small mono reading after the label (a count, a pip). */
  badge?: ReactNode;
}

export interface PanelProps extends Omit<HTMLAttributes<HTMLElement>, 'title'> {
  /** Silkscreen legend, e.g. `FINDINGS`. Rendered uppercase. Ignored when `tabs` is given. */
  legend: ReactNode;
  /** Legends as tabs; `tab` is the active id and `onTab` switches. */
  tabs?: readonly PanelTab[];
  tab?: string;
  onTab?: (id: string) => void;
  /** Id of the element the tabs control (the body gets it). */
  tabPanelId?: string;
  /** Right-aligned meta: counts, timings. Mono. */
  meta?: ReactNode;
  /** Controls placed between the legend and the meta. */
  actions?: ReactNode;
  /** Control pinned to the header's right edge (after the meta), e.g. a drawer's Close. */
  end?: ReactNode;
  /** Remove the body's default padding (tables, grids and logs bring their own). */
  flush?: boolean;
  bodyClassName?: string;
  children?: ReactNode;
}

function Tabs({ tabs, tab, onTab, controls }: { tabs: readonly PanelTab[]; tab?: string | undefined; onTab?: ((id: string) => void) | undefined; controls?: string | undefined }) {
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    const i = tabs.findIndex((t) => t.id === tab);
    const next = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
    if (!next) return;
    e.preventDefault();
    onTab?.(next.id);
    const el = e.currentTarget.querySelector<HTMLElement>(`[data-tab="${next.id}"]`);
    el?.focus();
  };
  return (
    <div role="tablist" className="flex h-8 items-stretch gap-4" onKeyDown={onKey}>
      {tabs.map((t) => {
        const active = t.id === tab;
        return (
          <button
            key={t.id}
            type="button"
            role="tab"
            data-tab={t.id}
            aria-selected={active}
            aria-controls={controls}
            tabIndex={active ? 0 : -1}
            onClick={() => onTab?.(t.id)}
            className={cx(
              'relative flex items-center gap-1 t-label focus-visible:outline-1 focus-visible:-outline-offset-1',
              active ? 'text-fg' : 'text-fg-faint hover:text-fg-dim',
            )}
          >
            {t.label}
            {t.badge !== undefined ? <span className="flex items-center gap-1 t-mono normal-case tracking-normal">{t.badge}</span> : null}
            {active ? <span aria-hidden className="absolute inset-x-0 bottom-0 h-[2px] bg-signal" /> : null}
          </button>
        );
      })}
    </div>
  );
}

export function Panel({
  legend,
  tabs,
  tab,
  onTab,
  tabPanelId,
  meta,
  actions,
  end,
  flush = false,
  className,
  bodyClassName,
  children,
  ...rest
}: PanelProps) {
  return (
    <section className={cx('flex min-w-0 flex-col bg-panel', className)} {...rest}>
      <header className="flex h-8 shrink-0 items-center gap-4 border-b border-line px-4">
        {tabs ? <Tabs tabs={tabs} tab={tab} onTab={onTab} controls={tabPanelId} /> : <h2 className="t-label text-fg-faint">{legend}</h2>}
        {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
        {meta !== undefined ? <div className="ml-auto truncate t-mono text-fg-faint">{meta}</div> : null}
        {end ? <div className={cx('flex shrink-0 items-center', meta === undefined && 'ml-auto')}>{end}</div> : null}
      </header>
      <div id={tabPanelId} role={tabs ? 'tabpanel' : undefined} className={cx('min-h-0 flex-1', !flush && 'p-4', bodyClassName)}>
        {children}
      </div>
    </section>
  );
}
