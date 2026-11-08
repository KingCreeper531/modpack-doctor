// @vitest-environment happy-dom
/**
 * The Paste/Share dialogs keep the keyboard (review M3), offer "Delete from mclo.gs" after an
 * upload (M4) and say what happens to pasted and shared text (H1, L6).
 */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SharedLog } from '../../../bindings';
import { App } from '../../app/App';
import { mockStore, until } from '../../app/__tests__/helpers';
import type { Result } from '../../app/ipc';
import { MOCK_INSTANCES } from '../../app/mockData';
import { handleKey } from '../Overlays';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function setViewport(width: number) {
  (window as unknown as { happyDOM: { setViewport(v: { width: number; height: number }): void } }).happyDOM.setViewport({ width, height: 900 });
  window.dispatchEvent(new Event('resize'));
}
beforeEach(() => {
  setViewport(1600);
  Object.defineProperty(navigator, 'clipboard', { value: { writeText: () => Promise.resolve() }, configurable: true });
});

const ATM = MOCK_INSTANCES[0]!;
const NEWEST_CRASH = 'crash-reports/crash-2026-11-03_14.22.07-client.txt';

async function renderApp(...args: Parameters<typeof mockStore>) {
  const m = mockStore(...args);
  render(<App store={m.store} />);
  await act(async () => {
    await m.store.getState().init();
    await until(() => m.store.getState().scans[ATM.id]?.status === 'done');
    await until(() => m.store.getState().crashes[ATM.id]?.analyses[NEWEST_CRASH]?.status === 'done');
  });
  return m;
}

const dialog = (name: string) => screen.queryByRole('dialog', { name });

async function click(el: Element) {
  await act(async () => {
    fireEvent.click(el);
  });
}

/** A key press on the page body (focus outside the dialog), through the window listener. */
function pressOnBody(key: string, mods: Partial<KeyboardEventInit> = {}) {
  act(() => {
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...mods }));
  });
}

/** `share_log` that answers only when the test says so. */
function holdUpload(m: Awaited<ReturnType<typeof renderApp>>) {
  let answer: (r: Result<SharedLog>) => void = () => undefined;
  vi.spyOn(m.backend.commands, 'shareLog').mockImplementation(
    () =>
      new Promise((resolve) => {
        answer = resolve;
      }),
  );
  return (r: Result<SharedLog> = { status: 'ok', data: { url: 'https://mclo.gs/Held1', rawUrl: 'https://api.mclo.gs/1/raw/Held1', totalLines: 3, sentLines: 3, truncated: false } }) =>
    act(async () => {
      answer(r);
      await until(() => !m.store.getState().logDialogBusy);
    });
}

describe('keyboard containment of the log dialogs (M3)', () => {
  it('while uploading: focus on the panel, Esc and the palette do nothing, the dialog cannot be replaced', async () => {
    const m = await renderApp();
    const release = holdUpload(m);
    const scan = vi.spyOn(m.store.getState(), 'scan');
    act(() => m.store.getState().setLogDialog({ kind: 'share', instanceId: ATM.id, sourceId: NEWEST_CRASH }));
    await click(within(dialog('Share on mclo.gs')!).getByRole('button', { name: 'Upload to mclo.gs' }));
    const d = dialog('Share on mclo.gs')!;
    expect(m.store.getState().logDialogBusy).toBe(true);
    expect(document.activeElement).toBe(d);
    expect(d.getAttribute('aria-busy')).toBe('true');

    // Esc on the dialog and on the body: still open.
    act(() => {
      d.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    });
    pressOnBody('Escape');
    expect(dialog('Share on mclo.gs')).not.toBeNull();
    // Ctrl+K, Ctrl+R, J from the body: nothing opens, rescans or moves underneath.
    pressOnBody('k', { ctrlKey: true });
    pressOnBody('r', { ctrlKey: true });
    pressOnBody('j');
    expect(m.store.getState().paletteOpen).toBe(false);
    expect(scan).not.toHaveBeenCalled();
    expect(m.store.getState().cursor).toBeNull();
    // Another dialog (palette command, menu) cannot replace it mid-upload.
    act(() => m.store.getState().setLogDialog({ kind: 'paste', instanceId: ATM.id }));
    expect(dialog('Share on mclo.gs')).not.toBeNull();
    expect(dialog('Paste a log')).toBeNull();

    await release();
    const done = dialog('Share on mclo.gs')!;
    expect(document.activeElement).toBe(done.querySelector('[data-autofocus]'));
    expect(document.activeElement?.textContent).toBe('Close');
    // Answered: the global Esc closes it now.
    pressOnBody('Escape');
    expect(dialog('Share on mclo.gs')).toBeNull();
  });

  it('the global Esc closes a log dialog before About or the inspector selection', async () => {
    const m = await renderApp();
    act(() => m.store.getState().setLogDialog({ kind: 'paste', instanceId: ATM.id }));
    const e = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    Object.defineProperty(e, 'target', { value: document.body });
    act(() => handleKey(m.store, e));
    expect(m.store.getState().logDialog).toBeNull();
    expect(e.defaultPrevented).toBe(true);
  });

  it('while any log dialog is open the palette shortcut is swallowed', async () => {
    const m = await renderApp();
    act(() => m.store.getState().setLogDialog({ kind: 'paste', instanceId: ATM.id }));
    const e = new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true, cancelable: true });
    act(() => handleKey(m.store, e));
    expect(m.store.getState().paletteOpen).toBe(false);
    expect(e.defaultPrevented).toBe(true);
    expect(m.store.getState().logDialog).toEqual({ kind: 'paste', instanceId: ATM.id });
  });
});

