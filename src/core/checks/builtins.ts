/**
 * Dependency ids satisfied by the game, the JVM or the loader itself — never by a jar in the pack.
 * Matched case-insensitively (pre-1.13 `mcmod.info` uses `Forge` / `FML`).
 *
 * Deliberately NOT built in:
 * - `fabric`: the legacy id of Fabric API (modern Fabric API `provides` it). Treating it as
 *   built-in would hide a missing Fabric API for older mods.
 * - `fabric-api`, `kotlinforforge`, `architectury`, … : ordinary mods.
 * - `mixinextras` on Forge/NeoForge: mods ship it via JarJar, so a nested copy (which counts as
 *   present) is expected there. See `isBuiltinDependency` for Fabric/Quilt.
 */
import type { PackContext } from '../model';
import { versionApi } from '../version';

export const BUILTIN_DEPENDENCIES: Readonly<Record<string, string>> = {
  minecraft: 'the game itself',
  java: 'the Java runtime (Fabric/Quilt built-in mod)',
  forge: 'the Forge loader mod',
  neoforge: 'the NeoForge loader mod',
  fml: 'Forge Mod Loader (pre-1.13 built-in mod)',
  mcp: 'MCP mappings (pre-1.13 Forge built-in mod)',
  javafml: 'FML Java language provider',
  lowcodefml: 'FML low-code language provider',
  fabricloader: 'Fabric Loader',
  'fabric-loader': 'Fabric Loader (alias)',
  quilt_loader: 'Quilt Loader',
  'quilt-loader': 'Quilt Loader (alias)',
};

/**
 * MixinExtras ships inside Fabric Loader since 0.15.0 (mod id `mixinextras`) and inside Quilt
 * Loader since 0.23.0. With an unknown loader version we assume a modern loader.
 */
const MIXINEXTRAS_SINCE: Readonly<Partial<Record<string, string>>> = { fabric: '0.15.0', quilt: '0.23.0' };

export function isBuiltinDependency(modId: string, pack: PackContext): boolean {
  const id = modId.toLowerCase();
  if (Object.hasOwn(BUILTIN_DEPENDENCIES, id)) return true;
  if (id === 'mixinextras' && pack.loader) {
    const since = MIXINEXTRAS_SINCE[pack.loader.kind];
    if (since === undefined) return false;
    const v = pack.loader.version;
    return v === null || versionApi.compare(v, since, 'fabric', 'other') >= 0;
  }
  return false;
}
