/**
 * M3 smoke-scan follow-up (docs/research/loader-enforcement.md, "Follow-up"): older FML
 * VersionSupportMatrix branches, legacy FML metadata (mcmod.info only), and Sinytra Connector.
 * Cases mirror real packs that load: All in One / Create Above and Beyond (Forge 36.2.x),
 * Parasites / RLCraft (Forge 1.12.2), antarchy (NeoForge 1.21.1 + Connector).
 */
import { describe, expect, it } from 'vitest';
import type { JarRecord, LoaderKind } from '../../../bindings';
import type { Severity } from '../../model';
import { describeFallback, evaluateRange, fmlFallbacks } from '../../pack';
import { codes, fabric, forge, jar, neoforge, nested, only, pack, run } from './fixtures';

describe('VersionSupportMatrix on every branch', () => {
  it.each<[string, string, string | null, string, string[]]>([
    ['Forge 1.16.5 (36.x)', '1.16.5', '36.2.39', 'minecraft', ['1.16.3', '1.16.4']],
    ['Forge 1.16.5 (36.x)', '1.16.5', '36.2.39', 'forge', ['34.1.42', '35.1.37']],
    ['Forge 1.16.4 (35.x)', '1.16.4', '35.1.37', 'minecraft', ['1.16.3', '1.16.4']],
    ['Forge 1.16.3 (34.x)', '1.16.3', '34.1.0', 'minecraft', []],
    ['Forge 1.17.1', '1.17.1', '37.1.1', 'minecraft', []],
    ['Forge 1.18.2', '1.18.2', '40.2.0', 'minecraft', []],
    ['Forge 1.19.2', '1.19.2', '43.3.0', 'minecraft', ['1.19.1']],
    ['Forge 1.19.2', '1.19.2', '43.3.0', 'forge', ['42.0.9']],
    ['Forge 1.19.3', '1.19.3', '44.1.0', 'minecraft', []],
    ['Forge 1.19.4', '1.19.4', '45.1.0', 'forge', []],
    ['Forge 1.20.2', '1.20.2', '48.1.0', 'forge', []],
    ['Forge 1.20.4', '1.20.4', '49.0.0', 'forge', []],
    ['Forge 1.20.1 ≥ 47.2.16', '1.20.1', '47.2.16', 'forge', ['47.1.79']],
    ['Forge 1.20.1 47.2.20', '1.20.1', '47.2.20', 'forge', ['47.1.79']],
    ['Forge 1.20.1 before 47.2.16', '1.20.1', '47.2.15', 'forge', []],
    ['Forge 1.20.1, version unknown (benefit of the doubt)', '1.20.1', null, 'forge', ['47.1.79']],
    ['Forge 1.20.1 minecraft is strict', '1.20.1', '47.2.20', 'minecraft', []],
  ])('%s: %s also accepts %j', (_name, mc, version, dep, expected) => {
    expect(fmlFallbacks('forge', mc, dep, version)).toEqual([...expected]);
  });

  it.each<[string, string, string, Severity | null]>([
    ['All in One: [1.16.4] on Forge 36.2.39 / 1.16.5', '[1.16.4]', '1.16.5', 'info'],
    ['Create Above and Beyond: [1.16.3,1.16.5) on 1.16.5', '[1.16.3,1.16.5)', '1.16.5', 'info'],
    ['[1.16.2] on 1.16.5 → error', '[1.16.2]', '1.16.5', 'error'],
    ['[1.16.5] on 1.16.5 is fine', '[1.16.5]', '1.16.5', null],
    ['[1.19.1] on 1.19.2 → info', '[1.19.1]', '1.19.2', 'info'],
    ['[1.18.1] on Forge 1.18.2 → error (strict)', '[1.18.1]', '1.18.2', 'error'],
    ['[1.19.3] on Forge 1.19.4 → error (strict)', '[1.19.3]', '1.19.4', 'error'],
  ])('E-MC-RANGE: %s', (_name, mcRange, mc, expected) => {
    const j = forge({ file: 'mod.jar', mods: [{ id: 'mod', mc: mcRange }] });
    expect(only(run([j], pack('forge', mc, '36.2.39')), 'E-MC-RANGE').map((f) => f.severity)).toEqual(expected ? [expected] : []);
  });

  it.each<[string, string, string, string, Severity | null]>([
    ['forge [34.1.42] on 36.2.39 → info', '1.16.5', '36.2.39', '[34.1.42]', 'info'],
    ['forge [35.1.37,36) on 36.2.39 → info', '1.16.5', '36.2.39', '[35.1.37,36)', 'info'],
    ['forge [42.0.9] on 43.3.0 / 1.19.2 → info', '1.19.2', '43.3.0', '[42.0.9]', 'info'],
    ['Forge 47.2.20, forge [47.1.0,47.1.79] → info', '1.20.1', '47.2.20', '[47.1.0,47.1.79]', 'info'],
    ['Forge 47.2.0, forge [47.1.0,47.1.79] → error (no table before 47.2.16)', '1.20.1', '47.2.0', '[47.1.0,47.1.79]', 'error'],
    ['Forge 47.1.0 is simply inside [47.1.0,47.1.79]', '1.20.1', '47.1.0', '[47.1.0,47.1.79]', null],
    ['forge [47.3,) on 47.2.20 → error (47.1.79 is not in range either)', '1.20.1', '47.2.20', '[47.3,)', 'error'],
  ])('E-LOADER-RANGE: %s', (_name, mc, version, loaderDep, expected) => {
    const j = forge({ file: 'mod.jar', mods: [{ id: 'mod', loaderDep }] });
    expect(only(run([j], pack('forge', mc, version)), 'E-LOADER-RANGE').map((f) => f.severity)).toEqual(expected ? [expected] : []);
  });

  it('unknown Forge 1.20.1 version: the 47.1.79 fallback is assumed, and the wording says so', () => {
    const r = { syntax: 'maven' as const, raw: ['[47.1.0,47.1.79]'], unrepresentable: null };
    const v = evaluateRange('47.0.0', r, 'other', 'forge', { loader: 'forge', mc: '1.20.1', loaderVersion: null });
    expect(v).toMatchObject({ kind: 'fallback', fallback: '47.1.79', assumed: true });
    if (v.kind === 'fallback') expect(describeFallback(v, 'forge')).toContain('assumed: the override exists from Forge 47.2.16');
    const known = evaluateRange('47.0.0', r, 'other', 'forge', { loader: 'forge', mc: '1.20.1', loaderVersion: '47.2.20' });
    expect(known).toMatchObject({ kind: 'fallback', assumed: false });
    // In practice the range checks need a known loader version, so nothing is reported without one.
    const j = forge({ file: 'mod.jar', mods: [{ id: 'mod', loaderDep: '[47.1.0,47.1.79]' }] });
    expect(run([j], pack('forge', '1.20.1', null))).toEqual([]);
  });
});

