/**
 * Per-instance Modrinth enrichment state (M5) and the pure view helpers built on it: the mod-table
 * column, icons, fix-button versions, the summary-strip notice and the inspector's side text.
 *
 * The store (store.ts) drives the flow documented at the top of `src/core/modrinth/index.ts`
 * after each scan and keeps one `InstanceModrinth` per instance. The context is used only while
 * it answers the current scan (`key` = the planned queries + `includeBeta`), so a stale context
 * never marks a new jar "not on Modrinth".
 */
import type { AppError, DeclaredFile, JarRecord, MrProject, MrVersion, ScanResult } from '../../bindings';
import type * as ModrinthCore from '../../core/modrinth';
import type { DependencyResolution, JarMatch, UpdateFilters } from '../../core/modrinth';
import { depRangeVersions, type DepRangeData } from '../../core/modrinth/depRangeFix';
import type { ModrinthContext } from '../../core/model';
import type { ModrinthMatch, ModRow } from '../components/ModTable';
import type { FixVersions } from '../components/labels';

/** The `src/core/modrinth` entry points the store calls (injectable for tests). */
export type ModrinthCoreApi = Pick<
  typeof ModrinthCore,
  | 'planQueries'
  | 'updateVersionTypes'
  | 'betaFallbackHashes'
  | 'projectIdsOf'
  | 'buildModrinthContext'
  | 'jarMatch'
  | 'chooseVersion'
  | 'missingModIds'
  | 'enrichFindings'
>;

export type ModrinthNotice =
  /**
   * Modrinth could not be reached at all: the identify call failed for a network reason
   * (`network` / `offline`), answered `offline`, or every one of its batches failed. Static
   * checks only (DESIGN.md §10). Only network conditions ever say "unreachable".
   */
  | { kind: 'offline' }
  /**
   * Modrinth answered, but part of the lookup did not: some hashes `failed`, or the update,
   * project or dependency step failed for a network reason, or the update / project step failed
   * outright. What is shown is right; some of it is unknown. Quieter than "unreachable".
   */
  | { kind: 'partial' }
  /** Identification stopped with a non-network error (`internal`, `invalid`…): no context. */
  | { kind: 'failed' }
  /** Modrinth answered `rateLimited`. `retryAt` (UI clock) while the one automatic retry waits. */
  | { kind: 'rateLimited'; retryAt: number | null };

/** Error kinds that mean "the network": the only ones that may say "Modrinth unreachable". */
export function isNetworkError(e: Pick<AppError, 'kind'>): boolean {
  return e.kind === 'network' || e.kind === 'offline';
}

export interface InstanceModrinth {
  /**
   * `off`: `Settings.modrinthEnabled` is false (no lookups). `error`: identification failed, no
   * context. `done`: a context exists (it may still be degraded, see `notice`).
   */
  status: 'idle' | 'loading' | 'done' | 'off' | 'error';
  ctx: ModrinthContext | null;
  /** The queries `ctx` answers; null while a new lookup runs. */
  key: string | null;
  /** The scan the context was last confirmed for (the mod table shows `ctx` only for it). */
  scanRef: ScanResult | null;
  /** Update filters of the lookup (dependency resolution reuses them). */
  filters: UpdateFilters | null;
  /** Missing mod id → chosen Modrinth version. */
  resolutions: Readonly<Record<string, DependencyResolution>>;
  /**
   * Modrinth answers for E-DEP-RANGE advice (`src/core/modrinth/depRangeFix.ts`): resolved mod ids
   * and version lists, for the current context. Absent = nothing fetched yet.
   */
  depRange?: DepRangeData;
  /**
   * Missing mod ids whose Modrinth lookup failed for a non-network reason (`invalid`,
   * `internal`…): that dependency is skipped and its finding says so; no global notice.
   */
  unresolved: Readonly<Record<string, AppError>>;
  /**
   * Project id → cached icon path from the `modrinth_icons` second pass. Rendering prefers it
   * over `MrProject.iconPath`; the checks never see it (icons never re-run them).
   */
  icons: Readonly<Record<string, string>>;
  notice: ModrinthNotice | null;
  /** The first step error, if any (kept for the tooltip of the notice). */
  error: AppError | null;
  /**
   * Query key of the last finished lookup (`done` or `error`), kept even when it failed or was
   * degraded. Opening the instance again answers from this state; only Refresh, a settings
   * change, an override, a rescan or the rate-limit timer look a degraded lookup up again.
   */
  lookupKey: string | null;
}

export function emptyModrinth(): InstanceModrinth {
  return { status: 'idle', ctx: null, key: null, scanRef: null, filters: null, resolutions: {}, unresolved: {}, icons: {}, notice: null, error: null, lookupKey: null };
}

