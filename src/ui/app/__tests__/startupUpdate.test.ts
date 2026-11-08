/**
 * The opt-in startup update check (`Settings.autoCheckUpdates`, CONTRACTS invariant 18): off by
 * default, once per start after a delay, the same `check_update`, silent on failure, never during
 * a fix, never installs; the mock runs it only for the scenarios that ask.
 */
import { describe, expect, it, vi } from 'vitest';

import type { Backend } from '../ipc';
import { missingBackend, tauriBackend } from '../ipc';
import { MOCK_INSTANCES } from '../mockData';
import { createMockBackend, MOCK_UPDATE, mockOptionsFromSearch, type MockOptions } from '../mockIpc';
import { STARTUP_UPDATE_DELAY_MS, startupCheckAllowed } from '../startupUpdate';
import { DEFAULT_SETTINGS, settingsPatch, type StoreDeps } from '../store';
import { mockStore, until } from './helpers';

const ATM = MOCK_INSTANCES[0]!;
const CREATE = 'mods/create-1.20.1-0.5.1.f.jar';

/** A `setTimer` that only records; `fire()` runs the startup check's timer. */
function timers() {
  const list: Array<{ cb: () => void; ms: number }> = [];
  return {
    setTimer: (cb: () => void, ms: number) => {
      list.push({ cb, ms });
    },
    startup: () => list.filter((t) => t.ms === STARTUP_UPDATE_DELAY_MS),
    fire() {
      const due = this.startup();
      expect(due).toHaveLength(1);
      due[0]!.cb();
    },
  };
}

/** A mock store; `auto` stores `autoCheckUpdates` before start, as a previous session would. */
async function started(opts: Partial<MockOptions> = {}, auto: boolean | null = true, extra: Partial<StoreDeps> = {}) {
  const t = timers();
  const m = mockStore({ opMs: 50, ...opts }, undefined, undefined, { appVersion: '0.1.0', setTimer: t.setTimer, ...extra });
  if (auto !== null) await m.backend.commands.setSettings(settingsPatch({ autoCheckUpdates: auto }));
  const check = vi.spyOn(m.backend.commands, 'checkUpdate');
  const install = vi.spyOn(m.backend.commands, 'installUpdate');
  await m.store.getState().init();
  await until(() => m.store.getState().scans[ATM.id]?.status === 'done');
  return { ...m, t, check, install };
}

const settle = () => new Promise((r) => setTimeout(r, 10));

describe('the setting', () => {
  it('is off by default (store and every mock scenario except the auto ones)', () => {
    expect(DEFAULT_SETTINGS.autoCheckUpdates).toBe(false);
    expect(createMockBackend().settings().autoCheckUpdates).toBe(false);
    expect(createMockBackend({ scenario: 'update' }).settings().autoCheckUpdates).toBe(false);
    expect(createMockBackend({ scenario: 'autoupdate' }).settings().autoCheckUpdates).toBe(true);
    expect(createMockBackend({ scenario: 'autoupdatefail' }).settings().autoCheckUpdates).toBe(true);
    expect(mockOptionsFromSearch('?scenario=autoupdate').scenario).toBe('autoupdate');
    expect(mockOptionsFromSearch('?scenario=autoupdatefail').scenario).toBe('autoupdatefail');
  });

  it('setAutoCheckUpdates persists through set_settings, and only that field', async () => {
    const m = await started({}, null);
    const write = vi.spyOn(m.backend.commands, 'setSettings');
    expect(await m.store.getState().setAutoCheckUpdates(true)).toBeNull();
    expect(write).toHaveBeenCalledWith(settingsPatch({ autoCheckUpdates: true }));
    expect(m.backend.settings().autoCheckUpdates).toBe(true);
    expect(m.store.getState().settings.autoCheckUpdates).toBe(true);
    await m.store.getState().setAutoCheckUpdates(false);
    expect(m.backend.settings().autoCheckUpdates).toBe(false);
    expect(m.store.getState().settings.autoCheckUpdates).toBe(false);
    // Turning it on checks nothing now (it applies from the next start).
    await m.store.getState().setAutoCheckUpdates(true);
    await settle();
    expect(m.check).not.toHaveBeenCalled();
  });

  it('a refused write reverts the toggle and returns the error', async () => {
    const m = await started({}, null);
    const refusal = { kind: 'io' as const, message: 'The settings could not be saved.', path: null };
    vi.spyOn(m.backend.commands, 'setSettings').mockResolvedValueOnce({ status: 'error', error: refusal });
    const p = m.store.getState().setAutoCheckUpdates(true);
    // The intent shows at once.
    expect(m.store.getState().settings.autoCheckUpdates).toBe(true);
    expect(await p).toEqual(refusal);
    expect(m.store.getState().settings.autoCheckUpdates).toBe(false);
  });

  it('a later setSettings answer (theme, override) does not drop it', async () => {
    const m = await started({}, true);
    m.store.getState().setTheme('dark');
    await settle();
    await m.store.getState().setOverride(ATM.id, { mcVersion: '1.20.1', loader: null, side: null });
    expect(m.store.getState().settings.autoCheckUpdates).toBe(true);
  });
});

