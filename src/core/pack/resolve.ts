/**
 * Pack identity resolution (check 1).
 *
 * Each part is resolved independently, highest precedence first:
 *
 * | part        | 1. override            | 2. metadata (launcher / mrpack)            | 3. majority of active top-level jars |
 * |-------------|------------------------|--------------------------------------------|--------------------------------------|
 * | `mcVersion` | `override.mcVersion`   | `instance.mcVersion` when non-null         | most-satisfied MC version            |
 * | `loader`    | `override.loader`      | `instance.loader`, **including null**      | most-compatible loader, version null |
 * | `side`      | `override.side`        | `instance.side`                            | —                                    |
 *
 * Launcher/mrpack metadata with `loader: null` means a vanilla instance (CONTRACTS invariant 4),
 * so the loader is never inferred then. With `metadataSource: 'inferred'` both parts are inferred.
 *
 * `source` names the highest-precedence origin that supplied `mcVersion` or `loader`:
 * `override` if the override set either of them (a side-only override does not count), else
 * `launcher` / `mrpack` if metadata supplied either, else `majority` if inference found either,
 * else `unknown`.
 *
 * Majority rules (over *active top-level* jars, see `isActive`). The loader is resolved first
 * (using the MC version only when it is known from override/metadata), then the MC version is
 * inferred from the entries relevant to that loader:
 * - Loader: each loader kind scores the number of jars with at least one entry it would load
 *   (`entryRelevant`: a file it reads + `loaderAccepts`, so Fabric jars also count for Quilt,
 *   and Forge/NeoForge count for each other on 1.20.1). Ties → more jars that target that loader
 *   natively; then the fixed order Forge, NeoForge, Fabric, Quilt, Legacy Forge. The inferred
 *   loader's version is always null.
 * - MC version: candidates are the version-like tokens in the `mcRange` of every entry relevant
 *   to the resolved loader (all entries when it is unknown): bounds of Maven ranges, versions in
 *   Fabric predicates (a `1.21.x` wildcard yields `1.21`). Each candidate that normalises as a
 *   Minecraft version scores the number of jars with at least one such range it satisfies
 *   (`subject: 'minecraft'`). Highest score wins; ties → the token mentioned most often; then the
 *   one mentioned more often as a lower bound or exact version (an upper bound such as
 *   `<=1.20.4` or the right side of `[1.20,1.20.4]` is weak evidence); then the newest.
 */
import type { Instance, JarRecord, LoaderInfo, LoaderKind, PackOverride, RawRange, ScanResult } from '../../bindings';
import type { PackContext } from '../model';
import { versionApi } from '../version';
import { isActive } from './active';
import { entryRelevant } from './loaders';

const LOADER_ORDER: readonly LoaderKind[] = ['forge', 'neoforge', 'fabric', 'quilt', 'legacyforge'];

/** Version-like tokens in a range string: `1.20.1`, `1.21-pre1`, `26.1`, `23w51a`. */
const VERSION_TOKEN = /\d{2}w\d{2}[a-z]|\d+(?:\.\d+)+(?:-[A-Za-z0-9.]*[A-Za-z0-9])?/g;

function activeTopLevel(scan: ScanResult): JarRecord[] {
  const byId = new Map(scan.jars.map((j) => [j.id, j] as const));
  return scan.jars.filter((j) => j.depth === 0 && isActive(j, byId));
}

/** Whether the token at `index` in `raw` is an upper bound (`<`, `<=`, right side of `[a,b]`). */
function isUpperBound(raw: string, index: number, syntax: RawRange['syntax']): boolean {
  const before = raw.slice(0, index);
  if (syntax === 'fabric') return /<=?\s*$/.test(before);
  const open = Math.max(before.lastIndexOf('['), before.lastIndexOf('('));
  return open >= 0 && before.slice(open).includes(',');
}

