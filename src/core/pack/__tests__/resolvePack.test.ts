import { describe, expect, it } from 'vitest';
import type { Instance, JarRecord, PackOverride, ScanResult } from '../../../bindings';
import { fabric, forge, instance, jar, neoforge, quilt, scan } from '../../checks/__tests__/fixtures';
import { describePack, resolvePack } from '../index';
import { inferLoaderKind, inferMcVersion } from '../resolve';

const inferred = (over: Partial<Instance> = {}): Instance =>
  instance({ metadataSource: 'inferred', mcVersion: null, loader: null, ...over });

function manyFabric(n: number, mc: string | string[], prefix = 'f'): JarRecord[] {
  return Array.from({ length: n }, (_, i) => fabric({ file: `${prefix}${i}.jar`, mods: [{ id: `${prefix}${i}`, mc }] }));
}

describe('resolvePack precedence', () => {
  const jars = scan(...manyFabric(3, '~1.21.1'));

  it.each<[string, Instance, PackOverride | null, Partial<ReturnType<typeof resolvePack>>]>([
    [
      'launcher metadata wins over the jar majority',
      instance({ mcVersion: '1.20.1', loader: { kind: 'forge', version: '47.3.0' } }),
      null,
      { mcVersion: '1.20.1', loader: { kind: 'forge', version: '47.3.0' }, source: 'launcher' },
    ],
    [
      'mrpack metadata is labelled mrpack',
      instance({ metadataSource: 'mrpack', mcVersion: '1.21.1', loader: { kind: 'fabric', version: '0.16.5' } }),
      null,
      { mcVersion: '1.21.1', loader: { kind: 'fabric', version: '0.16.5' }, source: 'mrpack' },
    ],
    [
      'override beats launcher metadata',
      instance(),
      { mcVersion: '1.21.1', loader: { kind: 'neoforge', version: '21.1.77' }, side: null },
      { mcVersion: '1.21.1', loader: { kind: 'neoforge', version: '21.1.77' }, source: 'override' },
    ],
    [
      'partial override: loader overridden, MC from launcher → source override',
      instance(),
      { mcVersion: null, loader: { kind: 'neoforge', version: '47.1.106' }, side: null },
      { mcVersion: '1.20.1', loader: { kind: 'neoforge', version: '47.1.106' }, source: 'override' },
    ],
    [
      'side-only override keeps the metadata source',
      instance(),
      { mcVersion: null, loader: null, side: 'server' },
      { mcVersion: '1.20.1', side: 'server', source: 'launcher' },
    ],
    [
      'inferred instance → majority, loader version null',
      inferred(),
      null,
      { mcVersion: '1.21.1', loader: { kind: 'fabric', version: null }, source: 'majority' },
    ],
    [
      'launcher with null loader means vanilla: loader is not inferred',
      instance({ loader: null, mcVersion: '1.21.1' }),
      null,
      { mcVersion: '1.21.1', loader: null, source: 'launcher' },
    ],
    [
      'launcher without MC version: MC inferred, source stays launcher',
      instance({ mcVersion: null, loader: { kind: 'fabric', version: '0.16.5' } }),
      null,
      { mcVersion: '1.21.1', loader: { kind: 'fabric', version: '0.16.5' }, source: 'launcher' },
    ],
  ])('%s', (_name, inst, override, expected) => {
    expect(resolvePack(inst, jars, override)).toMatchObject(expected);
  });

  it('side comes from the instance unless overridden', () => {
    expect(resolvePack(instance({ side: 'server' }), jars).side).toBe('server');
    expect(resolvePack(instance({ side: 'server' }), jars, { mcVersion: null, loader: null, side: 'client' }).side).toBe('client');
  });

  it('nothing known → unknown', () => {
    expect(resolvePack(inferred(), scan())).toEqual({ mcVersion: null, loader: null, side: 'client', source: 'unknown' });
  });

  it('never throws on malformed input', () => {
    const broken = { jars: [{ id: 'x', mods: null }] } as unknown as ScanResult;
    expect(() => resolvePack(inferred(), broken)).not.toThrow();
    expect(resolvePack(inferred(), broken).source).toBe('unknown');
  });
});

