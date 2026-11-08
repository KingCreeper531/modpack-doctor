import { describe, expect, it } from 'vitest';
import type { JarRecord, LoaderKind, Side } from '../../../bindings';
import type { PackContext } from '../../model';
import { BUILTIN_DEPENDENCIES, isBuiltinDependency } from '../builtins';
import { fabric, forge, highlighted, jar, neoforge, nested, only, pack, quilt, run } from './fixtures';

const missing = (jars: JarRecord[], p: PackContext) => only(run(jars, p), 'E-MISSING-DEP');
const outOfRange = (jars: JarRecord[], p: PackContext) => only(run(jars, p), 'E-DEP-RANGE');

describe('built-in dependency ids', () => {
  it.each(Object.keys(BUILTIN_DEPENDENCIES))('%s is built in', (id) => {
    expect(isBuiltinDependency(id, pack('forge', '1.20.1'))).toBe(true);
  });

  it.each<[string, LoaderKind | null, string | null, boolean]>([
    ['Forge', null, null, true], // pre-1.13 mcmod.info spelling, case-insensitive
    ['FML', null, null, true],
    ['fabric', 'fabric', '0.16.5', false], // legacy Fabric API id — must be installed
    ['fabric-api', 'fabric', '0.16.5', false],
    ['mixinextras', 'fabric', '0.16.5', true],
    ['mixinextras', 'fabric', '0.14.21', false],
    ['mixinextras', 'fabric', null, true],
    ['mixinextras', 'quilt', '0.26.0', true],
    ['mixinextras', 'forge', '47.3.0', false],
    ['mixinextras', 'neoforge', '21.1.77', false],
  ])('%s on %s %s → %s', (id, loader, version, expected) => {
    expect(isBuiltinDependency(id, pack(loader, '1.20.1', version))).toBe(expected);
  });
});