describe('where the startup check may run', () => {
  it('under Tauri; the mock only for autoupdate / autoupdatefail; never without a backend', () => {
    expect(startupCheckAllowed(tauriBackend())).toBe(true);
    expect(startupCheckAllowed(missingBackend())).toBe(false);
    for (const scenario of ['default', 'update', 'updatefail', 'crash'] as const) {
      expect(startupCheckAllowed(createMockBackend({ scenario })), scenario).toBe(false);
    }
    expect(startupCheckAllowed(createMockBackend({ scenario: 'autoupdate' }))).toBe(true);
    expect(startupCheckAllowed(createMockBackend({ scenario: 'autoupdatefail' }))).toBe(true);
    expect(startupCheckAllowed({ kind: 'mock' } as Backend)).toBe(false);
  });

  it('the mock in another scenario never checks at start, even with the setting on', async () => {
    const m = await started({ scenario: 'update' }, true);
    expect(m.t.startup()).toHaveLength(0);
    await settle();
    expect(m.check).not.toHaveBeenCalled();
    expect(m.store.getState().update).toEqual({ status: 'idle' });
  });
});

describe('startup check', () => {
  it('does not run when the setting is off', async () => {
    const m = await started({ scenario: 'update' }, false, { startupUpdateCheck: true });
    expect(m.t.startup()).toHaveLength(0);
    await settle();
    expect(m.check).not.toHaveBeenCalled();
    expect(m.store.getState().update).toEqual({ status: 'idle' });
  });

  it('runs once, after the delay, never at start itself; finds the update and installs nothing', async () => {
    const m = await started({ scenario: 'autoupdate' }, null);
    // The first screen is ready and nothing was asked yet.
    expect(m.store.getState().phase).toBe('ready');
    expect(m.check).not.toHaveBeenCalled();
    expect(m.store.getState().update).toEqual({ status: 'idle' });
    m.t.fire();
    await until(() => m.store.getState().update.status === 'available');
    expect(m.check).toHaveBeenCalledTimes(1);
    expect(m.store.getState().update).toEqual({ status: 'available', info: MOCK_UPDATE, install: 'idle', error: null });
    // init is idempotent: no second schedule.
    await m.store.getState().init();
    expect(m.t.startup()).toHaveLength(1);
    await settle();
    expect(m.check).toHaveBeenCalledTimes(1);
    expect(m.install).not.toHaveBeenCalled();
  });

  it('is silent on failure: an error only About shows, nothing else on screen changes', async () => {
    const m = await started({ scenario: 'autoupdatefail' }, null);
    const before = m.store.getState();
    m.t.fire();
    await until(() => m.store.getState().update.status === 'error');
    const after = m.store.getState();
    expect(after.update).toMatchObject({ status: 'error', error: { kind: 'network' } });
    expect(after).toMatchObject({
      aboutOpen: false,
      railError: before.railError,
      settingsError: before.settingsError,
      crashBanner: before.crashBanner,
      fixErrors: before.fixErrors,
    });
    expect(m.install).not.toHaveBeenCalled();
  });

  it('a thrown IPC failure at start is silent too', async () => {
    const m = await started({ scenario: 'autoupdate' }, null);
    m.check.mockRejectedValueOnce(new Error('bridge gone'));
    m.t.fire();
    await until(() => m.store.getState().update.status === 'error');
    expect(m.store.getState().aboutOpen).toBe(false);
  });

  it('waits while a work order executes, then checks once; the install state is never touched', async () => {
    const m = await started({ scenario: 'autoupdate' }, null);
    await m.store.getState().fix('k', { kind: 'disable', jarId: CREATE });
    const running = m.store.getState().executeOrder();
    await until(() => m.store.getState().order?.phase === 'running');
    m.t.fire();
    await settle();
    expect(m.check).not.toHaveBeenCalled();
    expect(m.store.getState().update).toEqual({ status: 'idle' });
    await running;
    await until(() => m.store.getState().update.status === 'available');
    expect(m.check).toHaveBeenCalledTimes(1);
    expect(m.store.getState().update).toMatchObject({ install: 'idle' });
    // Later order changes do not check again.
    await m.store.getState().fix('k2', { kind: 'enable', jarId: CREATE });
    await settle();
    expect(m.check).toHaveBeenCalledTimes(1);
    expect(m.install).not.toHaveBeenCalled();
  });

  it('skips when the user already checked, or turned the setting off before it ran', async () => {
    const a = await started({ scenario: 'autoupdate' }, null);
    await a.store.getState().checkUpdate();
    a.t.fire();
    await settle();
    expect(a.check).toHaveBeenCalledTimes(1);

    const b = await started({ scenario: 'autoupdate' }, null);
    await b.store.getState().setAutoCheckUpdates(false);
    b.t.fire();
    await settle();
    expect(b.check).not.toHaveBeenCalled();
    expect(b.store.getState().update).toEqual({ status: 'idle' });
  });

  it('never interrupts an install in progress', async () => {
    const m = await started({ scenario: 'autoupdate' }, null);
    m.t.fire();
    await until(() => m.store.getState().update.status === 'available');
    let release: () => void = () => undefined;
    m.install.mockImplementationOnce(() => new Promise((r) => (release = () => r({ status: 'ok', data: null }))));
    const p = m.store.getState().installUpdate('0.2.0');
    expect(m.store.getState().update).toMatchObject({ install: 'installing' });
    // A check (e.g. a second startup check) while installing is ignored.
    await m.store.getState().checkUpdate();
    expect(m.check).toHaveBeenCalledTimes(1);
    expect(m.store.getState().update).toMatchObject({ install: 'installing' });
    release();
    await p;
    expect(m.store.getState().update).toMatchObject({ install: 'restarting' });
  });
});
