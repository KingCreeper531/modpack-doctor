// @vitest-environment happy-dom
/** M7 screens: command palette, shortcuts, context menus, .mrpack workspace, drop feedback, report export. */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { App } from '../../app/App';
import { finding, mockStore, until } from '../../app/__tests__/helpers';
import { MOCK_INSTANCES, MOCK_PICKED_PACK } from '../../app/mockData';

afterEach(cleanup);

function setViewport(width: number) {
  (window as unknown as { happyDOM: { setViewport(v: { width: number; height: number }): void } }).happyDOM.setViewport({ width, height: 900 });
  window.dispatchEvent(new Event('resize'));
}

beforeEach(() => setViewport(1600));

// happy-dom lays nothing out, so the virtualised mod table would render no rows: give every
// element a 1200×800 box while these tests run.
let restoreLayout: (() => void) | null = null;
beforeEach(() => {
  const rect = vi
    .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
    .mockReturnValue({ x: 0, y: 0, top: 0, left: 0, right: 1200, bottom: 800, width: 1200, height: 800, toJSON: () => ({}) } as DOMRect);
  const oh = vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(800);
  const ow = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1200);
  restoreLayout = () => {
    rect.mockRestore();
    oh.mockRestore();
    ow.mockRestore();
  };
});
afterEach(() => restoreLayout?.());

const ATM = MOCK_INSTANCES[0]!;
const CREATE = 'mods/create-1.20.1-0.5.1.f.jar';
const JEI = 'mods/jei-1.20.1-forge-15.2.0.27.jar';

const findings = () => [
  finding('dis', 'error', [CREATE], { title: 'Create misbehaves', fixes: [{ kind: 'disable', jarId: CREATE }] }),
  finding('dup', 'warning', [JEI], { title: 'JEI twice' }),
  finding('info', 'info', [JEI], { title: 'Just so you know', fixes: [] }),
];

async function renderApp(opts: Parameters<typeof mockStore>[0] = {}, make = findings) {
  const m = mockStore(opts, make);
  render(<App store={m.store} />);
  await act(async () => {
    await m.store.getState().init();
    await until(() => m.store.getState().scans[ATM.id]?.status === 'done');
  });
  return m;
}

type M = Awaited<ReturnType<typeof renderApp>>;

/** A key press as the user makes it: on the focused element (or the body), bubbling to window. */
function press(key: string, mods: Partial<KeyboardEventInit> = {}, target: Element = document.activeElement ?? document.body) {
  const e = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...mods });
  act(() => {
    target.dispatchEvent(e);
  });
  return e;
}

const triageRows = () => screen.getByRole('list', { name: /^Findings,/ }).querySelectorAll<HTMLElement>('[data-finding-id]');
const cursorRow = () => document.querySelector<HTMLElement>('[data-cursor="true"]')?.closest<HTMLElement>('[data-finding-id]')?.dataset.findingId ?? null;

async function openPack(m: M) {
  await act(async () => {
    await m.store.getState().openMrpack();
    await until(() => m.store.getState().scans[MOCK_PICKED_PACK.id]?.status === 'done');
    await until(() => m.store.getState().modrinth[MOCK_PICKED_PACK.id]?.status === 'done');
  });
}

