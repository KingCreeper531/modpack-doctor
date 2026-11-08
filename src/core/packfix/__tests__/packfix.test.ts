/**
 * Edits for the fixed copy of an opened `.mrpack` (`Finding.packEdits`), per finding type, through
 * the real `runChecks`: declared files (replace / remove / add a dependency) and override jars
 * (remove). Instance findings never get any, and pack findings never keep instance fixes.
 */
import { describe, expect, it } from 'vitest';

import type { DeclaredFile, JarRecord, MrVersion } from '../../../bindings';
import { fabric, forge, instance, modrinth, mrProject, mrVersion, pack, scan, sha1Of } from '../../checks/__tests__/fixtures';
import { runChecks } from '../../checks';
import type { CheckInput, Finding, ModrinthContext, PackContext } from '../../model';
import { forPack, isOverrideJarPath, packEditKey, suggestionKey } from '../index';

const PACK: PackContext = { mcVersion: '1.20.1', loader: { kind: 'fabric', version: '0.15.11' }, side: 'client', source: 'mrpack' };

function declared(path: string, over: Partial<DeclaredFile> = {}): DeclaredFile {
  return {
    path,
    sha1: sha1Of(`declared:${path}`),
    sha512: '0'.repeat(128),
    size: 1000,
    client: 'required',
    server: 'required',
    downloads: [`https://cdn.modrinth.com/data/AAAAAAAA/versions/BBBBBBBB/${path.split('/').pop()}`],
    ...over,
  };
}

function packInput(files: DeclaredFile[], mr?: ModrinthContext, jars: JarRecord[] = [], p: PackContext = PACK): CheckInput {
  return {
    instance: instance({ launcher: 'mrpack', metadataSource: 'mrpack', mcVersion: p.mcVersion, loader: p.loader }),
    scan: { ...scan(...jars), declared: files },
    pack: p,
    ...(mr ? { modrinth: mr } : {}),
  };
}

/** An override jar (`overrides/mods/<file>` unless `dir` says otherwise). */
function override(j: JarRecord, dir = 'overrides/mods'): JarRecord {
  const path = `${dir}/${j.fileName}`;
  return { ...j, id: path, path };
}

function file(version: string): MrVersion['files'][number] {
  return {
    url: `https://cdn.modrinth.com/data/PROJ0001/versions/${version}/x-${version}.jar`,
    filename: `x-${version}.jar`,
    size: 4096,
    primary: true,
    sha1: '1'.repeat(40),
    sha512: '2'.repeat(128),
    fileType: null,
  };
}

const OLD_DATE = '2024-01-01T00:00:00Z';
const NEW_DATE = '2024-06-01T00:00:00Z';

/** The declared file is version CUR of PROJ0001 (`over`); `update` is the context's update. */
function ctxFor(f: DeclaredFile, over: Partial<MrVersion>, update?: Partial<MrVersion>): ModrinthContext {
  const current = mrVersion({ id: 'CURver01', projectId: 'PROJ0001', datePublished: OLD_DATE, ...over });
  const updates: Record<string, MrVersion> = {};
  if (update) updates[f.sha1] = mrVersion({ id: 'NEWver01', projectId: 'PROJ0001', versionNumber: '2.0.0', datePublished: NEW_DATE, files: [file('2.0.0')], ...update });
  return modrinth({ versions: { [f.sha1]: current }, updates, projects: { PROJ0001: mrProject({ id: 'PROJ0001', title: 'Thing' }) } });
}

const labels = (f: Finding | undefined) => (f?.packEdits ?? []).map((s) => s.label);
const byCode = (findings: Finding[], code: Finding['code']) => findings.filter((f) => f.code === code);

