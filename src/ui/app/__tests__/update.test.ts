/** M8: user-initiated update check and install (CONTRACTS invariant 18), the mocks, palette entries. */
import { describe, expect, it, vi } from 'vitest';

import { MOCK_INSTANCES } from '../mockData';
import { createMockBackend, MOCK_UPDATE, mockOptionsFromSearch, type MockOptions } from '../mockIpc';
import { paletteGroups, runPaletteCommand, type PaletteActions } from '../paletteCommands';
import { UPDATE_ORDER_RUNNING } from '../store';
import { mockStore, until } from './helpers';

const ATM = MOCK_INSTANCES[0]!;
const CREATE = 'mods/create-1.20.1-0.5.1.f.jar';

async function ready(opts: Partial<MockOptions> = {}) {
  const m = mockStore(opts, undefined, undefined, { appVersion: '0.1.0' });
  await m.store.getState().init();
  await until(() => m.store.getState().scans[ATM.id]?.status === 'done');
  return m;
}

describe('update mocks', () => {
  it('reads the scenario from the URL', () => {
    expect(mockOptionsFromSearch('?scenario=update').scenario).toBe('update');
    expect(mockOptionsFromSearch('?scenario=updatefail').scenario).toBe('updatefail');
  });

  it('default: up to date; update: 0.2.0; updatefail: a readable network error', async () => {
    expect(await createMockBackend({ latencyMs: 0 }).commands.checkUpdate()).toEqual({ status: 'ok', data: null });
    expect(await createMockBackend({ latencyMs: 0, scenario: 'update' }).commands.checkUpdate()).toEqual({ status: 'ok', data: MOCK_UPDATE });
    expect(MOCK_UPDATE.version).toBe('0.2.0');
    const fail = await createMockBackend({ latencyMs: 0, scenario: 'updatefail' }).commands.checkUpdate();
    expect(fail).toMatchObject({ status: 'error', error: { kind: 'network', message: expect.stringMatching(/github\.com.*try again\.$/) } });
  });

  it('install is refused with conflict while a work order executes', async () => {
    const m = await ready({ scenario: 'update', opMs: 50 });
    await m.store.getState().fix('k', { kind: 'disable', jarId: CREATE });
    const running = m.store.getState().executeOrder();
    await until(() => m.store.getState().order?.phase === 'running');
    expect(await m.backend.commands.installUpdate()).toMatchObject({ status: 'error', error: { kind: 'conflict' } });
    await running;
    expect(await m.backend.commands.installUpdate()).toEqual({ status: 'ok', data: null });
  });
});

describe('update check', () => {
  it('never runs by itself: not at start, not when About opens', async () => {
    const m = mockStore({ scenario: 'update' });
    const check = vi.spyOn(m.backend.commands, 'checkUpdate');
    const install = vi.spyOn(m.backend.commands, 'installUpdate');
    await m.store.getState().init();
    await until(() => m.store.getState().scans[ATM.id]?.status === 'done');
    m.store.getState().setAboutOpen(true);
    await new Promise((r) => setTimeout(r, 20));
    expect(check).not.toHaveBeenCalled();
    expect(install).not.toHaveBeenCalled();
    expect(m.store.getState().update).toEqual({ status: 'idle' });
  });

  it('checking → up to date (with the running version)', async () => {
    const m = await ready();
    const p = m.store.getState().checkUpdate();
    expect(m.store.getState().update).toEqual({ status: 'checking' });
    await p;
    expect(m.store.getState().update).toEqual({ status: 'current', version: '0.1.0' });
  });

  it('checking → update available, nothing installed', async () => {
    const m = await ready({ scenario: 'update' });
    const install = vi.spyOn(m.backend.commands, 'installUpdate');
    await m.store.getState().checkUpdate();
    expect(m.store.getState().update).toEqual({ status: 'available', info: MOCK_UPDATE, install: 'idle', error: null });
    expect(install).not.toHaveBeenCalled();
  });

  it('a failed check is an inline error; a thrown IPC failure too', async () => {
    const m = await ready({ scenario: 'updatefail' });
    await m.store.getState().checkUpdate();
    expect(m.store.getState().update).toMatchObject({ status: 'error', error: { kind: 'network' } });
    vi.spyOn(m.backend.commands, 'checkUpdate').mockRejectedValueOnce(new Error('bridge gone'));
    await m.store.getState().checkUpdate();
    expect(m.store.getState().update).toMatchObject({ status: 'error', error: { kind: 'internal', message: expect.stringContaining('bridge gone') } });
  });

  it('a second click while checking does not start another check', async () => {
    const m = await ready();
    const check = vi.spyOn(m.backend.commands, 'checkUpdate');
    const p = m.store.getState().checkUpdate();
    await m.store.getState().checkUpdate();
    await p;
    expect(check).toHaveBeenCalledTimes(1);
  });
});

