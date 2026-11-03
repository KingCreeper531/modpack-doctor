import { describe, expect, it, vi } from 'vitest';

import type { AppError, ScanProgress, ScanResult, ScanStarted, Settings } from '../../../bindings';
import { deriveTiles, instanceStatus } from '../derive';
import type { AppCommands, Backend, EventChannel, Result } from '../ipc';
import { createMockBackend } from '../mockIpc';
import { MOCK_INSTANCES } from '../mockData';
import { emptyScan } from '../scanState';
import { createAppStore, DEFAULT_SETTINGS, settingsPatch } from '../store';
import { fakeCore, finding, manualFrames, mockStore, until } from './helpers';

const ATM = MOCK_INSTANCES[0]!;
const JEI_A = 'mods/jei-1.20.1-forge-15.2.0.27.jar';
const JEI_B = 'mods/jei-1.20.1-forge-15.3.0.4.jar';
const CORRUPT = 'mods/betterfoliage-1.20.1-5.0.2.jar';
const CREATE = 'mods/create-1.20.1-0.5.1.f.jar';

describe('init and scan lifecycle', () => {
  it('loads settings and discovery, selects the first instance and scans it', async () => {
    const { store, calls } = mockStore({ theme: 'light' }, () => [finding('dup', 'error', [JEI_A, JEI_B])]);
    await store.getState().init();
    const st = store.getState();
    expect(st.phase).toBe('ready');
    expect(st.settings.theme).toBe('light');
    expect(st.discovery?.instances.length).toBe(MOCK_INSTANCES.length);
    expect(st.selectedInstanceId).toBe(ATM.id);
    await until(() => store.getState().scans[ATM.id]?.status === 'done');
    const sc = store.getState().scans[ATM.id]!;
    expect(sc.result?.jars.filter((j) => j.depth === 0)).toHaveLength(512);
    expect(sc.stubs).toHaveLength(512);
    expect(sc.done).toBe(512);
    expect(sc.findings.map((f) => f.id)).toEqual(['dup']);
    expect(sc.pack).toMatchObject({ mcVersion: '1.20.1', source: 'launcher' });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.instance.id).toBe(ATM.id);
    expect(instanceStatus(sc)).toBe('error');
  });

  it('init is idempotent (StrictMode double effects)', async () => {
    const { store, backend } = mockStore();
    const spy = vi.spyOn(backend.commands, 'discoverInstances');
    await Promise.all([store.getState().init(), store.getState().init()]);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('records a failed scan as an inline error and an error pip', async () => {
    const { store } = mockStore({ scenario: 'errors' });
    await store.getState().init();
    await until(() => store.getState().scans[ATM.id]?.status === 'error');
    const sc = store.getState().scans[ATM.id]!;
    expect(sc.error?.kind).toBe('permission');
    expect(sc.error?.path).toContain('mods');
    expect(instanceStatus(sc)).toBe('error');
  });

  it('turns a thrown check into checksError instead of crashing', async () => {
    const { store } = mockStore({}, () => {
      throw new Error('boom');
    });
    await store.getState().init();
    await until(() => store.getState().scans[ATM.id]?.status === 'done');
    const sc = store.getState().scans[ATM.id]!;
    expect(sc.findings).toEqual([]);
    expect(sc.checksError?.message).toContain('boom');
  });

  it('keeps a selection that still exists after a rescan and drops one that does not', async () => {
    const { store } = mockStore({}, () => [finding('dup', 'error', [JEI_A, JEI_B])]);
    await store.getState().init();
    await until(() => store.getState().scans[ATM.id]?.status === 'done');
    store.getState().select({ kind: 'jar', id: CREATE });
    await store.getState().scan(ATM.id);
    expect(store.getState().selection).toEqual({ kind: 'jar', id: CREATE });
    store.getState().select({ kind: 'finding', id: 'gone' });
    await store.getState().scan(ATM.id);
    expect(store.getState().selection).toBeNull();
  });

  it('honours initialSelect once the scan that contains it finishes', async () => {
    const { store } = mockStore({}, () => [finding('dup', 'error', [JEI_A, JEI_B])], 'dup');
    await store.getState().init();
    await until(() => store.getState().scans[ATM.id]?.status === 'done');
    expect(store.getState().selection).toEqual({ kind: 'finding', id: 'dup' });
    expect(store.getState().expandFindingId).toBe('dup');
  });
});

/** A backend whose scan the test drives event by event. */
function drivenBackend() {
  const base = createMockBackend({ latencyMs: 0, scanMs: 0 });
  const subs: { started?: (p: ScanStarted) => void; progress?: (p: ScanProgress) => void } = {};
  let resolveScan: (r: Result<ScanResult>) => void = () => undefined;
  const ch = <T,>(set: (cb: (p: T) => void) => void): EventChannel<T> => ({
    listen: async (cb) => {
      set(cb);
      return () => undefined;
    },
  });
  const commands: AppCommands = {
    ...base.commands,
    scanInstance: () => new Promise<Result<ScanResult>>((r) => (resolveScan = r)),
  };
  const backend: Backend = {
    kind: 'mock',
    commands,
    events: {
      ...base.events,
      scanStarted: ch<ScanStarted>((cb) => (subs.started = cb)),
      scanProgress: ch<ScanProgress>((cb) => (subs.progress = cb)),
    },
  };
  return { backend, subs, resolve: (r: Result<ScanResult>) => resolveScan(r) };
}

describe('progress batching', () => {
  it('applies a burst of ScanProgress in one store update per frame', async () => {
    const { backend, subs, resolve } = drivenBackend();
    const frames = manualFrames();
    const { core } = fakeCore(() => [finding('w', 'warning', ['mods/b.jar'])]);
    const store = createAppStore({ backend, core, frame: frames.frame });
    await store.getState().init();
    await until(() => store.getState().scans[ATM.id]?.status === 'scanning');

    const jars = ['mods/a.jar', 'mods/b.jar', 'mods/c.jar'];
    subs.started!({ instanceId: ATM.id, jars: jars.map((id) => ({ id, path: id, fileName: id.slice(5), disabled: id === 'mods/c.jar' })) });
    expect(store.getState().scans[ATM.id]!.total).toBe(3);

    const listener = vi.fn();
    const off = store.subscribe(listener);
    subs.progress!({ instanceId: ATM.id, done: 1, total: 3, jarId: 'mods/b.jar', parsed: true });
    subs.progress!({ instanceId: ATM.id, done: 2, total: 3, jarId: 'mods/a.jar', parsed: false });
    expect(listener).not.toHaveBeenCalled();
    expect(frames.pending).toBe(1);

    frames.run();
    expect(listener).toHaveBeenCalledTimes(1);
    const mid = store.getState().scans[ATM.id]!;
    expect(mid.done).toBe(2);
    expect(mid.progress).toEqual({ 'mods/b.jar': true, 'mods/a.jar': false });
    // During the scan: file-name order, unscanned until progress, unparsed = error.
    expect(deriveTiles(mid, 'severity').map((t) => [t.id, t.state])).toEqual([
      ['mods/a.jar', 'error'],
      ['mods/b.jar', 'ok'],
      ['mods/c.jar', 'unscanned'],
    ]);

    subs.progress!({ instanceId: ATM.id, done: 3, total: 3, jarId: 'mods/c.jar', parsed: true });
    off();
    // The result arrives before the frame: pending progress is flushed first, never lost.
    resolve({ status: 'ok', data: { instanceId: ATM.id, startedAtMs: 0, durationMs: 5, jars: [], declared: [], issues: [] } });
    await until(() => store.getState().scans[ATM.id]?.status === 'done');
    const end = store.getState().scans[ATM.id]!;
    expect(end.progress['mods/c.jar']).toBe(true);
    expect(end.findings.map((f) => f.id)).toEqual(['w']);
    frames.run();
  });

  it('ignores progress for an instance that is not scanning', async () => {
    const { backend, subs } = drivenBackend();
    const frames = manualFrames();
    const store = createAppStore({ backend, core: fakeCore().core, frame: frames.frame });
    await store.getState().init();
    subs.progress!({ instanceId: 'nope', done: 1, total: 1, jarId: 'x', parsed: true });
    frames.run();
    expect(store.getState().scans.nope).toBeUndefined();
  });
});

describe('tile status derivation', () => {
  const stubs = ['mods/a.jar', 'mods/b.jar', 'mods/c.jar', 'mods/d.jar', 'mods/e.jar'].map((id) => ({
    id,
    path: id,
    fileName: id.slice(5),
    disabled: id === 'mods/e.jar',
  }));
  const progress = { 'mods/a.jar': true, 'mods/b.jar': true, 'mods/c.jar': false, 'mods/d.jar': true, 'mods/e.jar': true };

  it('takes the worst finding severity, maps nested culprits to the parent, and counts', () => {
    const scan = {
      ...emptyScan(),
      status: 'done' as const,
      stubs,
      progress,
      findings: [
        finding('1', 'warning', ['mods/a.jar']),
        finding('2', 'error', ['mods/a.jar', 'mods/b.jar!/META-INF/jarjar/x.jar']),
        finding('3', 'warning', ['mods/c.jar']),
        finding('4', 'info', ['mods/d.jar']),
        finding('5', 'warning', ['mods/a.jar']),
      ],
    };
    const tiles = deriveTiles(scan, 'name');
    expect(tiles.map((t) => [t.id, t.state, t.count])).toEqual([
      ['mods/a.jar', 'error', 1],
      ['mods/b.jar', 'error', 1],
      ['mods/c.jar', 'warning', 1],
      ['mods/d.jar', 'ok', 0],
      ['mods/e.jar', 'disabled', 0],
    ]);
  });

  it('sorts by severity (error, warning, info, ok, disabled) after the scan, by name otherwise', () => {
    const scan = {
      ...emptyScan(),
      status: 'done' as const,
      stubs,
      progress: { ...progress, 'mods/c.jar': true },
      findings: [finding('1', 'warning', ['mods/b.jar']), finding('2', 'error', ['mods/d.jar']), finding('3', 'info', ['mods/c.jar'])],
    };
    expect(deriveTiles(scan, 'severity').map((t) => t.id)).toEqual(['mods/d.jar', 'mods/b.jar', 'mods/c.jar', 'mods/a.jar', 'mods/e.jar']);
    expect(deriveTiles(scan, 'name').map((t) => t.id)).toEqual(stubs.map((s) => s.id));
    expect(deriveTiles({ ...scan, status: 'scanning' }, 'severity').map((t) => t.id)).toEqual(stubs.map((s) => s.id));
  });

  it('keeps an unparsed jar red when no finding cites it', () => {
    const scan = { ...emptyScan(), status: 'done' as const, stubs, progress, findings: [] };
    expect(deriveTiles(scan, 'name').find((t) => t.id === 'mods/c.jar')?.state).toBe('error');
  });

  it('labels tiles with the mod id and version once the result is in', async () => {
    const { store } = mockStore();
    await store.getState().init();
    await until(() => store.getState().scans[ATM.id]?.status === 'done');
    const tiles = deriveTiles(store.getState().scans[ATM.id]!, 'name');
    expect(tiles.find((t) => t.id === CREATE)).toMatchObject({ label: 'create', version: '0.5.1.f', state: 'ok' });
    expect(tiles.find((t) => t.id === CORRUPT)?.state).toBe('error');
  });
});

describe('settings round-trips', () => {
  it('persists the grid sort, theme and inspector width through set_settings patches', async () => {
    const { store, backend } = mockStore();
    await store.getState().init();
    const spy = vi.spyOn(backend.commands, 'setSettings');
    store.getState().setGridSort('severity');
    expect(store.getState().settings.gridSort).toBe('severity');
    expect(spy).toHaveBeenLastCalledWith(settingsPatch({ gridSort: 'severity' }));
    store.getState().setTheme('dark');
    expect(spy).toHaveBeenLastCalledWith(settingsPatch({ theme: 'dark' }));
    store.getState().setInspectorWidth(9999);
    expect(store.getState().inspectorWidth).toBe(640);
    expect(spy).toHaveBeenCalledTimes(2);
    store.getState().commitInspectorWidth(300);
    expect(spy).toHaveBeenLastCalledWith(settingsPatch({ inspectorWidth: 300 }));
    await until(() => backend.settings().inspectorWidth === 300);
    expect(backend.settings()).toMatchObject({ gridSort: 'severity', theme: 'dark' });
  });

  it('an override is stored, then the checks re-run against it; clearing it re-runs again', async () => {
    const { store, backend, calls } = mockStore();
    await store.getState().init();
    await until(() => store.getState().scans[ATM.id]?.status === 'done');
    expect(calls).toHaveLength(1);
    const o = { mcVersion: '1.20.4', loader: { kind: 'neoforge' as const, version: '20.4.1' }, side: null };
    await store.getState().setOverride(ATM.id, o);
    expect(backend.settings().overrides[ATM.id]).toEqual(o);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.pack).toMatchObject({ mcVersion: '1.20.4', loader: { kind: 'neoforge' }, source: 'override' });
    expect(store.getState().scans[ATM.id]!.pack?.source).toBe('override');
    await store.getState().setOverride(ATM.id, null);
    expect(backend.settings().overrides[ATM.id]).toBeUndefined();
    expect(calls[2]!.pack.source).toBe('launcher');
  });

  it('shows a settings failure on the override editor and leaves the checks alone', async () => {
    const { store, backend, calls } = mockStore();
    await store.getState().init();
    await until(() => store.getState().scans[ATM.id]?.status === 'done');
    const err: AppError = { kind: 'io', message: 'Settings could not be saved.', path: null };
    vi.spyOn(backend.commands, 'setSettings').mockResolvedValue({ status: 'error', error: err });
    await store.getState().setOverride(ATM.id, { mcVersion: '1.20.4', loader: null, side: null });
    expect(store.getState().overrideError).toEqual(err);
    expect(calls).toHaveLength(1);
  });

  it('falls back to defaults and reports when get_settings fails', async () => {
    const { store, backend } = mockStore();
    vi.spyOn(backend.commands, 'getSettings').mockRejectedValue(new Error('ipc down'));
    await store.getState().init();
    expect(store.getState().settings).toEqual(DEFAULT_SETTINGS satisfies Settings);
    expect(store.getState().settingsError).toMatchObject({ kind: 'internal' });
    expect(store.getState().settingsError?.message).toContain('ipc down');
  });
});

