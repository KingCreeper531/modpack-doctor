import { describe, expect, it } from 'vitest';
import type { JarRecord, LoaderKind } from '../../../bindings';
import { fabric, forge, jar, neoforge, nested, notes, only, pack, run } from './fixtures';

describe('E-DUP-ID', () => {
  it('two top-level jars with the same mod id: keep the newer version', () => {
    const older = fabric({ file: 'sodium-0.5.3.jar', mods: [{ id: 'sodium', name: 'Sodium', version: '0.5.3' }], mtimeMs: 2 });
    const newer = fabric({ file: 'sodium-0.5.11.jar', mods: [{ id: 'sodium', name: 'Sodium', version: '0.5.11' }], mtimeMs: 1 });
    const [f] = only(run([older, newer], pack('fabric', '1.20.1')), 'E-DUP-ID');
    expect(f).toMatchObject({
      severity: 'warning', // Fabric: best effort, newest preferred (see fmlEnforcement.test.ts)
      title: 'Two copies of Sodium — Fabric keeps one (best effort, newest preferred: 0.5.11)',
      fixes: [{ kind: 'removeDuplicate', keep: 'mods/sodium-0.5.11.jar', remove: 'mods/sodium-0.5.3.jar' }],
    });
    expect(f?.explanation).toContain('Keep sodium-0.5.11.jar (0.5.11, the newest copy)');
    expect(f?.evidence.filter((e) => e.kind === 'metadata')).toHaveLength(2);
  });

  it('Maven ordering for Forge versions (1.10 > 1.9)', () => {
    const a = forge({ file: 'a.jar', mods: [{ id: 'jei', version: '15.1.10' }] });
    const b = forge({ file: 'b.jar', mods: [{ id: 'jei', version: '15.1.9' }] });
    const [f] = only(run([a, b], pack('forge', '1.20.1')), 'E-DUP-ID');
    expect(f?.fixes).toEqual([{ kind: 'removeDuplicate', keep: 'mods/a.jar', remove: 'mods/b.jar' }]);
  });

  it('equal versions: the most recently modified file is kept', () => {
    const a = fabric({ file: 'a.jar', mods: [{ id: 'x', version: '1.0' }], mtimeMs: 100 });
    const b = fabric({ file: 'b.jar', mods: [{ id: 'x', version: '1.0' }], mtimeMs: 200 });
    const [f] = only(run([a, b], pack('fabric', '1.20.1')), 'E-DUP-ID');
    expect(f?.fixes).toEqual([{ kind: 'removeDuplicate', keep: 'mods/b.jar', remove: 'mods/a.jar' }]);
  });

  it('three copies → one finding, two removals', () => {
    const jars = ['1.0', '2.0', '3.0'].map((v) => fabric({ file: `x-${v}.jar`, mods: [{ id: 'x', version: v }] }));
    const found = only(run(jars, pack('fabric', '1.20.1')), 'E-DUP-ID');
    expect(found).toHaveLength(1);
    expect(found[0]?.culprits.map((c) => c.fileName)).toEqual(['x-3.0.jar', 'x-2.0.jar', 'x-1.0.jar']);
    expect(found[0]?.fixes).toHaveLength(2);
  });

  it.each<[string, JarRecord[], LoaderKind]>([
    ['Forge + NeoForge metadata in one jar', [jar({ file: 'both.jar', mods: [{ id: 'x', loader: 'forge' }, { id: 'x', loader: 'neoforge' }] })], 'neoforge'],
    ['mods.toml + mcmod.info in one jar', [jar({ file: 'both.jar', mods: [{ id: 'x', loader: 'forge' }, { id: 'x', loader: 'legacyforge' }] })], 'forge'],
    ['a disabled copy', [fabric({ file: 'a.jar', mods: [{ id: 'x' }] }), fabric({ file: 'b.jar', disabled: true, mods: [{ id: 'x' }] })], 'fabric'],
  ])('not reported: %s', (_name, jars, loader) => {
    expect(only(run(jars, pack(loader, '1.20.1')), 'E-DUP-ID')).toEqual([]);
  });

  it('nested copies are fine: two parents bundling the same library, or a bundled copy of a top-level mod', () => {
    const a = forge({ file: 'a.jar', mods: [{ id: 'a' }] });
    const b = forge({ file: 'b.jar', mods: [{ id: 'b' }] });
    const la = nested(a, { file: 'lib.jar', mods: [{ id: 'lib' }], packages: ['org.lib'], jarjar: { group: 'org', artifact: 'lib', version: '1.0' } });
    const lb = nested(b, { file: 'lib.jar', mods: [{ id: 'lib' }], packages: ['org.lib'], jarjar: { group: 'org', artifact: 'lib', version: '1.1' } });
    const lib = forge({ file: 'lib-top.jar', mods: [{ id: 'lib' }] });
    const found = run([a, b, la, lb, lib], pack('forge', '1.20.1'));
    expect(only(found, 'E-DUP-ID')).toEqual([]);
    expect(only(found, 'E-SPLIT-PKG')).toEqual([]);

    const api = fabric({ file: 'fabric-api.jar', mods: [{ id: 'fabric-api' }] });
    const m = fabric({ file: 'm.jar', mods: [{ id: 'm' }] });
    const bundled = nested(m, { file: 'fabric-api-base.jar', mods: [{ id: 'fabric-api' }] }, 'fabric');
    expect(only(run([api, m, bundled], pack('fabric', '1.20.1')), 'E-DUP-ID')).toEqual([]);
  });

  it('jars sharing several ids produce one finding naming every id', () => {
    const a = forge({ file: 'a.jar', mods: [{ id: 'core' }, { id: 'addon' }] });
    const b = forge({ file: 'b.jar', mods: [{ id: 'core' }, { id: 'addon' }] });
    const found = only(run([a, b], pack('forge', '1.20.1')), 'E-DUP-ID');
    expect(found).toHaveLength(1);
    expect(notes(found[0])[0]).toBe('Mod ids "addon", "core" declared by: a.jar (1.0.0), b.jar (1.0.0).');
  });
});

