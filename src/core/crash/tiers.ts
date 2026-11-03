/** Helpers for tagging anchors with their watch-mode tier (docs/CONTRACTS.md invariant 11). */
import type { CrashAnchor } from '../model';

/** The game cannot continue: watch mode notifies promptly. */
export function fatal(...texts: string[]): CrashAnchor[] {
  return texts.map((text) => ({ text, tier: 'fatal' }));
}

/** Also logged by healthy games: recorded silently, analysed only with a crash/exit. */
export function contextual(...texts: string[]): CrashAnchor[] {
  return texts.map((text) => ({ text, tier: 'contextual' }));
}

/** Deduplicated by text, first-seen order; when tiers disagree, fatal wins. */
export function mergeAnchors(list: readonly CrashAnchor[]): CrashAnchor[] {
  const byText = new Map<string, CrashAnchor>();
  for (const a of list) {
    if (a.text.length === 0) continue;
    const seen = byText.get(a.text);
    if (!seen) byText.set(a.text, { text: a.text, tier: a.tier });
    else if (a.tier === 'fatal') seen.tier = 'fatal';
  }
  return [...byText.values()];
}

export interface WatchHit {
  /** 1-based line number. */
  line: number;
  anchor: string;
}

/**
 * Pure model of watch-mode tailing (the Rust side does the same over new `latest.log` lines):
 * a line containing any fatal anchor is a fatal hit (reported with its first fatal anchor);
 * otherwise a line containing a contextual anchor is a contextual hit.
 */
export function classifyWatchLines(
  lines: readonly string[],
  anchors: readonly CrashAnchor[],
): { fatal: WatchHit[]; contextual: WatchHit[] } {
  const fatalTexts = anchors.filter((a) => a.tier === 'fatal').map((a) => a.text);
  const contextualTexts = anchors.filter((a) => a.tier === 'contextual').map((a) => a.text);
  const out = { fatal: [] as WatchHit[], contextual: [] as WatchHit[] };
  lines.forEach((text, i) => {
    const f = fatalTexts.find((a) => text.includes(a));
    if (f !== undefined) {
      out.fatal.push({ line: i + 1, anchor: f });
      return;
    }
    const c = contextualTexts.find((a) => text.includes(a));
    if (c !== undefined) out.contextual.push({ line: i + 1, anchor: c });
  });
  return out;
}
