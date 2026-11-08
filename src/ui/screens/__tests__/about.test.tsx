// @vitest-environment happy-dom
/** M8 screens: the About dialog (DESIGN §6.8) and the user-initiated update flow (invariant 18). */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { App } from '../../app/App';
import { finding, mockStore, until } from '../../app/__tests__/helpers';
import { MOCK_INSTANCES } from '../../app/mockData';
import type { MockOptions } from '../../app/mockIpc';
import { DISCLAIMER, releaseDate } from '../../components/AboutPlate';
import { aboutInfo, isRepoUrl, loadAppInfo } from '../AboutDialog';
import { version as appVersion } from '../../../../package.json';

afterEach(cleanup);

function setViewport(width: number) {
  (window as unknown as { happyDOM: { setViewport(v: { width: number; height: number }): void } }).happyDOM.setViewport({ width, height: 900 });
  window.dispatchEvent(new Event('resize'));
}
beforeEach(() => setViewport(1600));

const ATM = MOCK_INSTANCES[0]!;
const XSS = '<img src=x onerror="window.__pwned=1">';

async function renderApp(opts: Partial<MockOptions> = {}) {
  const m = mockStore(opts, () => [finding('dis', 'error', ['mods/create-1.20.1-0.5.1.f.jar'])], undefined, { appVersion: '0.1.0' });
  render(<App store={m.store} />);
  await act(async () => {
    await m.store.getState().init();
    await until(() => m.store.getState().scans[ATM.id]?.status === 'done');
  });
  return m;
}

function press(key: string, mods: Partial<KeyboardEventInit> = {}, target: Element = document.activeElement ?? document.body) {
  const e = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...mods });
  act(() => {
    target.dispatchEvent(e);
  });
  return e;
}

const dialog = () => screen.queryByRole('dialog', { name: 'Modpack Doctor' });
const aboutButton = () => screen.getByRole('button', { name: 'About' });

async function click(el: Element) {
  await act(async () => {
    fireEvent.click(el);
  });
}

