/**
 * Which metadata file the pack's loader reads (pack/loaders.ts `metadataFilesRead`), and how
 * that drives relevance and W-CORRUPT-JAR. Mirrors real jars from the owner's NeoForge 21.1.235 /
 * MC 1.21.1 pack that ship a stale or broken META-INF/mods.toml next to neoforge.mods.toml.
 */
import { describe, expect, it } from 'vitest';
import type { JarRecord, LoaderKind } from '../../../bindings';
import { metadataFilesRead } from '../../pack';
import { codes, fabric, forge, jar, neoforge, only, pack, quilt, run } from './fixtures';

const NEO = 'META-INF/neoforge.mods.toml';
const MODS = 'META-INF/mods.toml';

describe('metadataFilesRead', () => {
  it.each<[LoaderKind, string | null, string[], string[] | null]>([
    ['neoforge', '1.20.4', [NEO, MODS], [MODS]],
    ['neoforge', '1.20.5', [NEO, MODS], [NEO]],
    ['neoforge', '1.21.1', [NEO, MODS], [NEO]],
    ['neoforge', '26.1', [NEO, MODS], [NEO]],
    ['neoforge', '1.20.1', [NEO, MODS], [MODS]],
    ['neoforge', null, [NEO, MODS], [NEO, MODS]],
    ['forge', '1.20.1', [NEO, MODS, 'mcmod.info'], [MODS]],
    ['forge', '1.12.2', [MODS, 'mcmod.info'], ['mcmod.info']],
    ['forge', '1.7.10', [MODS, 'mcmod.info'], ['mcmod.info']],
    ['legacyforge', '1.12.2', [MODS, 'mcmod.info'], ['mcmod.info']],
    ['legacyforge', null, [MODS, 'mcmod.info'], ['mcmod.info']],
    ['forge', null, [NEO, MODS], [MODS, 'mcmod.info']],
    ['fabric', '1.21.1', ['fabric.mod.json', 'quilt.mod.json'], ['fabric.mod.json']],
    ['quilt', '1.21.1', ['fabric.mod.json', 'quilt.mod.json'], ['quilt.mod.json']],
    ['quilt', '1.21.1', ['fabric.mod.json'], ['fabric.mod.json']],
    ['unknown', '1.21.1', [NEO], null],
  ])('%s on %s with %j → %j', (loader, mc, present, expected) => {
    const read = metadataFilesRead(loader, mc, present);
    expect(read === null ? null : [...read].sort()).toEqual(expected === null ? null : [...expected].sort());
  });
});

/** create-stuff-additions1.21.1_v2.1.4a.jar: stale mods.toml for 1.20.4 + real neoforge.mods.toml. */
function createStuffAdditions(): JarRecord {
  return jar({
    file: 'create-stuff-additions1.21.1_v2.1.4a.jar',
    mods: [
      { id: 'create_sa', loader: 'neoforge', version: '2.1.4a', mc: '[1.21.1]', loaderDep: '[21.1,)' },
      { id: 'create_sa', loader: 'neoforge', modsToml: true, version: '2.1.4a', mc: '[1.20.4]', loaderDep: '[20.4,)' },
    ],
  });
}

/** create_radar / numismaticsutils: broken mods.toml next to a valid neoforge.mods.toml. */
function brokenLeftover(file: string, id: string): JarRecord {
  return jar({
    file,
    mods: [{ id, loader: 'neoforge', mc: '[1.21.1]', loaderDep: '[21.1,)' }],
    metadataErrors: [{ file: MODS, reason: 'invalid TOML: expected `=`, found newline at line 3' }],
  });
}

describe('real-pack jars on NeoForge 21.1.235 / MC 1.21.1', () => {
  const p = pack('neoforge', '1.21.1', '21.1.235');

  it('create-stuff-additions: the stale mods.toml [1.20.4] entry is ignored → no findings', () => {
    expect(run([createStuffAdditions()], p)).toEqual([]);
  });

  it.each([
    ['create_radar-0.4.jar', 'create_radar'],
    ['numismaticsutils-1.0.jar', 'numismaticsutils'],
  ])('%s: a broken mods.toml next to neoforge.mods.toml is not W-CORRUPT-JAR', (file, id) => {
    expect(run([brokenLeftover(file, id)], p)).toEqual([]);
  });

  it('a broken neoforge.mods.toml IS reported, with the file and reason', () => {
    const j = jar({
      file: 'bad.jar',
      mods: [{ id: 'bad', loader: 'neoforge', modsToml: true }],
      metadataErrors: [{ file: NEO, reason: 'invalid TOML: duplicate key `modId`' }],
    });
    const found = run([j], p);
    expect(codes(found)).toEqual(['W-CORRUPT-JAR']); // no E-WRONG-LOADER on top of it
    expect(found[0]).toMatchObject({
      severity: 'warning',
      title: "META-INF/neoforge.mods.toml inside bad.jar can't be read: invalid TOML: duplicate key `modId`",
      culprits: [{ jarId: 'mods/bad.jar', fileName: 'bad.jar' }],
    });
    expect(found[0]?.fixes[0]?.kind).toBe('manual');
  });
});