describe('command palette', () => {
  it('Ctrl+K opens it; a command switches the instance; Esc closes and focus returns', async () => {
    await renderApp();
    const rescan = screen.getByRole('button', { name: 'Rescan' });
    rescan.focus();
    press('k', { ctrlKey: true });
    const input = screen.getByPlaceholderText('instance, mod id, or action…');
    expect(document.activeElement).toBe(input);
    const palette = document.querySelector<HTMLElement>('[cmdk-root]')!;
    for (const h of ['Instances', 'Actions', 'Findings', 'Mods']) expect(within(palette).getByText(h)).toBeTruthy();
    // Esc closes and gives focus back.
    press('Escape', {}, input);
    expect(screen.queryByPlaceholderText('instance, mod id, or action…')).toBeNull();
    expect(document.activeElement).toBe(rescan);

    press('k', { metaKey: true }, document.body);
    const fo = MOCK_INSTANCES[1]!;
    fireEvent.click(screen.getByRole('option', { name: new RegExp(`^${fo.name}`) }));
    expect(screen.queryByPlaceholderText('instance, mod id, or action…')).toBeNull();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(fo.name);
  });

  it('go to finding (by code) expands and selects it; finding codes are mono', async () => {
    const m = await renderApp();
    press('k', { ctrlKey: true }, document.body);
    const option = screen.getByRole('option', { name: /Create misbehaves/ });
    expect(within(option).getByText('E-DUP-ID').className).toContain('t-mono');
    fireEvent.click(option);
    expect(m.store.getState().selection).toEqual({ kind: 'finding', id: 'dis' });
    expect(m.store.getState().cursor).toBe('dis');
    const row = Array.from(triageRows()).find((r) => r.dataset.findingId === 'dis')!;
    expect(row.querySelector('[aria-expanded]')!.getAttribute('aria-expanded')).toBe('true');
  });

  it('theme commands and Export report run through the store; nothing executes an order', async () => {
    const m = await renderApp();
    const exec = vi.spyOn(m.backend.commands, 'executeWorkOrder');
    press('k', { ctrlKey: true }, document.body);
    fireEvent.click(screen.getByRole('option', { name: /^Theme: Light/ }));
    expect(m.store.getState().settings.theme).toBe('light');
    press('k', { ctrlKey: true }, document.body);
    await act(async () => {
      fireEvent.click(screen.getByRole('option', { name: /^Export report \(JSON\)/ }));
      await until(() => m.store.getState().reports[ATM.id]?.status === 'saved');
    });
    expect(screen.getByText('Report saved')).toBeTruthy();
    expect(exec).not.toHaveBeenCalled();
  });
});

describe('shortcuts', () => {
  it('J/K move the keyboard cursor, Enter expands, Esc clears the selection', async () => {
    const m = await renderApp();
    press('j', {}, document.body);
    expect(cursorRow()).toBe('dis');
    press('j', {}, document.body);
    press('j', {}, document.body);
    press('j', {}, document.body);
    expect(cursorRow()).toBe('info');
    press('k', {}, document.body);
    expect(cursorRow()).toBe('dup');
    const row = Array.from(triageRows()).find((r) => r.dataset.findingId === 'dup')!;
    const toggle = row.querySelector('[aria-expanded]')!;
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    press('Enter', {}, document.body);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(m.store.getState().selection).toEqual({ kind: 'finding', id: 'dup' });
    press('Enter', {}, document.body);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    press('Escape', {}, document.body);
    expect(m.store.getState().selection).toBeNull();
  });

  it('never fires while typing', async () => {
    const m = await renderApp();
    const input = screen.getByRole('textbox', { name: /Minecraft/i });
    input.focus();
    press('j', {}, input);
    press('k', { ctrlKey: true }, input);
    expect(m.store.getState().cursor).toBeNull();
    expect(m.store.getState().paletteOpen).toBe(false);
    const scan = vi.spyOn(m.store.getState(), 'scan');
    const e = press('r', { ctrlKey: true }, input);
    // The webview reload is swallowed, but no rescan starts from a text field.
    expect(e.defaultPrevented).toBe(true);
    expect(scan).not.toHaveBeenCalled();
  });

  it('Ctrl+R rescans instead of reloading', async () => {
    const m = await renderApp();
    const scan = vi.spyOn(m.backend.commands, 'scanInstance');
    const e = press('r', { ctrlKey: true }, document.body);
    expect(e.defaultPrevented).toBe(true);
    expect(scan).toHaveBeenCalledWith(ATM.id);
    await act(async () => {
      await until(() => m.store.getState().scans[ATM.id]?.status === 'done');
    });
  });

  it('never executes or discards a work order: Enter and Esc leave an open order alone', async () => {
    const m = await renderApp();
    const exec = vi.spyOn(m.backend.commands, 'executeWorkOrder');
    const discard = vi.spyOn(m.backend.commands, 'discardWorkOrder');
    await act(async () => {
      await m.store.getState().fix('dis', { kind: 'disable', jarId: CREATE }, 'triage');
    });
    expect(m.store.getState().order?.phase).toBe('review');
    m.store.getState().select({ kind: 'finding', id: 'dis' });
    m.store.getState().setCursor('dis');
    (document.activeElement as HTMLElement | null)?.blur();
    press('Enter', {}, document.body);
    press('Escape', {}, document.body);
    expect(exec).not.toHaveBeenCalled();
    expect(discard).not.toHaveBeenCalled();
    expect(m.store.getState().order?.phase).toBe('review');
    // Esc did not even clear the selection: the order is the top-most thing on screen.
    expect(m.store.getState().selection).toEqual({ kind: 'finding', id: 'dis' });
    // Enter inside the order panel stays the panel's (a disable is not a single-rename undo).
    const panel = screen.getByRole('region', { name: /^Work order/ });
    press('Enter', {}, panel);
    expect(exec).not.toHaveBeenCalled();
  });
});

