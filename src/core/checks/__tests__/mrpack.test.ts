/**
 * `.mrpack` declared files (CONTRACTS invariant 15): E-WRONG-LOADER, E-MC-RANGE, E-MISSING-DEP,
 * I-NOT-ON-MODRINTH from Modrinth data, W-MRPACK-DOWNLOAD from the index URLs. No fixes ever.
 */
import { describe, expect, it } from 'vitest';
import type { DeclaredFile, JarRecord, LoaderKind, MrDependency, MrVersion } from '../../../bindings';
import { findingId } from '../../crash/id';
import type { CheckInput, Finding, ModrinthContext, PackContext } from '../../model';
import { enrichFindings } from '../../modrinth';
import { runChecks } from '../index';
import { mrpackDeclaredCheck } from '../mrpackDeclared';
import { classifyDownloadUrl, mrpackDownloadCheck } from '../mrpackDownload';
import { fabric, instance, modrinth, mrProject, mrVersion, notes, scan, sha1Of } from './fixtures';

function declared(path: string, over: Partial<DeclaredFile> = {}): DeclaredFile {
  const name = path.split('/').pop() ?? path;
  return {
    path,
    sha1: sha1Of(`declared:${path}`),
    sha512: '0'.repeat(128),
    size: 1000,
    client: 'required',
    server: 'required',
    downloads: [`https://cdn.modrinth.com/data/AAAAAAAA/versions/BBBBBBBB/${name}`],
    ...over,
  };
}

function mrPack(loader: LoaderKind | null, mc: string | null, version: string | null = null): PackContext {
  return { mcVersion: mc, loader: loader ? { kind: loader, version } : null, side: 'client', source: 'mrpack' };
}

function packInput(files: DeclaredFile[], p: PackContext, mr?: ModrinthContext, jars: JarRecord[] = []): CheckInput {
  return {
    instance: instance({
      launcher: 'mrpack',
      metadataSource: 'mrpack',
      root: 'C:\\Users\\Bob\\Downloads\\pack.mrpack',
      gameDir: 'C:\\Users\\Bob\\Downloads\\pack.mrpack',
      mcVersion: p.mcVersion,
      loader: p.loader,
    }),
    scan: { ...scan(...jars), declared: files },
    pack: p,
    ...(mr ? { modrinth: mr } : {}),
  };
}

/** Findings whose culprits are declared files (by index path). */
function onDeclared(findings: readonly Finding[], files: readonly DeclaredFile[]): Finding[] {
  const paths = new Set(files.map((f) => f.path));
  return findings.filter((f) => f.culprits.some((c) => paths.has(c.jarId)));
}

function identified(entries: [DeclaredFile | JarRecord, Partial<MrVersion> & { projectId: string }][], over: Partial<ModrinthContext> = {}): ModrinthContext {
  const versions: Record<string, MrVersion> = {};
  for (const [f, v] of entries) versions[f.sha1] = mrVersion({ id: `ver-${v.projectId}`, ...v });
  return modrinth({ versions, ...over });
}

const SODIUM = declared('mods/sodium-fabric-0.5.8+mc1.20.1.jar');

