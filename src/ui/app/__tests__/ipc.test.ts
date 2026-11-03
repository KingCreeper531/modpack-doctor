import { describe, expect, it, vi } from 'vitest';

import type { ScanProgress, ScanStarted } from '../../../bindings';
import { call, createBackend, isTauri, tauriBackend } from '../ipc';
import { MOCK_INSTANCES, mockJars } from '../mockData';
import { createMockBackend, mockOptionsFromSearch } from '../mockIpc';

describe('real / mock switch', () => {
  it('detects Tauri by __TAURI_INTERNALS__', () => {
    expect(isTauri({ __TAURI_INTERNALS__: {} })).toBe(true);
    expect(isTauri({})).toBe(false);
    expect(isTauri(undefined)).toBe(false);
  });

  it('uses the generated commands inside Tauri and the mock elsewhere', () => {
    const tauriWindow = { __TAURI_INTERNALS__: {}, location: { search: '' } };
    expect(createBackend(tauriWindow).kind).toBe('tauri');
    const mock = createBackend({ location: { search: '?scenario=empty&theme=light' } });
    expect(mock.kind).toBe('mock');
    expect(Object.keys(mock.commands).sort()).toEqual(Object.keys(tauriBackend().commands).sort());
    expect(Object.keys(mock.events).sort()).toEqual(Object.keys(tauriBackend().events).sort());
  });

  it('parses ?scenario= and ?theme=, defaulting unknown values', () => {
    expect(mockOptionsFromSearch('?scenario=scanning&theme=dark')).toMatchObject({ scenario: 'scanning', theme: 'dark' });
    expect(mockOptionsFromSearch('?scenario=bogus&theme=purple')).toMatchObject({ scenario: 'default', theme: 'system' });
  });
});

describe('call()', () => {
  it('passes results through and turns a thrown Error into an internal AppError', async () => {
    expect(await call(Promise.resolve({ status: 'ok' as const, data: 1 }))).toEqual({ status: 'ok', data: 1 });
    const r = await call(() => Promise.reject(new Error('channel closed')));
    expect(r).toEqual({ status: 'error', error: { kind: 'internal', message: 'The app backend did not answer: channel closed', path: null } });
  });
});

