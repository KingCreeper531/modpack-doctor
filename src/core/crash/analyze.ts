/** Runs every crash pattern over a digest and orders the findings. */
import type { CrashInput, CrashPattern, Finding, FindingCode, Severity } from '../model';
import { fabricIncompatPattern } from './patterns/fabricIncompat';
import { javaVersionPattern } from './patterns/javaVersion';
import { missingDepsPattern } from './patterns/missingDeps';
import { mixinPattern } from './patterns/mixin';
import { nativePattern } from './patterns/native';
import { noClassDefPattern } from './patterns/noClassDef';
import { oomPattern } from './patterns/oom';
import { resolutionPattern } from './patterns/resolution';
import { rootCausePattern } from './patterns/rootCause';
import { suspectedPattern } from './patterns/suspected';

export { digestFromText } from './text';

/** Most specific first; C-ROOT-CAUSE last (fallback only). */
export const CRASH_PATTERNS: readonly CrashPattern[] = [
  javaVersionPattern,
  oomPattern,
  nativePattern,
  missingDepsPattern,
  fabricIncompatPattern,
  resolutionPattern,
  mixinPattern,
  noClassDefPattern,
  suspectedPattern,
  rootCausePattern,
];

const CODE_RANK: Partial<Record<FindingCode, number>> = {
  'C-JAVA-VERSION': 0,
  'C-OOM': 1,
  'C-NATIVE': 2,
  'C-MISSING-MANDATORY': 3,
  'C-FABRIC-INCOMPAT': 4,
  'C-RESOLUTION': 5,
  'C-MIXIN': 6,
  'C-NOCLASSDEF': 7,
  'C-SUSPECTED': 8,
  'C-ROOT-CAUSE': 9,
};

const SEVERITY_RANK: Record<Severity, number> = { error: 0, warning: 1, info: 2 };

function firstLine(f: Finding): number {
  for (const e of f.evidence) {
    if (e.kind === 'log') {
      const culprit = e.lines.find((l) => l.role === 'culprit') ?? e.lines[0];
      if (culprit) return culprit.n;
    }
  }
  return Number.MAX_SAFE_INTEGER;
}

/**
 * Classifies a crash report / log digest. Findings are de-duplicated by id and ordered by
 * severity, then specificity (wrong Java, memory, native, dependencies, mixin, missing class,
 * suspected mods), then position in the log. C-ROOT-CAUSE is added only when no other
 * error-severity finding exists.
 */
export function analyzeCrash(input: CrashInput): Finding[] {
  const byId = new Map<string, Finding>();
  for (const pattern of CRASH_PATTERNS) {
    if (pattern === rootCausePattern) continue;
    for (const f of pattern.match(input)) if (!byId.has(f.id)) byId.set(f.id, f);
  }
  if (![...byId.values()].some((f) => f.severity === 'error')) {
    for (const f of rootCausePattern.match(input)) if (!byId.has(f.id)) byId.set(f.id, f);
  }
  const ranked = [...byId.values()].map((f) => ({ f, line: firstLine(f) }));
  ranked.sort(
    (a, b) =>
      SEVERITY_RANK[a.f.severity] - SEVERITY_RANK[b.f.severity] ||
      (CODE_RANK[a.f.code] ?? 99) - (CODE_RANK[b.f.code] ?? 99) ||
      a.line - b.line ||
      a.f.id.localeCompare(b.f.id),
  );
  return ranked.map((r) => r.f);
}
