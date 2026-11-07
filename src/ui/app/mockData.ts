/**
 * Deterministic mock data for the browser preview (mockIpc.ts): a discovery report spanning
 * several launchers and realistic `JarRecord`s per instance. The jar sets deliberately contain
 * what the static checks look for (wrong loader, missing dependency, duplicate mod id, split
 * package, client-only on a server, corrupt jar, a class file newer than the pack's Java), so
 * the real `src/core` checks fire against them exactly as they would against a Rust scan.
 */
import type {
  DeclaredFile,
  Dependency,
  DependencyKind,
  DiscoveryReport,
  Instance,
  JarRecord,
  JarStatus,
  LauncherProbe,
  LoaderKind,
  ModEnvironment,
  ModMeta,
  RangeSyntax,
  RawRange,
} from '../../bindings';

/** mulberry32: small, seedable. */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hex(r: () => number, n: number): string {
  let s = '';
  while (s.length < n) s += Math.floor(r() * 0x100000000).toString(16).padStart(8, '0');
  return s.slice(0, n);
}

function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

// ── Instances ────────────────────────────────────────────────────────────────

const HOME = 'C:\\Users\\alex';
const ROAMING = `${HOME}\\AppData\\Roaming`;

export const MOCK_INSTANCES: Instance[] = [
  {
    id: '3f9c2a71d0b84e15',
    name: 'All the Mods 9',
    launcher: 'curseforge',
    root: `${HOME}\\curseforge\\minecraft\\Instances\\All the Mods 9`,
    gameDir: `${HOME}\\curseforge\\minecraft\\Instances\\All the Mods 9`,
    mcVersion: '1.20.1',
    loader: { kind: 'forge', version: '47.3.0' },
    side: 'client',
    metadataSource: 'launcher',
    modCount: 512,
  },
  {
    id: '8a1e40c6f7d23b90',
    name: 'Fabulously Optimized',
    launcher: 'modrinth',
    root: `${ROAMING}\\ModrinthApp\\profiles\\Fabulously Optimized`,
    gameDir: `${ROAMING}\\ModrinthApp\\profiles\\Fabulously Optimized`,
    mcVersion: '1.21.1',
    loader: { kind: 'fabric', version: '0.16.5' },
    side: 'client',
    metadataSource: 'launcher',
    modCount: 87,
  },
  {
    id: '7d3a5c19e0f2b864',
    name: 'smp-2024 server',
    launcher: 'manual',
    root: 'D:\\servers\\smp-2024',
    gameDir: 'D:\\servers\\smp-2024',
    mcVersion: '1.20.1',
    loader: { kind: 'fabric', version: '0.15.11' },
    side: 'server',
    metadataSource: 'inferred',
    modCount: 44,
  },
  {
    id: 'c04d9e2b61a8f735',
    name: 'Create: Above and Beyond',
    launcher: 'prism',
    root: `${ROAMING}\\PrismLauncher\\instances\\CABIN`,
    gameDir: `${ROAMING}\\PrismLauncher\\instances\\CABIN\\.minecraft`,
    mcVersion: '1.16.5',
    loader: { kind: 'forge', version: '36.2.39' },
    side: 'client',
    metadataSource: 'launcher',
    modCount: 156,
  },
  {
    id: '51b7e8d02c94a6f3',
    name: 'NeoForge test 1.21',
    launcher: 'multimc',
    root: 'D:\\MultiMC\\instances\\neo-test',
    gameDir: 'D:\\MultiMC\\instances\\neo-test\\.minecraft',
    mcVersion: '1.21.1',
    loader: { kind: 'neoforge', version: '21.1.77' },
    side: 'client',
    metadataSource: 'launcher',
    modCount: 42,
  },
  {
    id: '2b8f61e4d7a09c53',
    name: 'Cobblemon Official 1.5',
    launcher: 'mrpack',
    root: `${HOME}\\Downloads\\Cobblemon Official Modpack 1.5.2.mrpack`,
    gameDir: `${HOME}\\Downloads\\Cobblemon Official Modpack 1.5.2.mrpack`,
    mcVersion: '1.21.1',
    loader: { kind: 'fabric', version: '0.16.9' },
    side: 'client',
    metadataSource: 'mrpack',
    modCount: 61,
  },
  {
    id: 'e6290f4a1b3dc875',
    name: 'Latest release',
    launcher: 'vanilla',
    root: `${ROAMING}\\.minecraft`,
    gameDir: `${ROAMING}\\.minecraft`,
    mcVersion: '1.21.4',
    loader: null,
    side: 'client',
    metadataSource: 'launcher',
    modCount: 0,
  },
];

export const MOCK_PROBES: LauncherProbe[] = [
  { launcher: 'modrinth', path: `${ROAMING}\\ModrinthApp\\app.db`, result: { state: 'found', count: 1 }, notes: [] },
  { launcher: 'prism', path: `${ROAMING}\\PrismLauncher\\instances`, result: { state: 'found', count: 1 }, notes: [] },
  { launcher: 'multimc', path: 'D:\\MultiMC\\instances', result: { state: 'found', count: 1 }, notes: [] },
  { launcher: 'curseforge', path: `${HOME}\\curseforge\\minecraft\\Instances`, result: { state: 'found', count: 1 }, notes: [] },
  { launcher: 'vanilla', path: `${ROAMING}\\.minecraft\\launcher_profiles.json`, result: { state: 'found', count: 1 }, notes: [] },
];

