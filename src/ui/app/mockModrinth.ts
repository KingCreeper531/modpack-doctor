/**
 * Modrinth answers for the browser preview (mockIpc.ts), shaped exactly like the Rust client's
 * (`HashLookup`, `ProjectLookup`, `MrVersion[]`, `MrProject | null`). Dev only: reachable through
 * the mock backend, which `createBackend` drops from production bundles.
 *
 * Over the mock jar sets (mockData.ts):
 * - most jars are identified by hash; a few are not on Modrinth (OptiFine, the corrupt jar,
 *   Mekanism, about one filler in eleven);
 * - release updates: Create, JEI, Curios and Lithostitched (the 1.20.1 build, which turns the
 *   E-MC-RANGE finding into a replace fix) in All the Mods 9, Sodium and Iris on the server,
 *   Sodium in Fabulously Optimized, Traveler's Backpack (its NeoForge build, for E-WRONG-LOADER);
 * - one beta-only update (EntityCulling in Fabulously Optimized): no compatible release, so the
 *   update shows only through the `["release","beta"]` fallback;
 * - one jar ahead of the latest release (Jade in All the Mods 9 is a beta newer than the newest
 *   release): Modrinth answers the older release, which is never offered (a downgrade), and the
 *   beta fallback answers the jar itself, so the jar reads "up to date";
 * - Sodium in All the Mods 9 is a Fabric jar with no Forge build: no compatible version at all;
 * - every version has a `datePublished`; updates are published after the version they replace;
 * - FTB Library's project has no icon; every other icon is a small inline SVG drawn from the
 *   design tokens (never a remote URL, never a real logo). As in Rust, `modrinth_projects`
 *   attaches only icons a previous `modrinth_icons` call cached; `modrinth_icons` "downloads"
 *   them (the backend keeps the cache);
 * - `botarium` (missing for Ad Astra) resolves to a project with a downloadable release.
 * Client-only projects (Sodium, Iris, Mod Menu…) carry `client_only`, so W-CLIENT-ON-SERVER fires
 * on the server instance.
 */
import type { HashLookup, JarRecord, MrFile, MrProject, MrVersion, ProjectLookup, SideSupport } from '../../bindings';
import { MOCK_INSTANCES, mockDeclaredFiles, mockJars } from './mockData';

interface ProjectSpec {
  slug: string;
  title: string;
  env?: 'client_only' | 'server_only' | 'client_and_server';
  /** No icon on Modrinth. */
  noIcon?: boolean;
  /** Newer release per instance id (else the jar itself is the newest compatible release). */
  release?: Readonly<Record<string, string>>;
  /** A beta per instance id, newer than any release. */
  beta?: Readonly<Record<string, string>>;
  /** Loader of the release named in `release` (when it differs from the jar's, e.g. a port). */
  releaseLoader?: string;
  /**
   * Per instance id: the jar is a beta, newer than this latest release (which Modrinth's update
   * route still answers when only releases are asked for).
   */
  aheadOfRelease?: Readonly<Record<string, string>>;
}

const ATM9 = '3f9c2a71d0b84e15';
const FO = '8a1e40c6f7d23b90';
const SMP = '7d3a5c19e0f2b864';
const NEO = '51b7e8d02c94a6f3';

