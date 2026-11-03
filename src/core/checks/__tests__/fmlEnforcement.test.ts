/**
 * Loader-accurate enforcement (docs/research/loader-enforcement.md): FML VersionSupportMatrix
 * fallbacks, FML side filtering, and per-loader duplicate-id severity. Includes the exact cases
 * from the owner's NeoForge 21.1.235 / MC 1.21.1 pack, which loads fine.
 */
import { describe, expect, it } from 'vitest';
import type { LoaderKind, Side } from '../../../bindings';
import type { Severity } from '../../model';
import { evaluateRange, FML_VERSION_SUPPORT_MATRIX, fmlFallbacks } from '../../pack';
import { fabric, forge, highlighted, jar, neoforge, notes, only, pack, quilt, range, run } from './fixtures';

describe('FML VersionSupportMatrix', () => {
  it.each<[LoaderKind, string, string, string[]]>([
    // Every row of the research table…
    ['neoforge', '1.21.1', 'minecraft', ['1.21']],
    ['neoforge', '1.21.1', 'neoforge', ['21.0.166']],
    ['neoforge', '1.21.8', 'minecraft', ['1.21.7']],
    ['neoforge', '1.21.8', 'neoforge', ['21.7.26-beta']],
    ['forge', '1.20.1', 'forge', ['47.1.79']],
    ['forge', '1.20.1', 'minecraft', []],
    // …and the strict ones.
    ['neoforge', '1.20.4', 'minecraft', []], // 20.x
    ['neoforge', '1.20.4', 'neoforge', []],
    ['neoforge', '1.21', 'minecraft', []], // 21.0
    ['neoforge', '1.21.3', 'minecraft', []], // 21.3
    ['neoforge', '1.21.4', 'neoforge', []],
    ['neoforge', '1.21.5', 'minecraft', []],
    ['neoforge', '1.21.1', 'forge', []],
    ['forge', '1.21.1', 'forge', []],
    ['fabric', '1.21.1', 'minecraft', []],
    ['quilt', '1.21.1', 'minecraft', []],
  ])('%s on %s: %s also accepts %j', (loader, mc, dep, expected) => {
    expect(fmlFallbacks(loader, mc, dep)).toEqual(expected);
  });

  it('has exactly the three researched rows', () => {
    expect(FML_VERSION_SUPPORT_MATRIX.map((r) => `${r.loader}@${r.mc}`)).toEqual(['neoforge@1.21.1', 'neoforge@1.21.8', 'forge@1.20.1']);
  });

  it('fallbacks never apply to Fabric-syntax ranges', () => {
    const fabricRange = range('fabric', '1.21');
    expect(evaluateRange('1.21.1', fabricRange, 'minecraft', 'minecraft', { loader: 'neoforge', mc: '1.21.1' })).toEqual({ kind: 'fail' });
  });
});