/** `?scenario=empty`: every location checked, nothing found. */
export const EMPTY_PROBES: LauncherProbe[] = [
  { launcher: 'modrinth', path: `${ROAMING}\\ModrinthApp\\app.db`, result: { state: 'notInstalled' }, notes: [] },
  { launcher: 'prism', path: `${ROAMING}\\PrismLauncher\\instances`, result: { state: 'found', count: 0 }, notes: [] },
  { launcher: 'multimc', path: `${ROAMING}\\MultiMC\\instances`, result: { state: 'notInstalled' }, notes: [] },
  {
    launcher: 'curseforge',
    path: `${HOME}\\curseforge\\minecraft\\Instances`,
    result: { state: 'permissionDenied' },
    notes: ['folder is owned by another user'],
  },
  { launcher: 'vanilla', path: `${ROAMING}\\.minecraft\\launcher_profiles.json`, result: { state: 'found', count: 0 }, notes: [] },
];

export function mockDiscovery(empty: boolean): DiscoveryReport {
  return empty ? { instances: [], probes: EMPTY_PROBES } : { instances: MOCK_INSTANCES, probes: MOCK_PROBES };
}

// ── Jar builders ─────────────────────────────────────────────────────────────

const range = (syntax: RangeSyntax, ...raw: string[]): RawRange => ({ syntax, raw, unrepresentable: null });

type DepSpec = [modId: string, kind: DependencyKind, range: string];

interface ModSpec {
  modId: string;
  version: string;
  name?: string | null;
  loader: LoaderKind;
  /** MC range; Maven syntax for Forge/NeoForge, Fabric predicates otherwise. */
  mc: string;
  /** Loader-dependency range (`forge` / `neoforge` / `fabricloader`). */
  loaderRange: string | null;
  deps?: DepSpec[];
  provides?: string[];
  env?: ModEnvironment;
}

function isForgeLike(k: LoaderKind) {
  return k === 'forge' || k === 'neoforge' || k === 'legacyforge';
}

function forgeExcerpt(s: ModSpec, deps: Dependency[]): string {
  const lines = [
    'modLoader="javafml"',
    `loaderVersion="[${s.loader === 'neoforge' ? '4' : '47'},)"`,
    'license="All Rights Reserved"',
    '',
    '[[mods]]',
    `modId="${s.modId}"`,
    `version="${s.version}"`,
    `displayName="${s.name ?? s.modId}"`,
    '',
  ];
  for (const d of deps) {
    lines.push(
      `[[dependencies.${s.modId}]]`,
      `    modId="${d.modId}"`,
      s.loader === 'neoforge' ? `    type="${d.kind === 'required' ? 'required' : d.kind === 'incompatible' ? 'incompatible' : 'optional'}"` : `    mandatory=${d.kind === 'required'}`,
      `    versionRange="${d.range.raw[0] ?? '*'}"`,
      '    ordering="NONE"',
      `    side="${d.side ?? 'BOTH'}"`,
    );
  }
  return lines.join('\n');
}

function fabricExcerpt(s: ModSpec, deps: Dependency[]): string {
  const depends = deps.filter((d) => d.kind === 'required');
  const breaks = deps.filter((d) => d.kind === 'breaks');
  const obj: Record<string, unknown> = {
    schemaVersion: 1,
    id: s.modId,
    version: s.version,
    name: s.name ?? s.modId,
    environment: s.env === 'client' ? 'client' : s.env === 'server' ? 'server' : '*',
    depends: Object.fromEntries(depends.map((d) => [d.modId, d.range.raw.join(' || ') || '*'])),
  };
  if (s.provides?.length) obj.provides = s.provides;
  if (breaks.length) obj.breaks = Object.fromEntries(breaks.map((d) => [d.modId, d.range.raw.join(' || ') || '*']));
  return JSON.stringify(obj, null, 2);
}

function modMeta(s: ModSpec): ModMeta {
  const forgeLike = isForgeLike(s.loader);
  const syntax: RangeSyntax = forgeLike ? 'maven' : 'fabric';
  const loaderDep = s.loader === 'neoforge' ? 'neoforge' : forgeLike ? 'forge' : s.loader === 'quilt' ? 'quilt_loader' : 'fabricloader';
  const side = forgeLike ? (s.env === 'client' ? 'CLIENT' : s.env === 'server' ? 'SERVER' : 'BOTH') : null;
  const deps: Dependency[] = [];
  if (s.loaderRange) deps.push({ modId: loaderDep, kind: 'required', range: range(syntax, s.loaderRange), side });
  deps.push({ modId: 'minecraft', kind: 'required', range: range(syntax, s.mc), side });
  for (const [modId, kind, r] of s.deps ?? []) deps.push({ modId, kind, range: range(syntax, r), side });
  return {
    modId: s.modId,
    version: s.version,
    name: s.name ?? null,
    loader: s.loader,
    provides: s.provides ?? [],
    environment: s.env ?? 'both',
    mcRange: range(syntax, s.mc),
    loaderRange: s.loaderRange ? range(syntax, s.loaderRange) : null,
    languageLoader: forgeLike ? 'javafml' : null,
    languageRange: forgeLike ? range('maven', s.loader === 'neoforge' ? '[4,)' : '[47,)') : null,
    deps,
    metadataFile: s.loader === 'neoforge' ? 'META-INF/neoforge.mods.toml' : forgeLike ? 'META-INF/mods.toml' : s.loader === 'quilt' ? 'quilt.mod.json' : 'fabric.mod.json',
    metadataExcerpt: forgeLike ? forgeExcerpt(s, deps) : fabricExcerpt(s, deps),
  };
}

interface JarSpec {
  file: string;
  /** Folder relative to the scan root. */
  dir?: string;
  disabled?: boolean;
  mods: ModSpec[];
  /** Own Java packages; generated from the first mod id when omitted. */
  packages?: string[];
  mixins?: string[];
  /** Class-file major version (61 = Java 17, 65 = Java 21). */
  maxClass?: number | null;
  status?: JarStatus;
  moduleName?: string | null;
  nested?: Array<{ entry: string; group: string; artifact: string; range: string; mod: ModSpec; packages?: string[] }>;
  sizeKb?: number;
}

