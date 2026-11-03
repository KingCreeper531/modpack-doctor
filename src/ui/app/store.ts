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
 * Crash analysis (M4): an instance's log sources load when it is opened; the newest crash report
 * (else the newest log) is selected and analysed (`read_log_digest` → `analyzeCrash`, see
 * crashState.ts). Watch mode: `setWatch` → `set_watch` with the tiered `CRASH_ANCHORS`; Rust
 * persists `Settings.watched`, and `init` re-arms every watched id once. A `CrashDetected`
 * episode (duplicates dropped) is read and analysed; only an error-severity crash finding
 * (`summarizeCrash` non-null) raises a native notification, a rail alert and selects the crash.
 * When notifications are not allowed, an in-app banner shows instead.
 *
 * Nothing is persisted beyond `Settings` (theme, grid sort, inspector width, overrides; watched
 * instances are persisted by Rust).
 */
import { createStore, type StoreApi } from 'zustand/vanilla';

import type {
  AppError,
  CrashDetected,
  DiscoveryReport,
  FixAction,
  GridSort,
  Instance,
  Launcher,
  LogDigest,
  OpStatus,
  PackOverride,
  ResolvedTheme,
  ScanProgress,
  ScanResult,
  ScanStarted,
  Settings,
  SettingsPatch,
  ThemePref,
  WatchAnchor,
  WorkOrder,
} from '../../bindings';
import { runChecks as coreRunChecks } from '../../core/checks';
import { analyzeCrash as coreAnalyzeCrash, CRASH_ANCHORS, CRASH_ANCHOR_TEXTS } from '../../core/crash';
import { summarizeCrash } from '../../core/crash/summary';
import type { CheckInput, CrashInput, Finding, JarIndex, PackContext } from '../../core/model';
import { buildJarIndex as coreBuildJarIndex, resolvePack as coreResolvePack } from '../../core/pack';
import type { ModSortKey } from '../components/ModTable';
import { clampSize, INSPECTOR_DEFAULT, INSPECTOR_MAX, INSPECTOR_MIN } from '../components/resize';
import type { SortState } from '../components/sort';
import { packIdentity, topLevelId } from './derive';
import {
  defaultSourceId,
  emptyCrashes,
  sortSources,
  upsertSource,
  type CrashAlert,
  type CrashAnalysis,
  type CrashPane,
  type FindingsTab,
  type InstanceCrashes,
} from './crashState';
import { call, type Backend, type Unlisten } from './ipc';
import { deniedNotifier, type Notifier } from './notify';
import { emptyScan, type InstanceScan } from './scanState';

export type FixOrigin = 'triage' | 'inspector' | 'mods';

export type Selection =
  | { kind: 'jar'; id: string }
  | { kind: 'finding'; id: string }
  /** A crash finding (C-*) from one log source's analysis. */
  | { kind: 'crash'; id: string; sourceId: string };

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

/** Rules-core crash entry points (injectable for tests). */
export interface CrashCoreApi {
  analyzeCrash: (input: CrashInput) => Finding[];
  buildJarIndex: (scan: ScanResult) => JarIndex;
}

/** Title of every crash notification (the body is the likely cause). */
export const CRASH_NOTIFICATION_TITLE = 'Modpack crashed';

/** The tiered anchor list as `set_watch` takes it (fresh objects each call). */
export function watchAnchors(): WatchAnchor[] {
  return CRASH_ANCHORS.map((a) => ({ text: a.text, tier: a.tier }));
}

