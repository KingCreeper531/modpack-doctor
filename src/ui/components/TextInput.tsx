/** Input (DESIGN.md §6.5): a `raised` well, 1px line-strong, r-1, 24px tall. Mono by default. */
import type { InputHTMLAttributes } from 'react';

import { cx } from './cx';

export interface TextInputProps extends InputHTMLAttributes<HTMLInputElement> {
  mono?: boolean;
}

export function TextInput({ mono = true, className, ...rest }: TextInputProps) {
  return (
    <input
      className={cx(
        'h-6 min-w-0 rounded-1 border border-line-strong bg-raised px-2 text-fg placeholder:text-fg-faint',
        mono ? 't-mono' : 't-body',
        'disabled:text-fg-faint',
        className,
      )}
      {...rest}
    />
  );
}