const AUTHORS = ['mrcrayfish', 'simibubi', 'shadows', 'teamabnormals', 'vazkii', 'jaredlll08', 'cadiboo', 'tterrag', 'blay09', 'lothrazar', 'fuzs', 'darkhax'];

function packagesFor(modId: string, r: () => number): string[] {
  const author = AUTHORS[Math.floor(r() * AUTHORS.length)]!;
  const base = `com.${author}.${modId.replace(/[^a-z0-9_]/g, '')}`;
  const subs = ['', '.client', '.common', '.mixin', '.network', '.registry', '.data', '.compat', '.util', '.block', '.item'];
  const n = 2 + Math.floor(r() * 7);
  return subs.slice(0, n).map((s) => base + s).sort();
}

function buildJar(spec: JarSpec, seed: number): JarRecord[] {
  const r = seeded(seed);
  const dir = spec.dir ?? 'mods';
  const fileName = spec.disabled ? `${spec.file}.disabled` : spec.file;
  const id = `${dir}/${spec.file}`;
  const status: JarStatus = spec.status ?? { state: 'ok' };
  const mods = status.state === 'ok' ? spec.mods.map(modMeta) : [];
  const primary = spec.mods[0];
  const nestedRecords: JarRecord[] = (spec.nested ?? []).map((n, i) => {
    const nr = seeded(seed + 101 + i);
    const meta = modMeta(n.mod);
    return {
      id: `${id}!/${n.entry}`,
      path: n.entry,
      fileName: n.entry.slice(n.entry.lastIndexOf('/') + 1),
      size: Math.round((40 + nr() * 900) * 1024),
      mtimeMs: 0,
      sha1: hex(nr, 40),
      sha512: hex(nr, 128),
      disabled: !!spec.disabled,
      depth: 1,
      parentId: id,
      status: { state: 'ok' },
      metadataErrors: [],
      loaders: [meta.loader],
      mods: [meta],
      packages: n.packages ?? packagesFor(n.mod.modId, nr),
      mixinConfigs: [],
      maxClassMajor: 61,
      moduleName: null,
      fmlModType: null,
      jarjar: { group: n.group, artifact: n.artifact, range: n.range, version: n.mod.version },
      nested: [],
    };
  });
  const top: JarRecord = {
    id,
    path: `${dir}/${fileName}`,
    fileName,
    size: Math.round((spec.sizeKb ?? 30 + r() * 4000) * 1024),
    mtimeMs: 1_717_000_000_000 + Math.floor(r() * 12_000_000_000),
    sha1: hex(r, 40),
    sha512: hex(r, 128),
    disabled: !!spec.disabled,
    depth: 0,
    parentId: null,
    status,
    metadataErrors: [],
    loaders: [...new Set(mods.map((m) => m.loader))],
    mods,
    packages: status.state === 'ok' ? (spec.packages ?? (primary ? packagesFor(primary.modId, r) : [])) : [],
    mixinConfigs: status.state === 'ok' ? (spec.mixins ?? (primary && r() < 0.45 ? [`${primary.modId}.mixins.json`] : [])) : [],
    maxClassMajor: status.state === 'ok' ? (spec.maxClass === undefined ? 61 : spec.maxClass) : null,
    moduleName: spec.moduleName ?? null,
    fmlModType: null,
    jarjar: null,
    nested: nestedRecords.map((n) => n.id),
  };
  return [top, ...nestedRecords];
}

// ── Filler mods ──────────────────────────────────────────────────────────────

const PREFIX = ['', '', '', 'better', 'more', 'simple', 'fancy', 'extra', 'tiny', 'easy', 'smart', 'cozy', 'deep', 'quark', 'ftb', 'mcw'];
const STEM = [
  'storage', 'biomes', 'lights', 'crates', 'backpacks', 'furniture', 'villagers', 'mobs', 'tools', 'farming', 'cooking',
  'pipes', 'trees', 'caves', 'ores', 'magic', 'compass', 'maps', 'chat', 'hud', 'tweaks', 'waystones', 'elevators',
  'dungeons', 'structures', 'boats', 'carts', 'banners', 'barrels', 'doors', 'fences', 'bridges', 'paths', 'lanterns',
  'quests', 'chunks', 'teams', 'ranks', 'backups', 'essentials', 'library', 'core', 'utils', 'gems', 'armor', 'weapons',
];

const title = (s: string) => s.replace(/(^|_)([a-z])/g, (_, sep: string, c: string) => (sep ? ' ' : '') + c.toUpperCase());

function filler(count: number, seed: number, loader: LoaderKind, mc: string, loaderRange: string, mcVersion: string, taken: Set<string>): JarSpec[] {
  const r = seeded(seed);
  const out: JarSpec[] = [];
  let guard = 0;
  while (out.length < count && guard++ < count * 50) {
    const p = PREFIX[Math.floor(r() * PREFIX.length)]!;
    const s = STEM[Math.floor(r() * STEM.length)]!;
    let modId = p ? `${p}${s}` : s;
    if (taken.has(modId)) modId = `${modId}_${Math.floor(r() * 900 + 100)}`;
    if (taken.has(modId)) continue;
    taken.add(modId);
    const version = `${Math.floor(r() * 6)}.${Math.floor(r() * 12)}.${Math.floor(r() * 30)}`;
    const name = (p ? `${title(p)} ` : '') + title(s);
    const loaderTag = loader === 'neoforge' ? 'neoforge' : isForgeLike(loader) ? 'forge' : 'fabric';
    out.push({
      file: `${modId}-${loaderTag}-${mcVersion}-${version}.jar`,
      disabled: r() < 0.025,
      mods: [{ modId, version, name, loader, mc, loaderRange, env: 'both' }],
    });
  }
  return out;
}

// ── Per-instance jar sets ────────────────────────────────────────────────────

