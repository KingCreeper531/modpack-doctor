/**
 * Browser-preview backend with the exact command/event surface of the Rust app (ipc.ts picks it
 * when `__TAURI_INTERNALS__` is absent). Data comes from mockData.ts; scans are simulated by
 * emitting `ScanStarted` and then `ScanProgress` in a shuffled completion order over ~1.5 s, the
 * way the Rust scanner reports jars as rayon finishes them.
 *
 * URL parameters (screenshots and manual review):
 * - `?scenario=default|empty|scanning|errors|offline|ratelimit|modrinthoff|crash`
 *   - `empty`: no instances, so the app shows the probes table.
 *   - `scanning`: the first scan freezes mid-way (about 55 % of jars reported).
 *   - `errors`: scanning the first instance fails with a permission error, and so does listing
 *     its logs; fixes fail as always.
 *   - `offline`: Modrinth is unreachable: every lookup answers `offline` with nothing cached.
 *   - `ratelimit`: the first `modrinth_identify` answers `rateLimited` (`retryAfterS: 5`), every
 *     later call succeeds.
 *   - `modrinthoff`: Modrinth is switched off in settings (static checks only).
 *   - `crash`: two instances are watched (`Settings.watched`); a few seconds after the UI re-arms
 *     them, each "crashes": a new crash report appears in its log list, the game process goes
 *     away and one `CrashDetected` is emitted per instance, as Rust watch mode would.
 *   - `gamerunning`: `game_running` reports Minecraft running for every instance, and every
 *     `execute_work_order` is refused with `gameRunning` (the order stays valid).
 *   - `fixfail`: the 2nd op of every work order fails (the only op of a one-op order); the
 *     completed ops are rolled back and the result says `rolledBack: true`.
 *   - `expired`: the first `execute_work_order` answers `notFound` (the order expired).
 *   - `interrupted`: the 2nd op of every fix order with two or more ops fails and reversing the
 *     1st fails too, so the snapshot stays `incomplete` (History offers Recover).
 *   - `drop`: shortly after start a file "dropped" on the window is refused (`DropRejected`), as
 *     Rust reports a drop that is not a `.mrpack`.
 *
 * `.mrpack` (M7): `pick_mrpack` "opens" `MOCK_PICKED_PACK` (Explorer Kit 2.1); scanning a pack
 * reports the jars inside its zip (`overrides/…`) plus the files its index declares
 * (`ScanResult.declared`, mockData.ts `mockDeclaredFiles`), which `modrinth_identify` knows by hash.
 * `save_report` "saves" to a fake Documents path (no file is written) and answers `null`
 * (cancelled) for every other call with `?scenario=reportcancel`.
 * - `?order=running` (with the `order` screenshot hook, devHooks.ts): the 2nd op of an executed
 *   order starts running and never finishes.
 *
 * Fixes (M6): mockFix.ts plans, executes and undoes work orders over an in-memory copy of each
 * instance's jars, so a rescan after a fix shows the change; backups are recorded per order.
 *
 * Modrinth (M5): realistic answers over the mock jar sets (mockModrinth.ts). With
 * `modrinthEnabled` false every lookup is cache-only and the cache is empty (`offline: true`),
 * as in Rust. Icons arrive only through `modrinth_icons` (after `iconMs`), which fills an icon
 * cache; `modrinth_projects` attaches cached icons only.
 *
 * Logs (M4): `list_log_sources` / `read_log_digest` serve real-format texts from fixtures/logs
 * (mockLogs.ts); the digest is the whole file, as `digestFromText` builds it.
 * - `?theme=dark|light` seeds the stored theme preference.
 */
import type {
  AppError,
  BackupEntry,
  CrashDetected,
  DropRejected,
  FixAction,
  GridSort,
  PackIdentity,
  WorkOrder,
  WorkOrderResult,
  GameStatus,
  HashLookup,
  InstanceAdded,
  LogDigest,
  LogSource,
  MrProject,
  MrVersion,
  OpStatus,
  ProjectLookup,
  ReportFormat,
  ScanProgress,
  ScanStarted,
  Instance,
  JarStub,
  Launcher,
  ScanResult,
  Settings,
  SettingsPatch,
  ThemePref,
  WatchAnchor,
} from '../../bindings';
import { digestFromText } from '../../core/crash';
import type { AppCommands, Backend, EventChannel, Result, Unlisten } from './ipc';
import { MOCK_PICKED_PACK, mockDeclared, mockDiscovery, pickedFolderInstance, seeded } from './mockData';
import { createMockFix, type MockFixEngine } from './mockFix';
import { mockCrash, mockCrashInstances, mockLogs, toSource, type MockLog } from './mockLogs';
import {
  MOCK_RATE_LIMIT_S,
  mockFindUpdates,
  mockIcons,
  mockIdentify,
  mockOffline,
  mockProjects,
  mockProjectVersions,
  mockResolveModId,
} from './mockModrinth';

