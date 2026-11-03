/**
 * E-LOADER-RANGE (error): an effective entry's `loaderRange` (its dependency on `forge`,
 * `neoforge`, `fabricloader` or `quilt_loader`) excludes the pack's loader version.
 * - Never compares `languageRange` (`loaderVersion`, the FML language-provider version).
 * - Only when the entry targets the pack's own loader: a Fabric mod on Quilt, or a Forge mod on
 *   NeoForge 1.20.1, declares a range over a *different* loader's version numbers, which we cannot
 *   map, so it is skipped.
 * - Skipped when the loader version is unknown (inferred packs) or `satisfies` returns null.
 * Fixes: disable the jar; manual "update the loader / get a matching build".
 */
import type { Check, Finding } from '../model';
import { LOADER_DEP_IDS, LOADER_NAMES } from '../pack';
import { versionApi } from '../version';
import { contextFor } from './context';
import { dependencyLines, describeRange, disable, entryEvidence, entryLabel, entryRef, makeFinding, manual, modName, rawRange } from './evidence';

export const loaderRangeCheck: Check = {
  id: 'loader-range',
  codes: ['E-LOADER-RANGE'],
  run(input) {
    const ctx = contextFor(input);
    const loader = ctx.pack.loader;
    if (!loader || !loader.version || loader.kind === 'unknown') return [];
    const version = loader.version;
    const loaderName = LOADER_NAMES[loader.kind];
    const out: Finding[] = [];
    for (const e of ctx.effective) {
      const range = e.mod.loaderRange;
      if (!range || e.mod.loader !== loader.kind) continue;
      if (versionApi.satisfies(version, range, 'other') !== false) continue;
      const name = modName(e.mod);
      const wants = describeRange(range);
      const depIds = LOADER_DEP_IDS[e.mod.loader];
      const dep = e.mod.deps.find((d) => depIds.includes(d.modId));
      const bundled = e.jar.depth > 0 ? ` It is bundled inside ${e.top.fileName}.` : '';
      out.push(
        makeFinding({
          code: 'E-LOADER-RANGE',
          severity: 'error',
          title: `${name} needs ${loaderName} ${wants}, but the pack has ${version}`,
          explanation:
            `${entryLabel(e)} requires ${loaderName} ${wants} (${rawRange(range)}), and this pack runs ${loaderName} ${version}. ` +
            `The loader stops at startup with a dependency error.${bundled} ` +
            `Change the instance to a ${loaderName} version in that range, or install a build of ${name} that supports ${version}.`,
          culprits: [entryRef(e)],
          evidence: entryEvidence(ctx, e, dep ? dependencyLines(e.mod, dep.modId, dep.kind) : []),
          fixes: [
            manual(
              `In your launcher, switch the instance to ${loaderName} ${wants}.`,
              `Or replace ${e.top.fileName} with a version of ${name} that supports ${loaderName} ${version}.`,
            ),
            disable(e.top),
          ],
          discriminator: e.mod.modId,
        }),
      );
    }
    return out;
  },
};
