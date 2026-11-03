/** Loader display names and short codes. Pure. */
import type { LoaderKind } from '../../bindings';

export const LOADER_NAME: Record<LoaderKind, string> = {
  forge: 'Forge',
  neoforge: 'NeoForge',
  fabric: 'Fabric',
  quilt: 'Quilt',
  legacyforge: 'Legacy Forge',
  unknown: 'Unknown loader',
};

/** Three-letter codes for the 80px mod-table loader column (DESIGN.md §6.6). */
export const LOADER_ABBR: Record<LoaderKind, string> = {
  forge: 'FRG',
  neoforge: 'NEO',
  fabric: 'FAB',
  quilt: 'QLT',
  legacyforge: 'LFG',
  unknown: '?',
};
