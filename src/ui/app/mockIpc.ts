/**
 * Browser-preview backend with the exact command/event surface of the Rust app (ipc.ts picks it
 * when `__TAURI_INTERNALS__` is absent). Data comes from mockData.ts; scans are simulated by
 * emitting `ScanStarted` and then `ScanProgress` in a shuffled completion order over ~1.5 s, the
 * way the Rust scanner reports jars as rayon finishes them.
 *
 * URL parameters (screenshots and manual review):
 * - `?scenario=default|empty|scanning|errors|offline`
 *   - `empty`: no instances, so the app shows the probes table.
 *   - `scanning`: the first scan freezes mid-way (about 55 % of jars reported).
 *   - `errors`: scanning the first instance fails with a permission error; fixes fail as always.
 *   - `offline`: Modrinth is switched off in settings (static checks only).
 * - `?theme=dark|light` seeds the stored theme preference.
 */
import type {
  AppError,
  CrashDetected,
  DropRejected,
  GridSort,
  InstanceAdded,
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
} from '../../bindings';
import type { AppCommands, Backend, EventChannel, Result, Unlisten } from './ipc';
import { mockDiscovery, mockJars, pickedFolderInstance, seeded } from './mockData';

export type MockScenario = 'default' | 'empty' | 'scanning' | 'errors' | 'offline';

export interface MockOptions {
  scenario: MockScenario;
  theme: ThemePref;
  /** How long a full scan takes to report every jar. */
  scanMs: number;
  /** Round-trip delay of every command. */
  latencyMs: number;
  gridSort?: GridSort;
}

const SCENARIOS: readonly MockScenario[] = ['default', 'empty', 'scanning', 'errors', 'offline'];

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
const notYet = (what: string, milestone: string) => err('internal', `${what} is not implemented yet (${milestone})`);

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
}

export function createMockBackend(options: Partial<MockOptions> = {}): MockBackend {
  const opts: MockOptions = { scenario: 'default', theme: 'system', scanMs: 1500, latencyMs: 40, ...options };
  const empty = opts.scenario === 'empty';
  let discovery = mockDiscovery(empty);
  let settings: Settings = {
    theme: opts.theme,
    manualFolders: [],
    launcherRoots: [],
    watched: [],
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

  async function scanInstance(instanceId: string): Promise<Result<ScanResult>> {
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
    pickMrpack: async () => notYet('pick_mrpack', 'M7'),
    scanInstance,
    listLogSources: async () => notYet('list_log_sources', 'M4'),
    readLogDigest: async () => notYet('read_log_digest', 'M4'),
    setWatch: async () => notYet('set_watch', 'M4'),
    modrinthIdentify: async () => notYet('modrinth_identify', 'M5'),
    modrinthFindUpdates: async () => notYet('modrinth_find_updates', 'M5'),
    modrinthProjects: async () => notYet('modrinth_projects', 'M5'),
    modrinthProjectVersions: async () => notYet('modrinth_project_versions', 'M5'),
    planWorkOrder: async () => {
      await lag();
      return notYet('plan_work_order', 'M6');
    },
    executeWorkOrder: async () => notYet('execute_work_order', 'M6'),
    discardWorkOrder: async () => notYet('discard_work_order', 'M6'),
    listBackups: async () => notYet('list_backups', 'M6'),
    planUndo: async () => notYet('plan_undo', 'M6'),
    gameRunning: async () => ok({ running: false, pids: [], reason: null }),
    getSettings: async () => {
      await lag();
      return ok(settings);
    },
    setSettings: async (patch: SettingsPatch) => {
      await lag();
      return ok(applyPatch(patch));
    },
    saveReport: async () => notYet('save_report', 'M7'),
    setWindowTheme: async () => ok(null),
    checkUpdate: async () => notYet('check_update', 'M8'),
    installUpdate: async () => notYet('install_update', 'M8'),
  };

  return {
    kind: 'mock',
    options: opts,
    commands,
    events: ev,
    settings: () => settings,
  };
}