/** Mod id → project. Mod ids not listed get a generated project (fillers). */
const PROJECTS: Readonly<Record<string, ProjectSpec>> = {
  create: { slug: 'create', title: 'Create', release: { [ATM9]: '0.5.1.j' } },
  embeddium: { slug: 'embeddium', title: 'Embeddium', env: 'client_only' },
  rubidium: { slug: 'rubidium', title: 'Rubidium', env: 'client_only' },
  sodium: { slug: 'sodium', title: 'Sodium', env: 'client_only', release: { [SMP]: '0.5.11+mc1.20.1', [FO]: '0.6.5+mc1.21.1' } },
  iris: { slug: 'iris', title: 'Iris Shaders', env: 'client_only', release: { [SMP]: '1.7.5+mc1.20.1' } },
  modmenu: { slug: 'modmenu', title: 'Mod Menu', env: 'client_only' },
  ad_astra: { slug: 'ad-astra', title: 'Ad Astra' },
  resourcefullib: { slug: 'resourceful-lib', title: 'Resourceful Lib' },
  jei: { slug: 'jei', title: 'Just Enough Items', release: { [ATM9]: '15.3.0.8' } },
  fastsuite: { slug: 'fastsuite', title: 'FastSuite' },
  lithostitched: { slug: 'lithostitched', title: 'Lithostitched', release: { [ATM9]: '1.0.9' } },
  curios: { slug: 'curios', title: 'Curios API', release: { [ATM9]: '5.10.0+1.20.1' } },
  architectury: { slug: 'architectury-api', title: 'Architectury API' },
  cloth_config: { slug: 'cloth-config', title: 'Cloth Config API' },
  ae2: { slug: 'ae2', title: 'Applied Energistics 2' },
  ftbquests: { slug: 'ftb-quests-forge', title: 'FTB Quests' },
  ftblibrary: { slug: 'ftb-library-forge', title: 'FTB Library', noIcon: true },
  oculus: { slug: 'oculus', title: 'Oculus', env: 'client_only' },
  jade: { slug: 'jade', title: 'Jade', aheadOfRelease: { [ATM9]: '11.7.1' } },
  lithium: { slug: 'lithium', title: 'Lithium' },
  'fabric-api': { slug: 'fabric-api', title: 'Fabric API' },
  entityculling: { slug: 'entityculling', title: 'Entity Culling', env: 'client_only', beta: { [FO]: '1.7.1-beta.2' } },
  notenoughanimations: { slug: 'not-enough-animations', title: 'Not Enough Animations', env: 'client_only' },
  ferritecore: { slug: 'ferrite-core', title: 'FerriteCore' },
  spark: { slug: 'spark', title: 'spark' },
  chunky: { slug: 'chunky', title: 'Chunky', env: 'server_only' },
  travelersbackpack: { slug: 'travelersbackpack', title: "Traveler's Backpack", release: { [NEO]: '10.1.8' }, releaseLoader: 'neoforge' },
  hearthhud: { slug: 'hearthstone-hud', title: 'Hearthstone HUD', env: 'client_only' },
  glintful: { slug: 'glintful', title: 'Glintful', env: 'client_only' },
  stackcount: { slug: 'stack-count', title: 'Stack Count', env: 'client_only' },
};

/** Not on Modrinth (CurseForge-only or hand-made). */
const NOT_ON_MODRINTH = new Set(['mekanism', 'fastsuite']);

/** Dependencies `modrinth_resolve_mod_id` can find, with their newest release per MC version. */
const RESOLVABLE: Readonly<Record<string, ProjectSpec & { versions: Readonly<Record<string, string>> }>> = {
  botarium: { slug: 'botarium', title: 'Botarium', versions: { '1.20.1': '2.3.4' } },
  cloth_config: { slug: 'cloth-config', title: 'Cloth Config API', versions: { '1.20.1': '11.1.136', '1.21.1': '15.0.140' } },
  'fabric-api': { slug: 'fabric-api', title: 'Fabric API', versions: { '1.20.1': '0.92.2+1.20.1', '1.21.1': '0.107.0+1.21.1' } },
};

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

const B62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
/** Modrinth-style 8-character id. */
function mrId(seed: string): string {
  let h = hash(seed);
  let h2 = hash(`${seed}#`);
  let out = '';
  for (let i = 0; i < 8; i++) {
    const v = i < 4 ? h : h2;
    out += B62[v % 62];
    if (i < 4) h = Math.floor(h / 62) + 7919 * (i + 1);
    else h2 = Math.floor(h2 / 62) + 104729 * (i + 1);
  }
  return out;
}

function hex(seed: string, n: number): string {
  let s = '';
  let i = 0;
  while (s.length < n) s += hash(`${seed}/${i++}`).toString(16).padStart(8, '0');
  return s.slice(0, n);
}

interface Entry {
  instanceId: string;
  mc: string;
  jar: JarRecord;
  modId: string;
  spec: ProjectSpec;
}

let index: Map<string, Entry> | null = null;

/** sha1 → mock jar, over every mock instance (built once). */
function entries(): Map<string, Entry> {
  if (index) return index;
  index = new Map();
  for (const inst of MOCK_INSTANCES) {
    for (const jar of mockJars(inst.id)) {
      if (jar.depth !== 0) continue;
      const meta = jar.mods[0];
      if (!meta || jar.status.state !== 'ok') continue;
      const modId = meta.modId;
      if (NOT_ON_MODRINTH.has(modId)) continue;
      const spec = PROJECTS[modId];
      // About one filler in eleven is not on Modrinth.
      if (!spec && hash(modId) % 11 === 3) continue;
      index.set(jar.sha1, {
        instanceId: inst.id,
        mc: inst.mcVersion ?? '',
        jar,
        modId,
        spec: spec ?? { slug: modId.replace(/_/g, '-'), title: meta.name ?? modId },
      });
    }
  }
  return index;
}

