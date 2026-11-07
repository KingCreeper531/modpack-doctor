/**
 * Modrinth lookup lifecycle (M5 review): no stuck "loading", Refresh restarts, settings writes are
 * serialised against lookups, icons are a second pass, and only network conditions say
 * "unreachable".
 */
import { describe, expect, it, vi } from 'vitest';

import type { AppError, HashLookup, Settings } from '../../../bindings';
import type { CheckInput, Finding } from '../../../core/model';
import type { Result } from '../ipc';
import { MOCK_INSTANCES } from '../mockData';
import { noticeText, viewContext } from '../modrinthState';
import { finding, mockStore, until } from './helpers';

const ATM = MOCK_INSTANCES[0]!;
const FO = MOCK_INSTANCES[1]!;
const AD_ASTRA = 'mods/ad_astra-forge-1.20.1-1.15.18.jar';
const OPTIFINE = 'mods/OptiFine_1.20.1_HD_U_I6.jar';

function checks(input: CheckInput): Finding[] {
  const out = [finding('missing', 'error', [AD_ASTRA], { code: 'E-MISSING-DEP', missingModIds: ['botarium'], fixes: [] })];
  if (input.modrinth) out.push(finding('notmr', 'info', [OPTIFINE], { code: 'I-NOT-ON-MODRINTH', fixes: [] }));
  return out;
}

type Store = ReturnType<typeof mockStore>;
const mr = (m: Store, id = ATM.id) => m.store.getState().modrinth[id];
const findings = (m: Store, id = ATM.id) => m.store.getState().scans[id]?.findings ?? [];
const result = (m: Store, id = ATM.id) => m.store.getState().scans[id]?.result ?? null;
const tick = () => new Promise((r) => setTimeout(r, 20));

