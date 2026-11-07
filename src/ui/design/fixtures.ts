/** Fixture data for /design, typed with the real contract types. Deterministic (seeded). */
import type { AppError, Instance, LauncherProbe, OpStatus, WorkOrder } from '../../bindings';
import type { Finding } from '../../core/model';
import type { AboutInfo } from '../components/AboutPlate';
import type { PaletteGroup } from '../components/CommandPalette';
import type { ModRow } from '../components/ModTable';
import type { Tile } from '../components/TileGrid';
import type { TileState } from '../components/tileGridModel';

/** mulberry32: small, seedable, good enough for fixtures. */
export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const INSTANCES: Instance[] = [
  {
    id: '3f9c2a71d0b84e15',
    name: 'All the Mods 9',
    launcher: 'curseforge',
    root: 'C:\\Users\\alex\\curseforge\\minecraft\\Instances\\All the Mods 9',
    gameDir: 'C:\\Users\\alex\\curseforge\\minecraft\\Instances\\All the Mods 9',
    mcVersion: '1.20.1',
    loader: { kind: 'forge', version: '47.3.0' },
    side: 'client',
    metadataSource: 'launcher',
    modCount: 214,
  },
  {
    id: '8a1e40c6f7d23b90',
    name: 'Fabulously Optimized',
    launcher: 'modrinth',
    root: 'C:\\Users\\alex\\AppData\\Roaming\\ModrinthApp\\profiles\\Fabulously Optimized',
    gameDir: 'C:\\Users\\alex\\AppData\\Roaming\\ModrinthApp\\profiles\\Fabulously Optimized',
    mcVersion: '1.21.1',
    loader: { kind: 'fabric', version: '0.16.5' },
    side: 'client',
    metadataSource: 'launcher',
    modCount: 87,
  },
  {
    id: 'c04d9e2b61a8f735',
    name: 'Create: Above and Beyond',
    launcher: 'prism',
    root: 'C:\\Users\\alex\\AppData\\Roaming\\PrismLauncher\\instances\\CABIN',
    gameDir: 'C:\\Users\\alex\\AppData\\Roaming\\PrismLauncher\\instances\\CABIN\\.minecraft',
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
    id: 'e6290f4a1b3dc875',
    name: 'Quilt sandbox',
    launcher: 'vanilla',
    root: 'C:\\Users\\alex\\AppData\\Roaming\\.minecraft',
    gameDir: 'C:\\Users\\alex\\AppData\\Roaming\\.minecraft',
    mcVersion: '1.20.4',
    loader: { kind: 'quilt', version: '0.26.3' },
    side: 'client',
    metadataSource: 'inferred',
    modCount: 31,
  },
  {
    id: '7d3a5c19e0f2b864',
    name: 'server-pack',
    launcher: 'manual',
    root: 'D:\\servers\\smp-2024',
    gameDir: 'D:\\servers\\smp-2024',
    mcVersion: '1.12.2',
    loader: { kind: 'legacyforge', version: '14.23.5.2860' },
    side: 'server',
    metadataSource: 'inferred',
    modCount: 63,
  },
  {
    id: '2b8f61e4d7a09c53',
    name: 'Cobblemon Official 1.5',
    launcher: 'mrpack',
    root: 'C:\\Users\\alex\\Downloads\\Cobblemon Official Modpack 1.5.2.mrpack',
    gameDir: 'C:\\Users\\alex\\Downloads\\Cobblemon Official Modpack 1.5.2.mrpack',
    mcVersion: null,
    loader: null,
    side: 'client',
    metadataSource: 'mrpack',
    modCount: 118,
  },
];

export const INSTANCE_STATUS = ['error', 'warning', 'ok', 'unscanned', 'ok', 'warning', 'unscanned'] as const;