describe('mock backend', () => {
  it('discovers several launchers, a 500-mod instance, a server and an mrpack', async () => {
    const b = createMockBackend({ latencyMs: 0, scanMs: 0 });
    const r = await b.commands.discoverInstances();
    if (r.status !== 'ok') throw new Error('expected ok');
    const launchers = new Set(r.data.instances.map((i) => i.launcher));
    expect(launchers.size).toBeGreaterThanOrEqual(5);
    expect(r.data.instances.some((i) => i.modCount >= 500)).toBe(true);
    expect(r.data.instances.some((i) => i.side === 'server')).toBe(true);
    expect(r.data.instances.some((i) => i.launcher === 'mrpack')).toBe(true);
    const empty = await createMockBackend({ scenario: 'empty', latencyMs: 0 }).commands.discoverInstances();
    expect(empty.status === 'ok' && empty.data.instances.length).toBe(0);
    expect(empty.status === 'ok' && empty.data.probes.some((p) => p.result.state === 'permissionDenied')).toBe(true);
  });

  it('emits ScanStarted (file-name order) then one ScanProgress per top-level jar', async () => {
    const b = createMockBackend({ latencyMs: 0, scanMs: 0 });
    const started: ScanStarted[] = [];
    const progress: ScanProgress[] = [];
    await b.events.scanStarted.listen((p) => started.push(p));
    await b.events.scanProgress.listen((p) => progress.push(p));
    const id = MOCK_INSTANCES[0]!.id;
    const r = await b.commands.scanInstance(id);
    expect(r.status).toBe('ok');
    expect(started).toHaveLength(1);
    const names = started[0]!.jars.map((j) => j.fileName.toLowerCase());
    expect(names).toEqual([...names].sort((a, c) => a.localeCompare(c)));
    expect(progress).toHaveLength(started[0]!.jars.length);
    expect(progress.at(-1)).toMatchObject({ done: 512, total: 512 });
    expect(new Set(progress.map((p) => p.jarId)).size).toBe(512);
    expect(progress.find((p) => p.jarId === 'mods/betterfoliage-1.20.1-5.0.2.jar')?.parsed).toBe(false);
  });

  it('spreads progress over time and can freeze mid-scan', async () => {
    vi.useFakeTimers();
    try {
      const b = createMockBackend({ scenario: 'scanning', latencyMs: 0, scanMs: 1500 });
      let n = 0;
      await b.events.scanProgress.listen(() => n++);
      let settled = false;
      void b.commands.scanInstance(MOCK_INSTANCES[0]!.id).then(() => (settled = true));
      await vi.advanceTimersByTimeAsync(400);
      expect(n).toBeGreaterThan(0);
      expect(n).toBeLessThan(512);
      await vi.advanceTimersByTimeAsync(5000);
      expect(n).toBe(Math.floor(512 * 0.55));
      expect(settled).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('round-trips settings patches, including removing an override', async () => {
    const b = createMockBackend({ latencyMs: 0 });
    const o = { mcVersion: '1.20.4', loader: null, side: 'server' as const };
    await b.commands.setSettings({ theme: 'light', overrides: { a: o }, modrinthEnabled: null, includeBeta: null, gridSort: 'severity', inspectorWidth: 400 });
    const got = await b.commands.getSettings();
    expect(got.status === 'ok' && got.data).toMatchObject({ theme: 'light', gridSort: 'severity', inspectorWidth: 400, overrides: { a: o } });
    await b.commands.setSettings({ theme: null, overrides: { a: null }, modrinthEnabled: null, includeBeta: null, gridSort: null, inspectorWidth: null });
    expect(b.settings().overrides).toEqual({});
    expect(b.settings().theme).toBe('light');
  });

  it('answers fix planning honestly: not implemented yet', async () => {
    const r = await createMockBackend({ latencyMs: 0 }).commands.planWorkOrder('x', { mcVersion: '1.20.1', loader: { kind: 'forge', version: null } }, []);
    expect(r).toEqual({ status: 'error', error: { kind: 'internal', message: 'plan_work_order is not implemented yet (M6)', path: null } });
  });
});

describe('mock jar data feeds the static checks', () => {
  const atm = mockJars(MOCK_INSTANCES[0]!.id);
  const top = atm.filter((j) => j.depth === 0);

  it('contains a wrong-loader jar, a missing dependency, a duplicate id and a split package', () => {
    expect(top.some((j) => j.loaders.includes('fabric'))).toBe(true);
    const ids = new Set(atm.flatMap((j) => j.mods.flatMap((m) => [m.modId, ...m.provides])));
    expect(atm.some((j) => j.mods.some((m) => m.deps.some((d) => d.kind === 'required' && d.modId === 'botarium')))).toBe(true);
    expect(ids.has('botarium')).toBe(false);
    expect(top.filter((j) => j.mods.some((m) => m.modId === 'jei'))).toHaveLength(2);
    const owners = top.filter((j) => j.packages.includes('me.jellysquid.mods.sodium.client'));
    expect(owners.length).toBeGreaterThanOrEqual(2);
  });

  it('contains a corrupt jar, a Java 21 class file on 1.20.1, nested jars and disabled jars', () => {
    expect(top.some((j) => j.status.state === 'corrupt')).toBe(true);
    expect(top.some((j) => j.maxClassMajor === 65)).toBe(true);
    const nested = atm.filter((j) => j.depth === 1);
    expect(nested.length).toBeGreaterThan(0);
    expect(nested.every((n) => n.id.startsWith(`${n.parentId}!/`) && n.jarjar)).toBe(true);
    const disabled = top.filter((j) => j.disabled);
    expect(disabled.length).toBeGreaterThan(0);
    expect(disabled.every((j) => j.path.endsWith('.disabled') && !j.id.endsWith('.disabled'))).toBe(true);
  });

  it('puts client-only mods on the server instance', () => {
    const server = MOCK_INSTANCES.find((i) => i.side === 'server')!;
    expect(mockJars(server.id).some((j) => j.mods.some((m) => m.environment === 'client'))).toBe(true);
  });

  it('is deterministic', () => {
    expect(mockJars(MOCK_INSTANCES[1]!.id)).toBe(mockJars(MOCK_INSTANCES[1]!.id));
    expect(top[0]!.sha1).toMatch(/^[0-9a-f]{40}$/);
    expect(top[0]!.sha512).toMatch(/^[0-9a-f]{128}$/);
  });
});
