/**
 * App state (zustand). One store per app run, created with its backend (ipc.ts) and the
 * rules-core entry points, both injectable for tests.
 *
 * Scan lifecycle: `scan(id)` → Rust emits `ScanStarted` (all stubs, display order) → many
 * `ScanProgress` → `scan_instance` resolves with the `ScanResult` → `resolvePack` + `runChecks`
 * run synchronously → tiles take their final states.
 *
 * Progress batching: `ScanProgress` handlers only push into a plain buffer and request one
 * frame (`requestAnimationFrame`). The frame applies the whole buffer in a single `set`, so a
 * burst of hundreds of events costs one store update and one render per frame, and only the
 * components that select scan progress re-render.
 *
 * Nothing is persisted beyond `Settings` (theme, grid sort, inspector width, overrides).
 */
import { createStore, type StoreApi } from 'zustand/vanilla';

import type {
  AppError,
  DiscoveryReport,
  FixAction,
  GridSort,
  Instance,
  Launcher,
  OpStatus,
  PackOverride,
  ResolvedTheme,
  ScanProgress,
  ScanStarted,
  Settings,
  SettingsPatch,
  ThemePref,
  WorkOrder,
} from '../../bindings';
import { runChecks as coreRunChecks } from '../../core/checks';
import type { CheckInput, Finding, PackContext } from '../../core/model';
import { resolvePack as coreResolvePack } from '../../core/pack';
import type { ModSortKey } from '../components/ModTable';
import { clampSize, INSPECTOR_DEFAULT, INSPECTOR_MAX, INSPECTOR_MIN } from '../components/resize';
import type { SortState } from '../components/sort';
import { packIdentity, topLevelId } from './derive';
import { call, type Backend, type Unlisten } from './ipc';
import { emptyScan, type InstanceScan } from './scanState';

export type Selection = { kind: 'jar'; id: string } | { kind: 'finding'; id: string };

export interface OpenOrder {
  instanceId: string;
  order: WorkOrder;
  statuses: OpStatus[];
  phase: 'review' | 'running' | 'finished';
  rolledBack: boolean;
  error: AppError | null;
}

export interface CoreApi {
  resolvePack: (instance: Instance, scan: NonNullable<InstanceScan['result']>, override?: PackOverride | null) => PackContext;
  runChecks: (input: CheckInput) => Finding[];
}

export interface StoreDeps {
  backend: Backend;
  core?: CoreApi;
  /** Wall clock, ms since epoch. */
  now?: () => number;
  /** Batches progress; defaults to `requestAnimationFrame` (setTimeout outside a browser). */
  frame?: (cb: () => void) => void;
  /**
   * A finding id or jar id to select once the first scan that contains it finishes (the mock
   * backend's `?select=` screenshot hook).
   */
  initialSelect?: string | null;
}

export const DEFAULT_SETTINGS: Settings = {
  theme: 'system',
  manualFolders: [],
  launcherRoots: [],
  watched: [],
  overrides: {},
  modrinthEnabled: true,
  includeBeta: false,
  gridSort: 'name',
  inspectorWidth: INSPECTOR_DEFAULT,
};

export interface AppState {
  phase: 'loading' | 'ready';
  settings: Settings;
  settingsError: AppError | null;
  discovery: DiscoveryReport | null;
  discoveryError: AppError | null;
  /** Add folder / add launcher folder / rejected drop. */
  railError: AppError | null;
  selectedInstanceId: string | null;
  scans: Readonly<Record<string, InstanceScan>>;
  selection: Selection | null;
  /** Jar the mod table should scroll to (tile click, chip click). */
  revealJarId: string | null;
  /** Finding the triage list should expand (selected from outside the list). */
  expandFindingId: string | null;
  /** Mod-table sort per instance, in memory only. */
  modSort: Readonly<Record<string, SortState<ModSortKey> | null>>;
  /** Fix errors keyed by finding id (or `jar:<id>` for the enable toggle). */
  fixErrors: Readonly<Record<string, AppError>>;
  /** Keys with a `plan_work_order` call in flight. */
  fixPending: Readonly<Record<string, true>>;
  overrideError: AppError | null;
  order: OpenOrder | null;
  /** Live inspector width (persisted on commit). */
  inspectorWidth: number;