export const PROBES: LauncherProbe[] = [
  { launcher: 'modrinth', path: 'C:\\Users\\alex\\AppData\\Roaming\\ModrinthApp\\app.db', result: { state: 'notInstalled' }, notes: [] },
  { launcher: 'prism', path: 'C:\\Users\\alex\\AppData\\Roaming\\PrismLauncher\\instances', result: { state: 'found', count: 0 }, notes: [] },
  { launcher: 'multimc', path: 'C:\\Users\\alex\\AppData\\Roaming\\MultiMC\\instances', result: { state: 'notInstalled' }, notes: [] },
  {
    launcher: 'curseforge',
    path: 'C:\\Users\\alex\\curseforge\\minecraft\\Instances',
    result: { state: 'permissionDenied' },
    notes: ['folder is owned by another user'],
  },
  { launcher: 'vanilla', path: 'C:\\Users\\alex\\AppData\\Roaming\\.minecraft\\launcher_profiles.json', result: { state: 'found', count: 0 }, notes: [] },
  {
    launcher: 'modrinth',
    path: 'D:\\Portable\\ModrinthApp\\app.db',
    // A busy app.db degrades to listing profile folders (discovery M2/B): Found + note, not Error.
    result: { state: 'found', count: 0 },
    notes: ['database busy — retried 3×; folders listed without metadata'],
  },
];

export const ERRORS: AppError[] = [
  {
    kind: 'permission',
    message: 'Modpack Doctor cannot read this folder. Close the launcher and try again, or check the folder permissions.',
    path: 'C:\\Users\\alex\\curseforge\\minecraft\\Instances\\All the Mods 9\\mods',
  },
  { kind: 'gameRunning', message: 'Minecraft is running from this instance. Quit the game before changing files.', path: null },
  { kind: 'hashMismatch', message: 'The downloaded file did not match the checksum Modrinth published. Nothing was changed.', path: 'mods/sodium-0.5.11.jar' },
];

/** Jar names shown in chips and fix labels. */
export const JAR_NAMES: Record<string, string> = {
  'mods/sodium-0.5.8.jar': 'sodium-0.5.8.jar',
  'mods/embeddium-0.3.18.jar': 'embeddium-0.3.18.jar',
  'mods/rubidium-0.7.1.jar': 'rubidium-0.7.1.jar',
  'mods/create-1.20.1-0.5.1.f.jar': 'create-1.20.1-0.5.1.f.jar',
  'mods/flywheel-forge-1.20.1-0.6.10.jar': 'flywheel-forge-0.6.10.jar',
  'mods/iris-1.7.2.jar': 'iris-1.7.2.jar',
  'mods/oculus-1.20.1-1.6.9.jar': 'oculus-1.6.9.jar',
};

