import { describe, expect, it } from 'vitest';
import type { JarRecord, MrProject, MrVersion } from '../../../bindings';
import type { PackContext } from '../../model';
import { fabric, forge, highlighted, modrinth, mrProject, mrVersion, neoforge, nested, notes, only, pack, quilt, run } from './fixtures';

describe('E-INCOMPAT', () => {
  const fp = pack('fabric', '1.20.1', '0.16.5');

  it.each<[string, JarRecord[], PackContext, 'error' | 'warning' | null]>([
    [
      'Fabric breaks, target in range → error',
      [fabric({ file: 'sodium.jar', mods: [{ id: 'sodium', deps: [{ id: 'optifabric', kind: 'breaks', range: '*' }] }] }), fabric({ file: 'optifabric.jar', mods: [{ id: 'optifabric', version: '1.14.3' }] })],
      fp,
      'error',
    ],
    [
      'Fabric breaks, target outside the range → nothing',
      [fabric({ file: 'a.jar', mods: [{ id: 'a', deps: [{ id: 'b', kind: 'breaks', range: '<2.0' }] }] }), fabric({ file: 'b.jar', mods: [{ id: 'b', version: '2.1.0' }] })],
      fp,
      null,
    ],
    [
      'Fabric conflicts → warning (loader only warns)',
      [fabric({ file: 'a.jar', mods: [{ id: 'a', deps: [{ id: 'b', kind: 'conflicts' }] }] }), fabric({ file: 'b.jar', mods: [{ id: 'b' }] })],
      fp,
      'warning',
    ],
    [
      'Forge incompatible with Maven range → error',
      [forge({ file: 'a.jar', mods: [{ id: 'a', deps: [{ id: 'rubidium', kind: 'incompatible', range: '[0.6,)' }] }] }), forge({ file: 'r.jar', mods: [{ id: 'rubidium', version: '0.7.1' }] })],
      pack('forge', '1.20.1', '47.3.0'),
      'error',
    ],
    [
      'NeoForge discouraged → warning',
      [neoforge({ file: 'a.jar', mods: [{ id: 'a', deps: [{ id: 'b', kind: 'conflicts', range: '[1,)' }] }] }), neoforge({ file: 'b.jar', mods: [{ id: 'b', version: '1.2' }] })],
      pack('neoforge', '1.21.1', '21.1.77'),
      'warning',
    ],
    [
      'Quilt breaks → error',
      [quilt({ file: 'a.jar', mods: [{ id: 'a', deps: [{ id: 'b', kind: 'incompatible', range: '*' }] }] }), quilt({ file: 'b.jar', mods: [{ id: 'b' }] })],
      pack('quilt', '1.20.1', '0.26.0'),
      'error',
    ],
    [
      'target absent → nothing',
      [fabric({ file: 'a.jar', mods: [{ id: 'a', deps: [{ id: 'b', kind: 'breaks' }] }] })],
      fp,
      null,
    ],
    [
      'target only in a disabled jar → nothing',
      [fabric({ file: 'a.jar', mods: [{ id: 'a', deps: [{ id: 'b', kind: 'breaks' }] }] }), fabric({ file: 'b.jar', disabled: true, mods: [{ id: 'b' }] })],
      fp,
      null,
    ],
  ])('%s', (_name, jars, p, severity) => {
    const found = only(run(jars, p), 'E-INCOMPAT');
    if (severity === null) expect(found).toEqual([]);
    else expect(found.map((f) => f.severity)).toEqual([severity]);
  });

  it('a bundled target counts; culprits and fixes name both top-level jars', () => {
    const a = fabric({ file: 'a.jar', mods: [{ id: 'a', name: 'Alpha', deps: [{ id: 'oldlib', kind: 'breaks', range: '<3' }] }] });
    const host = fabric({ file: 'host.jar', mods: [{ id: 'host' }] });
    const lib = nested(host, { file: 'oldlib.jar', mods: [{ id: 'oldlib', name: 'Old Lib', version: '2.0.0' }] }, 'fabric');
    const [f] = only(run([a, host, lib], fp), 'E-INCOMPAT');
    expect(f?.title).toBe('Alpha is incompatible with Old Lib');
    expect(f?.culprits).toEqual([
      { jarId: 'mods/a.jar', fileName: 'a.jar', modId: 'a' },
      { jarId: 'mods/host.jar', fileName: 'host.jar', modId: 'oldlib' },
    ]);
    expect(f?.fixes).toEqual([
      { kind: 'disable', jarId: 'mods/host.jar' },
      { kind: 'disable', jarId: 'mods/a.jar' },
    ]);
    expect(highlighted(f)).toEqual(['"oldlib": "<3"']);
  });

  it('entries inside the declaring jar are ignored', () => {
    const a = fabric({ file: 'a.jar', mods: [{ id: 'a', deps: [{ id: 'inner', kind: 'breaks' }] }] });
    const inner = nested(a, { file: 'inner.jar', mods: [{ id: 'inner' }] }, 'fabric');
    expect(only(run([a, inner], fp), 'E-INCOMPAT')).toEqual([]);
  });
});

