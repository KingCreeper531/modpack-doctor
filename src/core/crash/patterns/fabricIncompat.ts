/**
 * C-FABRIC-INCOMPAT: Fabric/Quilt dependency resolution failures (crash-formats.md §3.5, §3.6).
 * Fabric: `Some of your mods are incompatible with the game or each other!` (GUI title
 * `Incompatible mods found!`, old `… incompatible mod set!`) with detail lines
 * `Mod 'Name' (id) ver requires <range> of <dep>, which is missing!` and solution lines
 * (`Install …`, `Replace …`, `Remove mod … (<path>).`). Quilt: the same sentences with display
 * names and no ids, and `Duplicate mod:` blocks. Java requirements go to C-JAVA-VERSION.
 */
import type { JarRecord } from '../../../bindings';
import type { CrashPattern, Finding, Severity } from '../../model';
import { ctxOf, disable, finding, gate, listText, logEvidence, manual, refs, worst, type Ctx } from '../context';
import { jarByFileName, jarsForModId, jarsForModName, uniqueTopLevel } from '../jars';
import { basename, logMessage } from '../text';

export const FABRIC_HEADERS: readonly string[] = [
  'Incompatible mods found!',
  'Incompatible mod set!',
  'Some of your mods are incompatible',
  'Mod resolution encountered an incompatible mod set',
  'Mod resolution failed',
];

type Kind = 'missing' | 'wrong' | 'env' | 'constraints' | 'breaks' | 'duplicate';

interface Party {
  id?: string;
  name: string;
}

interface Problem {
  key: string;
  kind: Kind;
  subjects: Party[];
  dep?: Party;
  range?: string;
  actual?: string;
  /** Jar file names named by the log (Fabric `Remove mod … (<path>)`, Quilt duplicates). */
  files: string[];
  /** The loader itself suggested removing `files` (Fabric); Quilt lists every copy instead. */
  removeSuggested?: boolean;
  lineIdx: number[];
  severity: Severity | null;
}

const FABRIC_SUBJECT = /(?:[Mm]od )?'([^']+)' \(([\w.-]+)\) (\S+) (requires|transitively requires|is incompatible with|conflicts with|recommends|breaks) (.+)$/;
const DEP = /^(.+?) of (?:(?:[Mm]od )?'([^']+)' \(([\w.-]+)\)|([\w.-]+))(.*)$/;
const QUILT = /^(.+?) (requires|transitively requires|breaks with) (.+?) of (.+?), (which is missing!?|but only (?:a different|the wrong|wrong) versions? (?:is|are) present.*|but an incompatible version is present.*)$/;
const OLD_FABRIC = /Could not find required mod: ([\w.-]+) requires \{([\w.-]+) @ \[([^\]]*)\]\}/;
const REMOVE = /Remove mod '([^']+)' \(([\w.-]+)\) (\S+) \(([^)]+)\)\./;
const INSTALL = /Install ([\w.-]+), (.+?)\.\s*$/;
const REPLACE = /Replace (?:mod )?'([^']+)' \(([\w.-]+)\) (\S+) with (.+?)\.\s*$/;
const QUILT_DUPLICATE = /Duplicate mod: (.+?)\s*$/;
const BUILTIN = new Set(['minecraft', 'java', 'fabricloader', 'quilt_loader']);

