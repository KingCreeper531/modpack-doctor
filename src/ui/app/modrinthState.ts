/**
 * Per-instance Modrinth enrichment state (M5) and the pure view helpers built on it: the mod-table
 * column, icons, fix-button versions, the summary-strip notice and the inspector's side text.
 *
 * The store (store.ts) drives the flow documented at the top of `src/core/modrinth/index.ts`
 * after each scan and keeps one `InstanceModrinth` per instance. The context is used only while
 * it answers the current scan (`key` = the planned queries + `includeBeta`), so a stale context
 * never marks a new jar "not on Modrinth".
 */
import type { AppError, JarRecord, MrProject, MrVersion, ScanResult } from '../../bindings';
import type * as ModrinthCore from '../../core/modrinth';
import type { DependencyResolution, JarMatch, UpdateFilters } from '../../core/modrinth';
import type { ModrinthContext } from '../../core/model';
import type { ModrinthMatch, ModRow } from '../components/ModTable';
import type { FixVersions } from '../components/labels';

/** The `src/core/modrinth` entry points the store calls (injectable for tests). */
export type ModrinthCoreApi = Pick<
  typeof ModrinthCore,
  | 'planQueries'
  | 'updateVersionTypes'
  | 'projectIdsOf'
  | 'buildModrinthContext'
  | 'jarMatch'
  | 'chooseVersion'
  | 'missingModIds'
  | 'enrichFindings'
>;

export type ModrinthNotice =
  /** A lookup was offline, failed, or errored: static checks only (DESIGN.md §10). */
  | { kind: 'offline' }
  /** Modrinth answered `rateLimited`. `retryAt` (UI clock) while the one automatic retry waits. */
  | { kind: 'rateLimited'; retryAt: number | null };

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
  notice: ModrinthNotice | null;
  /** The first step error, if any (kept for the tooltip of the notice). */
  error: AppError | null;
}

export function emptyModrinth(): InstanceModrinth {
  return { status: 'idle', ctx: null, key: null, scanRef: null, filters: null, resolutions: {}, notice: null, error: null };
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

/** Summary-strip notice text (DESIGN.md §10), or null. `now` is the UI clock. */
export function noticeText(n: ModrinthNotice | null, now: number): string | null {
  if (!n) return null;
  if (n.kind === 'offline') return 'Modrinth unreachable — static checks only';
  if (n.retryAt === null) return 'Modrinth rate limit — static checks only';
  return `Modrinth rate limit — retrying in ${Math.max(0, Math.ceil((n.retryAt - now) / 1000))} s`;
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

/**
 * A per-jar view for `deriveModRows`: the Modrinth column and the icon. Without a context every
 * jar is unknown (`—`). A throwing core never breaks the table.
 */
export function modrinthRowView(
  core: Pick<ModrinthCoreApi, 'jarMatch'>,
  ctx: ModrinthContext | null,
  convert: ((p: string) => string) | null,
): (jar: JarRecord) => Pick<ModRow, 'modrinth' | 'iconUrl'> {
  return (jar) => {
    if (!ctx) return { modrinth: { state: 'offline' }, iconUrl: null };
    try {
      const m = core.jarMatch(jar, ctx);
      return { modrinth: matchCell(m), iconUrl: iconSrc(matchProject(m)?.iconPath, convert) };
    } catch {
      return { modrinth: { state: 'offline' }, iconUrl: null };
    }
  };
}

const isBeta = (v: MrVersion) => v.versionType !== 'release';

/**
 * Version facts the fix buttons need (`Update Sodium to 0.5.11`, `Install Cloth Config 15.0.140`):
 * every update in the context and every dependency resolution, by version id.
 */
export function fixVersions(ctx: ModrinthContext | null, resolutions: Readonly<Record<string, DependencyResolution>>): FixVersions {
  const out: Record<string, { versionNumber: string; beta: boolean; title?: string }> = {};
  if (ctx) {
    for (const v of Object.values(ctx.updates)) {
      const title = ctx.projects[v.projectId]?.title;
      out[v.id] = { versionNumber: v.versionNumber, beta: isBeta(v), ...(title ? { title } : {}) };
    }
  }
  for (const r of Object.values(resolutions)) out[r.version.id] = { versionNumber: r.version.versionNumber, beta: r.beta, title: r.project.title };
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