describe('Delete from mclo.gs (M4)', () => {
  it('one click deletes the upload; the dialog says the link no longer works', async () => {
    const m = await renderApp();
    act(() => m.store.getState().setLogDialog({ kind: 'share', instanceId: ATM.id, sourceId: NEWEST_CRASH }));
    await click(within(dialog('Share on mclo.gs')!).getByRole('button', { name: 'Upload to mclo.gs' }));
    await act(async () => {
      await until(() => !!screen.queryByRole('textbox', { name: 'mclo.gs link' }));
    });
    await click(within(dialog('Share on mclo.gs')!).getByRole('button', { name: 'Delete from mclo.gs' }));
    await act(async () => {
      await until(() => !!dialog('Share on mclo.gs')?.textContent?.includes('Deleted from mclo.gs'));
    });
    expect(m.backend.deletedShares()).toEqual(['Mock1']);
    const d = dialog('Share on mclo.gs')!;
    expect(d.textContent).toContain('The link no longer works.');
    expect(document.activeElement).toBe(d.querySelector('[data-autofocus]'));
    expect(document.activeElement?.textContent).toBe('Close');
  });

  it('a refused delete is shown inline and the link stays', async () => {
    const m = await renderApp();
    vi.spyOn(m.backend.commands, 'deleteSharedLog').mockResolvedValue({
      status: 'error',
      error: { kind: 'network', message: 'mclo.gs refused to delete the log (HTTP 403: Invalid token), so it is still online.', path: null },
    });
    act(() => m.store.getState().setLogDialog({ kind: 'share', instanceId: ATM.id, sourceId: NEWEST_CRASH }));
    await click(within(dialog('Share on mclo.gs')!).getByRole('button', { name: 'Upload to mclo.gs' }));
    await act(async () => {
      await until(() => !!screen.queryByRole('textbox', { name: 'mclo.gs link' }));
    });
    await click(within(dialog('Share on mclo.gs')!).getByRole('button', { name: 'Delete from mclo.gs' }));
    await act(async () => {
      await until(() => !!screen.queryByRole('alert'));
    });
    const d = dialog('Share on mclo.gs')!;
    expect(within(d).getByRole('alert').textContent).toContain('so it is still online');
    expect((screen.getByRole('textbox', { name: 'mclo.gs link' }) as HTMLInputElement).value).toBe('https://mclo.gs/Mock1');
  });
});

describe('what the dialogs say (H1, L6)', () => {
  it('the share confirmation says tokens and the user name are removed and the Minecraft name stays', async () => {
    const m = await renderApp();
    act(() => m.store.getState().setLogDialog({ kind: 'share', instanceId: ATM.id, sourceId: NEWEST_CRASH }));
    const t = dialog('Share on mclo.gs')!.textContent ?? '';
    expect(t).toContain('home folder is replaced with ~');
    expect(t).toContain('login tokens, account IDs and your computer’s user name are removed');
    expect(t).toContain('Your Minecraft player name stays visible');
  });

  it('the paste dialog mentions Modrinth lookups only when they are on', async () => {
    const m = await renderApp();
    act(() => m.store.getState().setLogDialog({ kind: 'paste', instanceId: ATM.id }));
    expect(dialog('Paste a log')!.textContent).toContain('not uploaded and not saved; mod names in it may be looked up on Modrinth');
    act(() => m.store.getState().setLogDialog(null));
    await act(async () => {
      await m.store.getState().setModrinthEnabled(false);
    });
    act(() => m.store.getState().setLogDialog({ kind: 'paste', instanceId: ATM.id }));
    const t = dialog('Paste a log')!.textContent ?? '';
    expect(t).toContain('The text stays on this computer');
    expect(t).not.toContain('Modrinth');
  });
});
