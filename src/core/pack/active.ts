import type { JarRecord } from '../../bindings';

/**
 * A jar is *active* when the game would load it:
 * - it is not disabled (`*.jar.disabled`),
 * - its status is `ok`, or `corrupt` with at least one parsed metadata entry (one metadata file
 *   was invalid but another parsed, so the loader still sees a mod), and
 * - for a nested jar, its parent (and so every ancestor) is active.
 *
 * Unreadable jars and corrupt jars without metadata are inactive (W-CORRUPT-JAR reports them).
 */
export function isActive(jar: JarRecord, byId: ReadonlyMap<string, JarRecord>): boolean {
  const seen = new Set<string>();
  let cur: JarRecord | undefined = jar;
  while (cur) {
    if (seen.has(cur.id)) return false;
    seen.add(cur.id);
    if (!selfActive(cur)) return false;
    if (cur.parentId === null) return true;
    cur = byId.get(cur.parentId);
  }
  // A nested jar whose parent record is missing: treat as inactive (orphan).
  return false;
}

function selfActive(jar: JarRecord): boolean {
  if (jar.disabled) return false;
  if (jar.status.state === 'ok') return true;
  return jar.status.state === 'corrupt' && jar.mods.length > 0;
}

/** Whether the jar or any ancestor is disabled (it is then excluded from every check). */
export function isDisabledChain(jar: JarRecord, byId: ReadonlyMap<string, JarRecord>): boolean {
  const seen = new Set<string>();
  let cur: JarRecord | undefined = jar;
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    if (cur.disabled) return true;
    cur = cur.parentId === null ? undefined : byId.get(cur.parentId);
  }
  return false;
}

/** Top-level ancestor (the jar itself at depth 0). Falls back to the jar for orphans. */
export function topLevelOf(jar: JarRecord, byId: ReadonlyMap<string, JarRecord>): JarRecord {
  const seen = new Set<string>();
  let cur = jar;
  while (cur.parentId !== null && !seen.has(cur.id)) {
    seen.add(cur.id);
    const parent = byId.get(cur.parentId);
    if (!parent) break;
    cur = parent;
  }
  return cur;
}