const F = { forge: (mc = '[1.20.1,1.21)', lr: string | null = '[47,)') => ({ loader: 'forge' as const, mc, loaderRange: lr }) };

function atm9(): JarSpec[] {
  const named: JarSpec[] = [
    {
      file: 'create-1.20.1-0.5.1.f.jar',
      mods: [{ modId: 'create', version: '0.5.1.f', name: 'Create', ...F.forge(), deps: [['flywheel', 'required', '[0.6.10,0.6.11)']] }],
      mixins: ['create.mixins.json'],
      sizeKb: 14_820,
      nested: [
        {
          entry: 'META-INF/jarjar/flywheel-forge-1.20.1-0.6.10-7.jar',
          group: 'com.jozufozu.flywheel',
          artifact: 'flywheel-forge-1.20.1',
          range: '[0.6.10-7,0.6.11)',
          mod: { modId: 'flywheel', version: '0.6.10-7', name: 'Flywheel', ...F.forge() },
        },
        {
          entry: 'META-INF/jarjar/Registrate-MC1.20-1.3.3.jar',
          group: 'com.tterrag.registrate',
          artifact: 'Registrate',
          range: '[MC1.20-1.3.3,)',
          mod: { modId: 'registrate', version: 'MC1.20-1.3.3', name: 'Registrate', ...F.forge() },
        },
      ],
    },
    // Split package (E-SPLIT-PKG): both renderers ship me.jellysquid.mods.sodium.client.
    {
      file: 'embeddium-0.3.18+mc1.20.1.jar',
      mods: [{ modId: 'embeddium', version: '0.3.18+mc1.20.1', name: 'Embeddium', ...F.forge() }],
      packages: ['me.jellysquid.mods.sodium.client', 'me.jellysquid.mods.sodium.client.render', 'org.embeddedt.embeddium.api'],
      mixins: ['embeddium.mixins.json'],
    },
    {
      file: 'rubidium-0.7.1.jar',
      mods: [{ modId: 'rubidium', version: '0.7.1', name: 'Rubidium', ...F.forge() }],
      packages: ['me.jellysquid.mods.sodium.client', 'me.jellysquid.mods.sodium.client.gl', 'me.jellysquid.mods.sodium.common'],
      mixins: ['rubidium.mixins.json'],
    },
    // Wrong loader (E-WRONG-LOADER): a Fabric jar in a Forge pack.
    {
      file: 'sodium-fabric-0.5.8+mc1.20.1.jar',
      mods: [{ modId: 'sodium', version: '0.5.8+mc1.20.1', name: 'Sodium', loader: 'fabric', mc: '~1.20.1', loaderRange: '>=0.12.0', env: 'client' }],
      packages: ['me.jellysquid.mods.sodium.fabric', 'net.caffeinemc.mods.sodium.api'],
      mixins: ['sodium.mixins.json'],
    },
    // Missing dependency (E-MISSING-DEP): botarium is not installed.
    {
      file: 'ad_astra-forge-1.20.1-1.15.18.jar',
      mods: [{ modId: 'ad_astra', version: '1.15.18', name: 'Ad Astra', ...F.forge(), deps: [['botarium', 'required', '[2.3.3,)'], ['resourcefullib', 'required', '[2.1.20,)']] }],
      mixins: ['ad_astra-common.mixins.json', 'ad_astra.mixins.json'],
    },
    {
      file: 'resourcefullib-forge-1.20.1-2.1.24.jar',
      mods: [{ modId: 'resourcefullib', version: '2.1.24', name: 'Resourceful Lib', ...F.forge() }],
    },
    // Duplicate mod id (E-DUP-ID): two JEI builds.
    {
      file: 'jei-1.20.1-forge-15.2.0.27.jar',
      mods: [{ modId: 'jei', version: '15.2.0.27', name: 'Just Enough Items', ...F.forge() }],
      packages: ['mezz.jei.api', 'mezz.jei.common', 'mezz.jei.forge', 'mezz.jei.gui', 'mezz.jei.library'],
    },
    {
      file: 'jei-1.20.1-forge-15.3.0.4.jar',
      mods: [{ modId: 'jei', version: '15.3.0.4', name: 'Just Enough Items', ...F.forge() }],
      packages: ['mezz.jei.api', 'mezz.jei.common', 'mezz.jei.forge', 'mezz.jei.gui', 'mezz.jei.library'],
    },
    // Corrupt jar (W-CORRUPT-JAR).
    {
      file: 'betterfoliage-1.20.1-5.0.2.jar',
      mods: [],
      status: { state: 'corrupt', reason: 'Not a valid zip archive: end of central directory record not found.' },
      sizeKb: 212,
    },
    // Class files newer than the pack's Java (W-JAVA-CLASS): Java 21 classes on 1.20.1 (Java 17).
    {
      file: 'fastsuite-1.20.1-5.0.1.jar',
      mods: [{ modId: 'fastsuite', version: '5.0.1', name: 'FastSuite', ...F.forge() }],
      maxClass: 65,
    },
    // MC range excludes 1.20.1 (E-MC-RANGE).
    {
      file: 'lithostitched-forge-1.20.4-1.1.5.jar',
      mods: [{ modId: 'lithostitched', version: '1.1.5', name: 'Lithostitched', ...F.forge('[1.20.4,1.21)', '[49,)') }],
    },
    { file: 'curios-forge-5.9.1+1.20.1.jar', mods: [{ modId: 'curios', version: '5.9.1+1.20.1', name: 'Curios API', ...F.forge() }], mixins: ['curios.mixins.json'] },
    { file: 'architectury-9.2.14-forge.jar', mods: [{ modId: 'architectury', version: '9.2.14', name: 'Architectury', ...F.forge() }] },
    { file: 'cloth-config-11.1.118-forge.jar', mods: [{ modId: 'cloth_config', version: '11.1.118', name: 'Cloth Config v10 API', ...F.forge() }] },
    {
      file: 'appliedenergistics2-forge-15.2.1.jar',
      mods: [{ modId: 'ae2', version: '15.2.1', name: 'Applied Energistics 2', ...F.forge() }],
      sizeKb: 9_420,
      nested: [
        {
          entry: 'META-INF/jarjar/guideme-20.1.7.jar',
          group: 'org.appliedenergistics',
          artifact: 'guideme',
          range: '[20.1.7,)',
          mod: { modId: 'guideme', version: '20.1.7', name: 'GuideME', ...F.forge() },
        },
      ],
    },
    { file: 'Mekanism-1.20.1-10.4.5.20.jar', mods: [{ modId: 'mekanism', version: '10.4.5', name: 'Mekanism', ...F.forge() }], sizeKb: 11_300 },
    { file: 'ftb-quests-forge-2001.3.2.jar', mods: [{ modId: 'ftbquests', version: '2001.3.2', name: 'FTB Quests', ...F.forge(), deps: [['ftblibrary', 'required', '[2001.1.3,)']] }] },
    { file: 'ftb-library-forge-2001.2.1.jar', mods: [{ modId: 'ftblibrary', version: '2001.2.1', name: 'FTB Library', ...F.forge() }] },
    { file: 'oculus-mc1.20.1-1.6.9.jar', mods: [{ modId: 'oculus', version: '1.6.9', name: 'Oculus', ...F.forge(), env: 'client' }], mixins: ['oculus.mixins.json'] },
    { file: 'jade-1.20.1-forge-11.8.0.jar', mods: [{ modId: 'jade', version: '11.8.0', name: 'Jade', ...F.forge() }] },
    { file: 'OptiFine_1.20.1_HD_U_I6.jar', mods: [], packages: ['net.optifine', 'net.optifine.shaders', 'net.optifine.util'], maxClass: 61 },
    // Named by the crash reports and logs of the browser preview (mockLogs.ts, from fixtures/logs).
    {
      file: 'emberforge-1.20.1-2.4.0.jar',
      mods: [{ modId: 'emberforge', version: '2.4.0', name: 'Emberforge', ...F.forge() }],
      packages: ['com.cinderwick.emberforge', 'com.cinderwick.emberforge.block', 'com.cinderwick.emberforge.client', 'com.cinderwick.emberforge.mixin.client'],
      mixins: ['emberforge.mixins.json'],
    },
    {
      file: 'tidyterrain-1.20.1-1.8.2.jar',
      mods: [{ modId: 'tidyterrain', version: '1.8.2', name: 'Tidy Terrain', ...F.forge() }],
      packages: ['dev.tidy.terrain', 'dev.tidy.terrain.mixin', 'dev.tidy.terrain.worldgen'],
      mixins: ['tidyterrain.mixins.json'],
    },
    {
      file: 'pipeworks-1.20.1-2.3.1.jar',
      mods: [{ modId: 'pipeworks', version: '2.3.1', name: 'Pipeworks', ...F.forge() }],
      packages: ['net.brassgear.pipeworks', 'net.brassgear.pipeworks.block.entity', 'net.brassgear.pipeworks.network'],
      mixins: ['pipeworks.mixins.json'],
    },
    {
      file: 'hearthstone-hud-1.20.1-0.6.1.jar',
      mods: [{ modId: 'hearthhud', version: '0.6.1', name: 'Hearthstone HUD', ...F.forge(), env: 'client' }],
      packages: ['net.kilnworks.hearthhud', 'net.kilnworks.hearthhud.client', 'net.kilnworks.hearthhud.mixin'],
      mixins: ['hearthhud.mixins.json'],
    },
    {
      file: 'lanternlight-1.20.1-1.0.3.jar',
      mods: [{ modId: 'lanternlight', version: '1.0.3', name: 'Lantern Light', ...F.forge() }],
      packages: ['io.github.lumenworks.lanternlight', 'io.github.lumenworks.lanternlight.mixin'],
      mixins: ['lanternlight.mixins.json'],
    },
    {
      file: 'saplingsplus-forge-1.20.1-3.0.0.jar',
      mods: [{ modId: 'saplingsplus', version: '3.0.0', name: 'Saplings Plus', ...F.forge() }],
      packages: ['org.grovekeep.saplings', 'org.grovekeep.saplings.common'],
      mixins: ['saplingsplus.mixins.json'],
    },
    {
      file: 'Larder-Forge-1.20.1-4.2.17.jar',
      mods: [{ modId: 'larder', version: '4.2.17', name: 'Larder', ...F.forge() }],
      packages: ['net.pantrydev.larder', 'net.pantrydev.larder.api'],
      mixins: ['larder.mixins.json'],
    },
  ];
  const taken = new Set(named.flatMap((j) => j.mods.map((m) => m.modId)).concat(['flywheel', 'registrate', 'guideme', 'botarium']));
  return [...named, ...filler(512 - named.length, 9001, 'forge', '[1.20.1,1.21)', '[47,)', '1.20.1', taken)];
}

