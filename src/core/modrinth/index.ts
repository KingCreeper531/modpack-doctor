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
 * 6. `enrichFindings(findings, ctx, resolutions)` adds `replace` / `installDependency` fixes,
 *    also for crash findings.
 */
import type { HashLookup, JarRecord, MrFile, MrProject, MrVersion, ProjectLookup, ScanResult } from '../../bindings';
import type { Finding, ModrinthContext, PackContext } from '../model';

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

/**
 * Modrinth loader names for the pack: forge → `forge`; neoforge → `neoforge` (plus `forge` on MC
 * 1.20.1, CONTRACTS invariant 12); fabric → `fabric`; quilt → `quilt`, `fabric`;
 * legacyforge → `forge`; unknown / null → `[]`.
 */
export declare function modrinthLoaders(pack: PackContext): string[];

export declare function planQueries(scan: ScanResult, pack: PackContext): ModrinthQueries;

/** `["release"]`, or `["release","beta"]` when `includeBeta`. Never alpha. */
export declare function updateVersionTypes(includeBeta: boolean): string[];

/** Project ids of every identified version (deduplicated, sorted). */
export declare function projectIdsOf(identify: HashLookup): string[];

/**
 * Merge the lookups. `updates` keeps, per sha1, the release update if any, else the beta-fallback
 * update; an "update" equal to the identified version (same version id) is dropped, as is any
 * alpha. `failed` = union of failed sha1s of `identify` only (a failed update lookup is not a
 * failed identification). `offline` = `identify.offline`. Keys are lower-case sha1s.
 */
export declare function buildModrinthContext(args: {
  identify: HashLookup;
  updates?: HashLookup | null;
  betaFallback?: HashLookup | null;
  projects?: ProjectLookup | null;
}): ModrinthContext;

/** State of one jar (nested jars: `unknown` unless their sha1 was identified). */
export declare function jarMatch(jar: JarRecord, ctx: ModrinthContext | null | undefined): JarMatch;

/**
 * The file a download would use — CONTRACTS invariant 8, identical to the Rust planner: skip
 * `sources-jar`, `dev-jar`, `javadoc-jar`, `signature`; then the `primary` file, else the sole
 * file; null when several remain and none is primary, or when `version.primaryDropped`.
 */
export declare function downloadFile(version: MrVersion): MrFile | null;

/**
 * Newest usable version from `modrinth_project_versions` output (already filtered by loader + MC):
 * the first `release` with a `downloadFile`; else, only when no release qualifies, the first
 * `beta` (labelled beta). `includeBeta` lets a newer beta win over an older release. Never alpha.
 */
export declare function chooseVersion(versions: MrVersion[], includeBeta: boolean): MrVersion | null;

/** Union of `finding.missingModIds` (deduplicated, sorted). */
export declare function missingModIds(findings: readonly Finding[]): string[];

/**
 * Returns new findings (inputs untouched; ids unchanged) with Modrinth fixes:
 * - `replace` for each culprit jar with an update in `ctx.updates` whose `downloadFile` is not
 *   null, on E-WRONG-LOADER, E-MC-RANGE, E-LOADER-RANGE and every C-* crash finding. Replace fixes
 *   go first (recommended), before existing fixes; no duplicates.
 * - `installDependency` for each of `finding.missingModIds` that has a resolution, first.
 * Nothing changes when `ctx` is null/offline.
 */
export declare function enrichFindings(
  findings: readonly Finding[],
  ctx: ModrinthContext | null | undefined,
  resolutions?: Readonly<Record<string, DependencyResolution>>,
): Finding[];