describe('E-MC-RANGE with FML fallbacks', () => {
  it.each<[string, LoaderKind, string, string, string | undefined, Side, Severity | null]>([
    // Owner's pack: NeoForge 21.1.235 on 1.21.1.
    ['Iris [1.21,1.21.1) side CLIENT on a client', 'neoforge', '1.21.1', '[1.21,1.21.1)', 'CLIENT', 'client', 'info'],
    ['Iris [1.21,1.21.1) side CLIENT on a server → skipped by FML side filter', 'neoforge', '1.21.1', '[1.21,1.21.1)', 'CLIENT', 'server', null],
    ['Deep Aether [1.21,1.21.1) side BOTH on a client', 'neoforge', '1.21.1', '[1.21,1.21.1)', 'BOTH', 'client', 'info'],
    ['Deep Aether [1.21,1.21.1) side BOTH on a server', 'neoforge', '1.21.1', '[1.21,1.21.1)', 'BOTH', 'server', 'info'],
    ['[1.21.1] is fine', 'neoforge', '1.21.1', '[1.21.1]', 'BOTH', 'client', null],
    ['[1.21] (exact old version) → info', 'neoforge', '1.21.1', '[1.21]', undefined, 'client', 'info'],
    ['[1.20,1.20.6] on 1.21.1 → error', 'neoforge', '1.21.1', '[1.20,1.20.6]', 'BOTH', 'client', 'error'],
    ['SERVER-side dependency skipped on a client', 'neoforge', '1.21.1', '[1.20,1.20.6]', 'SERVER', 'client', null],
    // NeoForge 1.21.8 row.
    ['[1.21.7] on 1.21.8 → info', 'neoforge', '1.21.8', '[1.21.7]', undefined, 'client', 'info'],
    ['[1.21.6] on 1.21.8 → error', 'neoforge', '1.21.8', '[1.21.6]', undefined, 'client', 'error'],
    // Strict NeoForge versions.
    ['NeoForge 21.0 (1.21) is strict', 'neoforge', '1.21', '[1.20.6]', undefined, 'client', 'error'],
    ['NeoForge 21.3 (1.21.3) is strict for [1.21,1.21.1)', 'neoforge', '1.21.3', '[1.21,1.21.1)', undefined, 'client', 'error'],
    ['NeoForge 20.x (1.20.4) is strict', 'neoforge', '1.20.4', '[1.20.2,1.20.4)', undefined, 'client', 'error'],
    // Forge 1.20.1: only the forge mod has a fallback; minecraft is strict.
    ['Forge 1.20.1 minecraft [1.20] → error', 'forge', '1.20.1', '[1.20]', undefined, 'client', 'error'],
    ['Forge 1.20.1 minecraft [1.20,1.21) is fine', 'forge', '1.20.1', '[1.20,1.21)', undefined, 'client', null],
  ])('%s', (_name, loader, mc, mcRange, mcSide, side, expected) => {
    const j = jar({ file: 'mod.jar', mods: [{ id: 'mod', loader, mc: mcRange, ...(mcSide ? { mcSide } : {}) }] });
    const found = only(run([j], pack(loader, mc, null, side)), 'E-MC-RANGE');
    expect(found.map((f) => f.severity)).toEqual(expected ? [expected] : []);
  });

  it.each<[string, LoaderKind, string | string[]]>([
    ['Fabric', 'fabric', '1.21'],
    ['Fabric array', 'fabric', ['1.20.6', '1.21']],
    ['Quilt', 'quilt', '=1.21'],
  ])('%s stays strict on 1.21.1', (_name, loader, mcRange) => {
    const j = jar({ file: 'mod.jar', mods: [{ id: 'mod', loader, mc: mcRange }] });
    expect(only(run([j], pack(loader, '1.21.1')), 'E-MC-RANGE').map((f) => f.severity)).toEqual(['error']);
  });

  it('info finding names the compatibility override and keeps the evidence', () => {
    const iris = neoforge({ file: 'iris-neoforge-1.8.1.jar', mods: [{ id: 'iris', name: 'Iris', mc: '[1.21,1.21.1)', mcSide: 'CLIENT' }] });
    const [f] = only(run([iris], pack('neoforge', '1.21.1', '21.1.235')), 'E-MC-RANGE');
    expect(f?.severity).toBe('info');
    expect(f?.title).toBe('Iris declares Minecraft [1.21,1.21.1); loads on 1.21.1 through a compatibility override');
    expect(f?.explanation).toContain("loads through NeoForge's compatibility override for 1.21 mods on 1.21.1");
    expect(notes(f)).toContain("Accepted through NeoForge's compatibility override for 1.21 mods on 1.21.1.");
    expect(highlighted(f)).toEqual(['modId="minecraft"', 'versionRange="[1.21,1.21.1)"']);
    expect(f?.fixes.map((x) => x.kind)).toEqual(['manual']);
  });
});

