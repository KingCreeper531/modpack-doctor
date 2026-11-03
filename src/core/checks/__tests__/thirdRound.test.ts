/**
 * Third research round (docs/research/loader-enforcement.md): what each loader does with jars for
 * another loader and with metadata-less jars (`FMLModType`). One test per row of the table, plus
 * the Villager City case (Forge 1.20.4 with NeoForge-requiring Incendium / Nullscape / snuffles).
 */
import { describe, expect, it } from 'vitest';
import type { JarRecord, LoaderKind } from '../../../bindings';
import type { Severity } from '../../model';
import { fmlEra, fmlLoadsModType } from '../../pack';
import { fabric, forge, jar, neoforge, nested, only, pack, quilt, run } from './fixtures';

const fabricOnly = (): JarRecord => fabric({ file: 'sodium-fabric.jar', mods: [{ id: 'sodium' }] });
const plainLib = (fmlModType: string | null = null, over: Partial<Parameters<typeof jar>[0]> = {}): JarRecord => {
  const j = jar({ file: 'kotlin-stdlib.jar', packages: ['kotlin'], ...over });
  j.fmlModType = fmlModType;
  return j;
};
const severities = (jars: JarRecord[], loader: LoaderKind, mc: string | null): Severity[] =>
  only(run(jars, pack(loader, mc, null)), 'E-WRONG-LOADER').map((f) => f.severity);

describe('fmlEra / fmlLoadsModType', () => {
  it.each<[LoaderKind, string | null, string | null]>([
    ['forge', '1.12.2', 'legacy'],
    ['legacyforge', null, 'legacy'],
    ['forge', '1.16.5', 'silent'],
    ['forge', '1.20.1', 'silent'],
    ['forge', '1.20.4', 'silent'],
    ['forge', null, 'silent'],
    ['neoforge', '1.20.1', 'silent'],
    ['neoforge', '1.20.4', 'silent'],
    ['neoforge', '1.20.6', 'warn'],
    ['neoforge', '1.21.1', 'warn'],
    ['neoforge', '26.1', 'warn'],
    ['neoforge', null, 'warn'],
    ['fabric', '1.21.1', null],
  ])('%s %s → %s', (loader, mc, era) => {
    expect(fmlEra(loader, mc)).toBe(era);
  });

  it.each<[LoaderKind, string, boolean]>([
    ['neoforge', 'MOD', true],
    ['neoforge', 'GAMELIBRARY', true],
    ['neoforge', 'library', true],
    ['neoforge', 'LANGPROVIDER', false],
    ['forge', 'LANGPROVIDER', true],
    ['forge', 'PLUGIN', false],
  ])('%s FMLModType %s → loaded: %s', (loader, type, expected) => {
    expect(fmlLoadsModType(loader, type)).toBe(expected);
  });
});

describe('(a) Fabric-only jar on FML', () => {
  it.each<[string, LoaderKind, string, Severity[]]>([
    ['Forge 1.20.1 → info (ignored silently)', 'forge', '1.20.1', ['info']],
    ['Forge 1.18.2 → info', 'forge', '1.18.2', ['info']],
    ['NeoForge 1.20.4 → info', 'neoforge', '1.20.4', ['info']],
    ['NeoForge 1.20.6 → warning (brokenfile.fabric)', 'neoforge', '1.20.6', ['warning']],
    ['NeoForge 1.21.1 → warning', 'neoforge', '1.21.1', ['warning']],
    ['Forge 1.12.2 → nothing (classpath)', 'forge', '1.12.2', []],
  ])('%s', (_name, loader, mc, expected) => {
    expect(severities([fabricOnly()], loader, mc)).toEqual(expected);
  });

  it('NeoForge 1.21.1 wording names the warning screen and brokenfile.fabric', () => {
    const [f] = only(run([fabricOnly()], pack('neoforge', '1.21.1')), 'E-WRONG-LOADER');
    expect(f?.title).toBe('sodium-fabric.jar is a Fabric mod — skipped by NeoForge');
    expect(f?.explanation).toContain('"Warnings while loading mods" screen (brokenfile.fabric)');
  });
});

