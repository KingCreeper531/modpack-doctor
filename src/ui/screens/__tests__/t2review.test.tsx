// @vitest-environment happy-dom
/**
 * M7 review (UI): reload keys, no override editor for `.mrpack` packs, React keys that survive
 * duplicate index paths and download URLs (the last index entry wins in the inspector).
 */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DeclaredFile } from '../../../bindings';
import { App } from '../../app/App';
import { mockStore, until } from '../../app/__tests__/helpers';
import { shortcutOf, suppressesDefault, type KeyInput } from '../../app/keyboard';
import { MOCK_INSTANCES, MOCK_PICKED_PACK } from '../../app/mockData';
import { ModTable, rowKeys, type ModRow } from '../../components/ModTable';
import { PACK_OVERRIDE_NOTE } from '../inspector/PackPanel';

afterEach(cleanup);

let restoreLayout: (() => void) | null = null;
beforeEach(() => {
  (window as unknown as { happyDOM: { setViewport(v: { width: number; height: number }): void } }).happyDOM.setViewport({ width: 1600, height: 900 });
  window.dispatchEvent(new Event('resize'));
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

async function renderApp() {
  const m = mockStore({}, () => []);
  render(<App store={m.store} />);
  await act(async () => {
    await m.store.getState().init();
    await until(() => m.store.getState().scans[ATM.id]?.status === 'done');
  });
  return m;
}

async function openPack(m: Awaited<ReturnType<typeof renderApp>>) {
  await act(async () => {
    await m.store.getState().openMrpack();
    await until(() => m.store.getState().scans[MOCK_PICKED_PACK.id]?.status === 'done');
    await until(() => m.store.getState().modrinth[MOCK_PICKED_PACK.id]?.status === 'done');
  });
}

/** React's duplicate-key warning, if any was logged. */
function keyWarnings(spy: { mock: { calls: unknown[][] } }): string[] {
  return spy.mock.calls.map((c: unknown[]) => c.map(String).join(' ')).filter((t: string) => /same key/i.test(t));
}

const key = (k: string, target: EventTarget | null = document.body, mods: Partial<KeyInput> = {}): KeyInput => ({
  key: k,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  target,
  ...mods,
});

describe('reload keys', () => {
  it('swallows F5, Ctrl/Cmd/Shift+F5 and Ctrl/Cmd+Shift+R without rescanning', () => {
    for (const k of [
      key('F5'),
      key('F5', document.body, { ctrlKey: true }),
      key('F5', document.body, { metaKey: true }),
      key('F5', document.body, { shiftKey: true }),
      key('R', document.body, { ctrlKey: true, shiftKey: true }),
      key('R', document.body, { metaKey: true, shiftKey: true }),
    ]) {
      expect(suppressesDefault(k)).toBe(true);
      expect(shortcutOf(k)).toBeNull();
    }
    // Ctrl/Cmd+R still rescans; Alt+F5 and plain R are not reloads.
    expect(suppressesDefault(key('r', document.body, { ctrlKey: true }))).toBe(true);
    expect(shortcutOf(key('r', document.body, { metaKey: true }))).toBe('rescan');
    expect(suppressesDefault(key('F5', document.body, { altKey: true }))).toBe(false);
    expect(suppressesDefault(key('r'))).toBe(false);
    expect(suppressesDefault(key('F6'))).toBe(false);
  });

  it('swallows them while typing too, and nothing fires', () => {
    const input = document.createElement('input');
    for (const k of [key('F5', input), key('F5', input, { ctrlKey: true }), key('R', input, { ctrlKey: true, shiftKey: true }), key('r', input, { ctrlKey: true })]) {
      expect(suppressesDefault(k)).toBe(true);
      expect(shortcutOf(k)).toBeNull();
    }
  });

  it('in the app: F5 / Ctrl+Shift+R are prevented and do not rescan; Ctrl+R rescans', async () => {
    const m = await renderApp();
    const scan = vi.spyOn(m.store.getState(), 'scan');
    const press = (k: string, mods: Partial<KeyboardEventInit> = {}) => {
      const e = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...mods });
      act(() => {
        document.body.dispatchEvent(e);
      });
      return e;
    };
    expect(press('F5').defaultPrevented).toBe(true);
    expect(press('F5', { ctrlKey: true }).defaultPrevented).toBe(true);
    expect(press('R', { ctrlKey: true, shiftKey: true }).defaultPrevented).toBe(true);
    expect(scan).not.toHaveBeenCalled();
    expect(press('r', { ctrlKey: true }).defaultPrevented).toBe(true);
    expect(scan).toHaveBeenCalledTimes(1);
  });
});

