/**
 * E-WRONG-LOADER (error): an active top-level jar has metadata, but none of its entries is
 * relevant to the pack (`entryRelevant`, pack/loaders.ts): either no entry targets a loader the
 * pack runs (`loaderAccepts`: Quilt runs Fabric mods; Forge/NeoForge are compatible on 1.20.1),
 * or the matching entries sit in a file the loader no longer reads (`metadataFilesRead`: e.g. a
 * jar with only `META-INF/mods.toml` on NeoForge ≥ 1.20.5).
 * Not reported: jars without metadata (plain libraries), entries of an `unknown` loader, jars with
 * a parse error in a file the loader reads (W-CORRUPT-JAR covers those), and packs whose loader is
 * unknown or vanilla.
 * Fix: disable the jar.
 */
import type { Check, Finding } from '../model';
import { describeLoader, LOADER_NAMES, loaderAccepts, loaderReadsFile } from '../pack';
import { contextFor } from './context';
import { disable, jarRef, makeFinding, metadataEvidence, modIdLines, modName } from './evidence';

export const wrongLoaderCheck: Check = {
  id: 'wrong-loader',
  codes: ['E-WRONG-LOADER'],
  run(input) {
    const ctx = contextFor(input);
    const kind = ctx.pack.loader?.kind;
    if (!kind || kind === 'unknown') return [];
    const mc = ctx.pack.mcVersion;
    const out: Finding[] = [];
    for (const jar of ctx.topLevel) {
      const declared = jar.mods.filter((m) => m.loader !== 'unknown');
      if (declared.length === 0 || ctx.relevant(jar).length > 0) continue;
      if ((jar.metadataErrors ?? []).some((e) => loaderReadsFile(kind, mc, jar, e.file))) continue;
      const loaders = [...new Set(declared.map((m) => LOADER_NAMES[m.loader]))];
      // Right loader, wrong file: the entry would be accepted, but the loader never reads it.
      const unread = declared.find((m) => loaderAccepts(kind, mc, m) && !loaderReadsFile(kind, mc, jar, m.metadataFile));
      const first = unread ?? declared[0];
      if (!first) continue;
      const packLoader = describeLoader(ctx.pack);
      const name = modName(first);
      const title = unread
        ? `${jar.fileName} only has ${unread.metadataFile}, which ${LOADER_NAMES[kind]}${mc ? ` on ${mc}` : ''} does not read`
        : `${jar.fileName} is a ${loaders.join('/')} mod, but this pack runs ${LOADER_NAMES[kind]}`;
      const explanation = unread
        ? `${name} (${jar.fileName}) declares itself only in ${unread.metadataFile}. ${packLoader} on Minecraft ${mc ?? '(unknown)'} ` +
          `reads a different metadata file, so it does not see this mod at all — it is ignored, and anything that depends on it will be missing. ` +
          `Install the build of ${name} made for this Minecraft version, and disable this one.`
        : `${name} (${jar.fileName}) only has ${loaders.join(' and ')} metadata, so ${packLoader} cannot load it. ` +
          `Depending on the loader it is either silently ignored or stops the game from starting, and anything that ` +
          `depends on it will be missing. Disable it, and install the ${LOADER_NAMES[kind]} build of ${name} instead if one exists.`;
      out.push(
        makeFinding({
          code: 'E-WRONG-LOADER',
          severity: 'error',
          title,
          explanation,
          culprits: [jarRef(jar, first.modId)],
          evidence: [
            ...(first.metadataExcerpt ? [metadataEvidence(jar, first, modIdLines(first))] : []),
            { kind: 'note', text: `Declared loader${loaders.length > 1 ? 's' : ''}: ${loaders.join(', ')} (${[...new Set(declared.map((m) => m.metadataFile))].join(', ')}).` },
            ctx.packNote,
          ],
          fixes: [disable(jar)],
          discriminator: '',
        }),
      );
    }
    return out;
  },
};
