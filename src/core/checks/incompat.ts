/**
 * E-INCOMPAT: an effective entry declares another mod incompatible, and that mod is loaded in a
 * version inside the declared range.
 * - `incompatible` (Forge/NeoForge `type="incompatible"`, Quilt `breaks`) and Fabric `breaks`:
 *   **error** — the loader refuses to start.
 * - `conflicts` (Fabric `conflicts`, NeoForge `type="discouraged"`): **warning** — the loader only
 *   logs a warning; the combination is known to misbehave. Same code, lower severity.
 * - The target may be top-level or bundled (any loaded entry, `provides` included); entries in
 *   the declaring jar itself are ignored. Unparseable ranges (`satisfies` null) are not reported.
 * - Forge `side` restrictions apply as for dependencies.
 * - Fixes: disable the target's top-level jar first (the declaring author named it as the
 *   problem), then disable the declaring jar.
 */
import type { Check, Finding, JarRef } from '../model';
import { versionApi } from '../version';
import { aliasGroup } from './connector';
import { contextFor } from './context';
import { dependencyLines, describeRange, disable, entryEvidence, entryLabel, entryRef, jarRef, makeFinding, modName, rawRange } from './evidence';
import { depSideApplies } from './missingDep';

export const incompatCheck: Check = {
  id: 'incompatible',
  codes: ['E-INCOMPAT'],
  run(input) {
    const ctx = contextFor(input);
    const out: Finding[] = [];
    for (const e of ctx.effective) {
      for (const dep of e.mod.deps) {
        if (dep.kind !== 'incompatible' && dep.kind !== 'breaks' && dep.kind !== 'conflicts') continue;
        if (dep.modId === e.mod.modId || !depSideApplies(dep, ctx.pack.side)) continue;
        if (ctx.connector.via(e.jar) && aliasGroup(dep.modId)) continue; // Connector: breaks on aliased ids not enforced
        const targets = ctx
          .providers(dep.modId)
          .filter((p) => p.top.id !== e.top.id && versionApi.satisfies(p.mod.version, dep.range, 'other') === true);
        if (targets.length === 0) continue;
        const hard = dep.kind !== 'conflicts';
        const name = modName(e.mod);
        const target = targets[0];
        if (!target) continue;
        const targetName = modName(target.mod);
        const range = describeRange(dep.range);
        const rangeText = range.startsWith('any version') ? '' : ` ${range} (${rawRange(dep.range)})`;
        const culprits: JarRef[] = [entryRef(e)];
        for (const t of targets) if (!culprits.some((c) => c.jarId === t.top.id)) culprits.push(jarRef(t.top, dep.modId));
        const tops = [...new Map(targets.map((t) => [t.top.id, t.top] as const)).values()];
        out.push(
          makeFinding({
            code: 'E-INCOMPAT',
            severity: hard ? 'error' : 'warning',
            title: hard ? `${name} is incompatible with ${targetName}` : `${name} conflicts with ${targetName}`,
            explanation:
              `${entryLabel(e)} declares "${dep.modId}"${rangeText} as ${hard ? 'incompatible' : 'conflicting'}, and ${entryLabel(target)} ` +
              `version ${target.mod.version} is installed. ` +
              (hard
                ? 'The loader refuses to start with both. '
                : 'The loader starts but warns; the authors say the two misbehave together. ') +
              `Disable one of them.`,
            culprits,
            evidence: entryEvidence(ctx, e, dependencyLines(e.mod, dep.modId, dep.kind), `Installed "${dep.modId}": ${targets.map((t) => `${t.mod.version} in ${t.top.fileName}`).join('; ')}.`),
            fixes: [...tops.map(disable), disable(e.top)],
            discriminator: `${e.mod.modId}->${dep.modId}`,
          }),
        );
      }
    }
    return out;
  },
};
