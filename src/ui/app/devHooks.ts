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
 * - `?open=mrpack` (M7): "opens" the mock pack (Explorer Kit 2.1) as `pick_mrpack` would.
 * - `?palette=1`: the command palette opens once the selected instance is scanned.
 * - `?menu=mod|finding|instance`: the DOM context menu of the first mod-table row, triage row or
 *   rail row opens once the selected instance is scanned (with `open=mrpack`: the pack's rows).
 * - `?drag=1` (read by Shell.tsx): the file-drop overlay shows as if a file were dragged over.
 */
import type { FixAction } from '../../bindings';
import type { Finding } from '../../core/model';
import { findingMenuFor, instanceMenuFor, modMenuFor } from './rowMenus';
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
  const open = p.get('open');
  const palette = p.get('palette') === '1';
  const menu = p.get('menu');
  if (!order && tab !== 'history' && !instance && open !== 'mrpack' && !palette && !menu) return;
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
    if (open === 'mrpack') {
      await waitFor((s) => s.phase === 'ready');
      await store.getState().openMrpack();
    }
    if (instance) {
      await waitFor((s) => !!s.discovery?.instances.some((i) => i.id === instance));
      store.getState().selectInstance(instance);
      await waitFor((s) => s.selectedInstanceId === instance);
    }
    await waitFor((s) => !!s.selectedInstanceId && s.scans[s.selectedInstanceId]?.status === 'done');
    const st = store.getState();
    const id = st.selectedInstanceId!;
    if (palette) st.setPaletteOpen(true);
    if (menu === 'mod' || menu === 'finding' || menu === 'instance') {
      // Let the rows render, then open the menu under the first one, as a right-click would.
      await new Promise((r) => setTimeout(r, 400));
      const sel = menu === 'mod' ? '[role="grid"][aria-label="Mods"] [data-row-id]' : menu === 'finding' ? '[data-finding-id]' : 'nav[aria-label="Instance list"] button[aria-current="true"]';
      const el = document.querySelector<HTMLElement>(sel);
      const s = store.getState();
      const items =
        menu === 'mod'
          ? modMenuFor(store, el?.dataset.rowId ?? '')
          : menu === 'finding'
            ? findingMenuFor(store, el?.dataset.findingId ?? s.scans[id]?.findings[0]?.id ?? '')
            : instanceMenuFor(store, id);
      const r = el?.getBoundingClientRect();
      if (items.length) s.openMenu({ label: `${menu} menu`, items, x: (r?.left ?? 240) + 48, y: (r?.top ?? 120) + 16, returnFocus: el });
    }
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
