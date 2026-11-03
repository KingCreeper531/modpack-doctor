/**
 * E-MC-RANGE (error): an effective metadata entry's `mcRange` excludes the pack's MC version.
 * Evaluated with `versionApi.satisfies(mc, range, 'minecraft')`; `null` (unknown MC version,
 * unparseable or unrepresentable range) never produces a finding. Bundled (nested) mods are
 * checked too, after JarJar/JiJ de-duplication (checks/context.ts); the culprit is then the
 * top-level jar that bundles them.
 * Fixes: disable the jar; manual "get the build for <MC>".
 */
import type { Check, Finding } from '../model';
import { versionApi } from '../version';
import { contextFor } from './context';
import { dependencyLines, describeRange, disable, entryEvidence, entryLabel, entryRef, makeFinding, manual, modName, rawRange } from './evidence';

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
      if (!range || versionApi.satisfies(mc, range, 'minecraft') !== false) continue;
      const name = modName(e.mod);
      const wants = describeRange(range, 'minecraft');
      const bundled = e.jar.depth > 0 ? ` It is bundled inside ${e.top.fileName}, so the fix applies to that jar.` : '';
      out.push(
        makeFinding({
          code: 'E-MC-RANGE',
          severity: 'error',
          title: `${name} is made for Minecraft ${wants}, not ${mc}`,
          explanation:
            `${entryLabel(e)} declares that it only works with Minecraft ${wants} (${rawRange(range)}), but this pack runs ${mc}. ` +
            `The loader refuses to start with it, or it crashes when it touches game code that changed.${bundled} ` +
            `Install the build of ${name} made for ${mc}, or disable it.`,
          culprits: [entryRef(e)],
          evidence: entryEvidence(ctx, e, dependencyLines(e.mod, 'minecraft')),
          fixes: [disable(e.top), manual(`Download the version of ${name} made for Minecraft ${mc} and replace ${e.top.fileName} with it.`)],
          discriminator: e.mod.modId,
        }),
      );
    }
    return out;
  },
};