export interface StoreDeps {
  backend: Backend;
  core?: CoreApi;
  crashCore?: CrashCoreApi;
  /** Native crash notifications; defaults to none (every crash goes to the in-app banner). */
  notifier?: Notifier;
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
  /** Where each fix error was triggered, so it renders once, next to the button pressed. */
  fixErrorFrom: Readonly<Record<string, FixOrigin>>;
  /** Instances with a rescan queued behind the running one. */
  rescanQueued: Readonly<Record<string, true>>;
  /** Which backend answers: Tauri, the dev-only browser mock, or nothing (bridge missing). */
  backendKind: Backend['kind'];
  /** Narrow windows show the inspector as a drawer; this is whether it is open. */
  inspectorOpen: boolean;
  /** Keys with a `plan_work_order` call in flight. */
  fixPending: Readonly<Record<string, true>>;
  overrideError: AppError | null;
  order: OpenOrder | null;
  /** Live inspector width (persisted on commit). */
  inspectorWidth: number;
  /** Crash and log analysis per instance. */
  crashes: Readonly<Record<string, InstanceCrashes>>;
  /** Which view the findings panel shows, per instance (default `findings`). */
  findingsTab: Readonly<Record<string, FindingsTab>>;
  /** Announced crashes not looked at yet, per instance (rail pip). */
  crashAlerts: Readonly<Record<string, CrashAlert>>;
  /** Shown when the native notification could not be sent (permission refused). */
  crashBanner: CrashAlert | null;
  /** Instances with a `set_watch` call in flight. */
  watchPending: Readonly<Record<string, true>>;
  watchErrors: Readonly<Record<string, AppError>>;

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
  fix(key: string, action: FixAction, from?: FixOrigin): Promise<void>;
  setInspectorOpen(open: boolean): void;
  setJarEnabled(jarId: string, enabled: boolean): Promise<void>;
  executeOrder(): Promise<void>;
  cancelOrder(): Promise<void>;
  addFolder(): Promise<void>;
  addLauncherRoot(launcher: Launcher): Promise<void>;
  clearRailError(): void;
  dismissFixError(key: string): void;
  /** Mirror the resolved theme onto the native title bar (theme.ts calls it). */
  setWindowTheme(theme: ResolvedTheme): Promise<unknown>;
  /** (Re)list an instance's crash reports and logs; selects and analyses the default source. */
  loadLogSources(id: string): Promise<void>;
  selectLogSource(id: string, sourceId: string): void;
  /** Read and analyse one source (skipped when already analysed, unless `force`). */
  analyzeLogSource(id: string, sourceId: string, force?: boolean): Promise<void>;
  setFindingsTab(id: string, tab: FindingsTab): void;
  setCrashPane(id: string, pane: CrashPane, line?: number | null): void;
  /** Select a crash finding: crash view, its source, the inspector. */
  selectCrash(id: string, sourceId: string, findingId: string): void;
  setWatch(id: string, enabled: boolean): Promise<void>;
  /** Open an announced crash (banner "Show"). */
  openCrashAlert(alert: CrashAlert): void;
  dismissCrashBanner(): void;
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
  const crashCore: CrashCoreApi = deps.crashCore ?? { analyzeCrash: coreAnalyzeCrash, buildJarIndex: coreBuildJarIndex };
  const notifier = deps.notifier ?? deniedNotifier();
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
  /** Instances with one rescan requested while they were scanning. */
  const queued = new Set<string>();
  /** Latest `list_log_sources` / `read_log_digest` request per instance / source. */
  const sourceTokens = new Map<string, number>();
  const digestTokens = new Map<string, number>();
  /** `instanceId#episode` of every `CrashDetected` handled (duplicates are dropped). */
  const episodes = new Set<string>();
  let rearmed = false;
  const indexes = new WeakMap<ScanResult, JarIndex>();
  const bump = (m: Map<string, number>, key: string) => {
    const t = (m.get(key) ?? 0) + 1;
    m.set(key, t);
    return t;
  };

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
      // A late ScanStarted (after the result, or for a scan we never asked for) must not wipe
      // the finished state.
      if (get().scans[e.instanceId]?.status !== 'scanning') return;
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
        const override = get().settings.overrides[id] ?? null;
        const pack = core.resolvePack(inst, sc.result, override);
        // What the pack would be without the override: the override editor's placeholders.
        const detected = override ? core.resolvePack(inst, sc.result, null) : pack;
        const findings = core.runChecks({ instance: inst, scan: sc.result, pack });
        return { pack, detected, findings, checksError: null };
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        return { pack: null, detected: null, findings: [], checksError: { kind: 'internal', message: `The checks stopped with an error: ${message}`, path: null } };
      }
    };

    const keepSelection = (id: string) => {
      const sel = get().selection;
      const sc = get().scans[id];
      if (!sel || !sc) return;
      const exists =
        sel.kind === 'jar'
          ? !!sc.result?.jars.some((j) => j.id === sel.id)
          : sel.kind === 'finding'
            ? sc.findings.some((f) => f.id === sel.id)
            : !!get().crashes[id]?.analyses[sel.sourceId]?.findings.some((f) => f.id === sel.id);
      if (!exists) set({ selection: null });
    };

    const patchCrashes = (id: string, fn: (c: InstanceCrashes) => InstanceCrashes) =>
      set((st) => ({ crashes: { ...st.crashes, [id]: fn(st.crashes[id] ?? emptyCrashes()) } }));

    const putAnalysis = (id: string, sourceId: string, a: CrashAnalysis) =>
      patchCrashes(id, (c) => ({ ...c, analyses: { ...c.analyses, [sourceId]: a } }));

    const clearAlert = (id: string) => {
      if (!get().crashAlerts[id]) return;
      set((st) => {
        const crashAlerts = { ...st.crashAlerts };
        delete crashAlerts[id];
        return { crashAlerts };
      });
    };

    /** analyzeCrash over a digest, mapped to jars when the instance has a scan. */
    const classify = (id: string, digest: LogDigest): CrashAnalysis => {
      const sc = get().scans[id];
      try {
        const input: CrashInput = { digest };
        if (sc?.result) {
          let index = indexes.get(sc.result);
          if (!index) {
            index = crashCore.buildJarIndex(sc.result);
            indexes.set(sc.result, index);
          }
          input.index = index;
        }
        if (sc?.pack) input.pack = sc.pack;
        const findings = crashCore.analyzeCrash(input);
        return { status: 'done', digest, findings, summary: summarizeCrash(findings), error: null, mapped: !!sc?.result };
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        return {
          status: 'error',
          digest,
          findings: [],
          summary: null,
          error: { kind: 'internal', message: `The crash analysis stopped with an error: ${message}`, path: null },
          mapped: false,
        };
      }
    };

    /** Read + analyse one source; resolves with the analysis (null when superseded). */
    const analyze = async (id: string, sourceId: string, force: boolean): Promise<CrashAnalysis | null> => {
      const cur = get().crashes[id]?.analyses[sourceId];
      if (!force && cur && cur.status !== 'error') return cur.status === 'done' ? cur : null;
      const key = `${id}/${sourceId}`;
      const token = bump(digestTokens, key);
      putAnalysis(id, sourceId, { status: 'loading', digest: null, findings: [], summary: null, error: null, mapped: false });
      const r = await call(cmd.readLogDigest(id, sourceId, [...CRASH_ANCHOR_TEXTS], null));
      if (digestTokens.get(key) !== token) return null;
      const a: CrashAnalysis =
        r.status === 'ok' ? classify(id, r.data) : { status: 'error', digest: null, findings: [], summary: null, error: r.error, mapped: false };
      putAnalysis(id, sourceId, a);
      return a;
    };

    /** Re-run the analysis of every digest already read (after a scan or an override). */
    const reanalyze = (id: string) => {
      const c = get().crashes[id];
      if (!c) return;
      const analyses: Record<string, CrashAnalysis> = { ...c.analyses };
      let changed = false;
      for (const [sourceId, a] of Object.entries(c.analyses)) {
        if (a.status !== 'done' || !a.digest) continue;
        analyses[sourceId] = classify(id, a.digest);
        changed = true;
      }
      if (changed) patchCrashes(id, (cc) => ({ ...cc, analyses }));
      if (get().selection?.kind === 'crash') keepSelection(id);
    };

    const rearm = async (ids: readonly string[]) => {
      if (rearmed) return;
      rearmed = true;
      const anchors = watchAnchors();
      await Promise.all(
        ids.map(async (id) => {
          const r = await call(cmd.setWatch(id, true, anchors));
          if (r.status === 'error') set((st) => ({ watchErrors: { ...st.watchErrors, [id]: r.error } }));
        }),
      );
    };

    const onCrash = async (e: CrashDetected) => {
      const key = `${e.instanceId}#${e.episode}`;
      if (episodes.has(key)) return;
      episodes.add(key);
      const id = e.instanceId;
      patchCrashes(id, (c) => {
        const analyses = { ...c.analyses };
        delete analyses[e.source.id];
        return { ...c, sources: upsertSource(c.sources, e.source), analyses };
      });
      const a = await analyze(id, e.source.id, true);
      const summary = a?.summary;
      // A normal quit never reaches here (Rust), and a crash without an error-severity finding
      // is listed but never announced.
      if (!summary) return;
      const alert: CrashAlert = { instanceId: id, episode: e.episode, sourceId: e.source.id, summary };
      patchCrashes(id, (c) => ({ ...c, selectedSourceId: e.source.id, pane: 'diagnosis', logLine: null }));
      set((st) => ({ findingsTab: { ...st.findingsTab, [id]: 'crashes' }, crashAlerts: { ...st.crashAlerts, [id]: alert } }));
      const sent = await notifier.notify(CRASH_NOTIFICATION_TITLE, summary.likelyCause ?? summary.headline);
      if (sent === 'denied') set({ crashBanner: alert });
    };

    /** Start the one rescan queued while `id` was scanning, if any. */
    const runQueued = (id: string) => {
      if (!queued.delete(id)) return;
      set((st) => {
        const rescanQueued = { ...st.rescanQueued };
        delete rescanQueued[id];
        return { rescanQueued };
      });
      void get().scan(id);
    };

    const applyInitialSelect = (id: string) => {
      const want = initialSelect;
      const sc = get().scans[id];
      if (!want || !sc) return;
      if (sc.findings.some((f) => f.id === want)) {
        initialSelect = null;
        set({ selection: { kind: 'finding', id: want }, expandFindingId: want, inspectorOpen: true });
      } else if (sc.result?.jars.some((j) => j.id === want)) {
        initialSelect = null;
        set({ selection: { kind: 'jar', id: want }, revealJarId: topLevelId(want), inspectorOpen: true });
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
        ev.crashDetected.listen((e) => void onCrash(e)),
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
        // Rust never starts watchers by itself (CONTRACTS invariant 11): re-arm, once.
        void rearm(settings.data.watched);
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
      fixErrorFrom: {},
      rescanQueued: {},
      backendKind: backend.kind,
      inspectorOpen: false,
      fixPending: {},
      overrideError: null,
      order: null,
      inspectorWidth: INSPECTOR_DEFAULT,
      crashes: {},
      findingsTab: {},
      crashAlerts: {},
      crashBanner: null,
      watchPending: {},
      watchErrors: {},

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
        // Opening an instance with an announced crash shows that crash.
        const alert = get().crashAlerts[id];
        if (alert) {
          patchCrashes(id, (c) => ({ ...c, selectedSourceId: alert.sourceId, pane: 'diagnosis' }));
          set((st) => ({ findingsTab: { ...st.findingsTab, [id]: 'crashes' } }));
          clearAlert(id);
          if (get().crashBanner?.instanceId === id) set({ crashBanner: null });
        }
        const cs = get().crashes[id]?.sourcesStatus;
        if (!cs || cs === 'idle') void get().loadLogSources(id);
      },

      async scan(id) {
        if (get().scans[id]?.status === 'scanning') {
          // Something changed mid-scan (a fix, a Rescan click): run once more when this ends.
          queued.add(id);
          set((st) => ({ rescanQueued: { ...st.rescanQueued, [id]: true } }));
          return;
        }
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
          runQueued(id);
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
        reanalyze(id);
        keepSelection(id);
        applyInitialSelect(id);
        runQueued(id);
      },

      select(sel) {
        // Selecting something opens the inspector drawer on narrow windows (ignored when docked).
        set(sel ? { selection: sel, inspectorOpen: true } : { selection: null });
      },

      revealJar(jarId) {
        set({ selection: { kind: 'jar', id: jarId }, revealJarId: topLevelId(jarId), inspectorOpen: true });
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
          reanalyze(instanceId);
          keepSelection(instanceId);
        }
      },

      async fix(key, action, from = key.startsWith('jar:') ? 'mods' : 'triage') {
        const id = get().selectedInstanceId;
        // Manual fixes are advice only: their steps are already on screen, nothing to plan.
        if (!id || action.kind === 'manual') return;
        const identity = packIdentity(get().scans[id]?.pack ?? null);
        const setErr = (e: AppError | null) =>
          set((st) => {
            const fixErrors = { ...st.fixErrors };
            const fixErrorFrom = { ...st.fixErrorFrom };
            if (e) {
              fixErrors[key] = e;
              fixErrorFrom[key] = from;
            } else {
              delete fixErrors[key];
              delete fixErrorFrom[key];
            }
            const fixPending = { ...st.fixPending };
            delete fixPending[key];
            return { fixErrors, fixErrorFrom, fixPending };
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
          const fixErrorFrom = { ...st.fixErrorFrom };
          delete fixErrors[key];
          delete fixErrorFrom[key];
          return { fixErrors, fixErrorFrom };
        });
      },

      setInspectorOpen(open) {
        set({ inspectorOpen: open });
      },

      async loadLogSources(id) {
        const token = bump(sourceTokens, id);
        patchCrashes(id, (c) => ({ ...c, sourcesStatus: 'loading', sourcesError: null }));
        const r = await call(cmd.listLogSources(id));
        if (sourceTokens.get(id) !== token) return;
        if (r.status === 'error') {
          patchCrashes(id, (c) => ({ ...c, sourcesStatus: 'error', sourcesError: r.error }));
          return;
        }
        const sources = sortSources(r.data);
        let selected: string | null = null;
        patchCrashes(id, (c) => {
          // A rewritten file (latest.log grows, a report is replaced) is read again.
          const analyses: Record<string, CrashAnalysis> = {};
          for (const s of sources) {
            const before = c.sources.find((p) => p.id === s.id);
            const a = c.analyses[s.id];
            if (a && before && before.modifiedMs === s.modifiedMs && before.size === s.size) analyses[s.id] = a;
          }
          selected = c.selectedSourceId && sources.some((s) => s.id === c.selectedSourceId) ? c.selectedSourceId : defaultSourceId(sources);
          return { ...c, sources, sourcesStatus: 'done', sourcesError: null, selectedSourceId: selected, analyses };
        });
        if (selected) await analyze(id, selected, false);
      },

      selectLogSource(id, sourceId) {
        patchCrashes(id, (c) => ({ ...c, selectedSourceId: sourceId, logLine: null }));
        clearAlert(id);
        void analyze(id, sourceId, false);
      },

      async analyzeLogSource(id, sourceId, force = false) {
        await analyze(id, sourceId, force);
      },

      setFindingsTab(id, tab) {
        set((st) => ({ findingsTab: { ...st.findingsTab, [id]: tab } }));
        if (tab !== 'crashes') return;
        clearAlert(id);
        const cs = get().crashes[id]?.sourcesStatus;
        if (!cs || cs === 'idle') void get().loadLogSources(id);
      },

      setCrashPane(id, pane, line = null) {
        patchCrashes(id, (c) => ({ ...c, pane, logLine: line }));
      },

      selectCrash(id, sourceId, findingId) {
        patchCrashes(id, (c) => ({ ...c, selectedSourceId: sourceId }));
        set((st) => ({
          findingsTab: { ...st.findingsTab, [id]: 'crashes' },
          selection: findingId ? { kind: 'crash', id: findingId, sourceId } : st.selection,
          inspectorOpen: findingId ? true : st.inspectorOpen,
        }));
        clearAlert(id);
        void analyze(id, sourceId, false);
      },

      async setWatch(id, enabled) {
        if (get().watchPending[id]) return;
        set((st) => ({ watchPending: { ...st.watchPending, [id]: true } }));
        const r = await call(cmd.setWatch(id, enabled, watchAnchors()));
        set((st) => {
          const watchPending = { ...st.watchPending };
          delete watchPending[id];
          const watchErrors = { ...st.watchErrors };
          if (r.status === 'error') {
            watchErrors[id] = r.error;
            return { watchPending, watchErrors };
          }
          delete watchErrors[id];
          const rest = st.settings.watched.filter((w) => w !== id);
          return { watchPending, watchErrors, settings: { ...st.settings, watched: enabled ? [...rest, id] : rest } };
        });
      },

      openCrashAlert(alert) {
        set({ crashBanner: null });
        get().selectInstance(alert.instanceId);
        const top = get().crashes[alert.instanceId]?.analyses[alert.sourceId]?.findings[0]?.id ?? '';
        get().selectCrash(alert.instanceId, alert.sourceId, top);
      },

      dismissCrashBanner() {
        set({ crashBanner: null });
      },
    };
  });
  return store;
}
