// @vitest-environment happy-dom
/**
 * "Save fixed copy…" on screen (mock backend, real rules core): a pack finding's edit buttons →
 * the fixed-copy panel in place of the mod table with Rust's planned ops → Save fixed copy… → the
 * saved path and "Open it in your launcher to install it."; Cancel; refusals as sentences.
 */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { App } from '../../app/App';
import { until } from '../../app/__tests__/helpers';
import { createMockBackend } from '../../app/mockIpc';
import { MOCK_PICKED_PACK } from '../../app/mockData';
import { createAppStore } from '../../app/store';

afterEach(cleanup);

// happy-dom lays nothing out: give every element a box so the virtualised lists render rows.
let restore: (() => void) | null = null;
beforeEach(() => {
  (window as unknown as { happyDOM: { setViewport(v: { width: number; height: number }): void } }).happyDOM.setViewport({ width: 1600, height: 900 });
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

const PACK = MOCK_PICKED_PACK.id;
const IF = 'mods/ImmediatelyFast-Fabric-1.3.4+1.21.1.jar';

async function renderPack() {
  const backend = createMockBackend({ scanMs: 0, latencyMs: 0, iconMs: 0 });
  const store = createAppStore({ backend, frame: (cb) => cb() });
  render(<App store={store} />);
  await act(async () => {
    await store.getState().init();
    await store.getState().openMrpack();
    await until(() => store.getState().scans[PACK]?.status === 'done' && store.getState().modrinth[PACK]?.status === 'done');
  });
  return { backend, store };
}

/** Expand the triage row whose title contains `text`; returns the row. */
function expandRow(text: RegExp): HTMLElement {
  const list = screen.getByRole('list', { name: /^Findings,/ });
  const toggle = within(list).getByRole('button', { name: text, expanded: false });
  fireEvent.click(toggle);
  return toggle.closest<HTMLElement>('[data-finding-id]')!;
}

const panel = () => document.querySelector<HTMLElement>('[data-pack-fix]');

describe('Save fixed copy…', () => {
  it('edit → planned ops in place of the mod table → save → path and the launcher note', async () => {
    const { backend } = await renderPack();
    const row = expandRow(/ImmediatelyFast is listed for Minecraft/);
    expect(within(row).getByText('Edits go into a new copy of the pack; the opened file is never changed.')).toBeTruthy();
    expect(screen.getByRole('grid', { name: 'Mods' })).toBeTruthy();

    await act(async () => {
      fireEvent.click(within(row).getByRole('button', { name: 'Replace with 1.2.21+1.20.1' }));
      await until(() => !!panel()?.textContent?.includes('Becomes'));
    });
    const p = panel()!;
    expect(screen.queryByRole('grid', { name: 'Mods' })).toBeNull();
    expect(p.getAttribute('aria-label')).toBe('Fixed copy of Explorer Kit 2.1.mrpack');
    const edits = within(p).getByRole('list', { name: 'Edits' });
    expect(edits.textContent).toContain('01');
    expect(edits.textContent).toContain('replace');
    expect(edits.textContent).toContain(IF);
    expect(edits.textContent).toContain('Becomes mods/ImmediatelyFast-Fabric-1.2.21+1.20.1.jar');
    expect(within(p).getByTitle(/^https:\/\/cdn\.modrinth\.com\//).getAttribute('data-role')).toBe('source-url');
    expect(within(p).getByText(MOCK_PICKED_PACK.root)).toBeTruthy();
    // The chosen button is disabled and the row says where the edit went.
    expect((within(row).getByRole('button', { name: 'Replace with 1.2.21+1.20.1' }) as HTMLButtonElement).disabled).toBe(true);
    expect(within(row).getByText('In the fixed copy below.')).toBeTruthy();

    const save = within(p).getByRole('button', { name: 'Save fixed copy…' }) as HTMLButtonElement;
    expect(save.className).toContain('bg-fg'); // the primary ink button
    // Enter on the focused button never saves.
    const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    save.dispatchEvent(enter);
    expect(enter.defaultPrevented).toBe(true);
    await act(async () => {
      fireEvent.click(save);
      await until(() => backend.packFix.saved().length === 1);
    });
    const status = within(panel()!).getByRole('status');
    expect(status.textContent).toBe('savedSaved C:\\Users\\alex\\Downloads\\Explorer Kit 2.1 (fixed).mrpack. Open it in your launcher to install it.');
    fireEvent.click(within(panel()!).getByRole('button', { name: 'Close' }));
    expect(panel()).toBeNull();
    expect(screen.getByRole('grid', { name: 'Mods' })).toBeTruthy();
  });

  it('Cancel and Esc drop the draft; nothing is saved', async () => {
    const { backend, store } = await renderPack();
    const row = expandRow(/ImmediatelyFast is listed for Minecraft/);
    await act(async () => {
      fireEvent.click(within(row).getByRole('button', { name: 'Remove ImmediatelyFast-Fabric-1.3.4+1.21.1.jar' }));
      await until(() => store.getState().packFix?.phase === 'review');
    });
    fireEvent.click(within(panel()!).getByRole('button', { name: 'Cancel' }));
    expect(panel()).toBeNull();

    await act(async () => {
      fireEvent.click(within(row).getByRole('button', { name: 'Remove ImmediatelyFast-Fabric-1.3.4+1.21.1.jar' }));
      await until(() => store.getState().packFix?.phase === 'review');
    });
    const p = panel()!;
    p.focus();
    fireEvent.keyDown(p, { key: 'Escape' });
    expect(panel()).toBeNull();
    expect(backend.packFix.saved()).toHaveLength(0);
  });

  it('refusals render as sentences: a failed save in the panel, an unknown version next to the button', async () => {
    const { backend, store } = await renderPack();
    const row = expandRow(/ImmediatelyFast is listed for Minecraft/);
    await act(async () => {
      fireEvent.click(within(row).getByRole('button', { name: 'Remove ImmediatelyFast-Fabric-1.3.4+1.21.1.jar' }));
      await until(() => store.getState().packFix?.phase === 'review');
    });
    backend.packFix.failNextSave = {
      kind: 'conflict',
      message: 'C:\\Users\\alex\\Downloads\\Explorer Kit 2.1 (fixed).mrpack already exists. Save the fixed copy again and choose another name.',
      path: null,
    };
    await act(async () => {
      fireEvent.click(within(panel()!).getByRole('button', { name: 'Save fixed copy…' }));
      await until(() => store.getState().packFix?.error !== null);
    });
    expect(within(panel()!).getByText(/already exists\. Save the fixed copy again and choose another name\./)).toBeTruthy();
    // Removing the only edit closes the panel.
    await act(async () => {
      fireEvent.click(within(panel()!).getByRole('button', { name: /^Remove edit 01/ }));
      await until(() => store.getState().packFix === null);
    });
    expect(panel()).toBeNull();

    // Modrinth has no compatible version of the dependency.
    vi.spyOn(backend.commands, 'modrinthProjectVersions').mockResolvedValue({ status: 'ok', data: [] });
    const dep = expandRow(/requires Cloth Config API/);
    await act(async () => {
      fireEvent.click(within(dep).getByRole('button', { name: 'Add Cloth Config API' }));
      await until(() => Object.keys(store.getState().packEditErrors).length > 0);
    });
    expect(
      within(dep).getByText("Modrinth has no release or beta of Cloth Config API for this pack's loader and Minecraft 1.20.1, so it can't be added."),
    ).toBeTruthy();
    expect(panel()).toBeNull();
    fireEvent.click(within(dep).getByRole('button', { name: 'Dismiss' }));
    expect(within(dep).queryByText(/Modrinth has no release or beta/)).toBeNull();
  });
});