export type MockScenario =
  | 'default'
  | 'empty'
  | 'scanning'
  | 'errors'
  | 'offline'
  | 'ratelimit'
  | 'modrinthoff'
  | 'crash'
  | 'gamerunning'
  | 'fixfail'
  | 'expired'
  | 'interrupted'
  | 'drop'
  | 'reportcancel';

export interface MockOptions {
  scenario: MockScenario;
  theme: ThemePref;
  /** How long a full scan takes to report every jar. */
  scanMs: number;
  /** Round-trip delay of every command. */
  latencyMs: number;
  /** How long `modrinth_icons` takes to "download" icons (default: `latencyMs`). */
  iconMs?: number;
  gridSort?: GridSort;
  /** `crash` scenario: override every instance's delay between arming and its crash. */
  crashDelayMs?: number;
  /** Delay of each work-order op step (default: ten times `latencyMs`). */
  opMs?: number;
  /** Screenshot hook: the op at this index of an executed order never finishes. */
  holdOpAt?: number | null;
}

const SCENARIOS: readonly MockScenario[] = [
  'default',
  'empty',
  'scanning',
  'errors',
  'offline',
  'ratelimit',
  'modrinthoff',
  'crash',
  'gamerunning',
  'fixfail',
  'expired',
  'interrupted',
  'drop',
  'reportcancel',
];

export function mockOptionsFromSearch(search: string): MockOptions {
  const p = new URLSearchParams(search);
  const s = p.get('scenario');
  const t = p.get('theme');
  return {
    scenario: SCENARIOS.includes(s as MockScenario) ? (s as MockScenario) : 'default',
    theme: t === 'dark' || t === 'light' ? t : 'system',
    scanMs: 1500,
    latencyMs: 40,
    iconMs: 700,
    holdOpAt: p.get('order') === 'running' ? 1 : null,
  };
}

const ok = <T>(data: T): Result<T> => ({ status: 'ok', data });
const err = (kind: AppError['kind'], message: string, path: string | null = null): Result<never> => ({ status: 'error', error: { kind, message, path } });
/** Same shape as Rust's `not_yet` (commands/mod.rs): a neutral `unavailable` error. */
const notYet = (feature: string) => err('unavailable', `${feature} isn't available in this version of Modpack Doctor yet.`);

