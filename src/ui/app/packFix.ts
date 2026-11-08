/**
 * "Save fixed copy…" for an opened `.mrpack` (store slice). The pack is read-only and never
 * changed; Rust writes a corrected NEW `.mrpack` that the user then imports into a launcher.
 *
 * Flow: a pack finding's edit button (`Finding.packEdits`) → `addPackEdit` adds the edit to the
 * draft (an `addProject` suggestion is first resolved to the project's newest compatible version:
 * `modrinth_project_versions` with the pack's loaders + MC and `["release","beta"]`, then
 * `chooseVersion`) → the whole list is planned again (`plan_pack_fix`; Rust validates every edit
 * and fetches every version itself) → the panel shows Rust's numbered ops, warnings or refusal →
 * Save fixed copy… (`save_fixed_pack`: Rust opens the native save dialog and writes the copy) →
 * the saved path, or nothing when the dialog was cancelled (the plan stays usable). A save that
 * fails with `notFound` (expired) or `conflict` (the pack changed since planning, or the chosen
 * file already exists) clears the plan, so the panel offers Plan again.
 *
 * One draft at a time: a draft of another pack must be saved or cancelled first (said next to the
 * button pressed). Edits on the same subject replace each other (a later "Replace" of a file
 * replaces an earlier "Remove" of it); an identical edit is not added twice. Removing the last
 * edit closes the draft. Every refusal is an `AppError` sentence shown inline, never a toast.
 */
import type { AppError, MrVersion, PackEdit, PackFixPlan, SavedPack } from '../../bindings';
import type { PackContext, PackEditSuggestion } from '../../core/model';
import { modrinthLoaders } from '../../core/modrinth';
import { packEditKey } from '../../core/packfix';
import { call, type AppCommands } from './ipc';

/** An edit in the draft, with the button label it came from. */
export interface ChosenEdit {
  edit: PackEdit;
  label: string;
  findingId: string;
}

export interface PackFixDraft {
  instanceId: string;
  edits: ChosenEdit[];
  /** Rust's plan for exactly `edits`; null while planning, after a refusal or once expired. */
  plan: PackFixPlan | null;
  phase: 'planning' | 'review' | 'saving' | 'saved';
  /** The planning refusal, or why the last save failed. */
  error: AppError | null;
  /** Where the copy went (phase `saved`). */
  saved: SavedPack | null;
}

export interface PackFixSlice {
  /** The fixed copy being prepared (one at a time). */
  packFix: PackFixDraft | null;
  /** Finding ids whose `addProject` edit is being looked up on Modrinth. */
  packEditPending: Readonly<Record<string, true>>;
  /** Why an edit button of a finding did nothing (e.g. no compatible version), by finding id. */
  packEditErrors: Readonly<Record<string, AppError>>;
  addPackEdit(instanceId: string, findingId: string, suggestion: PackEditSuggestion): Promise<void>;
  /** Drop one edit of the draft (by index) and plan the rest again. */
  removePackEdit(index: number): Promise<void>;
  /** Plan the draft again (after a refusal or an expired plan). */
  planPackFixAgain(): Promise<void>;
  /** `save_fixed_pack` for the current plan (Rust opens the native save dialog). */
  savePackFix(): Promise<void>;
  /** Drop the draft (Cancel, or Close once saved). Nothing was written. */
  cancelPackFix(): void;
  dismissPackEditError(findingId: string): void;
}

export const packFixInitial: Pick<PackFixSlice, 'packFix' | 'packEditPending' | 'packEditErrors'> = {
  packFix: null,
  packEditPending: {},
  packEditErrors: {},
};

export interface PackFixDeps {
  commands: Pick<AppCommands, 'planPackFix' | 'saveFixedPack' | 'modrinthProjectVersions'>;
  get(): PackFixSlice;
  set(partial: Partial<PackFixSlice>): void;
  /** The effective pack identity of the instance's last check run, or null. */
  pack(instanceId: string): PackContext | null;
  instanceName(instanceId: string): string;
  modrinthEnabled(): boolean;
  includeBeta(): boolean;
  chooseVersion(versions: MrVersion[], includeBeta: boolean): MrVersion | null;
}

const appError = (kind: AppError['kind'], message: string): AppError => ({ kind, message, path: null });

