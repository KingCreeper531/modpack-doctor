/**
 * E-SPLIT-PKG (error) / I-SPLIT-PKG (info): the same Java package is in the *own* classes of two
 * or more loaded top-level jars (`JarIndex.byPackage`; nested jars never count, so two mods
 * bundling the same library are not reported).
 * - Error on Forge/NeoForge from MC 1.17 (or unknown MC): their JPMS module layer refuses split
 *   packages with `ResolutionException: Module X reads package Y from both A and B`.
 * - Info otherwise (Fabric/Quilt, Forge before 1.17, Legacy Forge, unknown loader): no module
 *   layer, one copy of each class silently wins.
 * - Jars that are already E-DUP-ID duplicates of each other are not reported again.
 * - All packages shared by the same set of jars are grouped into one finding.
 * - Fix: disable one jar. Preferred first: a jar no other loaded mod requires (disabling it
 *   cannot cause a missing dependency), then the jar with fewer dependents; ties → file name.
 *   One `disable` per culprit, in that order.
 */
import type { JarRecord } from '../../bindings';
import type { Check, Finding } from '../model';
import { LOADER_NAMES, mcCompare } from '../pack';
import { contextFor, type CheckContext } from './context';
import { disable, jarRef, listText, makeFinding, plural } from './evidence';

function isFatal(ctx: CheckContext): boolean {
  const kind = ctx.pack.loader?.kind;
  if (kind !== 'forge' && kind !== 'neoforge') return false;
  const c = mcCompare(ctx.pack.mcVersion, '1.17');
  return c === null || c >= 0;
}

/** Number of other loaded top-level jars with a required dependency on one of `jar`'s ids. */
function dependents(ctx: CheckContext, jar: JarRecord): JarRecord[] {
  const ids = new Set(ctx.loaded(jar).flatMap((m) => [m.modId, ...m.provides]));
  if (ids.size === 0) return [];
  return ctx.loadedTopLevel.filter(
    (other) => other.id !== jar.id && ctx.loaded(other).some((m) => m.deps.some((d) => d.kind === 'required' && ids.has(d.modId))),
  );
}

export const splitPkgCheck: Check = {
  id: 'split-packages',
  codes: ['E-SPLIT-PKG', 'I-SPLIT-PKG'],
  run(input) {
    const ctx = contextFor(input);
    const loadedTop = new Set(ctx.loadedTopLevel.map((j) => j.id));
    const groups = new Map<string, { jars: JarRecord[]; packages: string[] }>();
    for (const [pkg, owners] of ctx.index.byPackage) {
      const jars = owners.filter((j) => loadedTop.has(j.id));
      if (jars.length < 2) continue;
      const key = jars.map((j) => j.id).sort().join('\n');
      const g = groups.get(key) ?? { jars: [...jars].sort((a, b) => (a.id < b.id ? -1 : 1)), packages: [] };
      g.packages.push(pkg);
      groups.set(key, g);
    }

    const fatal = isFatal(ctx);
    const loaderName = ctx.pack.loader ? LOADER_NAMES[ctx.pack.loader.kind] : 'this loader';
    const out: Finding[] = [];
    for (const { jars, packages } of groups.values()) {
      const idSets = jars.map((j) => new Set(ctx.relevant(j).map((m) => m.modId)));
      const first = idSets[0];
      if (first && [...first].some((id) => idSets.every((s) => s.has(id)))) continue; // E-DUP-ID covers it
      packages.sort();
      const deps = new Map(jars.map((j) => [j.id, dependents(ctx, j)] as const));
      const order = [...jars].sort(
        (a, b) =>
          (deps.get(a.id)?.length ?? 0) - (deps.get(b.id)?.length ?? 0) ||
          (a.fileName < b.fileName ? -1 : a.fileName > b.fileName ? 1 : 0),
      );
      const names = jars.map((j) => j.fileName);
      const pkgText = listText(packages, 4);
      const recommended = order[0];
      const recDeps = recommended ? (deps.get(recommended.id) ?? []) : [];
      const why = recommended
        ? recDeps.length === 0
          ? `Disabling ${recommended.fileName} is suggested first because no other mod requires it.`
          : `Every jar involved is required by another mod; ${recommended.fileName} has the fewest dependents (${recDeps.map((d) => d.fileName).join(', ')}).`
        : '';
      const impact = fatal
        ? `${loaderName} puts every mod on a Java module layer, which refuses a package that comes from two jars: the game stops with "ResolutionException: Module … reads package ${packages[0]} from both …".`
        : `${loaderName} has no module layer, so this usually loads, but only one copy of each class wins and the other jar may misbehave.`;
      out.push(
        makeFinding({
          code: fatal ? 'E-SPLIT-PKG' : 'I-SPLIT-PKG',
          severity: fatal ? 'error' : 'info',
          title: `${listText(names, 3)} ${jars.length === 2 ? 'both' : 'all'} contain package ${packages[0]}${packages.length > 1 ? ` (+${packages.length - 1} more)` : ''}`,
          explanation: `${names.join(' and ')} each ship their own copy of ${plural(packages.length, 'Java package')} (${pkgText}). ${impact} ${why}`,
          culprits: jars.map((j) => jarRef(j, ctx.relevant(j)[0]?.modId)),
          evidence: [
            { kind: 'note', text: `Shared ${packages.length === 1 ? 'package' : 'packages'}: ${packages.join(', ')}.` },
            ...jars.map((j) => ({ kind: 'note' as const, text: `${j.fileName}${j.moduleName ? ` (module ${j.moduleName})` : ''}: ${plural(j.packages.length, 'package')} of its own.` })),
            ctx.packNote,
          ],
          fixes: order.map(disable),
          discriminator: '',
        }),
      );
    }
    return out;
  },
};