describe('legacy FML (MC < 1.13) reads only mcmod.info', () => {
  const rl = pack('forge', '1.12.2', '14.23.5.2860');

  it('Parasites / RLCraft: a jar with a 1.13.2 mods.toml AND mcmod.info → no findings from the toml', () => {
    const srp = jar({
      file: 'SRParasites-1.12.2v1.10.2.jar',
      maxClassMajor: 52,
      mods: [
        { id: 'srparasites', loader: 'forge', mc: '[1.13.2]', loaderDep: '[25,)', deps: [{ id: 'notpresent', range: '[1,)' }] },
        { id: 'srparasites', loader: 'legacyforge', version: '1.10.2' },
      ],
    });
    expect(run([srp], rl)).toEqual([]);
  });

  it('a jar with only a 1.13+ mods.toml → E-WRONG-LOADER "made for Minecraft 1.13+"', () => {
    const modern = forge({ file: 'jei-1.16.5.jar', mods: [{ id: 'jei', mc: '[1.16.5]' }] });
    const found = run([modern], rl);
    expect(codes(found)).toEqual(['E-WRONG-LOADER']);
    expect(found[0]?.title).toBe('jei-1.16.5.jar is made for Minecraft 1.13+, but this pack runs 1.12.2');
  });

  it('mcmod.info mcversion is never enforced (FML does not read it)', () => {
    const old = jar({ file: 'old.jar', mods: [{ id: 'old', loader: 'legacyforge', mc: '[1.10.2]' }], maxClassMajor: 52 });
    expect(run([old], rl)).toEqual([]);
  });

  it('mcmod.info dependencies the scanner emits (useDependencyInformation) are still checked', () => {
    const m = jar({ file: 'm.jar', mods: [{ id: 'm', loader: 'legacyforge', deps: [{ id: 'baubles', range: '[1.5,)' }] }], maxClassMajor: 52 });
    expect(codes(run([m], rl))).toEqual(['E-MISSING-DEP']);
  });

  it('duplicate ids on legacy FML are an error', () => {
    const a = jar({ file: 'a.jar', mods: [{ id: 'x', loader: 'legacyforge', version: '1.0' }], maxClassMajor: 52 });
    const b = jar({ file: 'b.jar', mods: [{ id: 'x', loader: 'legacyforge', version: '2.0' }], maxClassMajor: 52 });
    expect(only(run([a, b], rl), 'E-DUP-ID').map((f) => f.severity)).toEqual(['error']);
  });
});