describe('(b) neoforge.mods.toml-only jar on Forge, (c) mods.toml-only jar on NeoForge ≥ 1.20.5', () => {
  it('(b) Forge 1.20.4 → info', () => {
    const j = neoforge({ file: 'neo-only.jar', mods: [{ id: 'neo', mc: '[1.20.4]' }] });
    expect(severities([j], 'forge', '1.20.4')).toEqual(['info']);
  });

  it('(c) NeoForge 1.20.6 / 1.21.1: a Forge mod (mods.toml) → warning brokenfile.minecraft_forge', () => {
    const j = forge({ file: 'forge-mod.jar', mods: [{ id: 'fm', mc: '[1.21.1]', loaderDep: '[52,)' }] });
    expect(severities([j], 'neoforge', '1.20.6')).toEqual(['warning']);
    const [f] = only(run([j], pack('neoforge', '1.21.1')), 'E-WRONG-LOADER');
    expect(f?.explanation).toContain('brokenfile.minecraft_forge');
  });

  it('Quilt-only jar on NeoForge 1.21.1 → warning brokenfile.quilt', () => {
    const j = quilt({ file: 'q.jar', mods: [{ id: 'q' }] });
    const [f] = only(run([j], pack('neoforge', '1.21.1')), 'E-WRONG-LOADER');
    expect(f?.severity).toBe('warning');
    expect(f?.explanation).toContain('brokenfile.quilt');
  });
});

describe('(d) a file the loader reads requires the other FML loader → error', () => {
  /**
   * Villager City (Forge 1.20.4), metadata as scanned from the real jars: Incendium and Nullscape
   * ship one mods.toml declaring BOTH `forge` and `neoforge` as optional (the scanner classifies
   * it NeoForge), so Forge reads it and loads them; snuffles requires `neoforge` [20.2,).
   */
  const multiOptional = (file: string, id: string): JarRecord =>
    jar({
      file,
      mods: [
        { id, loader: 'neoforge', modsToml: true, mc: '[1.20.4]', deps: [{ id: 'forge', kind: 'optional', range: '[49,)' }, { id: 'neoforge', kind: 'optional', range: '[20.4,)' }] },
        { id, loader: 'fabric', mc: '1.20.4', deps: [{ id: 'fabric-api-base' }] },
        { id, loader: 'quilt', mc: '1.20.4' },
      ],
    });
  const snuffles = (): JarRecord =>
    neoforge({ file: 'snuffles-1.1.0.jar', mods: [{ id: 'snuffles', modsToml: true, mc: '[1.20.2,1.21)', loaderDep: '[20.2,)' }] });

  it('Villager City: snuffles (requires neoforge) → error naming "neoforge"; Incendium / Nullscape (optional forge + neoforge) load', () => {
    const jars = [multiOptional('Incendium_1.20.4_v5.3.4.jar', 'incendium'), multiOptional('Nullscape_1.20.4_v1.2.4.jar', 'nullscape'), snuffles()];
    const found = only(run(jars, pack('forge', '1.20.4', '49.0.3')), 'E-WRONG-LOADER');
    expect(found.map((f) => [f.severity, f.title])).toEqual([['error', 'snuffles-1.1.0.jar requires NeoForge, but this pack runs Forge']]);
    expect(found[0]?.explanation).toContain('required dependency on "neoforge" ([20.2,))');
  });

  it('a mods.toml that requires neoforge on Forge 1.20.4 → error (even when it also has Fabric/Quilt metadata)', () => {
    const j = jar({
      file: 'multi.jar',
      mods: [
        { id: 'multi', loader: 'neoforge', modsToml: true, loaderDep: '[20.4,)' },
        { id: 'multi', loader: 'fabric' },
      ],
    });
    expect(severities([j], 'forge', '1.20.4')).toEqual(['error']);
  });

  it('NeoForge 1.20.4 reading a mods.toml with only an OPTIONAL forge dependency → loaded, no finding', () => {
    const j = forge({ file: 'flex.jar', mods: [{ id: 'flex', deps: [{ id: 'forge', kind: 'optional', range: '[49,)' }] }] });
    expect(severities([j], 'neoforge', '1.20.4')).toEqual([]);
  });

  it('NeoForge 1.20.4 reading a mods.toml that requires forge → error', () => {
    const j = forge({ file: 'forge-only.jar', mods: [{ id: 'fo', loaderDep: '[49,)' }] });
    expect(severities([j], 'neoforge', '1.20.4')).toEqual(['error']);
  });

  it('NeoForge 1.21.1: a neoforge.mods.toml requiring forge → error', () => {
    const j = neoforge({ file: 'odd.jar', mods: [{ id: 'odd', deps: [{ id: 'forge', range: '[1,)' }] }] });
    expect(severities([j], 'neoforge', '1.21.1')).toEqual(['error']);
  });

  it('1.20.1 stays compatible both ways (no finding)', () => {
    expect(severities([snuffles()], 'forge', '1.20.1')).toEqual([]);
  });
});

