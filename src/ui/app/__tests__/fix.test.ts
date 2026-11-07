/**
 * M6 store flow over the mock fix engine (mockFix.ts): plan → panel → execute with live OpStatus
 * events → result → rescan and history; refusals, expiry, the game guard, rollback, undo and the
 * mod-table toggle.
 */
import { describe, expect, it, vi } from 'vitest';

import type { FixAction, OpStatus } from '../../../bindings';
import { fixBlockReason } from '../derive';
import { MOCK_INSTANCES } from '../mockData';
import { EXPIRED_MESSAGE } from '../mockFix';
import { mockFindUpdates, mockProjectVersions, mockResolveModId } from '../mockModrinth';
import type { MockOptions } from '../mockIpc';
import { undoKey } from '../store';
import { enterExecutes, orderOutcome } from '../../components/workOrderModel';
import { mockStore, until } from './helpers';

const ATM = MOCK_INSTANCES[0]!;
const FO = MOCK_INSTANCES[1]!;
const CREATE = 'mods/create-1.20.1-0.5.1.f.jar';
const LITHO = 'mods/lithostitched-forge-1.20.4-1.1.5.jar';
const CURIOS_NEW = 'mods/curios-forge-5.9.1+1.20.1.jar';
const CURIOS_OLD = 'mods/curios-forge-5.7.0+1.20.1.jar';

async function ready(opts: Partial<MockOptions> = {}, id = ATM.id) {
  const m = mockStore(opts);
  await m.store.getState().init();
  if (id !== ATM.id) m.store.getState().selectInstance(id);
  await until(() => m.store.getState().scans[id]?.status === 'done');
  return m;
}

type M = Awaited<ReturnType<typeof ready>>;

/** The Lithostitched 1.0.9 replace (the update Modrinth offers for the 1.20.4 build). */
function lithoReplace(m: M): FixAction {
  const jar = m.backend.fix.jarsOf(ATM.id).find((j) => j.id === LITHO)!;
  const v = mockFindUpdates([jar.sha1], ['forge'], ['1.20.1'], ['release']).found[jar.sha1]!;
  return { kind: 'replace', jarId: LITHO, versionId: v.id };
}

function botarium(mc: string, loader: string): FixAction {
  const p = mockResolveModId('botarium')!;
  return { kind: 'installDependency', modId: 'botarium', versionId: mockProjectVersions(p.id, [loader], [mc])[0]!.id };
}

const paths = (m: M, id = ATM.id) => m.backend.fix.jarsOf(id).filter((j) => j.depth === 0).map((j) => j.path);
const scanPaths = (m: M, id = ATM.id) => (m.store.getState().scans[id]?.result?.jars ?? []).filter((j) => j.depth === 0).map((j) => j.path);

async function finish(m: M) {
  await m.store.getState().executeOrder();
  await until(() => m.store.getState().scans[ATM.id]?.status === 'done' && m.store.getState().history[ATM.id]?.status === 'done');
}

