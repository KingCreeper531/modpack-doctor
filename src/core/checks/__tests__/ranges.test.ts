import { describe, expect, it } from 'vitest';
import type { JarRecord, LoaderKind } from '../../../bindings';
import { versionApi } from '../../version';
import { fabric, forge, highlighted, jar, neoforge, nested, only, pack, quilt, run } from './fixtures';

describe('E-MC-RANGE', () => {
  it.each<[string, LoaderKind, string | string[], string, boolean]>([
    // Maven (Forge / NeoForge)
    ['Maven open range [1.20,) on 1.20.1', 'forge', '[1.20,)', '1.20.1', false],
    ['Maven [1.20,1.20.2) includes 1.20.1', 'forge', '[1.20,1.20.2)', '1.20.1', false],
    ['Maven [1.20,1.20.2) excludes 1.20.2', 'forge', '[1.20,1.20.2)', '1.20.2', true],
    ['Maven exact [1.20.1] excludes 1.20.4', 'forge', '[1.20.1]', '1.20.4', true],
    ['Maven soft "1.19.2" matches anything (FML soft requirement)', 'forge', '1.19.2', '1.20.1', false],
    ['Maven union [1.20.1],[1.20.4] includes 1.20.4', 'neoforge', '[1.20.1],[1.20.4]', '1.20.4', false],
    ['Maven: 1.21-pre1 is above 1.21 (FML order), outside [1.20,1.21)', 'neoforge', '[1.20,1.21)', '1.21-pre1', true],
    // Fabric / Quilt predicates
    ['Fabric ~1.20.1 on 1.20.1', 'fabric', '~1.20.1', '1.20.1', false],
    ['Fabric ~1.20.1 on 1.21', 'fabric', '~1.20.1', '1.21', true],
    ['Fabric >=1.20 <1.21 AND-group on 1.20.6', 'fabric', '>=1.20 <1.21', '1.20.6', false],
    ['Fabric array OR: ["1.20.1","1.20.4"] on 1.20.4', 'fabric', ['1.20.1', '1.20.4'], '1.20.4', false],
    ['Fabric array OR: ["1.20.1","1.20.4"] on 1.20.2', 'fabric', ['1.20.1', '1.20.4'], '1.20.2', true],
    ['Fabric 1.21.x admits the pre-release 1.21-pre1', 'fabric', '1.21.x', '1.21-pre1', false],
    ['Fabric 1.21.x excludes 1.22', 'fabric', '1.21.x', '1.20.6', true],
    ['Fabric * matches everything', 'fabric', '*', '26.1', false],
    ['Quilt >=1.20.2 on 1.20.1', 'quilt', '>=1.20.2', '1.20.1', true],
    ['year-based MC 26.1 inside >=1.21', 'fabric', '>=1.21', '26.1', false],
  ])('%s', (_name, loader, mc, packMc, expected) => {
    const j = jar({ file: 'mod.jar', mods: [{ id: 'mod', loader, mc }] });
    expect(only(run([j], pack(loader, packMc)), 'E-MC-RANGE')).toHaveLength(expected ? 1 : 0);
  });

  it('unknown pack MC, unparseable or unrepresentable ranges → no finding', () => {
    const j = fabric({ file: 'a.jar', mods: [{ id: 'a', mc: '~1.20.1' }] });
    expect(only(run([j], pack('fabric', null)), 'E-MC-RANGE')).toEqual([]);
    const bad = forge({ file: 'b.jar', mods: [{ id: 'b', mc: '[1.20' }] });
    const badRange = bad.mods[0]?.mcRange;
    expect(badRange && versionApi.satisfies('1.21', badRange, 'minecraft')).toBeNull();
    expect(only(run([bad], pack('forge', '1.21')), 'E-MC-RANGE')).toEqual([]);
    const weird = fabric({ file: 'c.jar', mods: [{ id: 'c', mc: '~1.20.1' }] });
    const m = weird.mods[0];
    if (m?.mcRange) m.mcRange = { syntax: 'fabric', raw: [], unrepresentable: '{"any":[...]}' };
    expect(only(run([weird], pack('fabric', '1.21')), 'E-MC-RANGE')).toEqual([]);
  });

  it('wording, culprit, evidence lines (Fabric)', () => {
    const j = fabric({ file: 'sodium-0.5.8.jar', mods: [{ id: 'sodium', name: 'Sodium', mc: '~1.20.1', deps: [{ id: 'fabric-api' }] }] });
    const api = fabric({ file: 'fabric-api.jar', mods: [{ id: 'fabric-api' }] });
    const [f] = only(run([j, api], pack('fabric', '1.21.1', '0.16.5')), 'E-MC-RANGE');
    expect(f?.title).toMatch(/^Sodium is made for Minecraft .*1\.20\.1.*, not 1\.21\.1$/);
    expect(f?.culprits).toEqual([{ jarId: 'mods/sodium-0.5.8.jar', fileName: 'sodium-0.5.8.jar', modId: 'sodium' }]);
    expect(highlighted(f)).toEqual(['"minecraft": "~1.20.1",']);
    expect(f?.fixes[0]).toEqual({ kind: 'disable', jarId: 'mods/sodium-0.5.8.jar' });
    expect(f?.fixes[1]?.kind).toBe('manual');
  });

  it('evidence lines (mods.toml): the modId line and its versionRange', () => {
    const j = forge({ file: 'jei.jar', mods: [{ id: 'jei', mc: '[1.20.1,1.20.2)', loaderDep: '[47,)' }] });
    const [f] = only(run([j], pack('forge', '1.21.1', '51.0.0')), 'E-MC-RANGE');
    expect(highlighted(f)).toEqual(['modId="minecraft"', 'versionRange="[1.20.1,1.20.2)"']);
  });

  it('only entries the pack loader reads are checked (multi-loader jar)', () => {
    const multi = jar({ file: 'multi.jar', mods: [{ id: 'm', loader: 'fabric', mc: '~1.21' }, { id: 'm', loader: 'forge', mc: '[1.20.1]' }] });
    expect(only(run([multi], pack('fabric', '1.21')), 'E-MC-RANGE')).toEqual([]);
    expect(only(run([multi], pack('forge', '1.21')), 'E-MC-RANGE')).toHaveLength(1);
  });

  it('bundled mods are checked and reported against the top-level jar', () => {
    const parent = fabric({ file: 'bundle.jar', mods: [{ id: 'bundle', mc: '>=1.20' }] });
    const child = nested(parent, { file: 'inner.jar', mods: [{ id: 'inner', mc: '~1.20.1' }] }, 'fabric');
    const [f] = only(run([parent, child], pack('fabric', '1.21')), 'E-MC-RANGE');
    expect(f?.culprits).toEqual([{ jarId: parent.id, fileName: 'bundle.jar', modId: 'inner' }]);
    expect(f?.evidence[0]).toMatchObject({ kind: 'metadata', jarId: child.id });
    expect(f?.explanation).toContain('bundled inside bundle.jar');
  });
});

