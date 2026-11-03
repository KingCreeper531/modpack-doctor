/**
 * E-MC-RANGE: an effective metadata entry's `mcRange` excludes the pack's MC version.
 * - Evaluated with `evaluateRange` (pack/fmlCompat.ts): plain `versionApi.satisfies(mc, range,
 *   'minecraft')`, then — Maven/FML ranges only — FML's `VersionSupportMatrix` fallbacks
 *   (e.g. Forge 1.16.5 also accepts `1.16.3`/`1.16.4`, Forge 1.19.2 `1.19.1`, NeoForge 1.21.1
 *   `1.21`, NeoForge 1.21.8 `1.21.7`; full table in pack/fmlCompat.ts).
 * - `mcmod.info` entries are skipped: legacy FML never reads `mcversion`.
 *   - excluded by the actual version and every fallback → **error** (FML/Fabric/Quilt refuse it);
 *   - admitted only by a fallback → **info** (it loads through the compatibility override);
 *   - unknown (unknown MC, unparseable/unrepresentable range) → nothing.
 *   Fabric/Quilt ranges are strict.
 * - FML side filter: a `minecraft` dependency with `side = "CLIENT"` is not checked on a server
 *   pack, `SERVER` not on a client pack.
 * - Bundled (nested) mods are checked too, after JarJar/JiJ de-duplication (checks/context.ts);
 *   the culprit is then the top-level jar that bundles them.
 * Fixes (error): disable the jar; manual "get the build for <MC>". Info: manual only.
 */
import type { Check, Finding } from '../model';
import { describeFallback, evaluateRange, MCMOD_INFO } from '../pack';
import { contextFor } from './context';
import { dependencyLines, describeRange, disable, entryEvidence, entryLabel, entryRef, makeFinding, manual, modName, rawRange, rangeDependency } from './evidence';
import { depSideApplies } from './missingDep';

export const mcRangeCheck: Check = {
  id: 'mc-range',
  codes: ['E-MC-RANGE'],
  run(input) {
    const ctx = contextFor(input);
    const mc = ctx.pack.mcVersion;
    if (mc === null) return [];
    const out: Finding[] = [];
    for (const e of ctx.effective) {
      const range = e.mod.mcRange;
      // Legacy FML never reads mcmod.info `mcversion` (it enforces @Mod acceptedMinecraftVersions,
      // which the scanner does not read yet).
      if (!range || e.mod.metadataFile === MCMOD_INFO) continue;
      const dep = rangeDependency(e.mod, ['minecraft']);
      if (dep && !depSideApplies(dep, ctx.pack.side)) continue;
      const verdict = evaluateRange(mc, range, 'minecraft', 'minecraft', { loader: ctx.pack.loader?.kind, mc, loaderVersion: ctx.pack.loader?.version ?? null });
      if (verdict.kind === 'pass' || verdict.kind === 'unknown') continue;
      const name = modName(e.mod);
      const wants = describeRange(range, 'minecraft');
      const evidence = entryEvidence(ctx, e, dependencyLines(e.mod, 'minecraft'));
      if (verdict.kind === 'fallback') {
        const via = describeFallback(verdict, 'minecraft');
        out.push(
          makeFinding({
            code: 'E-MC-RANGE',
            severity: 'info',
            title: `${name} declares Minecraft ${rawRange(range)}; loads on ${mc} through a compatibility override`,
            explanation:
              `${entryLabel(e)} declares Minecraft ${wants} (${rawRange(range)}), which does not include ${mc}. ` +
              `It still loads through ${via}: FML treats ${verdict.fallback} mods as compatible. ` +
              `Nothing to do unless the mod misbehaves; a build made for ${mc} is the cleaner option.`,
            culprits: [entryRef(e)],
            evidence: [...evidence.slice(0, -1), { kind: 'note', text: `Accepted through ${via}.` }, ctx.packNote],
            fixes: [manual(`Optional: install the version of ${name} made for Minecraft ${mc}.`)],
            discriminator: e.mod.modId,
          }),
        );
        continue;
      }
      const bundled = e.jar.depth > 0 ? ` It is bundled inside ${e.top.fileName}, so the fix applies to that jar.` : '';
      out.push(
        makeFinding({
          code: 'E-MC-RANGE',
          severity: 'error',
          title: `${name} is made for Minecraft ${wants}, not ${mc}`,
          explanation:
            `${entryLabel(e)} declares that it only works with Minecraft ${wants} (${rawRange(range)}), but this pack runs ${mc}. ` +
            `The loader refuses to start with it.${bundled} ` +
            `Install the build of ${name} made for ${mc}, or disable it.`,
          culprits: [entryRef(e)],
          evidence,
          fixes: [disable(e.top), manual(`Download the version of ${name} made for Minecraft ${mc} and replace ${e.top.fileName} with it.`)],
          discriminator: e.mod.modId,
        }),
      );
    }
    return out;
  },
};
