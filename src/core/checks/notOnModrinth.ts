/**
 * I-NOT-ON-MODRINTH (info): only when a Modrinth context is present and not offline. Active
 * top-level jars whose sha1 is neither in `versions` (identified) nor in `failed` (lookup failed:
 * unknown, not missing) are listed in ONE finding; every such jar is a culprit. All other checks
 * still run for them. No fix.
 */
import type { Check, Finding } from '../model';
import { contextFor } from './context';
import { jarRef, listText, makeFinding, plural } from './evidence';

export const TITLE_NOT_ON_MODRINTH = 'Not on Modrinth (possibly CurseForge or manual)';

export const notOnModrinthCheck: Check = {
  id: 'not-on-modrinth',
  codes: ['I-NOT-ON-MODRINTH'],
  run(input) {
    const mr = input.modrinth;
    if (!mr || mr.offline) return [];
    const ctx = contextFor(input);
    const failed = new Set(mr.failed.map((s) => s.toLowerCase()));
    const known = new Set(Object.keys(mr.versions).map((s) => s.toLowerCase()));
    const missing = [...ctx.topLevel]
      .filter((j) => {
        const h = j.sha1.toLowerCase();
        return h.length > 0 && !known.has(h) && !failed.has(h);
      })
      .sort((a, b) => (a.fileName.toLowerCase() < b.fileName.toLowerCase() ? -1 : a.fileName.toLowerCase() > b.fileName.toLowerCase() ? 1 : 0));
    if (missing.length === 0) return [];
    const names = missing.map((j) => j.fileName);
    const finding: Finding = makeFinding({
      code: 'I-NOT-ON-MODRINTH',
      severity: 'info',
      title: TITLE_NOT_ON_MODRINTH,
      explanation:
        `${plural(missing.length, 'jar')} did not match any file on Modrinth by hash: ${listText(names, 8)}. ` +
        `They probably come from CurseForge, a mod's own site, or were built by hand. Nothing is wrong with that, ` +
        `but the app cannot suggest updates or replacements for them. Every other check still covers them.`,
      culprits: missing.map((j) => jarRef(j, ctx.relevant(j)[0]?.modId)),
      evidence: [{ kind: 'note', text: `Not found on Modrinth: ${names.join(', ')}.` }, ctx.packNote],
      fixes: [],
      discriminator: '',
    });
    return [finding];
  },
};