export const FINDINGS: Finding[] = [
  {
    id: 'f-split-01',
    code: 'E-SPLIT-PKG',
    severity: 'error',
    title: 'Two jars ship package me.jellysquid.mods.sodium.client',
    explanation:
      'embeddium-0.3.18.jar and rubidium-0.7.1.jar both contain classes in the same Java package. Forge loads mods as Java modules, and a package may belong to only one module, so the game stops with a ResolutionException before the title screen. Keep one of the two renderers.',
    culprits: [
      { jarId: 'mods/embeddium-0.3.18.jar', fileName: 'embeddium-0.3.18.jar', modId: 'embeddium' },
      { jarId: 'mods/rubidium-0.7.1.jar', fileName: 'rubidium-0.7.1.jar', modId: 'rubidium' },
    ],
    evidence: [
      {
        kind: 'log',
        source: 'logs/latest.log',
        lines: [
          { n: 412, text: '[main/INFO] [cpw.mods.modlauncher.LaunchServiceHandler/MODLAUNCHER]: Launching target \'forgeclient\'', role: 'context' },
          { n: 413, text: '[main/ERROR] [net.minecraftforge.fml.loading.ModSorter/LOADING]: Module resolution failed', role: 'context' },
          {
            n: 414,
            text: 'java.lang.module.ResolutionException: Modules embeddium and rubidium export package me.jellysquid.mods.sodium.client to module flywheel',
            role: 'culprit',
          },
          { n: 415, text: '\tat java.lang.module.Resolver.resolveFail(Resolver.java:901)', role: 'context' },
          { n: 1620, text: '[main/INFO] [net.minecraftforge.fml.loading.FMLLoader/]: Shutting down', role: 'context' },
        ],
        frames: [],
      },
    ],
    fixes: [
      { kind: 'disable', jarId: 'mods/rubidium-0.7.1.jar' },
      { kind: 'disable', jarId: 'mods/embeddium-0.3.18.jar' },
    ],
  },
  {
    id: 'f-mixin-02',
    code: 'C-MIXIN',
    severity: 'error',
    title: 'Mixin apply failed: oculus.mixins.json targets a class Iris also patches',
    explanation:
      'oculus-1.6.9.jar failed to apply a mixin to LevelRenderer while the game was starting. The stack trace runs through Iris, which is a Fabric shader mod and does not belong in a Forge pack. Remove Iris; Oculus is the Forge port of the same mod.',
    culprits: [
      { jarId: 'mods/oculus-1.20.1-1.6.9.jar', fileName: 'oculus-1.6.9.jar', modId: 'oculus' },
      { jarId: 'mods/iris-1.7.2.jar', fileName: 'iris-1.7.2.jar', modId: 'iris' },
    ],
    evidence: [
      {
        kind: 'log',
        source: 'crash-reports/crash-2024-11-02_21.14.07-client.txt',
        lines: [
          { n: 1, text: '---- Minecraft Crash Report ----', role: 'context' },
          { n: 2, text: '// Shall we play a game?', role: 'context' },
          { n: 6, text: 'Description: Initializing game', role: 'context' },
          {
            n: 8,
            text: 'org.spongepowered.asm.mixin.transformer.throwables.MixinTransformerError: An unexpected critical error was encountered',
            role: 'culprit',
          },
          { n: 9, text: '\tat net.irisshaders.iris.mixin.MixinLevelRenderer.iris$beginLevelRender(MixinLevelRenderer.java:92)', role: 'culprit' },
          { n: 10, text: '\tat net.coderbot.iris.compat.sodium.mixin.MixinSodiumWorldRenderer.handler$zza000(MixinSodiumWorldRenderer.java:41)', role: 'context' },
          { n: 11, text: '\tat net.minecraft.client.renderer.LevelRenderer.renderLevel(LevelRenderer.java:1205)', role: 'context' },
          { n: 1216, text: '-- System Details --', role: 'context' },
        ],
        frames: [
          { line: 9, jarId: 'mods/iris-1.7.2.jar' },
          { line: 10, jarId: 'mods/oculus-1.20.1-1.6.9.jar' },
        ],
      },
    ],
    fixes: [{ kind: 'disable', jarId: 'mods/iris-1.7.2.jar' }],
  },
  {
    id: 'f-dep-03',
    code: 'E-MISSING-DEP',
    severity: 'error',
    title: 'create requires flywheel [0.6.10,0.6.11) — not installed',
    explanation:
      'Create 0.5.1.f declares a required dependency on Flywheel 0.6.10. No jar in the pack provides the mod id flywheel, so Forge refuses to load Create. The matching Flywheel build for 1.20.1 is on Modrinth.',
    culprits: [{ jarId: 'mods/create-1.20.1-0.5.1.f.jar', fileName: 'create-1.20.1-0.5.1.f.jar', modId: 'create' }],
    evidence: [
      {
        kind: 'metadata',
        jarId: 'mods/create-1.20.1-0.5.1.f.jar',
        file: 'META-INF/mods.toml',
        excerpt:
          '[[dependencies.create]]\n    modId="forge"\n    mandatory=true\n    versionRange="[47.1.3,)"\n[[dependencies.create]]\n    modId="flywheel"\n    mandatory=true\n    versionRange="[0.6.10,0.6.11)"\n    ordering="AFTER"',
        highlight: [6, 8],
      },
      { kind: 'note', text: 'Pack: Forge 47.3.0 on 1.20.1 (from launcher metadata)' },
    ],
    fixes: [{ kind: 'installDependency', modId: 'flywheel', versionId: 'Gx3kM2pQ' }],
  },
  {
    id: 'f-java-04',
    code: 'W-JAVA-CLASS',
    severity: 'warning',
    title: 'sodium-0.5.8.jar is compiled for Java 21; this pack ships Java 17',
    explanation:
      'Class files in this jar have major version 65 (Java 21). Minecraft 1.20.1 runs on Java 17, so the mod will fail to load unless the launcher is configured with a newer runtime. Usually this means the jar was built for a newer Minecraft version.',
    culprits: [{ jarId: 'mods/sodium-0.5.8.jar', fileName: 'sodium-0.5.8.jar', modId: 'sodium' }],
    evidence: [{ kind: 'note', text: 'maxClassMajor 65 (Java 21) · pack runtime Java 17' }],
    fixes: [
      { kind: 'replace', jarId: 'mods/sodium-0.5.8.jar', versionId: 'yaoBL9D9' },
      { kind: 'manual', steps: ['Open the instance settings in your launcher.', 'Set the Java runtime to Java 21.', 'Rescan with Ctrl+R.'] },
    ],
  },
  {
    id: 'f-mr-05',
    code: 'I-NOT-ON-MODRINTH',
    severity: 'info',
    title: '12 jars could not be matched on Modrinth',
    explanation: 'These files are not published on Modrinth, or were repackaged. Static checks still ran; updates cannot be suggested for them.',
    culprits: [{ jarId: 'mods/flywheel-forge-1.20.1-0.6.10.jar', fileName: 'flywheel-forge-0.6.10.jar', modId: 'flywheel' }],
    evidence: [],
    fixes: [],
  },
];