function deferred<T>() {
  let resolve: (v: T) => void = () => undefined;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

async function enriched(m: Store, id = ATM.id) {
  await m.store.getState().init();
  await until(() => mr(m, id)?.status === 'done' && !!mr(m, id)?.resolutions.botarium, 4000);
}

describe('no lookup stays "loading"', () => {
  it('a rescan with unchanged jars during a lookup is adopted by it (the reviewer’s sequence)', async () => {
    const m = mockStore({}, checks);
    const gate = deferred<Result<HashLookup>>();
    const real = m.backend.commands.modrinthIdentify;
    const identify = vi.spyOn(m.backend.commands, 'modrinthIdentify').mockReturnValueOnce(gate.promise);
    await m.store.getState().init();
    await until(() => mr(m)?.status === 'loading');
    const first = result(m);
    // Rescan: same jars, a new ScanResult object.
    await m.store.getState().scan(ATM.id);
    expect(result(m)).not.toBe(first);
    expect(mr(m)?.status).toBe('loading');
    expect(identify).toHaveBeenCalledTimes(1);
    // Release the first identify: the run finishes for the new result.
    const [sha1s] = identify.mock.calls[0]!;
    gate.resolve(await real(sha1s, false));
    await until(() => mr(m)?.status === 'done');
    expect(viewContext(mr(m), result(m))).not.toBeNull();
    expect(findings(m).map((f) => f.id)).toContain('notmr');
    expect(identify).toHaveBeenCalledTimes(1);
  });

  it('Refresh while a lookup runs starts it over; the old answer is dropped', async () => {
    const m = mockStore({}, checks);
    const gate = deferred<Result<HashLookup>>();
    const identify = vi.spyOn(m.backend.commands, 'modrinthIdentify').mockReturnValueOnce(gate.promise);
    await m.store.getState().init();
    await until(() => mr(m)?.status === 'loading');
    await m.store.getState().refreshModrinth(ATM.id);
    expect(identify).toHaveBeenCalledTimes(2);
    expect(identify.mock.calls[1]![1]).toBe(true);
    expect(mr(m)?.status).toBe('done');
    const ctx = mr(m)!.ctx;
    gate.resolve({ status: 'error', error: { kind: 'network', message: 'Modrinth did not answer.', path: null } });
    await tick();
    expect(mr(m)?.status).toBe('done');
    expect(mr(m)?.ctx).toBe(ctx);
    expect(mr(m)?.notice).toBeNull();
  });

  it('every exit is terminal: identify errors of each kind end in "error", never "loading"', async () => {
    for (const kind of ['network', 'offline', 'internal', 'invalid'] as const) {
      const m = mockStore({}, checks);
      vi.spyOn(m.backend.commands, 'modrinthIdentify').mockResolvedValue({ status: 'error', error: { kind, message: 'x', path: null } });
      await m.store.getState().init();
      await until(() => mr(m)?.status === 'error');
      expect(mr(m)?.notice).toEqual(kind === 'network' || kind === 'offline' ? { kind: 'offline' } : { kind: 'failed' });
    }
  });
});

describe('Modrinth settings writes and lookups', () => {
  /** Records Rust's `modrinthEnabled` at the moment of every identify call. */
  function watchIdentify(m: Store) {
    const seen: boolean[] = [];
    const real = m.backend.commands.modrinthIdentify;
    const spy = vi.spyOn(m.backend.commands, 'modrinthIdentify').mockImplementation((sha1s, refresh) => {
      seen.push(m.backend.settings().modrinthEnabled);
      return real(sha1s, refresh);
    });
    return { seen, spy };
  }

  /** Holds the next `set_settings` until released. */
  function gateNextWrite(m: Store) {
    const gate = deferred<void>();
    const real = m.backend.commands.setSettings;
    const spy = vi.spyOn(m.backend.commands, 'setSettings').mockImplementationOnce(async (patch) => {
      await gate.promise;
      return real(patch);
    });
    return { release: () => gate.resolve(), spy };
  }

  it('fast on → off → on: writes are serialised, the lookup runs only once Rust is on, and finishes online', async () => {
    const m = mockStore({ scenario: 'modrinthoff' }, checks);
    await m.store.getState().init();
    await until(() => mr(m)?.status === 'off');
    const { seen } = watchIdentify(m);
    const w = gateNextWrite(m);
    const clicks = [true, false, true].map((on) => m.store.getState().setModrinthEnabled(on));
    await tick();
    // Each write waits for the one before it.
    expect(w.spy).toHaveBeenCalledTimes(1);
    expect(m.store.getState().settings.modrinthEnabled).toBe(true);
    expect(seen).toEqual([]);
    w.release();
    await Promise.all(clicks);
    await until(() => mr(m)?.status === 'done' && !!mr(m)?.resolutions.botarium);
    expect(w.spy.mock.calls.map((c) => c[0].modrinthEnabled)).toEqual([true, false, true]);
    expect(m.backend.settings().modrinthEnabled).toBe(true);
    expect(m.store.getState().settings.modrinthEnabled).toBe(true);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every(Boolean)).toBe(true);
    expect(mr(m)?.notice).toBeNull();
    expect(mr(m)?.ctx?.offline).toBe(false);
  });

  it('fast off → on from a clean context: Rust ends on and the context stays (no offline answer)', async () => {
    const m = mockStore({}, checks);
    await enriched(m);
    const { seen } = watchIdentify(m);
    const w = gateNextWrite(m);
    const off = m.store.getState().setModrinthEnabled(false);
    const on = m.store.getState().setModrinthEnabled(true);
    w.release();
    await Promise.all([off, on]);
    await tick();
    expect(m.backend.settings().modrinthEnabled).toBe(true);
    expect(mr(m)?.status).toBe('done');
    expect(mr(m)?.notice).toBeNull();
    expect(seen.every(Boolean)).toBe(true);
  });

  it('a lookup started before turning off is not joined by the "turn on" lookup', async () => {
    const m = mockStore({}, checks);
    await enriched(m);
    const gate = deferred<Result<HashLookup>>();
    const real = m.backend.commands.modrinthIdentify;
    const identify = vi.spyOn(m.backend.commands, 'modrinthIdentify').mockReturnValueOnce(gate.promise);
    const refresh = m.store.getState().refreshModrinth(ATM.id);
    await until(() => identify.mock.calls.length === 1);
    const w = gateNextWrite(m);
    const off = m.store.getState().setModrinthEnabled(false);
    const on = m.store.getState().setModrinthEnabled(true);
    w.release();
    await Promise.all([off, on]);
    // The "on" lookup is a new run, sent while Rust is on.
    await until(() => identify.mock.calls.length === 2);
    // The old run's answer came from Rust while it was off: cache-only, nothing found.
    const [sha1s] = identify.mock.calls[0]!;
    gate.resolve({ status: 'ok', data: { found: {}, failed: [...sha1s], offline: true } });
    await refresh;
    await until(() => mr(m)?.status === 'done' && !!mr(m)?.resolutions.botarium);
    expect(mr(m)?.notice).toBeNull();
    expect(mr(m)?.ctx?.offline).toBe(false);
    expect(identify).toHaveBeenCalledTimes(2);
    void real;
  });

  it('turning on while a scan finishes: the lookup waits for Rust to be on', async () => {
    const m = mockStore({ scenario: 'modrinthoff' }, checks);
    await m.store.getState().init();
    await until(() => mr(m)?.status === 'off');
    const { seen } = watchIdentify(m);
    const w = gateNextWrite(m);
    const on = m.store.getState().setModrinthEnabled(true);
    // A rescan finishes while the write is pending: its lookup must not run yet.
    await m.store.getState().scan(ATM.id);
    await tick();
    expect(seen).toEqual([]);
    w.release();
    await on;
    await until(() => mr(m)?.status === 'done');
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every(Boolean)).toBe(true);
    expect(mr(m)?.notice).toBeNull();
  });

  it('a failed latest write reverts to what Rust confirmed and leaves a terminal state', async () => {
    const m = mockStore({}, checks);
    await enriched(m);
    const error: AppError = { kind: 'io', message: 'The settings file could not be written.', path: null };
    vi.spyOn(m.backend.commands, 'setSettings').mockResolvedValueOnce({ status: 'error', error });
    await m.store.getState().setModrinthEnabled(false);
    expect(m.store.getState().settings.modrinthEnabled).toBe(true);
    expect(m.store.getState().settingsError).toEqual(error);
    await until(() => mr(m)?.status === 'done');
  });

  it('an override write never clobbers a pending Modrinth intent', async () => {
    const m = mockStore({}, checks);
    await enriched(m);
    const w = gateNextWrite(m);
    const off = m.store.getState().setModrinthEnabled(false);
    await tick();
    expect(w.spy).toHaveBeenCalledTimes(1);
    // Unrelated settings answer (Rust still says on) arrives first.
    const before: Settings = m.backend.settings();
    vi.spyOn(m.backend.commands, 'setSettings').mockResolvedValueOnce({ status: 'ok', data: { ...before, modrinthEnabled: true } });
    await m.store.getState().setOverride(ATM.id, { mcVersion: '1.20.1', loader: null, side: null });
    expect(m.store.getState().settings.modrinthEnabled).toBe(false);
    w.release();
    await off;
    expect(mr(m)?.status).toBe('off');
  });
});

