import type { JarRecord, ScanResult } from '../../bindings';
import type { JarIndex } from '../model';
import { isActive } from './active';

function push(map: Map<string, JarRecord[]>, key: string, jar: JarRecord): void {
  const list = map.get(key);
  if (!list) map.set(key, [jar]);
  else if (!list.includes(jar)) list.push(jar);
}

/** Top-level before nested, then by id: deterministic regardless of scan order. */
function byDepthThenId(a: JarRecord, b: JarRecord): number {
  return a.depth - b.depth || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/**
 * Lookup tables over active jars (`isActive`), as documented on `JarIndex`.
 *
 * - `byId`, `byModId`, `byPackageAnyDepth`, `byMixinConfig`: active jars at any depth.
 * - `byModId`: keyed by every `modId` and `provides` id of every metadata entry (all loaders —
 *   the index does not know the pack loader); a jar appears once per key even when several of its
 *   entries declare the id (Forge + NeoForge metadata in one jar). Every nested copy is listed:
 *   JarJar/JiJ de-duplication is a check concern (see checks/context.ts).
 * - `byPackage`: active top-level jars only, from their own classes.
 * - `byFileName`: top-level jars by actual file name. Per the field doc this includes disabled
 *   jars under their `x.jar.disabled` name (handy for mapping a file name back to a tile); every
 *   other table is active-only.
 * - Lists are ordered top-level first, then by jar id.
 */
export function buildJarIndexImpl(scan: ScanResult): JarIndex {
  const all = [...scan.jars].sort(byDepthThenId);
  const everything = new Map(all.map((j) => [j.id, j] as const));
  const byId = new Map<string, JarRecord>();
  const byModId = new Map<string, JarRecord[]>();
  const byPackage = new Map<string, JarRecord[]>();
  const byPackageAnyDepth = new Map<string, JarRecord[]>();
  const byMixinConfig = new Map<string, JarRecord[]>();
  const byFileName = new Map<string, JarRecord>();

  for (const jar of all) {
    if (jar.depth === 0 && jar.disabled && !byFileName.has(jar.fileName)) byFileName.set(jar.fileName, jar);
    if (!isActive(jar, everything)) continue;
    byId.set(jar.id, jar);
    for (const m of jar.mods) {
      push(byModId, m.modId, jar);
      for (const p of m.provides) push(byModId, p, jar);
    }
    for (const p of jar.packages) {
      push(byPackageAnyDepth, p, jar);
      if (jar.depth === 0) push(byPackage, p, jar);
    }
    for (const c of jar.mixinConfigs) push(byMixinConfig, c, jar);
    if (jar.depth === 0) byFileName.set(jar.fileName, jar);
  }
  return { byId, byModId, byPackage, byPackageAnyDepth, byMixinConfig, byFileName };
}