describe('update install', () => {
  it('installs only the version on screen, once', async () => {
    const m = await ready({ scenario: 'update' });
    const install = vi.spyOn(m.backend.commands, 'installUpdate');
    // Nothing on screen yet.
    await m.store.getState().installUpdate('0.2.0');
    expect(install).not.toHaveBeenCalled();
    await m.store.getState().checkUpdate();
    // A different version than the one shown.
    await m.store.getState().installUpdate('0.3.0');
    expect(install).not.toHaveBeenCalled();
    const p = m.store.getState().installUpdate('0.2.0');
    expect(m.store.getState().update).toMatchObject({ status: 'available', install: 'installing' });
    // A double click is ignored.
    await m.store.getState().installUpdate('0.2.0');
    await p;
    expect(install).toHaveBeenCalledTimes(1);
    expect(m.store.getState().update).toMatchObject({ status: 'available', install: 'restarting', error: null });
    // No new check replaces an install in progress.
    const check = vi.spyOn(m.backend.commands, 'checkUpdate');
    await m.store.getState().checkUpdate();
    expect(check).not.toHaveBeenCalled();
  });

  it('refused inline while a work order runs (the store does not even ask Rust)', async () => {
    const m = await ready({ scenario: 'update', opMs: 50 });
    await m.store.getState().checkUpdate();
    await m.store.getState().fix('k', { kind: 'disable', jarId: CREATE });
    const running = m.store.getState().executeOrder();
    await until(() => m.store.getState().order?.phase === 'running');
    const install = vi.spyOn(m.backend.commands, 'installUpdate');
    await m.store.getState().installUpdate('0.2.0');
    expect(install).not.toHaveBeenCalled();
    expect(m.store.getState().update).toMatchObject({ status: 'available', install: 'idle', error: UPDATE_ORDER_RUNNING });
    await running;
    // After the order finished, the same button works and the error clears.
    await m.store.getState().installUpdate('0.2.0');
    expect(install).toHaveBeenCalledTimes(1);
    expect(m.store.getState().update).toMatchObject({ install: 'restarting', error: null });
  });

  it("Rust's refusal (conflict, signature) stays inline and Install can be pressed again", async () => {
    const m = await ready({ scenario: 'update' });
    await m.store.getState().checkUpdate();
    vi.spyOn(m.backend.commands, 'installUpdate').mockResolvedValueOnce({
      status: 'error',
      error: { kind: 'conflict', message: 'A work order is running. Wait for it to finish, then install the update.', path: null },
    });
    await m.store.getState().installUpdate('0.2.0');
    expect(m.store.getState().update).toMatchObject({ status: 'available', install: 'idle', error: { kind: 'conflict' } });
    await m.store.getState().installUpdate('0.2.0');
    expect(m.store.getState().update).toMatchObject({ install: 'restarting', error: null });
  });
});

describe('palette entries', () => {
  it('lists Check for updates and About, with or without an instance', async () => {
    const m = await ready();
    const ids = (s: Parameters<typeof paletteGroups>[0]) => paletteGroups(s).find((g) => g.heading === 'Actions')!.items.map((i) => i.id);
    expect(ids(m.store.getState())).toEqual(expect.arrayContaining(['check-updates', 'about']));
    expect(ids({ ...m.store.getState(), selectedInstanceId: null, discovery: null })).toEqual(expect.arrayContaining(['check-updates', 'about']));
    const about = paletteGroups(m.store.getState()).find((g) => g.heading === 'Actions')!.items.find((i) => i.id === 'about');
    expect(about?.label).toBe('About Modpack Doctor');
  });

  it('About opens the dialog; Check for updates opens it and checks; neither installs', () => {
    const a = {
      setAboutOpen: vi.fn(),
      checkUpdate: vi.fn(async () => undefined),
    } as unknown as PaletteActions;
    const s = { selectedInstanceId: null, settings: { watched: [] } } as unknown as Parameters<typeof runPaletteCommand>[1];
    runPaletteCommand('about', s, a);
    expect(a.setAboutOpen).toHaveBeenCalledWith(true);
    expect(a.checkUpdate).not.toHaveBeenCalled();
    runPaletteCommand('check-updates', s, a);
    expect(a.setAboutOpen).toHaveBeenCalledTimes(2);
    expect(a.checkUpdate).toHaveBeenCalledTimes(1);
  });

  it('setAboutOpen closes the palette and any menu', async () => {
    const m = await ready();
    m.store.getState().setPaletteOpen(true);
    m.store.getState().setAboutOpen(true);
    expect(m.store.getState()).toMatchObject({ aboutOpen: true, paletteOpen: false, menu: null });
    m.store.getState().setAboutOpen(false);
    expect(m.store.getState().aboutOpen).toBe(false);
  });
});