describe('E-LOADER-RANGE', () => {
  it.each<[string, JarRecord, LoaderKind, string, string | null, boolean]>([
    ['Forge [47,) on 47.3.0', forge({ file: 'a.jar', mods: [{ id: 'a', loaderDep: '[47,)' }] }), 'forge', '1.20.1', '47.3.0', false],
    ['Forge [47.2,) on 47.1.0', forge({ file: 'a.jar', mods: [{ id: 'a', loaderDep: '[47.2,)' }] }), 'forge', '1.20.1', '47.1.0', true],
    ['Forge soft 47.1.0 matches anything', forge({ file: 'a.jar', mods: [{ id: 'a', loaderDep: '47.1.0' }] }), 'forge', '1.20.1', '40.0.0', false],
    ['NeoForge [21.1.50,) on 21.1.77', neoforge({ file: 'a.jar', mods: [{ id: 'a', loaderDep: '[21.1.50,)' }] }), 'neoforge', '1.21.1', '21.1.77', false],
    ['NeoForge [21.1.80,) on 21.1.77', neoforge({ file: 'a.jar', mods: [{ id: 'a', loaderDep: '[21.1.80,)' }] }), 'neoforge', '1.21.1', '21.1.77', true],
    ['Fabric >=0.15 on 0.14.21', fabric({ file: 'a.jar', mods: [{ id: 'a', loaderDep: '>=0.15' }] }), 'fabric', '1.20.1', '0.14.21', true],
    ['Fabric >=0.15 on 0.16.5', fabric({ file: 'a.jar', mods: [{ id: 'a', loaderDep: '>=0.15' }] }), 'fabric', '1.20.1', '0.16.5', false],
    ['Quilt >=0.20 on 0.19.0', quilt({ file: 'a.jar', mods: [{ id: 'a', loaderDep: '>=0.20' }] }), 'quilt', '1.20.1', '0.19.0', true],
    ['unknown loader version → no finding', fabric({ file: 'a.jar', mods: [{ id: 'a', loaderDep: '>=0.15' }] }), 'fabric', '1.20.1', null, false],
    ['Fabric mod on Quilt: fabricloader range is not compared with the Quilt version', fabric({ file: 'a.jar', mods: [{ id: 'a', loaderDep: '>=0.15' }] }), 'quilt', '1.20.1', '0.26.0', false],
    ['Forge mod on NeoForge 1.20.1: forge range not compared', forge({ file: 'a.jar', mods: [{ id: 'a', loaderDep: '[47.2,)' }] }), 'neoforge', '1.20.1', '47.1.106', false],
  ])('%s', (_name, j, loader, mc, version, expected) => {
    expect(only(run([j], pack(loader, mc, version)), 'E-LOADER-RANGE')).toHaveLength(expected ? 1 : 0);
  });

  it('never compares languageRange (loaderVersion) with the loader version', () => {
    const j = neoforge({ file: 'a.jar', mods: [{ id: 'a' }] });
    // languageRange is [4,) — NeoForge 21.1.77 would satisfy it anyway; make it fail on purpose.
    const m = j.mods[0];
    if (m) m.languageRange = { syntax: 'maven', raw: ['[99,)'], unrepresentable: null };
    expect(only(run([j], pack('neoforge', '1.21.1', '21.1.77')), 'E-LOADER-RANGE')).toEqual([]);
  });

  it('highlights the loader dependency and suggests changing the loader first', () => {
    const j = forge({ file: 'create.jar', mods: [{ id: 'create', name: 'Create', mc: '[1.20.1]', loaderDep: '[47.2,)' }] });
    const [f] = only(run([j], pack('forge', '1.20.1', '47.1.0')), 'E-LOADER-RANGE');
    expect(f?.title).toMatch(/^Create needs Forge .*47\.2.*, but the pack has 47\.1\.0$/);
    expect(highlighted(f)).toEqual(['modId="forge"', 'versionRange="[47.2,)"']);
    expect(f?.fixes.map((x) => x.kind)).toEqual(['manual', 'disable']);
  });
});
