/**
 * Instance rail row (DESIGN.md §5): 48px, two lines. The name (`t-body` 500), then a mono line:
 * launcher abbreviation, MC version, loader glyph + version, mod count. A 4px status pip on the
 * right edge shows the last scan. Selected: 2px `signal` left rule plus `raised`.
 */
import type { Instance } from '../../bindings';
import { LoaderGlyph } from '../glyphs/LoaderGlyph';
import { LOADER_NAME } from '../glyphs/loaders';
import { cx } from './cx';
import { formatInt } from './format';
import { LAUNCHER_ABBR, LAUNCHER_NAME } from './labels';
import { Pip, type PipTone } from './Severity';

export type ScanStatus = 'ok' | 'warning' | 'error' | 'unscanned';

const PIP_TONE: Record<ScanStatus, PipTone> = { ok: 'ok', warning: 'warning', error: 'error', unscanned: 'none' };
const STATUS_WORD: Record<ScanStatus, string> = {
  ok: 'last scan clean',
  warning: 'last scan: warnings',
  error: 'last scan: errors',
  unscanned: 'not scanned',
};

export interface InstanceRailRowProps {
  instance: Instance;
  status: ScanStatus;
  selected?: boolean;
  onSelect?: (id: string) => void;
  /**
   * Headline of a watched crash not looked at yet (M4). Shows a `crash` mark in `err-text` with
   * an `err` pip on the name line; it clears when the instance is opened.
   */
  crash?: string | null;
  /** Watch mode is on (a small `watching` word on the name line). */
  watching?: boolean;
}

export function InstanceRailRow({ instance, status, selected = false, onSelect, crash = null, watching = false }: InstanceRailRowProps) {
  const loader = instance.loader;
  return (
    <button
      type="button"
      aria-current={selected || undefined}
      aria-label={`${instance.name}, ${LAUNCHER_NAME[instance.launcher]}, ${STATUS_WORD[status]}${crash ? `, ${crash}` : ''}`}
      title={instance.root}
      onClick={() => onSelect?.(instance.id)}
      className={cx(
        'flex h-12 w-full items-center gap-2 border-b border-l-2 border-b-line pr-2 pl-[14px] text-left',
        selected ? 'border-l-signal bg-raised' : 'border-l-transparent hover:bg-raised',
        'focus-visible:bg-raised focus-visible:outline-1 focus-visible:-outline-offset-1 focus-visible:outline-signal',
      )}
    >
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex min-w-0 items-center gap-2">
          <span className="min-w-0 flex-1 truncate t-body font-medium text-fg">{instance.name}</span>
          {crash ? (
            <span className="flex shrink-0 items-center gap-1 t-mono text-err-text" title={crash} data-testid="rail-crash">
              <Pip tone="error" />
              crash
            </span>
          ) : watching ? (
            <span className="shrink-0 t-mono text-fg-faint" title="Watching for crashes">
              watching
            </span>
          ) : null}
        </span>
        <span className="flex min-w-0 items-center gap-2 t-mono text-fg-faint">
          <span className="w-8 shrink-0 text-fg-dim">{LAUNCHER_ABBR[instance.launcher]}</span>
          <span className="shrink-0">{instance.mcVersion ?? '—'}</span>
          <span className="flex min-w-0 items-center gap-1" title={loader ? LOADER_NAME[loader.kind] : 'Loader unknown'}>
            <LoaderGlyph kind={loader?.kind ?? null} size={12} className="shrink-0" />
            <span className="truncate">{loader?.version ?? '—'}</span>
          </span>
          <span className="ml-auto shrink-0 text-fg-dim">{formatInt(instance.modCount)}</span>
        </span>
      </span>
      <Pip tone={PIP_TONE[status]} />
    </button>
  );
}