function emitter<T>() {
  const subs = new Set<(p: T) => void>();
  const ch: EventChannel<T> & { emit(p: T): void } = {
    listen: (cb) => {
      subs.add(cb);
      const off: Unlisten = () => {
        subs.delete(cb);
      };
      return Promise.resolve(off);
    },
    emit: (p) => {
      for (const cb of [...subs]) cb(p);
    },
  };
  return ch;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface MockBackend extends Backend {
  kind: 'mock';
  options: MockOptions;
  /** Test hook: current in-memory settings. */
  settings(): Settings;
  /** Test hook: instances with watch mode armed, and the anchors each was armed with. */
  watches(): ReadonlyMap<string, readonly WatchAnchor[]>;
  /**
   * Test hook: make `instanceId` crash now (its scripted crash report appears, then one
   * `CrashDetected`). Returns the event, or null when the instance has no scripted crash.
   */
  crash(instanceId: string, episode?: number): CrashDetected | null;
  /** Test hook: emit any `CrashDetected` as Rust would (e.g. a repeated episode). */
  emitCrashDetected(e: CrashDetected): void;
  /** Test hook: the fix engine (jar lists, stored orders, expiry). */
  fix: MockFixEngine;
  /** Test hook: every report `save_report` "saved". */
  reports(): ReadonlyArray<{ name: string; format: ReportFormat; contents: string }>;
  /** Test hook: emit a `DropRejected` as Rust does for a refused drop. */
  emitDropRejected(e: DropRejected): void;
}

export function createMockBackend(options: Partial<MockOptions> = {}): MockBackend {
  const opts: MockOptions = { scenario: 'default', theme: 'system', scanMs: 1500, latencyMs: 40, ...options };
  const empty = opts.scenario === 'empty';
  let discovery = mockDiscovery(empty);
  let settings: Settings = {
    theme: opts.theme,
    manualFolders: [],
    launcherRoots: [],
    watched: opts.scenario === 'crash' ? mockCrashInstances() : [],
    overrides: {},
    modrinthEnabled: opts.scenario !== 'modrinthoff',
    includeBeta: false,
    gridSort: opts.gridSort ?? 'name',
    inspectorWidth: 360,
  };
  let picks = 0;
  let scans = 0;
  let identifies = 0;
  /** Project ids whose icon `modrinth_icons` has cached (as Rust's icon cache dir). */
  const iconCache = new Set<string>();
  /** No network: Modrinth switched off (cache-only, empty cache) or unreachable. */
  const mrOffline = () => !settings.modrinthEnabled || opts.scenario === 'offline';
  const added: Instance[] = [];
  const reports: Array<{ name: string; format: ReportFormat; contents: string }> = [];

  const ev = {
    scanStarted: emitter<ScanStarted>(),
    scanProgress: emitter<ScanProgress>(),
    instanceAdded: emitter<InstanceAdded>(),
    dropRejected: emitter<DropRejected>(),
    crashDetected: emitter<CrashDetected>(),
    opStatus: emitter<OpStatus>(),
  };
  if (opts.scenario === 'drop') {
    // As if a .zip had been dropped on the window a moment after start.
    setTimeout(() => ev.dropRejected.emit({ name: 'Explorer Kit 2.1.zip', reason: 'only Modrinth modpacks (.mrpack files) and instance folders can be added.' }), 600);
  }

  const lag = () => sleep(opts.latencyMs);
  const instances = () => [...discovery.instances, ...added];
  /** Instances with a scan in flight (an order is refused while its instance is scanned). */
  const scanning = new Set<string>();
  const fix = createMockFix(
    {
      opMs: opts.opMs ?? opts.latencyMs * 10,
      failSecondOp: opts.scenario === 'fixfail',
      expireFirst: opts.scenario === 'expired',
      gameRunning: opts.scenario === 'gamerunning',
      interrupt: opts.scenario === 'interrupted',
      holdOpAt: opts.holdOpAt ?? null,
    },
    {
      instance: (id) => instances().find((i) => i.id === id),
      override: (id) => settings.overrides[id] ?? null,
      offline: () => mrOffline(),
      scanning: (id) => scanning.has(id),
      emit: (s) => ev.opStatus.emit(s),
      now: () => Date.now(),
      sleep: (ms) => (ms > 0 ? sleep(ms) : Promise.resolve()),
    },
  );

  /** Wall clock when the backend started; log ages are relative to it. */
  const born = Date.now();
  const watches = new Map<string, readonly WatchAnchor[]>();
  /** Crash reports written since start (`crash` scenario / test hook), per instance. */
  const appeared = new Map<string, Array<{ log: MockLog; at: number }>>();
  const crashed = new Set<string>();
  const timers = new Set<string>();
  let episodes = 0;

  /** Every log file of an instance, newest first (as Rust lists them). */
  function sourcesOf(instanceId: string): Array<{ log: MockLog; source: LogSource }> {
    const fresh = (appeared.get(instanceId) ?? []).map(({ log, at }) => ({ log, source: toSource(log, at) }));
    const old = mockLogs(instanceId).map((log) => ({ log, source: toSource(log, born) }));
    return [...fresh, ...old].sort((a, b) => b.source.modifiedMs - a.source.modifiedMs || a.source.id.localeCompare(b.source.id));
  }

  function crash(instanceId: string, episode?: number): CrashDetected | null {
    const scripted = mockCrash(instanceId);
    if (!scripted) return null;
    const at = Date.now();
    const list = (appeared.get(instanceId) ?? []).filter((a) => a.log.id !== scripted.log.id);
    appeared.set(instanceId, [{ log: scripted.log, at }, ...list]);
    crashed.add(instanceId);
    const source = toSource(scripted.log, at);
    const e: CrashDetected = {
      instanceId,
      episode: episode ?? ++episodes,
      source,
      triggers: [
        { kind: 'newCrashReport', source_id: source.id },
        { kind: 'processExit', pid: scripted.pid },
      ],
    };
    ev.crashDetected.emit(e);
    return e;
  }

  /** `crash` scenario: the first arming of a scripted instance schedules its crash. */
  function schedule(instanceId: string) {
    const scripted = mockCrash(instanceId);
    if (opts.scenario !== 'crash' || !scripted || timers.has(instanceId) || crashed.has(instanceId)) return;
    timers.add(instanceId);
    setTimeout(() => {
      if (watches.has(instanceId)) crash(instanceId);
    }, opts.crashDelayMs ?? scripted.delayMs);
  }

  async function scanInstance(instanceId: string): Promise<Result<ScanResult>> {
    scanning.add(instanceId);
    try {
      return await scanOnce(instanceId);
    } finally {
      scanning.delete(instanceId);
    }
  }

  async function scanOnce(instanceId: string): Promise<Result<ScanResult>> {
    await lag();
    const inst = instances().find((i) => i.id === instanceId);
    if (!inst) return err('notFound', 'This instance is no longer on disk. Rescan your launchers to refresh the list.');
    const first = scans++ === 0;
    if (opts.scenario === 'errors' && instanceId === discovery.instances[0]?.id) {
      return err(
        'permission',
        'Modpack Doctor cannot read the mods folder. Close the launcher and try again, or check the folder permissions.',
        `${inst.gameDir}\\mods`,
      );
    }
    const startedAtMs = Date.now();
    // The instance as the mock fixes left it.
    const jars = [...fix.jarsOf(instanceId)];
    const top = jars.filter((j) => j.depth === 0).sort((a, b) => a.fileName.toLowerCase().localeCompare(b.fileName.toLowerCase()));
    const stubs: JarStub[] = top.map((j) => ({ id: j.id, path: j.path, fileName: j.fileName, disabled: j.disabled }));
    ev.scanStarted.emit({ instanceId, jars: stubs });

    const order = top.map((_, i) => i);
    const r = seeded(instanceId.length * 7919 + scans);
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(r() * (i + 1));
      [order[i], order[j]] = [order[j]!, order[i]!];
    }
    const freezeAt = opts.scenario === 'scanning' && first ? Math.floor(top.length * 0.55) : top.length;
    const tick = 16;
    const perTick = Math.max(1, Math.ceil(top.length / Math.max(1, opts.scanMs / tick)));
    let done = 0;
    while (done < freezeAt) {
      const end = Math.min(freezeAt, done + perTick);
      for (; done < end; done++) {
        const jar = top[order[done]!]!;
        ev.scanProgress.emit({ instanceId, done: done + 1, total: top.length, jarId: jar.id, parsed: jar.status.state === 'ok' });
      }
      if (opts.scanMs > 0) await sleep(tick);
    }
    if (freezeAt < top.length) return new Promise<Result<ScanResult>>(() => undefined);
    return ok({ instanceId, startedAtMs, durationMs: Date.now() - startedAtMs, jars, declared: inst.launcher === 'mrpack' ? mockDeclared(instanceId) : [], issues: [] });
  }

  function applyPatch(p: SettingsPatch): Settings {
    const overrides = { ...settings.overrides };
    if (p.overrides) {
      for (const [id, o] of Object.entries(p.overrides)) {
        if (o === null || o === undefined) delete overrides[id];
        else overrides[id] = o;
      }
    }
    settings = {
      ...settings,
      theme: p.theme ?? settings.theme,
      overrides,
      modrinthEnabled: p.modrinthEnabled ?? settings.modrinthEnabled,
      includeBeta: p.includeBeta ?? settings.includeBeta,
      gridSort: p.gridSort ?? settings.gridSort,
      inspectorWidth: p.inspectorWidth ?? settings.inspectorWidth,
    };
    return settings;
  }

  const commands: AppCommands = {
    discoverInstances: async () => {
      await lag();
      return ok({ instances: instances(), probes: discovery.probes });
    },
    pickAndAddFolder: async () => {
      await lag();
      const inst = pickedFolderInstance(++picks);
      added.push(inst);
      settings = { ...settings, manualFolders: [...settings.manualFolders, inst.root] };
      return ok(inst);
    },
    removeManualInstance: async (instanceId: string) => {
      await lag();
      const i = added.findIndex((a) => a.id === instanceId);
      if (i >= 0) {
        added.splice(i, 1);
        return ok(null);
      }
      // Manual folders and opened packs from the seeded discovery can go too (as in Rust).
      const seededHit = discovery.instances.find((d) => d.id === instanceId);
      if (!seededHit || (seededHit.launcher !== 'manual' && seededHit.launcher !== 'mrpack')) {
        return err('notFound', 'Only folders you added yourself and opened packs can be removed from the list.');
      }
      discovery = { ...discovery, instances: discovery.instances.filter((d) => d.id !== instanceId) };
      return ok(null);
    },
    pickLauncherRoot: async (launcher: Launcher) => {
      await lag();
      const path = `D:\\Portable\\${launcher}`;
      settings = { ...settings, launcherRoots: [...settings.launcherRoots, { launcher, path }] };
      discovery = { ...discovery, probes: [...discovery.probes, { launcher, path, result: { state: 'found', count: 0 }, notes: ['added folder'] }] };
      return ok({ instances: instances(), probes: discovery.probes });
    },
    removeLauncherRoot: async () => {
      await lag();
      return ok(null);
    },
    pickMrpack: async (): Promise<Result<Instance | null>> => {
      await lag();
      // Opening the same file again answers the same instance (Rust de-duplicates by path).
      if (!added.some((a) => a.id === MOCK_PICKED_PACK.id)) added.push(MOCK_PICKED_PACK);
      return ok(MOCK_PICKED_PACK);
    },
    scanInstance,
    listLogSources: async (instanceId: string): Promise<Result<LogSource[]>> => {
      await lag();
      const inst = instances().find((i) => i.id === instanceId);
      if (!inst) return err('notFound', 'This instance is no longer on disk. Rescan your launchers to refresh the list.');
      // As in Rust (commands/logs.rs): a .mrpack file has no game folder, so no logs.
      if (inst.launcher === 'mrpack') return ok([]);
      if (opts.scenario === 'errors' && instanceId === discovery.instances[0]?.id) {
        return err('permission', 'Modpack Doctor cannot read the crash-reports folder. Check the folder permissions and try again.', `${inst.gameDir}\\crash-reports`);
      }
      return ok(sourcesOf(instanceId).map((s) => s.source));
    },
    readLogDigest: async (instanceId: string, sourceId: string, anchors: string[]): Promise<Result<LogDigest>> => {
      await lag();
      if (instances().find((i) => i.id === instanceId)?.launcher === 'mrpack') return err('invalid', 'a .mrpack file has no logs to read');
      const hit = sourcesOf(instanceId).find((s) => s.source.id === sourceId);
      if (!hit) return err('notFound', `${sourceId} is not in this instance's log list any more. Refresh the list and try again.`);
      if (anchors.length === 0) return err('invalid', 'No anchors were given, so the log digest would be empty.');
      return ok(digestFromText(hit.log.text, hit.source));
    },
    setWatch: async (instanceId: string, enabled: boolean, anchors: WatchAnchor[]): Promise<Result<null>> => {
      await lag();
      const inst = instances().find((i) => i.id === instanceId);
      if (enabled && !inst) return err('notFound', 'This instance is no longer on disk. Rescan your launchers to refresh the list.');
      if (enabled && inst?.launcher === 'mrpack') return err('invalid', `"${inst.name}" is a .mrpack file, so there is no game to watch`);
      if (enabled && anchors.length === 0) return err('invalid', 'Watch mode needs the crash anchors from the rules core; none were given.');
      if (enabled) {
        watches.set(instanceId, [...anchors]);
        schedule(instanceId);
      } else watches.delete(instanceId);
      const watched = settings.watched.filter((w) => w !== instanceId);
      settings = { ...settings, watched: enabled ? [...watched, instanceId] : watched };
      return ok(null);
    },
    modrinthIdentify: async (sha1s: string[]): Promise<Result<HashLookup>> => {
      await lag();
      if (mrOffline()) return ok(mockOffline(sha1s));
      if (opts.scenario === 'ratelimit' && identifies++ === 0) {
        return {
          status: 'error',
          error: {
            kind: 'rateLimited',
            message: 'Modrinth is limiting requests from this computer for a moment. Modpack Doctor will try again by itself.',
            path: null,
            retryAfterS: MOCK_RATE_LIMIT_S,
          },
        };
      }
      return ok(mockIdentify(sha1s));
    },
    modrinthFindUpdates: async (sha1s: string[], loaders: string[], gameVersions: string[], versionTypes: string[]): Promise<Result<HashLookup>> => {
      await lag();
      if (mrOffline()) return ok(mockOffline(sha1s));
      return ok(mockFindUpdates(sha1s, loaders, gameVersions, versionTypes));
    },
    modrinthProjects: async (ids: string[]): Promise<Result<ProjectLookup>> => {
      await lag();
      if (mrOffline()) return ok({ found: {}, failed: [...ids], offline: true });
      return ok(mockProjects(ids, iconCache));
    },
    modrinthProjectVersions: async (projectId: string, loaders: string[], gameVersions: string[]): Promise<Result<MrVersion[]>> => {
      await lag();
      if (mrOffline()) return err('offline', 'Modrinth is not reachable right now, so versions could not be listed.');
      return ok(mockProjectVersions(projectId, loaders, gameVersions));
    },
    modrinthIcons: async (projectIds: string[]): Promise<Result<Record<string, string>>> => {
      await sleep(opts.iconMs ?? opts.latencyMs);
      // Off or unreachable: no download, only what is cached already.
      const icons = mockIcons(projectIds);
      if (!mrOffline()) for (const id of Object.keys(icons)) iconCache.add(id);
      return ok(Object.fromEntries(Object.entries(icons).filter(([id]) => iconCache.has(id))));
    },
    modrinthResolveModId: async (modId: string): Promise<Result<MrProject | null>> => {
      await lag();
      if (mrOffline()) return err('offline', 'Modrinth is not reachable right now, so the mod could not be looked up.');
      return ok(mockResolveModId(modId, iconCache));
    },
    planWorkOrder: async (instanceId: string, pack: PackIdentity, actions: FixAction[]): Promise<Result<WorkOrder>> => {
      await lag();
      return fix.plan(instanceId, pack, actions);
    },
    executeWorkOrder: async (orderId: string): Promise<Result<WorkOrderResult>> => {
      await lag();
      return fix.execute(orderId);
    },
    discardWorkOrder: async (orderId: string): Promise<Result<null>> => {
      await lag();
      return fix.discard(orderId);
    },
    listBackups: async (instanceId: string): Promise<Result<BackupEntry[]>> => {
      await lag();
      return fix.listBackups(instanceId);
    },
    planUndo: async (backupId: string, actionIndexes: number[] | null): Promise<Result<WorkOrder>> => {
      await lag();
      return fix.planUndo(backupId, actionIndexes);
    },
    gameRunning: async (instanceId: string): Promise<Result<GameStatus>> => {
      await lag();
      const inst = instances().find((i) => i.id === instanceId);
      if (!inst) return err('notFound', 'This instance is no longer on disk. Rescan your launchers to refresh the list.');
      const scripted = mockCrash(instanceId);
      // `crash` scenario: the game is running until it crashes.
      if (scripted && opts.scenario === 'crash' && !crashed.has(instanceId)) {
        return ok({ running: true, pids: [scripted.pid], reason: `javaw.exe pid ${scripted.pid} with --gameDir ${inst.gameDir}` });
      }
      return ok(fix.gameStatus(instanceId));
    },
    getSettings: async () => {
      await lag();
      return ok(settings);
    },
    setSettings: async (patch: SettingsPatch) => {
      await lag();
      return ok(applyPatch(patch));
    },
    saveReport: async (defaultName: string, format: ReportFormat, contents: string): Promise<Result<string | null>> => {
      await lag();
      if (contents.length > 16 * 1024 * 1024) return err('invalid', 'The report is larger than 16 MiB, so it was not saved.');
      if (opts.scenario === 'reportcancel') return ok(null);
      reports.push({ name: defaultName, format, contents });
      return ok(`C:\\Users\\alex\\Documents\\${defaultName}.${format === 'json' ? 'json' : 'md'}`);
    },
    setWindowTheme: async () => ok(null),
    homeDir: async () => ok(String.raw`C:\Users\alex`),
    checkUpdate: async () => notYet('Update checks'),
    installUpdate: async () => notYet('Installing updates'),
  };

  return {
    kind: 'mock',
    options: opts,
    commands,
    events: ev,
    settings: () => settings,
    watches: () => watches,
    crash,
    emitCrashDetected: (e) => ev.crashDetected.emit(e),
    fix,
    reports: () => reports,
    emitDropRejected: (e) => ev.dropRejected.emit(e),
  };
}