describe('pack identity override', () => {
  it('a .mrpack shows the note instead of the override editor; a folder instance keeps the editor', async () => {
    const m = await renderApp();
    expect(screen.getByRole('form', { name: 'Pack identity override' })).toBeTruthy();
    expect(screen.queryByText(PACK_OVERRIDE_NOTE)).toBeNull();
    await openPack(m);
    expect(screen.queryByRole('form', { name: 'Pack identity override' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Apply and recheck' })).toBeNull();
    const note = screen.getByText(PACK_OVERRIDE_NOTE);
    expect(note.textContent).toBe("A .mrpack's identity comes from its index; overrides aren't available for packs.");
    // Back to the folder instance: the editor returns.
    act(() => m.store.getState().selectInstance(ATM.id));
    expect(screen.getByRole('form', { name: 'Pack identity override' })).toBeTruthy();
  });
});

describe('duplicate keys', () => {
  it('rowKeys suffixes repeats and leaves unique ids alone', () => {
    expect(rowKeys(['a', 'b', 'a', 'c', 'a'])).toEqual(['a', 'b', 'a#2', 'c', 'a#3']);
    expect(rowKeys([])).toEqual([]);
  });

  it('ModTable renders rows with a repeated id without React key warnings', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const row = (name: string): ModRow => ({
      id: 'mods/dup.jar',
      name,
      modId: null,
      version: null,
      loader: null,
      modrinth: { state: 'offline' },
      findings: { error: 0, warning: 0, info: 0 },
      enabled: true,
      declared: true,
      path: 'mods/dup.jar',
    });
    render(<ModTable rows={[row('First'), row('Second')]} sort={null} onSort={() => undefined} variant="pack" />);
    expect(screen.getByRole('row', { name: 'First' })).toBeTruthy();
    expect(screen.getByRole('row', { name: 'Second' })).toBeTruthy();
    expect(keyWarnings(err)).toEqual([]);
    err.mockRestore();
  });

  it('the inspector shows the LAST index entry of a repeated path, and repeated download URLs render without key warnings', async () => {
    const m = await renderApp();
    await openPack(m);
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const url = 'https://cdn.modrinth.com/data/AAAAAAAA/versions/BBBBBBBB/dup.jar';
    const entry = (size: number, downloads: string[]): DeclaredFile => ({
      path: 'mods/dup.jar',
      sha1: 'a'.repeat(40),
      sha512: 'b'.repeat(128),
      size,
      client: 'required',
      server: 'required',
      downloads,
    });
    act(() => {
      m.store.setState((s) => {
        const scan = s.scans[MOCK_PICKED_PACK.id]!;
        const result = scan.result!;
        return {
          scans: { ...s.scans, [MOCK_PICKED_PACK.id]: { ...scan, result: { ...result, declared: [...result.declared, entry(1, ['https://x.example/a.jar']), entry(2048, [url, url])] } } },
        };
      });
    });
    act(() => m.store.getState().select({ kind: 'jar', id: 'mods/dup.jar' }));
    const inspector = screen.getByRole('complementary', { name: 'Inspector' });
    expect(within(inspector).getByText('pack index entry')).toBeTruthy();
    expect(within(inspector).getAllByText(url)).toHaveLength(2);
    expect(within(inspector).queryByText('https://x.example/a.jar')).toBeNull();
    expect(keyWarnings(err)).toEqual([]);
    err.mockRestore();
    fireEvent.keyDown(document.body, { key: 'Escape' });
  });
});