describe('E-WRONG-LOADER on declared files', () => {
  it.each<[string, LoaderKind | null, string, string[], string, boolean]>([
    ['Forge-only mod on Fabric', 'fabric', '1.20.1', ['forge'], 'mods/x.jar', true],
    ['Fabric mod on Fabric', 'fabric', '1.20.1', ['fabric'], 'mods/x.jar', false],
    ['Fabric mod on Quilt (Quilt loads Fabric mods)', 'quilt', '1.20.1', ['fabric'], 'mods/x.jar', false],
    ['Quilt-only mod on Fabric', 'fabric', '1.20.1', ['quilt'], 'mods/x.jar', true],
    ['Forge mod on NeoForge 1.20.1', 'neoforge', '1.20.1', ['forge'], 'mods/x.jar', false],
    ['NeoForge mod on Forge 1.20.1', 'forge', '1.20.1', ['neoforge'], 'mods/x.jar', false],
    ['Forge mod on NeoForge 1.21.1', 'neoforge', '1.21.1', ['forge'], 'mods/x.jar', true],
    ['NeoForge mod on Forge 1.20.4', 'forge', '1.20.4', ['neoforge'], 'mods/x.jar', true],
    ['Fabric-only mod on Forge', 'forge', '1.20.1', ['fabric'], 'mods/x.jar', true],
    ['multi-loader version', 'neoforge', '1.21.1', ['fabric', 'neoforge'], 'mods/x.jar', false],
    ['legacy Forge 1.12.2', 'legacyforge', '1.12.2', ['forge'], 'mods/x.jar', false],
    ['vanilla pack: nothing (no loader to compare with)', null, '1.20.1', ['fabric'], 'mods/x.jar', false],
    ['unknown loader: nothing', 'unknown', '1.20.1', ['forge'], 'mods/x.jar', false],
    ['resource pack (loader "minecraft")', 'fabric', '1.20.1', ['minecraft'], 'resourcepacks/x.zip', false],
    ['shader pack on Fabric', 'fabric', '1.20.1', ['iris', 'optifine'], 'shaderpacks/x.zip', false],
    ['data pack in mods/ (no mod loader listed)', 'fabric', '1.20.1', ['datapack'], 'mods/x.jar', false],
    ['Forge mod listed for a non-mod path is not judged', 'fabric', '1.20.1', ['forge'], 'resourcepacks/x.zip', false],
  ])('%s', (_name, loader, mc, loaders, path, expected) => {
    const file = declared(path);
    const mr = identified([[file, { projectId: 'PROJ0001', loaders, gameVersions: [mc] }]]);
    const found = runChecks(packInput([file], mrPack(loader, mc, '1.0'), mr)).filter((f) => f.code === 'E-WRONG-LOADER');
    expect(found.length).toBe(expected ? 1 : 0);
    if (expected) {
      const f = found[0] as Finding;
      expect(f.severity).toBe('error');
      expect(f.culprits).toEqual([{ jarId: path, fileName: path.split('/').pop() }]);
      expect(f.fixes).toEqual([]);
      expect(f.id).toBe(findingId('E-WRONG-LOADER', [path], 'declared'));
      expect(notes(f)[0]).toContain(`modrinth.index.json lists ${path}`);
      expect(notes(f)[1]).toContain(`loaders: ${loaders.join(', ')}`);
    }
  });

  it('names the project title and the pack loader', () => {
    const mr = identified([[SODIUM, { projectId: 'AANobbMI', loaders: ['fabric', 'quilt'], versionNumber: 'mc1.20.1-0.5.8' }]], {
      projects: { AANobbMI: mrProject({ id: 'AANobbMI', title: 'Sodium', slug: 'sodium' }) },
    });
    const [f] = mrpackDeclaredCheck.run(packInput([SODIUM], mrPack('neoforge', '1.20.1', '47.1.106'), mr));
    expect(f?.title).toBe('Sodium is made for fabric, quilt, not this pack\'s loader');
    expect(f?.explanation).toContain('Sodium mc1.20.1-0.5.8 (version ver-AANobbMI)');
    expect(f?.explanation).toContain('NeoForge 47.1.106');
    expect(f?.explanation).toContain('switch to the NeoForge build of Sodium');
    expect(notes(f).at(-1)).toBe('Pack: NeoForge 47.1.106 on Minecraft 1.20.1 (from the .mrpack index)');
  });
});

describe('E-MC-RANGE on declared files', () => {
  it.each<[string, string | null, string[], string, 'error' | 'warning' | null]>([
    ['other version', '1.20.1', ['1.19.2', '1.19.4'], 'mods/x.jar', 'error'],
    ['exact match', '1.20.1', ['1.20', '1.20.1'], 'mods/x.jar', null],
    ['same line only (1.20, 1.20.2) → warning', '1.20.1', ['1.20', '1.20.2'], 'mods/x.jar', 'warning'],
    ['year-based same line', '26.1.2', ['26.1', '26.1.1'], 'mods/x.jar', 'warning'],
    ['year-based vs legacy', '26.1', ['1.21.11'], 'mods/x.jar', 'error'],
    ['snapshot pack, release listing', '26.4-snapshot-6', ['26.3'], 'mods/x.jar', 'error'],
    ['empty list: unknown', '1.20.1', [], 'mods/x.jar', null],
    ['unknown pack MC: nothing', null, ['1.19.2'], 'mods/x.jar', null],
    ['resource pack for another version: not judged', '1.20.1', ['1.19.2'], 'resourcepacks/x.zip', null],
  ])('%s', (_name, mc, gameVersions, path, severity) => {
    const file = declared(path);
    const mr = identified([[file, { projectId: 'PROJ0001', loaders: ['fabric'], gameVersions }]]);
    const found = mrpackDeclaredCheck.run(packInput([file], mrPack('fabric', mc), mr)).filter((f) => f.code === 'E-MC-RANGE');
    expect(found.map((f) => f.severity)).toEqual(severity ? [severity] : []);
    if (severity) {
      expect(found[0]?.fixes).toEqual([]);
      expect(found[0]?.title).toContain(`not ${mc}`);
      expect(found[0]?.id).toBe(findingId('E-MC-RANGE', [path], 'declared'));
    }
  });
});

