/** View hooks for fix buttons and work orders (M6). */
import { fixBlockReason } from '../app/derive';
import { useApp } from '../app/StoreContext';

/**
 * Why the instance's fix buttons are disabled, or null: a work order of another instance is open
 * (only one order is shown at a time), the scan has not finished, or the pack identity is unknown.
 * An open order of this instance needs no words: it is on screen.
 */
export function useFixBlock(instanceId: string): string | null {
  return useApp((s) => {
    const o = s.order;
    if (o && o.instanceId !== instanceId) {
      const name = s.discovery?.instances.find((i) => i.id === o.instanceId)?.name ?? 'another instance';
      return `A work order for ${name} is open. Close or cancel it first.`;
    }
    return fixBlockReason(s.scans[instanceId]);
  });
}
