/**
 * E-DUP-ID: two or more active top-level jars declare the same mod id (among the entries the
 * pack loader reads). Severity follows what each loader does (docs/research/loader-enforcement.md):
 * - Forge/NeoForge (FML `UniqueModListBuilder` groups files by their FIRST mod id and keeps the
 *   newest file of each group): when every jar's first relevant mod entry is the same id →
 *   **warning** ("keeps the newest, ignores the older"); otherwise (the id is a secondary mod in
 *   at least one file, so two kept files declare it) → **error**.
 * - Fabric: **warning** — the resolver keeps one per id, newest preferred (best effort).
 * - Quilt, legacy FML (Forge on MC < 1.13 or a Legacy Forge pack; DuplicateModsFoundException),
 *   unknown loader: **error**.
 * - Duplicates inside one jar (Forge + NeoForge metadata, or mods.toml + mcmod.info) are ignored.
 * - Nested jars are never compared: the loaders de-duplicate JarJar libraries by
 *   `group:artifact` and Fabric/Quilt JiJ by mod id, and a top-level copy overrides a nested one.
 * - Jars sharing several ids produce one finding listing every id.
 * - Groups, modes and ranking come from checks/duplicates.ts (computed once in the context; the
 *   copies FML/Fabric drop are excluded from every other check).
 * - Fix: `removeDuplicate` keeping the newest copy (placeholder / `0.0NONE` versions rank lowest;
 *   ties → the most recently modified file, then the smallest jar id). One fix per extra copy.
 */
import type { FixAction, JarRecord, ModMeta } from '../../bindings';
import type { Check, Evidence, Finding } from '../model';
import { mcCompare } from '../pack';
import { contextFor } from './context';
import { jarRef, listText, makeFinding, metadataEvidence, modIdLines, modName } from './evidence';

const COUNT_WORDS: Readonly<Record<number, string>> = { 2: 'Two', 3: 'Three', 4: 'Four', 5: 'Five' };

export const dupIdCheck: Check = {
  id: 'duplicate-mod-id',
  codes: ['E-DUP-ID'],
  run(input) {
    const ctx = contextFor(input);
    const out: Finding[] = [];
    const kind = ctx.pack.loader?.kind;
    // Modern FML (legacy FML refuses every duplicate, with its own wording).
    const fml = kind === 'neoforge' || (kind === 'forge' && (mcCompare(ctx.pack.mcVersion, '1.13') ?? 0) >= 0);
    for (const { jars, ids, mode, rankId: firstId } of ctx.duplicates) {
      const ranked = jars;
      const metaOf = (j: JarRecord): ModMeta | undefined => ctx.relevant(j).find((m) => m.modId === firstId);
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
      const keepVersion = keepMeta?.version ?? 'unknown version';
      const declared = `${versions.join(' and ')} all declare the mod id${ids.length > 1 ? 's' : ''} ${listText(ids.map((i) => `"${i}"`))}. `;
      const advice =
        `Keep ${keep.fileName} (${keepVersion}, the newest copy) and remove ${listText(remove.map((j) => j.fileName))}; ` +
        `removed files go into the backup, not the bin.`;
      const copies = `${COUNT_WORDS[jars.length] ?? String(jars.length)} copies of ${name}`;
      const others = remove.length === 1 ? 'the older' : 'the others';
      const { title, why } =
        mode === 'fml-grouped'
          ? {
              title: `${copies} — the loader keeps the newest (${keepVersion}) and ignores ${others}`,
              why: `FML groups jars by their first mod id, loads only the newest file of the group and silently skips the rest, so the game starts — but the extra file is dead weight and confusing. `,
            }
          : mode === 'fabric'
            ? {
                title: `${copies} — Fabric keeps one (best effort, newest preferred: ${keepVersion})`,
                why: `Fabric's resolver keeps exactly one mod per id, preferring the newest, as a best effort; which copy wins is not guaranteed. `,
              }
            : {
                title: `${name} is installed ${jars.length} times (${listText(ranked.map((j) => j.fileName), 3)})`,
                why:
                  kind === 'quilt'
                    ? `Quilt refuses duplicate mod ids and stops with "Duplicate mod". `
                    : fml
                      ? `The id is not the first mod of every file, so FML keeps more than one file declaring it and stops with a duplicate-mod error. `
                      : `A loader can only load one mod per id, so it stops with a duplicate-mod error. `,
              };
      out.push(
        makeFinding({
          code: 'E-DUP-ID',
          severity: mode === 'error' ? 'error' : 'warning',
          title,
          explanation: declared + why + advice,
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
