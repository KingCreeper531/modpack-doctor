/** JarIndex lookups used by the crash patterns. All results are active jars from the index. */
import type { JarRecord } from '../../bindings';
import type { JarIndex, JarRef } from '../model';

/** The top-level jar a (possibly nested) jar ships in: what the user can disable. */
export function topLevel(jar: JarRecord, index: JarIndex): JarRecord {
  let cur = jar;
  for (let guard = 0; cur.parentId && guard < 16; guard++) {
    const parent = index.byId.get(cur.parentId);
    if (!parent) break;
    cur = parent;
  }
  return cur;
}

/** Display name of a jar: the first mod's name, else its mod id, else the file name. */
export function jarLabel(jar: JarRecord, modId?: string): string {
  const mod = (modId ? jar.mods.find((m) => m.modId === modId) : undefined) ?? jar.mods[0];
  if (mod?.name) return mod.name;
  return mod?.modId ?? jar.fileName;
}

/** JarRef for the top-level jar; `modId` defaults to that jar's first mod. */
export function jarRef(jar: JarRecord, index: JarIndex, modId?: string): JarRef {
  const top = topLevel(jar, index);
  const id = modId ?? top.mods[0]?.modId;
  return id ? { jarId: top.id, fileName: top.fileName, modId: id } : { jarId: top.id, fileName: top.fileName };
}

/** Unique top-level jars, preserving order. */
export function uniqueTopLevel(jars: readonly JarRecord[], index: JarIndex): JarRecord[] {
  const seen = new Set<string>();
  const out: JarRecord[] = [];
  for (const j of jars) {
    const top = topLevel(j, index);
    if (!seen.has(top.id)) {
      seen.add(top.id);
      out.push(top);
    }
  }
  return out;
}

/** Jars declaring (or providing) a mod id; top-level declarations first. */
export function jarsForModId(modId: string, index: JarIndex): JarRecord[] {
  const list = index.byModId.get(modId) ?? index.byModId.get(modId.toLowerCase()) ?? [];
  return [...list].sort((a, b) => a.depth - b.depth);
}

export function jarByFileName(name: string, index: JarIndex): JarRecord | undefined {
  const direct = index.byFileName.get(name);
  if (direct) return direct;
  for (const jar of index.byId.values()) if (jar.fileName === name) return jar;
  return undefined;
}

/**
 * Jars whose own classes contain `pkg` (top-level owners first, then any depth). With
 * `prefix`, falls back to the longest parent package with at least three segments.
 */
export function jarsForPackage(pkg: string, index: JarIndex, prefix = false): JarRecord[] {
  let p = pkg;
  for (;;) {
    const top = index.byPackage.get(p);
    if (top && top.length > 0) return [...top];
    const nested = index.byPackageAnyDepth.get(p);
    if (nested && nested.length > 0) return [...nested];
    if (!prefix) return [];
    const cut = p.lastIndexOf('.');
    if (cut < 0) return [];
    p = p.slice(0, cut);
    if (p.split('.').length < 3) return [];
  }
}

/** JDK automatic-module name derived from a jar file name (ModuleFinder rules). */
export function automaticModuleName(fileName: string): string {
  let name = fileName.replace(/\.jar$/i, '');
  const version = /-(\d+(\.|$))/.exec(name);
  if (version) name = name.slice(0, version.index);
  return name
    .replace(/[^A-Za-z0-9]/g, '.')
    .replace(/\.{2,}/g, '.')
    .replace(/^\.+|\.+$/g, '');
}

/** Jars for a JPMS module name: mod id (FML names mod modules after the first mod id) or automatic name. */
export function jarsForModule(name: string, index: JarIndex): JarRecord[] {
  const byMod = jarsForModId(name, index);
  if (byMod.length > 0) return byMod;
  const out: JarRecord[] = [];
  for (const jar of index.byId.values()) {
    if (automaticModuleName(jar.fileName) === name) out.push(jar);
  }
  return out.sort((a, b) => a.depth - b.depth);
}

/** Jars whose mod display name or id equals `name` (Quilt messages use display names). */
export function jarsForModName(name: string, index: JarIndex): JarRecord[] {
  // Loose comparison: "Lumen Lanterns" matches the id `lumenlanterns` and the name "Lumen lanterns".
  const loose = (t: string): string => t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  const wanted = loose(name);
  const out: JarRecord[] = [];
  if (!wanted) return out;
  for (const jar of index.byId.values()) {
    if (jar.mods.some((m) => (m.name !== null && loose(m.name) === wanted) || loose(m.modId) === wanted)) out.push(jar);
  }
  return out.sort((a, b) => a.depth - b.depth);
}
