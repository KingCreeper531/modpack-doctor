import { describe, expect, it } from 'vitest';
import type { JarRecord, LoaderKind } from '../../../bindings';
import { fabric, forge, highlighted, jar, neoforge, notes, only, pack, quilt, run } from './fixtures';

const sodium = fabric({ file: 'sodium-fabric-0.5.8.jar', mods: [{ id: 'sodium', name: 'Sodium', mc: '~1.20.1' }] });
const jei = forge({ file: 'jei-1.20.1-forge.jar', mods: [{ id: 'jei', name: 'JEI', mc: '[1.20.1,1.20.2)', loaderDep: '[47,)' }] });
const neoMods = neoforge({ file: 'neo-mod-1.20.1.jar', mods: [{ id: 'neomod', modsToml: true, mc: '[1.20.1]', loaderDep: '[47.1,)' }] });
const neoNew = neoforge({ file: 'neo-mod-1.21.1.jar', mods: [{ id: 'neonew', mc: '[1.21.1]', loaderDep: '[21.1,)' }] });
const forgeNoLoaderDep = forge({ file: 'lib-1.20.4.jar', mods: [{ id: 'plainlib', mc: '[1.20.4]' }] });
const quiltMod = quilt({ file: 'quilt-only.jar', mods: [{ id: 'qonly' }] });
const multi = jar({ file: 'architectury-mod.jar', mods: [{ id: 'arch', loader: 'fabric' }, { id: 'arch', loader: 'forge' }] });
const legacy = jar({ file: 'old-mod-1.12.2.jar', mods: [{ id: 'oldmod', loader: 'legacyforge' }] });
const library = jar({ file: 'kotlin-stdlib.jar', packages: ['kotlin'] });

describe('E-WRONG-LOADER', () => {
  it.each<[string, JarRecord, LoaderKind, string, boolean]>([
    ['Fabric mod on Forge', sodium, 'forge', '1.20.1', true],
    ['Forge mod on Fabric', jei, 'fabric', '1.20.1', true],
    ['Fabric mod on Quilt is fine', sodium, 'quilt', '1.20.1', false],
    ['Quilt mod on Fabric', quiltMod, 'fabric', '1.20.1', true],
    ['Forge mod on NeoForge 1.20.1 is fine', jei, 'neoforge', '1.20.1', false],
    ['NeoForge (mods.toml + neoforge dep) mod on Forge 1.20.1 is fine', neoMods, 'forge', '1.20.1', false],
    ['NeoForge mod on Forge 1.21.1', neoNew, 'forge', '1.21.1', true],
    ['Forge mod (with forge dep) on NeoForge 1.21.1', jei, 'neoforge', '1.21.1', true],
    ['Forge-classified mods.toml without a loader dep on NeoForge 1.20.4 is fine', forgeNoLoaderDep, 'neoforge', '1.20.4', false],
    ['…but not on NeoForge 1.21.1 (neoforge.mods.toml era)', forgeNoLoaderDep, 'neoforge', '1.21.1', true],
    ['multi-loader jar matches either loader (Fabric)', multi, 'fabric', '1.20.1', false],
    ['multi-loader jar matches either loader (Forge)', multi, 'forge', '1.20.1', false],
    ['multi-loader jar on Quilt via its Fabric entry', multi, 'quilt', '1.20.1', false],
    ['multi-loader jar on NeoForge 1.21.1 matches neither', multi, 'neoforge', '1.21.1', true],
    ['legacy mcmod.info mod on Forge 1.20.1', legacy, 'forge', '1.20.1', true],
    ['legacy mcmod.info mod on Forge 1.12.2 is fine', legacy, 'forge', '1.12.2', false],
    ['plain library jar is never reported', library, 'fabric', '1.20.1', false],
  ])('%s', (_name, j, loader, mc, expected) => {
    expect(only(run([j], pack(loader, mc)), 'E-WRONG-LOADER')).toHaveLength(expected ? 1 : 0);
  });

  it('is skipped when the pack loader is unknown or vanilla', () => {
    expect(only(run([sodium], pack(null, '1.20.1')), 'E-WRONG-LOADER')).toEqual([]);
    expect(only(run([sodium], pack('unknown', '1.20.1')), 'E-WRONG-LOADER')).toEqual([]);
  });

  it('with an unknown MC version, MC-dependent cases are not reported', () => {
    expect(only(run([neoMods], pack('forge', null)), 'E-WRONG-LOADER')).toEqual([]);
    // …but Forge never reads neoforge.mods.toml, whatever the MC version.
    expect(only(run([neoNew], pack('forge', null)), 'E-WRONG-LOADER')).toHaveLength(1);
    expect(only(run([jei], pack('neoforge', null)), 'E-WRONG-LOADER')).toEqual([]);
    expect(only(run([sodium], pack('forge', null)), 'E-WRONG-LOADER')).toHaveLength(1);
  });

  it('describes the jar, offers disable, and shows metadata + pack evidence', () => {
    const [f] = only(run([sodium], pack('forge', '1.20.1', '47.3.0')), 'E-WRONG-LOADER');
    expect(f).toMatchObject({
      severity: 'error',
      title: 'sodium-fabric-0.5.8.jar is a Fabric mod, but this pack runs Forge',
      culprits: [{ jarId: 'mods/sodium-fabric-0.5.8.jar', fileName: 'sodium-fabric-0.5.8.jar', modId: 'sodium' }],
      fixes: [{ kind: 'disable', jarId: 'mods/sodium-fabric-0.5.8.jar' }],
    });
    expect(highlighted(f)).toEqual(['"id": "sodium",']);
    expect(notes(f)).toContain('Pack: Forge 47.3.0 on Minecraft 1.20.1 (from launcher metadata)');
  });

  it('disabled jars are not reported', () => {
    const off = fabric({ file: 'sodium.jar', disabled: true, mods: [{ id: 'sodium' }] });
    expect(only(run([off], pack('forge', '1.20.1')), 'E-WRONG-LOADER')).toEqual([]);
  });
});