describe('E-LOADER-RANGE with FML fallbacks', () => {
  it.each<[string, LoaderKind, string, string, string, string | undefined, Side, Severity | null]>([
    ['neoforge [21.0.0-beta,21.1.227) on 21.1.235 → info', 'neoforge', '1.21.1', '21.1.235', '[21.0.0-beta,21.1.227)', undefined, 'client', 'info'],
    ['neoforge [21.1.240,) on 21.1.235 → error', 'neoforge', '1.21.1', '21.1.235', '[21.1.240,)', undefined, 'client', 'error'],
    ['neoforge [21.1,) on 21.1.235 is fine', 'neoforge', '1.21.1', '21.1.235', '[21.1,)', undefined, 'client', null],
    ['neoforge CLIENT-side loader dep skipped on a server', 'neoforge', '1.21.1', '21.1.235', '[21.1.240,)', 'CLIENT', 'server', null],
    ['neoforge 1.21.8: [21.7.0-beta,21.7.30) on 21.8.10 → info', 'neoforge', '1.21.8', '21.8.10', '[21.7.0-beta,21.7.30)', undefined, 'client', 'info'],
    ['neoforge 1.21.3 is strict', 'neoforge', '1.21.3', '21.3.50', '[21.0.0-beta,21.3.40)', undefined, 'client', 'error'],
    ['forge [47.1.80,) on 47.0.35 → error', 'forge', '1.20.1', '47.0.35', '[47.1.80,)', undefined, 'client', 'error'],
    ['forge [47,) on 47.0.35 is fine', 'forge', '1.20.1', '47.0.35', '[47,)', undefined, 'client', null],
    ['forge [47.1.0,) on 47.0.35 → info (47.1.79 fallback)', 'forge', '1.20.1', '47.0.35', '[47.1.0,)', undefined, 'client', 'info'],
    ['forge on 1.19.2 is strict', 'forge', '1.19.2', '43.2.0', '[43.3,)', undefined, 'client', 'error'],
  ])('%s', (_name, loader, mc, version, loaderDep, loaderSide, side, expected) => {
    const j = jar({ file: 'mod.jar', mods: [{ id: 'mod', loader, loaderDep, ...(loaderSide ? { loaderSide } : {}) }] });
    const found = only(run([j], pack(loader, mc, version, side)), 'E-LOADER-RANGE');
    expect(found.map((f) => f.severity)).toEqual(expected ? [expected] : []);
  });

  it('Fabric loader ranges stay strict', () => {
    const j = fabric({ file: 'm.jar', mods: [{ id: 'm', loaderDep: '>=0.16' }] });
    expect(only(run([j], pack('fabric', '1.21.1', '0.15.11')), 'E-LOADER-RANGE').map((f) => f.severity)).toEqual(['error']);
  });

  it('info wording names the fallback version', () => {
    const j = neoforge({ file: 'create.jar', mods: [{ id: 'create', name: 'Create', loaderDep: '[21.0.0-beta,21.1.227)' }] });
    const [f] = only(run([j], pack('neoforge', '1.21.1', '21.1.235')), 'E-LOADER-RANGE');
    expect(f?.title).toBe('Create declares NeoForge [21.0.0-beta,21.1.227); loads on 21.1.235 through a compatibility override');
    expect(f?.explanation).toContain("NeoForge's compatibility override for mods built for NeoForge 21.0.166 on 1.21.1");
  });
});

describe('E-DEP-RANGE on minecraft/loader dependencies not covered by the range checks', () => {
  const p = pack('neoforge', '1.21.1', '21.1.235');

  it.each<[string, string, 'required' | 'optional', string | undefined, Side, Severity | null]>([
    ['optional neoforge [21.0.0-beta,21.1.227) → info', '[21.0.0-beta,21.1.227)', 'optional', undefined, 'client', 'info'],
    ['optional neoforge [21.1.240,) → error (FML enforces optional ranges)', '[21.1.240,)', 'optional', undefined, 'client', 'error'],
    ['optional neoforge [21.1.240,) side CLIENT on a server → skipped', '[21.1.240,)', 'optional', 'CLIENT', 'server', null],
    ['required neoforge [21.1,) → fine', '[21.1,)', 'required', undefined, 'client', null],
  ])('%s', (_name, depRange, kind, side, packSide, expected) => {
    const j = neoforge({
      file: 'm.jar',
      mods: [{ id: 'm', loaderDep: '[21.1,)', deps: [{ id: 'neoforge', kind, range: depRange, ...(side ? { side } : {}) }] }],
    });
    const found = only(run([j], { ...p, side: packSide }), 'E-DEP-RANGE');
    expect(found.map((f) => f.severity)).toEqual(expected ? [expected] : []);
  });

  it('a second minecraft dependency gets the 1.21 fallback too', () => {
    const j = neoforge({ file: 'm.jar', mods: [{ id: 'm', mc: '[1.21.1]', deps: [{ id: 'minecraft', kind: 'optional', range: '[1.21,1.21.1)' }] }] });
    const found = run([j], p);
    expect(only(found, 'E-MC-RANGE')).toEqual([]);
    expect(only(found, 'E-DEP-RANGE').map((f) => f.severity)).toEqual(['info']);
  });

  it('the dependency owned by E-MC-RANGE / E-LOADER-RANGE is not reported twice', () => {
    const j = neoforge({ file: 'm.jar', mods: [{ id: 'm', mc: '[1.20,1.20.6]', loaderDep: '[21.1.240,)' }] });
    const found = run([j], p);
    expect(only(found, 'E-DEP-RANGE')).toEqual([]);
    expect(only(found, 'E-MC-RANGE')).toHaveLength(1);
    expect(only(found, 'E-LOADER-RANGE')).toHaveLength(1);
  });
});