const projectId = (slug: string) => mrId(`project:${slug}`);

function file(pid: string, vid: string, filename: string, seed: string, size: number): MrFile {
  return {
    url: `https://cdn.modrinth.com/data/${pid}/versions/${vid}/${encodeURIComponent(filename)}`,
    filename,
    size,
    primary: true,
    sha1: hex(`${seed}:sha1`, 40),
    sha512: hex(`${seed}:sha512`, 128),
    fileType: null,
  };
}

const DAY_MS = 86_400_000;
/** 2024-02-01T00:00:00Z: identified versions are published in the 240 days after it. */
const EPOCH_MS = Date.UTC(2024, 1, 1);

/** ISO publish time, `days` after `EPOCH_MS` plus a deterministic time of day. */
function published(days: number, seed: string): string {
  return new Date(EPOCH_MS + days * DAY_MS + (hash(`${seed}@time`) % DAY_MS)).toISOString();
}

/** Days after `EPOCH_MS` the jar's own version came out. */
function ownDay(e: Entry): number {
  return 20 + (hash(`${e.spec.slug}:${e.jar.mods[0]?.version ?? ''}`) % 240);
}

function version(
  spec: ProjectSpec,
  versionNumber: string,
  versionType: string,
  loader: string,
  mc: string,
  filename: string,
  size: number,
  datePublished: string,
  sha1?: string,
): MrVersion {
  const pid = projectId(spec.slug);
  const vid = mrId(`version:${spec.slug}:${versionNumber}:${loader}`);
  const f = file(pid, vid, filename, `${spec.slug}:${versionNumber}:${loader}`, size);
  return {
    id: vid,
    projectId: pid,
    versionNumber,
    name: `${spec.title} ${versionNumber}`,
    gameVersions: [mc],
    loaders: [loader],
    versionType,
    datePublished,
    environment: spec.env ?? 'client_and_server',
    files: [sha1 ? { ...f, sha1 } : f],
    droppedFiles: 0,
    primaryDropped: false,
    dependencies: [],
  };
}

/** The version a jar is (its own file). */
function identified(e: Entry): MrVersion {
  const loader = e.jar.loaders[0] ?? 'forge';
  const meta = e.jar.mods[0]!;
  const mc = e.mc;
  const type = e.spec.aheadOfRelease?.[e.instanceId] ? 'beta' : 'release';
  const date = published(ownDay(e), `${e.spec.slug}:${meta.version}`);
  return version(e.spec, meta.version, type, loader, mc, e.jar.fileName.replace(/\.disabled$/, ''), e.jar.size, date, e.jar.sha1);
}

function lookup(sha1s: string[], answer: (e: Entry) => MrVersion | null): HashLookup {
  const found: Record<string, MrVersion> = {};
  for (const h of sha1s) {
    const e = entries().get(h.toLowerCase());
    const v = e ? answer(e) : null;
    if (v) found[h] = v;
  }
  return { found, failed: [], offline: false };
}

/** A file a mock `.mrpack` index declares, as Modrinth identifies its hash (or null). */
function declaredVersion(sha1: string): MrVersion | null {
  for (const files of Object.values(mockDeclaredFiles())) {
    for (const d of files) {
      if (d.file.sha1.toLowerCase() !== sha1.toLowerCase() || !d.project) continue;
      const p = d.project;
      const spec: ProjectSpec = { slug: p.slug, title: p.title, ...(p.env ? { env: p.env } : {}) };
      const name = d.file.path.slice(d.file.path.lastIndexOf('/') + 1);
      const v = version(spec, p.versionNumber, 'release', p.loaders[0] ?? 'fabric', p.gameVersions[0] ?? '', name, d.file.size, published(120, `${p.slug}:${p.versionNumber}`), d.file.sha1);
      return { ...v, loaders: [...p.loaders], gameVersions: [...p.gameVersions] };
    }
  }
  return null;
}

/** `modrinth_identify` (jars of the mock instances, and the files mock packs declare). */
export function mockIdentify(sha1s: string[]): HashLookup {
  const r = lookup(sha1s, identified);
  for (const h of sha1s) {
    if (r.found[h]) continue;
    const v = declaredVersion(h);
    if (v) r.found[h] = v;
  }
  return r;
}