describe('Sinytra Connector', () => {
  const neo = pack('neoforge', '1.21.1', '21.1.235');
  const connector = (): JarRecord => neoforge({ file: 'connector-2.0.0-beta.jar', mods: [{ id: 'connector', mc: '[1.21.1]' }] });
  /** Forgified Fabric API: a native NeoForge mod with JarJar'd FFAPI modules. */
  const ffapi = (): JarRecord[] => {
    const top = neoforge({ file: 'forgified-fabric-api.jar', mods: [{ id: 'fabric_api', version: '0.104.0' }] });
    const base = nested(top, { file: 'fabric-api-base.jar', mods: [{ id: 'fabric_api_base', version: '0.4.42' }], jarjar: { group: 'org.sinytra', artifact: 'fabric-api-base', version: '0.4.42' } }, 'neoforge');
    return [top, base];
  };
  const fabricMod = (over: Partial<Parameters<typeof fabric>[0]> = {}): JarRecord =>
    fabric({ file: 'antarchy-fabric.jar', mods: [{ id: 'antarchy', mc: '>=1.21', loaderDep: '>=0.15', deps: [{ id: 'fabric-api' }] }], ...over });

  it('antarchy: a Fabric-only jar with Connector → no E-WRONG-LOADER (and no findings)', () => {
    expect(run([connector(), ...ffapi(), fabricMod()], neo)).toEqual([]);
  });

  it('without Connector the same jar stays an E-WRONG-LOADER error', () => {
    expect(codes(run([...ffapi(), fabricMod()], neo))).toEqual(['E-WRONG-LOADER']);
  });

  it('Forge 1.20.1 uses mod id connectormod', () => {
    const cm = forge({ file: 'connector-1.0.0-beta.jar', mods: [{ id: 'connectormod' }] });
    const f = fabric({ file: 'f.jar', mods: [{ id: 'f', mc: '~1.20.1' }] });
    expect(run([cm, f], pack('forge', '1.20.1', '47.3.0'))).toEqual([]);
    expect(codes(run([f], pack('forge', '1.20.1', '47.3.0')))).toEqual(['E-WRONG-LOADER']);
  });

  it('fabricloader dependencies are ignored; minecraft is checked strictly with Fabric semantics', () => {
    const old = fabricMod({ mods: [{ id: 'antarchy', mc: '1.21', loaderDep: '>=99' }] });
    const found = run([connector(), ...ffapi(), old], neo);
    // Fabric "1.21" is exact: 1.21.1 fails, and FML's 1.21 → 1.21.1 table does not apply.
    expect(found.map((f) => [f.code, f.severity])).toEqual([['E-MC-RANGE', 'error']]);
  });

  it('the upstream Fabric API jar (and its bundled modules) produce no findings', () => {
    const api = fabric({ file: 'fabric-api-0.102.0.jar', mods: [{ id: 'fabric-api', mc: '~1.21', deps: [{ id: 'nonexistent' }] }] });
    const mod = nested(api, { file: 'fabric-api-base.jar', mods: [{ id: 'fabric-api-base', loaderDep: '>=99' }] }, 'fabric');
    expect(run([connector(), ...ffapi(), api, mod], neo)).toEqual([]);
  });

  it('a Fabric jar duplicating a native mod id (with -/_ normalisation) is skipped: no E-DUP-ID, no wrong loader', () => {
    const native = neoforge({ file: 'my_mod-neoforge.jar', mods: [{ id: 'my_mod' }] });
    const dup = fabric({ file: 'my-mod-fabric.jar', mods: [{ id: 'my-mod', deps: [{ id: 'missing-thing' }] }] });
    expect(run([connector(), native, dup], neo)).toEqual([]);
  });

  it('mixinextras as a Fabric-only jar on 1.21.x is skipped', () => {
    const mx = fabric({ file: 'mixinextras-fabric.jar', mods: [{ id: 'mixinextras', loaderDep: '>=99' }] });
    expect(run([connector(), mx], neo)).toEqual([]);
  });

  it('x-y deps are satisfied by FFAPI x_y modules', () => {
    const m = fabricMod({ mods: [{ id: 'antarchy', deps: [{ id: 'fabric-api-base', range: '*' }] }] });
    expect(run([connector(), ...ffapi(), m], neo)).toEqual([]);
  });

  it('cloth-config2 / player-animator deps are widened to the aliased native ids', () => {
    const cloth = neoforge({ file: 'cloth-config-neoforge.jar', mods: [{ id: 'cloth_config', version: '15.0.140' }] });
    const anim = neoforge({ file: 'playeranimator.jar', mods: [{ id: 'playeranimator', version: '2.0.0' }] });
    const m = fabricMod({ mods: [{ id: 'antarchy', deps: [{ id: 'cloth-config2', range: '>=99' }, { id: 'player-animator', range: '>=99' }] }] });
    expect(run([connector(), cloth, anim, m], neo)).toEqual([]);
  });

  it('other depends and breaks stay errors', () => {
    const missing = fabricMod({ mods: [{ id: 'antarchy', deps: [{ id: 'owo-lib', range: '>=0.12' }] }] });
    expect(codes(run([connector(), missing], neo))).toEqual(['E-MISSING-DEP']);
    const target = neoforge({ file: 'sodium.jar', mods: [{ id: 'sodium', version: '0.6.0' }] });
    const breaker = fabricMod({ mods: [{ id: 'antarchy', deps: [{ id: 'sodium', kind: 'breaks', range: '*' }] }] });
    expect(only(run([connector(), target, breaker], neo), 'E-INCOMPAT').map((f) => f.severity)).toEqual(['error']);
    const clothBreak = fabricMod({ mods: [{ id: 'antarchy', deps: [{ id: 'cloth-config2', kind: 'breaks', range: '*' }] }] });
    const cloth = neoforge({ file: 'cloth.jar', mods: [{ id: 'cloth_config' }] });
    expect(only(run([connector(), cloth, clothBreak], neo), 'E-INCOMPAT')).toEqual([]);
  });

  it.each<[string, LoaderKind]>([
    ['Fabric pack', 'fabric'],
    ['Quilt pack', 'quilt'],
  ])('a connector jar on a %s does nothing special', (_name, loader) => {
    const c = neoforge({ file: 'connector.jar', mods: [{ id: 'connector' }] });
    expect(codes(run([c], pack(loader, '1.21.1')))).toEqual(['E-WRONG-LOADER']);
  });
});