  init(): Promise<void>;
  dispose(): void;
  selectInstance(id: string): void;
  scan(id: string): Promise<void>;
  select(sel: Selection | null): void;
  revealJar(jarId: string): void;
  setGridSort(sort: GridSort): void;
  setModSort(instanceId: string, sort: SortState<ModSortKey> | null): void;
  setTheme(pref: ThemePref): void;
  setInspectorWidth(width: number): void;
  commitInspectorWidth(width: number): void;
  setOverride(instanceId: string, override: PackOverride | null): Promise<void>;
  fix(key: string, action: FixAction): Promise<void>;
  setJarEnabled(jarId: string, enabled: boolean): Promise<void>;
  executeOrder(): Promise<void>;
  cancelOrder(): Promise<void>;
  addFolder(): Promise<void>;
  addLauncherRoot(launcher: Launcher): Promise<void>;
  clearRailError(): void;
  dismissFixError(key: string): void;
  /** Mirror the resolved theme onto the native title bar (theme.ts calls it). */
  setWindowTheme(theme: ResolvedTheme): Promise<unknown>;
}

export type AppStore = StoreApi<AppState>;

/** A full `SettingsPatch` with every field but the given ones left unchanged (null). */
export function settingsPatch(p: Partial<SettingsPatch>): SettingsPatch {
  return { theme: null, overrides: null, modrinthEnabled: null, includeBeta: null, gridSort: null, inspectorWidth: null, ...p };
}

const UNKNOWN_PACK: AppError = {
  kind: 'invalid',
  message:
    "The pack's Minecraft version or loader is unknown, so a fix can't be checked against it. Set them under Pack identity in the inspector, then try again.",
  path: null,
};

function defaultFrame(cb: () => void) {
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => cb());
  else setTimeout(cb, 16);
}

