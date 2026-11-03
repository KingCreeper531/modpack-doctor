/**
 * The single anchor list (docs/CONTRACTS.md invariant 11): passed to `read_log_digest` (digest
 * prefilter) and `set_watch` (latest.log tailing). Literal, case-sensitive substrings.
 */
import { CRASH_PATTERNS } from './analyze';
import { CRASH_SIGNALS } from './context';

/** Structure the patterns read but that is not a failure by itself. */
const STRUCTURE: readonly string[] = [
  'A detailed walkthrough of the error',
  '-- System Details --',
  '/FATAL]',
];

function dedupe(list: readonly string[]): string[] {
  return [...new Set(list.filter((a) => a.length > 0))];
}

/** Deduped union of every pattern's anchors, the crash signals and structural markers. */
export const CRASH_ANCHORS: readonly string[] = dedupe([
  ...CRASH_SIGNALS,
  ...STRUCTURE,
  ...CRASH_PATTERNS.flatMap((p) => p.anchors),
]);

/**
 * Proposal (not yet in the contract): the subset that only appears when loading or the game
 * actually failed, for watch-mode triggers. Generic anchors such as `Caused by: ` or
 * `ClassNotFoundException` also occur in harmless WARN/DEBUG lines of a normal launch.
 */
export const CRASH_TRIGGER_ANCHORS: readonly string[] = dedupe([...CRASH_SIGNALS, '/FATAL]', 'Mixin apply failed', 'Mixin apply for mod ']);
