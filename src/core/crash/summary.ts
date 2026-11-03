/**
 * One-line crash verdict for watch-mode notifications and the in-app banner (M4).
 *
 * Pure. Input: findings from `analyzeCrash` (already ranked: severity, then whether they explain
 * the crash's own trace, then specificity). Only an error-severity crash finding counts
 * (docs/CONTRACTS.md invariant 11): anything else returns null and nothing is notified.
 */
import type { Finding } from '../model';

export interface CrashSummary {
  /** `Modpack crashed — likely cause: …`, at most `HEADLINE_MAX` characters. */
  headline: string;
  /**
   * The top error finding's one-line diagnosis. Null when the analysis only fell back to the
   * innermost `Caused by:` and could not tie it to any jar (the cause is not really known).
   */
  likelyCause: string | null;
  /** File names of the top finding's culprit jars, in order, without duplicates. */
  culpritFiles: string[];
}

export const HEADLINE_MAX = 120;
const PREFIX = 'Modpack crashed';

function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

export function summarizeCrash(findings: readonly Finding[]): CrashSummary | null {
  const top = findings.find((f) => f.severity === 'error' && f.code.startsWith('C-'));
  if (!top) return null;
  const title = oneLine(top.title);
  const culpritFiles = [...new Set(top.culprits.map((c) => c.fileName))];
  const unattributed = top.code === 'C-ROOT-CAUSE' && culpritFiles.length === 0;
  const likelyCause = unattributed || title.length === 0 ? null : title;
  const headline = likelyCause
    ? clip(`${PREFIX} — likely cause: ${likelyCause}`, HEADLINE_MAX)
    : clip(title ? `${PREFIX} — ${title}` : PREFIX, HEADLINE_MAX);
  return { headline, likelyCause, culpritFiles };
}