function fabric121(): JarSpec[] {
  const fab = (mc = '>=1.21 <1.21.2', lr = '>=0.15.0') => ({ loader: 'fabric' as const, mc, loaderRange: lr });
  const named: JarSpec[] = [
    { file: 'sodium-fabric-0.6.0+mc1.21.1.jar', mods: [{ modId: 'sodium', version: '0.6.0+mc1.21.1', name: 'Sodium', ...fab(), env: 'client' }], mixins: ['sodium.mixins.json'], maxClass: 65 },
    { file: 'iris-fabric-1.8.0+mc1.21.1.jar', mods: [{ modId: 'iris', version: '1.8.0+mc1.21.1', name: 'Iris', ...fab(), env: 'client', deps: [['sodium', 'required', '>=0.6.0-beta.2']] }], maxClass: 65 },
    { file: 'lithium-fabric-0.13.1+mc1.21.1.jar', mods: [{ modId: 'lithium', version: '0.13.1+mc1.21.1', name: 'Lithium', ...fab() }], maxClass: 65 },
    { file: 'fabric-api-0.105.0+1.21.1.jar', mods: [{ modId: 'fabric-api', version: '0.105.0+1.21.1', name: 'Fabric API', ...fab(), provides: ['fabric'] }], maxClass: 65, sizeKb: 2_160 },
    { file: 'modmenu-11.0.2.jar', mods: [{ modId: 'modmenu', version: '11.0.2', name: 'Mod Menu', ...fab(), env: 'client' }], maxClass: 65 },
    // Fabric has no module layer: a shared package is informational (I-SPLIT-PKG).
    { file: 'entityculling-fabric-1.7.0-mc1.21.jar', mods: [{ modId: 'entityculling', version: '1.7.0', name: 'EntityCulling', ...fab(), env: 'client' }], packages: ['dev.tr7zw.entityculling', 'dev.tr7zw.util'], maxClass: 65 },
    { file: 'notenoughanimations-fabric-1.8.0-mc1.21.jar', mods: [{ modId: 'notenoughanimations', version: '1.8.0', name: 'NotEnoughAnimations', ...fab(), env: 'client' }], packages: ['dev.tr7zw.notenoughanimations', 'dev.tr7zw.util'], maxClass: 65 },
    // Named by the crash reports of the browser preview (mockLogs.ts, from fixtures/logs).
    { file: 'glintful-1.21.1-fabric-3.2.0.jar', mods: [{ modId: 'glintful', version: '3.2.0', name: 'Glintful', ...fab(), env: 'client' }], packages: ['me.prism.glintful', 'me.prism.glintful.client', 'me.prism.glintful.mixin'], mixins: ['glintful.mixins.json'], maxClass: 65 },
    { file: 'trinketry-1.21.1-1.4.0.jar', mods: [{ modId: 'trinketry', version: '1.4.0', name: 'Trinketry', ...fab() }], packages: ['com.pebble.trinketry', 'com.pebble.trinketry.client', 'com.pebble.trinketry.slot'], mixins: ['trinketry.mixins.json'], maxClass: 65 },
    { file: 'stackcount-1.21.1-1.0.2.jar', mods: [{ modId: 'stackcount', version: '1.0.2', name: 'Stack Count', ...fab(), env: 'client' }], packages: ['io.github.tallyho.stackcount'], mixins: ['stackcount.mixins.json'], maxClass: 65 },
  ];
  const taken = new Set(named.flatMap((j) => j.mods.map((m) => m.modId)));
  return [...named, ...filler(87 - named.length, 2101, 'fabric', '>=1.21', '>=0.15.0', '1.21.1', taken).map((j) => ({ ...j, maxClass: 65 }))];
}