describe('context menus (DOM menu of the browser build)', () => {
  it('mod row: keyboard navigation, Disable plans a work order (never executes it), Esc returns focus', async () => {
    const m = await renderApp();
    await act(async () => {
      await until(() => m.store.getState().modrinth[ATM.id]?.status === 'done');
    });
    const exec = vi.spyOn(m.backend.commands, 'executeWorkOrder');
    const row = screen.getByRole('grid', { name: 'Mods' }).querySelector<HTMLElement>('[data-row-id]')!;
    const jarId = row.dataset.rowId!;
    row.focus();
    fireEvent.contextMenu(row, { clientX: 300, clientY: 400 });
    let menu = screen.getByRole('menu');
    expect(within(menu).getAllByRole('menuitem').map((i) => i.textContent)).toEqual(['Disable…', 'Show in inspector', 'Copy file name', 'Open on Modrinth']);
    expect(within(menu).getAllByRole('separator')).toHaveLength(1);
    expect(document.activeElement?.textContent).toBe('Disable…');
    press('ArrowDown');
    expect(document.activeElement?.textContent).toBe('Show in inspector');
    press('End');
    expect(document.activeElement?.textContent).toBe('Open on Modrinth');
    press('ArrowDown');
    expect(document.activeElement?.textContent).toBe('Disable…');
    press('Escape');
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(row);

    fireEvent.contextMenu(row, { clientX: 300, clientY: 400 });
    menu = screen.getByRole('menu');
    await act(async () => {
      press('Enter');
      await until(() => m.store.getState().order !== null);
    });
    expect(m.store.getState().order).toMatchObject({ phase: 'review', source: { action: { kind: 'disable', jarId } } });
    expect(exec).not.toHaveBeenCalled();
  });

  it('finding row: Copy summary, Apply first fix (planned), Show in inspector', async () => {
    const m = await renderApp();
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const row = Array.from(triageRows()).find((r) => r.dataset.findingId === 'dis')!;
    fireEvent.contextMenu(row.firstElementChild!, { clientX: 300, clientY: 300 });
    const items = within(screen.getByRole('menu')).getAllByRole('menuitem');
    expect(items.map((i) => i.textContent)).toEqual(['Copy summary', expect.stringMatching(/^Apply first fix: Disable /), 'Show in inspector']);
    await act(async () => {
      fireEvent.click(items[0]!);
    });
    expect(writeText).toHaveBeenCalledWith('E-DUP-ID  Create misbehaves  (create-1.20.1-0.5.1.f.jar)');
    fireEvent.contextMenu(row.firstElementChild!, { clientX: 300, clientY: 300 });
    await act(async () => {
      fireEvent.click(screen.getByRole('menuitem', { name: /^Apply first fix/ }));
      await until(() => m.store.getState().order !== null);
    });
    expect(m.store.getState().order?.phase).toBe('review');
    // A finding with no plannable fix offers none.
    const info = Array.from(triageRows()).find((r) => r.dataset.findingId === 'info')!;
    fireEvent.contextMenu(info.firstElementChild!, { clientX: 300, clientY: 300 });
    expect(within(screen.getByRole('menu')).getAllByRole('menuitem').map((i) => i.textContent)).toEqual(['Copy summary', 'Show in inspector']);
  });

  it('instance rail rows: launcher instances cannot be removed; an opened pack can (and never offers watch)', async () => {
    const m = await renderApp();
    const rail = screen.getByRole('navigation', { name: 'Instance list' });
    fireEvent.contextMenu(within(rail).getByRole('button', { name: new RegExp(`^${ATM.name}`) }), { clientX: 100, clientY: 50 });
    expect(within(screen.getByRole('menu')).getAllByRole('menuitem').map((i) => i.firstElementChild?.textContent)).toEqual([
      'Rescan',
      'Watch for crashes',
      'Export report (Markdown)…',
      'Export report (JSON)…',
    ]);
    press('Escape');
    await openPack(m);
    fireEvent.contextMenu(within(rail).getByRole('button', { name: new RegExp(`^${MOCK_PICKED_PACK.name}`) }), { clientX: 100, clientY: 400 });
    const items = within(screen.getByRole('menu')).getAllByRole('menuitem').map((i) => i.firstElementChild?.textContent);
    expect(items).toEqual(['Rescan', 'Export report (Markdown)…', 'Export report (JSON)…', 'Close pack']);
    await act(async () => {
      fireEvent.click(screen.getByRole('menuitem', { name: 'Close pack' }));
      await until(() => !m.store.getState().discovery!.instances.some((i) => i.id === MOCK_PICKED_PACK.id));
    });
    expect(within(rail).queryByRole('button', { name: new RegExp(`^${MOCK_PICKED_PACK.name}`) })).toBeNull();
  });
});

