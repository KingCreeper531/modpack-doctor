// @vitest-environment happy-dom
/** "Paste a log" and "Share on mclo.gs" (logTools.ts, LogDialogs.tsx), rendered over the mock backend. */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { App } from '../../app/App';
import { mockStore, until } from '../../app/__tests__/helpers';
import { isMclogsPage, PASTED_SOURCE_ID, shareErrorText, sharedNote } from '../../app/logTools';
import { MOCK_INSTANCES } from '../../app/mockData';
import { paletteGroups, runPaletteCommand, type PaletteActions } from '../../app/paletteCommands';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function setViewport(width: number) {
  (window as unknown as { happyDOM: { setViewport(v: { width: number; height: number }): void } }).happyDOM.setViewport({ width, height: 900 });
  window.dispatchEvent(new Event('resize'));
}
beforeEach(() => setViewport(1600));

const ATM = MOCK_INSTANCES[0]!;
const NEWEST_CRASH = 'crash-reports/crash-2026-11-03_14.22.07-client.txt';
const CONSOLE = [
  '# Minecraft launcher log started at 2026-09-13 21:45:50',
  '# Instance: All the Mods 9 ',
  '',
  "Unrecognized VM option 'UseConcMarkSweepGC'",
  'Error: Could not create the Java Virtual Machine.',
  'Error: A fatal exception has occurred. Program will exit.',
].join('\n');

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

async function click(el: Element) {
  await act(async () => {
    fireEvent.click(el);
  });
}

const dialog = (name: string) => screen.queryByRole('dialog', { name });

function stubClipboard(writeText: (t: string) => Promise<void>) {
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
}

describe('Paste a log', () => {
  it('analyses pasted text for the selected instance, lists it as pasted and never calls Rust for it', async () => {
    const m = await renderApp();
    const read = vi.spyOn(m.backend.commands, 'readLogDigest');
    await click(screen.getByRole('tab', { name: /Crashes/ }));
    await click(screen.getAllByRole('button', { name: 'Paste a log…' })[0]!);
    const d = dialog('Paste a log')!;
    expect(d.getAttribute('aria-modal')).toBe('true');
    expect(d.textContent).toContain('not uploaded and not saved');
    expect(d.textContent).toContain('Up to 5 MB or 100,000 lines');
    const analyse = within(d).getByRole('button', { name: 'Analyse' });
    expect((analyse as HTMLButtonElement).disabled).toBe(true);
    const area = within(d).getByRole('textbox', { name: 'Log text' });
    expect(document.activeElement).toBe(area);
    await act(async () => {
      fireEvent.change(area, { target: { value: CONSOLE } });
    });
    expect(d.textContent).toContain('6 lines');
    await click(analyse);
    expect(dialog('Paste a log')).toBeNull();
    const c = m.store.getState().crashes[ATM.id]!;
    expect(c.selectedSourceId).toBe(PASTED_SOURCE_ID);
    expect(c.analyses[PASTED_SOURCE_ID]?.findings.map((f) => f.code)).toEqual(['C-JVM-START']);
    expect(m.store.getState().findingsTab[ATM.id]).toBe('crashes');
    const list = screen.getByRole('list', { name: 'Crash reports and logs' });
    expect(within(list).getByTitle(PASTED_SOURCE_ID).textContent).toMatch(/pasted/);
    expect(screen.getByRole('list', { name: /Crash findings/ }).textContent).toContain('Java does not accept the JVM argument -XX:+UseConcMarkSweepGC');
    expect(read.mock.calls.some((c) => c[1] === PASTED_SOURCE_ID)).toBe(false);
    // Nothing to share for pasted text.
    expect(screen.queryByRole('button', { name: 'Share on mclo.gs…' })).toBeNull();
    // A refresh of the file list keeps the pasted text and its analysis.
    await act(async () => {
      await m.store.getState().loadLogSources(ATM.id);
    });
    expect(m.store.getState().crashes[ATM.id]?.analyses[PASTED_SOURCE_ID]?.status).toBe('done');
  });

  it('Esc closes without analysing; typed keys never reach the window shortcuts', async () => {
    const m = await renderApp();
    act(() => m.store.getState().setLogDialog({ kind: 'paste', instanceId: ATM.id }));
    const area = within(dialog('Paste a log')!).getByRole('textbox', { name: 'Log text' });
    act(() => {
      area.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', bubbles: true, cancelable: true }));
    });
    expect(m.store.getState().cursor).toBeNull();
    act(() => {
      area.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    });
    expect(dialog('Paste a log')).toBeNull();
    expect(m.store.getState().crashes[ATM.id]?.analyses[PASTED_SOURCE_ID]).toBeUndefined();
  });
});

