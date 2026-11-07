/**
 * Modrinth enrichment (M5). FROZEN API — implementation owned by the M5 core agent.
 *
 * Pure: inputs are the IPC results (`HashLookup`, `ProjectLookup`, `MrVersion[]`), outputs are
 * the `ModrinthContext` the checks read, per-jar match states for the mod table, and findings with
 * Modrinth fixes added. No network, no Tauri, no DOM (purity.test.ts).
 *
 * Flow (the UI drives it after each scan; every step is optional and may fail independently):
 * 1. `planQueries(scan, pack)` → sha1s to identify, and the update filters (null when the pack's
 *    loader or MC version is unknown: an unfiltered update call returns other MC versions).
 * 2. `modrinth_identify(sha1s)`, then `modrinth_find_updates(sha1s, loaders, gameVersions,
 *    updateVersionTypes(includeBeta))`, and if `includeBeta` is false a second call with
 *    `["release","beta"]` for the sha1s that got no release (beta-only fallback,
 *    CONTRACTS invariant 8).
 * 3. `modrinth_projects(projectIdsOf(identify))` for titles, sides and icons.
 * 4. `buildModrinthContext(…)` → `ModrinthContext`; run the checks with it.
 * 5. `missingModIds(findings)` → `modrinth_resolve_mod_id` per id → `modrinth_project_versions`
 *    → `chooseVersion` → `DependencyResolution`s.
 * 6. `enrichFindings(findings, ctx, resolutions, scan.jars)` adds `replace` / `installDependency`
 *    fixes, also for crash findings.
 */
import type { FixAction, HashLookup, JarRecord, MrFile, MrProject, MrVersion, ProjectLookup, ScanResult } from '../../bindings';
import type { Finding, FindingCode, ModrinthContext, PackContext } from '../model';

export interface UpdateFilters {
  /** Modrinth loader names (`modrinthLoaders`). Never empty. */
  loaders: string[];
  /** `[pack.mcVersion]`. Never empty. */
  gameVersions: string[];
}

export interface ModrinthQueries {
  /** sha1 (lower-case, deduplicated, sorted) of every top-level jar, enabled or disabled. */
  identify: string[];
  /** Null when the pack's loader or MC version is unknown: no update lookup then. */
  updates: UpdateFilters | null;
}

/** One jar's Modrinth state for the mod table and inspector. */
export type JarMatch =
  | { state: 'matched'; version: MrVersion; project: MrProject | null }
  | { state: 'update'; version: MrVersion; project: MrProject | null; update: MrVersion; beta: boolean }
  | { state: 'missing' }
  /** Lookup failed, offline, or never ran: unknown, never "missing". */
  | { state: 'unknown' };

/** A chosen version for a missing dependency. */
export interface DependencyResolution {
  modId: string;
  project: MrProject;
  version: MrVersion;
  /** `version.versionType !== 'release'` (shown as "beta"). */
  beta: boolean;
}

// ---- helpers -----------------------------------------------------------------------------------

/** Sorted, de-duplicated copy (plain code-unit order, deterministic across locales). */
function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** Only `release` and `beta` are ever suggested (invariant 8); unknown types are not guessed at. */
function isSuggestible(v: MrVersion): boolean {
  return v.versionType === 'release' || v.versionType === 'beta';
}

/** Lower-cased keys; the first entry wins when two keys differ only in case. */
function lowerKeys<T>(record: { [key in string]: T } | null | undefined): Map<string, T> {
  const out = new Map<string, T>();
  for (const [k, v] of Object.entries(record ?? {})) {
    const key = k.toLowerCase();
    if (!out.has(key)) out.set(key, v);
  }
  return out;
}

/** File types that are never download candidates (invariant 8; same list as the Rust planner). */
const EXCLUDED_FILE_TYPES: ReadonlySet<string> = new Set(['sources-jar', 'dev-jar', 'javadoc-jar', 'signature']);

/** Codes whose culprit jars get `replace` fixes, besides every `C-*` crash code. */
const REPLACE_CODES: ReadonlySet<FindingCode> = new Set<FindingCode>(['E-WRONG-LOADER', 'E-MC-RANGE', 'E-LOADER-RANGE']);

function wantsReplace(code: FindingCode): boolean {
  return REPLACE_CODES.has(code) || code.startsWith('C-');
}

// ---- queries -----------------------------------------------------------------------------------

/**
 * Modrinth loader names for the pack: forge → `forge`; neoforge → `neoforge` (plus `forge` on MC
 * 1.20.1, CONTRACTS invariant 12); fabric → `fabric`; quilt → `quilt`, `fabric`;
 * legacyforge → `forge`; unknown / null → `[]`.
 */