describe('E-MISSING-DEP on declared files', () => {
  const API = 'P7dR8mSH';
  const req = (projectId: string | null, dependencyType = 'required', versionId: string | null = null): MrDependency => ({
    projectId,
    versionId,
    fileName: null,
    dependencyType,
  });
  const fabricApi = mrProject({ id: API, slug: 'fabric-api', title: 'Fabric API' });
  const mod = declared('mods/mod.jar');
  const api = declared('mods/fabric-api.jar');
  const p = mrPack('fabric', '1.20.1', '0.16.5');

  it('reports a required project nothing provides, titled from ctx.projects; no fixes, no missingModIds', () => {
    const mr = identified([[mod, { projectId: 'MODPROJ1', dependencies: [req(API)] }]], {
      projects: { [API]: fabricApi, MODPROJ1: mrProject({ id: 'MODPROJ1', slug: 'my-mod', title: 'My Mod' }) },
    });
    const found = mrpackDeclaredCheck.run(packInput([mod], p, mr)).filter((f) => f.code === 'E-MISSING-DEP');
    expect(found).toHaveLength(1);
    const f = found[0] as Finding;
    expect(f.title).toBe('My Mod requires Fabric API, which the pack does not include');
    expect(f.fixes).toEqual([]);
    expect(f.missingModIds).toBeUndefined();
    expect(f.id).toBe(findingId('E-MISSING-DEP', [mod.path], `declared:${API}`));
    expect(notes(f)).toContain(`Required dependency: Fabric API (fabric-api), project ${API}.`);
  });

  it('falls back to the project id when the dependency project is not in ctx.projects', () => {
    const mr = identified([[mod, { projectId: 'MODPROJ1', dependencies: [req(API)] }]]);
    const [f] = mrpackDeclaredCheck.run(packInput([mod], p, mr));
    expect(f?.title).toBe(`mod.jar requires Modrinth project ${API}, which the pack does not include`);
  });

  it.each<[string, () => { files: DeclaredFile[]; jars: JarRecord[]; mr: ModrinthContext }]>([
    [
      'provided by another declared file',
      () => ({
        files: [mod, api],
        jars: [],
        mr: identified([
          [mod, { projectId: 'MODPROJ1', dependencies: [req(API)] }],
          [api, { projectId: API }],
        ]),
      }),
    ],
    [
      'provided by an identified override jar',
      () => {
        const jar = { ...fabric({ file: 'fabric-api.jar', mods: [{ id: 'fabric-api-base' }] }), id: 'overrides/mods/fabric-api.jar', path: 'overrides/mods/fabric-api.jar' };
        return { files: [mod], jars: [jar], mr: identified([[mod, { projectId: 'MODPROJ1', dependencies: [req(API)] }], [jar, { projectId: API }]]) };
      },
    ],
    [
      'provided by an unidentified override jar whose mod id is the project slug (- ≡ _)',
      () => {
        const jar = { ...fabric({ file: 'fapi-custom.jar', mods: [{ id: 'fabric_api' }] }), id: 'overrides/mods/fapi-custom.jar', path: 'overrides/mods/fapi-custom.jar' };
        return {
          files: [mod],
          jars: [jar],
          mr: identified([[mod, { projectId: 'MODPROJ1', dependencies: [req(API)] }]], { projects: { [API]: fabricApi } }),
        };
      },
    ],
    [
      'a file on that side failed to look up (unknown: it could be the provider)',
      () => ({ files: [mod, api], jars: [], mr: identified([[mod, { projectId: 'MODPROJ1', dependencies: [req(API)] }]], { failed: [api.sha1] }) }),
    ],
    ['optional dependency', () => ({ files: [mod], jars: [], mr: identified([[mod, { projectId: 'MODPROJ1', dependencies: [req(API, 'optional')] }]]) })],
    ['embedded dependency', () => ({ files: [mod], jars: [], mr: identified([[mod, { projectId: 'MODPROJ1', dependencies: [req(API, 'embedded')] }]]) })],
    ['dependency with only a version id', () => ({ files: [mod], jars: [], mr: identified([[mod, { projectId: 'MODPROJ1', dependencies: [req(null, 'required', 'VERSION1')] }]]) })],
    ['dependency on its own project', () => ({ files: [mod], jars: [], mr: identified([[mod, { projectId: 'MODPROJ1', dependencies: [req('MODPROJ1')] }]]) })],
    [
      'requirer is client-only and the dependency is client-only',
      () => {
        const m = { ...mod, server: 'unsupported' };
        const a = { ...api, server: 'unsupported' };
        return { files: [m, a], jars: [], mr: identified([[m, { projectId: 'MODPROJ1', dependencies: [req(API)] }], [a, { projectId: API }]]) };
      },
    ],
    [
      'client-overrides jar provides it for a client-only requirer',
      () => {
        const m = { ...mod, server: 'unsupported' };
        const jar = { ...fabric({ file: 'fabric-api.jar' }), id: 'client-overrides/mods/fabric-api.jar', path: 'client-overrides/mods/fabric-api.jar' };
        return { files: [m], jars: [jar], mr: identified([[m, { projectId: 'MODPROJ1', dependencies: [req(API)] }], [jar, { projectId: API }]]) };
      },
    ],
  ])('not reported: %s', (_name, make) => {
    const { files, jars, mr } = make();
    const found = runChecks(packInput(files, p, mr, jars)).filter((f) => f.code === 'E-MISSING-DEP');
    expect(found).toEqual([]);
  });

  it('a dependency installed on the client only is missing on the server', () => {
    const a = { ...api, server: 'unsupported' };
    const mr = identified([
      [mod, { projectId: 'MODPROJ1', dependencies: [req(API)] }],
      [a, { projectId: API }],
    ]);
    const found = mrpackDeclaredCheck.run(packInput([mod, a], p, mr)).filter((f) => f.code === 'E-MISSING-DEP');
    expect(found.map((f) => f.title)).toEqual([`mod.jar requires Modrinth project ${API}, which the pack does not include on the server`]);
  });

  it('a server-overrides jar does not provide for the client', () => {
    const jar = { ...fabric({ file: 'fabric-api.jar' }), id: 'server-overrides/mods/fabric-api.jar', path: 'server-overrides/mods/fabric-api.jar' };
    const mr = identified([
      [mod, { projectId: 'MODPROJ1', dependencies: [req(API)] }],
      [jar, { projectId: API }],
    ]);
    const found = mrpackDeclaredCheck.run(packInput([mod], p, mr, [jar])).filter((f) => f.code === 'E-MISSING-DEP');
    expect(found.map((f) => f.title)).toEqual([`mod.jar requires Modrinth project ${API}, which the pack does not include on the client`]);
  });
});