describe('fixes', () => {
  it('routes a fix through plan_work_order with the pack identity and shows the refusal inline', async () => {
    const { store, backend } = mockStore({}, () => [finding('dup', 'error', [JEI_A, JEI_B])]);
    await store.getState().init();
    await until(() => store.getState().scans[ATM.id]?.status === 'done');
    const spy = vi.spyOn(backend.commands, 'planWorkOrder');
    await store.getState().fix('dup', { kind: 'disable', jarId: JEI_A });
    expect(spy).toHaveBeenCalledWith(ATM.id, { mcVersion: '1.20.1', loader: { kind: 'forge', version: '47.3.0' } }, [{ kind: 'disable', jarId: JEI_A }]);
    expect(store.getState().fixErrors.dup?.message).toBe('plan_work_order is not implemented yet (M6)');
    expect(store.getState().fixPending.dup).toBeUndefined();
    store.getState().dismissFixError('dup');
    expect(store.getState().fixErrors.dup).toBeUndefined();
  });

  it('the enable toggle plans enable/disable the same way', async () => {
    const { store, backend } = mockStore();
    await store.getState().init();
    await until(() => store.getState().scans[ATM.id]?.status === 'done');
    const spy = vi.spyOn(backend.commands, 'planWorkOrder');
    await store.getState().setJarEnabled(CREATE, false);
    expect(spy.mock.calls[0]![2]).toEqual([{ kind: 'disable', jarId: CREATE }]);
    expect(store.getState().fixErrors[`jar:${CREATE}`]?.kind).toBe('internal');
  });

  it('refuses locally when the pack identity is unknown, and skips manual advice', async () => {
    const { store, backend } = mockStore();
    await store.getState().init();
    const spy = vi.spyOn(backend.commands, 'planWorkOrder');
    const vanilla = MOCK_INSTANCES.find((i) => i.launcher === 'vanilla')!;
    store.getState().selectInstance(vanilla.id);
    await until(() => store.getState().scans[vanilla.id]?.status === 'done');
    await store.getState().fix('f', { kind: 'disable', jarId: 'mods/x.jar' });
    expect(spy).not.toHaveBeenCalled();
    expect(store.getState().fixErrors.f?.kind).toBe('invalid');
    await store.getState().fix('m', { kind: 'manual', steps: ['x'] });
    expect(store.getState().fixErrors.m).toBeUndefined();
  });

  it('opens a planned order and discards it on cancel', async () => {
    const { store, backend } = mockStore();
    await store.getState().init();
    await until(() => store.getState().scans[ATM.id]?.status === 'done');
    const order = { id: 'o1', instanceId: ATM.id, kind: 'fix' as const, title: 't', actions: [], ops: [], notes: [], backupDir: 'b' };
    vi.spyOn(backend.commands, 'planWorkOrder').mockResolvedValue({ status: 'ok', data: order });
    const discard = vi.spyOn(backend.commands, 'discardWorkOrder');
    await store.getState().fix('k', { kind: 'disable', jarId: CREATE });
    expect(store.getState().order?.order.id).toBe('o1');
    await store.getState().cancelOrder();
    expect(store.getState().order).toBeNull();
    expect(discard).toHaveBeenCalledWith('o1');
  });
});

