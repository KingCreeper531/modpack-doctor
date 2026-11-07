// @vitest-environment happy-dom
/** M6 in the shell: the work-order panel's keyboard rules, the History tab and per-action undo. */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { App } from '../../app/App';
import { finding, mockStore, until } from '../../app/__tests__/helpers';
import { MOCK_INSTANCES } from '../../app/mockData';
import { SEEDED_INTERRUPTED_INSTANCE } from '../../app/mockFix';
import type { MockOptions } from '../../app/mockIpc';

afterEach(cleanup);

function setViewport(width: number) {
  (window as unknown as { happyDOM: { setViewport(v: { width: number; height: number }): void } }).happyDOM.setViewport({ width, height: 900 });
  window.dispatchEvent(new Event('resize'));
}

beforeEach(() => setViewport(1600));

const ATM = MOCK_INSTANCES[0]!;
const CREATE = 'mods/create-1.20.1-0.5.1.f.jar';

async function renderApp(make = () => [finding('dis', 'error', [CREATE], { title: 'Create misbehaves', fixes: [{ kind: 'disable', jarId: CREATE }] })]) {
  const m = mockStore({}, make);
  render(<App store={m.store} />);
  await act(async () => {
    await m.store.getState().init();
    await until(() => m.store.getState().scans[ATM.id]?.status === 'done');
  });
  return m;
}

type M = Awaited<ReturnType<typeof renderApp>>;

async function openHistory(m: M) {
  await act(async () => {
    fireEvent.click(screen.getByRole('tab', { name: /History/ }));
    await until(() => m.store.getState().history[ATM.id]?.status === 'done');
  });
  return screen.getByRole('list', { name: 'Backup history' });
}

const panel = () => screen.getByRole('region', { name: /^Work order \d+:/ });

describe('work order in the workspace', () => {
  it('a fix opens the panel in place of the mods; Enter never executes it; Esc cancels and discards', async () => {
    const m = await renderApp();
    fireEvent.click(screen.getByRole('button', { name: /Create misbehaves/ }));
    await act(async () => {
      fireEvent.click(within(screen.getByRole('list', { name: /Findings/ })).getByRole('button', { name: /^Disable create/ }));
      await until(() => m.store.getState().order !== null);
    });
    const p = panel();
    expect(screen.queryByRole('heading', { name: 'Mods' })).toBeNull();
    expect(document.activeElement).toBe(p);
    expect(within(p).queryByText('↵')).toBeNull();
    fireEvent.keyDown(p, { key: 'Enter' });
    expect(m.store.getState().order?.phase).toBe('review');
    // Fix buttons wait while an order is open.
    expect((within(screen.getByRole('list', { name: /Findings/ })).getByRole('button', { name: /^Disable create/ }) as HTMLButtonElement).disabled).toBe(true);
    const id = m.store.getState().order!.order.id;
    await act(async () => {
      fireEvent.keyDown(p, { key: 'Escape' });
      await until(() => !m.backend.fix.storedOrders().includes(id));
    });
    expect(m.store.getState().order).toBeNull();
    expect(screen.getByRole('heading', { name: 'Mods' })).toBeTruthy();
  });

  it('Execute by click runs it, shows the outcome and Close; Esc then closes', async () => {
    const m = await renderApp();
    await act(async () => {
      await m.store.getState().fix('dis', { kind: 'disable', jarId: CREATE });
    });
    await act(async () => {
      fireEvent.click(within(panel()).getByRole('button', { name: 'Execute' }));
      await until(() => m.store.getState().order?.phase === 'finished' && m.store.getState().scans[ATM.id]?.status === 'done');
    });
    expect(within(panel()).getByText('Done: 1 operation completed. Each action can be undone from History.')).toBeTruthy();
    expect(document.activeElement).toBe(panel());
    fireEvent.keyDown(panel(), { key: 'Escape' });
    expect(m.store.getState().order).toBeNull();
  });

  it('fix buttons are disabled with the reason when the pack identity is unknown', async () => {
    const m = await renderApp();
    await act(async () => {
      await m.store.getState().addFolder();
      const id = m.store.getState().selectedInstanceId!;
      await until(() => m.store.getState().scans[id]?.status === 'done');
    });
    fireEvent.click(screen.getByRole('button', { name: /Create misbehaves/ }));
    const list = screen.getByRole('list', { name: /Findings/ });
    expect((within(list).getByRole('button', { name: /^Disable create/ }) as HTMLButtonElement).disabled).toBe(true);
    expect(within(list).getByText(/Minecraft version or loader is unknown/)).toBeTruthy();
  });
});

