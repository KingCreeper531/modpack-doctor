/**
 * Duplicate mod ids among active top-level jars, and which copies the loader drops. Computed once
 * per input in checks/context.ts; E-DUP-ID reports every group, and the *dropped* copies are
 * excluded from every other check (they are never loaded).
 *
 * Grouping: jars sharing exactly the same set of duplicated (relevant) mod ids form one group.
 * Mode (docs/research/loader-enforcement.md):
 * - `fml-grouped` — modern FML (Forge on MC ≥ 1.13 or unknown, NeoForge) when every jar's first
 *   relevant mod id is the same: `UniqueModListBuilder` keeps the newest file, drops the rest.
 * - `fabric` — Fabric keeps one mod per id, newest preferred (best effort): the rest are dropped.
 * - `error` — Quilt, legacy FML, unknown loader, or an FML id that is a secondary mod in some file:
 *   the loader refuses to start; nothing is dropped.
 * Ranking (newest first): version of the group's rank id (`versionApi.compare`, Maven order for
 * Forge-family entries, Fabric order otherwise); a version that is an unresolved placeholder
 * (contains `${`) or FML's `0.0NONE` ranks lowest; then most recently modified; then jar id.
 */
import type { JarRecord, ModMeta } from '../../bindings';
import type { PackContext } from '../model';
import { mcCompare, versionSyntaxFor } from '../pack';
import { versionApi } from '../version';

export type DupMode = 'fml-grouped' | 'fabric' | 'error';

export interface DupGroup {
  /** Ranked: newest (kept) first. */
  jars: JarRecord[];
  /** Duplicated mod ids, sorted. */
  ids: string[];
  mode: DupMode;
  /** The id whose versions rank the copies (FML: the shared first mod id). */
  rankId: string;
  /** Copies the loader drops (empty in `error` mode). */
  dropped: JarRecord[];
}

/** FML substitutes `0.0NONE` for an unresolved `${file.jarVersion}`. */
export function isPlaceholderVersion(version: string): boolean {
  return version.includes('${') || version.trim() === '0.0NONE';
}

function cmpId(a: JarRecord, b: JarRecord): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function duplicateGroups(topLevel: readonly JarRecord[], relevant: (jar: JarRecord) => ModMeta[], pack: PackContext): DupGroup[] {
  const owners = new Map<string, JarRecord[]>();
  for (const jar of topLevel) {
    for (const id of new Set(relevant(jar).map((m) => m.modId))) {
      const list = owners.get(id) ?? [];
      list.push(jar);
      owners.set(id, list);
    }
  }
  const sets = new Map<string, { jars: JarRecord[]; ids: string[] }>();
  for (const [id, jars] of owners) {
    if (jars.length < 2) continue;
    const key = jars.map((j) => j.id).sort().join('\n');
    const entry = sets.get(key) ?? { jars, ids: [] };
    entry.ids.push(id);
    sets.set(key, entry);
  }

  const kind = pack.loader?.kind;
  // Modern FML only: legacy FML (MC < 1.13) throws DuplicateModsFoundException for any duplicate.
  const legacy = kind === 'forge' && (mcCompare(pack.mcVersion, '1.13') ?? 0) < 0;
  const fml = (kind === 'forge' && !legacy) || kind === 'neoforge';
  const out: DupGroup[] = [];
  for (const { jars, ids } of sets.values()) {
    ids.sort();
    const firstIds = jars.map((j) => relevant(j)[0]?.modId);
    const groupId = firstIds[0];
    const grouped = fml && groupId !== undefined && ids.includes(groupId) && firstIds.every((f) => f === groupId);
    const mode: DupMode = grouped ? 'fml-grouped' : kind === 'fabric' ? 'fabric' : 'error';
    const rankId = grouped && groupId !== undefined ? groupId : (ids[0] ?? '');
    const metaOf = (j: JarRecord): ModMeta | undefined => relevant(j).find((m) => m.modId === rankId);
    const ranked = [...jars].sort((a, b) => {
      const ma = metaOf(a);
      const mb = metaOf(b);
      let byVersion = 0;
      if (ma && mb) {
        const pa = isPlaceholderVersion(ma.version);
        const pb = isPlaceholderVersion(mb.version);
        byVersion = pa !== pb ? (pa ? 1 : -1) : pa ? 0 : versionApi.compare(mb.version, ma.version, versionSyntaxFor(ma.loader), 'other');
      }
      return byVersion || b.mtimeMs - a.mtimeMs || cmpId(a, b);
    });
    out.push({ jars: ranked, ids, mode, rankId, dropped: mode === 'error' ? [] : ranked.slice(1) });
  }
  return out.sort((a, b) => cmpId(a.jars[0] as JarRecord, b.jars[0] as JarRecord));
}
