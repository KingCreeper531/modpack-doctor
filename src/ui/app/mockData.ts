/**
 * Deterministic mock data for the browser preview (mockIpc.ts): a discovery report spanning
 * several launchers and realistic `JarRecord`s per instance. The jar sets deliberately contain
 * what the static checks look for (wrong loader, missing dependency, duplicate mod id, split
 * package, client-only on a server, corrupt jar, a class file newer than the pack's Java), so
 * the real `src/core` checks fire against them exactly as they would against a Rust scan.
 */
import type {
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

const SETS: Record<string, () => JarSpec[]> = {
  '3f9c2a71d0b84e15': atm9,
  '8a1e40c6f7d23b90': fabric121,
  '7d3a5c19e0f2b864': server,
  'c04d9e2b61a8f735': cabin,
  '51b7e8d02c94a6f3': neo121,
  '2b8f61e4d7a09c53': cobblemon,
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