/** Cache key of a lookup: the identified hashes, the update filters and the beta preference. */
export function queryKey(identify: readonly string[], updates: UpdateFilters | null, includeBeta: boolean): string {
  return JSON.stringify([identify, updates, includeBeta]);
}

/** The context the mod table and inspector may show for `result`, else null (unknown). */
export function viewContext(m: InstanceModrinth | undefined, result: ScanResult | null): ModrinthContext | null {
  if (!m || !m.ctx || m.key === null || !result || m.scanRef !== result) return null;
  return m.ctx;
}

/**
 * One piece of a summary-strip notice. `optional` pieces are dropped first when the strip is
 * narrow (a container query); the others are always visible.
 */
export interface NoticePart {
  text: string;
  optional?: boolean;
}

/**
 * Summary-strip notice (DESIGN.md §10) as parts, or null. `now` is the UI clock. The rate-limit
 * countdown is never optional: a narrow strip (1280×800) shows `Modrinth · retrying in 42 s`,
 * a wide one `Modrinth rate limit · retrying in 42 s`.
 */
export function noticeParts(n: ModrinthNotice | null, now: number): NoticePart[] | null {
  if (!n) return null;
  switch (n.kind) {
    case 'offline':
      return [{ text: 'Modrinth unreachable' }, { text: ' — static checks only', optional: true }];
    case 'partial':
      return [{ text: 'Modrinth: some lookups failed' }];
    case 'failed':
      return [{ text: 'Modrinth lookup failed' }, { text: ' — static checks only', optional: true }];
    case 'rateLimited':
      if (n.retryAt === null) return [{ text: 'Modrinth rate limit' }, { text: ' — static checks only', optional: true }];
      return [
        { text: 'Modrinth' },
        { text: ' rate limit', optional: true },
        { text: ` · retrying in ${Math.max(0, Math.ceil((n.retryAt - now) / 1000))} s` },
      ];
  }
}

/** The whole notice on one line (tooltip, tests), or null. */
export function noticeText(n: ModrinthNotice | null, now: number): string | null {
  return noticeParts(n, now)?.map((p) => p.text).join('') ?? null;
}

/** `JarMatch` → the mod-table column state. */
export function matchCell(m: JarMatch): ModrinthMatch {
  switch (m.state) {
    case 'matched':
      return { state: 'matched' };
    case 'update':
      return { state: 'update', version: m.update.versionNumber, beta: m.beta };
    case 'missing':
      return { state: 'missing' };
    case 'unknown':
      return { state: 'offline' };
  }
}

/**
 * Icon source for a cached project icon. In the app: `convert` (Tauri's `convertFileSrc`) on the
 * absolute cache path. The browser mock supplies inline `data:` images. Anything else (a remote
 * URL, a path outside Tauri) shows no icon: the webview never requests a remote URL.
 */
export function iconSrc(path: string | null | undefined, convert: ((p: string) => string) | null): string | null {
  if (!path) return null;
  if (path.startsWith('data:image/')) return path;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(path)) return null;
  return convert ? convert(path) : null;
}

/** Project of a matched jar (for its icon and title), if known. */
export function matchProject(m: JarMatch): MrProject | null {
  return m.state === 'matched' || m.state === 'update' ? m.project : null;
}

/** Cached icon path of a project: the `modrinth_icons` pass first, else what the lookup had. */
export function iconPathOf(project: MrProject | null, icons: Readonly<Record<string, string>> | undefined): string | null {
  if (!project) return null;
  return icons?.[project.id] ?? project.iconPath ?? null;
}

/**
 * A per-jar view for `deriveModRows`: the Modrinth column and the icon. Without a context every
 * jar is unknown (`—`). A throwing core never breaks the table.
 */
export function modrinthRowView(
  core: Pick<ModrinthCoreApi, 'jarMatch'>,
  ctx: ModrinthContext | null,
  convert: ((p: string) => string) | null,
  icons?: Readonly<Record<string, string>>,
): (jar: JarRecord) => Pick<ModRow, 'modrinth' | 'iconUrl'> {
  return (jar) => {
    if (!ctx) return { modrinth: { state: 'offline' }, iconUrl: null };
    try {
      const m = core.jarMatch(jar, ctx);
      return { modrinth: matchCell(m), iconUrl: iconSrc(iconPathOf(matchProject(m), icons), convert) };
    } catch {
      return { modrinth: { state: 'offline' }, iconUrl: null };
    }
  };
}

/**
 * Mod-table facts of a file a `.mrpack` index declares (`core.declaredMatch` by sha1): the
 * Modrinth column, the identified version and the project title (the row's name).
 */
