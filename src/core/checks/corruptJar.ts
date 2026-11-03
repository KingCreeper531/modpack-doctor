/**
 * W-CORRUPT-JAR (warning): a jar's status is `corrupt` (not a valid zip, or a metadata file could
 * not be parsed) or `unreadable` (I/O / permission error). Disabled jars (and jars nested in
 * them) are skipped. A damaged *nested* jar is reported against its top-level jar (that is the
 * file the user can replace), naming the nested entry.
 * Fix: manual (re-download / check permissions).
 */
import type { Check, Finding } from '../model';
import { isDisabledChain, topLevelOf } from '../pack';
import { contextFor } from './context';
import { jarRef, makeFinding, manual, metadataEvidence } from './evidence';

export const corruptJarCheck: Check = {
  id: 'corrupt-jar',
  codes: ['W-CORRUPT-JAR'],
  run(input) {
    const ctx = contextFor(input);
    const out: Finding[] = [];
    const jars = [...input.scan.jars].sort((a, b) => a.depth - b.depth || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    for (const jar of jars) {
      if (jar.status.state === 'ok' || isDisabledChain(jar, ctx.all)) continue;
      const top = topLevelOf(jar, ctx.all);
      const nested = jar.depth > 0;
      const unreadable = jar.status.state === 'unreadable';
      const reason = jar.status.reason;
      const label = nested ? `${jar.path} inside ${top.fileName}` : jar.fileName;
      const partly = jar.status.state === 'corrupt' && jar.mods.length > 0;
      const what = unreadable
        ? `could not be read (${reason}). It may be locked by another program, or you may lack permission to read it.`
        : partly
          ? `has a metadata file that could not be parsed (${reason}). The loader may reject it.`
          : `is damaged (${reason}). The loader cannot read it, so the mod is missing in game or the loader stops with an error.`;
      const steps = unreadable
        ? [`Close programs that may hold ${jar.fileName} open, check the file's permissions, then rescan.`]
        : [`Re-download ${top.fileName} from where you got it and replace the damaged file.`];
      const first = jar.mods[0];
      out.push(
        makeFinding({
          code: 'W-CORRUPT-JAR',
          severity: 'warning',
          title: unreadable ? `${label} cannot be read` : `${label} is damaged`,
          explanation: `${label} ${what}`,
          culprits: [jarRef(top, nested ? undefined : first?.modId)],
          evidence: [
            ...(first && first.metadataExcerpt ? [metadataEvidence(jar, first, [])] : []),
            { kind: 'note', text: `${unreadable ? 'Read error' : 'Problem'}: ${reason}` },
            ctx.packNote,
          ],
          fixes: [manual(...steps)],
          discriminator: nested ? jar.id : '',
        }),
      );
    }
    return out;
  },
};
