// @vitest-environment happy-dom
/**
 * "Save fixed copy…" store flow over the mock backend and the REAL rules core: the opened pack's
 * findings carry edits, chosen edits are planned by the backend, saved, refused or cancelled.
 */
import { describe, expect, it } from 'vitest';

import type { Finding } from '../../../core/model';
import { createMockBackend } from '../mockIpc';
import { MOCK_PICKED_PACK } from '../mockData';
import { createAppStore } from '../store';
import { until } from './helpers';

const PACK = MOCK_PICKED_PACK.id;
const IF = 'mods/ImmediatelyFast-Fabric-1.3.4+1.21.1.jar';
const XAERO = 'mods/Xaeros_Minimap_24.2.0_Fabric_1.20.jar';

async function openPack() {
  const backend = createMockBackend({ scanMs: 0, latencyMs: 0, iconMs: 0 });
  const store = createAppStore({ backend, frame: (cb) => cb() });
  await store.getState().init();
  await store.getState().openMrpack();
  await until(() => store.getState().scans[PACK]?.status === 'done' && store.getState().modrinth[PACK]?.status === 'done');
  const findings = () => store.getState().scans[PACK]?.findings ?? [];
  const on = (path: string, code: Finding['code']) => {
    const f = findings().find((x) => x.code === code && x.culprits.some((c) => c.jarId === path));
    if (!f) throw new Error(`no ${code} on ${path}`);
    return f;
  };
  return { backend, store, findings, on };
}

describe('pack findings', () => {
  it('carry fixed-copy edits and never instance fixes', async () => {
    const { findings, on } = await openPack();
    expect(findings().flatMap((f) => f.fixes.filter((x) => x.kind !== 'manual'))).toEqual([]);
    expect(on(IF, 'E-MC-RANGE').packEdits?.map((s) => s.label)).toEqual(['Replace with 1.2.21+1.20.1', 'Remove ImmediatelyFast-Fabric-1.3.4+1.21.1.jar']);
    expect(on(XAERO, 'E-MISSING-DEP').packEdits?.map((s) => s.label)).toEqual(['Add Cloth Config API']);
  });
});