describe('declared files', () => {
  const x = declared('mods/x-1.0.0.jar');

  it.each<[Finding['code'], Partial<MrVersion>]>([
    ['E-WRONG-LOADER', { loaders: ['forge'] }],
    ['E-MC-RANGE', { gameVersions: ['1.19.2'] }],
  ])('%s → replace with the newer compatible version, then remove', (code, over) => {
    const [f] = byCode(runChecks(packInput([x], ctxFor(x, over, { loaders: ['fabric'], gameVersions: ['1.20.1'] }))), code);
    expect(f?.fixes).toEqual([]);
    expect(f?.packEdits).toEqual([
      { kind: 'edit', label: 'Replace with 2.0.0', edit: { kind: 'replaceDeclared', path: 'mods/x-1.0.0.jar', versionId: 'NEWver01' } },
      { kind: 'edit', label: 'Remove x-1.0.0.jar', edit: { kind: 'removeDeclared', path: 'mods/x-1.0.0.jar' } },
    ]);
  });

  it.each<[string, Partial<MrVersion> | undefined]>([
    ['no update in the context', undefined],
    ['an update without a download file', { files: [] }],
    ['an update for another loader', { loaders: ['forge'] }],
    ['an update for another Minecraft version', { gameVersions: ['1.19.2'] }],
    ['an older "update" (a downgrade)', { datePublished: '2023-01-01T00:00:00Z' }],
    ['an update of another project', { projectId: 'OTHER001' }],
  ])('only remove with %s', (_name, update) => {
    const [f] = byCode(runChecks(packInput([x], ctxFor(x, { loaders: ['forge'] }, update))), 'E-WRONG-LOADER');
    expect(labels(f)).toEqual(['Remove x-1.0.0.jar']);
  });

  it('E-MISSING-DEP → add the dependency project (resolved by the UI)', () => {
    const dep = { projectId: 'DEPprj01', versionId: null, fileName: null, dependencyType: 'required' };
    const mr = ctxFor(x, { dependencies: [dep] });
    mr.projects.DEPprj01 = mrProject({ id: 'DEPprj01', title: 'Cloth Config API', slug: 'cloth-config' });
    const [f] = byCode(runChecks(packInput([x], mr)), 'E-MISSING-DEP');
    expect(f?.severity).toBe('warning');
    expect(f?.packEdits).toEqual([{ kind: 'addProject', label: 'Add Cloth Config API', projectId: 'DEPprj01', title: 'Cloth Config API' }]);
  });

  it('I-NOT-ON-MODRINTH and W-MRPACK-DOWNLOAD offer no edits', () => {
    const odd = declared('mods/odd.jar', { downloads: ['https://example.com/odd.jar'] });
    const findings = runChecks(packInput([odd], modrinth()));
    expect(findings.map((f) => f.code).sort()).toEqual(['I-NOT-ON-MODRINTH', 'W-MRPACK-DOWNLOAD']);
    expect(findings.every((f) => !f.packEdits?.length)).toBe(true);
  });
});

describe('override jars', () => {
  it('E-WRONG-LOADER → remove the override jar', () => {
    const jar = override(forge({ file: 'forgy.jar', mods: [{ id: 'forgy' }] }));
    const [f] = byCode(runChecks(packInput([], undefined, [jar])), 'E-WRONG-LOADER');
    expect(f?.fixes).toEqual([]);
    expect(f?.packEdits).toEqual([{ kind: 'edit', label: 'Remove forgy.jar', edit: { kind: 'removeOverride', entry: 'overrides/mods/forgy.jar' } }]);
  });

  it('W-CORRUPT-JAR → remove the damaged jar (client-overrides too)', () => {
    const jar = override(fabric({ file: 'broken.jar', mods: [], status: { state: 'corrupt', reason: 'not a zip file' } }), 'client-overrides/mods');
    const [f] = byCode(runChecks(packInput([], undefined, [jar])), 'W-CORRUPT-JAR');
    expect(f?.packEdits?.map((s) => (s.kind === 'edit' ? s.edit : null))).toEqual([{ kind: 'removeOverride', entry: 'client-overrides/mods/broken.jar' }]);
  });

  it('E-MISSING-DEP that is truly missing (error) → remove the jar that needs it', () => {
    const jar = override(fabric({ file: 'addon.jar', mods: [{ id: 'addon', deps: [{ id: 'base' }] }] }));
    const [f] = byCode(runChecks(packInput([], undefined, [jar])), 'E-MISSING-DEP');
    expect(f?.severity).toBe('error');
    expect(labels(f)).toEqual(['Remove addon.jar']);
  });

  it('E-MISSING-DEP lowered to a warning (the downloads may provide it) → no edit', () => {
    const jar = override(fabric({ file: 'addon.jar', mods: [{ id: 'addon', deps: [{ id: 'base' }] }] }));
    const [f] = byCode(runChecks(packInput([declared('mods/unknown-thing.jar')], undefined, [jar])), 'E-MISSING-DEP');
    expect(f?.severity).toBe('warning');
    expect(f?.packEdits ?? []).toEqual([]);
  });

  it('E-DUP-ID → remove the copies the duplicate fixes remove; the instance fixes are gone', () => {
    const older = override(fabric({ file: 'dup-1.0.jar', mods: [{ id: 'dup', version: '1.0.0' }] }));
    const newer = override(fabric({ file: 'dup-2.0.jar', mods: [{ id: 'dup', version: '2.0.0' }] }));
    const [f] = byCode(runChecks(packInput([], undefined, [older, newer])), 'E-DUP-ID');
    expect(f?.fixes).toEqual([]);
    expect(f?.packEdits).toEqual([{ kind: 'edit', label: 'Remove dup-1.0.jar', edit: { kind: 'removeOverride', entry: 'overrides/mods/dup-1.0.jar' } }]);
  });

  it('jars outside an override mods folder, and other codes, get nothing', () => {
    const stray = { ...forge({ file: 'stray.jar', mods: [{ id: 'stray' }] }), id: 'overrides/stray.jar', path: 'overrides/stray.jar' };
    const [f] = byCode(runChecks(packInput([], undefined, [stray])), 'E-WRONG-LOADER');
    expect(f?.packEdits ?? []).toEqual([]);
  });
});