describe('About dialog', () => {
  it('opens from the rail footer with name, version, description, link and disclaimer; no images', async () => {
    await renderApp();
    expect(dialog()).toBeNull();
    // The footer shows the version next to the entry point.
    expect(within(aboutButton().parentElement!).getByText(appVersion)).toBeTruthy();
    await click(aboutButton());
    const d = dialog()!;
    expect(d.getAttribute('aria-modal')).toBe('true');
    expect(within(d).getByText('About')).toBeTruthy();
    expect(within(d).getByText('Version').closest('tr')!.textContent).toContain(appVersion);
    expect(within(d).getByText(/^Finds why a Minecraft modpack crashes/)).toBeTruthy();
    expect(within(d).getByText('Licence').closest('tr')!.textContent).toContain('GPL-3.0-only');
    expect(within(d).getByRole('button', { name: /github\.com\/KingCreeper531\/modpack-doctor/ })).toBeTruthy();
    expect(d.textContent).toContain(DISCLAIMER);
    expect(d.textContent).toContain('not affiliated with or endorsed by Modrinth, Mojang, Microsoft, Forge, NeoForge, Fabric, or Quilt.');
    expect(d.textContent).toContain('Mod data from the Modrinth API.');
    // No logos of anyone.
    expect(d.querySelector('img')).toBeNull();
  });

  it('takes focus, traps Tab, closes on Esc and returns focus to the About button', async () => {
    const m = await renderApp();
    const trigger = aboutButton();
    trigger.focus();
    await click(trigger);
    const d = dialog()!;
    expect(document.activeElement).toBe(d);
    const buttons = within(d).getAllByRole('button');
    const first = buttons[0]!;
    const last = buttons[buttons.length - 1]!;
    // Tab from the last control wraps to the first, Shift+Tab from the first to the last.
    last.focus();
    expect(press('Tab', {}, last).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(first);
    expect(press('Tab', { shiftKey: true }, first).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(last);
    // Window shortcuts do not act underneath (J would move the findings cursor).
    press('j', {}, last);
    expect(m.store.getState().cursor).toBeNull();
    press('Escape', {}, last);
    expect(dialog()).toBeNull();
    expect(m.store.getState().aboutOpen).toBe(false);
    expect(document.activeElement).toBe(trigger);
    // With About closed the same key reaches the shortcuts again.
    press('j', {}, document.body);
    expect(m.store.getState().cursor).toBe('dis');
  });

  it('the Close button and the click-away layer close it too', async () => {
    await renderApp();
    await click(aboutButton());
    await click(within(dialog()!).getByRole('button', { name: 'Close' }));
    expect(dialog()).toBeNull();
    await click(aboutButton());
    const layer = document.querySelector<HTMLElement>('.fixed.inset-0.z-40')!;
    await act(async () => {
      fireEvent.mouseDown(layer);
    });
    expect(dialog()).toBeNull();
  });

  it('opens from the palette ("About Modpack Doctor") and focus returns to where it was', async () => {
    await renderApp();
    const rescan = screen.getByRole('button', { name: 'Rescan' });
    rescan.focus();
    press('k', { ctrlKey: true });
    await click(screen.getByRole('option', { name: /^About Modpack Doctor/ }));
    expect(screen.queryByPlaceholderText('instance, mod id, or action…')).toBeNull();
    const d = dialog()!;
    expect(document.activeElement).toBe(d);
    press('Escape', {}, d);
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(rescan);
  });

  it('shows the Tauri version, data folder and cache folder from app_info, mono and truncated with a title', async () => {
    await renderApp();
    await click(aboutButton());
    const d = dialog()!;
    await act(async () => {
      await until(() => !!within(d).queryByText('Cache directory'));
    });
    const value = (label: string) => within(d).getByText(label).closest('tr')!.querySelector('td')!;
    const expected: Array<[string, string]> = [
      ['Tauri version', '2.12.5'],
      ['Data directory', String.raw`C:\Users\alex\AppData\Roaming\io.github.kingcreeper531.modpackdoctor`],
      ['Cache directory', String.raw`C:\Users\alex\AppData\Local\io.github.kingcreeper531.modpackdoctor`],
    ];
    for (const [label, text] of expected) {
      const td = value(label);
      expect(td.textContent).toBe(text);
      expect(td.getAttribute('title')).toBe(text);
      expect(td.className).toContain('t-mono');
      expect(td.className).toContain('truncate');
    }
    // Plate order (DESIGN §6.8): version, commit, Tauri, data, cache, licence.
    const labels = Array.from(d.querySelectorAll('th[scope="row"]'), (th) => th.textContent);
    expect(labels.slice(0, 6)).toEqual(['Version', 'Build commit', 'Tauri version', 'Data directory', 'Cache directory', 'Licence']);
  });

  it('app_info: asked under Tauri, skipped without a backend, rows left off when it fails', async () => {
    const info = { tauriVersion: '2.12.5', dataDir: '/home/a/.local/share/x', cacheDir: '/home/a/.cache/x' };
    const ok = vi.fn(async () => ({ status: 'ok' as const, data: info }));
    expect(await loadAppInfo('tauri', { appInfo: ok })).toEqual(info);
    expect(ok).toHaveBeenCalledTimes(1);

    const unused = vi.fn(async () => ({ status: 'ok' as const, data: info }));
    expect(await loadAppInfo('none', { appInfo: unused })).toBeNull();
    expect(unused).not.toHaveBeenCalled();

    const failed = vi.fn(async () => ({ status: 'error' as const, error: { kind: 'internal' as const, message: 'x', path: null } }));
    expect(await loadAppInfo('tauri', { appInfo: failed })).toBeNull();
    const thrown = vi.fn(async () => {
      throw new Error('bridge gone');
    });
    expect(await loadAppInfo('tauri', { appInfo: thrown })).toBeNull();

    // The browser mock answers with fixed values.
    expect((await loadAppInfo('mock'))?.tauriVersion).toBe('2.12.5');

    // Unknown or blank values never reach the plate.
    expect(aboutInfo({ DEV: false }, null)).toMatchObject({ tauri: null, dataDir: null, cacheDir: null });
    expect(aboutInfo({ DEV: false }, { tauriVersion: ' ', dataDir: '', cacheDir: '/c' })).toMatchObject({ tauri: null, dataDir: null, cacheDir: '/c' });
    expect(aboutInfo({ DEV: false }, info)).toMatchObject({ tauri: '2.12.5', dataDir: info.dataDir, cacheDir: info.cacheDir });
  });

  it('build info: a CI commit when given, nothing guessed otherwise', () => {
    expect(aboutInfo({ DEV: false, VITE_BUILD_COMMIT: 'abc1234' }).commit).toBe('abc1234');
    expect(aboutInfo({ DEV: false }).commit).toBeNull();
    expect(aboutInfo({ DEV: true }).commit).toBe('development build');
    expect(aboutInfo({ DEV: false }).licence).toBe('GPL-3.0-only');
    expect(isRepoUrl('https://github.com/KingCreeper531/modpack-doctor')).toBe(true);
    expect(isRepoUrl('https://github.com/KingCreeper531/modpack-doctor/releases')).toBe(true);
    expect(isRepoUrl('https://github.com/KingCreeper531/modpack-doctor-evil')).toBe(false);
    expect(isRepoUrl('https://example.com/')).toBe(false);
    expect(releaseDate('2026-11-20T09:00:00Z')).toBe('2026-11-20');
    expect(releaseDate('next week')).toBe('next week');
    expect(releaseDate(null)).toBeNull();
  });
});

describe('updates in About', () => {
  it('nothing is checked until the button is pressed; then checking…, then up to date', async () => {
    const m = await renderApp();
    const check = vi.spyOn(m.backend.commands, 'checkUpdate');
    await click(aboutButton());
    expect(check).not.toHaveBeenCalled();
    const d = dialog()!;
    expect(within(d).getByText('Contacts github.com only when you click.')).toBeTruthy();
    let resolve!: () => void;
    const gate = new Promise<void>((r) => (resolve = r));
    check.mockImplementationOnce(async () => {
      await gate;
      return { status: 'ok', data: null };
    });
    await click(within(d).getByRole('button', { name: 'Check for updates' }));
    const busy = within(d).getByRole('button', { name: 'Checking…' }) as HTMLButtonElement;
    expect(busy.disabled).toBe(true);
    expect(within(d).getByRole('status').textContent).toMatch(/github\.com/);
    await act(async () => {
      resolve();
      await until(() => m.store.getState().update.status === 'current');
    });
    expect(within(d).getByText('0.1.0 is the latest release.')).toBeTruthy();
    expect(within(d).getByRole('button', { name: 'Check again' })).toBeTruthy();
    expect(check).toHaveBeenCalledTimes(1);
  });

  it('update available: version, date, notes as plain text (markup is never rendered)', async () => {
    const m = await renderApp({ scenario: 'update' });
    vi.spyOn(m.backend.commands, 'checkUpdate').mockResolvedValueOnce({
      status: 'ok',
      data: { version: '0.2.0', date: '2026-11-20T09:00:00Z', notes: `Fixes.\n${XSS}\n**not bold**` },
    });
    await click(aboutButton());
    const d = dialog()!;
    await act(async () => {
      fireEvent.click(within(d).getByRole('button', { name: 'Check for updates' }));
      await until(() => m.store.getState().update.status === 'available');
    });
    expect(within(d).getByText('Available').closest('tr')!.textContent).toContain('0.2.0');
    expect(within(d).getByText('Published').closest('tr')!.textContent).toContain('2026-11-20');
    const notes = within(d).getByTestId('update-notes');
    expect(notes.textContent).toBe(`Fixes.\n${XSS}\n**not bold**`);
    expect(notes.querySelector('img')).toBeNull();
    expect(notes.querySelector('strong,b')).toBeNull();
    expect(notes.children).toHaveLength(0);
    expect(d.querySelector('img')).toBeNull();
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
  });

  it('install runs only after the click, for the version shown', async () => {
    const m = await renderApp({ scenario: 'update' });
    const install = vi.spyOn(m.backend.commands, 'installUpdate');
    await click(aboutButton());
    const d = dialog()!;
    await act(async () => {
      fireEvent.click(within(d).getByRole('button', { name: 'Check for updates' }));
      await until(() => m.store.getState().update.status === 'available');
    });
    expect(install).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(within(d).getByRole('button', { name: 'Install 0.2.0 and restart' }));
      await until(() => m.store.getState().update.status === 'available' && (m.store.getState().update as { install: string }).install === 'restarting');
    });
    expect(install).toHaveBeenCalledTimes(1);
    const restarting = within(d).getByRole('button', { name: 'Restarting…' }) as HTMLButtonElement;
    expect(restarting.disabled).toBe(true);
    expect(within(d).getByText('Installed. Modpack Doctor restarts now.')).toBeTruthy();
  });

  it('a conflict (work order running) is shown inline and Install stays available', async () => {
    const m = await renderApp({ scenario: 'update' });
    vi.spyOn(m.backend.commands, 'installUpdate').mockResolvedValueOnce({
      status: 'error',
      error: { kind: 'conflict', message: 'A work order is running. Wait for it to finish, then install the update.', path: null },
    });
    await click(aboutButton());
    const d = dialog()!;
    await act(async () => {
      fireEvent.click(within(d).getByRole('button', { name: 'Check for updates' }));
      await until(() => m.store.getState().update.status === 'available');
    });
    await click(within(d).getByRole('button', { name: 'Install 0.2.0 and restart' }));
    await act(async () => {
      await until(() => !!(m.store.getState().update as { error?: unknown }).error);
    });
    const alert = within(d).getByRole('alert');
    expect(alert.textContent).toContain('conflict');
    expect(alert.textContent).toContain('A work order is running.');
    expect((within(d).getByRole('button', { name: 'Install 0.2.0 and restart' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('a failed check is an inline, readable error with Check again', async () => {
    const m = await renderApp({ scenario: 'updatefail' });
    await click(aboutButton());
    const d = dialog()!;
    await act(async () => {
      fireEvent.click(within(d).getByRole('button', { name: 'Check for updates' }));
      await until(() => m.store.getState().update.status === 'error');
    });
    const alert = within(d).getByRole('alert');
    expect(alert.textContent).toContain('network');
    expect(alert.textContent).toContain("Couldn't reach github.com");
    expect(within(d).getByText('Nothing was downloaded.')).toBeTruthy();
    expect(within(d).getByRole('button', { name: 'Check again' })).toBeTruthy();
  });

  it('palette "Check for updates" opens About and checks once', async () => {
    const m = await renderApp({ scenario: 'update' });
    const check = vi.spyOn(m.backend.commands, 'checkUpdate');
    press('k', { ctrlKey: true }, document.body);
    await act(async () => {
      fireEvent.click(screen.getByRole('option', { name: /^Check for updates/ }));
      await until(() => m.store.getState().update.status === 'available');
    });
    expect(check).toHaveBeenCalledTimes(1);
    expect(within(dialog()!).getByRole('button', { name: 'Install 0.2.0 and restart' })).toBeTruthy();
  });
});