describe('I-NOT-ON-MODRINTH for declared files', () => {
  const a = declared('mods/a.jar');
  const b = declared('mods/b.jar');
  const c = declared('resourcepacks/c.zip');
  const p = mrPack('fabric', '1.20.1');

  it('aggregates every unidentified declared file into one finding with a stable id', () => {
    const found = mrpackDeclaredCheck.run(packInput([b, a, c], p, modrinth())).filter((f) => f.code === 'I-NOT-ON-MODRINTH');
    expect(found).toHaveLength(1);
    const f = found[0] as Finding;
    expect(f.id).toBe(findingId('I-NOT-ON-MODRINTH', [], 'declared-aggregate'));
    expect(f.severity).toBe('info');
    expect(f.culprits.map((x) => x.jarId)).toEqual(['mods/a.jar', 'mods/b.jar', 'resourcepacks/c.zip']);
    expect(f.fixes).toEqual([]);
    const fewer = mrpackDeclaredCheck.run(packInput([a], p, modrinth())).find((x) => x.code === 'I-NOT-ON-MODRINTH');
    expect(fewer?.id).toBe(f.id);
  });

  it('failed lookups are unknown, not missing; identified files are not listed', () => {
    const mr = identified([[a, { projectId: 'PROJ0001' }]], { failed: [b.sha1.toUpperCase()] });
    const found = mrpackDeclaredCheck.run(packInput([a, b, c], p, mr)).filter((f) => f.code === 'I-NOT-ON-MODRINTH');
    expect(found.flatMap((f) => f.culprits.map((x) => x.jarId))).toEqual(['resourcepacks/c.zip']);
  });

  it('is separate from the override jars\' aggregate', () => {
    const jar = { ...fabric({ file: 'x.jar', mods: [{ id: 'x' }] }), id: 'overrides/mods/x.jar', path: 'overrides/mods/x.jar' };
    const found = runChecks(packInput([a], p, modrinth(), [jar])).filter((f) => f.code === 'I-NOT-ON-MODRINTH');
    // Sorted by first culprit file name: a.jar (declared) before x.jar (override).
    expect(found.map((f) => f.culprits.map((x) => x.jarId))).toEqual([['mods/a.jar'], ['overrides/mods/x.jar']]);
    expect(new Set(found.map((f) => f.id)).size).toBe(2);
  });

  it.each<[string, ModrinthContext | undefined]>([
    ['offline', modrinth({ offline: true })],
    ['no Modrinth context', undefined],
  ])('%s: no Modrinth-based finding at all', (_name, mr) => {
    const file = declared('mods/x.jar');
    expect(mrpackDeclaredCheck.run(packInput([file], p, mr))).toEqual([]);
  });
});