function kindOf(verb: string, tail: string): { kind: Kind; actual?: string } | null {
  if (verb === 'recommends' || verb === 'conflicts with') return null; // warnings only
  if (/which is missing/.test(tail)) return { kind: 'missing' };
  const wrong = /but only (?:the wrong|a different|wrong) versions? (?:is|are) present:?\s*(.*?)!?\s*$/.exec(tail);
  if (wrong) return { kind: 'wrong', actual: wrong[1] ?? '' };
  if (/which is disabled for this environment/.test(tail)) return { kind: 'env' };
  if (/can't be loaded due to other constraints/.test(tail)) return { kind: 'constraints' };
  const conflicting = /(?:yet|but) (?:a|an) (?:conflicting|incompatible) version is present:?\s*(.*?)!?\s*$/.exec(tail);
  if (conflicting) return { kind: 'breaks', actual: conflicting[1] ?? '' };
  if (verb === 'is incompatible with' || verb === 'breaks' || verb === 'breaks with') return { kind: 'breaks' };
  return null;
}

function partyLabel(p: Party): string {
  return p.id && p.id !== p.name ? `${p.name} (${p.id})` : p.name;
}

function partyJars(ctx: Ctx, p: Party | undefined): JarRecord[] {
  const index = ctx.index;
  if (!index || !p) return [];
  const js = p.id ? jarsForModId(p.id, index) : jarsForModName(p.name, index);
  return uniqueTopLevel(js.slice(0, 1), index);
}

function collect(ctx: Ctx): { problems: Problem[]; headerIdx: number[]; steps: Map<string, string>; sawDetails: boolean } {
  let sawDetails = false;
  const problems = new Map<string, Problem>();
  const headerIdx: number[] = [];
  const steps = new Map<string, string>();
  const add = (i: number, p: Omit<Problem, 'lineIdx' | 'severity' | 'files'> & { files?: string[] }): void => {
    const existing = problems.get(p.key);
    const sev = gate(ctx, i, { fatal: true });
    if (existing) {
      for (const s of p.subjects) if (!existing.subjects.some((e) => e.name === s.name)) existing.subjects.push(s);
      for (const f of p.files ?? []) if (!existing.files.includes(f)) existing.files.push(f);
      existing.lineIdx.push(i);
      existing.severity = worst(existing.severity, sev);
      return;
    }
    problems.set(p.key, { ...p, files: p.files ?? [], lineIdx: [i], severity: sev });
  };

  for (let i = 0; i < ctx.lines.length; i++) {
    const t = ctx.lines[i]?.text ?? '';
    if (FABRIC_HEADERS.some((h) => t.includes(h))) headerIdx.push(i);

    const rm = REMOVE.exec(t);
    if (rm) {
      const id = rm[2] ?? '';
      add(i, {
        key: `duplicate:${id}`,
        kind: 'duplicate',
        subjects: [{ id, name: rm[1] ?? id }],
        files: [basename(rm[4] ?? '')],
        removeSuggested: true,
      });
      continue;
    }
    const inst = INSTALL.exec(t);
    if (inst) {
      steps.set(inst[1] ?? '', `Install ${inst[1] ?? ''}, ${inst[2] ?? ''}.`);
      continue;
    }
    const rep = REPLACE.exec(t);
    if (rep) {
      steps.set(rep[2] ?? '', `Replace ${rep[1] ?? ''} ${rep[3] ?? ''} with ${rep[4] ?? ''}.`);
      continue;
    }

    const old = OLD_FABRIC.exec(t);
    if (old) {
      const id = old[1] ?? '';
      const dep = old[2] ?? '';
      add(i, { key: `missing:${dep}`, kind: 'missing', subjects: [{ id, name: id }], dep: { id: dep, name: dep }, range: old[3] ?? '' });
      continue;
    }

    const fs = FABRIC_SUBJECT.exec(t);
    if (fs) {
      sawDetails = true;
      const subject: Party = { id: fs[2] ?? '', name: fs[1] ?? '' };
      const verb = fs[4] ?? '';
      const d = DEP.exec(fs[5] ?? '');
      if (!d) continue;
      const dep: Party = d[3] ? { id: d[3], name: d[2] ?? d[3] } : { id: d[4] ?? '', name: d[4] ?? '' };
      const k = kindOf(verb, d[5] ?? '');
      if (!k || dep.id === 'java') continue; // java → C-JAVA-VERSION
      const key =
        k.kind === 'missing'
          ? `missing:${dep.id ?? dep.name}`
          : k.kind === 'breaks'
            ? `breaks:${[subject.id, dep.id].sort().join('+')}`
            : `${k.kind}:${subject.id}->${dep.id ?? dep.name}`;
      add(i, { key, kind: k.kind, subjects: [subject], dep, range: (d[1] ?? '').trim(), ...(k.actual ? { actual: k.actual } : {}) });
      continue;
    }

    const msg = logMessage(t).replace(/^\s*-\s+/, '').trim();
    const q = QUILT.exec(msg);
    if (q && !/^Mod [\w.-]+$/.test(q[1] ?? '')) {
      const subject: Party = { name: (q[1] ?? '').trim() };
      const dep: Party = { name: (q[4] ?? '').trim() };
      sawDetails = true;
      if (/^(?:java|Java)\b/.test(dep.name)) continue;
      const k = kindOf(q[2] ?? '', q[5] ?? '');
      if (!k) continue;
      const key = k.kind === 'missing' ? `missing:${dep.name}` : `${k.kind}:${subject.name}->${dep.name}`;
      add(i, { key, kind: k.kind, subjects: [subject], dep, range: (q[3] ?? '').trim(), ...(k.actual ? { actual: k.actual } : {}) });
      continue;
    }

    const dup = QUILT_DUPLICATE.exec(msg);
    if (dup) {
      const name = dup[1] ?? '';
      const files: string[] = [];
      for (let j = i + 1; j < ctx.lines.length && j <= i + 10; j++) {
        const f = /^\s*-\s+(.+?)\s*$/.exec(ctx.lines[j]?.text ?? '');
        if (!f) break;
        files.push(basename(f[1] ?? ''));
      }
      add(i, { key: `duplicate:${name}`, kind: 'duplicate', subjects: [{ name }], files });
    }
  }
  return { problems: [...problems.values()], headerIdx, steps, sawDetails };
}

function toFinding(ctx: Ctx, p: Problem, steps: Map<string, string>, headerIdx: number[]): Finding | null {
  if (!p.severity) return null;
  const index = ctx.index;
  const subjects = listText(p.subjects.map(partyLabel));
  const plural = p.subjects.length > 1;
  const subjectJars = index ? uniqueTopLevel(p.subjects.flatMap((s) => partyJars(ctx, s)), index) : [];
  const depJars = partyJars(ctx, p.dep);
  const dep = p.dep ? partyLabel(p.dep) : '';
  const evidence = [logEvidence(ctx, p.lineIdx, { context: 1, contextIdx: headerIdx.slice(0, 1) })];
  const unresolved = index ? p.subjects.filter((s) => partyJars(ctx, s).length === 0).map(partyLabel) : [];
  const stepFor = (id: string | undefined): string | undefined => (id ? steps.get(id) : undefined);

  switch (p.kind) {
    case 'missing': {
      const culprits = refs(ctx, subjectJars);
      return finding(ctx, {
        code: 'C-FABRIC-INCOMPAT',
        severity: p.severity,
        title: `${subjects} need${plural ? '' : 's'} ${dep}, which is missing`,
        explanation: `${subjects} require${plural ? '' : 's'} ${p.range ? `${p.range} of ` : ''}${dep}, but it is not installed, so the loader refused to start.`,
        culprits,
        evidence,
        fixes: [
          manual(stepFor(p.dep?.id) ?? `Install ${dep}${p.range ? ` (${p.range})` : ''} for this Minecraft version.`, `Or remove ${subjects}.`),
          ...culprits.flatMap((c) => disable(c)),
        ],
        discriminator: p.key,
        unresolved,
      });
    }
    case 'duplicate': {
      const jars = index ? p.files.map((f) => jarByFileName(f, index)) : [];
      const culprits = refs(ctx, jars);
      const files = p.files.length > 0 ? listText(p.files) : subjects;
      return finding(ctx, {
        code: 'C-FABRIC-INCOMPAT',
        severity: p.severity,
        title: `${subjects} is installed more than once`,
        explanation: `The loader found ${subjects} in more than one jar and refused to start. ${p.removeSuggested ? `It suggests removing ${files}.` : `Copies: ${files}. Keep one.`}`,
        culprits,
        evidence,
        fixes:
          p.removeSuggested && culprits.length > 0
            ? culprits.flatMap((c) => disable(c))
            : [manual(`Keep one copy of ${subjects} (usually the newest) and remove the others${p.files.length > 0 ? `: ${files}` : ''}.`)],
        discriminator: p.key,
        unresolved: index && culprits.length === 0 ? p.files : [],
      });
    }
    case 'breaks': {
      const culprits = refs(ctx, [...subjectJars, ...depJars]);
      return finding(ctx, {
        code: 'C-FABRIC-INCOMPAT',
        severity: p.severity,
        title: `${subjects} ${plural ? 'are' : 'is'} incompatible with ${dep}`,
        explanation: `${subjects} declare${plural ? '' : 's'} that ${p.range ? `${p.range} of ` : ''}${dep} breaks it${p.actual ? `, and ${p.actual} is installed` : ''}. Remove one of them or update to versions that work together.`,
        culprits,
        evidence,
        fixes: [manual(`Remove ${subjects} or ${dep}, or update one so the versions are compatible.`)],
        discriminator: p.key,
        unresolved,
      });
    }
    default: {
      // wrong version / wrong environment / blocked by other constraints
      const isMc = p.dep?.id === 'minecraft';
      const culprits = refs(ctx, isMc ? subjectJars : [...subjectJars, ...depJars]);
      const why =
        p.kind === 'env'
          ? `${dep} is disabled for this side (client/server)`
          : p.kind === 'constraints'
            ? `${dep} can't be loaded because of other constraints`
            : `${p.actual ? `${p.actual} is installed` : 'a different version is installed'}`;
      const step = stepFor(p.subjects[0]?.id) ?? stepFor(p.dep?.id);
      return finding(ctx, {
        code: 'C-FABRIC-INCOMPAT',
        severity: p.severity,
        title: isMc
          ? `${subjects} ${plural ? 'are' : 'is'} built for Minecraft ${p.range ?? ''}, but ${p.actual ?? 'another version'} is installed`
          : `${subjects} need${plural ? '' : 's'} ${p.range ? `${p.range} of ` : ''}${dep}, but ${why}`,
        explanation: `${subjects} require${plural ? '' : 's'} ${p.range ? `${p.range} of ` : ''}${dep}, but ${why}. The loader refused to start.${isMc ? ` Use a build of ${subjects} for this Minecraft version, or remove it.` : ''}`,
        culprits,
        evidence,
        fixes: isMc
          ? [...culprits.flatMap((c) => disable(c)), manual(step ?? `Download ${subjects} for Minecraft ${p.actual ?? 'this version'}.`)]
          : [manual(step ?? `Update ${dep} to ${p.range ?? 'the required version'}, or use a version of ${subjects} that accepts what is installed.`)],
        discriminator: p.key,
        unresolved: [...unresolved, ...(index && p.dep && !isMc && !BUILTIN.has(p.dep.id ?? '') && depJars.length === 0 ? [dep] : [])],
      });
    }
  }
}

export const fabricIncompatPattern: CrashPattern = {
  id: 'fabric-incompatible',
  codes: ['C-FABRIC-INCOMPAT'],
  anchors: [
    ...FABRIC_HEADERS,
    'A potential solution has been determined',
    'More details:',
    ', which is missing!',
    'but only the wrong version',
    'but only a different version',
    'which is disabled for this environment',
    "can't be loaded due to other constraints",
    'yet a conflicting version is present',
    'but an incompatible version is present',
    'is incompatible with',
    'transitively requires',
    'breaks with',
    'Could not find required mod',
    'Duplicate mod: ',
  ],
  match(input) {
    const ctx = ctxOf(input);
    const { problems, headerIdx, steps, sawDetails } = collect(ctx);
    const found = problems.flatMap((p) => toFinding(ctx, p, steps, headerIdx) ?? []);
    // Generic finding only when the details are not in the log (a java-only problem is
    // reported by C-JAVA-VERSION instead).
    if (found.length === 0 && !sawDetails && headerIdx.length > 0) {
      const i = headerIdx[0] ?? 0;
      const severity = gate(ctx, i, { fatal: true });
      if (severity) {
        found.push(
          finding(ctx, {
            code: 'C-FABRIC-INCOMPAT',
            severity,
            title: 'The loader found incompatible mods',
            explanation:
              'Fabric/Quilt refused to start because some mods are incompatible with the game or each other, but the details were not in this log. Check the lines after this message or the loader error window.',
            culprits: [],
            evidence: [logEvidence(ctx, headerIdx.slice(0, 3), { context: 6 })],
            fixes: [manual('Read the loader error window or the lines after this message, then install, update or remove the mods it names.')],
            discriminator: 'generic',
          }),
        );
      }
    }
    return found;
  },
};