describe('Share on mclo.gs', () => {
  it('uploads only after the confirmation, which names the file and says public and ~', async () => {
    const writes: string[] = [];
    stubClipboard(async (t) => {
      writes.push(t);
    });
    const m = await renderApp();
    const share = vi.spyOn(m.backend.commands, 'shareLog');
    await click(screen.getByRole('tab', { name: /Crashes/ }));
    await click(screen.getByRole('button', { name: 'Share on mclo.gs…' }));
    const d = dialog('Share on mclo.gs')!;
    expect(share).not.toHaveBeenCalled();
    expect(d.textContent).toContain('public');
    expect(d.textContent).toContain('home folder is replaced with ~');
    expect(d.textContent).toContain(NEWEST_CRASH);
    expect(d.textContent).toContain(ATM.name);
    // Cancel uploads nothing.
    await click(within(d).getByRole('button', { name: 'Cancel' }));
    expect(dialog('Share on mclo.gs')).toBeNull();
    expect(share).not.toHaveBeenCalled();

    await click(screen.getByRole('button', { name: 'Share on mclo.gs…' }));
    await click(within(dialog('Share on mclo.gs')!).getByRole('button', { name: 'Upload to mclo.gs' }));
    await act(async () => {
      await until(() => !!screen.queryByRole('textbox', { name: 'mclo.gs link' }));
    });
    expect(share).toHaveBeenCalledTimes(1);
    expect(share).toHaveBeenCalledWith(ATM.id, NEWEST_CRASH);
    expect(m.backend.shares()).toEqual([{ instanceId: ATM.id, sourceId: NEWEST_CRASH }]);
    const link = screen.getByRole('textbox', { name: 'mclo.gs link' }) as HTMLInputElement;
    expect(link.value).toBe('https://mclo.gs/Mock1');
    expect(writes).toEqual(['https://mclo.gs/Mock1']);
    expect(dialog('Share on mclo.gs')!.textContent).toContain('copied to the clipboard');
  });

  it('says so when the clipboard is unavailable, and still shows the link', async () => {
    stubClipboard(() => Promise.reject(new Error('denied')));
    const m = await renderApp();
    act(() => m.store.getState().setLogDialog({ kind: 'share', instanceId: ATM.id, sourceId: NEWEST_CRASH }));
    await click(within(dialog('Share on mclo.gs')!).getByRole('button', { name: 'Upload to mclo.gs' }));
    await act(async () => {
      await until(() => !!screen.queryByRole('textbox', { name: 'mclo.gs link' }));
    });
    expect(dialog('Share on mclo.gs')!.textContent).toContain('the clipboard was not available');
  });

  it('offline: a clear sentence, nothing uploaded, Try again offered', async () => {
    const m = await renderApp({ scenario: 'shareoffline' });
    act(() => m.store.getState().setLogDialog({ kind: 'share', instanceId: ATM.id, sourceId: NEWEST_CRASH }));
    await click(within(dialog('Share on mclo.gs')!).getByRole('button', { name: 'Upload to mclo.gs' }));
    await act(async () => {
      await until(() => !!screen.queryByRole('alert'));
    });
    const d = dialog('Share on mclo.gs')!;
    const alert = within(d).getByRole('alert');
    expect(alert.textContent).toContain('This computer seems to be offline, so nothing was uploaded.');
    expect(alert.getAttribute('data-kind')).toBe('offline');
    expect(within(d).getByRole('button', { name: 'Try again' })).toBeTruthy();
    expect(m.backend.shares()).toEqual([]);
  });

  it('a source that is no longer listed is refused by the backend and shown inline', async () => {
    const m = await renderApp();
    act(() => m.store.getState().setLogDialog({ kind: 'share', instanceId: ATM.id, sourceId: '../../secret.txt' }));
    await click(within(dialog('Share on mclo.gs')!).getByRole('button', { name: 'Upload to mclo.gs' }));
    await act(async () => {
      await until(() => !!screen.queryByRole('alert'));
    });
    expect(within(dialog('Share on mclo.gs')!).getByRole('alert').getAttribute('data-kind')).toBe('notFound');
    expect(m.backend.shares()).toEqual([]);
  });
});

describe('palette and helpers', () => {
  it('offers Paste for the instance and Share for its selected file only', async () => {
    const m = await renderApp();
    const st = m.store.getState();
    const actions = paletteGroups(st).find((g) => g.heading === 'Actions')!.items.map((i) => i.id);
    expect(actions).toContain('paste-log');
    expect(actions).toContain(`share-log:${NEWEST_CRASH}`);
    const calls: unknown[] = [];
    const a = {
      setFindingsTab: () => undefined,
      setLogDialog: (d: unknown) => calls.push(d),
    } as unknown as PaletteActions;
    runPaletteCommand(`share-log:${NEWEST_CRASH}`, st, a);
    runPaletteCommand('paste-log', st, a);
    expect(calls).toEqual([
      { kind: 'share', instanceId: ATM.id, sourceId: NEWEST_CRASH },
      { kind: 'paste', instanceId: ATM.id },
    ]);
    // Without crash state (older callers) there is no share entry.
    const { crashes: _c, ...rest } = st;
    expect(paletteGroups(rest).find((g) => g.heading === 'Actions')!.items.some((i) => i.id.startsWith('share-log'))).toBe(false);
  });

  it('opens only mclo.gs log pages; explains a cut upload', () => {
    expect(isMclogsPage('https://mclo.gs/WnMMikq')).toBe(true);
    for (const bad of ['http://mclo.gs/x', 'https://mclo.gs.evil.com/x', 'https://mclo.gs/a/b', 'https://api.mclo.gs/1/raw/x', 'javascript:alert(1)']) {
      expect(isMclogsPage(bad), bad).toBe(false);
    }
    expect(sharedNote({ url: '', rawUrl: '', totalLines: 30000, sentLines: 24999, truncated: true })).toContain('the last 24,999 of 30,000 lines');
    expect(shareErrorText({ kind: 'network', message: 'mclo.gs had a server error (HTTP 503). Try again later.', path: null })).toContain('HTTP 503');
  });
});
