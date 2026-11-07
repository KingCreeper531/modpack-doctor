/**
 * Screenshot hooks for the browser preview (dev builds with the mock backend only; App.tsx calls
 * this behind `import.meta.env.DEV`, so production bundles drop it):
 * - `?instance=<id>`: that instance is opened first (e.g. `c04d9e2b61a8f735`, Create: Above and
 *   Beyond, whose seeded backup is `incomplete`: the summary notice and Recover in HISTORY).
 * - `?tab=history`: the selected instance opens on its HISTORY legend.
 * - `?order=replace`: once the first instance's Modrinth fixes are in, the first `replace` fix
 *   (Lithostitched in All the Mods 9) is planned: the work order opens for review.
 * - `?order=running`: the same order is executed; the mock holds its 2nd op running.
 * - `?order=execute`: the same order is executed to the end (with `?scenario=fixfail` it fails at
 *   its 2nd op and rolls back; with `gamerunning` it is refused).
 * - `?order=undo`: HISTORY, then an undo whose file changed since (refused inline) and an undo of
 *   the seeded Curios API update (the work order opens for review).
 */
import type { FixAction } from '../../bindings';
import type { Finding } from '../../core/model';
import type { AppState, AppStore } from './store';

function firstReplace(s: AppState, id: string): { finding: Finding; fix: FixAction } | null {
  for (const f of s.scans[id]?.findings ?? []) {
    const fix = f.fixes.find((x) => x.kind === 'replace');
    if (fix) return { finding: f, fix };
  }
  return null;
}

export function applyDevHooks(store: AppStore, search: string): void {
  const p = new URLSearchParams(search);
  const order = p.get('order');
  const tab = p.get('tab');
  const instance = p.get('instance');
  if (!order && tab !== 'history' && !instance) return;
  const waitFor = (pred: (s: AppState) => boolean) =>
    new Promise<void>((resolve) => {
      if (pred(store.getState())) return resolve();
      const off = store.subscribe((s) => {
        if (!pred(s)) return;
        off();
        resolve();
      });
    });

  void (async () => {
    if (instance) {
      await waitFor((s) => !!s.discovery?.instances.some((i) => i.id === instance));
      store.getState().selectInstance(instance);
      await waitFor((s) => s.selectedInstanceId === instance);
    }
    await waitFor((s) => !!s.selectedInstanceId && s.scans[s.selectedInstanceId]?.status === 'done');
    const st = store.getState();
    const id = st.selectedInstanceId!;
    if (tab === 'history' || order === 'undo') st.setFindingsTab(id, 'history');
    if (order === 'replace' || order === 'running' || order === 'execute') {
      await waitFor((s) => firstReplace(s, id) !== null);
      const hit = firstReplace(store.getState(), id)!;
      await store.getState().fix(hit.finding.id, hit.fix, 'triage');
      if (order !== 'replace') await store.getState().executeOrder();
    }
    if (order === 'undo') {
      await waitFor((s) => s.history[id]?.status === 'done');
      const entries = store.getState().history[id]?.entries ?? [];
      const changed = entries.find((e) => e.actions.some((x) => x.kind === 'removeDuplicate') && e.undoneActions.length === 0);
      if (changed) await store.getState().undo(changed.id, [changed.actions.findIndex((x) => x.kind === 'disable')]);
      const update = entries.find((e) => e.actions.some((x) => x.kind === 'replace') && e.undoneActions.length === 0);
      if (update) await store.getState().undo(update.id, null);
    }
  })();
}