describe('the draft', () => {
  it('chosen edits are planned together, then saved; the path is kept', async () => {
    const { backend, store, on } = await openPack();
    const s = store.getState();
    const replace = on(IF, 'E-MC-RANGE');
    await s.addPackEdit(PACK, replace.id, replace.packEdits![0]!);
    let d = store.getState().packFix!;
    expect(d.phase).toBe('review');
    expect(d.plan?.ops.map((o) => [o.kind, o.subject])).toEqual([['replace', IF]]);
    expect(d.plan?.ops[0]?.url).toMatch(/^https:\/\/cdn\.modrinth\.com\//);

    const dep = on(XAERO, 'E-MISSING-DEP');
    await s.addPackEdit(PACK, dep.id, dep.packEdits![0]!);
    d = store.getState().packFix!;
    expect(d.edits.map((e) => e.label)).toEqual(['Replace with 1.2.21+1.20.1', 'Add Cloth Config API 11.1.136']);
    expect(d.plan?.ops.map((o) => o.kind)).toEqual(['replace', 'add']);
    expect(d.plan?.ops[1]?.detail).toContain('install it on both client and server');

    // The same edit again changes nothing; another edit of the same file replaces it.
    await s.addPackEdit(PACK, replace.id, replace.packEdits![0]!);
    expect(store.getState().packFix!.edits).toHaveLength(2);
    await s.addPackEdit(PACK, replace.id, replace.packEdits![1]!);
    expect(store.getState().packFix!.edits.map((e) => e.edit.kind)).toEqual(['removeDeclared', 'addDependency']);
    expect(store.getState().packFix!.plan?.ops.map((o) => o.kind)).toEqual(['remove', 'add']);

    await s.savePackFix();
    d = store.getState().packFix!;
    expect(d.phase).toBe('saved');
    expect(d.saved).toEqual({ path: 'C:\\Users\\alex\\Downloads\\Explorer Kit 2.1 (fixed).mrpack', fileName: 'Explorer Kit 2.1 (fixed).mrpack' });
    expect(backend.packFix.saved()).toHaveLength(1);
    s.cancelPackFix();
    expect(store.getState().packFix).toBeNull();
  });

  it('a cancelled dialog keeps the plan; a stale or expired plan is cleared and planned again', async () => {
    const { backend, store, on } = await openPack();
    const s = store.getState();
    const f = on(IF, 'E-MC-RANGE');
    await s.addPackEdit(PACK, f.id, f.packEdits![1]!);
    const planId = store.getState().packFix!.plan!.id;

    backend.packFix.cancelNextSave = true;
    await s.savePackFix();
    expect(store.getState().packFix).toMatchObject({ phase: 'review', error: null, saved: null });
    expect(store.getState().packFix!.plan!.id).toBe(planId);

    backend.packFix.failNextSave = { kind: 'conflict', message: 'The pack file changed since the fixed copy was planned. Review the edits again, then save.', path: null };
    await s.savePackFix();
    expect(store.getState().packFix!.error?.message).toBe('The pack file changed since the fixed copy was planned. Review the edits again, then save.');
    // Rust dropped the stale plan: only planning again helps.
    expect(store.getState().packFix!.plan).toBeNull();
    await s.planPackFixAgain();
    expect(store.getState().packFix).toMatchObject({ phase: 'review', error: null });

    backend.packFix.expireAll();
    await s.savePackFix();
    expect(store.getState().packFix!.error?.kind).toBe('notFound');
    expect(store.getState().packFix!.plan).toBeNull();
    await s.planPackFixAgain();
    expect(store.getState().packFix).toMatchObject({ phase: 'review', error: null });
    expect(store.getState().packFix!.plan!.id).not.toBe(planId);
    await s.savePackFix();
    expect(store.getState().packFix!.phase).toBe('saved');
  });

  it('a planning refusal is kept with the edits; removing the last edit closes the draft', async () => {
    const { store, on } = await openPack();
    const s = store.getState();
    const f = on(IF, 'E-MC-RANGE');
    await s.addPackEdit(PACK, f.id, { kind: 'edit', label: 'Remove gone.jar', edit: { kind: 'removeDeclared', path: 'mods/gone.jar' } });
    const d = store.getState().packFix!;
    expect(d.plan).toBeNull();
    expect(d.error?.message).toBe("Invalid request: Remove mods/gone.jar: the pack's index lists no file at that path.");
    await s.removePackEdit(0);
    expect(store.getState().packFix).toBeNull();
  });

  it('refusals of a button are sentences next to it (no version, another pack, Modrinth off)', async () => {
    const { store, on } = await openPack();
    const s = store.getState();
    const dep = on(XAERO, 'E-MISSING-DEP');
    await s.addPackEdit(PACK, dep.id, { kind: 'addProject', label: 'Add Nothing', projectId: 'NOPEnope', title: 'Nothing' });
    expect(store.getState().packEditErrors[dep.id]?.message).toBe(
      "Modrinth has no release or beta of Nothing for this pack's loader and Minecraft 1.20.1, so it can't be added.",
    );
    expect(store.getState().packFix).toBeNull();
    s.dismissPackEditError(dep.id);
    expect(store.getState().packEditErrors[dep.id]).toBeUndefined();

    // A draft of this pack is open; another pack's button is refused.
    const f = on(IF, 'E-MC-RANGE');
    await s.addPackEdit(PACK, f.id, f.packEdits![1]!);
    await s.addPackEdit('2b8f61e4d7a09c53', 'other-finding', f.packEdits![1]!);
    expect(store.getState().packEditErrors['other-finding']?.message).toBe(
      'A fixed copy of Explorer Kit 2.1 is being prepared. Save or cancel it first, then try again.',
    );

    await s.setModrinthEnabled(false);
    await s.addPackEdit(PACK, dep.id, dep.packEdits![0]!);
    expect(store.getState().packEditErrors[dep.id]?.kind).toBe('offline');
  });
});