describe('E-MISSING-DEP', () => {
  const p = pack('fabric', '1.20.1', '0.16.5');

  it('reports a required dependency nothing provides, with manual fix and highlighted line', () => {
    const extra = fabric({ file: 'sodium-extra.jar', mods: [{ id: 'sodium-extra', name: 'Sodium Extra', mc: '~1.20.1', deps: [{ id: 'sodium', range: '>=0.5.0' }] }] });
    const [f] = missing([extra], p);
    expect(f).toMatchObject({
      severity: 'error',
      culprits: [{ jarId: 'mods/sodium-extra.jar', fileName: 'sodium-extra.jar', modId: 'sodium-extra' }],
    });
    expect(f?.title).toMatch(/^Sodium Extra requires "sodium" .*0\.5\.0.*, which is not installed$/);
    expect(highlighted(f)).toEqual(['"sodium": ">=0.5.0"']);
    expect(f?.fixes).toHaveLength(1);
    expect(f?.fixes[0]).toMatchObject({ kind: 'manual' });
    const steps = f?.fixes[0]?.kind === 'manual' ? f.fixes[0].steps.join(' ') : '';
    expect(steps).toContain('"sodium"');
    expect(steps).toContain('>=0.5.0');
  });

  it.each<[string, JarRecord[]]>([
    ['present at top level', [fabric({ file: 's.jar', mods: [{ id: 'sodium' }] })]],
    ['present through provides', [fabric({ file: 'embeddium.jar', mods: [{ id: 'embeddium', provides: ['sodium'] }] })]],
  ])('not reported when the dependency is %s', (_name, others) => {
    const extra = fabric({ file: 'sodium-extra.jar', mods: [{ id: 'sodium-extra', deps: [{ id: 'sodium' }] }] });
    expect(missing([extra, ...others], p)).toEqual([]);
  });

  it('nested jars satisfy dependencies (Fabric JiJ and Forge JarJar)', () => {
    const parent = fabric({ file: 'mod.jar', mods: [{ id: 'mod', deps: [{ id: 'cloth-config' }] }] });
    const child = nested(parent, { file: 'cloth-config.jar', mods: [{ id: 'cloth-config' }] }, 'fabric');
    expect(missing([parent, child], p)).toEqual([]);

    const create = forge({ file: 'create.jar', mods: [{ id: 'create', deps: [{ id: 'flywheel', range: '[1.0,2.0)' }] }] });
    const fly = nested(create, { file: 'flywheel.jar', mods: [{ id: 'flywheel', version: '1.0.1' }], jarjar: { group: 'dev.engine-room', artifact: 'flywheel', range: '[1.0,2.0)', version: '1.0.1' } });
    expect(missing([create, fly], pack('forge', '1.20.1', '47.3.0'))).toEqual([]);
  });

  it('built-ins are never missing', () => {
    const m = fabric({ file: 'm.jar', mods: [{ id: 'm', mc: '~1.20.1', loaderDep: '>=0.15', deps: [{ id: 'java', range: '>=17' }, { id: 'mixinextras' }] }] });
    expect(missing([m], p)).toEqual([]);
    const f = forge({ file: 'f.jar', mods: [{ id: 'f', mc: '[1.20.1]', loaderDep: '[47,)' }] });
    expect(missing([f], pack('forge', '1.20.1', '47.3.0'))).toEqual([]);
    const n = neoforge({ file: 'n.jar', mods: [{ id: 'n', mc: '[1.21.1]', loaderDep: '[21.1,)' }] });
    expect(missing([n], pack('neoforge', '1.21.1', '21.1.77'))).toEqual([]);
  });

  it('the legacy "fabric" id (Fabric API) is reported when Fabric API is absent, satisfied by its provides', () => {
    const old = fabric({ file: 'old.jar', mods: [{ id: 'old', deps: [{ id: 'fabric' }] }] });
    expect(missing([old], p)).toHaveLength(1);
    const api = fabric({ file: 'fabric-api.jar', mods: [{ id: 'fabric-api', provides: ['fabric'] }] });
    expect(missing([old, api], p)).toEqual([]);
  });

  it.each<[string, Side, boolean]>([
    ['CLIENT', 'server', false],
    ['CLIENT', 'client', true],
    ['SERVER', 'client', false],
    ['BOTH', 'server', true],
  ])('Forge dependency side %s on a %s pack → reported: %s', (side, packSide, expected) => {
    const m = forge({ file: 'm.jar', mods: [{ id: 'm', deps: [{ id: 'somelib', range: '[1,)', side }] }] });
    expect(missing([m], pack('forge', '1.20.1', '47.3.0', packSide))).toHaveLength(expected ? 1 : 0);
  });

  it('optional and recommended dependencies are not required', () => {
    const m = fabric({ file: 'm.jar', mods: [{ id: 'm', deps: [{ id: 'modmenu', kind: 'optional' }, { id: 'rei', kind: 'recommended' }] }] });
    expect(missing([m], p)).toEqual([]);
  });

  it('a disabled jar providing the dependency is offered for re-enabling first', () => {
    const extra = fabric({ file: 'sodium-extra.jar', mods: [{ id: 'sodium-extra', deps: [{ id: 'sodium' }] }] });
    const off = fabric({ file: 'sodium.jar', disabled: true, mods: [{ id: 'sodium' }] });
    const [f] = missing([extra, off], p);
    expect(f?.fixes[0]).toEqual({ kind: 'enable', jarId: 'mods/sodium.jar' });
    expect(f?.explanation).toContain('sodium.jar.disabled');
  });

  it('a provider for another loader does not count (Forge build on a Fabric pack)', () => {
    const extra = fabric({ file: 'sodium-extra.jar', mods: [{ id: 'sodium-extra', deps: [{ id: 'sodium' }] }] });
    const wrong = forge({ file: 'sodium-forge.jar', mods: [{ id: 'sodium' }] });
    expect(missing([extra, wrong], p)).toHaveLength(1);
  });

  // Reported by a user: "it says he doesn't have Create but he does". The title must name the jar
  // that is there and why it doesn't count, never "not installed".
  describe('Create is in the folder but not used', () => {
    const forgePack = pack('forge', '1.20.1', '47.3.0');
    const addon = forge({ file: 'create_new_age.jar', mods: [{ id: 'create_new_age', name: 'Create: New Age', deps: [{ id: 'create', range: '[6.0,)' }] }] });

    it('disabled in the launcher', () => {
      const off = forge({ file: 'create-1.20.1-6.0.6.jar', disabled: true, mods: [{ id: 'create', name: 'Create', version: '6.0.6' }] });
      const [f] = missing([addon, off], forgePack);
      expect(f?.title).toContain('but create-1.20.1-6.0.6.jar.disabled is disabled');
      expect(f?.title).not.toContain('not installed');
      expect(f?.fixes[0]).toEqual({ kind: 'enable', jarId: 'mods/create-1.20.1-6.0.6.jar' });
    });

    it('the Fabric build in a Forge pack', () => {
      const fab = fabric({ file: 'create-fabric-0.5.1-j.jar', mods: [{ id: 'create', name: 'Create' }] });
      const [f] = missing([addon, fab], forgePack);
      expect(f?.title).toContain('but create-fabric-0.5.1-j.jar is the Fabric version, and this pack runs Forge');
      expect(f?.explanation).toContain('create-fabric-0.5.1-j.jar is the Fabric version');
    });

    it('client-only on a server', () => {
      const serverPack = pack('forge', '1.20.1', '47.3.0', 'server');
      const clientOnly = forge({ file: 'create.jar', mods: [{ id: 'create', env: 'client' }] });
      const [f] = missing([addon, clientOnly], serverPack);
      expect(f?.title).toContain('but create.jar is client-only, and this is a server instance');
    });

    it('still says "not installed" when no jar declares it', () => {
      const [f] = missing([addon], forgePack);
      expect(f?.title).toMatch(/requires "create" .*, which is not installed$/);
    });

    it('nothing is reported when Create is installed and active', () => {
      const ok = forge({ file: 'create-1.20.1-6.0.6.jar', mods: [{ id: 'create', version: '6.0.6' }] });
      expect(missing([addon, ok], forgePack)).toEqual([]);
    });
  });

  it('Quilt pack: a Fabric mod satisfies a Quilt mod dependency', () => {
    const q = quilt({ file: 'q.jar', mods: [{ id: 'q', deps: [{ id: 'cloth-config' }] }] });
    const cloth = fabric({ file: 'cloth.jar', mods: [{ id: 'cloth-config' }] });
    expect(missing([q, cloth], pack('quilt', '1.20.1', '0.26.0'))).toEqual([]);
    expect(missing([q], pack('quilt', '1.20.1', '0.26.0'))).toHaveLength(1);
  });

  it('client-only mods on a server are not checked (the loader skips them)', () => {
    const c = fabric({ file: 'c.jar', mods: [{ id: 'c', env: 'client', deps: [{ id: 'nothere' }] }] });
    expect(missing([c], pack('fabric', '1.20.1', '0.16.5', 'server'))).toEqual([]);
    expect(missing([c], pack('fabric', '1.20.1', '0.16.5', 'client'))).toHaveLength(1);
  });

  it('mods.toml evidence highlights the dependency block lines', () => {
    const m = forge({ file: 'm.jar', mods: [{ id: 'm', deps: [{ id: 'geckolib', range: '[4.4,)' }] }] });
    const [f] = missing([m], pack('forge', '1.20.1', '47.3.0'));
    expect(highlighted(f)).toEqual(['modId="geckolib"', 'versionRange="[4.4,)"']);
  });

  it('quilt.mod.json evidence highlights the id and versions lines', () => {
    const q = quilt({ file: 'q.jar', mods: [{ id: 'q', deps: [{ id: 'qsl', range: '>=6.0' }] }] });
    const [f] = missing([q], pack('quilt', '1.20.1', '0.26.0'));
    expect(highlighted(f)).toEqual(['"id": "qsl",', '"versions": ">=6.0"']);
  });
});

