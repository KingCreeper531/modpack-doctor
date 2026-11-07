/**
 * M7 review of the `.mrpack` declared-file checks: E-MISSING-DEP is a warning, knows that Quilted
 * Fabric API provides Fabric API, skips dependencies of another loader's build; two index entries
 * with one path → the last one counts.
 */
import { describe, expect, it } from 'vitest';
import type { DeclaredFile, JarRecord, LoaderKind, MrDependency, MrVersion } from '../../../bindings';
import type { CheckInput, Finding, ModrinthContext, PackContext } from '../../model';
import { runChecks } from '../index';
import { declaredFiles, mrpackDeclaredCheck } from '../mrpackDeclared';
import { mrpackDownloadCheck } from '../mrpackDownload';
import { fabric, instance, modrinth, mrProject, mrVersion, scan, sha1Of } from './fixtures';

const FABRIC_API = 'P7dR8mSH';
const QFAPI = 'qvIfYCYJ';

function declared(path: string, over: Partial<DeclaredFile> = {}): DeclaredFile {
  return {
    path,
    sha1: sha1Of(`declared:${path}`),
    sha512: '0'.repeat(128),
    size: 1000,
    client: 'required',
    server: 'required',
    downloads: [`https://cdn.modrinth.com/data/AAAAAAAA/versions/BBBBBBBB/${path.split('/').pop() ?? path}`],
    ...over,
  };
}

function mrPack(loader: LoaderKind | null, mc = '1.20.1'): PackContext {
  return { mcVersion: mc, loader: loader ? { kind: loader, version: null } : null, side: 'client', source: 'mrpack' };
}

function packInput(files: DeclaredFile[], p: PackContext, mr?: ModrinthContext, jars: JarRecord[] = []): CheckInput {
  return {
    instance: instance({ launcher: 'mrpack', metadataSource: 'mrpack', root: '/p/pack.mrpack', gameDir: '/p/pack.mrpack', mcVersion: p.mcVersion, loader: p.loader }),
    scan: { ...scan(...jars), declared: files },
    pack: p,
    ...(mr ? { modrinth: mr } : {}),
  };
}

function identified(entries: [DeclaredFile | JarRecord, Partial<MrVersion> & { projectId: string }][], over: Partial<ModrinthContext> = {}): ModrinthContext {
  const versions: Record<string, MrVersion> = {};
  for (const [f, v] of entries) versions[f.sha1] = mrVersion({ id: `ver-${v.projectId}`, ...v });
  return modrinth({ versions, ...over });
}

const req = (projectId: string): MrDependency => ({ projectId, versionId: null, fileName: null, dependencyType: 'required' });
const missingDeps = (found: readonly Finding[]) => found.filter((f) => f.code === 'E-MISSING-DEP');

const mod = declared('mods/mod.jar');

describe('declared E-MISSING-DEP severity', () => {
  it('is a warning (a jar Modrinth cannot see into may provide it), worded as such', () => {
    const mr = identified([[mod, { projectId: 'MODPROJ1', dependencies: [req('DEPPROJ1')] }]], {
      projects: { DEPPROJ1: mrProject({ id: 'DEPPROJ1', slug: 'dep', title: 'Dep' }) },
    });
    const [f, ...rest] = missingDeps(mrpackDeclaredCheck.run(packInput([mod], mrPack('fabric'), mr)));
    expect(rest).toEqual([]);
    expect(f?.severity).toBe('warning');
    expect(f?.title).toBe('mod.jar requires Dep, which the pack does not seem to include');
    expect(f?.explanation).toContain('Another file may still provide it under a different name');
    expect(f?.fixes).toEqual([]);
  });
});

describe('declared E-MISSING-DEP provider equivalence', () => {
  it('Quilted Fabric API (declared) provides Fabric API', () => {
    const qfapi = declared('mods/qfapi.jar');
    const mr = identified([
      [mod, { projectId: 'MODPROJ1', loaders: ['fabric', 'quilt'], dependencies: [req(FABRIC_API)] }],
      [qfapi, { projectId: QFAPI, loaders: ['quilt'] }],
    ]);
    expect(missingDeps(runChecks(packInput([mod, qfapi], mrPack('quilt'), mr)))).toEqual([]);
  });

  it('Quilted Fabric API (identified override jar) provides Fabric API', () => {
    const jar = { ...fabric({ file: 'qfapi.jar', mods: [{ id: 'quilted_fabric_api' }] }), id: 'overrides/mods/qfapi.jar', path: 'overrides/mods/qfapi.jar' };
    const mr = identified([
      [mod, { projectId: 'MODPROJ1', loaders: ['fabric'], dependencies: [req(FABRIC_API)] }],
      [jar, { projectId: QFAPI, loaders: ['quilt'] }],
    ]);
    expect(missingDeps(runChecks(packInput([mod], mrPack('quilt'), mr, [jar])))).toEqual([]);
  });

  it('the reverse does not hold: Fabric API does not provide Quilted Fabric API', () => {
    const api = declared('mods/fabric-api.jar');
    const mr = identified([
      [mod, { projectId: 'MODPROJ1', loaders: ['quilt'], dependencies: [req(QFAPI)] }],
      [api, { projectId: FABRIC_API }],
    ]);
    expect(missingDeps(runChecks(packInput([mod, api], mrPack('quilt'), mr)))).toHaveLength(1);
  });
});

