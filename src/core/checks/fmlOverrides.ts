/**
 * NeoForge FML dependency overrides (`config/fml.toml`), docs/research/loader-enforcement.md,
 * "Instance config files". Read from source (FancyModLoader `FMLConfig.load`,
 * `ModSorter.verifyDependencyVersions`):
 * - Syntax: `dependencyOverrides.<target> = ["-dep", "+dep"]` (or a single string), any TOML form.
 *   `-dep` removes **every** dependency entry of mod `<target>` on `dep` — required, optional,
 *   incompatible and discouraged alike — before FML checks them, so nothing about `dep` is
 *   enforced for `<target>` any more: not presence, not the version range, not incompatibility.
 *   That includes the `minecraft` and `neoforge` dependencies (they are ordinary entries there).
 *   `+dep` only adds load ordering; it never changes a check. Ids match exactly (case-sensitive,
 *   no `-`/`_` folding); an entry not starting with `+`/`-` is ignored by FML (logged).
 * - Only FML's own dependency check: Fabric mods loaded through Sinytra Connector are resolved by
 *   Fabric's solver, which never reads fml.toml, so their dependencies are not affected.
 * - Versions: NeoForge only — FML 4.0.34 = NeoForge **21.1.81** (MC 1.21.1), FML 5.0.6 = NeoForge
 *   **21.3.41-beta** (1.21.3), every NeoForge for 1.21.4+ (FML 6.0.4+) and 26.x. Not NeoForge
 *   20.x / 21.0 / 21.2 or 47.1 (1.20.1), and no Forge version has it. When the NeoForge version is
 *   unknown on 1.21.1 / 1.21.3 (or the MC version is unknown), overrides are applied and the
 *   wording says it assumed so (as for the FML compatibility table).
 *
 * Effect on findings (`relaxByOverride`): a finding about `<target>`'s constraint on `dep` that
 * the override removes (E-MISSING-DEP, E-DEP-RANGE, E-MC-RANGE, E-LOADER-RANGE, E-INCOMPAT) is
 * kept at **info**, says the constraint is overridden in config/fml.toml, and carries no fixes
 * that act on files (the game starts; the override is the user's choice). Where the override
 * exists in the file but this loader doesn't support it, the finding is unchanged plus a note
 * saying the override has no effect.
 */
import type { LoaderConfig } from '../../bindings';
import type { Finding, PackContext } from '../model';
import { mcCompare, mcIs } from '../pack';
import { versionApi } from '../version';
import type { CheckContext, ModEntry } from './context';
import { manual, modName } from './evidence';

export const FML_TOML = 'config/fml.toml';

export type OverrideSupport =
  | { kind: 'yes' }
  /** Applied, but only assumed: the loader version is unknown. `since` names the first build. */
  | { kind: 'assumed'; since: string }
  /** The running loader has no dependency overrides; `why` completes "…, so it has no effect". */
  | { kind: 'no'; why: string };

const SINCE_1_21_1 = '21.1.81';
const SINCE_1_21_3 = '21.3.41-beta';

/** Whether the pack's loader applies `dependencyOverrides` from config/fml.toml. */
export function fmlOverrideSupport(pack: PackContext): OverrideSupport {
  const loader = pack.loader;
  if (!loader || loader.kind !== 'neoforge') {
    return { kind: 'no', why: `${loader?.kind === 'forge' ? 'Forge has' : 'only NeoForge has'} no dependency overrides` };
  }
  const tooOld = (v: string): OverrideSupport => ({
    kind: 'no',
    why: `NeoForge ${v} predates dependency overrides (NeoForge ${SINCE_1_21_1} on 1.21.1, ${SINCE_1_21_3} on 1.21.3, every 1.21.4+ build)`,
  });
  const v = loader.version?.trim() || null;
  const parts = v?.split('.') ?? [];
  const major = Number.parseInt(parts[0] ?? '', 10);
  const minor = Number.parseInt(parts[1] ?? '', 10);
  if (v && Number.isFinite(major) && Number.isFinite(minor)) {
    // Year-based NeoForge (26.x, MC 26.1+) is on FML main. 47.x is NeoForge for 1.20.1.
    if (major >= 26 && major !== 47) return { kind: 'yes' };
    if (major === 21) {
      if (minor >= 4) return { kind: 'yes' };
      if (minor === 1) return versionApi.compare(v, SINCE_1_21_1, 'maven', 'other') >= 0 ? { kind: 'yes' } : tooOld(v);
      if (minor === 3) return versionApi.compare(v, SINCE_1_21_3, 'maven', 'other') >= 0 ? { kind: 'yes' } : tooOld(v);
      return tooOld(v); // 21.0 (1.21), 21.2 (1.21.2)
    }
    return tooOld(v); // 20.x, 47.x (NeoForge 1.20.1)
  }
  const mc = pack.mcVersion;
  if (mc === null) return { kind: 'assumed', since: SINCE_1_21_1 };
  if ((mcCompare(mc, '1.21.4') ?? -1) >= 0) return { kind: 'yes' };
  if (mcIs(mc, '1.21.1')) return { kind: 'assumed', since: SINCE_1_21_1 };
  if (mcIs(mc, '1.21.3')) return { kind: 'assumed', since: SINCE_1_21_3 };
  return { kind: 'no', why: `NeoForge for Minecraft ${mc} has no dependency overrides (they start with NeoForge ${SINCE_1_21_1} on 1.21.1)` };
}

