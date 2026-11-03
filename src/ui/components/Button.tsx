/**
 * Button (DESIGN.md §6.5). 24px or 32px tall, r-2, 1px line-strong border on panel.
 * `primary` is an ink button (fg fill, bg text), never amber: amber carries meaning, not emphasis.
 * Focus uses the global 2px signal ring with a 2px offset (tailwind.css base layer).
 */
import type { ButtonHTMLAttributes, ReactNode } from 'react';

import { cx } from './cx';

export type ButtonVariant = 'default' | 'primary' | 'danger';
export type ButtonSize = 24 | 32;

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** 16px Phosphor icon (regular), placed before the label. */
  icon?: ReactNode;
  /** Keyboard hint after the label, e.g. `↵` or `Ctrl+R`. Mono. */
  hint?: ReactNode;
}

const VARIANT: Record<ButtonVariant, string> = {
  default: 'border-line-strong bg-panel text-fg enabled:hover:bg-raised',
  primary: 'border-fg bg-fg text-bg enabled:hover:border-fg-dim enabled:hover:bg-fg-dim',
  danger: 'border-err bg-panel text-err-text enabled:hover:bg-raised',
};

export function Button({ variant = 'default', size = 32, icon, hint, className, children, type = 'button', ...rest }: ButtonProps) {
  return (
    <button
      type={type}
      className={cx(
        'inline-flex shrink-0 items-center gap-2 rounded-2 border font-medium whitespace-nowrap select-none',
        size === 32 ? 'h-8 px-4 t-body' : 'h-6 px-2 t-small',
        VARIANT[variant],
        'disabled:cursor-not-allowed disabled:border-line disabled:bg-panel disabled:text-fg-faint',
        className,
      )}
      {...rest}
    >
      {icon ? <span className="-ml-1 flex items-center">{icon}</span> : null}
      {children}
      {hint ? <span className="t-mono">{hint}</span> : null}
    </button>
  );
}