export function createAppStore(deps: StoreDeps): AppStore {
  const { backend } = deps;
  const core: CoreApi = deps.core ?? { resolvePack: coreResolvePack, runChecks: coreRunChecks };
  const now = deps.now ?? (() => Date.now());
  const frame = deps.frame ?? defaultFrame;
  let initialSelect = deps.initialSelect ?? null;
  const cmd = backend.commands;

  const unlisten: Unlisten[] = [];
  let initOnce: Promise<void> | null = null;
  let pending: ScanProgress[] = [];
  let flushQueued = false;
  /** Latest scan request per instance; stale results are dropped. */
  const tokens = new Map<string, number>();

  const store = createStore<AppState>()((set, get) => {
    const patchScan = (id: string, fn: (s: InstanceScan) => InstanceScan) =>
      set((st) => ({ scans: { ...st.scans, [id]: fn(st.scans[id] ?? emptyScan()) } }));

    const instanceById = (id: string) => get().discovery?.instances.find((i) => i.id === id) ?? null;

    /** Apply every buffered `ScanProgress` in one update. */
    const flush = () => {
      flushQueued = false;
      if (!pending.length) return;
      const batch = pending;
      pending = [];
      set((st) => {
        const scans = { ...st.scans };
        for (const p of batch) {
          const cur = scans[p.instanceId];
          if (!cur || cur.status !== 'scanning') continue;
          const progress = cur.progress === st.scans[p.instanceId]?.progress ? { ...cur.progress } : cur.progress;
          (progress as Record<string, boolean>)[p.jarId] = p.parsed;
          scans[p.instanceId] = { ...cur, progress, done: Math.max(cur.done, p.done), total: p.total };
        }
        return { scans };
      });
    };

    const onStarted = (e: ScanStarted) => {
      pending = pending.filter((p) => p.instanceId !== e.instanceId);
      patchScan(e.instanceId, (s) => ({ ...s, stubs: e.jars, progress: {}, done: 0, total: e.jars.length }));
    };

    const onProgress = (e: ScanProgress) => {
      pending.push(e);
      if (!flushQueued) {
        flushQueued = true;
        frame(flush);
      }
    };

    /** resolvePack → runChecks for an instance with a scan result. */
    const check = (id: string): Partial<InstanceScan> => {
      const sc = get().scans[id];
      const inst = instanceById(id);
      if (!sc?.result || !inst) return {};
      try {
        const pack = core.resolvePack(inst, sc.result, get().settings.overrides[id] ?? null);
        const findings = core.runChecks({ instance: inst, scan: sc.result, pack });
        return { pack, findings, checksError: null };
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        return { pack: null, findings: [], checksError: { kind: 'internal', message: `The checks stopped with an error: ${message}`, path: null } };
      }
    };

    const keepSelection = (id: string) => {
      const sel = get().selection;
      const sc = get().scans[id];
      if (!sel || !sc) return;
      const exists = sel.kind === 'jar' ? !!sc.result?.jars.some((j) => j.id === sel.id) : sc.findings.some((f) => f.id === sel.id);
      if (!exists) set({ selection: null });
    };

    const applyInitialSelect = (id: string) => {
      const want = initialSelect;
      const sc = get().scans[id];
      if (!want || !sc) return;
      if (sc.findings.some((f) => f.id === want)) {
        initialSelect = null;
        set({ selection: { kind: 'finding', id: want }, expandFindingId: want });
      } else if (sc.result?.jars.some((j) => j.id === want)) {
        initialSelect = null;
        set({ selection: { kind: 'jar', id: want }, revealJarId: topLevelId(want) });
      }
    };

    const start = async () => {
      const ev = backend.events;
      const subs = await Promise.all([
        ev.scanStarted.listen(onStarted),
        ev.scanProgress.listen(onProgress),
        ev.instanceAdded.listen(({ instance }) => {
          set((st) => {
            const d = st.discovery ?? { instances: [], probes: [] };
            if (d.instances.some((i) => i.id === instance.id)) return {};
            return { discovery: { ...d, instances: [...d.instances, instance] } };
          });
          get().selectInstance(instance.id);
        }),
        ev.dropRejected.listen(({ name, reason }) =>
          set({ railError: { kind: 'invalid', message: `${name} was not added: ${reason}`, path: null } }),
        ),
        ev.opStatus.listen((s) =>
          set((st) => {
            if (!st.order || st.order.order.id !== s.orderId) return {};
            const statuses = [...st.order.statuses.filter((x) => x.index !== s.index), s];
            return { order: { ...st.order, statuses } };
          }),
        ),
      ]);
      unlisten.push(...subs);

      const [settings, discovery] = await Promise.all([call(cmd.getSettings()), call(cmd.discoverInstances())]);
      if (settings.status === 'ok') {
        set({ settings: settings.data, inspectorWidth: clampSize(settings.data.inspectorWidth, INSPECTOR_MIN, INSPECTOR_MAX) });
      } else set({ settingsError: settings.error });
      if (discovery.status === 'ok') set({ discovery: discovery.data });
      else set({ discoveryError: discovery.error, discovery: { instances: [], probes: [] } });
      set({ phase: 'ready' });
      const first = get().discovery?.instances[0];
      if (first) get().selectInstance(first.id);
    };

    return {
      phase: 'loading',
      settings: DEFAULT_SETTINGS,
      settingsError: null,
      discovery: null,
      discoveryError: null,
      railError: null,
      selectedInstanceId: null,
      scans: {},
      selection: null,
      revealJarId: null,
      expandFindingId: null,
      modSort: {},
      fixErrors: {},
      fixPending: {},
      overrideError: null,
      order: null,
      inspectorWidth: INSPECTOR_DEFAULT,

      init() {
        initOnce ??= start();
        return initOnce;
      },

      dispose() {
        for (const u of unlisten.splice(0)) u();
      },

      setWindowTheme(theme) {
        return call(cmd.setWindowTheme(theme));
      },

      selectInstance(id) {
        if (get().selectedInstanceId !== id) set({ selectedInstanceId: id, selection: null, revealJarId: null, overrideError: null });
        const sc = get().scans[id];
        if (!sc || sc.status === 'idle') void get().scan(id);
      },

      async scan(id) {
        if (get().scans[id]?.status === 'scanning') return;
        const token = (tokens.get(id) ?? 0) + 1;
        tokens.set(id, token);
        // Keep the previous stubs (the grid keeps its shape until ScanStarted replaces them) and
        // the previous result and findings (the triage list and mod table stay readable).
        patchScan(id, (s) => ({ ...s, status: 'scanning', progress: {}, done: 0, total: s.stubs.length, error: null, startedAt: now() }));
        const res = await call(cmd.scanInstance(id));
        if (tokens.get(id) !== token) return;
        flush();
        if (res.status === 'error') {
          patchScan(id, (s) => ({ ...s, status: 'error', error: res.error, finishedAt: now() }));
          return;
        }
        const result = res.data;
        // The result is authoritative; it also covers any progress event that never arrived.
        patchScan(id, (s) => {
          const progress: Record<string, boolean> = { ...s.progress };
          for (const j of result.jars) if (j.depth === 0) progress[j.id] = j.status.state === 'ok';
          const n = Object.keys(progress).length;
          return { ...s, result, progress, done: n, total: n };
        });
        const checked = check(id);
        patchScan(id, (s) => ({ ...s, ...checked, status: 'done', finishedAt: now() }));
        keepSelection(id);
        applyInitialSelect(id);
      },

      select(sel) {
        set({ selection: sel });
      },

      revealJar(jarId) {
        set({ selection: { kind: 'jar', id: jarId }, revealJarId: topLevelId(jarId) });
      },

      setGridSort(gridSort) {
        const prev = get().settings;
        set({ settings: { ...prev, gridSort } });
        void call(cmd.setSettings(settingsPatch({ gridSort }))).then((r) => {
          if (r.status === 'error') set({ settingsError: r.error });
        });
      },

      setModSort(instanceId, sort) {
        set((st) => ({ modSort: { ...st.modSort, [instanceId]: sort } }));
      },

      setTheme(theme) {
        const prev = get().settings;
        set({ settings: { ...prev, theme } });
        void call(cmd.setSettings(settingsPatch({ theme }))).then((r) => {
          if (r.status === 'error') set({ settingsError: r.error });
          else set({ settingsError: null });
        });
      },

      setInspectorWidth(width) {
        set({ inspectorWidth: clampSize(width, INSPECTOR_MIN, INSPECTOR_MAX) });
      },

      commitInspectorWidth(width) {
        const w = clampSize(width, INSPECTOR_MIN, INSPECTOR_MAX);
        set((st) => ({ inspectorWidth: w, settings: { ...st.settings, inspectorWidth: w } }));
        void call(cmd.setSettings(settingsPatch({ inspectorWidth: w }))).then((r) => {
          if (r.status === 'error') set({ settingsError: r.error });
        });
      },

      async setOverride(instanceId, override) {
        const r = await call(cmd.setSettings(settingsPatch({ overrides: { [instanceId]: override } })));
        if (r.status === 'error') {
          set({ overrideError: r.error });
          return;
        }
        set({ settings: r.data, overrideError: null });
        if (get().scans[instanceId]?.result) {
          const checked = check(instanceId);
          patchScan(instanceId, (s) => ({ ...s, ...checked, finishedAt: s.status === 'done' ? now() : s.finishedAt }));
          keepSelection(instanceId);
        }
      },

      async fix(key, action) {
        const id = get().selectedInstanceId;
        // Manual fixes are advice only: their steps are already on screen, nothing to plan.
        if (!id || action.kind === 'manual') return;
        const identity = packIdentity(get().scans[id]?.pack ?? null);
        const setErr = (e: AppError | null) =>
          set((st) => {
            const fixErrors = { ...st.fixErrors };
            if (e) fixErrors[key] = e;
            else delete fixErrors[key];
            const fixPending = { ...st.fixPending };
            delete fixPending[key];
            return { fixErrors, fixPending };
          });
        if (!identity) {
          setErr(UNKNOWN_PACK);
          return;
        }
        set((st) => ({ fixPending: { ...st.fixPending, [key]: true } }));
        const r = await call(cmd.planWorkOrder(id, identity, [action]));
        if (r.status === 'error') {
          setErr(r.error);
          return;
        }
        setErr(null);
        set({ order: { instanceId: id, order: r.data, statuses: [], phase: 'review', rolledBack: false, error: null } });
      },

      async setJarEnabled(jarId, enabled) {
        await get().fix(`jar:${jarId}`, { kind: enabled ? 'enable' : 'disable', jarId });
      },

      async executeOrder() {
        const o = get().order;
        if (!o || o.phase !== 'review') return;
        set({ order: { ...o, phase: 'running' } });
        const r = await call(cmd.executeWorkOrder(o.order.id));
        const cur = get().order;
        if (!cur || cur.order.id !== o.order.id) return;
        if (r.status === 'error') {
          set({ order: { ...cur, phase: 'review', error: r.error } });
          return;
        }
        set({ order: { ...cur, phase: 'finished', statuses: r.data.statuses, rolledBack: r.data.rolledBack, error: null } });
        void get().scan(o.instanceId);
      },

      async cancelOrder() {
        const o = get().order;
        if (!o) return;
        set({ order: null });
        if (o.phase === 'review') await call(cmd.discardWorkOrder(o.order.id));
      },

      async addFolder() {
        const r = await call(cmd.pickAndAddFolder());
        if (r.status === 'error') {
          set({ railError: r.error });
          return;
        }
        set({ railError: null });
        const inst = r.data;
        if (!inst) return;
        set((st) => {
          const d = st.discovery ?? { instances: [], probes: [] };
          return d.instances.some((i) => i.id === inst.id) ? {} : { discovery: { ...d, instances: [...d.instances, inst] } };
        });
        get().selectInstance(inst.id);
      },

      async addLauncherRoot(launcher) {
        const r = await call(cmd.pickLauncherRoot(launcher));
        if (r.status === 'error') {
          set({ railError: r.error });
          return;
        }
        set({ railError: null });
        if (!r.data) return;
        set({ discovery: r.data });
        const sel = get().selectedInstanceId;
        const first = r.data.instances[0];
        if ((!sel || !r.data.instances.some((i) => i.id === sel)) && first) get().selectInstance(first.id);
      },

      clearRailError() {
        set({ railError: null });
      },

      dismissFixError(key) {
        set((st) => {
          const fixErrors = { ...st.fixErrors };
          delete fixErrors[key];
          return { fixErrors };
        });
      },
    };
  });
  return store;
}
