/** Store-level Modrinth flow (M5) against the mock backend and the real `src/core/modrinth`. */
import { describe, expect, it, vi } from 'vitest';

import type { AppError, HashLookup, LogDigest } from '../../../bindings';
import { jarMatch } from '../../../core/modrinth';
import type { CheckInput, Finding } from '../../../core/model';
import { deriveModRows } from '../derive';
import type { Result } from '../ipc';
import { MOCK_INSTANCES } from '../mockData';
import { fixVersions, modrinthRowView, noticeText, viewContext } from '../modrinthState';
import { fixLabel } from '../../components/labels';
import { finding, mockStore, until } from './helpers';

const ATM = MOCK_INSTANCES[0]!;
const FO = MOCK_INSTANCES[1]!;
const AD_ASTRA = 'mods/ad_astra-forge-1.20.1-1.15.18.jar';
const CREATE = 'mods/create-1.20.1-0.5.1.f.jar';
const OPTIFINE = 'mods/OptiFine_1.20.1_HD_U_I6.jar';
const LITHO = 'mods/lithostitched-forge-1.20.4-1.1.5.jar';

/** Checks that cite Modrinth the way the real ones do: a missing dep always, an MC-range error. */
function checks(input: CheckInput): Finding[] {
  const out = [
    finding('missing', 'error', [AD_ASTRA], { code: 'E-MISSING-DEP', missingModIds: ['botarium'], fixes: [] }),
    finding('range', 'error', [LITHO], { code: 'E-MC-RANGE', fixes: [{ kind: 'disable', jarId: LITHO }] }),
  ];
  if (input.modrinth) out.push(finding('notmr', 'info', [OPTIFINE], { code: 'I-NOT-ON-MODRINTH', fixes: [] }));
  return out;
}

type Store = ReturnType<typeof mockStore>;
const mr = (m: Store, id = ATM.id) => m.store.getState().modrinth[id];
const findings = (m: Store, id = ATM.id) => m.store.getState().scans[id]?.findings ?? [];

async function enriched(m: Store, id = ATM.id) {
  await m.store.getState().init();
  await until(() => mr(m, id)?.status === 'done' && !!mr(m, id)?.resolutions.botarium, 4000);
}