describe('icons: a second pass', () => {
  it('results and fixes never wait for icons; icons merge in later without re-running the checks', async () => {
    const m = mockStore({}, checks);
    const gate = deferred<Result<Record<string, string>>>();
    const real = m.backend.commands.modrinthIcons;
    const icons = vi.spyOn(m.backend.commands, 'modrinthIcons').mockReturnValueOnce(gate.promise);
    await enriched(m);
    expect(icons).toHaveBeenCalledTimes(1);
    expect(mr(m)?.icons).toEqual({});
    expect(findings(m).map((f) => f.id)).toContain('notmr');
    const runs = m.calls.length;
    const ids = icons.mock.calls[0]![0];
    expect(ids.length).toBeGreaterThan(0);
    gate.resolve(await real(ids));
    await until(() => Object.keys(mr(m)?.icons ?? {}).length > 0);
    expect(m.calls.length).toBe(runs);
    // Rust (and the mock) now has them cached: the next lookup's projects carry them.
    await m.store.getState().refreshModrinth(ATM.id);
    expect(Object.values(mr(m)!.ctx!.projects).some((p) => p.iconPath !== null)).toBe(true);
  });

  it('no icon request when Modrinth is unreachable or off', async () => {
    const offline = mockStore({ scenario: 'offline' }, checks);
    const a = vi.spyOn(offline.backend.commands, 'modrinthIcons');
    await offline.store.getState().init();
    await until(() => mr(offline)?.status === 'done');
    await tick();
    expect(a).not.toHaveBeenCalled();

    const off = mockStore({ scenario: 'modrinthoff' }, checks);
    const b = vi.spyOn(off.backend.commands, 'modrinthIcons');
    await off.store.getState().init();
    await until(() => mr(off)?.status === 'off');
    await tick();
    expect(b).not.toHaveBeenCalled();
  });

  it('a stale icon answer is dropped (Modrinth switched off meanwhile)', async () => {
    const m = mockStore({}, checks);
    const gate = deferred<Result<Record<string, string>>>();
    vi.spyOn(m.backend.commands, 'modrinthIcons').mockReturnValueOnce(gate.promise);
    await enriched(m);
    await m.store.getState().setModrinthEnabled(false);
    gate.resolve({ status: 'ok', data: { abc: 'data:image/svg+xml,x' } });
    await tick();
    expect(mr(m)?.status).toBe('off');
    expect(mr(m)?.icons).toEqual({});
  });
});

