/**
 * C-MISSING-MANDATORY: Forge/NeoForge `ModSorter` dependency errors (crash-formats.md §3.4):
 * `Missing or unsupported mandatory dependencies:` + `\tMod ID: 'x', Requested by: 'y',
 * Expected range: '…', Actual version: '…'` lines, and the translated
 * `Mod y requires x 1.0 or above` / `Currently, x is not installed` text.
 */
import type { CrashPattern, Finding, Severity } from '../../model';
import { ctxOf, disable, finding, gate, listText, logEvidence, manual, refs, worst, type Ctx } from '../context';
import { jarsForModId, uniqueTopLevel } from '../jars';
import { contiguous, logMessage, stripFormatting } from '../text';
import { contextual, fatal } from '../tiers';

const MOD_ID_LINE = /^\s*Mod ID: '([^']+)', Requested by: '([^']+)', Expected range: '([^']*)', Actual version: '([^']*)'/;
const TRANSLATED = /(?:^|[\s:-])Mod ([\w.-]+) requires ([\w.-]+) (.+?)\s*$/;
const CURRENTLY = /Currently, ([\w.-]+) is (.+?)\.?\s*$/;
const PLATFORM = new Set(['minecraft', 'forge', 'neoforge', 'fml', 'javafml', 'lowcodefml']);
const MISSING_VALUES = new Set(['[MISSING]', 'not installed', '']);

interface Requirement {
  requester: string;
  range: string;
}

interface Dep {
  depId: string;
  requirements: Requirement[];
  actual: string;
  lineIdx: number[];
  severity: Severity | null;
}

/** Human text for a Maven range (`[13.0.0,)` → "13.0.0 or newer"); unknown shapes are returned as is. */
export function describeMavenRange(range: string): string {
  const r = range.trim();
  if (r === '' || r === '*' || r === '[0,)' || r === '(,)') return 'any version';
  let m = /^\[([^,\]]+),\s*\)$/.exec(r);
  if (m) return `${m[1]} or newer`;
  m = /^\[([^,\]]+),\s*([^,\]]+)\)$/.exec(r);
  if (m) return `${m[1]} up to (not including) ${m[2]}`;
  m = /^\[([^,\]]+),\s*([^,\]]+)\]$/.exec(r);
  if (m) return `${m[1]} to ${m[2]}`;
  m = /^\[([^,\]]+)\]$/.exec(r);
  if (m) return `exactly ${m[1]}`;
  m = /^\(,\s*([^,\]]+)\)$/.exec(r);
  if (m) return `older than ${m[1]}`;
  m = /^\(,\s*([^,\]]+)\]$/.exec(r);
  if (m) return `${m[1]} or older`;
  return r;
}

function isMissing(actual: string): boolean {
  return MISSING_VALUES.has(actual.trim());
}

function collect(ctx: Ctx): Dep[] {
  const deps = new Map<string, Dep>();
  const record = (i: number, depId: string, requester: string, range: string, actual: string): void => {
    const sev = gate(ctx, i, { fatal: true });
    const key = `${depId}\u0000${isMissing(actual) ? '' : actual}`;
    const d = deps.get(key) ?? { depId, requirements: [], actual, lineIdx: [], severity: null };
    if (!d.requirements.some((r) => r.requester === requester)) d.requirements.push({ requester, range });
    d.lineIdx.push(i);
    d.severity = worst(d.severity, sev);
    deps.set(key, d);
  };

  let optional = false;
  ctx.lines.forEach((l, i) => {
    const t = l.text;
    if (t.includes('Missing or unsupported mandatory dependencies')) {
      optional = false;
      return;
    }
    if (t.includes('Unsupported installed optional dependencies')) {
      optional = true;
      return;
    }
    const m = MOD_ID_LINE.exec(t);
    if (m) {
      if (!optional) record(i, m[1] ?? '', m[2] ?? '', m[3] ?? '', m[4] ?? '');
      return;
    }
    if (!/^\s/.test(t) || !contiguous(ctx.lines, i - 1, i)) optional = false;

    const msg = stripFormatting(logMessage(t));
    const tr = TRANSLATED.exec(msg);
    // `Mod x requires mod y, version …` is the Fabric ≤0.11 resolver (C-FABRIC-INCOMPAT), not FML.
    if (!tr || tr[2] === 'mod') return;
    const depId = tr[2] ?? '';
    let actual = '[MISSING]';
    for (let j = i + 1; j <= i + 3 && contiguous(ctx.lines, j - 1, j); j++) {
      const cur = CURRENTLY.exec(stripFormatting(ctx.lines[j]?.text ?? ''));
      if (cur && cur[1] === depId) {
        actual = cur[2] === 'not installed' ? '[MISSING]' : (cur[2] ?? '');
        break;
      }
    }
    const range = (tr[3] ?? '').replace(/\.$/, '');
    record(i, depId, tr[1] ?? '', range, actual);
  });
  return [...deps.values()];
}