describe('E-DEP-RANGE', () => {
  it.each<[string, JarRecord[], PackContext, boolean]>([
    [
      'Fabric >=0.5.0 with 0.4.10 installed',
      [fabric({ file: 'x.jar', mods: [{ id: 'x', deps: [{ id: 'sodium', range: '>=0.5.0' }] }] }), fabric({ file: 's.jar', mods: [{ id: 'sodium', version: '0.4.10' }] })],
      pack('fabric', '1.20.1', '0.16.5'),
      true,
    ],
    [
      'Fabric >=0.5.0 with 0.5.8 installed',
      [fabric({ file: 'x.jar', mods: [{ id: 'x', deps: [{ id: 'sodium', range: '>=0.5.0' }] }] }), fabric({ file: 's.jar', mods: [{ id: 'sodium', version: '0.5.8+mc1.20.1' }] })],
      pack('fabric', '1.20.1', '0.16.5'),
      false,
    ],
    [
      'Maven [4.4,) with geckolib 4.2.1',
      [forge({ file: 'x.jar', mods: [{ id: 'x', deps: [{ id: 'geckolib', range: '[4.4,)' }] }] }), forge({ file: 'g.jar', mods: [{ id: 'geckolib', version: '4.2.1' }] })],
      pack('forge', '1.20.1', '47.3.0'),
      true,
    ],
    [
      'Maven soft "4.4" matches anything',
      [forge({ file: 'x.jar', mods: [{ id: 'x', deps: [{ id: 'geckolib', range: '4.4' }] }] }), forge({ file: 'g.jar', mods: [{ id: 'geckolib', version: '4.2.1' }] })],
      pack('forge', '1.20.1', '47.3.0'),
      false,
    ],
    [
      'Forge optional dependency out of range is enforced when installed',
      [forge({ file: 'x.jar', mods: [{ id: 'x', deps: [{ id: 'jei', kind: 'optional', range: '[15,)' }] }] }), forge({ file: 'jei.jar', mods: [{ id: 'jei', version: '14.0.0' }] })],
      pack('forge', '1.20.1', '47.3.0'),
      true,
    ],
    [
      'Fabric suggests out of range is not enforced',
      [fabric({ file: 'x.jar', mods: [{ id: 'x', deps: [{ id: 'modmenu', kind: 'optional', range: '>=9' }] }] }), fabric({ file: 'mm.jar', mods: [{ id: 'modmenu', version: '7.2.2' }] })],
      pack('fabric', '1.20.1', '0.16.5'),
      false,
    ],
    [
      'provides alias uses the provider version',
      [fabric({ file: 'x.jar', mods: [{ id: 'x', deps: [{ id: 'sodium', range: '>=0.5.0' }] }] }), fabric({ file: 'e.jar', mods: [{ id: 'embeddium', version: '0.3.0', provides: ['sodium'] }] })],
      pack('fabric', '1.20.1', '0.16.5'),
      true,
    ],
    [
      'absent dependency is E-MISSING-DEP, not E-DEP-RANGE',
      [fabric({ file: 'x.jar', mods: [{ id: 'x', deps: [{ id: 'sodium', range: '>=0.5.0' }] }] })],
      pack('fabric', '1.20.1', '0.16.5'),
      false,
    ],
  ])('%s', (_name, jars, p, expected) => {
    expect(outOfRange(jars, p)).toHaveLength(expected ? 1 : 0);
  });

  it('names both jars and the installed version', () => {
    const x = forge({ file: 'x.jar', mods: [{ id: 'x', name: 'X Mod', deps: [{ id: 'geckolib', range: '[4.4,)' }] }] });
    const g = forge({ file: 'geckolib-4.2.1.jar', mods: [{ id: 'geckolib', version: '4.2.1' }] });
    const [f] = outOfRange([x, g], pack('forge', '1.20.1', '47.3.0'));
    expect(f?.culprits).toEqual([
      { jarId: 'mods/x.jar', fileName: 'x.jar', modId: 'x' },
      { jarId: 'mods/geckolib-4.2.1.jar', fileName: 'geckolib-4.2.1.jar', modId: 'geckolib' },
    ]);
    expect(f?.title).toBe('X Mod needs "geckolib" 4.4 or newer; you have 4.2.1 (geckolib-4.2.1.jar)');
    expect(highlighted(f)).toEqual(['modId="geckolib"', 'versionRange="[4.4,)"']);
  });

  it('JarJar: FML keeps the highest copy inside every declared range, so a newer copy elsewhere satisfies', () => {
    const a = forge({ file: 'a.jar', mods: [{ id: 'a', deps: [{ id: 'mixinextras', range: '[0.3.5,)' }] }] });
    const oldCopy = nested(a, { file: 'mixinextras-0.2.0.jar', mods: [{ id: 'mixinextras', version: '0.2.0' }], jarjar: { group: 'io.github.llamalad7', artifact: 'mixinextras-forge', range: '[0.2.0,)', version: '0.2.0' } });
    const b = forge({ file: 'b.jar', mods: [{ id: 'b' }] });
    const newCopy = nested(b, { file: 'mixinextras-0.3.6.jar', mods: [{ id: 'mixinextras', version: '0.3.6' }], jarjar: { group: 'io.github.llamalad7', artifact: 'mixinextras-forge', range: '[0.3.0,)', version: '0.3.6' } });
    const p = pack('forge', '1.20.1', '47.3.0');
    expect(outOfRange([a, oldCopy, b, newCopy], p)).toEqual([]);
    // Without the newer copy the selected (only) copy is out of range.
    const a2 = forge({ file: 'a.jar', mods: [{ id: 'a', deps: [{ id: 'mixinextras', range: '[0.3.5,)' }] }] });
    const only02 = nested(a2, { file: 'mixinextras-0.2.0.jar', mods: [{ id: 'mixinextras', version: '0.2.0' }], jarjar: { group: 'io.github.llamalad7', artifact: 'mixinextras-forge', range: '[0.2.0,)', version: '0.2.0' } });
    expect(outOfRange([a2, only02], p)).toHaveLength(1);
  });

  it('JarJar: a copy outside another copy\'s range is not the one selected', () => {
    // b pins [0.2,0.3): FML must pick 0.2.0, which is outside a's [0.3.5,).
    const a = forge({ file: 'a.jar', mods: [{ id: 'a', deps: [{ id: 'lib', range: '[0.3.5,)' }] }] });
    const c1 = nested(a, { file: 'lib-0.3.6.jar', mods: [{ id: 'lib', version: '0.3.6' }], jarjar: { group: 'g', artifact: 'lib', range: '[0.3.5,)', version: '0.3.6' } });
    const b = forge({ file: 'b.jar', mods: [{ id: 'b' }] });
    const c2 = nested(b, { file: 'lib-0.2.0.jar', mods: [{ id: 'lib', version: '0.2.0' }], jarjar: { group: 'g', artifact: 'lib', range: '[0.2,0.3)', version: '0.2.0' } });
    // No copy satisfies both ranges → highest (0.3.6) is selected → in range for a.
    expect(outOfRange([a, c1, b, c2], pack('forge', '1.20.1', '47.3.0'))).toEqual([]);
  });

  it('a top-level copy wins over bundled copies', () => {
    const x = fabric({ file: 'x.jar', mods: [{ id: 'x', deps: [{ id: 'cloth-config', range: '>=11' }] }] });
    const bundled = nested(x, { file: 'cloth-11.jar', mods: [{ id: 'cloth-config', version: '11.1.0' }] }, 'fabric');
    const top = fabric({ file: 'cloth-9.jar', mods: [{ id: 'cloth-config', version: '9.0.0' }] });
    expect(outOfRange([x, bundled, top], pack('fabric', '1.20.1', '0.16.5'))).toHaveLength(1);
  });

  it('NeoForge 1.20.1 pack: Forge-classified mods are checked like native ones', () => {
    const x = jar({ file: 'x.jar', mods: [{ id: 'x', loader: 'forge', deps: [{ id: 'curios', range: '[5.4,)' }] }] });
    const c = neoforge({ file: 'curios.jar', mods: [{ id: 'curios', version: '5.2.0', modsToml: true }] });
    expect(outOfRange([x, c], pack('neoforge', '1.20.1', '47.1.106'))).toHaveLength(1);
  });
});