describe('version boundaries for the stale-mods.toml jar', () => {
  it.each<[string, string | null, string[]]>([
    // On 1.20.4 NeoForge reads mods.toml: the [1.20.4] entry is the live one, [1.21.1] is ignored.
    ['NeoForge 1.20.4', '1.20.4', []],
    // From 1.20.5 only neoforge.mods.toml counts: [1.21.1] on 1.20.5 fails.
    ['NeoForge 1.20.5', '1.20.5', ['E-MC-RANGE']],
    ['NeoForge 1.21.1', '1.21.1', []],
    ['NeoForge 26.1', '26.1', ['E-MC-RANGE']],
    // Unknown MC: both files count, but there is nothing to compare against.
    ['NeoForge, unknown MC', null, []],
  ])('%s → %j', (_name, mc, expected) => {
    expect(codes(run([createStuffAdditions()], pack('neoforge', mc, null)))).toEqual(expected);
  });

  it('NeoForge 1.20.4 with only neoforge.mods.toml → wrong file, reported as E-WRONG-LOADER', () => {
    const j = neoforge({ file: 'future.jar', mods: [{ id: 'future', mc: '[1.21.1]' }] });
    const [f] = only(run([j], pack('neoforge', '1.20.4')), 'E-WRONG-LOADER');
    expect(f?.title).toBe('future.jar only has META-INF/neoforge.mods.toml, which NeoForge on 1.20.4 does not read');
  });

  it('NeoForge 1.21.1 with only a mods.toml (neoforge dep) → wrong file', () => {
    const j = neoforge({ file: 'old.jar', mods: [{ id: 'old', modsToml: true, mc: '[1.20.4]' }] });
    const found = run([j], pack('neoforge', '1.21.1'));
    expect(codes(found)).toEqual(['E-WRONG-LOADER']);
    expect(found[0]?.title).toBe('old.jar only has META-INF/mods.toml, which NeoForge on 1.21.1 does not read');
  });

  it('Forge 1.20.1 reads mods.toml: a broken neoforge.mods.toml is ignored, a broken mods.toml is not', () => {
    const p = pack('forge', '1.20.1', '47.3.0');
    const ignored = forge({ file: 'a.jar', mods: [{ id: 'a', mc: '[1.20.1]' }], metadataErrors: [{ file: NEO, reason: 'x' }] });
    expect(run([ignored], p)).toEqual([]);
    const live = neoforge({ file: 'b.jar', mods: [{ id: 'b', mc: '[1.21.1]' }], metadataErrors: [{ file: MODS, reason: 'bad toml' }] });
    expect(codes(run([live], p))).toEqual(['W-CORRUPT-JAR']);
  });

  it('Forge never reads neoforge.mods.toml entries (dup ids and ranges ignore them)', () => {
    const a = jar({ file: 'a.jar', mods: [{ id: 'x', loader: 'forge', mc: '[1.20.1]' }, { id: 'x', loader: 'neoforge', mc: '[1.21.1]' }] });
    const b = forge({ file: 'b.jar', mods: [{ id: 'y', deps: [{ id: 'x', range: '[1,)' }] }] });
    expect(run([a, b], pack('forge', '1.20.1'))).toEqual([]);
  });

  it('unknown MC on NeoForge: a broken mods.toml counts (either file may be read)', () => {
    expect(codes(run([brokenLeftover('r.jar', 'r')], pack('neoforge', null)))).toEqual(['W-CORRUPT-JAR']);
  });
});

describe('Quilt reads quilt.mod.json, else fabric.mod.json', () => {
  const p = pack('quilt', '1.21.1', '0.26.0');

  it('a jar with both: the fabric.mod.json entry and its errors are ignored', () => {
    const both = jar({
      file: 'both.jar',
      mods: [
        { id: 'm', loader: 'quilt', mc: '>=1.21' },
        { id: 'm', loader: 'fabric', mc: '~1.20.1' },
      ],
    });
    expect(run([both], p)).toEqual([]);
    const brokenFabric = quilt({ file: 'q.jar', mods: [{ id: 'q' }], metadataErrors: [{ file: 'fabric.mod.json', reason: 'bad json' }] });
    expect(run([brokenFabric], p)).toEqual([]);
  });

  it('a Fabric-only jar is read through fabric.mod.json; its errors count', () => {
    const f = fabric({ file: 'f.jar', mods: [{ id: 'f', mc: '~1.20.1' }] });
    expect(codes(run([f], p))).toEqual(['E-MC-RANGE']);
    const broken = jar({ file: 'b.jar', packages: ['com.b'], status: { state: 'corrupt', reason: 'fabric.mod.json: bad json' }, metadataErrors: [{ file: 'fabric.mod.json', reason: 'bad json' }] });
    expect(codes(run([broken], p))).toEqual(['W-CORRUPT-JAR']);
  });
});

describe('unrepresentable ranges (unexpanded ${…} placeholders) are unknown', () => {
  it.each<[LoaderKind, string]>([
    ['neoforge', '1.21.1'],
    ['forge', '1.20.1'],
  ])('%s: no E-MC-RANGE / E-LOADER-RANGE', (loader, mc) => {
    const j = jar({ file: 't.jar', mods: [{ id: 't', loader, mc: '[1.0]', loaderDep: '[1.0]' }] });
    const m = j.mods[0];
    if (m?.mcRange && m.loaderRange) {
      m.mcRange = { syntax: 'maven', raw: [], unrepresentable: '${minecraft_version_range}' };
      m.loaderRange = { syntax: 'maven', raw: [], unrepresentable: '${neo_version_range}' };
    }
    const found = run([j], pack(loader, mc, loader === 'forge' ? '47.3.0' : '21.1.235'));
    expect(only(found, 'E-MC-RANGE')).toEqual([]);
    expect(only(found, 'E-LOADER-RANGE')).toEqual([]);
  });
});