describe('the mod-table toggle', () => {
  // The virtualised table renders rows only with a measured viewport.
  let restore: (() => void) | null = null;
  beforeEach(() => {
    const rect = vi
      .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockReturnValue({ x: 0, y: 0, top: 0, left: 0, right: 1200, bottom: 800, width: 1200, height: 800, toJSON: () => ({}) } as DOMRect);
    const oh = vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(800);
    const ow = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1200);
    restore = () => {
      rect.mockRestore();
      oh.mockRestore();
      ow.mockRestore();
    };
  });
  afterEach(() => restore?.());

  it('plans a one-op order and opens the panel; nothing is renamed before Execute', async () => {
    const m = await renderApp();
    const grid = screen.getByRole('grid', { name: 'Mods' });
    const toggle = within(grid).getAllByRole('button', { name: / enabled$/ })[0]!;
    const before = m.backend.fix.jarsOf(ATM.id).filter((j) => j.disabled).length;
    await act(async () => {
      fireEvent.click(toggle);
      await until(() => m.store.getState().order !== null);
    });
    const o = m.store.getState().order!;
    expect(o.order.actions).toEqual([{ kind: 'disable', jarId: expect.any(String) }]);
    expect(o.order.ops).toHaveLength(1);
    expect(panel().getAttribute('aria-label')).toMatch(/: Disable .+\.jar$/);
    expect(within(panel()).getByText('fix · 1 op')).toBeTruthy();
    expect(m.backend.fix.jarsOf(ATM.id).filter((j) => j.disabled)).toHaveLength(before);
  });
});

