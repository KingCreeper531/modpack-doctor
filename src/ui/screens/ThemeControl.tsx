/** Theme preference (DESIGN.md §9): system / dark / light, stored in settings. A radio group. */
import type { ThemePref } from '../../bindings';
import { cx } from '../components/cx';
import { onRovingKeyDown } from '../components/roving';
import { useActions, useApp } from '../app/StoreContext';

const OPTIONS: ReadonlyArray<[ThemePref, string]> = [
  ['system', 'System'],
  ['dark', 'Dark'],
  ['light', 'Light'],
];
const OPTION_IDS = OPTIONS.map(([v]) => v);

export function ThemeControl({ className }: { className?: string }) {
  const pref = useApp((s) => s.settings.theme);
  const a = useActions();
  return (
    <div className={cx('flex items-center gap-2', className)}>
      <span id="theme-label" className="t-label text-fg-faint">
        Theme
      </span>
      <div
        role="radiogroup"
        aria-labelledby="theme-label"
        className="ml-auto flex overflow-hidden rounded-2 border border-line-strong"
        onKeyDown={(e) => onRovingKeyDown(e, OPTION_IDS, pref, a.setTheme)}
      >
        {OPTIONS.map(([value, label], i) => {
          const on = pref === value;
          return (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={on}
              tabIndex={on ? 0 : -1}
              data-roving={value}
              onClick={() => a.setTheme(value)}
              className={cx(
                'h-[22px] px-2 t-small focus-visible:outline-1 focus-visible:-outline-offset-1',
                i > 0 && 'border-l border-line-strong',
                on ? 'bg-raised font-medium text-fg' :'bg-panel text-fg-dim hover:bg-raised hover:text-fg',
              )}
            >
              {label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
