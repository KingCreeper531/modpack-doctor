/**
 * Toggle (DESIGN.md §6.5): 28×14 track, square 10px thumb. On = ok-fill track, off = tile-off.
 * The thumb is the defining mark (≥ 3:1 against its track and the panel); `aria-pressed` and the
 * accessible label both change with the state.
 */
import { cx } from './cx';

export interface ToggleProps {
  on: boolean;
  onChange?: (next: boolean) => void;
  /** What is toggled, e.g. the mod name. The accessible name becomes `<label> enabled|disabled`. */
  label: string;
  /** Show the state word (`on` / `off`) beside the track. */
  showState?: boolean;
  disabled?: boolean;
  className?: string;
}

export function Toggle({ on, onChange, label, showState = false, disabled = false, className }: ToggleProps) {
  return (
    <button
      type="button"
      aria-pressed={on}
      aria-label={`${label} ${on ? 'enabled' : 'disabled'}`}
      disabled={disabled}
      onClick={() => onChange?.(!on)}
      className={cx('inline-flex items-center gap-2 disabled:cursor-not-allowed disabled:opacity-60', className)}
    >
      <span
        aria-hidden
        className={cx('relative block h-[14px] w-[28px] shrink-0 rounded-1', on ? 'bg-ok-fill' : 'bg-tile-off')}
      >
        <span
          className={cx('absolute top-[2px] left-[2px] block size-[10px]', on ? 'bg-bg' : 'bg-fg-faint')}
          style={{
            transform: on ? 'translateX(14px)' : 'translateX(0)',
            transition: 'transform var(--dur-fast) var(--ease-out)',
          }}
        />
      </span>
      {showState ? <span className={cx('t-mono', on ? 'text-ok' : 'text-fg-faint')}>{on ? 'on' : 'off'}</span> : null}
    </button>
  );
}