describe('declared E-MISSING-DEP and the pack loader family', () => {
  it('skips Fabric API listed by a multi-loader version on a Forge / NeoForge pack', () => {
    for (const loader of ['forge', 'neoforge'] as const) {
      const mr = identified([[mod, { projectId: 'MODPROJ1', loaders: ['fabric', 'forge', 'neoforge'], dependencies: [req(FABRIC_API), req('ARCHPROJ')] }]]);
      const found = missingDeps(mrpackDeclaredCheck.run(packInput([mod], mrPack(loader), mr)));
      // Fabric API is skipped; a loader-neutral dependency is still reported.
      expect(found.map((f) => f.title)).toEqual(['mod.jar requires Modrinth project ARCHPROJ, which the pack does not seem to include']);
    }
  });

  it('still reports Fabric API on a Fabric or Quilt pack', () => {
    for (const loader of ['fabric', 'quilt'] as const) {
      const mr = identified([[mod, { projectId: 'MODPROJ1', loaders: ['fabric', 'forge'], dependencies: [req(FABRIC_API)] }]]);
      expect(missingDeps(mrpackDeclaredCheck.run(packInput([mod], mrPack(loader), mr)))).toHaveLength(1);
    }
  });

  it('skips every dependency of a version whose mod loaders exclude the pack loader (E-WRONG-LOADER covers it)', () => {
    const mr = identified([[mod, { projectId: 'MODPROJ1', loaders: ['fabric'], dependencies: [req(FABRIC_API), req('OTHERDEP')] }]]);
    const found = mrpackDeclaredCheck.run(packInput([mod], mrPack('forge'), mr));
    expect(found.map((f) => f.code)).toEqual(['E-WRONG-LOADER']);
  });

  it('does not skip on an unknown or vanilla pack loader', () => {
    for (const p of [mrPack(null), mrPack('unknown')]) {
      const mr = identified([[mod, { projectId: 'MODPROJ1', loaders: ['fabric'], dependencies: [req(FABRIC_API)] }]]);
      expect(missingDeps(mrpackDeclaredCheck.run(packInput([mod], p, mr)))).toHaveLength(1);
    }
  });

  it('versions listing only non-mod loaders keep their dependencies', () => {
    const rp = declared('resourcepacks/x.zip');
    const mr = identified([[rp, { projectId: 'RPPROJ01', loaders: ['minecraft'], dependencies: [req('OTHERDEP')] }]]);
    expect(missingDeps(mrpackDeclaredCheck.run(packInput([rp], mrPack('forge'), mr)))).toHaveLength(1);
  });
});

describe('two index entries with one path', () => {
  const first = declared('mods/dup.jar', { sha1: sha1Of('first'), downloads: ['https://evil.example/first.jar'] });
  const last = declared('mods/dup.jar', { sha1: sha1Of('last'), downloads: ['https://cdn.modrinth.com/data/A/versions/B/dup.jar'] });

  it('declaredFiles keeps the last', () => {
    expect(declaredFiles(packInput([first, last], mrPack('fabric')))).toEqual([last]);
    expect(declaredFiles(packInput([last, first], mrPack('fabric')))).toEqual([first]);
  });

  it('the checks look at the last entry only, but the shadowed entry\'s links are still checked', () => {
    const shadowed = mrpackDownloadCheck.run(packInput([first, last], mrPack('fabric')));
    // A launcher still downloads the first entry before the last overwrites it.
    expect(shadowed.map((f) => [f.culprits[0]?.jarId, f.title])).toEqual([
      ['mods/dup.jar', "Unchecked index entry dup.jar downloads from evil.example outside Modrinth's allowed hosts"],
    ]);
    expect(mrpackDownloadCheck.run(packInput([last, first], mrPack('fabric'))).map((f) => f.title)).toEqual([
      "dup.jar downloads from evil.example outside Modrinth's allowed hosts",
    ]);
    const mr = identified([
      [first, { projectId: 'FIRSTPRJ', loaders: ['forge'] }],
      [last, { projectId: 'LASTPRJ1', loaders: ['fabric'] }],
    ]);
    expect(mrpackDeclaredCheck.run(packInput([first, last], mrPack('fabric'), mr))).toEqual([]);
    expect(mrpackDeclaredCheck.run(packInput([last, first], mrPack('fabric'), mr)).map((f) => f.code)).toEqual(['E-WRONG-LOADER']);
  });
});