function server(): JarSpec[] {
  const fab = (mc = '~1.20.1', lr = '>=0.14.21') => ({ loader: 'fabric' as const, mc, loaderRange: lr });
  const named: JarSpec[] = [
    // Client-only mods on a server (W-CLIENT-ON-SERVER).
    { file: 'sodium-fabric-0.5.8+mc1.20.1.jar', mods: [{ modId: 'sodium', version: '0.5.8+mc1.20.1', name: 'Sodium', ...fab(), env: 'client' }] },
    { file: 'iris-mc1.20.1-1.7.2.jar', mods: [{ modId: 'iris', version: '1.7.2+mc1.20.1', name: 'Iris', ...fab(), env: 'client' }] },
    { file: 'modmenu-7.2.2.jar', mods: [{ modId: 'modmenu', version: '7.2.2', name: 'Mod Menu', ...fab(), env: 'client' }] },
    { file: 'fabric-api-0.92.2+1.20.1.jar', mods: [{ modId: 'fabric-api', version: '0.92.2+1.20.1', name: 'Fabric API', ...fab(), provides: ['fabric'] }] },
    { file: 'lithium-fabric-mc1.20.1-0.11.2.jar', mods: [{ modId: 'lithium', version: '0.11.2', name: 'Lithium', ...fab() }] },
    { file: 'ferritecore-6.0.1-fabric.jar', mods: [{ modId: 'ferritecore', version: '6.0.1', name: 'FerriteCore', ...fab() }] },
    { file: 'spark-1.10.53-fabric.jar', mods: [{ modId: 'spark', version: '1.10.53', name: 'spark', ...fab() }] },
    { file: 'chunky-1.3.146.jar', mods: [{ modId: 'chunky', version: '1.3.146', name: 'Chunky', ...fab(), env: 'server' }] },
  ];
  const taken = new Set(named.flatMap((j) => j.mods.map((m) => m.modId)));
  return [...named, ...filler(44 - named.length, 4401, 'fabric', '~1.20.1', '>=0.14.21', '1.20.1', taken)];
}

function cabin(): JarSpec[] {
  const taken = new Set<string>(['create']);
  return [
    { file: 'create-mc1.16.5_v0.3.2g.jar', mods: [{ modId: 'create', version: 'mc1.16.5_v0.3.2g', name: 'Create', loader: 'forge', mc: '[1.16.5,1.17)', loaderRange: '[36.2.0,)' }], maxClass: 52, sizeKb: 9_800 },
    ...filler(155, 1651, 'forge', '[1.16.5,1.17)', '[36,)', '1.16.5', taken).map((j) => ({ ...j, maxClass: 52 })),
  ];
}

