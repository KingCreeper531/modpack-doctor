/**
 * M3 review follow-ups: dropped duplicate copies, placeholder / 0.0NONE versions, corrupt jars
 * broken only in unread files, Connector-only id normalisation, MC inference tie-breaks.
 */
import { describe, expect, it } from 'vitest';
import { inferMcVersion } from '../../pack/resolve';
import { contextFor } from '../context';
import { isPlaceholderVersion } from '../duplicates';
import { codes, fabric, forge, input, jar, neoforge, only, pack, quilt, run } from './fixtures';

describe('duplicate copies the loader drops are invisible to other checks', () => {
  const neo = pack('neoforge', '1.21.1', '21.1.235');

  it('FML: an old dropped copy with a bad MC range gives no E-MC-RANGE (E-DUP-ID still reports it)', () => {
    const old = neoforge({ file: 'createdynlight-2.0.1.jar', mods: [{ id: 'createdynlight', version: '2.0.1', mc: '[1.20.1]' }] });
    const cur = neoforge({ file: 'createdynlight-2.3.1.jar', mods: [{ id: 'createdynlight', version: '2.3.1', mc: '[1.21.1]' }] });
    const found = run([old, cur], neo);
    expect(codes(found)).toEqual(['E-DUP-ID']);
    expect(found[0]?.fixes).toEqual([{ kind: 'removeDuplicate', keep: cur.id, remove: old.id }]);
  });

  it('FML: a split package against a dropped copy is not reported, and it provides nothing', () => {
    const old = forge({ file: 'lib-1.0.jar', mods: [{ id: 'lib', version: '1.0', deps: [{ id: 'gone', range: '[1,)' }] }], packages: ['com.lib', 'com.shared'] });
    const cur = forge({ file: 'lib-2.0.jar', mods: [{ id: 'lib', version: '2.0' }], packages: ['com.lib'] });
    const other = forge({ file: 'other.jar', mods: [{ id: 'other' }], packages: ['com.shared'] });
    const found = run([old, cur, other], pack('forge', '1.20.1', '47.3.0'));
    expect(codes(found)).toEqual(['E-DUP-ID']); // no E-SPLIT-PKG (old vs other), no E-MISSING-DEP from old
    const ctx = contextFor(input([old, cur, other], pack('forge', '1.20.1', '47.3.0')));
    expect(ctx.isDropped(old)).toBe(true);
    expect(ctx.isLoaded(old)).toBe(false);
    expect(ctx.providers('lib').map((e) => e.jar.id)).toEqual([cur.id]);
  });

  it('Fabric drops the older copy too; Quilt and FML cross-file duplicates drop nothing', () => {
    const f1 = fabric({ file: 'x-1.jar', mods: [{ id: 'x', version: '1.0', mc: '~1.19' }] });
    const f2 = fabric({ file: 'x-2.jar', mods: [{ id: 'x', version: '2.0', mc: '~1.20.1' }] });
    expect(codes(run([f1, f2], pack('fabric', '1.20.1')))).toEqual(['E-DUP-ID']);

    const q1 = quilt({ file: 'q-1.jar', mods: [{ id: 'q', version: '1.0', mc: '~1.19' }] });
    const q2 = quilt({ file: 'q-2.jar', mods: [{ id: 'q', version: '2.0', mc: '~1.20.1' }] });
    expect(codes(run([q1, q2], pack('quilt', '1.20.1')))).toEqual(['E-DUP-ID', 'E-MC-RANGE']);

    const big = forge({ file: 'big.jar', mods: [{ id: 'big', mc: '[1.19.2]' }, { id: 'shared' }] });
    const lib = forge({ file: 'shared.jar', mods: [{ id: 'shared' }] });
    expect(codes(run([big, lib], pack('forge', '1.20.1', '47.3.0')))).toEqual(['E-DUP-ID', 'E-MC-RANGE']);
  });
});

describe('placeholder / 0.0NONE provider versions', () => {
  it.each([
    ['${file.jarVersion}', true],
    ['0.0NONE', true],
    ['1.2.${build}', true],
    ['1.0.0', false],
  ])('isPlaceholderVersion(%s) → %s', (v, expected) => {
    expect(isPlaceholderVersion(v)).toBe(expected);
  });

  it.each(['${file.jarVersion}', '0.0NONE'])('FML: a provider at %s passes the dependency range', (version) => {
    const user = forge({ file: 'user.jar', mods: [{ id: 'user', deps: [{ id: 'lib', range: '[4.4,)' }] }] });
    const lib = forge({ file: 'lib.jar', mods: [{ id: 'lib', version }] });
    expect(only(run([user, lib], pack('forge', '1.20.1', '47.3.0')), 'E-DEP-RANGE')).toEqual([]);
  });

  it('dupId ranking: a placeholder version ranks lowest, then mtime', () => {
    const real = neoforge({ file: 'a-real.jar', mods: [{ id: 'a', version: '0.1.0' }], mtimeMs: 1 });
    const tmpl = neoforge({ file: 'a-dev.jar', mods: [{ id: 'a', version: '${file.jarVersion}' }], mtimeMs: 9 });
    const [f] = only(run([real, tmpl], pack('neoforge', '1.21.1')), 'E-DUP-ID');
    expect(f?.fixes).toEqual([{ kind: 'removeDuplicate', keep: real.id, remove: tmpl.id }]);
  });
});