/** An override line in config/fml.toml that removes `target`'s constraints on `dep`. */
export interface OverrideMatch {
  target: string;
  dep: string;
  support: OverrideSupport;
}

export interface FmlOverrideView {
  readonly support: OverrideSupport;
  /**
   * The `-dep` override of this FML entry's mod id, or null. Never for Fabric/Quilt entries
   * (`viaConnector`, or a Fabric/Quilt loader): Fabric's resolver doesn't read fml.toml.
   */
  match(e: ModEntry, depId: string, viaConnector: boolean): OverrideMatch | null;
}

export function fmlOverrideView(config: LoaderConfig | null | undefined, pack: PackContext): FmlOverrideView {
  const support = fmlOverrideSupport(pack);
  const removed = new Map<string, Set<string>>();
  for (const o of config?.fmlDependencyOverrides ?? []) {
    const set = removed.get(o.modId) ?? new Set<string>();
    for (const entry of o.entries) if (entry.startsWith('-')) set.add(entry.slice(1));
    removed.set(o.modId, set);
  }
  return {
    support,
    match(e, depId, viaConnector) {
      if (removed.size === 0 || viaConnector || e.mod.loader === 'fabric' || e.mod.loader === 'quilt') return null;
      return removed.get(e.mod.modId)?.has(depId) ? { target: e.mod.modId, dep: depId, support } : null;
    },
  };
}

function overrideLine(m: OverrideMatch): string {
  return `dependencyOverrides.${m.target} = "-${m.dep}"`;
}

/**
 * Apply config/fml.toml to a finding about `e`'s constraint on `depId`: lowered to info when the
 * loader honours the override, annotated when it doesn't, unchanged when there is none.
 */
export function relaxByOverride(ctx: CheckContext, e: ModEntry, depId: string, finding: Finding): Finding {
  const m = ctx.fmlOverrides.match(e, depId, ctx.connector.via(e.jar));
  if (!m) return finding;
  const head = finding.evidence.slice(0, -1);
  const last = finding.evidence.slice(-1);
  if (m.support.kind === 'no') {
    const note = `${FML_TOML} has ${overrideLine(m)}, but ${m.support.why}, so it has no effect.`;
    return { ...finding, evidence: [...head, { kind: 'note', text: note }, ...last] };
  }
  const assumed =
    m.support.kind === 'assumed'
      ? ` (Assumed: dependency overrides exist from NeoForge ${m.support.since}, and the installed version is unknown.)`
      : '';
  const name = modName(e.mod);
  const { missingModIds: _dropped, ...rest } = finding;
  return {
    ...rest,
    severity: 'info',
    title: `${finding.title} — overridden in ${FML_TOML}`,
    explanation:
      `${FML_TOML} removes ${name}'s dependency constraints on "${m.dep}" (${overrideLine(m)}), so NeoForge doesn't check them and starts anyway. ` +
      `Without the override: ${finding.title}. Overrides are at your own risk: if ${name} really needs this, it can still crash later.${assumed}`,
    evidence: [...head, { kind: 'note', text: `Relaxed by ${FML_TOML}: ${overrideLine(m)}.${assumed}` }, ...last],
    fixes: [manual(`Nothing to do while the game starts. To have NeoForge enforce this again, remove "-${m.dep}" from dependencyOverrides.${m.target} in ${FML_TOML}.`)],
  };
}