describe('error classification and the per-instance cache', () => {
  it('a partial batch failure is the quiet notice; every batch failing is "unreachable"', async () => {
    const some = mockStore({}, checks);
    const real = some.backend.commands.modrinthIdentify;
    vi.spyOn(some.backend.commands, 'modrinthIdentify').mockImplementation(async (sha1s, refresh) => {
      const r = await real(sha1s, refresh);
      if (r.status !== 'ok') return r;
      const lost = sha1s.slice(0, 3);
      const found = Object.fromEntries(Object.entries(r.data.found).filter(([h]) => !lost.includes(h)));
      return { status: 'ok', data: { found, failed: lost, offline: false } };
    });
    await some.store.getState().init();
    await until(() => mr(some)?.status === 'done');
    expect(mr(some)?.notice).toEqual({ kind: 'partial' });
    expect(noticeText(mr(some)!.notice, 0)).toBe('Modrinth: some lookups failed');

    const all = mockStore({}, checks);
    vi.spyOn(all.backend.commands, 'modrinthIdentify').mockImplementation(async (sha1s) => ({ status: 'ok', data: { found: {}, failed: [...sha1s], offline: false } }));
    await all.store.getState().init();
    await until(() => mr(all)?.status === 'done');
    expect(mr(all)?.notice).toEqual({ kind: 'offline' });
  });

  it('invalid/internal from a dependency lookup skips that dependency, no global notice', async () => {
    const m = mockStore({}, checks);
    const error: AppError = { kind: 'invalid', message: 'Modrinth rejected the search query.', path: null };
    vi.spyOn(m.backend.commands, 'modrinthResolveModId').mockResolvedValue({ status: 'error', error });
    await m.store.getState().init();
    await until(() => !!mr(m)?.unresolved.botarium);
    expect(mr(m)?.notice).toBeNull();
    expect(mr(m)?.unresolved.botarium).toEqual(error);
    expect(mr(m)?.resolutions.botarium).toBeUndefined();
  });

  it('a network error from a dependency lookup is the quiet notice, not "unreachable"', async () => {
    const m = mockStore({}, checks);
    vi.spyOn(m.backend.commands, 'modrinthProjectVersions').mockResolvedValue({ status: 'error', error: { kind: 'network', message: 'x', path: null } });
    await m.store.getState().init();
    await until(() => mr(m)?.notice?.kind === 'partial');
    expect(mr(m)?.unresolved).toEqual({});
  });

  it('a notice never defeats the cache: switching instances does not look up again; a rescan and Refresh do', async () => {
    const m = mockStore({ scenario: 'offline' }, checks);
    await m.store.getState().init();
    await until(() => mr(m)?.status === 'done');
    expect(mr(m)?.notice).toEqual({ kind: 'offline' });
    const identify = vi.spyOn(m.backend.commands, 'modrinthIdentify');
    m.store.getState().selectInstance(FO.id);
    await until(() => mr(m, FO.id)?.status === 'done');
    identify.mockClear();
    m.store.getState().selectInstance(ATM.id);
    m.store.getState().selectInstance(FO.id);
    m.store.getState().selectInstance(ATM.id);
    await tick();
    expect(identify).not.toHaveBeenCalled();
    await m.store.getState().scan(ATM.id);
    await until(() => identify.mock.calls.length === 1);
    await until(() => mr(m)?.status === 'done');
    await m.store.getState().refreshModrinth(ATM.id);
    expect(identify).toHaveBeenCalledTimes(2);
  });

  it('an identify error is cached for instance switches too', async () => {
    const m = mockStore({}, checks);
    const identify = vi.spyOn(m.backend.commands, 'modrinthIdentify').mockResolvedValue({ status: 'error', error: { kind: 'internal', message: 'x', path: null } });
    await m.store.getState().init();
    await until(() => mr(m)?.status === 'error');
    expect(noticeText(mr(m)!.notice, 0)).toBe('Modrinth lookup failed — static checks only');
    m.store.getState().selectInstance(FO.id);
    await until(() => mr(m, FO.id)?.status === 'error');
    identify.mockClear();
    m.store.getState().selectInstance(ATM.id);
    await tick();
    expect(identify).not.toHaveBeenCalled();
  });
});
