import { describe, expect, it, vi } from 'vitest';

import type { ScanProgress, ScanStarted } from '../../../bindings';
import { projectIdsOf } from '../../../core/modrinth';
import { call, createBackend, isTauri, NO_BACKEND, tauriBackend } from '../ipc';
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

  it('never falls back to the mock when mocks are not allowed (production): every command fails inline', async () => {
    const b = createBackend({ location: { search: '?scenario=default' } }, false);
    expect(b.kind).toBe('none');
    expect(await b.commands.discoverInstances()).toEqual({ status: 'error', error: NO_BACKEND });
    expect(await b.commands.getSettings()).toEqual({ status: 'error', error: NO_BACKEND });
    const off = await b.events.scanProgress.listen(() => undefined);
    expect(typeof off).toBe('function');
    expect(NO_BACKEND.message).toMatch(/not running/);
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

  it('answers later-milestone commands exactly like Rust: a neutral unavailable error', async () => {
    const b = createMockBackend({ latencyMs: 0 });
    const pack = MOCK_INSTANCES.find((i) => i.launcher === 'mrpack')!;
    expect(await b.commands.scanInstance(pack.id)).toMatchObject({ error: { kind: 'unavailable', message: "Scanning .mrpack files isn't available in this version of Modpack Doctor yet." } });
    expect(await b.commands.saveReport('r', 'markdown', '')).toMatchObject({ error: { kind: 'unavailable' } });
  });

  it('answers the fix commands (M6) with readable refusals for bad input', async () => {
    const b = createMockBackend({ latencyMs: 0 });
    const r = await b.commands.planWorkOrder('x', { mcVersion: '1.20.1', loader: { kind: 'forge', version: null } }, []);
    expect(r).toMatchObject({ status: 'error', error: { kind: 'notFound' } });
    expect(await b.commands.planWorkOrder(MOCK_INSTANCES[0]!.id, { mcVersion: '1.20.1', loader: { kind: 'forge', version: null } }, [])).toMatchObject({
      error: { kind: 'invalid', message: 'No fix was given, so there is nothing to plan.' },
    });
    expect(await b.commands.listBackups('x')).toMatchObject({ error: { kind: 'notFound' } });
    expect(await b.commands.planUndo('not-a-backup', null)).toMatchObject({ error: { kind: 'invalid' } });
    expect(await b.commands.executeWorkOrder('9999')).toMatchObject({ error: { kind: 'notFound', message: 'This work order expired — review the fixes again.' } });
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

describe('mock Modrinth (M5)', () => {
  const ATM = MOCK_INSTANCES[0]!;
  const top = () => mockJars(ATM.id).filter((j) => j.depth === 0);
  const sha = (file: string) => top().find((j) => j.fileName === file)!.sha1;
  const FO = MOCK_INSTANCES[1]!;

  it('identifies most jars, leaves a few off Modrinth, and serves only inline icons', async () => {
    const b = createMockBackend({ latencyMs: 0 });
    const sha1s = top().map((j) => j.sha1);
    const r = await b.commands.modrinthIdentify(sha1s, false);
    if (r.status !== 'ok') throw new Error('identify failed');
    const found = Object.keys(r.data.found).length;
    expect(found).toBeGreaterThan(sha1s.length * 0.8);
    expect(found).toBeLessThan(sha1s.length);
    expect(r.data.found[sha('OptiFine_1.20.1_HD_U_I6.jar')]).toBeUndefined();
    expect(r.data.found[sha('Mekanism-1.20.1-10.4.5.20.jar')]).toBeUndefined();
    const p = await b.commands.modrinthProjects(projectIdsOf(r.data), false);
    if (p.status !== 'ok') throw new Error('projects failed');
    const projects = Object.values(p.data.found);
    expect(projects.some((x) => x.iconPath === null && x.slug === 'ftb-library-forge')).toBe(true);
    for (const x of projects) if (x.iconPath) expect(x.iconPath).toMatch(/^data:image\/svg\+xml,/);
    for (const v of Object.values(r.data.found)) for (const f of v.files) expect(f.url.startsWith('https://cdn.modrinth.com/')).toBe(true);
  });

  it('offers release updates, a beta-only update through the fallback, and a resolvable dependency', async () => {
    const b = createMockBackend({ latencyMs: 0 });
    const create = sha('create-1.20.1-0.5.1.f.jar');
    const u = await b.commands.modrinthFindUpdates([create], ['forge'], ['1.20.1'], ['release'], false);
    expect(u.status === 'ok' && u.data.found[create]?.versionNumber).toBe('0.5.1.j');
    const ec = mockJars(FO.id).find((j) => j.fileName.startsWith('entityculling'))!.sha1;
    const rel = await b.commands.modrinthFindUpdates([ec], ['fabric'], ['1.21.1'], ['release'], false);
    expect(rel.status === 'ok' && rel.data.found[ec]).toBeFalsy();
    const beta = await b.commands.modrinthFindUpdates([ec], ['fabric'], ['1.21.1'], ['release', 'beta'], false);
    expect(beta.status === 'ok' && beta.data.found[ec]).toMatchObject({ versionNumber: '1.7.1-beta.2', versionType: 'beta' });
    const p = await b.commands.modrinthResolveModId('botarium', ['forge'], ['1.20.1']);
    if (p.status !== 'ok' || !p.data) throw new Error('botarium not resolved');
    const v = await b.commands.modrinthProjectVersions(p.data.id, ['forge'], ['1.20.1'], ['release', 'beta']);
    expect(v.status === 'ok' && v.data[0]).toMatchObject({ versionNumber: '2.3.4', versionType: 'release' });
    expect(await b.commands.modrinthResolveModId('nothing_like_this', ['forge'], ['1.20.1'])).toEqual({ status: 'ok', data: null });
  });

  it('scenario offline answers every lookup offline; ratelimit fails the first identify only', async () => {
    const off = createMockBackend({ latencyMs: 0, scenario: 'offline' });
    expect(await off.commands.modrinthIdentify(['ab'], false)).toEqual({ status: 'ok', data: { found: {}, failed: ['ab'], offline: true } });
    const rl = createMockBackend({ latencyMs: 0, scenario: 'ratelimit' });
    expect(await rl.commands.modrinthIdentify([sha('create-1.20.1-0.5.1.f.jar')], false)).toMatchObject({ status: 'error', error: { kind: 'rateLimited', retryAfterS: 5 } });
    expect((await rl.commands.modrinthIdentify([sha('create-1.20.1-0.5.1.f.jar')], false)).status).toBe('ok');
    const disabled = createMockBackend({ latencyMs: 0, scenario: 'modrinthoff' });
    expect(disabled.settings().modrinthEnabled).toBe(false);
    expect(await disabled.commands.modrinthIdentify(['ab'], false)).toMatchObject({ status: 'ok', data: { offline: true } });
  });
});
