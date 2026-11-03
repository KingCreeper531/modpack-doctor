/**
 * E-WRONG-LOADER (error): an active top-level jar has metadata, but none of its entries is read by
 * the pack's loader (`loaderAccepts`: Quilt runs Fabric mods; Forge/NeoForge are compatible on
 * 1.20.1; see pack/loaders.ts). Jars without metadata (plain libraries) and entries of an
 * `unknown` loader are never reported. Skipped when the pack loader is unknown or vanilla.
 * Fix: disable the jar.
 */
import type { Check, Finding } from '../model';
import { describeLoader, LOADER_NAMES } from '../pack';
import { contextFor } from './context';
import { disable, jarRef, makeFinding, metadataEvidence, modIdLines, modName } from './evidence';

export const wrongLoaderCheck: Check = {
  id: 'wrong-loader',
  codes: ['E-WRONG-LOADER'],
  run(input) {
    const ctx = contextFor(input);
    const kind = ctx.pack.loader?.kind;
    if (!kind || kind === 'unknown') return [];
    const out: Finding[] = [];
    for (const jar of ctx.topLevel) {
      const declared = jar.mods.filter((m) => m.loader !== 'unknown');
      if (declared.length === 0 || ctx.relevant(jar).length > 0) continue;
      const loaders = [...new Set(declared.map((m) => LOADER_NAMES[m.loader]))];
      const first = declared[0];
      if (!first) continue;
      const packLoader = describeLoader(ctx.pack);
      const name = modName(first);
      out.push(
        makeFinding({
          code: 'E-WRONG-LOADER',
          severity: 'error',
          title: `${jar.fileName} is a ${loaders.join('/')} mod, but this pack runs ${LOADER_NAMES[kind]}`,
          explanation:
            `${name} (${jar.fileName}) only has ${loaders.join(' and ')} metadata, so ${packLoader} cannot load it. ` +
            `Depending on the loader it is either silently ignored or stops the game from starting, and anything that ` +
            `depends on it will be missing. Disable it, and install the ${LOADER_NAMES[kind]} build of ${name} instead if one exists.`,
          culprits: [jarRef(jar, first.modId)],
          evidence: [
            ...(first.metadataExcerpt ? [metadataEvidence(jar, first, modIdLines(first))] : []),
            { kind: 'note', text: `Declared loader${loaders.length > 1 ? 's' : ''}: ${loaders.join(', ')} (${first.metadataFile}).` },
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