describe('rail actions', () => {
  it('adds a picked folder, selects it and scans it', async () => {
    const { store } = mockStore();
    await store.getState().init();
    await store.getState().addFolder();
    const added = store.getState().discovery!.instances.at(-1)!;
    expect(added.launcher).toBe('manual');
    expect(store.getState().selectedInstanceId).toBe(added.id);
    await until(() => store.getState().scans[added.id]?.status === 'done');
  });

  it('replaces the discovery report after picking a launcher root, and reports failures inline', async () => {
    const { store, backend } = mockStore();
    await store.getState().init();
    await store.getState().addLauncherRoot('prism');
    expect(store.getState().discovery!.probes.some((p) => p.path.includes('Portable'))).toBe(true);
    vi.spyOn(backend.commands, 'pickLauncherRoot').mockResolvedValue({ status: 'error', error: { kind: 'permission', message: 'No access.', path: null } });
    await store.getState().addLauncherRoot('multimc');
    expect(store.getState().railError?.message).toBe('No access.');
    store.getState().clearRailError();
    expect(store.getState().railError).toBeNull();
  });

  it('adds instances from InstanceAdded and reports DropRejected', async () => {
    const backend = createMockBackend({ latencyMs: 0, scanMs: 0 });
    const store = createAppStore({ backend, core: fakeCore().core, frame: manualFrames().frame });
    await store.getState().init();
    const inst = { ...MOCK_INSTANCES[1]!, id: 'ffffffffffffffff', name: 'Dropped' };
    (backend.events.instanceAdded as unknown as { emit(p: unknown): void }).emit({ instance: inst });
    expect(store.getState().selectedInstanceId).toBe(inst.id);
    (backend.events.dropRejected as unknown as { emit(p: unknown): void }).emit({ name: 'x.zip', reason: 'not a folder or .mrpack' });
    expect(store.getState().railError?.message).toBe('x.zip was not added: not a folder or .mrpack');
  });
});