describe('W-CLIENT-ON-SERVER', () => {
  const server = pack('fabric', '1.20.1', '0.16.5', 'server');

  it('Fabric environment "client" on a server', () => {
    const j = fabric({ file: 'sodium.jar', mods: [{ id: 'sodium', name: 'Sodium', env: 'client' }] });
    const [f] = only(run([j], server), 'W-CLIENT-ON-SERVER');
    expect(f).toMatchObject({ severity: 'warning', title: 'Sodium is a client-only mod on a server', fixes: [{ kind: 'disable', jarId: 'mods/sodium.jar' }] });
    expect(highlighted(f)).toEqual(['"environment": "client",']);
  });

  it('Forge clientSideOnly on a server', () => {
    const j = forge({ file: 'oculus.jar', mods: [{ id: 'oculus', env: 'client' }] });
    const [f] = only(run([j], pack('forge', '1.20.1', '47.3.0', 'server')), 'W-CLIENT-ON-SERVER');
    expect(highlighted(f)).toEqual(['clientSideOnly=true']);
  });

  it('not on a client, and not for mods that run on both sides', () => {
    const c = fabric({ file: 'c.jar', mods: [{ id: 'c', env: 'client' }] });
    const both = fabric({ file: 'b.jar', mods: [{ id: 'b' }] });
    expect(only(run([c], pack('fabric', '1.20.1')), 'W-CLIENT-ON-SERVER')).toEqual([]);
    expect(only(run([both], server), 'W-CLIENT-ON-SERVER')).toEqual([]);
  });

  const viaModrinth = (version: Partial<MrVersion>, project?: Partial<MrProject>) => {
    const j = fabric({ file: 'zoomify.jar', mods: [{ id: 'zoomify', name: 'Zoomify' }] });
    const v = mrVersion({ projectId: 'P1', versionNumber: '2.14.0', ...version });
    const ctx = modrinth({ versions: { [j.sha1]: v }, projects: project ? { P1: mrProject({ id: 'P1', title: 'Zoomify', ...project }) } : {} });
    return only(run([j], server, ctx), 'W-CLIENT-ON-SERVER');
  };

  it.each<[string, Partial<MrVersion>, Partial<MrProject> | undefined, boolean]>([
    ['version environment client_only', { environment: 'client_only' }, undefined, true],
    ['version environment singleplayer_only', { environment: 'singleplayer_only' }, undefined, true],
    ['version environment client_only_server_optional (loads on a server)', { environment: 'client_only_server_optional' }, undefined, false],
    ['version environment client_and_server', { environment: 'client_and_server' }, undefined, false],
    ['version env wins over the project list', { environment: 'client_and_server' }, { environment: ['client_only'] }, false],
    ['unknown version env → project environment list', { environment: 'unknown' }, { environment: ['client_only'] }, true],
    ['no env → project mixed list is not client-only', { environment: null }, { environment: ['client_only', 'client_and_server'] }, false],
    ['no env anywhere → legacy server_side unsupported', { environment: null }, { clientSide: 'required', serverSide: 'unsupported' }, true],
    ['legacy server_side optional', { environment: null }, { clientSide: 'required', serverSide: 'optional' }, false],
  ])('Modrinth: %s', (_name, version, project, expected) => {
    expect(viaModrinth(version, project)).toHaveLength(expected ? 1 : 0);
  });

  it('Modrinth verdict is quoted as a note', () => {
    const [f] = viaModrinth({ environment: 'client_only' });
    expect(notes(f)[0]).toBe('Modrinth lists version 2.14.0 as "client_only".');
  });

  it('nested jars and disabled jars are not reported', () => {
    const host = fabric({ file: 'host.jar', mods: [{ id: 'host' }] });
    const inner = nested(host, { file: 'inner.jar', mods: [{ id: 'inner', env: 'client' }] }, 'fabric');
    const off = fabric({ file: 'off.jar', disabled: true, mods: [{ id: 'off', env: 'client' }] });
    expect(only(run([host, inner, off], server), 'W-CLIENT-ON-SERVER')).toEqual([]);
  });
});
