/**
 * W-MRPACK-DOWNLOAD (warning, CONTRACTS invariant 15): a `.mrpack` index file lists a download URL
 * whose host is outside Modrinth's allowlist. Placeholder registered with the contract; the M7 core
 * agent implements it (`ScanResult.declared[].downloads`).
 */
import type { Check } from '../model';

export const mrpackDownloadCheck: Check = {
  id: 'mrpack-download',
  codes: ['W-MRPACK-DOWNLOAD'],
  run() {
    return [];
  },
};