export function declaredRowView(
  core: Pick<typeof ModrinthCore, 'declaredMatch'>,
  ctx: ModrinthContext | null,
): (file: DeclaredFile) => { modrinth: ModrinthMatch; version: string | null; title: string | null } {
  return (file) => {
    if (!ctx) return { modrinth: { state: 'offline' }, version: null, title: null };
    try {
      const m = core.declaredMatch(file, ctx);
      const p = matchProject(m);
      return { modrinth: matchCell(m), version: m.state === 'matched' || m.state === 'update' ? m.version.versionNumber : null, title: p?.title ?? null };
    } catch {
      return { modrinth: { state: 'offline' }, version: null, title: null };
    }
  };
}

const isBeta = (v: MrVersion) => v.versionType !== 'release';

/**
 * Version facts the fix buttons need (`Update Sodium to 0.5.11`, `Install Cloth Config 15.0.140`):
 * every update in the context and every dependency resolution, by version id.
 */
export function fixVersions(
  ctx: ModrinthContext | null,
  resolutions: Readonly<Record<string, DependencyResolution>>,
  depRange?: DepRangeData,
): FixVersions {
  const out: Record<string, { versionNumber: string; beta: boolean; title?: string }> = {};
  if (ctx) {
    for (const v of Object.values(ctx.updates)) {
      const title = ctx.projects[v.projectId]?.title;
      out[v.id] = { versionNumber: v.versionNumber, beta: isBeta(v), ...(title ? { title } : {}) };
    }
  }
  for (const r of Object.values(resolutions)) out[r.version.id] = { versionNumber: r.version.versionNumber, beta: r.beta, title: r.project.title };
  // Versions an E-DEP-RANGE `replace` may name ("Update Create to 6.0.6").
  if (depRange) {
    for (const { version: v, title } of depRangeVersions(depRange, ctx)) {
      if (!(v.id in out)) out[v.id] = { versionNumber: v.versionNumber, beta: isBeta(v), ...(title ? { title } : {}) };
    }
  }
  return out;
}

/** Modrinth v3 environment values in words. */
const ENVIRONMENT: Readonly<Record<string, string>> = {
  client_and_server: 'client and server',
  client_only: 'client only',
  client_only_server_optional: 'client; server optional',
  singleplayer_only: 'singleplayer only',
  server_only: 'server only',
  server_only_client_optional: 'server; client optional',
  dedicated_server_only: 'dedicated server only',
  client_or_server: 'client or server',
  client_or_server_prefers_both: 'client or server, best on both',
  unknown: 'unknown',
};

const envWords = (e: string) => ENVIRONMENT[e] ?? e.replace(/_/g, ' ');

export type UpdateStatus = NonNullable<ModrinthContext['updateStatus']>[string];

/**
 * The inspector's "Update" line for an identified jar with no update to offer (CONTRACTS
 * invariant 8, `ModrinthContext.updateStatus`): "up to date" only when the lookup established
 * it; never inferred from a missing update.
 */
export function updateWords(
  status: UpdateStatus | undefined,
  filters: UpdateFilters | null,
  target: { loaderName: string | null; mcVersion: string | null },
): { tone: 'ok' | 'dim' | 'faint'; text: string } {
  if (!filters) return { tone: 'faint', text: 'not checked (pack MC version or loader unknown)' };
  if (status === 'upToDate') return { tone: 'ok', text: 'up to date' };
  if (status === 'noCompatible') {
    const words = [target.loaderName, target.mcVersion ?? filters.gameVersions[0] ?? null].filter((w): w is string => !!w).join(' ');
    return { tone: 'dim', text: words ? `no version for ${words} on Modrinth` : 'no compatible version on Modrinth' };
  }
  return { tone: 'faint', text: 'update check unavailable' };
}

/**
 * Where a mod runs, preferring the version's v3 `environment`, then the project's, then the
 * deprecated `client_side` / `server_side` fields.
 */
export function sideSupport(version: MrVersion | null, project: MrProject | null): string {
  if (version?.environment) return envWords(version.environment);
  const envs = project?.environment.filter((e) => e && e !== 'unknown') ?? [];
  if (envs.length) return envs.map(envWords).join(' / ');
  if (project && (project.clientSide !== 'unknown' || project.serverSide !== 'unknown')) {
    return `client ${project.clientSide} · server ${project.serverSide}`;
  }
  return 'unknown';
}

/** `https://modrinth.com/mod/<slug>`. */
export function projectUrl(project: Pick<MrProject, 'slug'>): string {
  return `https://modrinth.com/mod/${encodeURIComponent(project.slug)}`;
}