/** Everything failed and nothing was cached: the network is down. */
export function mockOffline(sha1s: string[]): HashLookup {
  return { found: {}, failed: [...sha1s], offline: true };
}

/** `modrinth_find_updates`: the newest version of the jar's project matching the filters. */
export function mockFindUpdates(sha1s: string[], loaders: string[], gameVersions: string[], versionTypes: string[]): HashLookup {
  return lookup(sha1s, (e) => {
    if (!gameVersions.includes(e.mc)) return null;
    const own = identified(e);
    const ownLoader = own.loaders[0]!;
    const day = ownDay(e);
    const ahead = e.spec.aheadOfRelease?.[e.instanceId];
    if (ahead) {
      if (!loaders.includes(ownLoader)) return null;
      // The newest *matching* version: the jar itself once betas count, else an older release.
      if (versionTypes.includes('beta')) return own;
      const older = day - 20 - (hash(`${e.spec.slug}:${ahead}`) % 40);
      return version(e.spec, ahead, 'release', ownLoader, e.mc, `${e.spec.slug}-${ahead}.jar`, e.jar.size - 1024, published(older, `${e.spec.slug}:${ahead}`));
    }
    const beta = e.spec.beta?.[e.instanceId];
    if (beta && versionTypes.includes('beta') && loaders.includes(ownLoader)) {
      return version(e.spec, beta, 'beta', ownLoader, e.mc, `${e.spec.slug}-${beta}.jar`, e.jar.size, published(day + 9, `${e.spec.slug}:${beta}`));
    }
    const release = e.spec.release?.[e.instanceId];
    const loader = e.spec.releaseLoader ?? ownLoader;
    if (release && loaders.includes(loader)) {
      const later = day + 14 + (hash(`${e.spec.slug}:${release}`) % 60);
      return version(e.spec, release, 'release', loader, e.mc, `${e.spec.slug}-${release}.jar`, e.jar.size + 2048, published(later, `${e.spec.slug}:${release}`));
    }
    // The beta-only project has no compatible release at all.
    if (beta) return null;
    return loaders.includes(ownLoader) ? own : null;
  });
}

/** Every Modrinth loader name the mock answers for. */
const ALL_LOADERS = ['forge', 'neoforge', 'fabric', 'quilt'];

/** A Modrinth version the mock knows, with the mod id its jar declares. */
export interface MockVersionInfo {
  version: MrVersion;
  modId: string;
  title: string;
}

/**
 * `GET /v2/version/{id}` for the mock fix planner (mockFix.ts): every version the mock ever
 * answers (identified jars, their updates and betas, resolvable dependencies), or null.
 */
export function mockVersionById(versionId: string): MockVersionInfo | null {
  for (const e of entries().values()) {
    const candidates = [
      identified(e),
      mockFindUpdates([e.jar.sha1], ALL_LOADERS, [e.mc], ['release']).found[e.jar.sha1],
      mockFindUpdates([e.jar.sha1], ALL_LOADERS, [e.mc], ['release', 'beta']).found[e.jar.sha1],
    ];
    const hit = candidates.find((v) => v?.id === versionId);
    if (hit) return { version: hit, modId: e.modId, title: e.spec.title };
  }
  for (const [modId, r] of Object.entries(RESOLVABLE)) {
    for (const mc of Object.keys(r.versions)) {
      for (const loader of ALL_LOADERS) {
        const hit = mockProjectVersions(projectId(r.slug), [loader], [mc]).find((v) => v.id === versionId);
        if (hit) return { version: hit, modId, title: r.title };
      }
    }
  }
  return null;
}

/** The version a jar's hash identifies (`modrinth_identify` for one hash), or null. */
export function mockIdentifiedVersion(sha1: string): MrVersion | null {
  return mockIdentify([sha1]).found[sha1] ?? null;
}

/**
 * Make a jar a mock fix wrote (a download, a restored snapshot file) identifiable by its hash,
 * as Modrinth would identify the real file. Idempotent; jars of unknown projects are ignored.
 */
export function mockRegisterJar(instanceId: string, jar: JarRecord): void {
  const meta = jar.mods[0];
  if (!meta) return;
  const spec = PROJECTS[meta.modId] ?? RESOLVABLE[meta.modId];
  if (!spec) return;
  const mc = MOCK_INSTANCES.find((i) => i.id === instanceId)?.mcVersion ?? '';
  entries().set(jar.sha1.toLowerCase(), { instanceId, mc, jar, modId: meta.modId, spec });
}