describe('.mrpack', () => {
  it('Open .mrpack sits next to Add folder and opens a read-only pack workspace', async () => {
    const m = await renderApp();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Open .mrpack' }));
      await until(() => m.store.getState().scans[MOCK_PICKED_PACK.id]?.status === 'done');
      await until(() => m.store.getState().modrinth[MOCK_PICKED_PACK.id]?.status === 'done');
    });
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(MOCK_PICKED_PACK.name);
    expect(screen.getByText('PACK · read-only')).toBeTruthy();
    const rail = screen.getByRole('navigation', { name: 'Instance list' });
    expect(within(rail).getByRole('button', { name: new RegExp(`^${MOCK_PICKED_PACK.name}`) }).textContent).toContain('PACK');
    // No watch toggle, no history legend.
    expect(screen.queryByRole('button', { name: /^Watch for crashes/ })).toBeNull();
    expect(screen.getAllByRole('tab').map((t) => t.textContent?.replace(/\d+$/, ''))).toEqual(['Findings', 'Crashes']);
    // Mod table: zip jars + declared files, an Env column, no toggles.
    const grid = screen.getByRole('grid', { name: 'Mods' });
    expect(within(grid).queryAllByRole('button', { pressed: true })).toHaveLength(0);
    expect(within(grid).queryAllByRole('button', { pressed: false })).toHaveLength(0);
    expect(within(grid).getByText('mods/explorer-waypoints-0.4.jar')).toBeTruthy();
    expect(within(grid).getByText('Sodium')).toBeTruthy();
    expect(within(grid).getByText('Env C/S')).toBeTruthy();
    expect(within(grid).getAllByText('req/no').length).toBeGreaterThan(0);
    expect(screen.getByText('8 mods')).toBeTruthy();
    expect(screen.getByText('2 in zip · 6 declared')).toBeTruthy();
    // Findings carry no fix buttons.
    const list = screen.queryByRole('list', { name: /^Findings,/ });
    if (list) {
      for (const t of within(list).getAllByRole('button', { expanded: false })) fireEvent.click(t);
      expect(within(list).queryByRole('button', { name: /^(Disable|Update|Install|Remove|Enable)/ })).toBeNull();
    }
    // A declared row's menu: nothing that changes files; it opens as a pack index entry.
    const declaredRow = document.querySelector<HTMLElement>('[data-row-id="mods/sodium-fabric-0.5.11+mc1.20.1.jar"]')!;
    fireEvent.contextMenu(declaredRow, { clientX: 300, clientY: 500 });
    expect(within(screen.getByRole('menu')).getAllByRole('menuitem').map((i) => i.textContent)).toEqual(['Show in inspector', 'Copy file name', 'Open on Modrinth']);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Show in inspector' }));
    const inspector = screen.getByRole('complementary', { name: 'Inspector' });
    expect(within(inspector).getByText('pack index entry')).toBeTruthy();
    expect(within(inspector).getByText('mods/sodium-fabric-0.5.11+mc1.20.1.jar')).toBeTruthy();
    // Override jars: no Disable either.
    const jarRow = document.querySelector<HTMLElement>('[data-row-id="overrides/mods/explorerkit-branding-2.1.0.jar"]')!;
    fireEvent.contextMenu(jarRow, { clientX: 300, clientY: 500 });
    expect(within(screen.getByRole('menu')).queryByRole('menuitem', { name: /Disable|Enable/ })).toBeNull();
  });

  it('a refused drop shows inline in the rail (not a toast) until dismissed', async () => {
    const m = await renderApp();
    act(() => m.backend.emitDropRejected({ name: 'notes.zip', reason: 'only Modrinth modpacks (.mrpack files) and instance folders can be added.' }));
    const alert = screen.getByRole('alert');
    expect(alert.closest('section')?.getAttribute('aria-label')).toBe('Instances');
    expect(alert.textContent).toContain('notes.zip was not added: only Modrinth modpacks (.mrpack files) and instance folders can be added.');
    fireEvent.click(within(alert).getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows a quiet overlay only while files are dragged over the window', async () => {
    await renderApp();
    const drag = (type: string, types: string[]) => {
      const e = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(e, 'dataTransfer', { value: { types } });
      act(() => {
        window.dispatchEvent(e);
      });
      return e;
    };
    drag('dragenter', ['text/plain']);
    expect(screen.queryByTestId('drop-overlay')).toBeNull();
    drag('dragenter', ['Files']);
    expect(screen.getByTestId('drop-overlay').textContent).toContain('Release to open a .mrpack file');
    drag('dragleave', ['Files']);
    expect(screen.queryByTestId('drop-overlay')).toBeNull();
    drag('dragenter', ['Files']);
    const drop = drag('drop', ['Files']);
    // The DOM drop never opens anything; it is only cancelled (Rust handles the real drop).
    expect(drop.defaultPrevented).toBe(true);
    expect(screen.queryByTestId('drop-overlay')).toBeNull();
  });
});

