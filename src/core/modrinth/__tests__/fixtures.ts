/**
 * Realistic Modrinth objects (shapes from docs/research/modrinth-api.md and
 * src-tauri/src/modrinth/tests.rs), as the Rust client hands them to the webview.
 */
import type { HashLookup, MrFile, MrProject, MrVersion, ProjectLookup } from '../../../bindings';

const CDN = 'https://cdn.modrinth.com/data';

export function mrFile(over: Partial<MrFile> & { filename: string }, projectId = 'AANobbMI', versionId = 'OihdIimA'): MrFile {
  return {
    url: `${CDN}/${projectId}/versions/${versionId}/${encodeURIComponent(over.filename)}`,
    size: 971552,
    primary: true,
    sha1: 'bcdbf37d9494e405cba210d7a80ed58e756297b5',
    sha512: '81c64f9c'.padEnd(128, '0'),
    fileType: null,
    ...over,
  };
}

/** A version with one primary CDN jar unless `files` is given. `datePublished` defaults to a fixed
 *  time (as the API always sends one): give versions that must order against each other their own. */
export function mrVersion(over: Partial<MrVersion> & { id: string; projectId: string }): MrVersion {
  const versionNumber = over.versionNumber ?? '1.0.0';
  return {
    versionNumber,
    name: `Version ${versionNumber}`,
    gameVersions: ['1.20.1'],
    loaders: ['fabric'],
    versionType: 'release',
    datePublished: '2023-06-12T17:31:40.637838Z',
    environment: 'client_and_server',
    files: [mrFile({ filename: `${over.projectId.toLowerCase()}-${versionNumber}.jar` }, over.projectId, over.id)],
    droppedFiles: 0,
    primaryDropped: false,
    dependencies: [],
    ...over,
  };
}

export function mrProject(over: Partial<MrProject> & { id: string; slug: string }): MrProject {
  return {
    title: over.slug,
    projectType: 'mod',
    environment: ['client_and_server'],
    clientSide: 'required',
    serverSide: 'required',
    iconPath: null,
    ...over,
  };
}

export function lookup(found: Record<string, MrVersion>, over: Partial<HashLookup> = {}): HashLookup {
  return { found, failed: [], offline: false, ...over };
}

export function projectLookup(found: Record<string, MrProject>, over: Partial<ProjectLookup> = {}): ProjectLookup {
  return { found, failed: [], offline: false, ...over };
}

// ---- Real-world fixtures -----------------------------------------------------------------------

export const SODIUM = mrProject({
  id: 'AANobbMI',
  slug: 'sodium',
  title: 'Sodium',
  environment: ['client_only'],
  clientSide: 'required',
  serverSide: 'unsupported',
});
export const FABRIC_API = mrProject({
  id: 'P7dR8mSH',
  slug: 'fabric-api',
  title: 'Fabric API',
  environment: ['client_or_server_prefers_both'],
  clientSide: 'optional',
  serverSide: 'optional',
});
export const CLOTH_CONFIG = mrProject({ id: '9s6osm5g', slug: 'cloth-config', title: 'Cloth Config API' });
export const ARCHITECTURY = mrProject({ id: 'lhGA9TYQ', slug: 'architectury-api', title: 'Architectury API' });

/**
 * sodium mc1.20-0.4.10 (older) and mc1.20.1-0.5.13-fabric (newest release for fabric/1.20.1); a
 * later beta and alpha. `datePublished` in Modrinth's own format (µs, `Z`).
 */
export const SODIUM_OLD = mrVersion({
  id: 'vgceLbdH',
  projectId: 'AANobbMI',
  versionNumber: 'mc1.20-0.4.10',
  gameVersions: ['1.20', '1.20.1'],
  datePublished: '2023-06-12T17:31:40.637838Z',
});
export const SODIUM_NEW = mrVersion({ id: 'OihdIimA', projectId: 'AANobbMI', versionNumber: 'mc1.20.1-0.5.13-fabric', datePublished: '2024-10-04T15:47:23.155411Z' });
export const SODIUM_BETA = mrVersion({
  id: 'b3TaSod1',
  projectId: 'AANobbMI',
  versionNumber: 'mc1.20.1-0.6.0-beta.2-fabric',
  versionType: 'beta',
  datePublished: '2024-11-20T09:12:05.004217Z',
});
export const SODIUM_ALPHA = mrVersion({
  id: 'aLphaS01',
  projectId: 'AANobbMI',
  versionNumber: 'mc1.20.1-0.6.0-alpha.1-fabric',
  versionType: 'alpha',
  datePublished: '2024-08-01T11:00:00.000000Z',
});

/**
 * The live downgrade (M5 review): the user runs Sodium 0.8.15-beta.1, the release lookup answers
 * 0.8.14 (published before it). 0.8.15-beta.2 is newer than the beta the user runs.
 */
export const SODIUM_0814 = mrVersion({
  id: 'rEl08140',
  projectId: 'AANobbMI',
  versionNumber: 'mc1.21.11-0.8.14-fabric',
  gameVersions: ['1.21.11'],
  datePublished: '2026-09-02T12:03:11.418209Z',
});
export const SODIUM_0815_B1 = mrVersion({
  id: 'bEt08151',
  projectId: 'AANobbMI',
  versionNumber: 'mc1.21.11-0.8.15-beta.1-fabric',
  gameVersions: ['1.21.11'],
  versionType: 'beta',
  datePublished: '2026-10-15T18:40:52.770031Z',
});
export const SODIUM_0815_B2 = mrVersion({
  id: 'bEt08152',
  projectId: 'AANobbMI',
  versionNumber: 'mc1.21.11-0.8.15-beta.2-fabric',
  gameVersions: ['1.21.11'],
  versionType: 'beta',
  datePublished: '2026-10-29T07:05:14.002871Z',
});

export const SHA_SODIUM_OLD = 'b11e18bb09f06c3f8028fa2c090072976fa326d0';
export const SHA_SODIUM_NEW = 'bcdbf37d9494e405cba210d7a80ed58e756297b5';
export const SHA_CLOTH = 'c1077c0f1900000000000000000000000000c107';
export const SHA_SODIUM_BETA1 = '5b0d1e8a9c2f4b6d8e0a1c3e5f7092b4d6f8a0c2';
export const SHA_UNKNOWN = '0000000000000000000000000000000000000000';