describe('(e) Forge/NeoForge jars on Fabric and Quilt', () => {
  it.each<[LoaderKind, string]>([
    ['fabric', 'ignored by Fabric Loader'],
    ['quilt', 'Quilt shows a blocking prompt'],
  ])('%s → warning (%s)', (loader, wording) => {
    const j = forge({ file: 'jei-forge.jar', mods: [{ id: 'jei' }] });
    const [f] = only(run([j], pack(loader, '1.20.1')), 'E-WRONG-LOADER');
    expect(f?.severity).toBe('warning');
    expect(f?.title).toContain(wording);
  });

  it('NeoForge jar on Fabric → warning', () => {
    expect(severities([neoforge({ file: 'n.jar', mods: [{ id: 'n' }] })], 'fabric', '1.21.1')).toEqual(['warning']);
  });
});

describe('metadata-less jars and FMLModType', () => {
  it.each<[string, LoaderKind, string, string | null, number]>([
    ['NeoForge 1.21.1, no FMLModType → one "not a mod file" warning', 'neoforge', '1.21.1', null, 1],
    ['NeoForge 1.21.1, LIBRARY → loaded, nothing', 'neoforge', '1.21.1', 'LIBRARY', 0],
    ['NeoForge 1.21.1, LANGPROVIDER → skipped as unknown → warning', 'neoforge', '1.21.1', 'LANGPROVIDER', 1],
    ['NeoForge 1.20.4, no FMLModType → ignored silently', 'neoforge', '1.20.4', null, 0],
    ['Forge 1.20.1, no FMLModType → ignored silently', 'forge', '1.20.1', null, 0],
    ['Forge 1.20.1, LANGPROVIDER → loaded', 'forge', '1.20.1', 'LANGPROVIDER', 0],
    ['Fabric → ignored', 'fabric', '1.21.1', null, 0],
    ['Quilt → no finding', 'quilt', '1.21.1', null, 0],
    ['Forge 1.12.2 → classpath', 'forge', '1.12.2', null, 0],
  ])('%s', (_name, loader, mc, type, expected) => {
    expect(only(run([plainLib(type)], pack(loader, mc)), 'E-WRONG-LOADER')).toHaveLength(expected);
  });

  it('the NeoForge warning lists every metadata-less jar once', () => {
    const a = plainLib(null, { file: 'a-lib.jar' });
    const b = plainLib(null, { file: 'b-lib.jar' });
    const found = only(run([a, b], pack('neoforge', '1.21.1')), 'E-WRONG-LOADER');
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ severity: 'warning', title: '2 jars in the mods folder are not a mod file' });
    expect(found[0]?.culprits.map((c) => c.fileName)).toEqual(['a-lib.jar', 'b-lib.jar']);
    expect(found[0]?.fixes).toHaveLength(2);
  });

  it('metadata-less jars FML skips feed neither E-SPLIT-PKG nor W-JAVA-CLASS', () => {
    const mod = forge({ file: 'mod.jar', mods: [{ id: 'mod' }], packages: ['kotlin'] });
    const skipped = plainLib(null, { maxClassMajor: 69 });
    expect(run([mod, skipped], pack('forge', '1.20.1', '47.3.0'))).toEqual([]);
    const loadedLib = plainLib('LIBRARY', { maxClassMajor: 69 });
    const found = run([mod, loadedLib], pack('forge', '1.20.1', '47.3.0'));
    expect(found.map((f) => f.code).sort()).toEqual(['E-SPLIT-PKG', 'W-JAVA-CLASS']);
  });

  it('nested metadata-less JarJar jars ARE loaded: a bundled library sharing a package with another mod → I-SPLIT-PKG (info)', () => {
    const host = forge({ file: 'host.jar', mods: [{ id: 'host' }] });
    const lib = nested(host, { file: 'guava-fork.jar', packages: ['com.google.common.base'], jarjar: { group: 'x', artifact: 'guava-fork', version: '1.0' } });
    const other = forge({ file: 'other.jar', mods: [{ id: 'other' }], packages: ['com.google.common.base'] });
    const found = run([host, lib, other], pack('forge', '1.20.1', '47.3.0'));
    expect(only(found, 'E-SPLIT-PKG')).toEqual([]);
    const [f] = only(found, 'I-SPLIT-PKG');
    expect(f?.culprits.map((c) => c.jarId)).toEqual([host.id, other.id]);
    expect(f?.evidence.some((e) => e.kind === 'note' && e.text.includes('via bundled META-INF/jarjar/guava-fork.jar'))).toBe(true);
  });

  it('FML never opens Fabric `jars` entries: a Fabric JiJ copy inside a multi-loader jar is not loaded', () => {
    const host = jar({ file: 'BadOptimizations.jar', mods: [{ id: 'badoptimizations', loader: 'neoforge' }, { id: 'badoptimizations', loader: 'fabric' }] });
    const jij = nested(host, { file: 'fabric-mixinextras.jar', mods: [{ id: 'mixinextras' }], packages: ['com.llamalad7.mixinextras'] }, 'fabric');
    const other = neoforge({ file: 'other.jar', mods: [{ id: 'other' }], packages: ['com.llamalad7.mixinextras'] });
    const found = run([host, jij, other], pack('neoforge', '1.21.1', '21.1.235'));
    expect(found.filter((f) => f.code === 'E-SPLIT-PKG' || f.code === 'I-SPLIT-PKG')).toEqual([]);
  });

  it('copies of one library under different JarJar groups (relocated coordinates) or sharing a mod id count once', () => {
    const a = forge({ file: 'a.jar', mods: [{ id: 'a' }] });
    const b = forge({ file: 'b.jar', mods: [{ id: 'b' }] });
    const la = nested(a, { file: 'mx-0.2.jar', mods: [{ id: 'mixinextras', version: '0.2.0' }], packages: ['com.llamalad7.mixinextras'], jarjar: { group: 'com.github.llamalad7.mixinextras', artifact: 'mixinextras-forge', version: '0.2.0' } });
    const lb = nested(b, { file: 'mx-0.5.jar', packages: ['com.llamalad7.mixinextras'], jarjar: { group: 'io.github.llamalad7', artifact: 'mixinextras-forge', version: '0.5.0' } });
    const found = run([a, b, la, lb], pack('forge', '1.20.1', '47.3.0'));
    expect(found.filter((f) => f.code === 'E-SPLIT-PKG' || f.code === 'I-SPLIT-PKG')).toEqual([]);
  });

  it('two mods bundling the same JarJar library share one copy → no split', () => {
    const a = forge({ file: 'a.jar', mods: [{ id: 'a' }] });
    const b = forge({ file: 'b.jar', mods: [{ id: 'b' }] });
    const la = nested(a, { file: 'lib.jar', packages: ['org.lib'], jarjar: { group: 'org', artifact: 'lib', version: '1.0' } });
    const lb = nested(b, { file: 'lib.jar', packages: ['org.lib'], jarjar: { group: 'org', artifact: 'lib', version: '1.1' } });
    expect(only(run([a, b, la, lb], pack('forge', '1.20.1')), 'E-SPLIT-PKG')).toEqual([]);
  });
});