describe('majority inference', () => {
  it('MC: the version satisfied by the most jars wins', () => {
    const jars = [...manyFabric(3, '~1.20.1'), ...manyFabric(1, '>=1.21', 'g')];
    expect(inferMcVersion(jars)).toBe('1.20.1');
  });

  it('MC: ties go to the newest version', () => {
    const jars = [...manyFabric(2, '1.20.1'), ...manyFabric(2, '1.21.1', 'g')];
    expect(inferMcVersion(jars)).toBe('1.21.1');
  });

  it('MC: Maven bounds count, exclusive upper bounds do not match', () => {
    const jars = [
      forge({ file: 'a.jar', mods: [{ id: 'a', mc: '[1.20,1.20.2)' }] }),
      forge({ file: 'b.jar', mods: [{ id: 'b', mc: '[1.20.1]' }] }),
      forge({ file: 'c.jar', mods: [{ id: 'c', mc: '[1.20.2,1.21)' }] }),
    ];
    expect(inferMcVersion(jars)).toBe('1.20.1');
  });

  it('MC: a wildcard and an array both count', () => {
    const jars = [
      fabric({ file: 'a.jar', mods: [{ id: 'a', mc: '1.21.x' }] }),
      fabric({ file: 'b.jar', mods: [{ id: 'b', mc: ['1.20.6', '1.21'] }] }),
    ];
    expect(inferMcVersion(jars)).toBe('1.21');
  });

  it('MC: no ranges → null', () => {
    expect(inferMcVersion([forge({ file: 'a.jar', mods: [{ id: 'a' }] })])).toBeNull();
  });

  it('loader: plain majority', () => {
    const jars = [
      forge({ file: 'a.jar', mods: [{ id: 'a' }] }),
      forge({ file: 'b.jar', mods: [{ id: 'b' }] }),
      fabric({ file: 'c.jar', mods: [{ id: 'c' }] }),
    ];
    expect(inferLoaderKind(jars, '1.20.1')).toBe('forge');
  });

  it('loader: Fabric jars count for Quilt, so a few Quilt jars make it Quilt', () => {
    const jars = [...manyFabric(3, '1.20.1'), quilt({ file: 'q.jar', mods: [{ id: 'q' }] })];
    expect(inferLoaderKind(jars, '1.20.1')).toBe('quilt');
    expect(inferLoaderKind(manyFabric(3, '1.20.1'), '1.20.1')).toBe('fabric');
  });

  it('loader: on 1.20.1 Forge and NeoForge count for each other; the native majority breaks the tie', () => {
    const jars = [
      forge({ file: 'a.jar', mods: [{ id: 'a' }] }),
      neoforge({ file: 'b.jar', mods: [{ id: 'b', modsToml: true }] }),
      neoforge({ file: 'c.jar', mods: [{ id: 'c', modsToml: true }] }),
    ];
    expect(inferLoaderKind(jars, '1.20.1')).toBe('neoforge');
  });

  it('loader: an exact tie falls back to the fixed order (Forge first)', () => {
    const jars = [forge({ file: 'a.jar', mods: [{ id: 'a' }] }), fabric({ file: 'b.jar', mods: [{ id: 'b' }] })];
    expect(inferLoaderKind(jars, '1.20.1')).toBe('forge');
  });

  it('a jar with Forge and NeoForge metadata counts once for each loader', () => {
    const both = jar({ file: 'both.jar', mods: [{ id: 'x', loader: 'forge' }, { id: 'x', loader: 'neoforge' }] });
    const jars = [both, fabric({ file: 'f.jar', mods: [{ id: 'f' }] })];
    // forge: 1 (native 1), neoforge: 1 (native 1), fabric: 1 → forge by fixed order.
    expect(inferLoaderKind(jars, '1.21.1')).toBe('forge');
    expect(inferLoaderKind([both, neoforge({ file: 'n.jar', mods: [{ id: 'n' }] })], '1.21.1')).toBe('neoforge');
  });

  it('disabled and nested jars do not vote', () => {
    const top = forge({ file: 'a.jar', mods: [{ id: 'a', mc: '[1.20.1]' }] });
    const s = scan(
      top,
      fabric({ file: 'x.jar', disabled: true, mods: [{ id: 'x', mc: '1.21.1' }] }),
      fabric({ file: 'y.jar', disabled: true, mods: [{ id: 'y', mc: '1.21.1' }] }),
    );
    expect(resolvePack(inferred(), s)).toMatchObject({ mcVersion: '1.20.1', loader: { kind: 'forge', version: null } });
  });
});

describe('describePack', () => {
  it.each([
    [{ mcVersion: '1.20.1', loader: { kind: 'forge' as const, version: '47.3.0' }, side: 'client' as const, source: 'launcher' as const }, 'Pack: Forge 47.3.0 on Minecraft 1.20.1 (from launcher metadata)'],
    [{ mcVersion: '1.21.1', loader: { kind: 'fabric' as const, version: null }, side: 'server' as const, source: 'majority' as const }, 'Pack: Fabric (version unknown) on Minecraft 1.21.1, server (inferred from the installed mods)'],
    [{ mcVersion: '1.21.1', loader: null, side: 'client' as const, source: 'launcher' as const }, 'Pack: Vanilla on Minecraft 1.21.1 (from launcher metadata)'],
    [{ mcVersion: null, loader: null, side: 'client' as const, source: 'unknown' as const }, 'Pack: an unknown loader on an unknown Minecraft version (not known)'],
  ])('%#', (p, text) => {
    expect(describePack(p)).toBe(text);
  });
});