describe('plan → panel → execute', () => {
  it('opens the planned order after game_running, streams OpStatus live, then rescans and reloads the history', async () => {
    const m = await ready();
    const game = vi.spyOn(m.backend.commands, 'gameRunning');
    await m.store.getState().fix('f-litho', lithoReplace(m), 'triage');
    const o = m.store.getState().order!;
    expect(game).toHaveBeenCalledWith(ATM.id);
    expect(o).toMatchObject({ phase: 'review', expired: false, game: { running: false }, source: { kind: 'fix', key: 'f-litho', from: 'triage' } });
    // Replace = download (naming the jar it replaces) + the move of the old jar into the backup.
    expect(o.order.ops.map((p) => p.op.op)).toEqual(['download', 'moveToBackup']);
    const dl = o.order.ops[0]!.op;
    expect(dl).toMatchObject({ op: 'download', projectTitle: 'Lithostitched', versionNumber: '1.0.9', replaces: LITHO, dest: 'mods/lithostitched-1.0.9.jar' });
    expect(dl.op === 'download' && dl.url.startsWith('https://cdn.modrinth.com/')).toBe(true);
    expect(o.order.title).toBe('Update Lithostitched to 1.0.9');
    expect(o.order.backupDir).toContain(`backups\\${ATM.id}\\`);

    const seen: OpStatus[][] = [];
    const off = m.store.subscribe((s) => {
      if (s.order?.phase === 'running') seen.push(s.order.statuses);
    });
    const rescan = vi.spyOn(m.backend.commands, 'scanInstance');
    await finish(m);
    off();
    // Live: an op was seen running before the result arrived.
    expect(seen.some((st) => st.some((x) => x.state === 'running'))).toBe(true);
    const done = m.store.getState().order!;
    expect(done.phase).toBe('finished');
    expect(done.rolledBack).toBe(false);
    expect(done.statuses.map((x) => x.state)).toEqual(['done', 'done']);
    expect(done.backupId).toMatch(new RegExp(`^${ATM.id}/\\d+$`));
    expect(orderOutcome(done.order, done.statuses, false)).toEqual({ ok: true, text: 'Done: 2 operations completed. Each action can be undone from History.' });
    // Rescanned: the new jar is there, the old one is in the snapshot.
    expect(rescan).toHaveBeenCalledWith(ATM.id);
    expect(scanPaths(m)).toContain('mods/lithostitched-1.0.9.jar');
    expect(scanPaths(m)).not.toContain(LITHO);
    // The panel stays until Close.
    expect(m.store.getState().order?.order.id).toBe(o.order.id);
    // History: the new snapshot first.
    const h = m.store.getState().history[ATM.id]!;
    expect(h.entries[0]).toMatchObject({ id: done.backupId, title: 'Update Lithostitched to 1.0.9', undoneActions: [] });
    await m.store.getState().cancelOrder();
    expect(m.store.getState().order).toBeNull();
  });

  it('Modrinth enrichment runs again after the rescan (the new jar is identified)', async () => {
    const m = await ready();
    await until(() => m.store.getState().modrinth[ATM.id]?.status === 'done');
    await m.store.getState().fix('f', lithoReplace(m));
    const identify = vi.spyOn(m.backend.commands, 'modrinthIdentify');
    await finish(m);
    await until(() => m.store.getState().modrinth[ATM.id]?.status === 'done' && identify.mock.calls.length > 0);
    const jar = m.store.getState().scans[ATM.id]!.result!.jars.find((j) => j.path === 'mods/lithostitched-1.0.9.jar')!;
    expect(identify.mock.calls.some((c) => c[0].includes(jar.sha1))).toBe(true);
    expect(m.store.getState().modrinth[ATM.id]!.ctx!.versions[jar.sha1]?.versionNumber).toBe('1.0.9');
  });

  it('Cancel discards the planned order in Rust; Esc-style cancel is ignored while running', async () => {
    const m = await ready({ opMs: 30 });
    await m.store.getState().fix('k', { kind: 'disable', jarId: CREATE });
    const id = m.store.getState().order!.order.id;
    expect(m.backend.fix.storedOrders()).toContain(id);
    await m.store.getState().cancelOrder();
    expect(m.backend.fix.storedOrders()).not.toContain(id);

    await m.store.getState().fix('k', { kind: 'disable', jarId: CREATE });
    const run = m.store.getState().executeOrder();
    expect(m.store.getState().order?.phase).toBe('running');
    await m.store.getState().cancelOrder();
    expect(m.store.getState().order?.phase).toBe('running');
    await run;
    expect(m.store.getState().order?.phase).toBe('finished');
  });

  it('a fix planned while another order executes is discarded and refused next to its button', async () => {
    const m = await ready({ opMs: 30 });
    await m.store.getState().fix('a', { kind: 'disable', jarId: CREATE });
    const run = m.store.getState().executeOrder();
    await m.store.getState().fix('b', { kind: 'disable', jarId: LITHO });
    expect(m.store.getState().fixErrors.b).toMatchObject({ kind: 'conflict', message: expect.stringContaining('Another work order is running') });
    await until(() => m.backend.fix.storedOrders().length === 0);
    await run;
  });

  it('ignores OpStatus of other orders and late events after the result', async () => {
    const m = await ready();
    await m.store.getState().fix('k', { kind: 'disable', jarId: CREATE });
    const id = m.store.getState().order!.order.id;
    await finish(m);
    const emit = (s: OpStatus) => (m.backend.events.opStatus as unknown as { emit(p: OpStatus): void }).emit(s);
    emit({ orderId: id, index: 0, state: 'failed', message: 'late' });
    emit({ orderId: 'other', index: 0, state: 'failed', message: 'other' });
    expect(m.store.getState().order!.statuses).toEqual([{ orderId: id, index: 0, state: 'done', message: null }]);
  });
});

