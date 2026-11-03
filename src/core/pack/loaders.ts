/**
 * Loader compatibility rules shared by `resolvePack` and the static checks.
 *
 * A jar can carry several metadata entries (`ModMeta`), each tagged with the loader it belongs to.
 * Whether an entry is loaded by the pack's loader is decided here, in one place:
 *
 * - Same loader → yes. An `unknown` pack loader or entry loader → yes (we cannot tell).
 * - Quilt runs Fabric mods → a Quilt pack accepts `fabric` entries. Fabric does not run Quilt mods.
 * - NeoForge for 1.20.1 is a fork of Forge 47.x (CONTRACTS invariant 12) → on MC 1.20.1 a Forge
 *   pack accepts `neoforge` entries and a NeoForge pack accepts `forge` entries, both ways.
 * - NeoForge 1.20.2–1.20.4 still read `META-INF/mods.toml`. The scanner classifies a mods.toml entry
 *   with neither a `forge` nor a `neoforge` dependency as Forge, so on those versions a NeoForge
 *   pack accepts a `forge` entry that has no loader dependency (`loaderRange === null`).
 * - Legacy Forge (`mcmod.info`) entries load only before MC 1.13; modern `mods.toml` only from 1.13.
 * - When the pack's MC version is unknown, the MC-dependent cases above are accepted: a check
 *   reports only what it can be sure of.
 */
import type { LoaderKind, ModMeta } from '../../bindings';
import { versionApi } from '../version';

export const LOADER_NAMES: Readonly<Record<LoaderKind, string>> = {
  forge: 'Forge',
  neoforge: 'NeoForge',
  fabric: 'Fabric',
  quilt: 'Quilt',
  legacyforge: 'Legacy Forge',
  unknown: 'an unknown loader',
};

/** Loader-dependency mod id per loader kind (what `ModMeta.loaderRange` is the range of). */
export const LOADER_DEP_IDS: Readonly<Record<LoaderKind, readonly string[]>> = {
  forge: ['forge'],
  neoforge: ['neoforge'],
  fabric: ['fabricloader', 'fabric-loader'],
  quilt: ['quilt_loader', 'quilt-loader'],
  legacyforge: ['forge', 'Forge'],
  unknown: [],
};

/** Normalised MC version equals `target`. False when unknown. */
export function mcIs(mc: string | null, target: string): boolean {
  if (mc === null) return false;
  return versionApi.normalizeMinecraft(mc) === versionApi.normalizeMinecraft(target);
}

/**
 * Chronological comparison of the pack MC version with `target` (Fabric MC ordering).
 * null when the pack MC version is unknown or not a recognised Minecraft version.
 */
export function mcCompare(mc: string | null, target: string): number | null {
  if (mc === null || versionApi.normalizeMinecraft(mc) === null) return null;
  return versionApi.compare(mc, target, 'fabric', 'minecraft');
}

/** Whether a metadata entry is loaded by a pack running `packLoader` on `mc` (see file docs). */
export function loaderAccepts(
  packLoader: LoaderKind,
  mc: string | null,
  mod: Pick<ModMeta, 'loader' | 'loaderRange'>,
): boolean {
  const kind = mod.loader;
  if (packLoader === 'unknown' || kind === 'unknown' || kind === packLoader) return true;
  const before113 = (): boolean | null => {
    const c = mcCompare(mc, '1.13');
    return c === null ? null : c < 0;
  };
  switch (packLoader) {
    case 'quilt':
      return kind === 'fabric';
    case 'fabric':
      return false;
    case 'forge':
      if (kind === 'neoforge') return mc === null || mcIs(mc, '1.20.1');
      if (kind === 'legacyforge') return before113() !== false;
      return false;
    case 'neoforge': {
      if (kind !== 'forge') return false;
      if (mc === null || mcIs(mc, '1.20.1')) return true;
      if (mod.loaderRange === null) {
        const lo = mcCompare(mc, '1.20.2');
        const hi = mcCompare(mc, '1.20.5');
        return lo !== null && hi !== null && lo >= 0 && hi < 0;
      }
      return false;
    }
    case 'legacyforge':
      if (kind === 'forge') return before113() !== true;
      return false;
    default:
      return false;
  }
}

/** Range syntax a loader's mod versions are ordered with. */
export function versionSyntaxFor(kind: LoaderKind): 'maven' | 'fabric' {
  return kind === 'fabric' || kind === 'quilt' ? 'fabric' : 'maven';
}