function neo121(): JarSpec[] {
  const neo = (mc = '[1.21.1,1.22)', lr = '[21.1.0,)') => ({ loader: 'neoforge' as const, mc, loaderRange: lr });
  const named: JarSpec[] = [
    // A Forge-only build in a NeoForge 1.21 pack (E-WRONG-LOADER).
    { file: 'travelersbackpack-forge-1.21.1-10.1.1.jar', mods: [{ modId: 'travelersbackpack', version: '10.1.1', name: "Traveler's Backpack", loader: 'forge', mc: '[1.21.1,1.22)', loaderRange: '[52,)' }], maxClass: 65 },
    { file: 'sodium-neoforge-0.6.0+mc1.21.1.jar', mods: [{ modId: 'sodium', version: '0.6.0+mc1.21.1', name: 'Sodium', ...neo(), env: 'client' }], maxClass: 65 },
  ];
  const taken = new Set(named.flatMap((j) => j.mods.map((m) => m.modId)));
  return [...named, ...filler(40, 2111, 'neoforge', '[1.21.1,1.22)', '[21.1.0,)', '1.21.1', taken).map((j) => ({ ...j, maxClass: 65 }))];
}

function cobblemon(): JarSpec[] {
  const taken = new Set<string>(['cobblemon']);
  const fab = { loader: 'fabric' as const, mc: '1.21.1', loaderRange: '>=0.16.0' };
  return [
    { file: 'Cobblemon-fabric-1.5.2+1.21.1.jar', dir: 'overrides/mods', mods: [{ modId: 'cobblemon', version: '1.5.2+1.21.1', name: 'Cobblemon', ...fab }], maxClass: 65, sizeKb: 31_200 },
    ...filler(60, 1521, 'fabric', '1.21.1', '>=0.16.0', '1.21.1', taken).map((j, i) => ({ ...j, dir: i % 9 === 4 ? 'client-overrides/mods' : 'overrides/mods', maxClass: 65 })),
  ];
}

// ── The .mrpack "opened" in the browser preview (M7) ─────────────────────────

/**
 * What `pick_mrpack` answers in the browser preview (no native dialog exists there): a small
 * Fabric 1.20.1 pack. Two jars ship in the zip (`overrides/`, `client-overrides/`); the index
 * declares six more by hash (`mockDeclaredFiles`).
 */
export const MOCK_PICKED_PACK: Instance = {
  id: 'a7c3e91f05d24b68',
  name: 'Explorer Kit 2.1',
  launcher: 'mrpack',
  root: `${HOME}\\Downloads\\Explorer Kit 2.1.mrpack`,
  gameDir: `${HOME}\\Downloads\\Explorer Kit 2.1.mrpack`,
  mcVersion: '1.20.1',
  loader: { kind: 'fabric', version: '0.15.11' },
  side: 'client',
  metadataSource: 'mrpack',
  modCount: 8,
};

function explorerKit(): JarSpec[] {
  const fab = { loader: 'fabric' as const, mc: '>=1.20 <1.21', loaderRange: '>=0.15.0' };
  return [
    {
      file: 'explorerkit-branding-2.1.0.jar',
      dir: 'overrides/mods',
      mods: [{ modId: 'explorerkit_branding', version: '2.1.0', name: 'Explorer Kit Branding', ...fab }],
      maxClass: 61,
      sizeKb: 24,
    },
    {
      file: 'menu-tweaks-1.3.0.jar',
      dir: 'client-overrides/mods',
      mods: [{ modId: 'menutweaks', version: '1.3.0', name: 'Menu Tweaks', ...fab, env: 'client' }],
      maxClass: 61,
      sizeKb: 41,
    },
  ];
}

/**
 * One file the mock index declares, with what Modrinth knows of its hash: `project` (slug, title,
 * version, loaders, game versions) when it is identified, else nothing (not on Modrinth).
 */
export interface MockDeclared {
  file: DeclaredFile;
  project: { slug: string; title: string; versionNumber: string; loaders: string[]; gameVersions: string[]; env?: 'client_only' | 'client_and_server' } | null;
}

function declared(path: string, client: string | null, server: string | null, url: string, sizeKb: number): DeclaredFile {
  const r = seeded(hashString(`declared:${path}`));
  return { path, sha1: hex(r, 40), sha512: hex(r, 128), size: sizeKb * 1024, client, server, downloads: [url] };
}

const cdn = (pid: string, file: string) => `https://cdn.modrinth.com/data/${pid}/versions/${file}`;

/**
 * The index of `MOCK_PICKED_PACK`. Deliberately: one download outside Modrinth's allowlist
 * (Xaero's Minimap from a CurseForge CDN → W-MRPACK-DOWNLOAD), one file Modrinth does not know
 * (I-NOT-ON-MODRINTH) and one built for another Minecraft version (ImmediatelyFast for 1.21.1 →
 * E-MC-RANGE).
 */