describe('planning refusals', () => {
  it('refuses a destination that exists (installing the same dependency twice)', async () => {
    const m = await ready();
    await m.store.getState().fix('dep', botarium('1.20.1', 'forge'));
    expect(m.store.getState().order!.order.ops).toEqual([
      { actionIndex: 0, op: expect.objectContaining({ op: 'download', projectTitle: 'Botarium', replaces: null, dest: expect.stringMatching(/^mods\/botarium-/) }) },
    ]);
    await finish(m);
    await m.store.getState().cancelOrder();
    await m.store.getState().fix('dep', botarium('1.20.1', 'forge'));
    expect(m.store.getState().order).toBeNull();
    expect(m.store.getState().fixErrors.dep).toMatchObject({ kind: 'conflict', message: expect.stringMatching(/^Install Botarium 2\.3\.4: mods\/botarium-.* already exists/) });
  });

  it('refuses a version for another loader or Minecraft version, naming the action', async () => {
    const m = await ready({}, FO.id);
    await m.store.getState().fix('wrong-loader', botarium('1.20.1', 'forge'));
    expect(m.store.getState().fixErrors['wrong-loader']).toMatchObject({ kind: 'invalid', message: 'Install Botarium 2.3.4: that version is for forge, but this pack runs Fabric. It was not planned.' });
    const cloth = mockResolveModId('cloth_config')!;
    const old = mockProjectVersions(cloth.id, ['fabric'], ['1.20.1'])[0]!;
    await m.store.getState().fix('wrong-mc', { kind: 'installDependency', modId: 'cloth_config', versionId: old.id });
    expect(m.store.getState().fixErrors['wrong-mc']?.message).toBe(`Install Cloth Config API ${old.versionNumber}: that version is for Minecraft 1.20.1, not 1.21.1. It was not planned.`);
  });

  it('refuses Modrinth fixes while Modrinth is off, and a pack identity that contradicts the launcher', async () => {
    const m = await ready({ scenario: 'modrinthoff' });
    const replace = lithoReplace(m);
    await m.store.getState().fix('r', replace);
    expect(m.store.getState().fixErrors.r?.kind).toBe('offline');
    const r = await m.backend.commands.planWorkOrder(ATM.id, { mcVersion: '1.21.1', loader: { kind: 'forge', version: null } }, [{ kind: 'disable', jarId: CREATE }]);
    expect(r).toMatchObject({ status: 'error', error: { kind: 'invalid', message: expect.stringContaining('disagrees with the instance') } });
  });

  it('fix buttons say why they are disabled while the pack identity is unknown', () => {
    expect(fixBlockReason(undefined)).toBe('Fixes can be planned once the scan has finished.');
    const result = { instanceId: 'x', startedAtMs: 0, durationMs: 0, jars: [], declared: [], issues: [] };
    expect(fixBlockReason({ result, pack: { mcVersion: null, loader: null, side: 'client', source: 'unknown' } })).toMatch(/Pack identity/);
    expect(fixBlockReason({ result, pack: { mcVersion: '1.20.1', loader: { kind: 'forge', version: null }, side: 'client', source: 'launcher' } })).toBeNull();
  });
});

