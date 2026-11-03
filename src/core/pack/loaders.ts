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
import type { JarRecord, LoaderKind, ModMeta } from '../../bindings';
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

export const NEOFORGE_TOML = 'META-INF/neoforge.mods.toml';
export const MODS_TOML = 'META-INF/mods.toml';
export const FABRIC_JSON = 'fabric.mod.json';
export const QUILT_JSON = 'quilt.mod.json';
export const MCMOD_INFO = 'mcmod.info';

/**
 * Metadata files the pack's loader actually reads from a jar that contains `present` files
 * (parsed or failed). null = every file (unknown loader).
 *
 * - NeoForge on MC ≥ 1.20.5 (incl. year-based 26.x): only `META-INF/neoforge.mods.toml` — a
 *   leftover `META-INF/mods.toml` (stale, empty, unexpanded template) is ignored by the loader.
 * - NeoForge 1.20.1–1.20.4: `META-INF/mods.toml` (`neoforge.mods.toml` did not exist yet).
 * - NeoForge with an unknown MC version: both FML files (we cannot tell).
 * - Forge: `META-INF/mods.toml` (+ `mcmod.info`, whose entries `loaderAccepts` limits to < 1.13).
 *   Forge never reads `neoforge.mods.toml`.
 * - Legacy Forge: `mcmod.info` and `META-INF/mods.toml` (the MC version decides via `loaderAccepts`).
 * - Fabric: `fabric.mod.json`. Quilt: `quilt.mod.json` when the jar has one, else `fabric.mod.json`.
 */
export function metadataFilesRead(packLoader: LoaderKind, mc: string | null, present: readonly string[]): ReadonlySet<string> | null {
  switch (packLoader) {
    case 'neoforge': {
      const c = mcCompare(mc, '1.20.5');
      if (c === null) return new Set([NEOFORGE_TOML, MODS_TOML]);
      return new Set([c >= 0 ? NEOFORGE_TOML : MODS_TOML]);
    }
    case 'forge':
      return new Set([MODS_TOML, MCMOD_INFO]);
    case 'legacyforge':
      return new Set([MCMOD_INFO, MODS_TOML]);
    case 'fabric':
      return new Set([FABRIC_JSON]);
    case 'quilt':
      return new Set([present.includes(QUILT_JSON) ? QUILT_JSON : FABRIC_JSON]);
    default:
      return null;
  }
}

/** Metadata files present in a jar: parsed entries plus files that failed to parse. */
export function presentMetadataFiles(jar: Pick<JarRecord, 'mods' | 'metadataErrors'>): string[] {
  return [...new Set([...jar.mods.map((m) => m.metadataFile), ...(jar.metadataErrors ?? []).map((e) => e.file)])];
}

/** Whether the pack's loader reads `file` from `jar`. */
export function loaderReadsFile(packLoader: LoaderKind, mc: string | null, jar: Pick<JarRecord, 'mods' | 'metadataErrors'>, file: string): boolean {
  const read = metadataFilesRead(packLoader, mc, presentMetadataFiles(jar));
  return read === null || read.has(file);
}

/**
 * The single relevance rule every check uses: the entry comes from a file the pack's loader
 * reads (`metadataFilesRead`) and targets a loader it runs (`loaderAccepts`).
 */
export function entryRelevant(packLoader: LoaderKind, mc: string | null, jar: Pick<JarRecord, 'mods' | 'metadataErrors'>, mod: ModMeta): boolean {
  return loaderReadsFile(packLoader, mc, jar, mod.metadataFile) && loaderAccepts(packLoader, mc, mod);
}

/** Range syntax a loader's mod versions are ordered with. */
export function versionSyntaxFor(kind: LoaderKind): 'maven' | 'fabric' {
  return kind === 'fabric' || kind === 'quilt' ? 'fabric' : 'maven';
}