function sameEdit(a: PackEdit, b: PackEdit): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function createPackFixSlice(d: PackFixDeps): Omit<PackFixSlice, 'packFix' | 'packEditPending' | 'packEditErrors'> {
  const { commands: cmd, get, set } = d;
  /** Latest plan request; an older answer is dropped. */
  let planToken = 0;

  const setError = (findingId: string, error: AppError | null) => {
    const next = { ...get().packEditErrors };
    if (error) next[findingId] = error;
    else delete next[findingId];
    set({ packEditErrors: next });
  };

  const setPending = (findingId: string, on: boolean) => {
    const next = { ...get().packEditPending };
    if (on) next[findingId] = true;
    else delete next[findingId];
    set({ packEditPending: next });
  };

  /** The newest compatible version of `projectId` as an `addDependency` edit, or a refusal. */
  const resolveProject = async (instanceId: string, projectId: string, title: string): Promise<{ edit: PackEdit; label: string } | AppError> => {
    if (!d.modrinthEnabled()) {
      return appError('offline', `Looking up mods online is switched off, so ${title} can't be found on Modrinth. Turn it on, then try again.`);
    }
    const pack = d.pack(instanceId);
    const loaders = pack ? modrinthLoaders(pack) : [];
    const mc = pack?.mcVersion?.trim() ?? '';
    if (loaders.length === 0 || !mc) {
      return appError('invalid', `The pack's Minecraft version or loader is unknown, so no version of ${title} can be chosen for it.`);
    }
    const r = await call(cmd.modrinthProjectVersions(projectId, loaders, [mc], ['release', 'beta']));
    if (r.status === 'error') return r.error;
    const v = d.chooseVersion(r.data, d.includeBeta());
    if (!v) {
      return appError('notFound', `Modrinth has no release or beta of ${title} for this pack's loader and Minecraft ${mc}, so it can't be added.`);
    }
    return { edit: { kind: 'addDependency', versionId: v.id }, label: `Add ${title} ${v.versionNumber}` };
  };

  const replan = async (): Promise<void> => {
    const draft = get().packFix;
    if (!draft) return;
    if (draft.edits.length === 0) {
      planToken++;
      set({ packFix: null });
      return;
    }
    const token = ++planToken;
    set({ packFix: { ...draft, phase: 'planning', plan: null, error: null, saved: null } });
    const r = await call(cmd.planPackFix(draft.instanceId, draft.edits.map((e) => e.edit)));
    const cur = get().packFix;
    if (token !== planToken || !cur) return;
    set({
      packFix: r.status === 'ok' ? { ...cur, phase: 'review', plan: r.data, error: null } : { ...cur, phase: 'review', plan: null, error: r.error },
    });
  };

  return {
    async addPackEdit(instanceId, findingId, suggestion) {
      const open = get().packFix;
      if (open && open.instanceId !== instanceId && open.phase !== 'saved') {
        setError(
          findingId,
          appError('conflict', `A fixed copy of ${d.instanceName(open.instanceId)} is being prepared. Save or cancel it first, then try again.`),
        );
        return;
      }
      if (open?.phase === 'saving' || get().packEditPending[findingId]) return;
      setError(findingId, null);
      let chosen: ChosenEdit;
      if (suggestion.kind === 'edit') {
        chosen = { edit: suggestion.edit, label: suggestion.label, findingId };
      } else {
        setPending(findingId, true);
        const r = await resolveProject(instanceId, suggestion.projectId, suggestion.title);
        setPending(findingId, false);
        if ('kind' in r && 'message' in r) {
          setError(findingId, r);
          return;
        }
        chosen = { ...r, findingId };
      }
      // The draft may have changed while Modrinth answered.
      const cur = get().packFix;
      if (cur?.phase === 'saving') return;
      const base = cur && cur.instanceId === instanceId && cur.phase !== 'saved' ? cur.edits : [];
      const key = packEditKey(chosen.edit);
      const at = base.findIndex((e) => packEditKey(e.edit) === key);
      if (at >= 0 && sameEdit(base[at]!.edit, chosen.edit) && cur?.instanceId === instanceId) return;
      const edits = at >= 0 ? base.map((e, i) => (i === at ? chosen : e)) : [...base, chosen];
      set({ packFix: { instanceId, edits, plan: null, phase: 'planning', error: null, saved: null } });
      await replan();
    },

    async removePackEdit(index) {
      const draft = get().packFix;
      if (!draft || draft.phase === 'saving' || draft.phase === 'saved') return;
      set({ packFix: { ...draft, edits: draft.edits.filter((_, i) => i !== index) } });
      await replan();
    },

    planPackFixAgain: replan,

    async savePackFix() {
      const draft = get().packFix;
      const plan = draft?.plan;
      if (!draft || !plan || draft.phase !== 'review') return;
      set({ packFix: { ...draft, phase: 'saving', error: null } });
      const r = await call(cmd.saveFixedPack(plan.id));
      const cur = get().packFix;
      if (!cur || cur.plan?.id !== plan.id) return;
      if (r.status === 'ok') {
        // null: the dialog was cancelled; the plan is still valid.
        set({ packFix: r.data ? { ...cur, phase: 'saved', saved: r.data, error: null } : { ...cur, phase: 'review' } });
        return;
      }
      // An expired plan, or one of a pack that changed since planning (`conflict`; Rust drops it,
      // and a destination that already exists is a conflict too), can only be planned again.
      const stale = r.error.kind === 'notFound' || r.error.kind === 'conflict';
      set({ packFix: { ...cur, phase: 'review', error: r.error, plan: stale ? null : cur.plan } });
    },

    cancelPackFix() {
      planToken++;
      set({ packFix: null });
    },

    dismissPackEditError(findingId) {
      setError(findingId, null);
    },
  };
}