describe('E-DUP-ID per loader', () => {
  it('createdynlight 2.0.1 + 2.3.1 on NeoForge (same first mod id) → warning, keep the newest', () => {
    const older = neoforge({ file: 'createdynlight-2.0.1.jar', mods: [{ id: 'createdynlight', name: 'Create Dynamic Lights', version: '2.0.1' }] });
    const newer = neoforge({ file: 'createdynlight-2.3.1.jar', mods: [{ id: 'createdynlight', name: 'Create Dynamic Lights', version: '2.3.1' }] });
    const [f] = only(run([older, newer], pack('neoforge', '1.21.1', '21.1.235')), 'E-DUP-ID');
    expect(f).toMatchObject({
      severity: 'warning',
      title: 'Two copies of Create Dynamic Lights — the loader keeps the newest (2.3.1) and ignores the older',
      fixes: [{ kind: 'removeDuplicate', keep: 'mods/createdynlight-2.3.1.jar', remove: 'mods/createdynlight-2.0.1.jar' }],
    });
    expect(f?.explanation).toContain('FML groups jars by their first mod id');
  });

  it('a secondary mod in a multi-mod jar is a hard error on FML', () => {
    const big = neoforge({ file: 'bigmod.jar', mods: [{ id: 'bigmod' }, { id: 'sharedlib' }] });
    const lib = neoforge({ file: 'sharedlib.jar', mods: [{ id: 'sharedlib' }] });
    const [f] = only(run([big, lib], pack('neoforge', '1.21.1', '21.1.235')), 'E-DUP-ID');
    expect(f?.severity).toBe('error');
    expect(f?.explanation).toContain('not the first mod of every file');
  });

  it.each<[string, LoaderKind, Severity]>([
    ['Forge, same first id', 'forge', 'warning'],
    ['NeoForge, same first id', 'neoforge', 'warning'],
    ['Fabric', 'fabric', 'warning'],
    ['Quilt', 'quilt', 'error'],
    ['Legacy Forge', 'legacyforge', 'error'],
  ])('%s → %s', (_name, loader, severity) => {
    const a = jar({ file: 'x-1.0.jar', mods: [{ id: 'x', loader, version: '1.0' }] });
    const b = jar({ file: 'x-2.0.jar', mods: [{ id: 'x', loader, version: '2.0' }] });
    const mc = loader === 'legacyforge' ? '1.12.2' : '1.20.1';
    expect(only(run([a, b], pack(loader, mc)), 'E-DUP-ID').map((f) => f.severity)).toEqual([severity]);
  });

  it('Forge secondary-id duplicate → error; Quilt says "Duplicate mod"', () => {
    const a = forge({ file: 'a.jar', mods: [{ id: 'a' }, { id: 'shared' }] });
    const b = forge({ file: 'b.jar', mods: [{ id: 'shared' }] });
    expect(only(run([a, b], pack('forge', '1.20.1')), 'E-DUP-ID').map((f) => f.severity)).toEqual(['error']);
    const q1 = quilt({ file: 'q1.jar', mods: [{ id: 'q' }] });
    const q2 = quilt({ file: 'q2.jar', mods: [{ id: 'q' }] });
    expect(only(run([q1, q2], pack('quilt', '1.20.1')), 'E-DUP-ID')[0]?.explanation).toContain('Duplicate mod');
  });

  it('severity changes do not change the finding id', () => {
    const a = jar({ file: 'x-1.0.jar', mods: [{ id: 'x', loader: 'fabric', version: '1.0' }] });
    const b = jar({ file: 'x-2.0.jar', mods: [{ id: 'x', loader: 'fabric', version: '2.0' }] });
    const asFabric = only(run([a, b], pack('fabric', '1.20.1')), 'E-DUP-ID')[0]?.id;
    const asQuilt = only(run([a, b], pack('quilt', '1.20.1')), 'E-DUP-ID')[0]?.id;
    expect(asFabric).toBe(asQuilt);
  });
});