export const WORK_ORDER_FIX: WorkOrder = {
  id: '0412',
  instanceId: '3f9c2a71d0b84e15',
  kind: 'fix',
  title: 'Disable rubidium, replace sodium, install flywheel',
  actions: [
    { kind: 'disable', jarId: 'mods/rubidium-0.7.1.jar' },
    { kind: 'replace', jarId: 'mods/sodium-0.5.8.jar', versionId: 'yaoBL9D9' },
    { kind: 'installDependency', modId: 'flywheel', versionId: 'Gx3kM2pQ' },
  ],
  ops: [
    { actionIndex: 0, op: { op: 'rename', from: 'mods/rubidium-0.7.1.jar', to: 'mods/rubidium-0.7.1.jar.disabled' } },
    {
      actionIndex: 1,
      op: {
        op: 'download',
        projectTitle: 'sodium',
        versionNumber: '0.5.11',
        sizeBytes: 319_488,
        url: 'https://cdn.modrinth.com/data/AANobbMI/versions/yaoBL9D9/sodium-fabric-0.5.11.jar',
        sha512: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
        dest: 'mods/sodium-0.5.11.jar',
        replaces: 'mods/sodium-0.5.8.jar',
      },
    },
    { actionIndex: 1, op: { op: 'moveToBackup', path: 'mods/sodium-0.5.8.jar' } },
    {
      actionIndex: 2,
      op: {
        op: 'download',
        projectTitle: 'Flywheel',
        versionNumber: '0.6.10-7',
        sizeBytes: 1_153_434,
        url: 'https://cdn.modrinth.com/data/5lpoZ5Pf/versions/Gx3kM2pQ/flywheel-forge-1.20.1-0.6.10-7.jar',
        sha512: '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
        dest: 'mods/flywheel-forge-1.20.1-0.6.10-7.jar',
        replaces: null,
      },
    },
  ],
  notes: ['manual step: set the Java runtime to Java 21 if sodium still fails'],
  backupDir: 'C:\\Users\\alex\\AppData\\Roaming\\dev.modpackdoctor\\backups\\3f9c2a71d0b84e15\\1730581247118',
};

export const WORK_ORDER_UNDO: WorkOrder = {
  id: '0413',
  instanceId: '3f9c2a71d0b84e15',
  kind: 'undo',
  title: 'Undo: enable rubidium',
  actions: [{ kind: 'enable', jarId: 'mods/rubidium-0.7.1.jar' }],
  ops: [{ actionIndex: 0, op: { op: 'rename', from: 'mods/rubidium-0.7.1.jar.disabled', to: 'mods/rubidium-0.7.1.jar' } }],
  notes: [],
  backupDir: 'C:\\Users\\alex\\AppData\\Roaming\\dev.modpackdoctor\\backups\\3f9c2a71d0b84e15\\1730581247118',
};

