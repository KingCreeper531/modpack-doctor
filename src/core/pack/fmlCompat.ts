/**
 * FML `VersionSupportMatrix` (docs/research/loader-enforcement.md, incl. the M3 smoke-scan
 * follow-up) and the range verdict shared by E-MC-RANGE, E-LOADER-RANGE and E-DEP-RANGE.
 *
 * FML (`ModSorter.verifyDependencyVersions`) first checks a dependency with plain Maven
 * `VersionRange.containsVersion`. When that fails, the range still passes if it contains one of
 * the fallback versions listed for the running loader + Minecraft version:
 *
 * | Loader / MC                         | `minecraft` also accepts | loader mod also accepts        |
 * |-------------------------------------|--------------------------|--------------------------------|
 * | Forge, MC 1.16.4–1.16.5 (35.x/36.x) | `1.16.3`, `1.16.4`       | `forge` `34.1.42`, `35.1.37`   |
 * | Forge, MC 1.19.2                    | `1.19.1`                 | `forge` `42.0.9`               |
 * | Forge, MC 1.20.1, Forge ≥ 47.2.16   | —                        | `forge` `47.1.79`              |
 * | NeoForge, MC 1.21.1                 | `1.21`                   | `neoforge` `21.0.166`          |
 * | NeoForge, MC 1.21.8                 | `1.21.7`                 | `neoforge` `21.7.26-beta`      |
 *
 * Strict (no rows): Forge 1.17/1.18, Forge 1.19.3–1.20.4 except 1.20.1, Forge 1.20.1 before
 * 47.2.16, NeoForge 47.1 / 20.x / 21.0 / 21.3–21.5. `loaderVersion` (javafml `34`/`35`/`42`
 * entries) is never compared by the checks. Fabric/Quilt have no table: their ranges (Fabric
 * syntax) are always strict — including Fabric mods loaded through Sinytra Connector.
 *
 * A row gated on a loader version (`minLoaderVersion`) is applied when the installed version is
 * unknown (benefit of the doubt); the verdict then carries `assumed: true` so findings can say so.
 */
import type { LoaderKind, RawRange } from '../../bindings';
import type { VersionSubject } from '../model';
import { versionApi } from '../version';
import { LOADER_NAMES, mcIs } from './loaders';

export interface MatrixRow {
  loader: LoaderKind;
  /** MC versions on which the row is active. */
  mcs: readonly string[];
  /** Row exists only from this loader version on (Maven order). */
  minLoaderVersion?: string;
  /** dependency mod id → fallback versions. */
  fallbacks: Readonly<Record<string, readonly string[]>>;
}

export const FML_VERSION_SUPPORT_MATRIX: readonly MatrixRow[] = [
  { loader: 'forge', mcs: ['1.16.4', '1.16.5'], fallbacks: { minecraft: ['1.16.3', '1.16.4'], forge: ['34.1.42', '35.1.37'] } },
  { loader: 'forge', mcs: ['1.19.2'], fallbacks: { minecraft: ['1.19.1'], forge: ['42.0.9'] } },
  { loader: 'forge', mcs: ['1.20.1'], minLoaderVersion: '47.2.16', fallbacks: { forge: ['47.1.79'] } },
  { loader: 'neoforge', mcs: ['1.21.1'], fallbacks: { minecraft: ['1.21'], neoforge: ['21.0.166'] } },
  { loader: 'neoforge', mcs: ['1.21.8'], fallbacks: { minecraft: ['1.21.7'], neoforge: ['21.7.26-beta'] } },
];

export interface PackLoaderInfo {
  loader: LoaderKind | null | undefined;
  mc: string | null;
  /** Installed loader version; null/undefined = unknown. */
  loaderVersion?: string | null;
}

interface ActiveRow {
  row: MatrixRow;
  /** Gated row applied because the loader version is unknown. */
  assumed: boolean;
}

function activeRow(pack: PackLoaderInfo): ActiveRow | null {
  if (!pack.loader || pack.mc === null) return null;
  const mc = pack.mc;
  const row = FML_VERSION_SUPPORT_MATRIX.find((r) => r.loader === pack.loader && r.mcs.some((m) => mcIs(mc, m)));
  if (!row) return null;
  if (row.minLoaderVersion === undefined) return { row, assumed: false };
  const v = pack.loaderVersion;
  if (!v) return { row, assumed: true };
  return versionApi.compare(v, row.minLoaderVersion, 'maven', 'other') >= 0 ? { row, assumed: false } : null;
}

/** Fallback versions FML also accepts for a dependency on `depId` in this pack. */
export function fmlFallbacks(
  loader: LoaderKind | null | undefined,
  mc: string | null,
  depId: string,
  loaderVersion: string | null = null,
): readonly string[] {
  return activeRow({ loader, mc, loaderVersion })?.row.fallbacks[depId] ?? [];
}

export type RangeVerdict =
  /** The actual version is in range. */
  | { kind: 'pass' }
  /** Out of range, but FML accepts it through the compatibility table. */
  | { kind: 'fallback'; fallback: string; loader: LoaderKind; mc: string; assumed: boolean; minLoaderVersion?: string }
  /** The loader refuses it. */
  | { kind: 'fail' }
  /** Unknown (unparseable range or version): never reported. */
  | { kind: 'unknown' };

/**
 * How the pack's loader treats `actual` against `range` for a dependency on `depId`.
 * Fallbacks apply only to Maven (FML) ranges, and only for the pack's own loader + MC row.
 */
export function evaluateRange(actual: string, range: RawRange, subject: VersionSubject, depId: string, pack: PackLoaderInfo): RangeVerdict {
  const plain = versionApi.satisfies(actual, range, subject);
  if (plain === null) return { kind: 'unknown' };
  if (plain) return { kind: 'pass' };
  if (range.syntax !== 'maven' || !pack.loader || pack.mc === null) return { kind: 'fail' };
  const active = activeRow(pack);
  if (!active) return { kind: 'fail' };
  for (const fallback of active.row.fallbacks[depId] ?? []) {
    if (versionApi.satisfies(fallback, range, subject) === true) {
      return {
        kind: 'fallback',
        fallback,
        loader: pack.loader,
        mc: pack.mc,
        assumed: active.assumed,
        ...(active.row.minLoaderVersion ? { minLoaderVersion: active.row.minLoaderVersion } : {}),
      };
    }
  }
  return { kind: 'fail' };
}

/** "NeoForge's compatibility override for 1.21 mods on 1.21.1". */
export function describeFallback(v: Extract<RangeVerdict, { kind: 'fallback' }>, depId: string): string {
  const what = depId === 'minecraft' ? `${v.fallback} mods` : `mods built for ${LOADER_NAMES[v.loader]} ${v.fallback}`;
  const text = `${LOADER_NAMES[v.loader]}'s compatibility override for ${what} on ${v.mc}`;
  return v.assumed && v.minLoaderVersion
    ? `${text} (assumed: the override exists from ${LOADER_NAMES[v.loader]} ${v.minLoaderVersion}, and the installed version is unknown)`
    : text;
}
