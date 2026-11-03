/**
 * Pack identity + jar index. FROZEN signatures (M3 contract); bodies owned by M3 agent H.
 */
import type { Instance, PackOverride, ScanResult } from '../../bindings';
import type { JarIndex, PackContext } from '../model';
import { buildJarIndexImpl } from './jarIndex';
import { resolvePackImpl } from './resolve';

/**
 * Effective pack identity (check 1): `override` > launcher/mrpack metadata > majority across
 * active jars. Never throws; unknown parts are null with `source: 'unknown'`.
 * Full precedence and `source` rules: ./resolve.ts.
 */
export function resolvePack(instance: Instance, scan: ScanResult, override?: PackOverride | null): PackContext {
  try {
    return resolvePackImpl(instance, scan, override);
  } catch {
    const side = override?.side ?? (instance?.side === 'server' ? 'server' : 'client');
    return { mcVersion: null, loader: null, side, source: 'unknown' };
  }
}

/** Lookup tables over active jars (see `JarIndex` docs and ./jarIndex.ts). */
export function buildJarIndex(scan: ScanResult): JarIndex {
  return buildJarIndexImpl(scan);
}

export { describeLoader, describePack } from './describe';
export { isActive, isDisabledChain, topLevelOf } from './active';
export { LOADER_DEP_IDS, LOADER_NAMES, loaderAccepts, mcCompare, mcIs, versionSyntaxFor } from './loaders';
