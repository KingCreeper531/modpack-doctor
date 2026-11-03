/**
 * E-DUP-ID (error): two or more active top-level jars declare the same mod id (among the entries
 * the pack loader reads).
 * - Duplicates inside one jar (Forge + NeoForge metadata, or mods.toml + mcmod.info) are ignored.
 * - Nested jars are never compared: the loaders de-duplicate JarJar libraries by
 *   `group:artifact` and Fabric/Quilt JiJ by mod id, and a top-level copy overrides a nested one.
 * - Jars sharing several ids produce one finding listing every id.
 * - Fix: `removeDuplicate` keeping the newest copy — highest version of the first shared id by
 *   `versionApi.compare` (Maven order for Forge-family entries, Fabric order otherwise); ties →
 *   the most recently modified file, then the smallest jar id. One fix per extra copy.
 */
import type { FixAction, JarRecord, ModMeta } from '../../bindings';
import type { Check, Evidence, Finding } from '../model';
import { versionSyntaxFor } from '../pack';
import { versionApi } from '../version';
import { contextFor } from './context';
import { jarRef, listText, makeFinding, metadataEvidence, modIdLines, modName } from './evidence';

export const dupIdCheck: Check = {
  id: 'duplicate-mod-id',
  codes: ['E-DUP-ID'],
  run(input) {
    const ctx = contextFor(input);
    const owners = new Map<string, JarRecord[]>();
    for (const jar of ctx.topLevel) {
      for (const id of new Set(ctx.relevant(jar).map((m) => m.modId))) {
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

    const out: Finding[] = [];
    for (const { jars, ids } of sets.values()) {
      ids.sort();
      const firstId = ids[0] ?? '';
      const metaOf = (j: JarRecord): ModMeta | undefined => ctx.relevant(j).find((m) => m.modId === firstId);
      const ranked = [...jars].sort((a, b) => {
        const ma = metaOf(a);
        const mb = metaOf(b);
        const syntax = versionSyntaxFor(ma?.loader ?? 'unknown');
        const byVersion = ma && mb ? versionApi.compare(mb.version, ma.version, syntax, 'other') : 0;
        return byVersion || b.mtimeMs - a.mtimeMs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
      });
      const keep = ranked[0];
      if (!keep) continue;
      const remove = ranked.slice(1);
      const keepMeta = metaOf(keep);
      const name = keepMeta ? modName(keepMeta) : firstId;
      const versions = ranked.map((j) => `${j.fileName} (${metaOf(j)?.version ?? '?'})`);
      const evidence: Evidence[] = [];
      for (const j of ranked) {
        const m = metaOf(j);
        if (m && m.metadataExcerpt) evidence.push(metadataEvidence(j, m, modIdLines(m)));
      }
      evidence.push({ kind: 'note', text: `Mod id${ids.length > 1 ? 's' : ''} ${listText(ids.map((i) => `"${i}"`))} declared by: ${versions.join(', ')}.` });
      evidence.push(ctx.packNote);
      const fixes: FixAction[] = remove.map((j) => ({ kind: 'removeDuplicate', keep: keep.id, remove: j.id }));
      out.push(
        makeFinding({
          code: 'E-DUP-ID',
          severity: 'error',
          title: `${name} is installed ${jars.length} times (${listText(ranked.map((j) => j.fileName), 3)})`,
          explanation:
            `${versions.join(' and ')} all declare the mod id${ids.length > 1 ? 's' : ''} ${listText(ids.map((i) => `"${i}"`))}. ` +
            `A loader can only load one mod per id, so it stops with a duplicate-mod error. ` +
            `Keep ${keep.fileName} (${keepMeta?.version ?? 'unknown version'}, the newest copy) and remove ${listText(remove.map((j) => j.fileName))}; ` +
            `removed files go into the backup, not the bin.`,
          culprits: ranked.map((j) => jarRef(j, firstId)),
          evidence,
          fixes,
          discriminator: ids.join(','),
        }),
      );
    }
    return out;
  },
};
