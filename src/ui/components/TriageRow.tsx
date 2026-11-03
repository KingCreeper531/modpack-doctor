/**
 * Triage row (DESIGN.md §6.2). Collapsed: 32px
 * `[4px severity rail][code, mono, fixed 144px][one-line diagnosis][culprit chips, right]`.
 * Expanded (click / Enter): explanation (≤ 72ch), evidence, fix buttons; height animates 160ms
 * ease-out via a 0fr → 1fr grid track (`--dur` is 0ms under reduced motion).
 * Focused (J/K, owned by the list): `raised` plus an inset 1px `signal` outline.
 *
 * The code carries a small severity word when a check lowered it (`E-DUP-ID warn`). Culprit
 * chips ellipsize and collapse past `MAX_CHIPS` into `+N`. Metadata evidence is clipped to
 * `EVIDENCE_LINES` with a Show all toggle; the inspector shows it in full.
 */
import type { ReactNode } from 'react';

import type { AppError, FixAction } from '../../bindings';
import type { Finding } from '../../core/model';
import { Button } from './Button';
import { Chip } from './Chip';
import { cx } from './cx';
import { ErrorRow } from './ErrorRow';
import { EvidenceView } from './EvidenceView';
import { basename } from './format';
import { fixLabel } from './labels';
import { FindingCode, RAIL_BG } from './Severity';

/** Chips shown before the rest collapse into `+N`. */
export const MAX_CHIPS = 2;
/** Metadata excerpt lines shown in an expanded row before "Show all". */
export const EVIDENCE_LINES = 12;

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
  /** Note beside the fix buttons (e.g. how work orders behave), once fixes can run. */
  fixHint?: ReactNode;
  /** Where a crash finding came from (log file name); shown as `from <origin>` after the title. */
  origin?: string;
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
  fixHint = null,
  origin,
}: TriageRowProps) {
  const name = (id: string) => jarNames[id] ?? basename(id);
  const bodyId = `triage-${finding.id}`;
  const shown = finding.culprits.slice(0, MAX_CHIPS);
  const hidden = finding.culprits.slice(MAX_CHIPS);
  const steps = finding.fixes.flatMap((f) => (f.kind === 'manual' ? f.steps : []));
  return (
    <div
      className={cx(
        '@container relative border-b border-line',
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
          <FindingCode code={finding.code} severity={finding.severity} className="w-36 shrink-0 truncate pl-1" />
          <span className={cx('min-w-0 flex-1 truncate pl-1 t-body text-fg', origin && 'min-w-[40%]')}>{finding.title}</span>
          {origin ? (
            <span className="max-w-[30%] min-w-0 shrink truncate pl-2 t-mono text-fg-faint" title={origin} data-testid="origin">
              from {origin}
            </span>
          ) : null}
        </button>
        <div className="flex max-w-[45%] min-w-0 shrink-0 items-center gap-1 pr-4 pl-2" data-testid="culprits">
          {shown.map((c) => (
            <Chip
              key={c.jarId}
              title={c.jarId}
              selected={selectedJarId === c.jarId}
              shrinkable
              {...(onJarClick ? { onClick: () => onJarClick(c.jarId) } : {})}
            >
              {c.fileName}
            </Chip>
          ))}
          {hidden.length ? (
            <span className="shrink-0 t-mono text-fg-faint" title={hidden.map((c) => c.fileName).join('\n')}>
              +{hidden.length}
            </span>
          ) : null}
        </div>
      </div>
      <div
        id={bodyId}
        className="grid"
        style={{ gridTemplateRows: expanded ? '1fr' : '0fr', transition: 'grid-template-rows var(--dur) var(--ease-out)' }}
        inert={!expanded}
      >
        <div className="min-h-0 overflow-hidden">
          {/* Aligned with the title column; in a narrow pane (crash view) it starts under the code. */}
          <div className="flex flex-col gap-4 pt-1 pr-4 pb-4 pl-4 @min-[560px]:pl-38">
            <p className="max-w-[72ch] t-body text-fg">{finding.explanation}</p>
            {hidden.length ? (
              <div className="flex flex-wrap gap-1" aria-label="All culprits">
                {finding.culprits.map((c) => (
                  <Chip key={c.jarId} title={c.jarId} selected={selectedJarId === c.jarId} {...(onJarClick ? { onClick: () => onJarClick(c.jarId) } : {})}>
                    {c.fileName}
                  </Chip>
                ))}
              </div>
            ) : null}
            {finding.evidence.map((ev, i) => (
              <EvidenceView key={i} evidence={ev} jarLabel={name} clipLines={EVIDENCE_LINES} {...(onJarClick ? { onJarClick } : {})} />
            ))}
            {finding.fixes.some((f) => f.kind !== 'manual') ? (
              <div className="flex flex-wrap items-center gap-2">
                {finding.fixes.map((fix, i) =>
                  fix.kind === 'manual' ? null : (
                    <Button key={i} size={24} variant={i === 0 ? 'primary' : 'default'} disabled={fixesDisabled} onClick={() => onFix?.(fix, i)}>
                      {fixLabel(fix, jarNames)}
                    </Button>
                  ),
                )}
                {fixHint ? <span className="t-small text-fg-faint">{fixHint}</span> : null}
              </div>
            ) : null}
            {fixError ? <ErrorRow error={fixError} className="border-t" /> : null}
            {steps.length > 0 ? (
              <ol className="flex flex-col gap-1 t-mono text-fg-dim">
                {steps.map((s, i) => (
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