function deferred<T>() {
  let resolve: (v: T) => void = () => undefined;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

describe('Modrinth flow after a scan', () => {
  it('runs identify → updates (+ beta fallback) → projects → checks with the context → dependency resolution', async () => {
    const m = mockStore({}, checks);
    const order: string[] = [];
    const cmd = m.backend.commands;
    for (const k of ['modrinthIdentify', 'modrinthFindUpdates', 'modrinthProjects', 'modrinthResolveModId', 'modrinthProjectVersions'] as const) {
      const orig = cmd[k] as (...a: unknown[]) => Promise<unknown>;
      vi.spyOn(cmd, k).mockImplementation(((...a: unknown[]) => {
        order.push(k === 'modrinthFindUpdates' ? `updates:${(a[3] as string[]).join('+')}` : k);
        return orig(...a);
      }) as never);
    }
    await enriched(m);
    expect(order.slice(0, 4)).toEqual(['modrinthIdentify', 'updates:release', 'updates:release+beta', 'modrinthProjects']);
    expect(order.slice(4)).toEqual(['modrinthResolveModId', 'modrinthProjectVersions']);
    // First the static checks, then again with the context.
    expect(m.calls[0]!.modrinth).toBeUndefined();
    expect(m.calls.at(-1)!.modrinth?.offline).toBe(false);
    const fs = findings(m);
    expect(fs.map((f) => f.id)).toContain('notmr');
    const missing = fs.find((f) => f.id === 'missing')!;
    expect(missing.fixes[0]).toMatchObject({ kind: 'installDependency', modId: 'botarium' });
    const range = fs.find((f) => f.id === 'range')!;
    expect(range.fixes[0]).toMatchObject({ kind: 'replace', jarId: LITHO });
    // Fix labels name the Modrinth versions.
    const st = mr(m)!;
    const versions = fixVersions(st.ctx, st.resolutions);
    expect(fixLabel(missing.fixes[0]!, {}, versions)).toBe('Install Botarium 2.3.4');
    expect(fixLabel(range.fixes[0]!, {}, versions)).toBe('Update Lithostitched to 1.0.9');
    expect(m.store.getState().scans[ATM.id]!.status).toBe('done');
    expect(st.notice).toBeNull();
  });

  it('shows the static findings first and never blocks them on Modrinth', async () => {
    const m = mockStore({}, checks);
    const gate = deferred<Result<HashLookup>>();
    vi.spyOn(m.backend.commands, 'modrinthIdentify').mockReturnValue(gate.promise);
    await m.store.getState().init();
    await until(() => m.store.getState().scans[ATM.id]?.status === 'done');
    expect(findings(m).map((f) => f.id)).toEqual(['missing', 'range']);
    expect(mr(m)?.status).toBe('loading');
    gate.resolve({ status: 'error', error: { kind: 'network', message: 'Modrinth did not answer.', path: null } });
    await until(() => mr(m)?.status === 'error');
    expect(mr(m)?.notice).toEqual({ kind: 'offline' });
    expect(findings(m).map((f) => f.id)).toEqual(['missing', 'range']);
  });

  it('feeds the mod table: update, beta-only update, not on Modrinth, icons', async () => {
    const m = mockStore({}, checks);
    await enriched(m);
    const sc = m.store.getState().scans[ATM.id]!;
    const ctx = viewContext(mr(m), sc.result);
    expect(ctx).not.toBeNull();
    const rows = deriveModRows(sc, modrinthRowView({ jarMatch }, ctx, null));
    const row = (id: string) => rows.find((r) => r.id === id)!;
    expect(row(CREATE).modrinth).toEqual({ state: 'update', version: '0.5.1.j', beta: false });
    expect(row(OPTIFINE).modrinth).toEqual({ state: 'missing' });
    expect(row(CREATE).iconUrl).toMatch(/^data:image\/svg\+xml,/);
    expect(row('mods/ftb-library-forge-2001.2.1.jar').iconUrl).toBeNull();
    // Nested jars are unknown unless identified.
    expect(row(CREATE).children?.[0]?.modrinth).toEqual({ state: 'offline' });

    m.store.getState().selectInstance(FO.id);
    await until(() => mr(m, FO.id)?.status === 'done');
    const fo = m.store.getState().scans[FO.id]!;
    const foRows = deriveModRows(fo, modrinthRowView({ jarMatch }, viewContext(mr(m, FO.id), fo.result), null));
    const ec = foRows.find((r) => r.id.startsWith('mods/entityculling'))!;
    expect(ec.modrinth).toEqual({ state: 'update', version: '1.7.1-beta.2', beta: true });
  });

  it('caches per instance: switching instances does not query again; Refresh does, bypassing the cache', async () => {
    const m = mockStore({}, checks);
    await enriched(m);
    const identify = vi.spyOn(m.backend.commands, 'modrinthIdentify');
    m.store.getState().selectInstance(FO.id);
    await until(() => mr(m, FO.id)?.status === 'done');
    expect(identify).toHaveBeenCalledTimes(1);
    m.store.getState().selectInstance(ATM.id);
    m.store.getState().selectInstance(FO.id);
    m.store.getState().selectInstance(ATM.id);
    await new Promise((r) => setTimeout(r, 20));
    expect(identify).toHaveBeenCalledTimes(1);
    // A rescan with the same jars reuses the context too.
    await m.store.getState().scan(ATM.id);
    expect(identify).toHaveBeenCalledTimes(1);
    expect(viewContext(mr(m), m.store.getState().scans[ATM.id]!.result)).not.toBeNull();
    await m.store.getState().refreshModrinth(ATM.id);
    expect(identify).toHaveBeenCalledTimes(2);
    expect(identify.mock.calls[1]![1]).toBe(true);
  });

  it('drops a lookup whose scan was replaced or whose settings changed meanwhile', async () => {
    const m = mockStore({}, checks);
    const gate = deferred<Result<HashLookup>>();
    const real = m.backend.commands.modrinthIdentify;
    const spy = vi.spyOn(m.backend.commands, 'modrinthIdentify').mockReturnValueOnce(gate.promise);
    await m.store.getState().init();
    await until(() => mr(m)?.status === 'loading');
    // Modrinth switched off while the lookup is in flight.
    await m.store.getState().setModrinthEnabled(false);
    expect(mr(m)?.status).toBe('off');
    gate.resolve(await real([], false));
    await new Promise((r) => setTimeout(r, 20));
    expect(mr(m)?.status).toBe('off');
    expect(mr(m)?.ctx).toBeNull();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('degrades on partial failures: updates fail → no update states, a notice, matches kept', async () => {
    const m = mockStore({}, checks);
    vi.spyOn(m.backend.commands, 'modrinthFindUpdates').mockResolvedValue({ status: 'error', error: { kind: 'network', message: 'Modrinth did not answer.', path: null } });
    vi.spyOn(m.backend.commands, 'modrinthProjects').mockResolvedValue({ status: 'error', error: { kind: 'internal', message: 'boom', path: null } });
    await enriched(m);
    const st = mr(m)!;
    expect(st.notice).toEqual({ kind: 'offline' });
    expect(st.updatesChecked).toBe(false);
    const sc = m.store.getState().scans[ATM.id]!;
    const rows = deriveModRows(sc, modrinthRowView({ jarMatch }, viewContext(st, sc.result), null));
    expect(rows.find((r) => r.id === CREATE)!.modrinth).toEqual({ state: 'matched' });
    expect(rows.find((r) => r.id === CREATE)!.iconUrl).toBeNull();
    expect(noticeText(st.notice, 0)).toBe('Modrinth unreachable — static checks only');
  });

  it('offline: every jar unknown, the unreachable notice, static findings only', async () => {
    const m = mockStore({ scenario: 'offline' }, checks);
    await m.store.getState().init();
    await until(() => mr(m)?.status === 'done');
    const st = mr(m)!;
    expect(st.notice).toEqual({ kind: 'offline' });
    const sc = m.store.getState().scans[ATM.id]!;
    const rows = deriveModRows(sc, modrinthRowView({ jarMatch }, viewContext(st, sc.result), null));
    expect(rows.every((r) => r.modrinth.state === 'offline')).toBe(true);
    expect(findings(m).every((f) => f.fixes.every((x) => x.kind !== 'installDependency' && x.kind !== 'replace'))).toBe(true);
  });

  it('rate limit: a countdown notice, one automatic retry after retryAfterS, then success', async () => {
    const timers: Array<{ cb: () => void; ms: number }> = [];
    const m = mockStore({ scenario: 'ratelimit' }, checks, undefined, { setTimer: (cb, ms) => void timers.push({ cb, ms }) });
    await m.store.getState().init();
    await until(() => mr(m)?.notice?.kind === 'rateLimited');
    expect(timers).toHaveLength(1);
    expect(timers[0]!.ms).toBe(5000);
    const n = mr(m)!.notice!;
    expect(n.kind === 'rateLimited' && n.retryAt !== null).toBe(true);
    if (n.kind === 'rateLimited' && n.retryAt !== null) expect(noticeText(n, n.retryAt - 4200)).toBe('Modrinth rate limit — retrying in 5 s');
    timers[0]!.cb();
    await until(() => mr(m)?.status === 'done' && mr(m)?.notice === null);
    expect(findings(m).map((f) => f.id)).toContain('notmr');
  });

  it('rate limit twice: no second automatic retry', async () => {
    const timers: Array<() => void> = [];
    const m = mockStore({}, checks, undefined, { setTimer: (cb) => void timers.push(cb) });
    const limited: AppError = { kind: 'rateLimited', message: 'Slow down.', path: null, retryAfterS: 42 };
    vi.spyOn(m.backend.commands, 'modrinthIdentify').mockResolvedValue({ status: 'error', error: limited });
    await m.store.getState().init();
    await until(() => timers.length === 1);
    timers[0]!();
    await until(() => {
      const n = mr(m)?.notice;
      return n?.kind === 'rateLimited' && n.retryAt === null;
    });
    expect(timers).toHaveLength(1);
    expect(noticeText(mr(m)!.notice, 0)).toBe('Modrinth rate limit — static checks only');
  });

  it('settings: off clears the context and stores the setting; on and includeBeta re-query', async () => {
    const m = mockStore({}, checks);
    await enriched(m);
    await m.store.getState().setModrinthEnabled(false);
    expect(m.backend.settings().modrinthEnabled).toBe(false);
    expect(mr(m)?.status).toBe('off');
    expect(m.calls.at(-1)!.modrinth).toBeUndefined();
    expect(findings(m).map((f) => f.id)).not.toContain('notmr');

    const updates = vi.spyOn(m.backend.commands, 'modrinthFindUpdates');
    await m.store.getState().setModrinthEnabled(true);
    await until(() => mr(m)?.status === 'done');
    expect(updates.mock.calls.map((c) => c[3])).toEqual([['release'], ['release', 'beta']]);

    updates.mockClear();
    await m.store.getState().setIncludeBeta(true);
    await until(() => mr(m)?.status === 'done');
    expect(m.backend.settings().includeBeta).toBe(true);
    // With betas included there is no separate fallback call.
    expect(updates.mock.calls.map((c) => c[3])).toEqual([['release', 'beta']]);
  });

  it('enriches crash findings and resolves the mod ids they report missing', async () => {
    const crashFinding = finding('crash', 'error', [CREATE], { code: 'C-MISSING-MANDATORY', missingModIds: ['cloth_config'], fixes: [] });
    const m = mockStore({}, checks, undefined, {
      crashCore: { analyzeCrash: (input: { digest: LogDigest }) => (input.digest ? [crashFinding] : []), buildJarIndex: () => ({}) as never },
    });
    await enriched(m);
    await until(() => !!mr(m)?.resolutions.cloth_config, 4000);
    await until(() =>
      Object.values(m.store.getState().crashes[ATM.id]?.analyses ?? {}).some((a) => a.findings.some((f) => f.fixes.some((x) => x.kind === 'installDependency'))),
    );
    const a = Object.values(m.store.getState().crashes[ATM.id]!.analyses).find((x) => x.status === 'done')!;
    expect(a.findings[0]!.fixes[0]).toMatchObject({ kind: 'installDependency', modId: 'cloth_config' });
    const st = mr(m)!;
    expect(fixLabel(a.findings[0]!.fixes[0]!, {}, fixVersions(st.ctx, st.resolutions))).toBe('Install Cloth Config API 11.1.136');
  });

});
