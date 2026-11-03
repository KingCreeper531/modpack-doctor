/**
 * Static checks. FROZEN signatures (M3 contract); bodies owned by M3 agent H.
 */
import type { Check, CheckInput, Finding } from '../model';

/** Every registered check, in run order. */
export const CHECKS: readonly Check[] = [];

/**
 * Run every check. Result is deterministic and sorted: severity (error, warning, info), then
 * code, then first culprit file name. Finding ids are stable across rescans.
 */
export function runChecks(input: CheckInput): Finding[] {
  return CHECKS.flatMap((c) => c.run(input));
}
