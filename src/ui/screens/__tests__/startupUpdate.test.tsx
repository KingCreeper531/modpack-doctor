// @vitest-environment happy-dom
/**
 * The opt-in startup update check on screen: the "Check for updates at startup" toggle in About
 * (persisted with set_settings), the quiet rail-footer notice that opens About, silence on
 * failure, and nothing installed without a click.
 */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { App } from '../../app/App';
import { finding, mockStore, until } from '../../app/__tests__/helpers';
import { MOCK_INSTANCES } from '../../app/mockData';
import type { MockOptions } from '../../app/mockIpc';
import { STARTUP_UPDATE_DELAY_MS } from '../../app/startupUpdate';
import { settingsPatch } from '../../app/store';
import { version as appVersion } from '../../../../package.json';

afterEach(cleanup);

function setViewport(width: number) {
  (window as unknown as { happyDOM: { setViewport(v: { width: number; height: number }): void } }).happyDOM.setViewport({ width, height: 900 });
  window.dispatchEvent(new Event('resize'));
}
beforeEach(() => setViewport(1600));

const ATM = MOCK_INSTANCES[0]!;

async function renderApp(opts: Partial<MockOptions> = {}, auto: boolean | null = null) {
  const startup: Array<() => void> = [];
  const setTimer = (cb: () => void, ms: number) => {
    if (ms === STARTUP_UPDATE_DELAY_MS) startup.push(cb);
  };
  const m = mockStore(opts, () => [finding('dis', 'error', ['mods/create-1.20.1-0.5.1.f.jar'])], undefined, { appVersion: '0.1.0', setTimer });
  if (auto !== null) await m.backend.commands.setSettings(settingsPatch({ autoCheckUpdates: auto }));
  const check = vi.spyOn(m.backend.commands, 'checkUpdate');
  const install = vi.spyOn(m.backend.commands, 'installUpdate');
  render(<App store={m.store} />);
  await act(async () => {
    await m.store.getState().init();
    await until(() => m.store.getState().scans[ATM.id]?.status === 'done');
  });
  const fire = async (status: string) => {
    expect(startup).toHaveLength(1);
    await act(async () => {
      startup[0]!();
      await until(() => m.store.getState().update.status === status);
    });
  };
  return { ...m, check, install, fire, startup };
}

async function click(el: Element) {
  await act(async () => {
    fireEvent.click(el);
  });
}

const dialog = () => screen.queryByRole('dialog', { name: 'Modpack Doctor' });
const aboutButton = () => screen.getByRole('button', { name: 'About' });
const toggle = (on: boolean) => within(dialog()!).getByRole('button', { name: `Check for updates at startup ${on ? 'enabled' : 'disabled'}` });

describe('Check for updates at startup (About)', () => {
  it('is a labelled toggle in the Updates section, off by default; turning it on persists via set_settings', async () => {
    const m = await renderApp();
    await click(aboutButton());
    const updates = within(dialog()!).getByRole('region', { name: 'Updates' });
    expect(within(updates).getByText('Check for updates at startup')).toBeTruthy();
    expect(within(updates).getByText('GitHub Releases · only when you ask')).toBeTruthy();
    expect(within(updates).getByText('Contacts github.com only when you click.')).toBeTruthy();
    const off = toggle(false);
    expect(off.getAttribute('aria-pressed')).toBe('false');
    expect(off.textContent).toContain('off');
    const write = vi.spyOn(m.backend.commands, 'setSettings');
    await click(off);
    expect(write).toHaveBeenCalledWith(settingsPatch({ autoCheckUpdates: true }));
    expect(m.backend.settings().autoCheckUpdates).toBe(true);
    const on = toggle(true);
    expect(on.getAttribute('aria-pressed')).toBe('true');
    expect(within(updates).getByText('GitHub Releases · at start and when you ask')).toBeTruthy();
    expect(within(updates).getByText('Contacts github.com when you click, and once at start.')).toBeTruthy();
    // It applies from the next start: nothing is checked now.
    expect(m.check).not.toHaveBeenCalled();
    await click(on);
    expect(m.backend.settings().autoCheckUpdates).toBe(false);
  });

  it('a refused write shows inline under the toggle and the toggle goes back', async () => {
    const m = await renderApp();
    vi.spyOn(m.backend.commands, 'setSettings').mockResolvedValueOnce({
      status: 'error',
      error: { kind: 'io', message: 'The settings could not be saved.', path: null },
    });
    await click(aboutButton());
    await click(toggle(false));
    expect(within(dialog()!).getByRole('alert').textContent).toContain('The settings could not be saved.');
    expect(toggle(false)).toBeTruthy();
  });
});

describe('startup notice (rail footer)', () => {
  it('nothing at start without the setting: the footer shows the version and no check runs', async () => {
    const m = await renderApp({ scenario: 'update' });
    expect(m.startup).toHaveLength(0);
    expect(within(aboutButton().parentElement!).getByText(appVersion)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Update .* available$/ })).toBeNull();
    expect(m.check).not.toHaveBeenCalled();
  });

  it('a newer version: a quiet "Update 0.2.0 available" beside About that opens About; nothing installs', async () => {
    const m = await renderApp({ scenario: 'autoupdate' });
    // Before the delay: the version, no check.
    expect(within(aboutButton().parentElement!).getByText(appVersion)).toBeTruthy();
    expect(m.check).not.toHaveBeenCalled();
    await m.fire('available');
    const notice = screen.getByRole('button', { name: 'Update 0.2.0 available' });
    expect(notice.className).toContain('text-signal');
    expect(notice.getAttribute('aria-haspopup')).toBe('dialog');
    // Non-modal: no dialog opened by itself, no toast or alert.
    expect(dialog()).toBeNull();
    expect(screen.queryAllByRole('alert')).toHaveLength(0);
    await click(notice);
    const d = dialog()!;
    expect(within(d).getByText('Available').closest('tr')!.textContent).toContain('0.2.0');
    expect(within(d).getByRole('button', { name: 'Install 0.2.0 and restart' })).toBeTruthy();
    expect(toggle(true)).toBeTruthy();
    expect(m.install).not.toHaveBeenCalled();
    expect(m.check).toHaveBeenCalledTimes(1);
    // Only the click on Install installs.
    await click(within(d).getByRole('button', { name: 'Install 0.2.0 and restart' }));
    expect(m.install).toHaveBeenCalledTimes(1);
  });

  it('a failed check stays silent at start; About shows the error when opened', async () => {
    const m = await renderApp({ scenario: 'autoupdatefail' });
    await m.fire('error');
    expect(screen.queryAllByRole('alert')).toHaveLength(0);
    expect(document.body.textContent).not.toContain('check for updates');
    expect(within(aboutButton().parentElement!).getByText(appVersion)).toBeTruthy();
    expect(dialog()).toBeNull();
    await click(aboutButton());
    expect(within(dialog()!).getByRole('alert').textContent).toMatch(/github\.com.*try again\./);
    expect(within(dialog()!).getByRole('button', { name: 'Check again' })).toBeTruthy();
    expect(m.install).not.toHaveBeenCalled();
  });

  it('up to date: the footer keeps the version', async () => {
    const m = await renderApp({ scenario: 'autoupdate' });
    m.check.mockResolvedValueOnce({ status: 'ok', data: null });
    await m.fire('current');
    expect(within(aboutButton().parentElement!).getByText(appVersion)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Update .* available$/ })).toBeNull();
  });
});
