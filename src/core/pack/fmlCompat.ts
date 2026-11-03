/**
 * FML `VersionSupportMatrix` (docs/research/loader-enforcement.md) and the range verdict shared
 * by E-MC-RANGE, E-LOADER-RANGE and E-DEP-RANGE.
 *
 * FML (`ModSorter.verifyDependencyVersions`) first checks a dependency with plain Maven
 * `VersionRange.containsVersion`. When that fails, the range still passes if it contains one of
 * the fallback versions listed for the running loader + Minecraft version:
 *
 * | Loader / MC              | `minecraft` also accepts | loader mod also accepts    |
 * |--------------------------|--------------------------|----------------------------|
 * | NeoForge, MC 1.21.1      | `1.21`                   | `neoforge` `21.0.166`      |
 * | NeoForge, MC 1.21.8      | `1.21.7`                 | `neoforge` `21.7.26-beta`  |
 * | Forge, MC 1.20.1         | —                        | `forge` `47.1.79`          |
 *
 * Everything else (NeoForge 20.x, 21.0, 21.2–21.5, other Forge versions, `loaderVersion`) is
 * strict. Fabric/Quilt have no such table: their ranges (Fabric syntax) are always strict.
 *
 * Known simplification: the Forge row is applied to every Forge 1.20.1 pack, although the table
 * entry only exists in later 47.x builds.
 */
import type { LoaderKind, RawRange } from '../../bindings';
import type { VersionSubject } from '../model';
import { versionApi } from '../version';
import { LOADER_NAMES, mcIs } from './loaders';

interface MatrixRow {
  loader: LoaderKind;
  mc: string;
  /** dependency mod id → fallback versions. */
  fallbacks: Readonly<Record<string, readonly string[]>>;
}

export const FML_VERSION_SUPPORT_MATRIX: readonly MatrixRow[] = [
  { loader: 'neoforge', mc: '1.21.1', fallbacks: { minecraft: ['1.21'], neoforge: ['21.0.166'] } },
  { loader: 'neoforge', mc: '1.21.8', fallbacks: { minecraft: ['1.21.7'], neoforge: ['21.7.26-beta'] } },
  { loader: 'forge', mc: '1.20.1', fallbacks: { forge: ['47.1.79'] } },
];

/** Fallback versions FML also accepts for a dependency on `depId` in this pack. */
export function fmlFallbacks(loader: LoaderKind | null | undefined, mc: string | null, depId: string): readonly string[] {
  if (!loader || mc === null) return [];
  const row = FML_VERSION_SUPPORT_MATRIX.find((r) => r.loader === loader && mcIs(mc, r.mc));
  return row?.fallbacks[depId] ?? [];
}

export type RangeVerdict =
  /** The actual version is in range. */
  | { kind: 'pass' }
  /** Out of range, but FML accepts it through the compatibility table. */
  | { kind: 'fallback'; fallback: string; loader: LoaderKind; mc: string }
  /** The loader refuses it. */
  | { kind: 'fail' }
  /** Unknown (unparseable range or version): never reported. */
  | { kind: 'unknown' };

/**
 * How the pack's loader treats `actual` against `range` for a dependency on `depId`.
 * Fallbacks apply only to Maven (FML) ranges, and only for the pack's own loader + MC row.
 */
export function evaluateRange(
  actual: string,
  range: RawRange,
  subject: VersionSubject,
  depId: string,
  pack: { loader: LoaderKind | null | undefined; mc: string | null },
): RangeVerdict {
  const plain = versionApi.satisfies(actual, range, subject);
  if (plain === null) return { kind: 'unknown' };
  if (plain) return { kind: 'pass' };
  if (range.syntax !== 'maven' || !pack.loader || pack.mc === null) return { kind: 'fail' };
  for (const fallback of fmlFallbacks(pack.loader, pack.mc, depId)) {
    if (versionApi.satisfies(fallback, range, subject) === true) return { kind: 'fallback', fallback, loader: pack.loader, mc: pack.mc };
  }
  return { kind: 'fail' };
}

/** "NeoForge's compatibility override for 1.21 mods on 1.21.1". */
export function describeFallback(v: Extract<RangeVerdict, { kind: 'fallback' }>, depId: string): string {
  const what = depId === 'minecraft' ? `${v.fallback} mods` : `mods built for ${LOADER_NAMES[v.loader]} ${v.fallback}`;
  return `${LOADER_NAMES[v.loader]}'s compatibility override for ${what} on ${v.mc}`;
}
