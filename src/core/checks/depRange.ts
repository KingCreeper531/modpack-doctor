/**
 * E-DEP-RANGE (error): a dependency is present, but the version the loader would use is outside
 * the declared range.
 * - Which dependencies: `required` ones; for Forge/NeoForge/Legacy Forge also `optional` ones,
 *   because FML enforces an optional dependency's range whenever that mod is installed. Fabric
 *   `recommends`/`suggests` only log a warning, so they are skipped. Built-ins (minecraft, the
 *   loader, java — covered by E-MC-RANGE / E-LOADER-RANGE) and side-excluded deps are skipped.
 * - Which version: `CheckContext.versionProviders` — a top-level provider wins over bundled
 *   copies; among JarJar copies only the one FML selects (highest version inside every copy's
 *   JarJar range); among Fabric/Quilt JiJ copies any one may be chosen by the resolver. For a
 *   `provides` alias the provider's own version is used, as Fabric does.
 * - No finding when any candidate satisfies the range, or when `satisfies` returns null.
 * Fixes: manual (install a matching version of the dependency); disable the dependent jar.
 */
import type { Check, Finding, JarRef } from '../model';
import { versionApi } from '../version';
import { isBuiltinDependency } from './builtins';
import { contextFor } from './context';
import { dependencyLines, describeRange, disable, entryEvidence, entryLabel, entryRef, jarRef, makeFinding, manual, modName, rawRange } from './evidence';
import { depSideApplies } from './missingDep';

export const depRangeCheck: Check = {
  id: 'dependency-range',
  codes: ['E-DEP-RANGE'],
  run(input) {
    const ctx = contextFor(input);
    const out: Finding[] = [];
    for (const e of ctx.effective) {
      const fml = e.mod.loader === 'forge' || e.mod.loader === 'neoforge' || e.mod.loader === 'legacyforge';
      for (const dep of e.mod.deps) {
        if (dep.modId === e.mod.modId) continue;
        if (!(dep.kind === 'required' || (fml && dep.kind === 'optional'))) continue;
        if (isBuiltinDependency(dep.modId, ctx.pack) || !depSideApplies(dep, ctx.pack.side)) continue;
        const providers = ctx.versionProviders(dep.modId).filter((p) => p.jar.id !== e.jar.id);
        if (providers.length === 0) continue;
        if (providers.some((p) => versionApi.satisfies(p.mod.version, dep.range, 'other') !== false)) continue;

        const name = modName(e.mod);
        const wants = describeRange(dep.range);
        const installed = providers.map((p) => `${p.mod.version} in ${p.jar.depth === 0 ? p.jar.fileName : `${p.jar.fileName} (bundled in ${p.top.fileName})`}`);
        const culprits: JarRef[] = [entryRef(e)];
        for (const p of providers) {
          if (!culprits.some((c) => c.jarId === p.top.id)) culprits.push(jarRef(p.top, dep.modId));
        }
        const optional = dep.kind === 'optional' ? ' (optional, but enforced when installed)' : '';
        out.push(
          makeFinding({
            code: 'E-DEP-RANGE',
            severity: 'error',
            title: `${name} needs "${dep.modId}" ${wants}, but ${installed[0] ?? 'another version'} is installed`,
            explanation:
              `${entryLabel(e)} depends on "${dep.modId}" ${wants} (${rawRange(dep.range)})${optional}. ` +
              `The pack has ${installed.join('; ')}, which is outside that range, so the loader refuses to start or the mods ` +
              `crash on missing classes or methods. Install a version of "${dep.modId}" in the range, or update ${name}.`,
            culprits,
            evidence: entryEvidence(ctx, e, dependencyLines(e.mod, dep.modId, dep.kind), `Installed "${dep.modId}": ${installed.join('; ')}.`),
            fixes: [
              manual(`Replace "${dep.modId}" with a version in ${wants} (${rawRange(dep.range)}).`, `Or update ${name} to a version that accepts the installed "${dep.modId}".`),
              disable(e.top),
            ],
            discriminator: `${e.mod.modId}->${dep.modId}`,
          }),
        );
      }
    }
    return out;
  },
};