describe('W-CORRUPT-JAR: corrupt only because of unread metadata files', () => {
  it('NeoForge 1.21.1: a corrupt jar whose only broken file is mods.toml → no finding', () => {
    const j = jar({
      file: 'stale.jar',
      packages: ['com.stale'],
      status: { state: 'corrupt', reason: 'META-INF/mods.toml: invalid TOML' },
      metadataErrors: [{ file: 'META-INF/mods.toml', reason: 'invalid TOML' }],
    });
    expect(only(run([j], pack('neoforge', '1.21.1')), 'W-CORRUPT-JAR')).toEqual([]);
    expect(only(run([j], pack('neoforge', '1.20.4')), 'W-CORRUPT-JAR')).toHaveLength(1);
  });

  it('a corrupt zip (no metadata errors) is still reported', () => {
    const j = jar({ file: 'zip.jar', status: { state: 'corrupt', reason: 'not a valid jar (zip) file' } });
    expect(only(run([j], pack('neoforge', '1.21.1')), 'W-CORRUPT-JAR')).toHaveLength(1);
  });
});

describe('Connector id normalisation applies only to Fabric jars loaded through Connector', () => {
  it('a native FML dependency on "my-lib" is not satisfied by "my_lib"', () => {
    const connector = neoforge({ file: 'connector.jar', mods: [{ id: 'connector' }] });
    const lib = neoforge({ file: 'my_lib.jar', mods: [{ id: 'my_lib' }] });
    const user = neoforge({ file: 'user.jar', mods: [{ id: 'user', deps: [{ id: 'my-lib', range: '[1,)' }] }] });
    expect(codes(run([connector, lib, user], pack('neoforge', '1.21.1')))).toEqual(['E-MISSING-DEP']);
    const fabricUser = fabric({ file: 'fuser.jar', mods: [{ id: 'fuser', deps: [{ id: 'my-lib' }] }] });
    expect(run([connector, lib, fabricUser], pack('neoforge', '1.21.1'))).toEqual([]);
  });
});

describe('MC inference', () => {
  const many = (n: number, mc: string, prefix: string) => Array.from({ length: n }, (_, i) => fabric({ file: `${prefix}${i}.jar`, mods: [{ id: `${prefix}${i}`, mc }] }));

  it('all mods >=1.20 plus one ">=1.20.1 <=1.20.4" does not infer 1.20.4', () => {
    const jars = [...many(5, '>=1.20', 'a'), fabric({ file: 'b.jar', mods: [{ id: 'b', mc: '>=1.20.1 <=1.20.4' }] })];
    const mc = inferMcVersion(jars, 'fabric');
    expect(mc).not.toBe('1.20.4');
    expect(mc).toBe('1.20.1');
  });

  it('Maven: the right-hand bound is an upper bound', () => {
    const jars = [forge({ file: 'a.jar', mods: [{ id: 'a', mc: '[1.20,)' }] }), forge({ file: 'b.jar', mods: [{ id: 'b', mc: '[1.20.1,1.20.4]' }] })];
    expect(inferMcVersion(jars, 'forge')).toBe('1.20.1');
  });

  it('ties go to the most-mentioned token before the newest', () => {
    const jars = [...many(2, '>=1.20', 'a'), ...many(2, '~1.20.1', 'b'), fabric({ file: 'c.jar', mods: [{ id: 'c', mc: '>=1.20.1' }] })];
    // 1.20.1 is satisfied by all 5 and mentioned 3 times; 1.20 by only the two >=1.20 jars.
    expect(inferMcVersion(jars, 'fabric')).toBe('1.20.1');
  });

  it('only entries relevant to the inferred loader count (a stale mods.toml is ignored)', () => {
    const jars = [
      jar({ file: 'x.jar', mods: [{ id: 'x', loader: 'neoforge', mc: '[1.21.1]' }, { id: 'x', loader: 'neoforge', modsToml: true, mc: '[1.20.4]' }] }),
      jar({ file: 'y.jar', mods: [{ id: 'y', loader: 'neoforge', mc: '[1.21.1]' }, { id: 'y', loader: 'neoforge', modsToml: true, mc: '[1.20.4]' }] }),
      fabric({ file: 'z.jar', mods: [{ id: 'z', mc: '1.20.4' }] }),
    ];
    // Without a loader filter 1.20.4 (3 jars) would beat 1.21.1 (2 jars).
    expect(inferMcVersion(jars, null)).toBe('1.20.4');
    // NeoForge: the Fabric jar does not vote; 1.21.1 and 1.20.4 tie on score and mentions → newest.
    expect(inferMcVersion(jars, 'neoforge')).toBe('1.21.1');
    expect(inferMcVersion(jars, 'fabric')).toBe('1.20.4');
  });
});