describe('W-MRPACK-DOWNLOAD: URL allowlist', () => {
  it.each<[string, string, boolean]>([
    ['Modrinth CDN', 'https://cdn.modrinth.com/data/AANobbMI/versions/OihdIimA/sodium.jar', true],
    ['GitHub release', 'https://github.com/owner/repo/releases/download/v1.0/mod.jar', true],
    ['raw GitHub', 'https://raw.githubusercontent.com/owner/repo/main/mod.jar', true],
    ['GitLab', 'https://gitlab.com/owner/repo/-/raw/main/mod.jar', true],
    ['scheme and host in upper case', 'HTTPS://CDN.MODRINTH.COM/data/x.jar', true],
    ['explicit default port', 'https://cdn.modrinth.com:443/data/x.jar', true],
    ['no path', 'https://github.com', true],
    ['query only', 'https://github.com?x=1', true],
    ['http', 'http://cdn.modrinth.com/data/x.jar', false],
    ['ftp', 'ftp://cdn.modrinth.com/data/x.jar', false],
    ['other port', 'https://cdn.modrinth.com:8443/data/x.jar', false],
    ['non-numeric port', 'https://cdn.modrinth.com:abc/data/x.jar', false],
    ['user info', 'https://user:pass@cdn.modrinth.com/data/x.jar', false],
    ['allowed host as user info', 'https://cdn.modrinth.com@evil.example/x.jar', false],
    ['subdomain of an allowed host', 'https://evil.cdn.modrinth.com/x.jar', false],
    ['www subdomain', 'https://www.github.com/x.jar', false],
    ['allowed host as a prefix', 'https://cdn.modrinth.com.evil.example/x.jar', false],
    ['lookalike suffix', 'https://github.com-releases.example/x.jar', false],
    ['modrinth.com itself is not a download host', 'https://modrinth.com/x.jar', false],
    ['trailing dot', 'https://cdn.modrinth.com./x.jar', false],
    ['IDN lookalike (dotless ı)', 'https://cdn.modr\u0131nth.com/x.jar', false],
    ['IDN lookalike (Cyrillic о)', 'https://github.c\u043em/x.jar', false],
    ['fullwidth dots', 'https://cdn\uff0emodrinth\uff0ecom/x.jar', false],
    ['punycode', 'https://xn--cdn-modrnth-6ib.com/x.jar', false],
    ['percent-encoded host', 'https://cdn%2Emodrinth.com/x.jar', false],
    ['backslash trick', 'https://evil.example\\@cdn.modrinth.com/x.jar', false],
    ['backslash after host', 'https://cdn.modrinth.com\\@evil.example/x.jar', false],
    ['fragment trick', 'https://evil.example#@cdn.modrinth.com/x.jar', false],
    ['query trick', 'https://evil.example?@cdn.modrinth.com/x.jar', false],
    ['IPv4', 'https://104.16.0.1/x.jar', false],
    ['IPv6', 'https://[2606:4700::1]/x.jar', false],
    ['whitespace inside', 'https://cdn.modrinth.com /x.jar', false],
    ['leading whitespace', ' https://cdn.modrinth.com/x.jar', false],
    ['newline', 'https://cdn.modrinth.com/x.jar\nhttps://evil.example', false],
    ['scheme-relative', '//cdn.modrinth.com/x.jar', false],
    ['no scheme', 'cdn.modrinth.com/x.jar', false],
    ['no host', 'https:///x.jar', false],
    ['bare scheme', 'https://', false],
    ['not a URL', 'not a url', false],
    ['empty', '', false],
    ['javascript', 'javascript:alert(1)', false],
  ])('%s', (_name, url, allowed) => {
    expect(classifyDownloadUrl(url).allowed).toBe(allowed);
  });

  it('reports the host a user-info URL really points to', () => {
    expect(classifyDownloadUrl('https://cdn.modrinth.com@evil.example/x.jar')).toMatchObject({ allowed: false, host: 'evil.example' });
    expect(classifyDownloadUrl('https://evil.example#@cdn.modrinth.com/')).toMatchObject({ allowed: false, host: 'evil.example' });
  });

  it('one warning per file with any URL outside the allowlist, offline too, with evidence and no fixes', () => {
    const ok = declared('mods/ok.jar');
    const mixed = declared('mods/mixed.jar', {
      downloads: ['https://cdn.modrinth.com/data/a/versions/b/mixed.jar', 'http://evil.example/mixed.jar', 'https://evil.example:8080/mixed.jar'],
    });
    const bad = declared('mods/bad.jar', { downloads: ['not a url'] });
    const empty = declared('mods/none.jar', { downloads: [] });
    const input = packInput([ok, mixed, bad, empty], mrPack('fabric', '1.20.1'), modrinth({ offline: true }));
    const found = runChecks(input).filter((f) => f.code === 'W-MRPACK-DOWNLOAD');
    expect(found.map((f) => f.culprits[0]?.jarId)).toEqual(['mods/bad.jar', 'mods/mixed.jar']);
    const m = found.find((f) => f.culprits[0]?.jarId === 'mods/mixed.jar') as Finding;
    expect(m.severity).toBe('warning');
    expect(m.fixes).toEqual([]);
    expect(m.title).toBe("mixed.jar downloads from evil.example outside Modrinth's allowed hosts");
    expect(m.id).toBe(findingId('W-MRPACK-DOWNLOAD', ['mods/mixed.jar'], 'declared'));
    expect(notes(m)).toEqual([
      `modrinth.index.json lists mods/mixed.jar (sha1 ${mixed.sha1}).`,
      'Download URL http://evil.example/mixed.jar: it uses http, not https.',
      'Download URL https://evil.example:8080/mixed.jar: it uses port 8080.',
      'Pack: Fabric (version unknown) on Minecraft 1.20.1 (from the .mrpack index)',
    ]);
    const b = found.find((f) => f.culprits[0]?.jarId === 'mods/bad.jar') as Finding;
    expect(b.title).toBe("bad.jar downloads outside Modrinth's allowed hosts");
  });

  it('nothing without declared files (an ordinary instance)', () => {
    expect(mrpackDownloadCheck.run(packInput([], mrPack('fabric', '1.20.1')))).toEqual([]);
  });
});