describe('E-SPLIT-PKG / I-SPLIT-PKG', () => {
  const a = (loader: LoaderKind) => jar({ file: 'alpha.jar', mods: [{ id: 'alpha', loader }], packages: ['com.shared.util', 'com.shared.api', 'com.alpha'] });
  const b = (loader: LoaderKind) => jar({ file: 'beta.jar', mods: [{ id: 'beta', loader }], packages: ['com.shared.util', 'com.shared.api', 'com.beta'] });

  it.each<[LoaderKind, string, 'E-SPLIT-PKG' | 'I-SPLIT-PKG', string]>([
    ['forge', '1.20.1', 'E-SPLIT-PKG', 'error'],
    ['neoforge', '1.21.1', 'E-SPLIT-PKG', 'error'],
    ['forge', '1.16.5', 'I-SPLIT-PKG', 'info'],
    ['fabric', '1.20.1', 'I-SPLIT-PKG', 'info'],
    ['quilt', '1.20.1', 'I-SPLIT-PKG', 'info'],
  ])('%s %s → %s (%s)', (loader, mc, code, severity) => {
    const found = run([a(loader), b(loader)], pack(loader, mc));
    const split = found.filter((f) => f.code === 'E-SPLIT-PKG' || f.code === 'I-SPLIT-PKG');
    expect(split).toHaveLength(1);
    expect(split[0]).toMatchObject({ code, severity });
  });

  it('groups every package of one jar pair, naming both jars and the package', () => {
    const [f] = only(run([a('forge'), b('forge')], pack('forge', '1.20.1')), 'E-SPLIT-PKG');
    expect(f?.title).toBe('alpha.jar, beta.jar both contain package com.shared.api (+1 more)');
    expect(f?.explanation).toContain('alpha.jar and beta.jar');
    expect(f?.explanation).toContain('com.shared.api, com.shared.util');
    expect(f?.explanation).toContain('ResolutionException');
    expect(notes(f)[0]).toBe('Shared packages: com.shared.api, com.shared.util.');
    expect(f?.culprits.map((c) => c.jarId)).toEqual(['mods/alpha.jar', 'mods/beta.jar']);
  });

  it('suggests disabling the jar no other mod depends on first', () => {
    const lib = forge({ file: 'aaa-lib.jar', mods: [{ id: 'aaalib' }], packages: ['com.shared'] });
    const user = forge({ file: 'zzz-addon.jar', mods: [{ id: 'addon' }], packages: ['com.shared'] });
    const dependent = forge({ file: 'needs-lib.jar', mods: [{ id: 'needs', deps: [{ id: 'aaalib', range: '[1,)' }] }] });
    const [f] = only(run([lib, user, dependent], pack('forge', '1.20.1')), 'E-SPLIT-PKG');
    expect(f?.fixes).toEqual([
      { kind: 'disable', jarId: 'mods/zzz-addon.jar' },
      { kind: 'disable', jarId: 'mods/aaa-lib.jar' },
    ]);
    expect(f?.explanation).toContain('Disabling zzz-addon.jar is suggested first because no other mod requires it.');
  });

  it.each<[string, JarRecord[]]>([
    ['packages of nested jars', (() => {
      const p1 = forge({ file: 'p1.jar', mods: [{ id: 'p1' }] });
      const p2 = forge({ file: 'p2.jar', mods: [{ id: 'p2' }] });
      return [p1, p2, nested(p1, { file: 'l.jar', packages: ['org.lib'], jarjar: { group: 'o', artifact: 'l' } }), nested(p2, { file: 'l.jar', packages: ['org.lib'], jarjar: { group: 'o', artifact: 'l' } })];
    })()],
    ['a disabled jar', [forge({ file: 'a.jar', mods: [{ id: 'a' }], packages: ['com.x'] }), forge({ file: 'b.jar', disabled: true, mods: [{ id: 'b' }], packages: ['com.x'] })]],
    ['duplicates (E-DUP-ID covers them)', [forge({ file: 'a.jar', mods: [{ id: 'x' }], packages: ['com.x'] }), forge({ file: 'b.jar', mods: [{ id: 'x' }], packages: ['com.x'] })]],
    ['a wrong-loader jar the loader ignores', [forge({ file: 'a.jar', mods: [{ id: 'a' }], packages: ['com.x'] }), fabric({ file: 'b.jar', mods: [{ id: 'b' }], packages: ['com.x'] })]],
  ])('not reported: %s', (_name, jars) => {
    expect(only(run(jars, pack('forge', '1.20.1')), 'E-SPLIT-PKG')).toEqual([]);
  });

  it('NeoForge mods on 1.20.1 Forge still split', () => {
    const x = neoforge({ file: 'x.jar', mods: [{ id: 'x', modsToml: true }], packages: ['com.x'] });
    const y = forge({ file: 'y.jar', mods: [{ id: 'y' }], packages: ['com.x'] });
    expect(only(run([x, y], pack('forge', '1.20.1')), 'E-SPLIT-PKG')).toHaveLength(1);
  });
});
