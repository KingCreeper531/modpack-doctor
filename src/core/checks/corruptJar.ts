/**
 * W-CORRUPT-JAR (warning), one finding per jar:
 * - status `corrupt` (not a valid zip, or none of its metadata files parsed) or `unreadable`
 *   (I/O / permission error); or
 * - status `ok`, but a `metadataErrors` entry is for a file the pack's loader reads
 *   (`loaderReadsFile`, pack/loaders.ts): "<file> inside X.jar can't be read: <reason>".
 *   Parse errors in files the loader ignores (a stale `META-INF/mods.toml` next to a valid
 *   `neoforge.mods.toml` on NeoForge ≥ 1.20.5, a `fabric.mod.json` in a jar Quilt reads through
 *   `quilt.mod.json`) produce nothing.
 * Disabled jars (and jars nested in them) are skipped. A damaged *nested* jar is reported against
 * its top-level jar (the file the user can replace), naming the nested entry.
 * Fix: manual (re-download / check permissions).
 */
import type { JarRecord } from '../../bindings';
import type { Check, Finding } from '../model';
import { isDisabledChain, loaderReadsFile, topLevelOf } from '../pack';
import { contextFor, type CheckContext } from './context';
import { jarRef, makeFinding, manual, metadataEvidence } from './evidence';

function statusFinding(ctx: CheckContext, jar: JarRecord, top: JarRecord, reason: string, unreadable: boolean): Finding {
  const nested = jar.depth > 0;
  const label = nested ? `${jar.path} inside ${top.fileName}` : jar.fileName;
  const what = unreadable
    ? `could not be read (${reason}). It may be locked by another program, or you may lack permission to read it.`
    : `is damaged (${reason}). The loader cannot read it, so the mod is missing in game or the loader stops with an error.`;
  const steps = unreadable
    ? [`Close programs that may hold ${jar.fileName} open, check the file's permissions, then rescan.`]
    : [`Re-download ${top.fileName} from where you got it and replace the damaged file.`];
  const first = jar.mods[0];
  return makeFinding({
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
  });
}

export const corruptJarCheck: Check = {
  id: 'corrupt-jar',
  codes: ['W-CORRUPT-JAR'],
  run(input) {
    const ctx = contextFor(input);
    const kind = ctx.pack.loader?.kind ?? 'unknown';
    const out: Finding[] = [];
    const jars = [...input.scan.jars].sort((a, b) => a.depth - b.depth || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    for (const jar of jars) {
      if (isDisabledChain(jar, ctx.all)) continue;
      const top = topLevelOf(jar, ctx.all);
      if (jar.status.state !== 'ok') {
        out.push(statusFinding(ctx, jar, top, jar.status.reason, jar.status.state === 'unreadable'));
        continue;
      }
      const errors = (jar.metadataErrors ?? []).filter((e) => loaderReadsFile(kind, ctx.pack.mcVersion, jar, e.file));
      const firstError = errors[0];
      if (!firstError) continue;
      const nested = jar.depth > 0;
      const where = nested ? `${jar.path} (bundled in ${top.fileName})` : jar.fileName;
      const more = errors.length > 1 ? ` (+${errors.length - 1} more)` : '';
      out.push(
        makeFinding({
          code: 'W-CORRUPT-JAR',
          severity: 'warning',
          title: `${firstError.file} inside ${where} can't be read: ${firstError.reason}${more}`,
          explanation:
            `${where} contains ${errors.map((e) => e.file).join(' and ')}, which the pack's loader reads, but ${errors.length === 1 ? 'it' : 'they'} could not be parsed ` +
            `(${firstError.reason}). The loader will reject the mod or stop with a mod-file error. Re-download the jar; if it persists, report it to the mod author.`,
          culprits: [jarRef(top, nested ? undefined : ctx.relevant(jar)[0]?.modId)],
          evidence: [...errors.map((e) => ({ kind: 'note' as const, text: `${e.file}: ${e.reason}` })), ctx.packNote],
          fixes: [manual(`Re-download ${top.fileName} from where you got it and replace it.`)],
          discriminator: nested ? jar.id : '',
        }),
      );
    }
    return out;
  },
};
