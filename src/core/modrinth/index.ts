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
 *    updateVersionTypes(includeBeta))` for the identified sha1s, then — only when
 *    `betaFallbackHashes(identify, updates, includeBeta)` is non-empty — a second call with
 *    `updateVersionTypes(true)` (`["release","beta"]`) for exactly those sha1s (CONTRACTS
 *    invariant 8). They are the identified sha1s that, with `includeBeta` off:
 *    - got no answer from the release lookup (not failed, and the lookup was not cache-only:
 *      offline, an absent hash means "not cached", not "no release") — no compatible release; or
 *    - got a release **older** than the identified version (`datePublished`): the user runs a
 *      pre-release newer than the last release, so only a newer beta can be an update. The UI
 *      must include these too, or such jars never see a newer beta.
 *    An update is only ever offered when it was published strictly after the identified version
 *    (both dates present); anything else would be a downgrade.
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

/** ISO 8601 with a time and an explicit zone, as Modrinth sends `date_published` (µs precision). */
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})[Tt ](\d{2}):(\d{2}):(\d{2})(?:[.,](\d{1,9})\d*)?(?:([Zz])|([+-])(\d{2}):?(\d{2}))$/;

/**
 * `datePublished` as `[epoch ms at whole seconds, nanoseconds within the second]`, compared
 * lexicographically (a single double cannot hold µs since 1970 exactly). Null when missing or
 * not a valid ISO 8601 date-time with a zone: an unknown date never makes a version "newer".
 */
function publishedKey(v: MrVersion): readonly [number, number] | null {
  const m = ISO_DATE.exec(typeof v.datePublished === 'string' ? v.datePublished.trim() : '');
  if (!m) return null;
  const [y, mo, d, h, mi, s] = m.slice(1, 7).map(Number) as [number, number, number, number, number, number];
  if (mo < 1 || mo > 12 || d < 1 || h > 23 || mi > 59 || s > 59) return null;
  const date = new Date(Date.UTC(y, mo - 1, d, h, mi, s));
  // Rejects 2024-02-30 and friends (Date.UTC would roll them over).
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) return null;
  let ms = date.getTime();
  if (!m[8]) {
    const oh = Number(m[10]);
    const om = Number(m[11]);
    if (oh > 23 || om > 59) return null;
    ms -= (m[9] === '-' ? -1 : 1) * (oh * 60 + om) * 60_000;
  }
  const nanos = Number((m[7] ?? '').padEnd(9, '0'));
  return Number.isFinite(ms) ? [ms, nanos] : null;
}

/** -1 / 0 / 1 by `datePublished`; null when either date is missing or unparseable. */
function comparePublished(a: MrVersion, b: MrVersion): -1 | 0 | 1 | null {
  const ka = publishedKey(a);
  const kb = publishedKey(b);
  if (!ka || !kb) return null;
  if (ka[0] !== kb[0]) return ka[0] < kb[0] ? -1 : 1;
  if (ka[1] !== kb[1]) return ka[1] < kb[1] ? -1 : 1;
  return 0;
}

/**
 * True only when `candidate` is another version published strictly after `current` (both dates
 * parseable) — CONTRACTS invariant 8: Modrinth's "newest matching" version can be older than a
 * beta the user runs, and a downgrade is never offered.
 */
export function isNewerVersion(candidate: MrVersion, current: MrVersion): boolean {
  return candidate.id !== current.id && comparePublished(candidate, current) === 1;
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

type UpdateStatus = NonNullable<ModrinthContext['updateStatus']>[string];

/** One update lookup (`modrinth_find_updates` result), keys and `failed` lower-cased. */
interface UpdateAnswers {
  found: Map<string, MrVersion>;
  failed: ReadonlySet<string>;
  offline: boolean;
}

function updateAnswers(lookup: HashLookup | null | undefined): UpdateAnswers | null {
  if (!lookup) return null;
  return { found: lowerKeys(lookup.found), failed: new Set(lookup.failed.map((s) => s.toLowerCase())), offline: lookup.offline };
}

/**
 * An update answer that may be suggested for `current` at all: same project (the Rust planner
 * refuses a `replace` across projects), and never alpha.
 */
function usableFor(current: MrVersion, candidate: MrVersion | undefined): MrVersion | undefined {
  if (!candidate || !isSuggestible(candidate)) return undefined;
  return candidate.projectId === current.projectId ? candidate : undefined;
}

/**
 * What the release lookup (`primary`) established for one identified version:
 * - `decided`: it settles the jar (newer release → update; same version or same date → up to
 *   date; dates missing → unknown), the beta fallback does not apply;
 * - `fallback`: no usable release answer, or a release **older** than the current version (a
 *   pre-release newer than the last release) — the beta fallback decides;
 * - `unknown`: no lookup, the hash failed, or offline without a cached answer.
 */
type PrimaryVerdict =
  | { kind: 'decided'; status: UpdateStatus; update?: MrVersion }
  | { kind: 'fallback'; olderRelease: boolean }
  | { kind: 'unknown' };

function primaryVerdict(sha1: string, current: MrVersion, primary: UpdateAnswers | null): PrimaryVerdict {
  if (!primary || primary.failed.has(sha1)) return { kind: 'unknown' };
  const raw = primary.found.get(sha1);
  const answer = usableFor(current, raw);
  if (!answer) {
    // Absent while cache-only means "not cached", not "no compatible release".
    if (raw === undefined && primary.offline) return { kind: 'unknown' };
    return { kind: 'fallback', olderRelease: false };
  }
  if (answer.id === current.id) return { kind: 'decided', status: 'upToDate' };
  const order = comparePublished(answer, current);
  if (order === 1) return { kind: 'decided', status: 'update', update: answer };
  if (order === 0) return { kind: 'decided', status: 'upToDate' };
  if (order === -1) return { kind: 'fallback', olderRelease: true };
  return { kind: 'decided', status: 'unknown' };
}

/**
 * sha1s for the beta-only fallback call (`modrinth_find_updates` with `updateVersionTypes(true)`):
 * the identified sha1s (lower-case, sorted) whose release lookup in `updates` got no usable answer
 * (absent — but not failed, and not merely uncached in an offline lookup — or alpha / another
 * project), or a release published **before** the identified version (the user runs a newer
 * pre-release; only a newer beta can be an update). `[]` when `includeBeta` (the first call
 * already covered betas) or when no update lookup ran (`updates` null). CONTRACTS invariant 8.
 */
export function betaFallbackHashes(identify: HashLookup, updates: HashLookup | null | undefined, includeBeta: boolean): string[] {
  const primary = updateAnswers(updates);
  if (includeBeta || !primary) return [];
  const out: string[] = [];
  for (const [sha1, current] of lowerKeys(identify.found)) {
    if (primaryVerdict(sha1, current, primary).kind === 'fallback') out.push(sha1);
  }
  return sortedUnique(out);
}

/**
 * Merge the lookups. Per identified sha1 (lower-case keys):
 * - `updates`: the release lookup's answer if it was published strictly after the identified
 *   version; else, when the release lookup got no usable answer or an **older** release (see
 *   `betaFallbackHashes`), the beta-fallback answer if it is strictly newer. Never alpha, never
 *   another project, never the same version, never an older or undated one (CONTRACTS
 *   invariant 8: no downgrades; missing dates → not offered).
 * - `updateStatus` (every identified sha1): `update` when `updates` has an entry; `upToDate` when
 *   the answer is this version or not newer (same date, or older with no newer beta);
 *   `noCompatible` when the release lookup ran and had no usable answer (not failed, not
 *   cache-only-absent) and the fallback, if run, had none either; `unknown` when no update lookup
 *   ran (`updates` null), the hash failed in a lookup that decides it, the lookup was cache-only
 *   without an answer, or a date needed to order the versions is missing.
 *   `betaFallback` null means no fallback was needed (or `includeBeta` was on).
 * - `failed` = union of failed sha1s of `identify` only (a failed update lookup is not a failed
 *   identification). `offline` = `identify.offline`.
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

  const primary = updateAnswers(args.updates);
  const fallback = updateAnswers(args.betaFallback);
  const updates: Record<string, MrVersion> = {};
  const updateStatus: Record<string, UpdateStatus> = {};
  for (const [sha1, current] of identified) {
    const verdict = primaryVerdict(sha1, current, primary);
    let status: UpdateStatus;
    let update: MrVersion | undefined;
    if (verdict.kind === 'unknown') status = 'unknown';
    else if (verdict.kind === 'decided') ({ status, update } = verdict);
    else {
      // The release lookup did not settle it: the beta-only fallback decides.
      const raw = fallback?.found.get(sha1);
      const answer = usableFor(current, raw);
      const order = answer ? (answer.id === current.id ? 0 : comparePublished(answer, current)) : undefined;
      if (answer && order === 1) {
        status = 'update';
        update = answer;
      } else if (order === 0 || order === -1) status = 'upToDate';
      else if (order === null) status = 'unknown';
      else if (fallback && raw === undefined && (fallback.failed.has(sha1) || fallback.offline)) status = 'unknown';
      // Nothing newer: on a pre-release past the last release that is "up to date".
      else status = verdict.olderRelease ? 'upToDate' : 'noCompatible';
    }
    updateStatus[sha1] = status;
    if (update) updates[sha1] = update;
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
    updateStatus,
  };
}

/**
 * State of one jar (nested jars: `unknown` unless their sha1 was identified). `update` only for
 * an update published strictly after the identified version (`isNewerVersion`), same project,
 * never alpha — also for hand-built contexts.
 */
export function jarMatch(jar: JarRecord, ctx: ModrinthContext | null | undefined): JarMatch {
  if (!ctx) return { state: 'unknown' };
  const sha1 = jar.sha1.trim().toLowerCase();
  if (sha1.length === 0) return { state: 'unknown' };
  const version = ctx.versions[sha1];
  if (version) {
    const project = ctx.projects[version.projectId] ?? null;
    const update = ctx.updates[sha1];
    // Defence in depth for hand-built contexts: never a downgrade, alpha or other project.
    if (update && isSuggestible(update) && update.projectId === version.projectId && isNewerVersion(update, version)) {
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
 * file; null when several remain and none is primary, when none is primary and the client
 * dropped any file (`droppedFiles > 0`: the sole remaining file is not the API's sole file), or
 * when `version.primaryDropped`.
 */
export function downloadFile(version: MrVersion): MrFile | null {
  if (version.primaryDropped) return null;
  const candidates = version.files.filter((f) => f.fileType === null || !EXCLUDED_FILE_TYPES.has(f.fileType));
  const primary = candidates.find((f) => f.primary);
  if (primary) return primary;
  // "Sole file" counts the API's whole list: a dropped file might have been the real one.
  if (version.droppedFiles > 0) return null;
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
 * - `replace` for each culprit jar with an update in `ctx.updates` that is published strictly
 *   after the identified version (same project, never alpha) and whose `downloadFile` is not
 *   null, on E-WRONG-LOADER, E-MC-RANGE, E-LOADER-RANGE and every C-* crash finding. Replace fixes
 *   go first (recommended), before existing fixes; no duplicates.
 * - `installDependency` for each of `finding.missingModIds` that has a resolution, first — after
 *   any existing `enable` fix (a disabled jar the user already has that provides the id).
 * Nothing changes when `ctx` is null/offline.
 *
 * `jars` (the scan's `JarRecord`s) maps culprit jar ids to sha1s, since `JarRef` carries no hash;
 * without it no `replace` fix can be offered. Only top-level, enabled jars are replaced (culprits
 * are always top-level). Order: existing `enable` fixes, then `installDependency` (in
 * `missingModIds` order), then `replace` (in culprit order), then the other existing fixes minus any the new ones supersede (same
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
    if (!current || !update || update.projectId !== current.projectId || !isNewerVersion(update, current)) return null;
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
    // Re-enabling a jar the user already has beats downloading another copy.
    const enables = kept.filter((fix) => fix.kind === 'enable');
    const rest = kept.filter((fix) => fix.kind !== 'enable');
    return { ...f, fixes: [...enables, ...added, ...rest] };
  });
}
