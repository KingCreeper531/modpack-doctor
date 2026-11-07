/**
 * Browser-preview backend with the exact command/event surface of the Rust app (ipc.ts picks it
 * when `__TAURI_INTERNALS__` is absent). Data comes from mockData.ts; scans are simulated by
 * emitting `ScanStarted` and then `ScanProgress` in a shuffled completion order over ~1.5 s, the
 * way the Rust scanner reports jars as rayon finishes them.
 *
 * URL parameters (screenshots and manual review):
 * - `?scenario=default|empty|scanning|errors|offline|crash`
 *   - `empty`: no instances, so the app shows the probes table.
 *   - `scanning`: the first scan freezes mid-way (about 55 % of jars reported).
 *   - `errors`: scanning the first instance fails with a permission error, and so does listing
 *     its logs; fixes fail as always.
 *   - `offline`: Modrinth is switched off in settings (static checks only).
 *   - `crash`: two instances are watched (`Settings.watched`); a few seconds after the UI re-arms
 *     them, each "crashes": a new crash report appears in its log list, the game process goes
 *     away and one `CrashDetected` is emitted per instance, as Rust watch mode would.
 *
 * Logs (M4): `list_log_sources` / `read_log_digest` serve real-format texts from fixtures/logs
 * (mockLogs.ts); the digest is the whole file, as `digestFromText` builds it.
 * - `?theme=dark|light` seeds the stored theme preference.
 */
import type {
  AppError,
  CrashDetected,
  DropRejected,
  GridSort,
  GameStatus,
  InstanceAdded,
  LogDigest,
  LogSource,
  OpStatus,
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
import { mockDiscovery, mockJars, pickedFolderInstance, seeded } from './mockData';
import { mockCrash, mockCrashInstances, mockLogs, toSource, type MockLog } from './mockLogs';

export type MockScenario = 'default' | 'empty' | 'scanning' | 'errors' | 'offline' | 'crash';

export interface MockOptions {
  scenario: MockScenario;
  theme: ThemePref;
  /** How long a full scan takes to report every jar. */
  scanMs: number;
  /** Round-trip delay of every command. */
  latencyMs: number;
  gridSort?: GridSort;
  /** `crash` scenario: override every instance's delay between arming and its crash. */
  crashDelayMs?: number;
}

const SCENARIOS: readonly MockScenario[] = ['default', 'empty', 'scanning', 'errors', 'offline', 'crash'];

export function mockOptionsFromSearch(search: string): MockOptions {
  const p = new URLSearchParams(search);
  const s = p.get('scenario');
  const t = p.get('theme');
  return {
    scenario: SCENARIOS.includes(s as MockScenario) ? (s as MockScenario) : 'default',
    theme: t === 'dark' || t === 'light' ? t : 'system',
    scanMs: 1500,
    latencyMs: 40,
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
    modrinthEnabled: opts.scenario !== 'offline',
    includeBeta: false,
    gridSort: opts.gridSort ?? 'name',
    inspectorWidth: 360,
  };
  let picks = 0;
  let scans = 0;
  const added: Instance[] = [];

  const ev = {
    scanStarted: emitter<ScanStarted>(),
    scanProgress: emitter<ScanProgress>(),
    instanceAdded: emitter<InstanceAdded>(),
    dropRejected: emitter<DropRejected>(),
    crashDetected: emitter<CrashDetected>(),
    opStatus: emitter<OpStatus>(),
  };

  const lag = () => sleep(opts.latencyMs);
  const instances = () => [...discovery.instances, ...added];

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
    await lag();
    const inst = instances().find((i) => i.id === instanceId);
    if (!inst) return err('notFound', 'This instance is no longer on disk. Rescan your launchers to refresh the list.');
    // As in Rust (commands/mod.rs): .mrpack scanning arrives in M7.
    if (inst.launcher === 'mrpack') return notYet('Scanning .mrpack files');
    const first = scans++ === 0;
    if (opts.scenario === 'errors' && instanceId === discovery.instances[0]?.id) {
      return err(
        'permission',
        'Modpack Doctor cannot read the mods folder. Close the launcher and try again, or check the folder permissions.',
        `${inst.gameDir}\\mods`,
      );
    }
    const startedAtMs = Date.now();
    const jars = mockJars(instanceId);
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
    return ok({ instanceId, startedAtMs, durationMs: Date.now() - startedAtMs, jars, declared: [], issues: [] });
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
      if (i < 0) return err('notFound', 'Only folders you added yourself can be removed from the list.');
      added.splice(i, 1);
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
    pickMrpack: async () => notYet('Opening .mrpack files'),
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
    modrinthIdentify: async () => notYet('Modrinth lookups'),
    modrinthFindUpdates: async () => notYet('Modrinth update suggestions'),
    modrinthProjects: async () => notYet('Modrinth project details'),
    modrinthProjectVersions: async () => notYet('Modrinth version lookups'),
    modrinthResolveModId: async () => notYet('Modrinth lookups'),
    planWorkOrder: async () => {
      await lag();
      return notYet('Applying fixes');
    },
    executeWorkOrder: async () => notYet('Applying fixes'),
    discardWorkOrder: async () => notYet('Applying fixes'),
    listBackups: async () => notYet('Backup history'),
    planUndo: async () => notYet('Undo'),
    gameRunning: async (instanceId: string): Promise<Result<GameStatus>> => {
      await lag();
      const inst = instances().find((i) => i.id === instanceId);
      if (!inst) return err('notFound', 'This instance is no longer on disk. Rescan your launchers to refresh the list.');
      const scripted = mockCrash(instanceId);
      // `crash` scenario: the game is running until it crashes.
      if (scripted && opts.scenario === 'crash' && !crashed.has(instanceId)) {
        return ok({ running: true, pids: [scripted.pid], reason: `javaw.exe pid ${scripted.pid} with --gameDir ${inst.gameDir}` });
      }
      return ok({ running: false, pids: [], reason: null });
    },
    getSettings: async () => {
      await lag();
      return ok(settings);
    },
    setSettings: async (patch: SettingsPatch) => {
      await lag();
      return ok(applyPatch(patch));
    },
    saveReport: async () => notYet('Saving reports'),
    setWindowTheme: async () => ok(null),
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
  };
}
