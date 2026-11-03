/**
 * Pack identity + jar index. FROZEN signatures (M3 contract); bodies owned by M3 agent H.
 */
import type { Instance, PackOverride, ScanResult } from '../../bindings';
import type { JarIndex, PackContext } from '../model';

/**
 * Effective pack identity (check 1): `override` > launcher/mrpack metadata > majority across
 * active jars. Never throws; unknown parts are null with `source: 'unknown'`.
 */
export function resolvePack(instance: Instance, scan: ScanResult, override?: PackOverride | null): PackContext {
  void scan;
  void override;
  return {
    mcVersion: instance.mcVersion,
    loader: instance.loader,
    side: instance.side,
    source: instance.metadataSource === 'launcher' ? 'launcher' : 'unknown',
  };
}

/** Lookup tables over active jars (see `JarIndex` docs). */
export function buildJarIndex(scan: ScanResult): JarIndex {
  void scan;
  return {
    byId: new Map(),
    byModId: new Map(),
    byPackage: new Map(),
    byPackageAnyDepth: new Map(),
    byMixinConfig: new Map(),
    byFileName: new Map(),
  };
}