describe('declared files in a full run', () => {
  it('findings are deterministic, carry no fixes, and Modrinth enrichment adds none', () => {
    const wrong = declared('mods/forge-only.jar', { downloads: ['https://example.com/forge-only.jar'] });
    const old = declared('mods/old.jar');
    const mr = identified(
      [
        [wrong, { projectId: 'PROJWRNG', loaders: ['forge'] }],
        [old, { projectId: 'PROJOLD1', gameVersions: ['1.19.2'], dependencies: [{ projectId: 'MISSING1', versionId: null, fileName: null, dependencyType: 'required' }] }],
      ],
      {
        updates: { [wrong.sha1]: mrVersion({ id: 'newer', projectId: 'PROJWRNG', datePublished: '2030-01-01T00:00:00Z' }) },
      },
    );
    const input = packInput([wrong, old], mrPack('fabric', '1.20.1', '0.16.5'), mr);
    const a = runChecks(input);
    const b = runChecks(packInput([old, wrong], mrPack('fabric', '1.20.1', '0.16.5'), mr));
    expect(a).toEqual(b);
    const mine = onDeclared(a, [wrong, old]);
    expect(mine.map((f) => f.code).sort()).toEqual(['E-MC-RANGE', 'E-MISSING-DEP', 'E-WRONG-LOADER', 'W-MRPACK-DOWNLOAD']);
    for (const f of mine) expect(f.fixes).toEqual([]);
    const enriched = enrichFindings(a, mr, {}, input.scan.jars);
    expect(onDeclared(enriched, [wrong, old]).flatMap((f) => f.fixes)).toEqual([]);
  });
});
