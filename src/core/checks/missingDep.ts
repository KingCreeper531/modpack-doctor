/**
 * E-MISSING-DEP (error): an effective entry has a `required` dependency that nothing provides.
 * Present = a loaded entry at any depth (top-level or nested — JarJar/JiJ) declares the id as its
 * `modId` or in `provides`, or the id is built in (checks/builtins.ts). Skipped:
 * - dependencies whose Forge `side` excludes the pack side (`CLIENT` on a server, `SERVER` on a
 *   client);
 * - `optional`/`recommended` dependencies (never fatal when absent);
 * - Quilt "any of" arrays (CONTRACTS invariant 13: they arrive as optional entries).
 * When a top-level jar does declare the id but doesn't count — disabled, damaged, built for another
 * loader, or for the other side — the title names that jar and the reason instead of "not
 * installed" (`absentReason`), so a user who can see the mod in their launcher isn't told it's gone.
 * Fixes: `enable` a disabled jar that provides the id, when there is one; then manual steps naming
 * the mod id and the required range. `missingModIds` names the absent id, so `src/core/modrinth` can
 * add an `installDependency` fix (M5).
 */
import type { Dependency, FixAction, JarRecord, LoaderKind, ModMeta } from '../../bindings';
import type { Check, Finding } from '../model';
import { entryRelevant, LOADER_NAMES } from '../pack';
import { isBuiltinDependency } from './builtins';
import { aliasGroup } from './connector';
import { contextFor, sideAccepts, type CheckContext } from './context';
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
    .filter((j) => j.mods.some((m) => entryRelevant(kind, ctx.pack.mcVersion, j, m) && declares(m, modId)))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function declares(m: ModMeta, modId: string): boolean {
  const id = modId.toLowerCase();
  return m.modId.toLowerCase() === id || m.provides.some((p) => p.toLowerCase() === id);
}

function loaderList(kinds: readonly LoaderKind[]): string {
  const names = [...new Set(kinds.filter((k) => k !== 'unknown').map((k) => LOADER_NAMES[k]))];
  return names.length === 0 ? 'another loader' : names.join(' / ');
}

/**
 * A top-level jar that declares `modId` but that the loader won't use, and why, in the words of
 * "<file> <reason>". Disabled first (the most common case: switched off in the launcher), then
 * damaged, wrong loader, wrong side. Null when no jar in the folder declares the id at all.
 */
export function absentReason(ctx: CheckContext, modId: string): { jar: JarRecord; reason: string } | null {
  const kind = ctx.pack.loader?.kind ?? 'unknown';
  const loaderName = LOADER_NAMES[kind];
  const candidates = ctx.input.scan.jars
    .filter((j) => j.depth === 0 && j.mods.some((m) => declares(m, modId)))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const reasons: { rank: number; jar: JarRecord; reason: string }[] = [];
  for (const jar of candidates) {
    const mods = jar.mods.filter((m) => declares(m, modId));
    const relevant = mods.filter((m) => entryRelevant(kind, ctx.pack.mcVersion, jar, m));
    if (jar.disabled) reasons.push({ rank: 0, jar, reason: 'is disabled' });
    else if (jar.status.state !== 'ok') reasons.push({ rank: 1, jar, reason: "is damaged and can't be read" });
    else if (relevant.length === 0)
      reasons.push({ rank: 2, jar, reason: `is the ${loaderList(mods.map((m) => m.loader))} version, and this pack runs ${loaderName}` });
    else if (!relevant.some((m) => sideAccepts(m.environment, ctx.pack.side)))
      reasons.push({ rank: 3, jar, reason: `is ${relevant[0]!.environment}-only, and this is a ${ctx.pack.side} instance` });
  }
  reasons.sort((a, b) => a.rank - b.rank);
  const first = reasons[0];
  return first ? { jar: first.jar, reason: first.reason } : null;
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
        const viaConnector = ctx.connector.via(e.jar);
        if (ctx.providers(dep.modId, viaConnector).length > 0) continue;
        // Connector widens aliased ids (cloth_config ↔ cloth-config2, …) to "any of them".
        const group = viaConnector ? aliasGroup(dep.modId) : null;
        if (group && group.some((a) => ctx.providers(a, true).length > 0)) continue;
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
        const absent = absentReason(ctx, dep.modId);
        const absentText = absent ? ` ${absent.jar.fileName} ${absent.reason}${disabled.length > 0 ? ' — re-enable it' : ''}.` : '';
        out.push({
          ...makeFinding({
            code: 'E-MISSING-DEP',
            severity: 'error',
            title: absent
              ? `${name} requires "${dep.modId}"${versionText}, but ${absent.jar.fileName} ${absent.reason}`
              : `${name} requires "${dep.modId}"${versionText}, which is not installed`,
            explanation:
              `${entryLabel(e)} lists "${dep.modId}"${versionText} as a required dependency, and no jar the loader will use provides it. ` +
              `The loader will refuse to start and report a missing mandatory dependency.${absentText} ` +
              `Install "${dep.modId}" or remove ${name}.`,
            culprits: [entryRef(e)],
            evidence: entryEvidence(ctx, e, dependencyLines(e.mod, dep.modId, dep.kind)),
            fixes,
            discriminator: `${e.mod.modId}->${dep.modId}`,
          }),
          // The loader mod id as declared (lower-case), for `src/core/modrinth` installDependency.
          missingModIds: [dep.modId.toLowerCase()],
        });
      }
    }
    return out;
  },
};
