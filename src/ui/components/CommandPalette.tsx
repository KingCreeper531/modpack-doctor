/**
 * Command palette (DESIGN.md §6.7), built on unstyled cmdk. 560px wide, anchored 64px below the
 * top of the window (never centred vertically), `panel`, `shadow-overlay`, r-2. A 32px input row
 * with a mono placeholder; 24px results grouped under `t-label` headings; the active row gets
 * `raised` plus a 2px `signal` left rule and the shortcut shows right-aligned in mono `fg-faint`.
 * No match colours: matched characters are `fg`, the rest `fg-dim`.
 */
import { MagnifyingGlass } from '@phosphor-icons/react';
import { Command } from 'cmdk';
import { useState, type ReactNode } from 'react';

import { cx } from './cx';
import { matchMask, matchRuns } from './paletteModel';

export interface PaletteItem {
  id: string;
  label: string;
  /** Secondary mono detail, e.g. a version or path. */
  detail?: string;
  shortcut?: string;
  icon?: ReactNode;
}

export interface PaletteGroup {
  heading: string;
  items: readonly PaletteItem[];
}

export interface CommandPaletteProps {
  groups: readonly PaletteGroup[];
  onSelect: (id: string) => void;
  onClose: () => void;
  /** `fixed`: the real overlay (64px from the window top). `contained`: positioned by the parent. */
  placement?: 'fixed' | 'contained';
  initialQuery?: string;
  className?: string;
}

function Marked({ label, query }: { label: string; query: string }) {
  const mask = matchMask(label, query);
  if (!mask || !query.trim()) return <span className="truncate text-fg-dim">{label}</span>;
  return (
    <span className="truncate">
      {matchRuns(label, mask).map((r, i) => (
        <span key={i} className={r.hit ? 'text-fg' : 'text-fg-dim'}>
          {r.text}
        </span>
      ))}
    </span>
  );
}

export function CommandPalette({ groups, onSelect, onClose, placement = 'fixed', initialQuery = '', className }: CommandPaletteProps) {
  const [query, setQuery] = useState(initialQuery);
  return (
    <Command
      label="Command palette"
      loop
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          onClose();
        }
      }}
      className={cx(
        'z-50 flex w-[560px] max-w-[calc(100vw-32px)] flex-col overflow-hidden rounded-2 bg-panel shadow-overlay',
        placement === 'fixed' && 'fixed top-16 left-1/2 -translate-x-1/2',
        className,
      )}
    >
      {/* The focus ring sits on the input row (focus-within): an offset ring would be clipped by the overlay. */}
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-line px-4 text-fg-faint focus-within:outline-1 focus-within:-outline-offset-1 focus-within:outline-signal">
        <MagnifyingGlass size={16} aria-hidden />
        <Command.Input
          value={query}
          onValueChange={setQuery}
          placeholder="instance, mod id, or action…"
          className="h-8 min-w-0 flex-1 bg-transparent t-mono text-fg placeholder:text-fg-faint focus-visible:outline-none"
        />
        <span className="t-mono text-fg-faint">esc</span>
      </div>
      <Command.List
        className={cx(
          'max-h-[384px] overflow-y-auto py-1',
          '[&_[cmdk-group-heading]]:flex [&_[cmdk-group-heading]]:h-6 [&_[cmdk-group-heading]]:items-center',
          '[&_[cmdk-group-heading]]:px-4 [&_[cmdk-group-heading]]:t-label [&_[cmdk-group-heading]]:text-fg-faint',
        )}
      >
        <Command.Empty className="flex h-6 items-center px-4 t-mono text-fg-faint">no match</Command.Empty>
        {groups.map((g) => (
          <Command.Group key={g.heading} heading={g.heading}>
            {g.items.map((it) => (
              <Command.Item
                key={it.id}
                value={`${it.label} ${it.detail ?? ''} ${it.id}`}
                onSelect={() => onSelect(it.id)}
                className={cx(
                  'flex h-6 cursor-default items-center gap-2 border-l-2 border-transparent pr-4 pl-[14px] t-body',
                  'data-[selected=true]:border-signal data-[selected=true]:bg-raised',
                )}
              >
                <span className="flex size-4 shrink-0 items-center justify-center text-fg-faint">{it.icon}</span>
                <Marked label={it.label} query={query} />
                {it.detail ? <span className="truncate t-mono text-fg-faint">{it.detail}</span> : null}
                {it.shortcut ? <span className="ml-auto shrink-0 t-mono text-fg-faint">{it.shortcut}</span> : null}
              </Command.Item>
            ))}
          </Command.Group>
        ))}
      </Command.List>
    </Command>
  );
}