function rangeText(range: string): string {
  return /^[[(]/.test(range.trim()) ? `${describeMavenRange(range)} (${range})` : range;
}

function toFinding(ctx: Ctx, d: Dep): Finding | null {
  if (!d.severity) return null;
  const index = ctx.index;
  const requesters = d.requirements.map((r) => r.requester);
  const requesterJars = index ? uniqueTopLevel(requesters.flatMap((r) => jarsForModId(r, index).slice(0, 1)), index) : [];
  const unresolved = index ? requesters.filter((r) => jarsForModId(r, index).length === 0) : [];
  const ranges = listText(d.requirements.map((r) => rangeText(r.range)));
  const who = listText(requesters);
  const missing = isMissing(d.actual);
  const evidence = [logEvidence(ctx, d.lineIdx, { context: 1 })];

  if (missing) {
    const culprits = refs(ctx, requesterJars);
    return finding(ctx, {
      code: 'C-MISSING-MANDATORY',
      severity: d.severity,
      title: `${who} need${requesters.length === 1 ? 's' : ''} ${d.depId}, which is not installed`,
      explanation: `${who} declare${requesters.length === 1 ? 's' : ''} a required dependency on ${d.depId} (${ranges}), but no installed jar provides ${d.depId}. The loader refuses to start until it is installed or the mod${requesters.length === 1 ? '' : 's'} needing it are removed.`,
      culprits,
      evidence,
      fixes: [
        manual(
          `Install ${d.depId} (${ranges}) for this Minecraft version and loader; it is required by ${who}.`,
          `Or remove ${who} if you do not need ${requesters.length === 1 ? 'it' : 'them'}.`,
        ),
        ...culprits.flatMap((c) => disable(c)),
      ],
      discriminator: `missing:${d.depId}`,
      unresolved,
    });
  }

  if (PLATFORM.has(d.depId)) {
    const culprits = refs(ctx, requesterJars);
    const platform = d.depId === 'minecraft' ? 'Minecraft' : d.depId === 'neoforge' ? 'NeoForge' : d.depId === 'forge' ? 'Forge' : d.depId;
    return finding(ctx, {
      code: 'C-MISSING-MANDATORY',
      severity: d.severity,
      title: `${who} ${requesters.length === 1 ? 'is' : 'are'} built for ${platform} ${ranges}, but ${d.actual} is installed`,
      explanation: `${who} only support${requesters.length === 1 ? 's' : ''} ${platform} ${ranges}; this pack runs ${platform} ${d.actual}. Replace ${requesters.length === 1 ? 'it' : 'them'} with a build for ${platform} ${d.actual}, or remove ${requesters.length === 1 ? 'it' : 'them'}.`,
      culprits,
      evidence,
      fixes: [
        ...culprits.flatMap((c) => disable(c)),
        manual(`Download ${who} for ${platform} ${d.actual} and replace the current jar${requesters.length === 1 ? '' : 's'}.`),
      ],
      discriminator: `platform:${d.depId}:${[...requesters].sort().join(',')}`,
      unresolved,
    });
  }

  const depJars = index ? uniqueTopLevel(jarsForModId(d.depId, index), index) : [];
  const culprits = refs(ctx, [...depJars, ...requesterJars]);
  return finding(ctx, {
    code: 'C-MISSING-MANDATORY',
    severity: d.severity,
    title: `${who} need${requesters.length === 1 ? 's' : ''} ${d.depId} ${ranges}, but ${d.actual} is installed`,
    explanation: `${d.depId} ${d.actual} is installed, but ${who} require${requesters.length === 1 ? 's' : ''} ${ranges}. Update ${d.depId} (or downgrade ${who}) so the versions match.`,
    culprits,
    evidence,
    fixes: [manual(`Replace ${d.depId} ${d.actual} with a version in ${ranges} for this Minecraft version.`)],
    discriminator: `version:${d.depId}:${[...requesters].sort().join(',')}`,
    unresolved: [...unresolved, ...(index && depJars.length === 0 ? [d.depId] : [])],
  });
}

export const missingDepsPattern: CrashPattern = {
  id: 'missing-mandatory-deps',
  codes: ['C-MISSING-MANDATORY'],
  anchors: [
    // Owner's list: FML refuses to load.
    ...fatal('Missing or unsupported mandatory dependencies'),
    ...contextual(
      'Unsupported installed optional dependencies',
      "\tMod ID: '",
      // The translated form shows up under `Failure message:` / `Loading errors encountered`
      // (suspected.ts anchors) and `Currently, x is not installed`.
      'is not installed',
    ),
  ],
  match(input) {
    const ctx = ctxOf(input);
    return collect(ctx).flatMap((d) => toFinding(ctx, d) ?? []);
  },
};
