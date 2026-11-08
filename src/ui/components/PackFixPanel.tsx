/**
 * Fixed copy of an opened `.mrpack` ("Save fixed copy…"): the work-order anatomy of DESIGN.md
 * §6.4 in place of the mod table, never a modal. A numbered mono list of the chosen edits — once
 * Rust has planned them, each row is Rust's op (verb, subject, the sentence of what the copy
 * gets, and for a replacement or addition the full CDN URL as a detail line) — then a footer with
 * the opened pack's path, Cancel and the primary ink button **Save fixed copy…** (instead of
 * Execute). Rust opens the native save dialog; the opened file is never changed.
 *
 * Above the list: Rust's planning refusal or the last save failure as an inline error row (an
 * expired plan offers Plan again), and the plan's warnings. Each row has Remove while the draft is
 * reviewed. Once saved, a `saved` line gives the new file's path and "Open it in your launcher to
 * install it." and Close replaces the buttons.
 *
 * Keyboard: Esc cancels (not while saving; fresh presses inside the panel only). Enter never
 * saves: Save needs a click or Tab + Space, like every work order but a single-rename undo.
 */
import './motion.css';

import { useEffect, useRef, type ReactNode } from 'react';

import type { PackEdit, PackFixOpKind } from '../../bindings';
import type { PackFixDraft } from '../app/packFix';
import { Button } from './Button';
import { cx } from './cx';
import { ErrorRow } from './ErrorRow';
import { opNumber, plural } from './format';
import { Panel } from './Panel';
import { RAIL_BG } from './Severity';

export interface PackFixPanelProps {
  draft: PackFixDraft;
  /** The opened pack's absolute path (shown in the footer). */
  packPath: string;
  onSave: () => void;
  onCancel: () => void;
  onRemoveEdit: (index: number) => void;
  onPlanAgain: () => void;
  autoFocus?: boolean;
  className?: string;
}

const OP_VERB: Record<PackFixOpKind, string> = { remove: 'remove', removeOverride: 'remove', replace: 'replace', add: 'add' };

function editVerb(edit: PackEdit): string {
  switch (edit.kind) {
    case 'removeDeclared':
    case 'removeOverride':
      return 'remove';
    case 'replaceDeclared':
      return 'replace';
    case 'addDependency':
      return 'add';
  }
}

/** A one-line reading with a 4px rail, aligned with the error rows (as in the work order). */
function Line({ tone, code, children, role }: { tone: 'warning' | 'ok'; code: string; children: ReactNode; role: 'status' }) {
  return (
    <div role={role} className="flex min-h-8 shrink-0 items-stretch border-b border-line bg-panel">
      <span aria-hidden className={cx('w-1 shrink-0', tone === 'ok' ? 'bg-ok-fill' : RAIL_BG.warning)} />
      <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-4 py-1 pr-2 pl-4">
        <span className={cx('w-24 shrink-0 t-mono', tone === 'ok' ? 'text-ok' : 'text-signal')}>{code}</span>
        <span className="min-w-[50%] flex-1 t-body text-fg">{children}</span>
      </div>
    </div>
  );
}