describe('History tab', () => {
  it('lists snapshots newest first with per-action Undo, undone marks and Undo all remaining', async () => {
    const m = await renderApp();
    const list = await openHistory(m);
    const entries = within(list).getAllByRole('listitem', { name: /^\d{4}-\d{2}-\d{2} \d{2}:\d{2} / });
    expect(entries).toHaveLength(4);
    expect(entries[1]!.getAttribute('aria-label')).toMatch(/Update Curios API to 5\.9\.1\+1\.20\.1$/);
    // The update lists its file operations in mono.
    expect(within(entries[1]!).getByText(/^download Curios API 5\.9\.1\+1\.20\.1 \(.+\) from cdn\.modrinth\.com → mods\/curios-forge-5\.9\.1\+1\.20\.1\.jar$/)).toBeTruthy();
    expect(within(entries[2]!).getByRole('button', { name: 'Undo all remaining' })).toBeTruthy();
    expect(within(entries[2]!).getAllByRole('button', { name: 'Undo' })).toHaveLength(2);
    expect(within(entries[3]!).getAllByText('undone')).toHaveLength(2);
    expect(within(entries[3]!).getByText('all undone')).toBeTruthy();
    expect(within(entries[3]!).queryByRole('button', { name: /Undo/ })).toBeNull();
    expect(screen.getByText('4 backups')).toBeTruthy();
  });

  it('Undo of a single disable opens an undo order with the ↵ hint; Enter executes it and the action is marked undone', async () => {
    const m = await renderApp();
    const list = await openHistory(m);
    const first = within(list).getAllByRole('listitem', { name: /^\d{4}-/ })[0]!;
    await act(async () => {
      fireEvent.click(within(first).getByRole('button', { name: 'Undo' }));
      await until(() => m.store.getState().order !== null);
    });
    const p = panel();
    expect(m.store.getState().order!.order.kind).toBe('undo');
    expect(within(p).getByText('↵')).toBeTruthy();
    // The history stays visible above the order it started; its buttons wait.
    expect((within(first).getByRole('button', { name: 'Undo' }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => {
      fireEvent.keyDown(p, { key: 'Enter' });
      await until(() => m.store.getState().order?.phase === 'finished' && m.store.getState().history[ATM.id]?.status === 'done');
    });
    const again = within(screen.getByRole('list', { name: 'Backup history' })).getAllByRole('listitem', { name: /^\d{4}-/ })[0]!;
    expect(within(again).getByText('all undone')).toBeTruthy();
  });

  it('a refused undo (file changed since) shows inline under its action, with Dismiss', async () => {
    const m = await renderApp();
    const list = await openHistory(m);
    const entry = within(list).getAllByRole('listitem', { name: /^\d{4}-/ })[2]!;
    const fast = within(entry)
      .getAllByRole('listitem')
      .find((li) => li.textContent?.includes('Disable fastsuite'))!;
    await act(async () => {
      fireEvent.click(within(fast).getByRole('button', { name: 'Undo' }));
      await until(() => Object.keys(m.store.getState().undoErrors).length > 0);
    });
    const row = within(fast).getByRole('alert');
    expect(row.getAttribute('data-kind')).toBe('conflict');
    expect(row.textContent).toContain('mods/fastsuite-1.20.1-5.0.1.jar.disabled is not there any more');
    expect(m.store.getState().order).toBeNull();
    fireEvent.click(within(row).getByRole('button', { name: 'Dismiss' }));
    expect(within(fast).queryByRole('alert')).toBeNull();
  });

  it('an instance without backups says so', async () => {
    const m = await renderApp();
    const fo = MOCK_INSTANCES[1]!;
    await act(async () => {
      m.store.getState().selectInstance(fo.id);
      await until(() => m.store.getState().scans[fo.id]?.status === 'done');
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('tab', { name: /History/ }));
      await until(() => m.store.getState().history[fo.id]?.status === 'done');
    });
    expect(screen.getByText(/No work order has run for this instance yet/)).toBeTruthy();
    expect(screen.getByText('0 backups')).toBeTruthy();
  });
});

describe('backup status: rolled back, interrupted and Recover', () => {
  const CABIN = MOCK_INSTANCES.find((i) => i.id === SEEDED_INTERRUPTED_INSTANCE)!;

  async function renderCabin(opts: Partial<MockOptions> = {}) {
    const m = mockStore(opts);
    render(<App store={m.store} />);
    await act(async () => {
      await m.store.getState().init();
      await until(() => m.store.getState().scans[ATM.id]?.status === 'done');
    });
    await act(async () => {
      m.store.getState().selectInstance(CABIN.id);
      await until(() => m.store.getState().scans[CABIN.id]?.status === 'done' && m.store.getState().history[CABIN.id]?.status === 'done');
    });
    return m;
  }

  it('an interrupted backup is announced in the summary strip (err pip, no toast); the notice opens History', async () => {
    const m = await renderCabin();
    const notice = screen.getByRole('button', { name: /interrupted work order/ });
    expect(notice.getAttribute('title')).toMatch(/some files are in its backup/);
    expect(notice.querySelector('.bg-err')).toBeTruthy();
    // The History tab carries the same mark.
    expect(within(screen.getByRole('tab', { name: /History/ })).getByRole('img', { name: 'interrupted work order' })).toBeTruthy();
    fireEvent.click(notice);
    expect(m.store.getState().findingsTab[CABIN.id]).toBe('history');
    expect(screen.getByRole('list', { name: 'Backup history' })).toBeTruthy();
    // Another instance without one shows no notice.
    await act(async () => {
      m.store.getState().selectInstance(ATM.id);
      await until(() => m.store.getState().history[ATM.id]?.status === 'done');
    });
    expect(screen.queryByRole('button', { name: /interrupted work order/ })).toBeNull();
  });

  it('History: an incomplete backup is an err-rail row with Recover and no per-action Undo', async () => {
    const m = await renderCabin();
    m.store.getState().setFindingsTab(CABIN.id, 'history');
    const entry = await screen.findByRole('listitem', { name: /^\d{4}-\d{2}-\d{2} \d{2}:\d{2} Remove create/ });
    const row = within(entry).getByRole('group', { name: 'Interrupted work order' });
    expect(row.textContent).toContain('Interrupted — some files are in the backup');
    expect(row.querySelector('.bg-err')).toBeTruthy();
    expect(within(row).getByRole('button', { name: 'Recover' })).toBeTruthy();
    expect(within(entry).queryByRole('button', { name: /^Undo/ })).toBeNull();
  });

  it('Recover plans the recovery into the same panel (undo, title from Rust); executing it leaves the backup complete', async () => {
    const m = await renderCabin();
    m.store.getState().setFindingsTab(CABIN.id, 'history');
    const entry = await screen.findByRole('listitem', { name: /Remove create/ });
    const plan = vi.spyOn(m.backend.commands, 'planUndo');
    await act(async () => {
      fireEvent.click(within(entry).getByRole('button', { name: 'Recover' }));
      await until(() => m.store.getState().order !== null);
    });
    expect(plan).toHaveBeenCalledWith(m.store.getState().history[CABIN.id]!.entries[0]!.id, null);
    const o = m.store.getState().order!;
    expect(o.order.kind).toBe('undo');
    expect(panel().getAttribute('aria-label')).toBe(`Work order ${o.order.id}: ${o.order.title}`);
    expect(within(panel()).getByText(o.order.title)).toBeTruthy();
    expect(within(panel()).getByText('undo · 1 op')).toBeTruthy();
    await act(async () => {
      fireEvent.click(within(panel()).getByRole('button', { name: 'Execute' }));
      await until(() => m.store.getState().order?.phase === 'finished' && m.store.getState().history[CABIN.id]?.status === 'done');
    });
    expect(m.store.getState().history[CABIN.id]!.entries[0]!.status).toBe('complete');
    const after = within(screen.getByRole('list', { name: 'Backup history' })).getAllByRole('listitem', { name: /^\d{4}-/ })[0]!;
    expect(within(after).queryByRole('button', { name: 'Recover' })).toBeNull();
    expect(within(after).getByText('all undone')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /interrupted work order/ })).toBeNull();
  });

  it('a refused recovery plan renders inline under the interrupted row', async () => {
    const m = await renderCabin();
    m.store.getState().setFindingsTab(CABIN.id, 'history');
    const entry = await screen.findByRole('listitem', { name: /Remove create/ });
    vi.spyOn(m.backend.commands, 'planUndo').mockResolvedValueOnce({
      status: 'error',
      error: { kind: 'conflict', message: 'Recovery was not planned: mods/x.jar changed since.', path: 'mods/x.jar' },
    });
    await act(async () => {
      fireEvent.click(within(entry).getByRole('button', { name: 'Recover' }));
      await until(() => Object.keys(m.store.getState().undoErrors).length > 0);
    });
    expect(m.store.getState().order).toBeNull();
    const alert = within(entry).getByRole('alert');
    expect(alert.getAttribute('data-kind')).toBe('conflict');
    expect(alert.textContent).toContain('Recovery was not planned');
  });

  it('a rolled-back backup reads "rolled back — files unchanged" and offers no Undo', async () => {
    const m = mockStore({ scenario: 'fixfail' });
    render(<App store={m.store} />);
    await act(async () => {
      await m.store.getState().init();
      await until(() => m.store.getState().scans[ATM.id]?.status === 'done');
    });
    await act(async () => {
      await m.store.getState().fix('d', { kind: 'disable', jarId: CREATE });
      await m.store.getState().executeOrder();
      await until(() => m.store.getState().history[ATM.id]?.status === 'done' && m.store.getState().history[ATM.id]!.entries.length === 5);
      await m.store.getState().cancelOrder();
    });
    const list = await openHistory(m);
    const first = within(list).getAllByRole('listitem', { name: /^\d{4}-/ })[0]!;
    expect(m.store.getState().history[ATM.id]!.entries[0]!.status).toBe('rolledBack');
    expect(within(first).getByText('rolled back — files unchanged')).toBeTruthy();
    expect(within(first).queryByRole('button', { name: /Undo/ })).toBeNull();
    expect(within(first).queryByText('undone')).toBeNull();
  });
});