describe('instances', () => {
  it('keep their fixes and get no pack edits', () => {
    const jar = forge({ file: 'forgy.jar', mods: [{ id: 'forgy' }] });
    const [f] = byCode(runChecks({ instance: instance(), scan: scan(jar), pack: pack('fabric', '1.20.1') }), 'E-WRONG-LOADER');
    expect(f?.fixes.length).toBeGreaterThan(0);
    expect(f?.packEdits).toBeUndefined();
  });
});

describe('helpers', () => {
  it('override jar paths', () => {
    for (const ok of ['overrides/mods/a.jar', 'client-overrides/mods/a.JAR', 'server-overrides/MODS/a.jar']) expect(isOverrideJarPath(ok), ok).toBe(true);
    for (const bad of ['mods/a.jar', 'overrides/a.jar', 'overrides/mods/sub/a.jar', 'overrides/mods/a.zip', 'overrides/mods/', 'xoverrides/mods/a.jar']) {
      expect(isOverrideJarPath(bad), bad).toBe(false);
    }
  });

  it('one key per subject (as Rust refuses two edits of one subject)', () => {
    expect(packEditKey({ kind: 'removeDeclared', path: 'mods/a.jar' })).toBe(packEditKey({ kind: 'replaceDeclared', path: 'mods/a.jar', versionId: 'X' }));
    expect(packEditKey({ kind: 'removeOverride', entry: 'overrides/mods/a.jar' })).not.toBe(packEditKey({ kind: 'removeDeclared', path: 'overrides/mods/a.jar' }));
    expect(packEditKey({ kind: 'addDependency', versionId: 'A' })).not.toBe(packEditKey({ kind: 'addDependency', versionId: 'B' }));
  });

  it('forPack merges without duplicates and leaves edit-free findings alone', () => {
    const jar = override(forge({ file: 'forgy.jar', mods: [{ id: 'forgy' }] }));
    const input = packInput([], undefined, [jar]);
    const f: Finding = {
      id: 'x',
      code: 'E-WRONG-LOADER',
      severity: 'error',
      title: 't',
      explanation: 'e',
      culprits: [{ jarId: jar.id, fileName: jar.fileName }],
      evidence: [],
      fixes: [{ kind: 'disable', jarId: jar.id }],
      packEdits: [{ kind: 'edit', label: 'Remove forgy.jar', edit: { kind: 'removeOverride', entry: jar.path } }],
    };
    const out = forPack(f, input);
    expect(out.fixes).toEqual([]);
    expect(out.packEdits?.map(suggestionKey)).toEqual([JSON.stringify({ kind: 'removeOverride', entry: jar.path })]);
    const plain: Finding = { ...f, code: 'I-SPLIT-PKG', fixes: [], packEdits: undefined };
    delete plain.packEdits;
    expect(forPack(plain, input)).toBe(plain);
  });
});