export function modrinthLoaders(pack: PackContext): string[] {
  switch (pack.loader?.kind) {
    case 'forge':
    case 'legacyforge':
      return ['forge'];
    case 'neoforge':
      return pack.mcVersion?.trim() === '1.20.1' ? ['neoforge', 'forge'] : ['neoforge'];
    case 'fabric':
      return ['fabric'];
    case 'quilt':
      return ['quilt', 'fabric'];
    default:
      return [];
  }
}

export function planQueries(scan: ScanResult, pack: PackContext): ModrinthQueries {
  const identify = sortedUnique(
    scan.jars.filter((j) => j.depth === 0).flatMap((j) => {
      const h = j.sha1.trim().toLowerCase();
      return h.length > 0 ? [h] : [];
    }),
  );
  const loaders = modrinthLoaders(pack);
  // MC versions are passed through verbatim: `26.1`, `26.4-snapshot-6`, `1.21.11` (invariant 9).
  const mc = pack.mcVersion?.trim() ?? '';
  const updates = loaders.length > 0 && mc.length > 0 ? { loaders, gameVersions: [mc] } : null;
  return { identify, updates };
}

/** `["release"]`, or `["release","beta"]` when `includeBeta`. Never alpha. */
export function updateVersionTypes(includeBeta: boolean): string[] {
  return includeBeta ? ['release', 'beta'] : ['release'];
}

/** Project ids of every identified version (deduplicated, sorted). */
export function projectIdsOf(identify: HashLookup): string[] {
  return sortedUnique(Object.values(identify.found).flatMap((v) => (v.projectId ? [v.projectId] : [])));
}

// ---- context -----------------------------------------------------------------------------------

/**
 * Merge the lookups. `updates` keeps, per sha1, the release update if any, else the beta-fallback
 * update; an "update" equal to the identified version (same version id) is dropped, as is any
 * alpha. `failed` = union of failed sha1s of `identify` only (a failed update lookup is not a
 * failed identification). `offline` = `identify.offline`. Keys are lower-case sha1s.
 */
export function buildModrinthContext(args: {
  identify: HashLookup;
  updates?: HashLookup | null;
  betaFallback?: HashLookup | null;
  projects?: ProjectLookup | null;
}): ModrinthContext {
  const identified = lowerKeys(args.identify.found);
  const versions: Record<string, MrVersion> = {};
  for (const [sha1, v] of identified) versions[sha1] = v;

  // An update is kept only for an identified jar, in the same project (the Rust planner refuses a
  // `replace` across projects or for a jar it cannot identify by hash), and never alpha.
  const usable = (sha1: string, candidate: MrVersion | undefined): MrVersion | undefined => {
    const current = identified.get(sha1);
    if (!candidate || !current || !isSuggestible(candidate)) return undefined;
    return candidate.projectId === current.projectId ? candidate : undefined;
  };
  const primary = lowerKeys(args.updates?.found);
  const fallback = lowerKeys(args.betaFallback?.found);
  const updates: Record<string, MrVersion> = {};
  for (const sha1 of sortedUnique([...primary.keys(), ...fallback.keys()])) {
    // The primary lookup decides whenever it returned something usable, even "already newest":
    // a compatible release exists then, so the beta-only fallback does not apply.
    const chosen = usable(sha1, primary.get(sha1)) ?? usable(sha1, fallback.get(sha1));
    if (chosen && chosen.id !== identified.get(sha1)?.id) updates[sha1] = chosen;
  }

  const projects: Record<string, MrProject> = {};
  // `ProjectLookup.found` is keyed by the requested id or slug; re-key by the project id.
  for (const p of Object.values(args.projects?.found ?? {})) {
    if (p.id && !(p.id in projects)) projects[p.id] = p;
  }

  return {
    versions,
    projects,
    updates,
    failed: sortedUnique(args.identify.failed.map((s) => s.toLowerCase())),
    offline: args.identify.offline,
  };
}

/** State of one jar (nested jars: `unknown` unless their sha1 was identified). */
export function jarMatch(jar: JarRecord, ctx: ModrinthContext | null | undefined): JarMatch {
  if (!ctx) return { state: 'unknown' };
  const sha1 = jar.sha1.trim().toLowerCase();
  if (sha1.length === 0) return { state: 'unknown' };
  const version = ctx.versions[sha1];
  if (version) {
    const project = ctx.projects[version.projectId] ?? null;
    const update = ctx.updates[sha1];
    if (update && update.id !== version.id && isSuggestible(update)) {
      return { state: 'update', version, project, update, beta: update.versionType !== 'release' };
    }
    return { state: 'matched', version, project };
  }
  // Not identified: only a completed online lookup of a top-level jar may say "missing".
  if (ctx.offline || jar.depth > 0 || ctx.failed.some((s) => s.toLowerCase() === sha1)) return { state: 'unknown' };
  return { state: 'missing' };
}

// ---- version / file choice ---------------------------------------------------------------------