/** Majority MC version across jars' declared Minecraft ranges, or null. */
export function inferMcVersion(jars: readonly JarRecord[], loader: LoaderKind | null = null): string | null {
  const ranges = jars.map((j) =>
    j.mods.flatMap((m) => (m.mcRange && (loader === null || entryRelevant(loader, null, j, m)) ? [m.mcRange] : [])),
  );
  const mentions = new Map<string, { all: number; lower: number }>();
  for (const list of ranges) {
    for (const r of list) {
      for (const raw of r.raw) {
        for (const m of raw.matchAll(VERSION_TOKEN)) {
          const token = m[0];
          if (versionApi.normalizeMinecraft(token) === null) continue;
          const stat = mentions.get(token) ?? { all: 0, lower: 0 };
          stat.all++;
          if (!isUpperBound(raw, m.index ?? 0, r.syntax)) stat.lower++;
          mentions.set(token, stat);
        }
      }
    }
  }
  let best: { token: string; score: number; all: number; lower: number } | null = null;
  for (const [token, stat] of [...mentions].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const score = ranges.filter((list) => list.some((r) => versionApi.satisfies(token, r, 'minecraft') === true)).length;
    if (score === 0) continue;
    const cand = { token, score, all: stat.all, lower: stat.lower };
    if (
      best === null ||
      cand.score > best.score ||
      (cand.score === best.score &&
        (cand.all > best.all ||
          (cand.all === best.all &&
            (cand.lower > best.lower ||
              (cand.lower === best.lower && versionApi.compare(token, best.token, 'fabric', 'minecraft') > 0)))))
    ) {
      best = cand;
    }
  }
  return best?.token ?? null;
}

/** Majority loader across jars' metadata entries, or null when no jar declares a loader. */
export function inferLoaderKind(jars: readonly JarRecord[], mc: string | null): LoaderKind | null {
  let best: LoaderKind | null = null;
  let bestScore = 0;
  let bestNative = 0;
  for (const kind of LOADER_ORDER) {
    let score = 0;
    let native = 0;
    for (const j of jars) {
      const mods = j.mods.filter((m) => m.loader !== 'unknown');
      if (mods.length === 0) continue;
      if (mods.some((m) => entryRelevant(kind, mc, j, m))) score++;
      if (mods.some((m) => m.loader === kind)) native++;
    }
    if (score === 0) continue;
    if (score > bestScore || (score === bestScore && native > bestNative)) {
      best = kind;
      bestScore = score;
      bestNative = native;
    }
  }
  return best;
}

export function resolvePackImpl(instance: Instance, scan: ScanResult, override?: PackOverride | null): PackContext {
  const ov = override ?? null;
  const metaSource: 'launcher' | 'mrpack' | null =
    instance.metadataSource === 'launcher' ? 'launcher' : instance.metadataSource === 'mrpack' ? 'mrpack' : null;

  let jars: JarRecord[] | null = null;
  const tops = (): JarRecord[] => (jars ??= safe(() => activeTopLevel(scan), []));

  // Known MC version (override / metadata), used by loader inference.
  let mcVersion: string | null = null;
  let mcFrom: PackContext['source'] = 'unknown';
  if (ov?.mcVersion) {
    mcVersion = ov.mcVersion;
    mcFrom = 'override';
  } else if (metaSource && instance.mcVersion) {
    mcVersion = instance.mcVersion;
    mcFrom = metaSource;
  }

  let loader: LoaderInfo | null = null;
  let loaderFrom: PackContext['source'] = 'unknown';
  if (ov?.loader) {
    loader = ov.loader;
    loaderFrom = 'override';
  } else if (metaSource) {
    loader = instance.loader;
    loaderFrom = metaSource;
  } else {
    const kind = safe(() => inferLoaderKind(tops(), mcVersion), null);
    if (kind !== null) {
      loader = { kind, version: null };
      loaderFrom = 'majority';
    }
  }

  if (mcVersion === null) {
    const kind = loader?.kind ?? null;
    mcVersion = safe(() => inferMcVersion(tops(), kind === 'unknown' ? null : kind), null);
    if (mcVersion !== null) mcFrom = 'majority';
  }

  const rank: readonly PackContext['source'][] = ['override', 'launcher', 'mrpack', 'majority', 'unknown'];
  const source = rank.find((s) => s === mcFrom || s === loaderFrom) ?? 'unknown';
  return { mcVersion, loader, side: ov?.side ?? instance.side, source };
}

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}