export function mockDeclaredFiles(): Readonly<Record<string, readonly MockDeclared[]>> {
  // Built on first use: a module-level table of function calls would survive tree-shaking and
  // carry mock strings into production bundles (mockIpc.ts is imported, never used, there).
  declaredCache ??= {
    'a7c3e91f05d24b68': [
      {
        file: declared('mods/fabric-api-0.92.2+1.20.1.jar', 'required', 'required', cdn('P7dR8mSH', 'fabric-api-0.92.2+1.20.1.jar'), 2140),
        project: { slug: 'fabric-api', title: 'Fabric API', versionNumber: '0.92.2+1.20.1', loaders: ['fabric'], gameVersions: ['1.20.1'] },
      },
      {
        file: declared('mods/sodium-fabric-0.5.11+mc1.20.1.jar', 'required', 'unsupported', cdn('AANobbMI', 'sodium-fabric-0.5.11+mc1.20.1.jar'), 1012),
        project: { slug: 'sodium', title: 'Sodium', versionNumber: '0.5.11+mc1.20.1', loaders: ['fabric'], gameVersions: ['1.20.1'], env: 'client_only' },
      },
      {
        file: declared('mods/lithium-fabric-mc1.20.1-0.11.2.jar', 'optional', 'required', cdn('gvQqBUqZ', 'lithium-fabric-mc1.20.1-0.11.2.jar'), 688),
        project: { slug: 'lithium', title: 'Lithium', versionNumber: 'mc1.20.1-0.11.2', loaders: ['fabric'], gameVersions: ['1.20.1'] },
      },
      {
        file: declared('mods/Xaeros_Minimap_24.2.0_Fabric_1.20.jar', 'required', 'unsupported', 'https://mediafilez.forgecdn.net/files/5395/104/Xaeros_Minimap_24.2.0_Fabric_1.20.jar', 1480),
        project: { slug: 'xaeros-minimap', title: "Xaero's Minimap", versionNumber: '24.2.0', loaders: ['fabric'], gameVersions: ['1.20.1'], env: 'client_only' },
      },
      {
        file: declared('mods/explorer-waypoints-0.4.jar', 'required', 'optional', 'https://github.com/explorer-kit/waypoints/releases/download/v0.4/explorer-waypoints-0.4.jar', 96),
        project: null,
      },
      {
        file: declared('mods/ImmediatelyFast-Fabric-1.3.4+1.21.1.jar', 'required', 'unsupported', cdn('5ZwdcRci', 'ImmediatelyFast-Fabric-1.3.4+1.21.1.jar'), 520),
        project: { slug: 'immediatelyfast', title: 'ImmediatelyFast', versionNumber: '1.3.4+1.21.1', loaders: ['fabric'], gameVersions: ['1.21.1'], env: 'client_only' },
      },
    ],
  };
  return declaredCache;
}

let declaredCache: Record<string, readonly MockDeclared[]> | null = null;

/** `ScanResult.declared` of a mock pack (empty for anything else). */
export function mockDeclared(instanceId: string): DeclaredFile[] {
  return (mockDeclaredFiles()[instanceId] ?? []).map((d) => d.file);
}

const SETS: Record<string, () => JarSpec[]> = {
  '3f9c2a71d0b84e15': atm9,
  '8a1e40c6f7d23b90': fabric121,
  '7d3a5c19e0f2b864': server,
  'c04d9e2b61a8f735': cabin,
  '51b7e8d02c94a6f3': neo121,
  '2b8f61e4d7a09c53': cobblemon,
  // MOCK_PICKED_PACK.id, as a literal so the table stays a pure (tree-shakable) object.
  a7c3e91f05d24b68: explorerKit,
};

const cache = new Map<string, JarRecord[]>();

/** Every jar (top-level and nested, flattened) a scan of `instanceId` reports. */
export function mockJars(instanceId: string): JarRecord[] {
  const hit = cache.get(instanceId);
  if (hit) return hit;
  const specs = SETS[instanceId]?.() ?? [];
  const jars = specs.flatMap((s) => buildJar(s, hashString(`${instanceId}/${s.file}`)));
  cache.set(instanceId, jars);
  return jars;
}

/** A folder "picked" in the browser preview (no native dialog exists there). */
export function pickedFolderInstance(n: number): Instance {
  const name = n === 1 ? 'my-test-pack' : `my-test-pack-${n}`;
  return {
    id: hex(seeded(hashString(name)), 16),
    name,
    launcher: 'manual',
    root: `${HOME}\\Desktop\\${name}`,
    gameDir: `${HOME}\\Desktop\\${name}`,
    mcVersion: null,
    loader: null,
    side: 'client',
    metadataSource: 'inferred',
    modCount: 0,
  };
}

// ── Jars written by mock fixes (mockFix.ts) ──────────────────────────────────

/** One mod a jar written by a mock fix declares. */
export interface MockModSpec {
  modId: string;
  version: string;
  name: string;
  loader: LoaderKind;
  /** Minecraft range in the loader's syntax (Maven for Forge/NeoForge, Fabric predicates otherwise). */
  mc: string;
  /** Dependencies other than the loader and Minecraft: `[modId, kind, range]`. */
  deps?: DepSpec[];
  env?: ModEnvironment;
}

/** Class-file major version a jar built for `mc` uses (Java 8 / 17 / 21). */
function classMajorFor(mc: string): number {
  const [maj = 1, min = 0, patch = 0] = mc.split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
  if (maj > 1) return 65;
  if (min < 17) return 52;
  return min > 20 || (min === 20 && patch >= 5) ? 65 : 61;
}

/**
 * A top-level jar at `path` declaring `mod`, as a mock fix writes it: a downloaded version, or an
 * old jar kept in a seeded backup snapshot. `sha1` / `sha512` / `sizeBytes` pin the file facts
 * (a download's come from its Modrinth file); otherwise they derive from `path`.
 */
export function mockJarAt(
  path: string,
  mod: MockModSpec,
  opts: { mcVersion: string; sizeBytes?: number; sha1?: string; sha512?: string; mtimeMs?: number },
): JarRecord {
  const slash = path.lastIndexOf('/');
  const spec: JarSpec = {
    file: path.slice(slash + 1),
    dir: slash < 0 ? '' : path.slice(0, slash),
    mods: [{ modId: mod.modId, version: mod.version, name: mod.name, loader: mod.loader, mc: mod.mc, loaderRange: null, deps: mod.deps ?? [], env: mod.env ?? 'both' }],
    maxClass: classMajorFor(opts.mcVersion),
    sizeKb: (opts.sizeBytes ?? 512 * 1024) / 1024,
  };
  const top = buildJar(spec, hashString(`fix:${path}:${mod.version}`))[0]!;
  return {
    ...top,
    size: opts.sizeBytes ?? top.size,
    sha1: opts.sha1 ?? top.sha1,
    sha512: opts.sha512 ?? top.sha512,
    mtimeMs: opts.mtimeMs ?? top.mtimeMs,
  };
}