describe('execute refusals', () => {
  it('game running: a warning before Execute; the refusal keeps the order open for a retry', async () => {
    const m = await ready({ scenario: 'gamerunning' });
    await m.store.getState().fix('k', { kind: 'disable', jarId: CREATE });
    const o = m.store.getState().order!;
    expect(o.game).toMatchObject({ running: true, pids: [18244], reason: expect.stringContaining('javaw.exe pid 18244') });
    await m.store.getState().executeOrder();
    const after = m.store.getState().order!;
    expect(after).toMatchObject({ phase: 'review', expired: false, error: { kind: 'gameRunning' } });
    expect(after.error!.message).toContain('Nothing was changed.');
    // Nothing touched; the order is still stored, so Execute can be tried again.
    expect(paths(m)).toContain(CREATE);
    expect(m.backend.fix.storedOrders()).toContain(o.order.id);
    await m.store.getState().executeOrder();
    expect(m.store.getState().order?.error?.kind).toBe('gameRunning');
  });

  it('expired: notFound marks the order expired; Execute is gone, Plan again plans the same fix anew', async () => {
    const m = await ready();
    await m.store.getState().fix('k', { kind: 'disable', jarId: CREATE }, 'inspector');
    const first = m.store.getState().order!.order.id;
    m.backend.fix.expireAll();
    await m.store.getState().executeOrder();
    expect(m.store.getState().order).toMatchObject({ phase: 'review', expired: true, error: { kind: 'notFound', message: EXPIRED_MESSAGE } });
    const execute = vi.spyOn(m.backend.commands, 'executeWorkOrder');
    await m.store.getState().executeOrder();
    expect(execute).not.toHaveBeenCalled();
    const discard = vi.spyOn(m.backend.commands, 'discardWorkOrder');
    await m.store.getState().planAgain();
    const again = m.store.getState().order!;
    expect(again.order.id).not.toBe(first);
    expect(again).toMatchObject({ expired: false, error: null, replanning: false, source: { kind: 'fix', key: 'k', from: 'inspector' } });
    expect(discard).not.toHaveBeenCalledWith(first);
    await finish(m);
    expect(m.store.getState().order?.statuses.map((s) => s.state)).toEqual(['done']);
  });

  it('expired scenario: the first execute expires; a Plan again that is refused closes the panel and shows the refusal at its button', async () => {
    const m = await ready({ scenario: 'expired' });
    await m.store.getState().fix('k', { kind: 'disable', jarId: CREATE });
    await m.store.getState().executeOrder();
    expect(m.store.getState().order?.expired).toBe(true);
    vi.spyOn(m.backend.commands, 'planWorkOrder').mockResolvedValueOnce({ status: 'error', error: { kind: 'notFound', message: 'gone', path: null } });
    await m.store.getState().planAgain();
    expect(m.store.getState().order).toBeNull();
    expect(m.store.getState().fixErrors.k).toMatchObject({ message: 'gone' });
    expect(m.store.getState().fixErrorFrom.k).toBe('triage');
  });
});

describe('rollback', () => {
  it('fixfail: the 2nd op fails, the 1st is rolled back, the result says rolledBack and the files are as they were', async () => {
    const m = await ready({ scenario: 'fixfail' });
    await m.store.getState().fix('r', lithoReplace(m));
    const before = paths(m).sort();
    await finish(m);
    const o = m.store.getState().order!;
    expect(o.rolledBack).toBe(true);
    expect(o.statuses.map((s) => s.state)).toEqual(['done', 'failed']);
    expect(o.statuses[1]!.message).toContain('locked by another program');
    expect(paths(m).sort()).toEqual(before);
    expect(scanPaths(m)).toContain(LITHO);
    const out = orderOutcome(o.order, o.statuses, o.rolledBack);
    expect(out.ok).toBe(false);
    expect(out.text).toMatch(/^Operation 02 failed: .*Rolled back: every completed operation was reversed/);
    // Listed with nothing left to undo.
    expect(m.store.getState().history[ATM.id]!.entries[0]).toMatchObject({ id: o.backupId, undoneActions: [0] });
  });

  it('fixfail on a one-op order: it fails with nothing to roll back', async () => {
    const m = await ready({ scenario: 'fixfail' });
    await m.store.getState().fix('k', { kind: 'disable', jarId: CREATE });
    await finish(m);
    const o = m.store.getState().order!;
    expect(o.rolledBack).toBe(false);
    expect(o.statuses.map((s) => s.state)).toEqual(['failed']);
    expect(orderOutcome(o.order, o.statuses, false).text).toMatch(/Nothing was changed\.$/);
  });
});

describe('the mod-table toggle', () => {
  it('disables through a one-op order; after execute and rescan the jar is disabled and the history has it', async () => {
    const m = await ready();
    await m.store.getState().setJarEnabled(CREATE, false);
    expect(m.store.getState().order!.order.title).toBe('Disable create-1.20.1-0.5.1.f.jar');
    await finish(m);
    const jar = m.store.getState().scans[ATM.id]!.result!.jars.find((j) => j.id === CREATE)!;
    expect(jar).toMatchObject({ disabled: true, path: `${CREATE}.disabled` });
    expect(m.store.getState().history[ATM.id]!.entries[0]!.actions).toEqual([{ kind: 'disable', jarId: CREATE }]);
    // Undo is a single rename: Enter may confirm it.
    await m.store.getState().cancelOrder();
    await m.store.getState().undo(m.store.getState().history[ATM.id]!.entries[0]!.id, [0]);
    const u = m.store.getState().order!;
    expect(u.order.kind).toBe('undo');
    expect(u.order.ops).toEqual([{ actionIndex: 0, op: { op: 'rename', from: `${CREATE}.disabled`, to: CREATE } }]);
    expect(enterExecutes(u.order)).toBe(true);
    await finish(m);
    expect(m.store.getState().scans[ATM.id]!.result!.jars.find((j) => j.id === CREATE)).toMatchObject({ disabled: false, path: CREATE });
    expect(m.store.getState().history[ATM.id]!.entries[0]!.undoneActions).toEqual([0]);
  });
});

