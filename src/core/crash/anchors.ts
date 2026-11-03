/**
 * The single anchor list (docs/CONTRACTS.md invariant 11). Every anchor is a literal,
 * case-sensitive substring with its watch tier:
 * - `CRASH_ANCHORS` (text + tier) goes to `set_watch`;
 * - `CRASH_ANCHOR_TEXTS` (every text, regardless of tier) goes to `read_log_digest`.
 */
import type { CrashAnchor } from '../model';
import { CRASH_PATTERNS } from './analyze';
import { CRASH_SIGNALS } from './context';
import { contextual, mergeAnchors } from './tiers';

/** Structure the patterns read but that is not a failure by itself. */
const STRUCTURE: readonly CrashAnchor[] = contextual(
  'A detailed walkthrough of the error',
  '-- System Details --',
  // Some mods log at FATAL for recoverable problems; FML's own fatal lines carry fatal anchors.
  '/FATAL]',
);

/** Deduplicated by text (fatal wins when two sources disagree on the tier). */
export const CRASH_ANCHORS: readonly CrashAnchor[] = mergeAnchors([
  ...CRASH_SIGNALS,
  ...STRUCTURE,
  ...CRASH_PATTERNS.flatMap((p) => p.anchors),
]);

/** Every anchor text, for the digest prefilter. */
export const CRASH_ANCHOR_TEXTS: readonly string[] = CRASH_ANCHORS.map((a) => a.text);