function sides(env: ProjectSpec['env']): { clientSide: SideSupport; serverSide: SideSupport } {
  if (env === 'client_only') return { clientSide: 'required', serverSide: 'unsupported' };
  if (env === 'server_only') return { clientSide: 'unsupported', serverSide: 'required' };
  return { clientSide: 'required', serverSide: 'required' };
}

/** A 16×16 glyph drawn with the current theme's tokens (inline, never fetched). */
function icon(slug: string): string {
  const css = typeof document !== 'undefined' ? getComputedStyle(document.documentElement) : null;
  const token = (name: string) => css?.getPropertyValue(name).trim() || 'currentColor';
  const palette = [token('--c-ok-fill'), token('--c-signal-fill'), token('--c-info'), token('--c-fg-dim')];
  const h = hash(slug);
  const fg = palette[h % palette.length]!;
  const bg = token('--c-raised');
  const cells: string[] = [];
  for (let i = 0; i < 9; i++) {
    if ((h >>> (i + 3)) & 1) cells.push(`<rect x="${2 + (i % 3) * 4}" y="${2 + Math.floor(i / 3) * 4}" width="4" height="4"/>`);
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" fill="${bg}"/><g fill="${fg}">${cells.join('')}</g></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

/** Project ids whose icon a `modrinth_icons` call has "downloaded" (the mock icon cache). */
export type MockIconCache = ReadonlySet<string>;

function project(spec: ProjectSpec, cached: MockIconCache): MrProject {
  const env = spec.env ?? 'client_and_server';
  const id = projectId(spec.slug);
  return {
    id,
    slug: spec.slug,
    title: spec.title,
    projectType: 'mod',
    environment: [env],
    ...sides(env),
    // Like Rust: only an icon already in the cache; `modrinth_projects` never downloads one.
    iconPath: !spec.noIcon && cached.has(id) ? icon(spec.slug) : null,
  };
}

let specs: Map<string, ProjectSpec> | null = null;

/** Project id → spec, over every identified jar and every resolvable dependency. */
function specById(): Map<string, ProjectSpec> {
  if (specs) return specs;
  specs = new Map();
  for (const e of entries().values()) specs.set(projectId(e.spec.slug), e.spec);
  for (const r of Object.values(RESOLVABLE)) specs.set(projectId(r.slug), r);
  for (const files of Object.values(mockDeclaredFiles())) {
    for (const d of files) {
      const p = d.project;
      if (p && !specs.has(projectId(p.slug))) specs.set(projectId(p.slug), { slug: p.slug, title: p.title, ...(p.env ? { env: p.env } : {}) });
    }
  }
  return specs;
}

/** `modrinth_projects`, keyed by the requested id. */
export function mockProjects(ids: string[], cached: MockIconCache = new Set()): ProjectLookup {
  const found: Record<string, MrProject> = {};
  for (const id of ids) {
    const spec = specById().get(id);
    if (spec) found[id] = project(spec, cached);
  }
  return { found, failed: [], offline: false };
}

/** `modrinth_icons`: project id → icon for every requested project that has one. */
export function mockIcons(ids: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const id of ids) {
    const spec = specById().get(id);
    if (spec && !spec.noIcon) out[id] = icon(spec.slug);
  }
  return out;
}

/** `modrinth_resolve_mod_id`. */
export function mockResolveModId(modId: string, cached: MockIconCache = new Set()): MrProject | null {
  const r = RESOLVABLE[modId];
  return r ? project(r, cached) : null;
}

/** `modrinth_project_versions`, newest first. */
export function mockProjectVersions(id: string, loaders: string[], gameVersions: string[]): MrVersion[] {
  const r = Object.values(RESOLVABLE).find((x) => projectId(x.slug) === id);
  const mc = gameVersions[0];
  const loader = loaders[0];
  if (!r || !mc || !loader) return [];
  const v = r.versions[mc];
  return v ? [version(r, v, 'release', loader, mc, `${r.slug}-${loader}-${mc}-${v}.jar`, 214_000, published(200 + (hash(`${r.slug}:${v}`) % 60), `${r.slug}:${v}`))] : [];
}

/** `rateLimited`, as the Rust client reports a 429. */
export const MOCK_RATE_LIMIT_S = 5;
