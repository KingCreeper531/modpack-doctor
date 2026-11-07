/**
 * Static checks. FROZEN signatures (M3 contract); bodies owned by M3 agent H.
 * How to add a check: ./README.md.
 */
import type { Check, CheckInput, Finding, Severity } from '../model';
import { clientOnServerCheck } from './clientOnServer';
import { corruptJarCheck } from './corruptJar';
import { depRangeCheck } from './depRange';
import { dupIdCheck } from './dupId';
import { incompatCheck } from './incompat';
import { javaClassCheck } from './javaClass';
import { loaderRangeCheck } from './loaderRange';
import { mcRangeCheck } from './mcRange';
import { missingDepCheck } from './missingDep';
import { notOnModrinthCheck } from './notOnModrinth';
import { mrpackDeclaredCheck } from './mrpackDeclared';
import { mrpackDownloadCheck } from './mrpackDownload';
import { splitPkgCheck } from './splitPkg';
import { wrongLoaderCheck } from './wrongLoader';

/** Every registered check, in run order. */
export const CHECKS: readonly Check[] = [
  wrongLoaderCheck,
  mcRangeCheck,
  loaderRangeCheck,
  missingDepCheck,
  depRangeCheck,
  dupIdCheck,
  splitPkgCheck,
  incompatCheck,
  clientOnServerCheck,
  corruptJarCheck,
  javaClassCheck,
  notOnModrinthCheck,
  mrpackDeclaredCheck,
  mrpackDownloadCheck,
];

const SEVERITY_RANK: Readonly<Record<Severity, number>> = { error: 0, warning: 1, info: 2 };

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Sort order of `runChecks`: severity, code, first culprit's file name, then id. */
export function compareFindings(a: Finding, b: Finding): number {
  return (
    SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
    cmp(a.code, b.code) ||
    cmp(a.culprits[0]?.fileName ?? '', b.culprits[0]?.fileName ?? '') ||
    cmp(a.id, b.id)
  );
}

/**
 * Run every check. Result is deterministic and sorted: severity (error, warning, info), then
 * code, then first culprit file name. Finding ids are stable across rescans.
 * Findings with the same id are reported once (the first wins). A check that throws is skipped
 * so one bug cannot hide every other finding.
 */
export function runChecks(input: CheckInput): Finding[] {
  const seen = new Set<string>();
  const out: Finding[] = [];
  // CONTRACTS invariant 15: a .mrpack is read-only; no finding on it carries fixes.
  const readOnly = input.instance.launcher === 'mrpack';
  for (const check of CHECKS) {
    let found: Finding[];
    try {
      found = check.run(input);
    } catch {
      continue;
    }
    for (const f of found) {
      if (seen.has(f.id)) continue;
      seen.add(f.id);
      out.push(readOnly && f.fixes.length > 0 ? { ...f, fixes: [] } : f);
    }
  }
  return out.sort(compareFindings);
}
