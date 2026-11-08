/**
 * E-LOADER-RANGE: an effective entry's `loaderRange` (its dependency on `forge`, `neoforge`,
 * `fabricloader` or `quilt_loader`) excludes the pack's loader version.
 * - Evaluated with `evaluateRange` (pack/fmlCompat.ts): plain Maven/Fabric check, then — FML
 *   only — the `VersionSupportMatrix` loader fallbacks (`neoforge` 21.0.166 on 1.21.1,
 *   21.7.26-beta on 1.21.8; `forge` 47.1.79 on 1.20.1). Excluded by the actual version and every
 *   fallback → **error**; admitted only by a fallback → **info**. Fabric/Quilt are strict.
 * - FML side filter: a loader dependency with `side = "CLIENT"` is skipped on a server pack,
 *   `SERVER` on a client pack.
 * - Never compares `languageRange` (`loaderVersion`, the FML language-provider version).
 * - Only when the entry targets the pack's own loader: a Fabric mod on Quilt, or a Forge mod on
 *   NeoForge 1.20.1, declares a range over a *different* loader's version numbers, which we cannot
 *   map, so it is skipped.
 * - Skipped when the loader version is unknown (inferred packs) or the verdict is unknown.
 * - A NeoForge `config/fml.toml` override `-neoforge` for the mod lowers it to info
 *   (checks/fmlOverrides.ts).
 * Fixes (error): manual "update the loader / get a matching build"; disable the jar.
 */
import type { Check, Finding } from '../model';
import { describeFallback, evaluateRange, LOADER_DEP_IDS, LOADER_NAMES, MCMOD_INFO } from '../pack';
import { contextFor } from './context';
import { dependencyLines, describeRange, disable, entryEvidence, entryLabel, entryRef, makeFinding, manual, modName, rangeDependency, rawRange } from './evidence';
import { relaxByOverride } from './fmlOverrides';
import { depSideApplies } from './missingDep';

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
      if (!range || e.mod.loader !== loader.kind || e.mod.metadataFile === MCMOD_INFO) continue;
      const dep = rangeDependency(e.mod, LOADER_DEP_IDS[e.mod.loader]);
      if (dep && !depSideApplies(dep, ctx.pack.side)) continue;
      const depId = dep?.modId ?? loader.kind;
      const verdict = evaluateRange(version, range, 'other', depId, { loader: loader.kind, mc: ctx.pack.mcVersion, loaderVersion: version });
      if (verdict.kind === 'pass' || verdict.kind === 'unknown') continue;
      const name = modName(e.mod);
      const wants = describeRange(range);
      const evidence = entryEvidence(ctx, e, dep ? dependencyLines(e.mod, dep.modId, dep.kind) : []);
      if (verdict.kind === 'fallback') {
        const via = describeFallback(verdict, depId);
        out.push(
          relaxByOverride(ctx, e, depId, makeFinding({
            code: 'E-LOADER-RANGE',
            severity: 'info',
            title: `${name} declares ${loaderName} ${rawRange(range)}; loads on ${version} through a compatibility override`,
            explanation:
              `${entryLabel(e)} declares ${loaderName} ${wants} (${rawRange(range)}), which does not include ${version}. ` +
              `It still loads through ${via}: FML accepts the range because it contains ${verdict.fallback}. ` +
              `Nothing to do unless the mod misbehaves.`,
            culprits: [entryRef(e)],
            evidence: [...evidence.slice(0, -1), { kind: 'note', text: `Accepted through ${via}.` }, ctx.packNote],
            fixes: [manual(`Optional: update ${name} to a version that declares support for ${loaderName} ${version}.`)],
            discriminator: e.mod.modId,
          })),
        );
        continue;
      }
      const bundled = e.jar.depth > 0 ? ` It is bundled inside ${e.top.fileName}.` : '';
      out.push(
        relaxByOverride(ctx, e, depId, makeFinding({
          code: 'E-LOADER-RANGE',
          severity: 'error',
          title: `${name} needs ${loaderName} ${wants}, but the pack has ${version}`,
          explanation:
            `${entryLabel(e)} requires ${loaderName} ${wants} (${rawRange(range)}), and this pack runs ${loaderName} ${version}. ` +
            `The loader stops at startup with a dependency error.${bundled} ` +
            `Change the instance to a ${loaderName} version in that range, or install a build of ${name} that supports ${version}.`,
          culprits: [entryRef(e)],
          evidence,
          fixes: [
            manual(
              `In your launcher, switch the instance to ${loaderName} ${wants}.`,
              `Or replace ${e.top.fileName} with a version of ${name} that supports ${loaderName} ${version}.`,
            ),
            disable(e.top),
          ],
          discriminator: e.mod.modId,
        })),
      );
    }
    return out;
  },
};
