/**
 * E-DEP-RANGE (error; info via FML compatibility override): a dependency is present, but the
 * version the loader would use is outside the declared range.
 * - Which dependencies: `required` ones; for Forge/NeoForge/Legacy Forge also `optional` ones,
 *   because FML enforces an optional dependency's range whenever that mod is installed. Fabric
 *   `recommends`/`suggests` only log a warning, so they are skipped. Deps whose Forge `side`
 *   excludes the pack side are skipped (FML filters by side first).
 * - `minecraft` / `forge` / `neoforge` dependencies: the entry's `mcRange` / `loaderRange` dep is
 *   owned by E-MC-RANGE / E-LOADER-RANGE; any other such dep is evaluated here against the pack
 *   with the same FML `VersionSupportMatrix` rule (`platformFinding`). Other built-ins (java,
 *   fabricloader, …) are skipped.
 * - FML entries: a provider whose version is an unresolved placeholder (contains `${`) or
 *   `0.0NONE` passes (FML substitutes `0.0NONE`, which passes every dependency check).
 * - Which version: `CheckContext.versionProviders` — a top-level provider wins over bundled
 *   copies; among JarJar copies only the one FML selects (highest version inside every copy's
 *   JarJar range); among Fabric/Quilt JiJ copies any one may be chosen by the resolver. For a
 *   `provides` alias the provider's own version is used, as Fabric does.
 * - No finding when any candidate satisfies the range, or when `satisfies` returns null.
 * Fixes: manual (install a matching version of the dependency); disable the dependent jar.
 * With Modrinth, `src/core/modrinth/depRangeFix.ts` names the concrete version and adds `replace`.
 */
import type { Dependency } from '../../bindings';
import type { Check, Finding, JarRef } from '../model';
import { describeFallback, evaluateRange, LOADER_DEP_IDS, LOADER_NAMES } from '../pack';
import { versionApi } from '../version';
import { isBuiltinDependency } from './builtins';
import { aliasGroup } from './connector';
import { isPlaceholderVersion } from './duplicates';
import { contextFor, type CheckContext, type ModEntry } from './context';
import {
  dependencyLines,
  describeRange,
  disable,
  entryEvidence,
  entryLabel,
  entryRef,
  jarRef,
  makeFinding,
  manual,
  modName,
  rangeDependency,
  rawRange,
} from './evidence';
import { depSideApplies } from './missingDep';
import { depRangeText } from './depRangeText';

/** Dependencies on the game or the FML loader mod: versions come from the pack, not a jar. */
const PLATFORM_IDS: readonly string[] = ['minecraft', 'forge', 'neoforge'];

/**
 * A `minecraft`/`forge`/`neoforge` dependency that E-MC-RANGE / E-LOADER-RANGE do not already
 * cover (they own the entry's `mcRange` / `loaderRange` dependency). Same verdict rules: FML
 * `VersionSupportMatrix` fallbacks → info; excluded by everything → error. A loader-mod
 * dependency is only evaluated against the pack's own loader (other loaders' numbering is not
 * mappable).
 */
function platformFinding(ctx: CheckContext, e: ModEntry, dep: Dependency): Finding | null {
  if (dep === rangeDependency(e.mod, ['minecraft']) || dep === rangeDependency(e.mod, LOADER_DEP_IDS[e.mod.loader])) return null;
  const loader = ctx.pack.loader;
  const actual = dep.modId === 'minecraft' ? ctx.pack.mcVersion : loader && loader.kind === dep.modId ? loader.version : null;
  if (!actual) return null;
  const subject = dep.modId === 'minecraft' ? 'minecraft' : 'other';
  const verdict = evaluateRange(actual, dep.range, subject, dep.modId, { loader: loader?.kind, mc: ctx.pack.mcVersion, loaderVersion: loader?.version ?? null });
  if (verdict.kind === 'pass' || verdict.kind === 'unknown') return null;
  const name = modName(e.mod);
  const target = dep.modId === 'minecraft' ? 'Minecraft' : LOADER_NAMES[loader?.kind ?? 'unknown'];
  const wants = describeRange(dep.range, subject);
  const evidence = entryEvidence(ctx, e, dependencyLines(e.mod, dep.modId, dep.kind));
  if (verdict.kind === 'fallback') {
    const via = describeFallback(verdict, dep.modId);
    return makeFinding({
      code: 'E-DEP-RANGE',
      severity: 'info',
      title: `${name} declares ${target} ${rawRange(dep.range)}; loads on ${actual} through a compatibility override`,
      explanation: `${entryLabel(e)} declares ${target} ${wants} (${rawRange(dep.range)}), which does not include ${actual}. It still loads through ${via}. Nothing to do unless the mod misbehaves.`,
      culprits: [entryRef(e)],
      evidence: [...evidence.slice(0, -1), { kind: 'note', text: `Accepted through ${via}.` }, ctx.packNote],
      fixes: [manual(`Optional: install a version of ${name} that declares support for ${target} ${actual}.`)],
      discriminator: `${e.mod.modId}->${dep.modId}`,
    });
  }
  return makeFinding({
    code: 'E-DEP-RANGE',
    severity: 'error',
    title: `${name} needs ${target} ${wants}, but the pack has ${actual}`,
    explanation: `${entryLabel(e)} depends on ${target} ${wants} (${rawRange(dep.range)}), and this pack runs ${actual}. The loader stops at startup with a dependency error. Install a build of ${name} for ${target} ${actual}, or disable it.`,
    culprits: [entryRef(e)],
    evidence,
    fixes: [manual(`Replace ${e.top.fileName} with a version of ${name} made for ${target} ${actual}.`), disable(e.top)],
    discriminator: `${e.mod.modId}->${dep.modId}`,
  });
}

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
        if (!depSideApplies(dep, ctx.pack.side)) continue;
        if (PLATFORM_IDS.includes(dep.modId)) {
          const f = platformFinding(ctx, e, dep);
          if (f) out.push(f);
          continue;
        }
        if (isBuiltinDependency(dep.modId, ctx.pack)) continue;
        if (ctx.connector.via(e.jar) && aliasGroup(dep.modId)) continue; // widened to * by Connector
        const providers = ctx.versionProviders(dep.modId, ctx.connector.via(e.jar)).filter((p) => p.jar.id !== e.jar.id);
        // FML: an unresolved `${file.jarVersion}` becomes `0.0NONE`, which passes every check.
        if (fml && providers.some((p) => isPlaceholderVersion(p.mod.version))) continue;
        if (providers.length === 0) continue;
        if (providers.some((p) => versionApi.satisfies(p.mod.version, dep.range, 'other') !== false)) continue;

        const culprits: JarRef[] = [entryRef(e)];
        for (const p of providers) {
          if (!culprits.some((c) => c.jarId === p.top.id)) culprits.push(jarRef(p.top, dep.modId));
        }
        // Wording (range in words, installed version, what to switch to): depRangeText.ts.
        const text = depRangeText(ctx, e, dep, providers);
        out.push(
          makeFinding({
            code: 'E-DEP-RANGE',
            severity: 'error',
            title: text.title,
            explanation: text.explanation,
            culprits,
            evidence: entryEvidence(ctx, e, dependencyLines(e.mod, dep.modId, dep.kind), text.installedNote),
            fixes: text.fixes,
            discriminator: `${e.mod.modId}->${dep.modId}`,
          }),
        );
      }
    }
    return out;
  },
};