export const WORK_ORDER_RESTORE: WorkOrder = {
  id: '0414',
  instanceId: '3f9c2a71d0b84e15',
  kind: 'undo',
  title: 'Undo: replace sodium, install flywheel',
  actions: [
    { kind: 'replace', jarId: 'mods/sodium-0.5.8.jar', versionId: 'yaoBL9D9' },
    { kind: 'installDependency', modId: 'flywheel', versionId: 'Gx3kM2pQ' },
  ],
  ops: [
    { actionIndex: 0, op: { op: 'restore', backupPath: 'mods/sodium-0.5.8.jar', to: 'mods/sodium-0.5.8.jar', expectAbsentOrSha1: null } },
    { actionIndex: 0, op: { op: 'removeCreated', path: 'mods/sodium-0.5.11.jar', expectSha1: '4f2c9e1a7b3d5f6081c2e4a6b8d0f1e3c5a7b9d1' } },
    { actionIndex: 1, op: { op: 'removeCreated', path: 'mods/flywheel-forge-1.20.1-0.6.10-7.jar', expectSha1: 'a7b3d5f6081c2e4a6b8d0f1e3c5a7b9d14f2c9e1' } },
  ],
  notes: [],
  backupDir: 'C:\\Users\\alex\\AppData\\Roaming\\dev.modpackdoctor\\backups\\3f9c2a71d0b84e15\\1730581247118',
};

export const STATUSES_RUNNING: OpStatus[] = [
  { orderId: '0412', index: 0, state: 'done', message: null },
  { orderId: '0412', index: 1, state: 'running', message: null },
];

export const STATUSES_FINISHED: OpStatus[] = [
  { orderId: '0414', index: 0, state: 'done', message: null },
  {
    orderId: '0414',
    index: 1,
    state: 'failed',
    message: 'sha1 changed since the fix (file was modified); left in place',
  },
  { orderId: '0414', index: 2, state: 'skipped', message: null },
];

const PREFIX = ['', '', '', 'better', 'more', 'simple', 'fancy', 'extra', 'tiny', 'easy', 'smart', 'cozy', 'deep'];
const STEM = [
  'storage', 'biomes', 'lights', 'crates', 'backpacks', 'furniture', 'villagers', 'mobs', 'tools', 'farming',
  'cooking', 'pipes', 'trees', 'caves', 'ores', 'magic', 'compass', 'maps', 'chat', 'hud', 'tweaks', 'shaders',
  'waystones', 'elevators', 'dungeons', 'structures', 'boats', 'carts', 'banners', 'barrels',
];
const KNOWN = [
  ['sodium', 'Sodium', '0.5.8'], ['embeddium', 'Embeddium', '0.3.18'], ['create', 'Create', '0.5.1.f'],
  ['jei', 'Just Enough Items', '15.2.0.27'], ['ae2', 'Applied Energistics 2', '15.2.1'], ['mekanism', 'Mekanism', '10.4.5'],
  ['ftbquests', 'FTB Quests', '2001.3.2'], ['curios', 'Curios API', '5.9.1'], ['architectury', 'Architectury', '9.2.14'],
  ['cloth_config', 'Cloth Config v11', '11.1.118'], ['iris', 'Iris', '1.7.2'], ['oculus', 'Oculus', '1.6.9'],
  ['flywheel', 'Flywheel', '0.6.10'], ['rubidium', 'Rubidium', '0.7.1'], ['lithium', 'Lithium', '0.11.2'],
] as const;

export interface FixtureJar {
  id: string;
  modId: string;
  name: string;
  version: string;
  final: TileState;
  count: number;
}

/** 1,000 deterministic jars; tiles and mod rows are taken from the front. */
export const JARS: FixtureJar[] = (() => {
  const r = rng(20241102);
  const out: FixtureJar[] = [];
  const used = new Set<string>();
  for (let i = 0; out.length < 1000; i++) {
    const known = KNOWN[i];
    let modId: string;
    let name: string;
    let version: string;
    if (known) {
      [modId, name, version] = known;
    } else {
      const p = PREFIX[Math.floor(r() * PREFIX.length)]!;
      const s = STEM[Math.floor(r() * STEM.length)]!;
      modId = `${p}${s}${used.has(`${p}${s}`) ? `_${Math.floor(r() * 90 + 10)}` : ''}`;
      if (used.has(modId)) continue;
      name = (p ? `${p[0]!.toUpperCase()}${p.slice(1)} ` : '') + `${s[0]!.toUpperCase()}${s.slice(1)}`;
      version = `${Math.floor(r() * 4)}.${Math.floor(r() * 12)}.${Math.floor(r() * 30)}`;
    }
    used.add(modId);
    const roll = r();
    const final: TileState = roll < 0.03 ? 'error' : roll < 0.09 ? 'warning' : roll < 0.13 ? 'disabled' : 'ok';
    out.push({
      id: `mods/${modId}-${version}.jar`,
      modId,
      name,
      version,
      final,
      count: final === 'error' || final === 'warning' ? 1 + Math.floor(r() * 3) : 0,
    });
  }
  return out;
})();