describe('report export', () => {
  it('Export report → Markdown saves and shows the path inline; cancel shows nothing', async () => {
    const m = await renderApp();
    fireEvent.click(screen.getByRole('button', { name: 'Export report' }));
    await act(async () => {
      fireEvent.click(screen.getByRole('menuitem', { name: 'Markdown (.md)…' }));
      await until(() => m.store.getState().reports[ATM.id]?.status === 'saved');
    });
    const status = screen.getByText('Report saved').closest('[role="status"]')!;
    expect(status.textContent).toMatch(/C:\\Users\\alex\\Documents\\modpack-doctor-all-the-mods-9-\d{4}-\d{2}-\d{2}\.md/);
    fireEvent.click(within(status as HTMLElement).getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByText('Report saved')).toBeNull();

    vi.spyOn(m.backend.commands, 'saveReport').mockResolvedValue({ status: 'ok', data: null });
    fireEvent.click(screen.getByRole('button', { name: 'Export report' }));
    await act(async () => {
      fireEvent.click(screen.getByRole('menuitem', { name: 'JSON (.json)…' }));
      await until(() => m.store.getState().reports[ATM.id] === undefined);
    });
    expect(screen.queryByText('Report saved')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('a refusal renders as an inline error row', async () => {
    const m = await renderApp();
    vi.spyOn(m.backend.commands, 'saveReport').mockResolvedValue({ status: 'error', error: { kind: 'conflict', message: 'The file exists and the replace was not confirmed.', path: null } });
    await act(async () => {
      await m.store.getState().exportReport(ATM.id, 'markdown');
    });
    const alert = screen.getByRole('alert');
    expect(within(alert).getByText('conflict')).toBeTruthy();
    expect(alert.textContent).toContain('The file exists and the replace was not confirmed.');
  });
});
