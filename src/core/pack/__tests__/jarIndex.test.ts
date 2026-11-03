import { describe, expect, it } from 'vitest';
import type { JarRecord } from '../../../bindings';
import { fabric, forge, jar, nested, scan } from '../../checks/__tests__/fixtures';
import { buildJarIndex } from '../index';

const ids = (list: readonly JarRecord[] | undefined): string[] => (list ?? []).map((j) => j.id);

describe('buildJarIndex', () => {
  const api = fabric({ file: 'fabric-api.jar', mods: [{ id: 'fabric-api', provides: ['fabric'] }], packages: ['net.fabricmc.fabric.impl'] });
  const apiModule = nested(api, { file: 'fabric-api-base.jar', mods: [{ id: 'fabric-api-base' }], packages: ['net.fabricmc.fabric.api.base'] }, 'fabric');
  const create = forge({ file: 'create.jar', mods: [{ id: 'create' }], packages: ['com.simibubi.create'] });
  const flywheel = nested(create, {
    file: 'flywheel.jar',
    mods: [{ id: 'flywheel' }],
    packages: ['dev.engine_room.flywheel'],
    jarjar: { group: 'dev.engine-room.flywheel', artifact: 'flywheel-forge', range: '[1.0,2.0)', version: '1.0.1' },
  });
  const off = forge({ file: 'off.jar', disabled: true, mods: [{ id: 'off' }], packages: ['com.off'] });
  const offChild = nested(off, { file: 'offlib.jar', mods: [{ id: 'offlib' }], packages: ['com.offlib'], jarjar: { group: 'g', artifact: 'offlib' } });
  const broken = forge({ file: 'broken.jar', status: { state: 'corrupt', reason: 'not a valid jar (zip) file' } });
  const halfBroken = forge({ file: 'half.jar', mods: [{ id: 'half' }], status: { state: 'corrupt', reason: 'fabric.mod.json: bad' } });
  const unreadable = forge({ file: 'locked.jar', status: { state: 'unreadable', reason: 'permission denied' } });
  const mixin = jar({ file: 'mixins.jar', mods: [{ id: 'mx' }] });
  mixin.mixinConfigs = ['mx.mixins.json'];
  const index = buildJarIndex(scan(create, flywheel, api, apiModule, off, offChild, broken, halfBroken, unreadable, mixin));

  it('byId holds only active jars (disabled, their children, unreadable and metadata-less corrupt jars are out)', () => {
    expect([...index.byId.keys()].sort()).toEqual(
      [api.id, apiModule.id, create.id, flywheel.id, halfBroken.id, mixin.id].sort(),
    );
  });

  it('byModId covers mod ids, provides and nested jars, top-level first', () => {
    expect(ids(index.byModId.get('fabric'))).toEqual([api.id]);
    expect(ids(index.byModId.get('flywheel'))).toEqual([flywheel.id]);
    expect(ids(index.byModId.get('fabric-api-base'))).toEqual([apiModule.id]);
    expect(index.byModId.has('off')).toBe(false);
    expect(index.byModId.has('offlib')).toBe(false);
  });

  it('a jar declaring an id twice (Forge + NeoForge metadata) is listed once', () => {
    const both = jar({ file: 'both.jar', mods: [{ id: 'x', loader: 'forge' }, { id: 'x', loader: 'neoforge' }] });
    expect(ids(buildJarIndex(scan(both)).byModId.get('x'))).toEqual([both.id]);
  });

  it('byPackage is top-level own classes only; byPackageAnyDepth includes nested jars', () => {
    expect(ids(index.byPackage.get('com.simibubi.create'))).toEqual([create.id]);
    expect(index.byPackage.has('dev.engine_room.flywheel')).toBe(false);
    expect(ids(index.byPackageAnyDepth.get('dev.engine_room.flywheel'))).toEqual([flywheel.id]);
    expect(index.byPackageAnyDepth.has('com.off')).toBe(false);
  });

  it('two parents nesting the same library both appear in byPackageAnyDepth only', () => {
    const a = forge({ file: 'a.jar', mods: [{ id: 'a' }] });
    const b = forge({ file: 'b.jar', mods: [{ id: 'b' }] });
    const la = nested(a, { file: 'lib.jar', packages: ['org.lib'], jarjar: { group: 'org', artifact: 'lib' } });
    const lb = nested(b, { file: 'lib.jar', packages: ['org.lib'], jarjar: { group: 'org', artifact: 'lib' } });
    const idx = buildJarIndex(scan(a, b, la, lb));
    expect(idx.byPackage.has('org.lib')).toBe(false);
    expect(ids(idx.byPackageAnyDepth.get('org.lib'))).toEqual([la.id, lb.id]);
  });

  it('byMixinConfig maps config names to jars', () => {
    expect(ids(index.byMixinConfig.get('mx.mixins.json'))).toEqual([mixin.id]);
  });

  it('byFileName: top-level only, disabled jars under their .disabled name', () => {
    expect(index.byFileName.get('create.jar')?.id).toBe(create.id);
    expect(index.byFileName.get('off.jar.disabled')?.id).toBe(off.id);
    expect(index.byFileName.has('flywheel.jar')).toBe(false);
  });

  it('is independent of scan order', () => {
    const shuffled = buildJarIndex(scan(mixin, apiModule, unreadable, halfBroken, broken, offChild, off, api, flywheel, create));
    expect([...shuffled.byId.keys()]).toEqual([...index.byId.keys()]);
    expect(ids(shuffled.byModId.get('fabric'))).toEqual(ids(index.byModId.get('fabric')));
  });
});