export function tilesFor(count: number, scanned: boolean): Tile[] {
  return JARS.slice(0, count).map((j) => ({
    id: j.id,
    label: j.modId,
    version: j.version,
    state: scanned ? j.final : 'unscanned',
    count: j.count,
  }));
}

export const MOD_ROWS: ModRow[] = JARS.slice(0, 500).map((j, i) => {
  const r = rng(i + 7);
  const row: ModRow = {
    id: j.id,
    name: j.name,
    modId: j.modId,
    version: j.version,
    loader: i % 23 === 7 ? null : 'forge',
    modrinth: i % 11 === 3 ? { state: 'missing' } : i % 9 === 4 ? { state: 'update', version: `${j.version.split('.')[0]}.${Math.floor(r() * 12)}.${Math.floor(r() * 40) + 1}` } : { state: 'matched' },
    findings: {
      error: j.final === 'error' ? j.count : 0,
      warning: j.final === 'warning' ? j.count : 0,
      info: i % 11 === 3 ? 1 : 0,
    },
    enabled: j.final !== 'disabled',
  };
  if (j.modId === 'create') {
    row.children = [
      { id: `${j.id}!/META-INF/jarjar/flywheel-forge-0.6.10.jar`, name: 'Flywheel', modId: 'flywheel', version: '0.6.10', loader: 'forge', modrinth: { state: 'matched' }, findings: { error: 0, warning: 0, info: 0 }, enabled: true },
      { id: `${j.id}!/META-INF/jarjar/registrate-1.3.3.jar`, name: 'Registrate', modId: 'registrate', version: 'MC1.20-1.3.3', loader: 'forge', modrinth: { state: 'missing' }, findings: { error: 0, warning: 0, info: 1 }, enabled: true },
    ];
  }
  if (j.modId === 'ae2') {
    row.children = [
      { id: `${j.id}!/META-INF/jarjar/guideme-20.1.7.jar`, name: 'GuideME', modId: 'guideme', version: '20.1.7', loader: 'forge', modrinth: { state: 'matched' }, findings: { error: 0, warning: 1, info: 0 }, enabled: true },
    ];
  }
  return row;
});

export const PALETTE_GROUPS: PaletteGroup[] = [
  {
    heading: 'Instances',
    items: [
      { id: 'inst:atm9', label: 'All the Mods 9', detail: 'CF · 1.20.1 · Forge 47.3.0' },
      { id: 'inst:fo', label: 'Fabulously Optimized', detail: 'MR · 1.21.1 · Fabric 0.16.5' },
    ],
  },
  {
    heading: 'Mods',
    items: [
      { id: 'mod:sodium', label: 'sodium', detail: '0.5.8 · mods/sodium-0.5.8.jar' },
      { id: 'mod:embeddium', label: 'embeddium', detail: '0.3.18' },
    ],
  },
  {
    heading: 'Actions',
    items: [
      { id: 'act:rescan', label: 'Rescan instance', shortcut: 'Ctrl+R' },
      { id: 'act:copy', label: 'Copy report as Markdown', shortcut: 'Ctrl+Shift+C' },
      { id: 'act:add', label: 'Add folder…' },
      { id: 'act:about', label: 'About Modpack Doctor' },
    ],
  },
];

export const ABOUT: AboutInfo = {
  version: '0.1.0',
  commit: '28de4a7 (2026-11-02)',
  tauri: '2.12.4 · WebView2 131.0.2903.70',
  dataDir: 'C:\\Users\\alex\\AppData\\Roaming\\dev.modpackdoctor',
  cacheDir: 'C:\\Users\\alex\\AppData\\Local\\dev.modpackdoctor\\cache',
  licence: 'TBD by the owner',
};
