/**
 * Sinytra Connector: runs Fabric mods on Forge 1.20.1 (mod id `connectormod`) and NeoForge
 * 1.21.x (`connector`). Rules from docs/research/loader-enforcement.md ("Sinytra Connector"):
 * - Active when an active jar's relevant (natively read) metadata declares or provides one of
 *   those ids, on a Forge or NeoForge pack.
 * - Fabric-only jars (a `fabric.mod.json` entry and no FML metadata the loader reads) are then
 *   loaded as mods: their Fabric entries become *relevant* (checks/context.ts), so there is no
 *   E-WRONG-LOADER for them. Their `minecraft` dependency is still checked strictly with Fabric
 *   semantics (no FML compatibility table), `fabricloader` dependencies are ignored (built-in).
 * - Connector silently skips — so they produce no findings at all:
 *   - the upstream Fabric API jar (`fabric-api` / `fabric_api`; Forgified Fabric API replaces it),
 *   - `mixinextras` on 1.21.x (the loader ships it),
 *   - Fabric mods whose id (normalised `-` → `_`) is already loaded as a native mod.
 * - Dependency ids are matched with `-` → `_` normalisation (FFAPI modules `fabric_api_base`
 *   satisfy `fabric-api-base`), and dependencies on the aliased ids cloth_config ↔ cloth-config2
 *   and playeranimator ↔ player-animator are widened: any version of either id satisfies them,
 *   and `breaks` on them is not enforced.
 * Not modelled: `hiddenMods` in config/connector.json, Connector's runtime mixin safeguard.
 */
import type { JarRecord, ModMeta } from '../../bindings';
import { FABRIC_JSON, mcCompare } from '../pack';

export const CONNECTOR_IDS: readonly string[] = ['connector', 'connectormod'];

export const CONNECTOR_ALIASES: readonly (readonly string[])[] = [
  ['cloth_config', 'cloth-config2'],
  ['playeranimator', 'player-animator'],
];

export function normalizeId(id: string): string {
  return id.replace(/-/g, '_');
}

/** The alias group containing `id` (normalised comparison), or null. */
export function aliasGroup(id: string): readonly string[] | null {
  const n = normalizeId(id);
  return CONNECTOR_ALIASES.find((g) => g.some((a) => normalizeId(a) === n)) ?? null;
}

export interface ConnectorView {
  /** Connector is installed and active in this pack. */
  readonly active: boolean;
  /** Fabric entries Connector loads from this jar ([] when not a Fabric-only jar). */
  mods(jar: JarRecord): ModMeta[];
  /** Why Connector silently skips this Fabric-only jar, or null. */
  ignored(jar: JarRecord): string | null;
  /** The jar's mods are loaded through Connector. */
  via(jar: JarRecord): boolean;
}

export const NO_CONNECTOR: ConnectorView = { active: false, mods: () => [], ignored: () => null, via: () => false };

export function connectorView(args: {
  packLoader: string;
  mc: string | null;
  active: readonly JarRecord[];
  /** Natively relevant entries (file read + loader accepted). */
  baseRelevant: (jar: JarRecord) => ModMeta[];
}): ConnectorView {
  const { packLoader, mc, active, baseRelevant } = args;
  if (packLoader !== 'forge' && packLoader !== 'neoforge') return NO_CONNECTOR;
  const declares = (m: ModMeta, ids: readonly string[]): boolean => [m.modId, ...m.provides].some((id) => ids.includes(id));
  const on = active.some((j) => baseRelevant(j).some((m) => declares(m, CONNECTOR_IDS)));
  if (!on) return NO_CONNECTOR;

  const native = new Set<string>();
  for (const j of active) for (const m of baseRelevant(j)) for (const id of [m.modId, ...m.provides]) native.add(normalizeId(id));
  const mc121 = (mcCompare(mc, '1.21') ?? -1) >= 0;

  const memo = new Map<string, { mods: ModMeta[]; ignored: string | null }>();
  const view = (jar: JarRecord): { mods: ModMeta[]; ignored: string | null } => {
    const hit = memo.get(jar.id);
    if (hit) return hit;
    let out: { mods: ModMeta[]; ignored: string | null } = { mods: [], ignored: null };
    const fabricEntries = jar.mods.filter((m) => m.metadataFile === FABRIC_JSON && m.loader === 'fabric');
    if (fabricEntries.length > 0 && baseRelevant(jar).length === 0) {
      const ids = fabricEntries.map((m) => normalizeId(m.modId));
      const dup = ids.find((id) => native.has(id));
      if (ids.includes('fabric_api')) out = { mods: [], ignored: 'Connector ignores the upstream Fabric API; Forgified Fabric API is used instead' };
      else if (mc121 && ids.includes('mixinextras')) out = { mods: [], ignored: 'Connector skips MixinExtras; the loader ships it' };
      else if (dup !== undefined) out = { mods: [], ignored: `Connector skips it: "${dup}" is already loaded as a native mod` };
      else out = { mods: fabricEntries, ignored: null };
    }
    memo.set(jar.id, out);
    return out;
  };
  return {
    active: true,
    mods: (jar) => view(jar).mods,
    ignored: (jar) => view(jar).ignored,
    via: (jar) => view(jar).mods.length > 0,
  };
}
