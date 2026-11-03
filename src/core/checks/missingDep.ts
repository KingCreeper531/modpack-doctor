/**
 * E-MISSING-DEP (error): an effective entry has a `required` dependency that nothing provides.
 * Present = a loaded entry at any depth (top-level or nested — JarJar/JiJ) declares the id as its
 * `modId` or in `provides`, or the id is built in (checks/builtins.ts). Skipped:
 * - dependencies whose Forge `side` excludes the pack side (`CLIENT` on a server, `SERVER` on a
 *   client);
 * - `optional`/`recommended` dependencies (never fatal when absent);
 * - Quilt "any of" arrays (CONTRACTS invariant 13: they arrive as optional entries).
 * Fixes: `enable` a disabled jar that provides the id, when there is one; then manual steps naming
 * the mod id and the required range (`installDependency` arrives in M5).
 */
import type { Dependency, FixAction, JarRecord } from '../../bindings';
import type { Check, Finding } from '../model';
import { loaderAccepts } from '../pack';
import { isBuiltinDependency } from './builtins';
import { contextFor, type CheckContext } from './context';
import { dependencyLines, describeRange, entryEvidence, entryLabel, entryRef, makeFinding, manual, modName, rawRange } from './evidence';

/** Forge dependency `side` vs the pack side. */
export function depSideApplies(dep: Dependency, side: 'client' | 'server'): boolean {
  const s = dep.side?.trim().toUpperCase();
  if (s === 'CLIENT') return side === 'client';
  if (s === 'SERVER') return side === 'server';
  return true;
}

function disabledProviders(ctx: CheckContext, modId: string): JarRecord[] {
  const kind = ctx.pack.loader?.kind ?? 'unknown';
  return ctx.input.scan.jars
    .filter((j) => j.depth === 0 && j.disabled)
    .filter((j) => j.mods.some((m) => loaderAccepts(kind, ctx.pack.mcVersion, m) && (m.modId === modId || m.provides.includes(modId))))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export const missingDepCheck: Check = {
  id: 'missing-dependency',
  codes: ['E-MISSING-DEP'],
  run(input) {
    const ctx = contextFor(input);
    const out: Finding[] = [];
    for (const e of ctx.effective) {
      for (const dep of e.mod.deps) {
        if (dep.kind !== 'required' || dep.modId === e.mod.modId) continue;
        if (isBuiltinDependency(dep.modId, ctx.pack) || !depSideApplies(dep, ctx.pack.side)) continue;
        if (ctx.providers(dep.modId).length > 0) continue;
        const name = modName(e.mod);
        const wants = describeRange(dep.range);
        const anyVersion = rawRange(dep.range) === '*' || wants.startsWith('any version');
        const versionText = anyVersion ? '' : ` ${wants}`;
        const disabled = disabledProviders(ctx, dep.modId);
        const fixes: FixAction[] = disabled.map((j) => ({ kind: 'enable', jarId: j.id }));
        fixes.push(
          manual(
            `Install the mod with id "${dep.modId}"${anyVersion ? '' : `, version ${wants} (${rawRange(dep.range)})`}, for the pack's loader and Minecraft version.`,
            `Or disable ${e.top.fileName} if you don't need ${name}.`,
          ),
        );
        const disabledText =
          disabled.length > 0 ? ` ${disabled.map((j) => j.fileName).join(', ')} would provide it but is disabled — re-enable it.` : '';
        out.push(
          makeFinding({
            code: 'E-MISSING-DEP',
            severity: 'error',
            title: `${name} requires "${dep.modId}"${versionText}, which is not installed`,
            explanation:
              `${entryLabel(e)} lists "${dep.modId}"${versionText} as a required dependency, and no active jar in the pack provides it. ` +
              `The loader will refuse to start and report a missing mandatory dependency.${disabledText} ` +
              `Install "${dep.modId}" or remove ${name}.`,
            culprits: [entryRef(e)],
            evidence: entryEvidence(ctx, e, dependencyLines(e.mod, dep.modId, dep.kind)),
            fixes,
            discriminator: `${e.mod.modId}->${dep.modId}`,
          }),
        );
      }
    }
    return out;
  },
};