describe('backup history and undo', () => {
  it('lists the seeded snapshots newest first, with undone marks', async () => {
    const m = await ready();
    m.store.getState().setFindingsTab(ATM.id, 'history');
    await until(() => m.store.getState().history[ATM.id]?.status === 'done');
    const entries = m.store.getState().history[ATM.id]!.entries;
    expect(entries).toHaveLength(4);
    expect([...entries].sort((a, b) => b.createdAtMs - a.createdAtMs)).toEqual(entries);
    expect(entries.map((e) => e.undoneActions)).toEqual([[], [], [], [0, 1]]);
    expect(entries[1]!.title).toBe('Update Curios API to 5.9.1+1.20.1');
  });

  it('undo of an update restores the old jar and moves the new one into the snapshot', async () => {
    const m = await ready();
    await m.store.getState().loadBackups(ATM.id);
    const entry = m.store.getState().history[ATM.id]!.entries.find((e) => e.title.startsWith('Update Curios'))!;
    await m.store.getState().undo(entry.id, null);
    const o = m.store.getState().order!;
    expect(o).toMatchObject({ source: { kind: 'undo', backupId: entry.id, actionIndexes: null }, order: { kind: 'undo', title: 'Undo: update Curios API to 5.9.1+1.20.1' } });
    expect(o.order.ops.map((p) => p.op.op)).toEqual(['restore', 'removeCreated']);
    expect(enterExecutes(o.order)).toBe(false);
    await finish(m);
    expect(scanPaths(m)).toContain(CURIOS_OLD);
    expect(scanPaths(m)).not.toContain(CURIOS_NEW);
    expect(m.store.getState().history[ATM.id]!.entries.find((e) => e.id === entry.id)!.undoneActions).toEqual([0]);
  });

  it('refuses an undo whose file changed since, inline per action; the others still undo', async () => {
    const m = await ready();
    await m.store.getState().loadBackups(ATM.id);
    const entry = m.store.getState().history[ATM.id]!.entries.find((e) => e.actions.length === 2 && e.undoneActions.length === 0)!;
    await m.store.getState().undo(entry.id, [1]);
    expect(m.store.getState().order).toBeNull();
    const err = m.store.getState().undoErrors[undoKey(entry.id, [1])]!;
    expect(err.kind).toBe('conflict');
    expect(err.message).toMatch(/^Undo of "Disable fastsuite-1\.20\.1-5\.0\.1\.jar" was not planned: mods\/fastsuite-1\.20\.1-5\.0\.1\.jar\.disabled is not there any more/);
    expect(m.store.getState().undoPending[undoKey(entry.id, [1])]).toBeUndefined();
    // "Undo all remaining" includes it, so it is refused as a whole, at its own row.
    await m.store.getState().undo(entry.id, null);
    expect(m.store.getState().undoErrors[undoKey(entry.id, null)]?.kind).toBe('conflict');
    // The other action still undoes.
    await m.store.getState().undo(entry.id, [0]);
    expect(m.store.getState().order!.order.ops).toEqual([{ actionIndex: 0, op: { op: 'restore', backupPath: 'files/mods/jei-1.20.1-forge-15.1.0.11.jar', to: 'mods/jei-1.20.1-forge-15.1.0.11.jar', expectAbsentOrSha1: null } }]);
    m.store.getState().dismissUndoError(undoKey(entry.id, [1]));
    expect(m.store.getState().undoErrors[undoKey(entry.id, [1])]).toBeUndefined();
  });

  it('a history load failure is kept as an error; a later load recovers', async () => {
    const m = await ready();
    const spy = vi.spyOn(m.backend.commands, 'listBackups').mockResolvedValueOnce({ status: 'error', error: { kind: 'io', message: 'disk', path: null } });
    await m.store.getState().loadBackups(ATM.id);
    expect(m.store.getState().history[ATM.id]).toMatchObject({ status: 'error', error: { message: 'disk' } });
    spy.mockRestore();
    await m.store.getState().loadBackups(ATM.id);
    expect(m.store.getState().history[ATM.id]?.status).toBe('done');
  });
});
