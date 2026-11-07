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
 * persists `Settings.watched`. After every successful discovery load the UI re-arms each watched
 * id that is in the instance list and not armed yet (or whose arm failed); absent ids are left
 * alone and re-armed when they come back. A `CrashDetected` episode (duplicates dropped) is read
 * and analysed; only an error-severity crash finding (`summarizeCrash` non-null) raises a native
 * notification (`<instance> crashed`, the likely cause) and selects the crash, plus a rail alert
 * unless the user is already looking at that instance. When notifications are not allowed, an
 * in-app banner shows instead. Every read of a source resolves with the newest analysis of that
 * source, so an episode is announced even when a Refresh or Retry re-reads its file meanwhile.
 *
 * Modrinth (M5): after every successful scan (and on a settings change, an override, or a manual
 * Refresh) `enrich` runs the flow documented in `src/core/modrinth/index.ts`: planQueries →
 * modrinth_identify → modrinth_find_updates (+ the beta-only fallback) → modrinth_projects →
 * buildModrinthContext → the checks again with the context → missingModIds →
 * modrinth_resolve_mod_id + modrinth_project_versions + chooseVersion → enrichFindings (static
 * and crash findings), with modrinth_icons as a separate second pass (icons never hold results
 * back and never re-run the checks). The static findings are on screen before it starts and stay
 * there: each step may fail on its own and only degrades (unknown states, a summary-strip
 * notice; only network conditions say "unreachable"). Results are token-guarded per instance;
 * a same-key rescan mid-lookup hands its result to the running lookup, so no lookup is ever left
 * "loading". The outcome is cached per instance under its query key, so switching instances
 * never re-queries, even when it was degraded; a clean one also answers a same-jar rescan.
 * Refresh (allowed while loading), settings changes, overrides, rescans of a degraded lookup and
 * the one automatic rate-limit retry (after `retryAfterS`) look up again. Modrinth settings
 * writes are serialised and lookups wait for them, so no lookup runs against a Rust
 * `modrinthEnabled` the UI no longer intends.
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
  HashLookup,
  Instance,
  Launcher,
  LogDigest,
  LogSource,
  OpStatus,
  PackOverride,
  ProjectLookup,
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
import type { CheckInput, CrashInput, Finding, JarIndex, ModrinthContext, PackContext } from '../../core/model';
// A namespace import: the module's functions are looked up when called, so a missing one fails
// that step (and degrades) instead of failing the whole module graph.
import * as coreModrinth from '../../core/modrinth';
import type { DependencyResolution, ModrinthQueries } from '../../core/modrinth';
import { buildJarIndex as coreBuildJarIndex, resolvePack as coreResolvePack } from '../../core/pack';
import type { ModSortKey } from '../components/ModTable';
import { clampSize, INSPECTOR_DEFAULT, INSPECTOR_MAX, INSPECTOR_MIN } from '../components/resize';
import type { SortState } from '../components/sort';
import { packIdentity, topLevelId } from './derive';
import {
  crashNotification,
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
import {
  emptyModrinth,
  isNetworkError,
  queryKey,
  type InstanceModrinth,
  type ModrinthCoreApi,
  type ModrinthNotice,
} from './modrinthState';
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

/** Why a Modrinth lookup was asked for; decides whether a degraded cached answer is reused. */
type MrReason = 'scan' | 'select' | 'settings' | 'override' | 'refresh' | 'retry';

/** One Modrinth lookup in flight (see `mrInflight`). */
interface MrRun {
  token: number;
  key: string;
  /** The intended `Settings.modrinthEnabled` the run was started for. */
  enabled: boolean;
  epoch: number;
  /** The scan result the context will answer; a same-key rescan replaces it. */
  result: ScanResult;
  promise: Promise<void>;
}

/** Rules-core crash entry points (injectable for tests). */
export interface CrashCoreApi {
  analyzeCrash: (input: CrashInput) => Finding[];
  buildJarIndex: (scan: ScanResult) => JarIndex;
}

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
  /** Rules-core Modrinth enrichment (`src/core/modrinth`); injectable for tests. */
  modrinthCore?: ModrinthCoreApi;
  /** Runs `cb` after `ms` (the rate-limit retry); defaults to `setTimeout`. */
  setTimer?: (cb: () => void, ms: number) => void;
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
  /** Modrinth enrichment per instance (M5). */
  modrinth: Readonly<Record<string, InstanceModrinth>>;

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
  /** Look the instance's jars up again, bypassing Rust's disk cache ("Refresh Modrinth"). */
  refreshModrinth(id: string): Promise<void>;
  setModrinthEnabled(on: boolean): Promise<void>;
  setIncludeBeta(on: boolean): Promise<void>;
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
  const mr: ModrinthCoreApi = deps.modrinthCore ?? coreModrinth;
  const setTimer = deps.setTimer ?? ((cb: () => void, ms: number) => void setTimeout(cb, ms));
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
  /**
   * The newest read of each `instanceId/sourceId`. A superseded read resolves with the one that
   * replaced it, so whoever waits on a source (a `CrashDetected` episode) gets its analysis.
   */
  const latestRead = new Map<string, Promise<CrashAnalysis | null>>();
  /** `instanceId#episode` of every `CrashDetected` handled (duplicates are dropped). */
  const episodes = new Set<string>();
  /** Instances whose watcher this run armed successfully (re-arm skips them). */
  const armed = new Set<string>();
  const indexes = new WeakMap<ScanResult, JarIndex>();
  /** Latest Modrinth lookup per instance; older lookups' results are dropped. */
  const mrTokens = new Map<string, number>();
  /**
   * The lookup in flight per instance. A repeat request with the same query key, intended
   * `modrinthEnabled` and settings epoch joins it, and adopts a newer scan result with the same
   * jars (a rescan mid-lookup), so the run that finishes is always the one the screen waits on.
   */
  const mrInflight = new Map<string, MrRun>();
  /**
   * Modrinth settings writes are serialised: each waits for the previous one, so Rust ends in the
   * state of the last click. Lookups wait until none is pending, so a lookup never runs against a
   * Rust `modrinthEnabled` that disagrees with the UI's intent.
   */
  let mrWrites: Promise<void> = Promise.resolve();
  let mrWritesPending = 0;
  /** Sequence number of the latest Modrinth settings write (only its answer is applied). */
  let mrWriteSeq = 0;
  /**
   * Bumped whenever the intended `modrinthEnabled` changes (a toggle, or a failed write
   * reverting it). A lookup started under an older epoch is never joined and restarts itself.
   */
  let mrEpoch = 0;
  /** The Modrinth settings Rust last confirmed (a failed latest write reverts the UI to them). */
  let mrConfirmed: { modrinthEnabled: boolean; includeBeta: boolean } | null = null;
  /** Missing mod ids already looked up for the instance's current context. */
  const mrAttempted = new Map<string, Set<string>>();
  /** Instances whose one automatic rate-limit retry is used up. */
  const mrRetried = new Set<string>();
  const bump =(m: Map<string, number>, key: string) => {
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

    const patchMr = (id: string, fn: (m: InstanceModrinth) => InstanceModrinth) =>
      set((st) => ({ modrinth: { ...st.modrinth, [id]: fn(st.modrinth[id] ?? emptyModrinth()) } }));

    /**
     * The instance's Modrinth state when its context answers `result` under `pack` and the
     * current settings (same query key), else null: the checks then run without Modrinth.
     */
    const usableModrinth = (id: string, result: ScanResult, pack: PackContext): (InstanceModrinth & { ctx: ModrinthContext }) | null => {
      const m = get().modrinth[id];
      const { modrinthEnabled, includeBeta } = get().settings;
      if (!m?.ctx || m.key === null || !modrinthEnabled) return null;
      try {
        const q = mr.planQueries(result, pack);
        return queryKey(q.identify, q.updates, includeBeta) === m.key ? { ...m, ctx: m.ctx } : null;
      } catch {
        return null;
      }
    };

    /** resolvePack → runChecks (with the Modrinth context when it applies) → enrichFindings. */
    const check = (id: string): Partial<InstanceScan> => {
      const sc = get().scans[id];
      const inst = instanceById(id);
      if (!sc?.result || !inst) return {};
      try {
        const override = get().settings.overrides[id] ?? null;
        const pack = core.resolvePack(inst, sc.result, override);
        // What the pack would be without the override: the override editor's placeholders.
        const detected = override ? core.resolvePack(inst, sc.result, null) : pack;
        const m = usableModrinth(id, sc.result, pack);
        let findings: Finding[] | null = null;
        if (m) {
          try {
            findings = mr.enrichFindings(core.runChecks({ instance: inst, scan: sc.result, pack, modrinth: m.ctx }), m.ctx, m.resolutions, sc.result.jars);
          } catch {
            // A Modrinth-side failure must not cost the static findings.
            findings = null;
          }
        }
        findings ??= core.runChecks({ instance: inst, scan: sc.result, pack });
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
        let findings = crashCore.analyzeCrash(input);
        // Modrinth fixes (replace / installDependency) for crash findings too.
        const m = sc?.result && sc.pack ? usableModrinth(id, sc.result, sc.pack) : null;
        if (m) {
          try {
            findings = mr.enrichFindings(findings, m.ctx, m.resolutions, sc?.result?.jars ?? []);
          } catch {
            // Keep the plain analysis.
          }
        }
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

    /**
     * Read + analyse one source. Resolves with the analysis that ends up stored for it: a read
     * that another read of the same source superseded (Refresh, Retry, a forced re-read) resolves
     * with that newer read's result rather than null, and a non-forced call while a read is in
     * flight shares it. Null only when the source has no analysis to give.
     */
    const analyze = (id: string, sourceId: string, force: boolean): Promise<CrashAnalysis | null> => {
      const key = `${id}/${sourceId}`;
      const cur = get().crashes[id]?.analyses[sourceId];
      if (!force && cur?.status === 'done') return Promise.resolve(cur);
      if (!force && cur?.status === 'loading') return latestRead.get(key) ?? Promise.resolve(null);
      const token = bump(digestTokens, key);
      putAnalysis(id, sourceId, { status: 'loading', digest: null, findings: [], summary: null, error: null, mapped: false });
      const read = (async (): Promise<CrashAnalysis | null> => {
        const r = await call(cmd.readLogDigest(id, sourceId, [...CRASH_ANCHOR_TEXTS], null));
        // Superseded: follow the newer read (set synchronously when it started).
        if (digestTokens.get(key) !== token) return (await latestRead.get(key)) ?? null;
        const a: CrashAnalysis =
          r.status === 'ok' ? classify(id, r.data) : { status: 'error', digest: null, findings: [], summary: null, error: r.error, mapped: false };
        putAnalysis(id, sourceId, a);
        // A crash may name missing mods the static checks did not (C-MISSING-MANDATORY).
        if (a.status === 'done') void resolveMissing(id);
        return a;
      })();
      latestRead.set(key, read);
      return read;
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

    /** Re-run the checks and crash analyses of a scanned instance (its Modrinth state changed). */
    const recheck = (id: string) => {
      if (!get().scans[id]?.result) return;
      const checked = check(id);
      patchScan(id, (s) => ({ ...s, ...checked }));
      reanalyze(id);
      keepSelection(id);
    };

    const internalError = (step: string, e: unknown): AppError => ({
      kind: 'internal',
      message: `The Modrinth ${step} stopped with an error: ${e instanceof Error ? e.message : String(e)}`,
      path: null,
    });

    /** One automatic retry per rate limit; a second one leaves the notice without a countdown. */
    const scheduleRetry = (id: string, token: number, error: AppError) => {
      if (mrRetried.has(id)) {
        patchMr(id, (m) => ({ ...m, notice: { kind: 'rateLimited', retryAt: null }, error }));
        return;
      }
      mrRetried.add(id);
      const ms = Math.max(1, error.retryAfterS ?? 30) * 1000;
      patchMr(id, (m) => ({ ...m, notice: { kind: 'rateLimited', retryAt: now() + ms }, error }));
      setTimer(() => {
        if (mrTokens.get(id) === token) void enrich(id, { reason: 'retry' });
      }, ms);
    };

    /** Every crash finding analysed so far for the instance. */
    const crashFindingsOf = (id: string): Finding[] =>
      Object.values(get().crashes[id]?.analyses ?? {}).flatMap((a) => (a.status === 'done' ? a.findings : []));

    /**
     * Step 5: resolve the missing mod ids of the static and crash findings (each id once per
     * context) to Modrinth versions, then re-run the checks so `enrichFindings` adds
     * `installDependency`. Each id fails on its own.
     */
    const resolveMissing = async (id: string): Promise<void> => {
      const m = get().modrinth[id];
      const sc = get().scans[id];
      if (!m || m.status !== 'done' || !m.ctx || m.ctx.offline || !m.filters || !sc || m.notice?.kind === 'rateLimited') return;
      const token = mrTokens.get(id) ?? 0;
      const key = m.key;
      let attempted = mrAttempted.get(id);
      if (!attempted) mrAttempted.set(id, (attempted = new Set()));
      let ids: string[];
      try {
        ids = mr.missingModIds([...sc.findings, ...crashFindingsOf(id)]).filter((x) => !attempted.has(x));
      } catch {
        return;
      }
      if (!ids.length) return;
      for (const x of ids) attempted.add(x);
      const { loaders, gameVersions } = m.filters;
      const includeBeta = get().settings.includeBeta;
      let limited: AppError | null = null;
      let degraded: AppError | null = null;
      const unresolved: Record<string, AppError> = {};
      // Rate limit → the one automatic retry; network → the quiet "some lookups failed" notice;
      // anything else (`invalid`, `internal`…) skips just this dependency, noted on its finding.
      const fail = (modId: string, e: AppError) => {
        if (e.kind === 'rateLimited') limited ??= e;
        else if (isNetworkError(e)) degraded ??= e;
        else unresolved[modId] = e;
      };
      const one = async (modId: string): Promise<DependencyResolution | null> => {
        const p = await call(cmd.modrinthResolveModId(modId, loaders, gameVersions));
        if (p.status === 'error') {
          fail(modId, p.error);
          return null;
        }
        if (!p.data) return null;
        const project = p.data;
        const v = await call(cmd.modrinthProjectVersions(project.id, loaders, gameVersions, mr.updateVersionTypes(true)));
        if (v.status === 'error') {
          fail(modId, v.error);
          return null;
        }
        try {
          const version = mr.chooseVersion(v.data, includeBeta);
          return version ? { modId, project, version, beta: version.versionType !== 'release' } : null;
        } catch {
          return null;
        }
      };
      const found = (await Promise.all(ids.map(one))).filter((r): r is DependencyResolution => r !== null);
      if (mrTokens.get(id) !== token || get().modrinth[id]?.key !== key) return;
      const failed: AppError | null = degraded;
      const skipped = Object.keys(unresolved).length > 0;
      if (found.length || failed || skipped) {
        patchMr(id, (cur) => ({
          ...cur,
          resolutions: { ...cur.resolutions, ...Object.fromEntries(found.map((r) => [r.modId, r])) },
          unresolved: skipped ? { ...cur.unresolved, ...unresolved } : cur.unresolved,
          notice: failed && !cur.notice ? { kind: 'partial' } : cur.notice,
          error: cur.error ?? failed,
        }));
      }
      if (found.length) recheck(id);
      if (limited) scheduleRetry(id, token, limited);
    };

    /** Step 7: icons, a second pass after the context is on screen (never re-runs the checks). */
    const loadIcons = async (id: string, token: number, projectIds: readonly string[]): Promise<void> => {
      if (!projectIds.length) return;
      const r = await call(() => cmd.modrinthIcons([...projectIds]));
      if (mrTokens.get(id) !== token || r.status === 'error') return;
      const found = Object.entries(r.data ?? {}).filter(([, p]) => typeof p === 'string' && p.length > 0);
      if (!found.length) return;
      patchMr(id, (m) => ({ ...m, icons: { ...m.icons, ...Object.fromEntries(found) } }));
    };

    /**
     * The Modrinth flow for one scanned instance (see the module docs). `reason` says who asks:
     * `refresh` bypasses Rust's disk cache and this store's cache; `retry` is the automatic
     * rate-limit retry. `enabled` is the intended `Settings.modrinthEnabled` (default: the UI's).
     *
     * Every call ends in a terminal state (`done`, `error`, `off`) or hands over to a newer run:
     * - Off: any run is cancelled, status `off`.
     * - A finished lookup with the same query key answers again without a request when it was
     *   clean, or when it was degraded and the instance is only being opened (`select`):
     *   switching instances never re-queries. Refresh, a settings change, an override, a rescan
     *   and the rate-limit timer look a degraded one up again.
     * - A run in flight with the same key, intent and settings epoch is joined, and adopts the
     *   newer scan result (a rescan with unchanged jars mid-lookup). Refresh always starts anew.
     * - A new run supersedes the previous one (token). It first waits for pending Modrinth
     *   settings writes; if the intent changed meanwhile (epoch) it restarts under the new one.
     */
    const enrich = (id: string, opts: { reason?: MrReason; enabled?: boolean } = {}): Promise<void> => {
      const reason = opts.reason ?? 'scan';
      const sc = get().scans[id];
      if (!sc || sc.status !== 'done' || !sc.result || !sc.pack) return Promise.resolve();
      const result = sc.result;
      const pack = sc.pack;
      const enabled = opts.enabled ?? get().settings.modrinthEnabled;
      const { includeBeta } = get().settings;
      const prev = get().modrinth[id] ?? emptyModrinth();

      if (!enabled) {
        bump(mrTokens, id);
        mrInflight.delete(id);
        if (prev.status !== 'off') patchMr(id, () => ({ ...emptyModrinth(), status: 'off' }));
        if (prev.ctx) recheck(id);
        return Promise.resolve();
      }

      let q: ModrinthQueries;
      try {
        q = mr.planQueries(result, pack);
      } catch (e) {
        bump(mrTokens, id);
        mrInflight.delete(id);
        patchMr(id, () => ({ ...emptyModrinth(), status: 'error', notice: { kind: 'failed' }, error: internalError('lookup', e) }));
        if (prev.ctx) recheck(id);
        return Promise.resolve();
      }
      const key = queryKey(q.identify, q.updates, includeBeta);
      if (reason !== 'refresh' && reason !== 'retry') {
        const running = mrInflight.get(id);
        if (running && running.key === key && running.enabled === enabled && running.epoch === mrEpoch && mrTokens.get(id) === running.token) {
          running.result = result;
          return running.promise;
        }
        const finished = !running && (prev.status === 'done' || prev.status === 'error') && prev.lookupKey === key;
        const degraded = prev.status === 'error' || prev.notice !== null;
        if (finished && (!degraded || reason === 'select')) {
          if (prev.status === 'done' && prev.scanRef !== result) patchMr(id, (m) => ({ ...m, scanRef: result }));
          return Promise.resolve();
        }
      }
      if (reason !== 'retry') mrRetried.delete(id);
      const token = bump(mrTokens, id);
      mrAttempted.set(id, new Set());
      patchMr(id, (m) => ({ ...m, status: 'loading', key: null, scanRef: null }));
      const run: MrRun = { token, key, enabled, epoch: mrEpoch, result, promise: Promise.resolve() };
      mrInflight.set(id, run);
      run.promise = lookup(id, run, q, includeBeta, reason);
      return run.promise;
    };

    /** One lookup run (`enrich` decides when one starts). */
    const lookup = async (id: string, run: MrRun, q: ModrinthQueries, includeBeta: boolean, reason: MrReason): Promise<void> => {
      const { token } = run;
      const refresh = reason === 'refresh';
      const finish = () => {
        if (mrInflight.get(id) === run) mrInflight.delete(id);
      };
      /**
       * After every await: null to go on; else the promise to return. A newer run owns the
       * instance (stale: it will reach a terminal state), or the intended `modrinthEnabled`
       * changed (restart under it; when no run can start, leave `idle`, never `loading`).
       */
      const halt = (): Promise<void> | null => {
        if (mrTokens.get(id) !== token) return Promise.resolve();
        if (run.epoch === mrEpoch) return null;
        finish();
        return (async () => {
          // Restart once Rust has the new intent; the write's own handler may restart us first.
          while (mrWritesPending > 0) await mrWrites;
          if (mrTokens.get(id) !== token) return;
          await enrich(id, { reason });
          if (mrTokens.get(id) === token) {
            bump(mrTokens, id);
            patchMr(id, (m) => (m.status === 'loading' ? { ...emptyModrinth(), icons: m.icons } : m));
          }
        })();
      };
      const fail = (notice: ModrinthNotice | null, error: AppError) => {
        finish();
        const hadCtx = !!get().modrinth[id]?.ctx;
        // Unknown, never "missing": no context at all, the checks run static only.
        patchMr(id, (m) => ({ ...emptyModrinth(), icons: m.icons, status: 'error', notice, error, lookupKey: run.key }));
        if (hadCtx) recheck(id);
      };

      // Rust must be in the state the UI intends before anything is sent.
      while (mrWritesPending > 0) await mrWrites;
      const h0 = halt();
      if (h0) return h0;

      let partial = false;
      let firstError: AppError | null = null;
      let limited: AppError | null = null;
      const noteLookup = (l: { failed: string[]; offline: boolean }) => {
        if (l.offline || l.failed.length) partial = true;
      };
      const noteError = (e: AppError) => {
        if (e.kind === 'rateLimited') limited ??= e;
        else partial = true;
        firstError ??= e;
      };

      // 1. Identify every top-level jar by hash.
      let identify: HashLookup = { found: {}, failed: [], offline: false };
      if (q.identify.length) {
        const r = await call(cmd.modrinthIdentify(q.identify, refresh));
        const h = halt();
        if (h) return h;
        if (r.status === 'error') {
          // Only a network condition is "unreachable"; any other error is a failed lookup.
          fail(r.error.kind === 'rateLimited' ? null : isNetworkError(r.error) ? { kind: 'offline' } : { kind: 'failed' }, r.error);
          if (r.error.kind === 'rateLimited') scheduleRetry(id, token, r.error);
          return;
        }
        identify = r.data;
        noteLookup(identify);
      }
      // Unreachable: served offline, or every batch failed (Rust reports network failures so).
      const failedIds = new Set(identify.failed.map((h) => h.toLowerCase()));
      const unreachable = identify.offline || (q.identify.length > 0 && q.identify.every((h) => failedIds.has(h.toLowerCase())));

      // 2. Updates for the identified jars (only with known filters), then the beta-only fallback.
      const hashes = Object.keys(identify.found).sort();
      let updates: HashLookup | null = null;
      let betaFallback: HashLookup | null = null;
      if (q.updates && hashes.length && !unreachable) {
        const { loaders, gameVersions } = q.updates;
        const r = await call(cmd.modrinthFindUpdates(hashes, loaders, gameVersions, mr.updateVersionTypes(includeBeta), refresh));
        const h = halt();
        if (h) return h;
        if (r.status === 'error') noteError(r.error);
        else {
          updates = r.data;
          noteLookup(updates);
          // No compatible release, or only one older than the jar (the user runs a newer
          // pre-release): ask again with betas (CONTRACTS invariant 8).
          let noRelease: string[] = [];
          try {
            noRelease = mr.betaFallbackHashes(identify, updates, includeBeta);
          } catch (e) {
            firstError ??= internalError('lookup', e);
          }
          if (noRelease.length) {
            const b = await call(cmd.modrinthFindUpdates(noRelease, loaders, gameVersions, mr.updateVersionTypes(true), refresh));
            const hb = halt();
            if (hb) return hb;
            if (b.status === 'error') {
              noteError(b.error);
              // Those jars are unknown, never "no compatible version" / "up to date": the
              // fallback answered nothing for them, so report every one of them as failed.
              betaFallback = { found: {}, failed: [...noRelease], offline: false };
            } else {
              betaFallback = b.data;
              noteLookup(betaFallback);
            }
          }
        }
      }

      // 3. Projects: titles and sides (icons come in a second pass, step 7).
      let projects: ProjectLookup | null = null;
      let projectIds: string[] = [];
      try {
        projectIds = mr.projectIdsOf(identify);
      } catch (e) {
        firstError ??= internalError('lookup', e);
      }
      if (projectIds.length && !limited) {
        const r = await call(cmd.modrinthProjects(projectIds, refresh));
        const h = halt();
        if (h) return h;
        if (r.status === 'error') noteError(r.error);
        else {
          projects = r.data;
          noteLookup(projects);
        }
      }

      // 4. The context, and the checks again with it.
      let ctx: ModrinthContext;
      try {
        ctx = mr.buildModrinthContext({ identify, updates, betaFallback, projects });
      } catch (e) {
        fail({ kind: 'failed' }, internalError('lookup', e));
        return;
      }
      finish();
      const notice: ModrinthNotice | null = limited ? null : unreachable ? { kind: 'offline' } : partial ? { kind: 'partial' } : null;
      patchMr(id, (m) => ({
        status: 'done',
        ctx,
        key: run.key,
        // A same-key rescan during the lookup handed its result over (`enrich`).
        scanRef: run.result,
        filters: q.updates,
        resolutions: {},
        unresolved: {},
        icons: m.icons,
        notice,
        error: firstError,
        lookupKey: run.key,
      }));
      recheck(id);
      if (limited) {
        scheduleRetry(id, token, limited);
        return;
      }

      // 5–6. Missing dependencies → installDependency fixes; 7. icons, alongside (never when
      // Modrinth was unreachable: no icon request then, CONTRACTS invariant 10).
      const icons = unreachable || !projects || projects.offline ? null : loadIcons(id, token, Object.keys(ctx.projects).sort());
      await Promise.all([resolveMissing(id), icons]);
    };

    /** Serialised `set_settings` for the Modrinth settings (see `mrWrites`). */
    const writeModrinthSettings = (patch: { modrinthEnabled?: boolean; includeBeta?: boolean }) => {
      mrWritesPending++;
      const p = mrWrites.then(() => call(() => cmd.setSettings(settingsPatch(patch))));
      mrWrites = p.then(
        () => {
          mrWritesPending--;
        },
        () => {
          mrWritesPending--;
        },
      );
      return p;
    };

    /**
     * Store `modrinthEnabled` / `includeBeta`, then re-run the lookup. The UI shows the intent at
     * once; writes are serialised and only the last click's answer is applied (a failed one
     * reverts to what Rust last confirmed). Lookups wait for the writes, so they never run
     * against a Rust state the UI no longer intends. The open instance re-queries; switching
     * Modrinth off applies to every scanned instance at once (no network); other instances pick
     * a change up when they are opened.
     */
    const updateModrinthSettings = async (patch: { modrinthEnabled?: boolean; includeBeta?: boolean }) => {
      const before = get().settings;
      if (mrWritesPending === 0) mrConfirmed = { modrinthEnabled: before.modrinthEnabled, includeBeta: before.includeBeta };
      if (patch.modrinthEnabled !== undefined && patch.modrinthEnabled !== before.modrinthEnabled) mrEpoch++;
      set({ settings: { ...before, ...patch } });
      const seq = ++mrWriteSeq;
      const r = await writeModrinthSettings(patch);
      if (r.status === 'ok') mrConfirmed = { modrinthEnabled: r.data.modrinthEnabled, includeBeta: r.data.includeBeta };
      // A newer click is on its way to Rust: only the last answer is applied.
      if (seq !== mrWriteSeq) return;
      const next = r.status === 'ok' ? r.data : (mrConfirmed ?? before);
      if (next.modrinthEnabled !== get().settings.modrinthEnabled) mrEpoch++;
      set((st) => ({
        settingsError: r.status === 'ok' ? null : r.error,
        settings: { ...st.settings, modrinthEnabled: next.modrinthEnabled, includeBeta: next.includeBeta },
      }));
      const sel = get().selectedInstanceId;
      const off = !get().settings.modrinthEnabled;
      await Promise.all(
        Object.keys(get().scans)
          .filter((id) => id === sel || off)
          .map((id) => enrich(id, { reason: 'settings' })),
      );
    };

    const setWatchPending = (ids: readonly string[], pending: boolean) =>
      set((st) => {
        const watchPending: Record<string, true> = { ...st.watchPending };
        for (const id of ids) {
          if (pending) watchPending[id] = true;
          else delete watchPending[id];
        }
        return { watchPending };
      });

    /**
     * Rust never starts watchers by itself (CONTRACTS invariant 11), and a rediscovery stops the
     * watcher of an instance that left the list. So after every successful discovery load: arm
     * each id in `Settings.watched` that is listed and not armed yet (or whose arm failed). Ids
     * that are not listed are never armed; they are forgotten as armed, so they re-arm when they
     * come back. Idempotent (`set_watch(true)` on a watched instance replaces its watcher).
     */
    const rearm = async () => {
      const instances = get().discovery?.instances ?? [];
      const present = new Set(instances.map((i) => i.id));
      for (const id of [...armed]) if (!present.has(id)) armed.delete(id);
      const ids = get().settings.watched.filter((id) => {
        const inst = instances.find((i) => i.id === id);
        return !!inst && inst.launcher !== 'mrpack' && !armed.has(id) && !get().watchPending[id];
      });
      if (!ids.length) return;
      // The toggle is disabled while its instance is being armed (no racing user toggle).
      setWatchPending(ids, true);
      const anchors = watchAnchors();
      await Promise.all(
        ids.map(async (id) => {
          const r = await call(cmd.setWatch(id, true, anchors));
          if (r.status === 'ok') armed.add(id);
          set((st) => {
            const watchErrors = { ...st.watchErrors };
            if (r.status === 'error') watchErrors[id] = r.error;
            else delete watchErrors[id];
            return { watchErrors };
          });
          setWatchPending([id], false);
        }),
      );
    };

    /** Episode sources being announced, per `instanceId/sourceId` (a stale listing keeps them). */
    const announcing = new Map<string, LogSource>();

    const onCrash = async (e: CrashDetected) => {
      const key = `${e.instanceId}#${e.episode}`;
      if (episodes.has(key)) return;
      episodes.add(key);
      const id = e.instanceId;
      const sourceKey = `${id}/${e.source.id}`;
      announcing.set(sourceKey, e.source);
      patchCrashes(id, (c) => {
        const analyses = { ...c.analyses };
        delete analyses[e.source.id];
        return { ...c, sources: upsertSource(c.sources, e.source), analyses };
      });
      let a: CrashAnalysis | null;
      try {
        // Resolves with whichever read of this source finishes last (a Refresh or a Retry may
        // re-read the file meanwhile), so the episode is never lost to a superseded read.
        a = await analyze(id, e.source.id, true);
      } finally {
        if (announcing.get(sourceKey) === e.source) announcing.delete(sourceKey);
      }
      const summary = a?.summary;
      // A normal quit never reaches here (Rust), and a crash without an error-severity finding
      // is listed but never announced.
      if (!a || !summary) return;
      const alert: CrashAlert = { instanceId: id, episode: e.episode, sourceId: e.source.id, summary };
      patchCrashes(id, (c) => ({
        ...c,
        // A listing that started before the crash file existed may have dropped it.
        sources: c.sources.some((s) => s.id === e.source.id) ? c.sources : upsertSource(c.sources, e.source),
        selectedSourceId: e.source.id,
        pane: 'diagnosis',
        logLine: null,
      }));
      set((st) => ({ findingsTab: { ...st.findingsTab, [id]: 'crashes' } }));
      // The rail mark and tab pip mean "not looked at yet". When this instance is open, its
      // crashes tab now shows this very source: nothing is unseen.
      if (get().selectedInstanceId === id) clearAlert(id);
      else set((st) => ({ crashAlerts: { ...st.crashAlerts, [id]: alert } }));
      const n = crashNotification(instanceById(id)?.name, summary, a.findings, e.source.id);
      const sent = await notifier.notify(n.title, n.body);
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
          void rearm();
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
      } else set({ settingsError: settings.error });
      if (discovery.status === 'ok') {
        set({ discovery: discovery.data });
        void rearm();
      } else set({ discoveryError: discovery.error, discovery: { instances: [], probes: [] } });
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
      modrinth: {},

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
        // A settings change since its last lookup applies now; otherwise the cache answers.
        else if (sc.status === 'done') void enrich(id, { reason: 'select' });
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
        // The static findings are on screen; Modrinth enrichment follows and never blocks them.
        void enrich(id, { reason: 'scan' });
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
        // The Modrinth settings are owned by their own serialised writes (the UI's intent).
        set((st) => ({ settings: { ...r.data, modrinthEnabled: st.settings.modrinthEnabled, includeBeta: st.settings.includeBeta }, overrideError: null }));
        if (get().scans[instanceId]?.result) {
          const checked = check(instanceId);
          patchScan(instanceId, (s) => ({ ...s, ...checked, finishedAt: s.status === 'done' ? now() : s.finishedAt }));
          reanalyze(instanceId);
          keepSelection(instanceId);
          // A new MC version or loader changes the update filters.
          void enrich(instanceId, { reason: 'override' });
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
        void rearm();
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
        void rearm();
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
        let sources = sortSources(r.data);
        // A crash file announced while this listing was in flight stays listed.
        for (const [k, s] of announcing) {
          if (k.startsWith(`${id}/`) && !sources.some((x) => x.id === s.id)) sources = upsertSource(sources, s);
        }
        let selected: string | null = null;
        patchCrashes(id, (c) => {
          // A rewritten file (latest.log grows, a report is replaced) is read again. A read in
          // flight is kept: it is the newest read of that file (an episode may be waiting on it).
          const analyses: Record<string, CrashAnalysis> = {};
          for (const s of sources) {
            const before = c.sources.find((p) => p.id === s.id);
            const a = c.analyses[s.id];
            if (a && (a.status === 'loading' || (before && before.modifiedMs === s.modifiedMs && before.size === s.size))) analyses[s.id] = a;
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
        patchCrashes(id, (c) => ({ ...c, pane, logLine: line, logRequest: line === null ? c.logRequest : c.logRequest + 1 }));
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
        if (r.status === 'ok') {
          if (enabled) armed.add(id);
          else armed.delete(id);
        }
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

      async refreshModrinth(id) {
        await enrich(id, { reason: 'refresh' });
      },

      async setModrinthEnabled(on) {
        await updateModrinthSettings({ modrinthEnabled: on });
      },

      async setIncludeBeta(on) {
        await updateModrinthSettings({ includeBeta: on });
      },
    };
  });
  return store;
}