/**
 * The file a download would use — CONTRACTS invariant 8, identical to the Rust planner: skip
 * `sources-jar`, `dev-jar`, `javadoc-jar`, `signature`; then the `primary` file, else the sole
 * file; null when several remain and none is primary, or when `version.primaryDropped`.
 */
export function downloadFile(version: MrVersion): MrFile | null {
  if (version.primaryDropped) return null;
  const candidates = version.files.filter((f) => f.fileType === null || !EXCLUDED_FILE_TYPES.has(f.fileType));
  const primary = candidates.find((f) => f.primary);
  if (primary) return primary;
  return candidates.length === 1 ? (candidates[0] ?? null) : null;
}

/**
 * Newest usable version from `modrinth_project_versions` output (already filtered by loader + MC):
 * the first `release` with a `downloadFile`; else, only when no release qualifies, the first
 * `beta` (labelled beta). `includeBeta` lets a newer beta win over an older release. Never alpha.
 */
export function chooseVersion(versions: MrVersion[], includeBeta: boolean): MrVersion | null {
  const usable = versions.filter((v) => isSuggestible(v) && downloadFile(v) !== null);
  if (includeBeta) return usable[0] ?? null;
  return usable.find((v) => v.versionType === 'release') ?? usable.find((v) => v.versionType === 'beta') ?? null;
}

// ---- findings ----------------------------------------------------------------------------------

/** Union of `finding.missingModIds` (deduplicated, sorted). */
export function missingModIds(findings: readonly Finding[]): string[] {
  return sortedUnique(findings.flatMap((f) => f.missingModIds ?? []));
}

/** Identity of a fix for de-duplication: one replace per jar, one install per mod id. */
function fixKey(fix: FixAction): string | null {
  switch (fix.kind) {
    case 'replace':
      return `replace\u0000${fix.jarId}`;
    case 'installDependency':
      return `install\u0000${fix.modId}`;
    default:
      return null;
  }
}

/**
 * Returns new findings (inputs untouched; ids unchanged) with Modrinth fixes:
 * - `replace` for each culprit jar with an update in `ctx.updates` whose `downloadFile` is not
 *   null, on E-WRONG-LOADER, E-MC-RANGE, E-LOADER-RANGE and every C-* crash finding. Replace fixes
 *   go first (recommended), before existing fixes; no duplicates.
 * - `installDependency` for each of `finding.missingModIds` that has a resolution, first.
 * Nothing changes when `ctx` is null/offline.
 *
 * `jars` (the scan's `JarRecord`s) maps culprit jar ids to sha1s, since `JarRef` carries no hash;
 * without it no `replace` fix can be offered. Only top-level, enabled jars are replaced (culprits
 * are always top-level). Order of new fixes: `installDependency` (in `missingModIds` order), then
 * `replace` (in culprit order), then the existing fixes minus any the new ones supersede (same
 * jar for `replace`, same mod id for `installDependency`). Unchanged findings are returned as is.
 */
export function enrichFindings(
  findings: readonly Finding[],
  ctx: ModrinthContext | null | undefined,
  resolutions?: Readonly<Record<string, DependencyResolution>>,
  jars?: readonly JarRecord[],
): Finding[] {
  if (!ctx || ctx.offline) return [...findings];
  const byId = new Map<string, JarRecord>();
  for (const j of jars ?? []) if (!byId.has(j.id)) byId.set(j.id, j);

  const replaceFor = (jarId: string): FixAction | null => {
    const jar = byId.get(jarId);
    if (!jar || jar.depth !== 0 || jar.disabled) return null;
    const sha1 = jar.sha1.trim().toLowerCase();
    const current = ctx.versions[sha1];
    const update = ctx.updates[sha1];
    if (!current || !update || update.id === current.id || update.projectId !== current.projectId) return null;
    if (!isSuggestible(update) || downloadFile(update) === null) return null;
    return { kind: 'replace', jarId: jar.id, versionId: update.id };
  };

  const installFor = (modId: string): FixAction | null => {
    const r = resolutions?.[modId];
    if (!r || !isSuggestible(r.version) || downloadFile(r.version) === null) return null;
    return { kind: 'installDependency', modId, versionId: r.version.id };
  };

  return findings.map((f) => {
    const added: FixAction[] = [];
    const keys = new Set<string>();
    const add = (fix: FixAction | null): void => {
      const key = fix && fixKey(fix);
      if (!fix || !key || keys.has(key)) return;
      keys.add(key);
      added.push(fix);
    };
    for (const modId of f.missingModIds ?? []) add(installFor(modId));
    if (wantsReplace(f.code)) for (const c of f.culprits) add(replaceFor(c.jarId));
    if (added.length === 0) return f;
    const kept = f.fixes.filter((fix) => {
      const key = fixKey(fix);
      return key === null || !keys.has(key);
    });
    return { ...f, fixes: [...added, ...kept] };
  });
}
