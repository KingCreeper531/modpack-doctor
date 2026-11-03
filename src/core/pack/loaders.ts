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
 * - Otherwise a Forge entry is accepted by NeoForge (and a NeoForge entry by Forge) unless it has a
 *   *required* dependency on its own loader id: FML reads the toml and loads any mod whose
 *   required dependencies it can satisfy. The scanner classifies a mods.toml entry with any
 *   `neoforge` dependency as NeoForge, so multi-loader jars declaring `forge` and `neoforge` as
 *   optional (Incendium, Nullscape) load on Forge 1.20.4. Which file is read (`mods.toml` vs
 *   `neoforge.mods.toml`) is decided separately by `metadataFilesRead`; a required other-loader
 *   dependency in a read file is E-WRONG-LOADER's error case.
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

function requires(mod: Pick<ModMeta, 'deps'>, id: string): boolean {
  return (mod.deps ?? []).some((d) => d.modId === id && d.kind === 'required');
}

/** Whether a metadata entry is loaded by a pack running `packLoader` on `mc` (see file docs). */
export function loaderAccepts(
  packLoader: LoaderKind,
  mc: string | null,
  mod: Pick<ModMeta, 'loader' | 'loaderRange' | 'deps'>,
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
      if (kind === 'neoforge') return mc === null || mcIs(mc, '1.20.1') || !requires(mod, 'neoforge');
      if (kind === 'legacyforge') return before113() !== false;
      return false;
    case 'neoforge': {
      if (kind !== 'forge') return false;
      return mc === null || mcIs(mc, '1.20.1') || !requires(mod, 'forge');
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
 * - Forge on MC ≥ 1.13: `META-INF/mods.toml`. Forge never reads `neoforge.mods.toml`.
 * - Legacy FML (Forge on MC < 1.13, or a `legacyforge` pack): only `mcmod.info`. A 1.13+
 *   `mods.toml` is never read there (FML finds the `@Mod` class and rejects it as wrong-MC).
 * - Forge with an unknown MC version: `mods.toml` and `mcmod.info` (we cannot tell).
 * - Fabric: `fabric.mod.json`. Quilt: `quilt.mod.json` when the jar has one, else `fabric.mod.json`.
 */
export function metadataFilesRead(packLoader: LoaderKind, mc: string | null, present: readonly string[]): ReadonlySet<string> | null {
  switch (packLoader) {
    case 'neoforge': {
      const c = mcCompare(mc, '1.20.5');
      if (c === null) return new Set([NEOFORGE_TOML, MODS_TOML]);
      return new Set([c >= 0 ? NEOFORGE_TOML : MODS_TOML]);
    }
    case 'forge': {
      const c = mcCompare(mc, '1.13');
      if (c === null) return new Set([MODS_TOML, MCMOD_INFO]);
      return new Set([c < 0 ? MCMOD_INFO : MODS_TOML]);
    }
    case 'legacyforge':
      return new Set([MCMOD_INFO]);
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

/**
 * How FML treats jars whose metadata it doesn't read (docs/research/loader-enforcement.md, third
 * round):
 * - `legacy`: Forge on MC < 1.13 / Legacy Forge — non-mod jars go on the classpath (loaded).
 * - `silent`: modern Forge (all 1.13+ versions), NeoForge before MC 1.20.6 — ignored silently
 *   (DEBUG log).
 * - `warn`: NeoForge on MC 1.20.6+ (incl. 21.x, 26.x) — skipped and listed on the "Warnings
 *   while loading mods" screen (`brokenfile.*`). The switch happened at FML 3.0.19, somewhere
 *   inside 1.20.6; all 1.20.6 builds are treated as `warn`. NeoForge with an unknown MC version is
 *   also `warn` (every current NeoForge line).
 * - null: not an FML pack.
 */
export type FmlEra = 'legacy' | 'silent' | 'warn';

export function fmlEra(kind: LoaderKind | null | undefined, mc: string | null): FmlEra | null {
  if (kind === 'legacyforge') return 'legacy';
  if (kind === 'forge') return (mcCompare(mc, '1.13') ?? 0) < 0 ? 'legacy' : 'silent';
  if (kind === 'neoforge') return (mcCompare(mc, '1.20.6') ?? 0) >= 0 ? 'warn' : 'silent';
  return null;
}

/**
 * Whether modern FML loads a jar without mods metadata through its MANIFEST `FMLModType`:
 * MOD / GAMELIBRARY / LIBRARY, plus LANGPROVIDER on Forge (NeoForge 21.x skips it as unknown).
 */
export function fmlLoadsModType(kind: LoaderKind | null | undefined, fmlModType: string | null | undefined): boolean {
  const t = fmlModType?.trim().toUpperCase();
  if (!t) return false;
  if (t === 'MOD' || t === 'GAMELIBRARY' || t === 'LIBRARY') return true;
  return t === 'LANGPROVIDER' && kind === 'forge';
}

/**
 * Whether a top-level jar with no relevant metadata entry is still loaded by the pack's loader:
 * legacy FML → yes (classpath), unless it only has 1.13+ FML metadata; modern FML → only through a
 * recognised `FMLModType` (assumed for container jars with nested jars, and when `fmlModType` is
 * absent from the record — older scans);
 * Fabric/Quilt → no (ignored); unknown loader → only when it has no metadata at all.
 */
export function metadataLessJarLoaded(
  kind: LoaderKind | null | undefined,
  mc: string | null,
  jar: Pick<JarRecord, 'mods' | 'fmlModType' | 'nested'>,
): boolean {
  const era = fmlEra(kind, mc);
  // Legacy classpath; a jar with 1.13+ FML metadata is either refused (wrong MC) or a real legacy
  // mod we cannot see (its @Mod class) — either way we don't model it as loaded.
  if (era === 'legacy') return !jar.mods.some((m) => m.metadataFile === MODS_TOML || m.metadataFile === NEOFORGE_TOML);
  if (era !== null) {
    // `undefined` = scanned before the field existed (unknown): benefit of the doubt. A container
    // jar with nested jars (kotlinforforge, connector) is only useful with an FMLModType.
    if (jar.fmlModType === undefined || jar.nested.length > 0) return true;
    return fmlLoadsModType(kind, jar.fmlModType);
  }
  if (kind === 'fabric' || kind === 'quilt') return false;
  return jar.mods.length === 0;
}

/** Range syntax a loader's mod versions are ordered with. */
export function versionSyntaxFor(kind: LoaderKind): 'maven' | 'fabric' {
  return kind === 'fabric' || kind === 'quilt' ? 'fabric' : 'maven';
}
