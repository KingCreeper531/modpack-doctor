/**
 * "Save fixed copy…" views for an opened `.mrpack` (store slice: app/packFix.ts).
 * - `PackEditButtons`: a pack finding's suggested edits (`Finding.packEdits`), first = primary,
 *   with a note that edits go into a new copy; a chosen edit's button is disabled and the row says
 *   it is in the copy. A refusal (no compatible version, another pack's copy open…) renders
 *   inline under the buttons.
 * - `PackFixOrder`: the fixed-copy panel in place of the mod table (Workspace).
 */
import type { Finding, PackEditSuggestion } from '../../core/model';
import { suggestionKey } from '../../core/packfix';
import { Button } from '../components/Button';
import { ErrorRow } from '../components/ErrorRow';
import { PackFixPanel } from '../components/PackFixPanel';
import type { ChosenEdit } from '../app/packFix';
import { useActions, useApp } from '../app/StoreContext';

/** True when the draft holds the edit this suggestion made (an `addProject` by its label prefix). */
function chosen(s: PackEditSuggestion, edits: readonly ChosenEdit[], findingId: string): boolean {
  if (s.kind === 'edit') return edits.some((e) => suggestionKey({ kind: 'edit', label: '', edit: e.edit }) === suggestionKey(s));
  return edits.some((e) => e.findingId === findingId && e.edit.kind === 'addDependency');
}

export function PackEditButtons({ instanceId, finding, className }: { instanceId: string; finding: Finding; className?: string }) {
  const draft = useApp((s) => (s.packFix?.instanceId === instanceId && s.packFix.phase !== 'saved' ? s.packFix : null));
  const pending = useApp((s) => !!s.packEditPending[finding.id]);
  const error = useApp((s) => s.packEditErrors[finding.id] ?? null);
  const a = useActions();
  const edits = finding.packEdits ?? [];
  if (edits.length === 0) return null;
  const inCopy = edits.some((s) => chosen(s, draft?.edits ?? [], finding.id));
  return (
    <div className={className}>
      <div className="flex flex-wrap items-center gap-2">
        {edits.map((s, i) => (
          <Button
            key={suggestionKey(s)}
            size={24}
            variant={i === 0 ? 'primary' : 'default'}
            disabled={pending || draft?.phase === 'saving' || chosen(s, draft?.edits ?? [], finding.id)}
            onClick={() => void a.addPackEdit(instanceId, finding.id, s)}
          >
            {s.label}
          </Button>
        ))}
        <span className="t-small text-fg-faint">
          {pending ? 'Looking up a compatible version…' : inCopy ? 'In the fixed copy below.' : 'Edits go into a new copy of the pack; the opened file is never changed.'}
        </span>
      </div>
      {error ? (
        <ErrorRow
          error={error}
          className="mt-2 border-t"
          action={
            <Button size={24} onClick={() => a.dismissPackEditError(finding.id)}>
              Dismiss
            </Button>
          }
        />
      ) : null}
    </div>
  );
}

/** The fixed-copy panel of the instance, in place of the mod table (§6.4 anatomy). */
export function PackFixOrder({ instanceId }: { instanceId: string }) {
  const draft = useApp((s) => (s.packFix?.instanceId === instanceId ? s.packFix : null));
  const packPath = useApp((s) => s.discovery?.instances.find((i) => i.id === instanceId)?.root ?? '');
  const a = useActions();
  if (!draft) return null;
  return (
    <div className="flex min-h-40 flex-1 flex-col">
      <PackFixPanel
        className="min-h-0 flex-1"
        draft={draft}
        packPath={packPath}
        autoFocus
        onSave={() => void a.savePackFix()}
        onCancel={() => a.cancelPackFix()}
        onRemoveEdit={(i) => void a.removePackEdit(i)}
        onPlanAgain={() => void a.planPackFixAgain()}
      />
    </div>
  );
}