export function PackFixPanel({ draft, packPath, onSave, onCancel, onRemoveEdit, onPlanAgain, autoFocus = false, className }: PackFixPanelProps) {
  const { plan, phase, error, saved, edits } = draft;
  const ref = useRef<HTMLElement>(null);
  const saving = phase === 'saving';
  const done = phase === 'saved';
  const fileName = plan?.packFileName ?? packPath.slice(Math.max(packPath.lastIndexOf('\\'), packPath.lastIndexOf('/')) + 1);
  // An expired plan (`notFound` on save) or a refusal: planning again is the way on.
  const planAgain = !plan && phase === 'review';

  useEffect(() => {
    if (!autoFocus) return;
    const el = ref.current;
    const active = typeof document === 'undefined' ? null : document.activeElement;
    const lost = !active || !el?.contains(active) || (active instanceof HTMLButtonElement && active.disabled);
    if (el && lost) el.focus({ preventScroll: true });
  }, [autoFocus, phase]);

  return (
    <Panel
      ref={ref}
      legend="Fixed copy"
      meta={plural(edits.length, 'edit')}
      flush
      className={cx('focus-visible:outline-1 focus-visible:-outline-offset-1', className)}
      bodyClassName="flex min-h-0 flex-col"
      aria-label={`Fixed copy of ${fileName}`}
      data-pack-fix=""
      tabIndex={-1}
      onKeyDown={(e) => {
        const inside = e.target instanceof Node && e.currentTarget.contains(e.target);
        if (e.key === 'Escape' && !e.repeat && inside && !saving) {
          e.preventDefault();
          onCancel();
        }
      }}
    >
      <div className="flex min-h-8 shrink-0 items-center border-b border-line px-4 t-body text-fg">
        <span className="min-w-0 truncate">
          Save a corrected copy of <span className="t-mono">{fileName}</span> as a new file. The opened pack stays as it is.
        </span>
      </div>
      {error && !done ? (
        <ErrorRow
          error={error}
          action={
            planAgain ? (
              <Button size={24} onClick={onPlanAgain}>
                Plan again
              </Button>
            ) : undefined
          }
        />
      ) : null}
      {plan && !done
        ? plan.warnings.map((w, i) => (
            <Line key={i} tone="warning" code="note" role="status">
              {w}
            </Line>
          ))
        : null}
      <div className="-mb-px min-h-0 flex-1 overflow-y-auto">
        <ol className="t-mono" aria-label="Edits">
          {edits.map((chosen, i) => {
            const op = plan?.ops[i];
            return (
              <li key={i} className="grid min-h-6 grid-cols-[32px_72px_minmax(0,1fr)_96px] items-start border-b border-line px-4 py-1">
                <span className="text-fg-faint">{opNumber(i)}</span>
                <span className="text-fg-dim">{op ? OP_VERB[op.kind] : editVerb(chosen.edit)}</span>
                <span className="min-w-0">
                  <span className="break-all text-fg">{op ? op.subject : chosen.label}</span>
                  {op ? <span className="block text-fg-faint">{op.detail}</span> : null}
                  {op?.url ? (
                    <span className="block truncate text-fg-faint" title={op.url} data-role="source-url">
                      {op.url}
                    </span>
                  ) : null}
                </span>
                <span className="flex justify-end">
                  {phase === 'planning' ? (
                    <span className="text-fg-faint">planning</span>
                  ) : done ? (
                    <span className="text-ok">saved</span>
                  ) : (
                    <Button size={24} disabled={saving} onClick={() => onRemoveEdit(i)} aria-label={`Remove edit ${opNumber(i)}: ${chosen.label}`}>
                      Remove
                    </Button>
                  )}
                </span>
              </li>
            );
          })}
        </ol>
      </div>
      <div className="relative shrink-0 border-t border-line bg-panel">
        {done && saved ? (
          <Line tone="ok" code="saved" role="status">
            Saved <span className="break-all t-mono">{saved.path}</span>. Open it in your launcher to install it.
          </Line>
        ) : null}
        <footer className="flex min-h-12 flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2">
          <span className="t-label text-fg-faint">copy of</span>
          <span className="min-w-0 flex-1 truncate t-mono text-fg-dim" title={packPath}>
            {packPath}
          </span>
          {done ? (
            <Button onClick={onCancel}>Close</Button>
          ) : (
            <>
              <Button onClick={onCancel} disabled={saving}>
                Cancel
              </Button>
              <Button
                variant="primary"
                onClick={onSave}
                // A focused button turns Enter into a click; saving needs a click or Space (§6.4).
                onKeyDown={(e) => {
                  if (e.key === 'Enter') e.preventDefault();
                }}
                disabled={!plan || phase !== 'review'}
              >
                {saving ? 'Saving…' : 'Save fixed copy…'}
              </Button>
            </>
          )}
        </footer>
      </div>
    </Panel>
  );
}
