/**
 * Triage row (DESIGN.md §6.2). Collapsed: 32px
 * `[4px severity rail][code, mono, fixed 144px][one-line diagnosis][culprit chips, right]`.
 * Expanded (click / Enter): explanation (≤ 72ch), evidence, fix buttons; height animates 160ms
 * ease-out via a 0fr → 1fr grid track (`--dur` is 0ms under reduced motion).
 * Focused (J/K, owned by the list): `raised` plus an inset 1px `signal` outline.
 */
import type { AppError, FixAction } from '../../bindings';
import type { Finding } from '../../core/model';
import { Button } from './Button';
import { Chip } from './Chip';
import { cx } from './cx';
import { ErrorRow } from './ErrorRow';
import { EvidenceView } from './EvidenceView';
import { basename } from './format';
import { fixLabel } from './labels';
import { RAIL_BG, SEVERITY_TEXT } from './Severity';

export interface TriageRowProps {
  finding: Finding;
  expanded: boolean;
  onToggle: () => void;
  /** Keyboard cursor (J/K). */
  focused?: boolean;
  /** Shown in the inspector. */
  selected?: boolean;
  /** Jar id → display name for chips and fix labels. */
  jarNames?: Readonly<Record<string, string>>;
  selectedJarId?: string | null;
  onJarClick?: (jarId: string) => void;
  onFix?: (fix: FixAction, index: number) => void;
  /** Disable fix buttons, e.g. while a work order is open. */
  fixesDisabled?: boolean;
  /** Why the last fix could not be planned (`plan_work_order` error), shown under the buttons. */
  fixError?: AppError | null;
}

export function TriageRow({
  finding,
  expanded,
  onToggle,
  focused = false,
  selected = false,
  jarNames = {},
  selectedJarId = null,
  onJarClick,
  onFix,
  fixesDisabled = false,
  fixError = null,
}: TriageRowProps) {
  const name = (id: string) => jarNames[id] ?? basename(id);
  const bodyId = `triage-${finding.id}`;
  return (
    <div
      className={cx(
        'relative border-b border-line',
        focused || selected ? 'bg-raised' : 'bg-panel hover:bg-raised',
        focused && 'outline-1 -outline-offset-1 outline-signal',
      )}
      data-severity={finding.severity}
      aria-current={selected || undefined}
    >
      <span aria-hidden className={cx('absolute inset-y-0 left-0 w-1', RAIL_BG[finding.severity])} />
      <div className="flex h-8 items-center pl-1">
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={bodyId}
          onClick={onToggle}
          className="flex h-8 min-w-0 flex-1 items-center text-left focus-visible:outline-1 focus-visible:-outline-offset-1"
        >
          <span className={cx('w-36 shrink-0 truncate pl-1 t-mono', SEVERITY_TEXT[finding.severity])} title={finding.code}>
            {finding.code}
          </span>
          <span className="min-w-0 flex-1 truncate pl-1 t-body text-fg">{finding.title}</span>
        </button>
        <div className="flex max-w-[45%] shrink-0 items-center gap-1 overflow-hidden pr-4 pl-2">
          {finding.culprits.map((c) => (
            <Chip
              key={c.jarId}
              title={c.jarId}
              selected={selectedJarId === c.jarId}
              {...(onJarClick ? { onClick: () => onJarClick(c.jarId) } : {})}
            >
              {c.fileName}
            </Chip>
          ))}
        </div>
      </div>
      <div
        id={bodyId}
        className="grid"
        style={{ gridTemplateRows: expanded ? '1fr' : '0fr', transition: 'grid-template-rows var(--dur) var(--ease-out)' }}
        inert={!expanded}
      >
        <div className="min-h-0 overflow-hidden">
          <div className="flex flex-col gap-4 pt-1 pr-4 pb-4 pl-38">
            <p className="max-w-[72ch] t-body text-fg">{finding.explanation}</p>
            {finding.evidence.map((ev, i) => (
              <EvidenceView key={i} evidence={ev} jarLabel={name} {...(onJarClick ? { onJarClick } : {})} />
            ))}
            {finding.fixes.length > 0 ? (
              <div className="flex flex-wrap items-center gap-2">
                {finding.fixes.map((fix, i) => (
                  <Button
                    key={i}
                    size={24}
                    variant={i === 0 ? 'primary' : 'default'}
                    disabled={fixesDisabled}
                    onClick={() => onFix?.(fix, i)}
                  >
                    {fixLabel(fix, jarNames)}
                  </Button>
                ))}
                {finding.fixes[0]?.kind !== 'manual' ? (
                  <span className="t-small text-fg-faint">opens a work order; nothing changes until you execute it</span>
                ) : null}
              </div>
            ) : null}
            {fixError ? <ErrorRow error={fixError} className="border-t" /> : null}
            {finding.fixes.flatMap((f) => (f.kind === 'manual' ? f.steps : [])).length > 0 ? (
              <ol className="flex flex-col gap-1 t-mono text-fg-dim">
                {finding.fixes
                  .flatMap((f) => (f.kind === 'manual' ? f.steps : []))
                  .map((s, i) => (
                    <li key={i} className="flex gap-2">
                      <span className="text-fg-faint">{String(i + 1).padStart(2, '0')}</span>
                      <span>{s}</span>
                    </li>
                  ))}
              </ol>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
