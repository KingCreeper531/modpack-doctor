/**
 * C-SUSPECTED: mods the loader or Forge's crash analyser names directly.
 * - Forge `Suspected Mod(s):` block (`\t<Name> (<modid>), Version: <ver>` + `\t\tat …` frames);
 * - Forge `-- MOD x --` / NeoForge `-- Mod loading issue for: x --` sections (`Mod File:`/`Mod file:`,
 *   `Failure message:`, `Exception message:`) and stray `Mod File:` lines;
 * - NeoForge `Loading errors encountered:` items, Forge `Failed to create mod instance`;
 * - Fabric/Quilt entrypoint failures (`… provided by 'coolmod'`).
 */
import type { CrashPattern, Finding, Severity } from '../../model';
import {
  ctxOf,
  disable,
  finding,
  framesAfter,
  gate,
  logEvidence,
  manual,
  mapFrames,
  refs,
  worst,
  type Ctx,
} from '../context';
import type { JarRecord } from '../../../bindings';
import { fileMatchesMod, jarByFileName, jarsForModLoose, uniqueTopLevel } from '../jars';
import { basename, contiguous, isFrameLine, logMessage, stripFormatting, truncate } from '../text';
import { contextual, fatal } from '../tiers';
import { innermostCause } from './rootCause';

type SuspectSource = 'analyser' | 'loader' | 'entrypoint';

interface Suspect {
  key: string;
  modId?: string;
  name?: string;
  version?: string;
  file?: string;
  stage?: string;
  source: SuspectSource;
  lineIdx: number[];
  frameIdx: number[];
  failure?: string;
  exception?: string;
  severity: Severity | null;
}

const SUSPECT_HEADER = /^Suspected Mods?: ?(.*)$/;
const SUSPECT_ENTRY = /^\t(.+) \(([a-z0-9_.-]+)\), Version: (.+)$/;
const SECTION_HEADER = /^-- (?:MOD (\S+)|Mod loading issue for: (\S+)|Mod loading issue|NO MOD INFO AVAILABLE) --\s*$/;
const MOD_FILE = /^\s*Mod [Ff]ile: (.+?)\s*$/;
const FAILURE = /^\s*Failure message: (.*)$/;
const EXCEPTION_MESSAGE = /^\s*Exception message: (.*)$/;
const LOADER_FAILURE = /^(.+?) \(([a-z][\w.-]*)\) (has failed to load correctly|has class loading errors|encountered an error.*)$/;
const MOD_INSTANCE = /Failed to create mod instance\. ModID: ([\w.-]+)/;
const ENTRYPOINT = [
  /Could not execute entrypoint stage '([\w-]+)' due to errors, provided by '([\w.-]+)'/,
  /Exception while loading entries for entrypoint '([\w-]+)' provided by '([\w.-]+)'/,
];
/** A failure that is really a missing dependency (C-MISSING-MANDATORY reports it). */
const MISSING_DEP_FAILURE =
  /requires \S+ .*(?:or above|or newer|or later|or below|between)|is not installed|missingdependency|Missing or unsupported mandatory/;
const BUILTIN_IDS = new Set(['minecraft', 'forge', 'neoforge', 'fml', 'mcp', 'java', 'fabricloader', 'quilt_loader']);

function collect(ctx: Ctx): Suspect[] {
  const suspects = new Map<string, Suspect>();
  const consumed = new Set<number>();
  const text = (i: number): string => ctx.lines[i]?.text ?? '';

  const upsert = (key: string, init: Omit<Suspect, 'key' | 'lineIdx' | 'frameIdx' | 'severity'>, at: number): Suspect => {
    let s = suspects.get(key);
    if (!s) {
      s = { key, ...init, lineIdx: [], frameIdx: [], severity: null };
      suspects.set(key, s);
    } else {
      for (const [k, v] of Object.entries(init) as [keyof typeof init, string | undefined][]) {
        if (v !== undefined && s[k] === undefined) (s as unknown as Record<string, unknown>)[k] = v;
      }
    }
    s.severity = worst(s.severity, gate(ctx, at, { warn: 'warning' }));
    return s;
  };

  for (let i = 0; i < ctx.lines.length; i++) {
    const t = text(i);

    const header = SUSPECT_HEADER.exec(t);
    if (header) {
      if ((header[1] ?? '').trim() === 'NONE') continue;
      let cur: Suspect | undefined;
      for (let j = i + 1; j < ctx.lines.length && contiguous(ctx.lines, j - 1, j); j++) {
        const u = text(j);
        if (!u.startsWith('\t')) break;
        const e = SUSPECT_ENTRY.exec(u);
        if (e) {
          const modId = e[2] ?? '';
          cur = upsert(modId, { modId, name: e[1] ?? modId, version: e[3] ?? '', source: 'analyser' }, i);
          cur.lineIdx.push(j);
        } else if (cur && u.startsWith('\t\t')) {
          if (isFrameLine(u)) cur.frameIdx.push(j);
          else cur.lineIdx.push(j);
        }
      }
      continue;
    }

    const sec = SECTION_HEADER.exec(t);
    if (sec) {
      const modId = sec[1] ?? sec[2];
      const idx = [i];
      let file: string | undefined;
      let failure: string | undefined;
      let exception: string | undefined;
      let frameIdx: number[] = [];
      for (let j = i + 1; j < ctx.lines.length && contiguous(ctx.lines, j - 1, j); j++) {
        const u = text(j);
        if (u.trim() === '' || u.startsWith('-- ')) break;
        consumed.add(j);
        const mf = MOD_FILE.exec(u);
        const fm = FAILURE.exec(u);
        const em = EXCEPTION_MESSAGE.exec(u);
        if (mf) {
          file = basename(mf[1] ?? '');
          idx.push(j);
        } else if (fm) {
          failure = stripFormatting(fm[1] ?? '').trim();
          idx.push(j);
          for (let k = j + 1; k < ctx.lines.length && contiguous(ctx.lines, k - 1, k); k++) {
            const v = text(k);
            if (!v.startsWith('\t\t') || isFrameLine(v)) break;
            failure += ` ${stripFormatting(v).trim()}`;
          }
        } else if (em) {
          exception = (em[1] ?? '').trim();
          idx.push(j);
        } else if (u.startsWith('Stacktrace:')) {
          frameIdx = framesAfter(ctx, j);
        }
      }
      if (failure && MISSING_DEP_FAILURE.test(failure)) continue;
      const key = modId ?? file;
      if (!key) continue;
      const s = upsert(
        key,
        {
          source: 'loader',
          ...(modId ? { modId } : {}),
          ...(file ? { file } : {}),
          ...(failure ? { failure } : {}),
          ...(exception ? { exception } : {}),
        },
        i,
      );
      s.lineIdx.push(...idx);
      s.frameIdx.push(...frameIdx);
      continue;
    }

    const mf = MOD_FILE.exec(t);
    if (mf && !consumed.has(i)) {
      const file = basename(mf[1] ?? '');
      if (file) upsert(file, { source: 'loader', file }, i).lineIdx.push(i);
      continue;
    }

    const msg = stripFormatting(logMessage(t)).replace(/^\s*(?:-\s+|Failure message:\s*)/, '').trim();
    const lf = consumed.has(i) ? null : LOADER_FAILURE.exec(msg);
    if (lf) {
      const modId = lf[2] ?? '';
      const next = text(i + 1);
      const exception = contiguous(ctx.lines, i, i + 1) && /^\t {2}\S/.test(next) ? next.trim() : undefined;
      const s = upsert(
        modId,
        { source: 'loader', modId, name: lf[1] ?? modId, failure: msg, ...(exception ? { exception } : {}) },
        i,
      );
      s.lineIdx.push(i);
      if (exception) s.lineIdx.push(i + 1);
      continue;
    }

    const mi = MOD_INSTANCE.exec(t);
    if (mi) {
      const modId = mi[1] ?? '';
      const s = upsert(modId, { source: 'loader', modId, failure: 'Failed to create mod instance' }, i);
      s.lineIdx.push(i);
      continue;
    }

    for (const re of ENTRYPOINT) {
      const m = re.exec(t);
      if (!m) continue;
      const modId = m[2] ?? '';
      const s = upsert(modId, { source: 'entrypoint', modId, stage: m[1] ?? '' }, i);
      s.lineIdx.push(i);
      break;
    }
  }
  return mergeSameMod(
    ctx,
    [...suspects.values()].filter((s) => !(s.modId && BUILTIN_IDS.has(s.modId))),
  );
}

function jarsOf(ctx: Ctx, s: Suspect): JarRecord[] {
  const index = ctx.index;
  if (!index) return [];
  const byFile = s.file ? jarByFileName(s.file, index) : undefined;
  if (byFile) return [byFile];
  return s.modId || s.name ? uniqueTopLevel(jarsForModLoose(s.modId, s.name, index), index) : [];
}

/**
 * One suspect per mod: a file-only suspect (`-- Mod loading issue --` + `Mod file:`) and a mod
 * suspect (`X (x) failed to load`) for the same jar become one, keeping the mod's name and id.
 */
function mergeSameMod(ctx: Ctx, list: Suspect[]): Suspect[] {
  const out: Suspect[] = [];
  const sameMod = (a: Suspect, b: Suspect): boolean => {
    if (a.modId && b.modId) {
      if (a.modId === b.modId) return true;
    } else {
      const file = a.file ?? b.file;
      const mod = a.modId ?? b.modId ?? a.name ?? b.name;
      if (file && mod && fileMatchesMod(file, mod)) return true;
      if (a.file && a.file === b.file) return true;
    }
    const ja = jarsOf(ctx, a)[0];
    const jb = jarsOf(ctx, b)[0];
    return ja !== undefined && jb !== undefined && ja.id === jb.id;
  };
  for (const s of list) {
    const into = out.find((o) => sameMod(o, s));
    if (!into) {
      out.push(s);
      continue;
    }
    // Prefer the entry that has the mod's identity as the base.
    if (!into.modId && s.modId) {
      into.key = s.key;
      into.modId = s.modId;
    }
    into.name ??= s.name;
    into.version ??= s.version;
    into.file ??= s.file;
    into.stage ??= s.stage;
    into.failure ??= s.failure;
    into.exception ??= s.exception;
    if (into.source !== 'analyser' && s.source === 'analyser') into.source = s.source;
    into.lineIdx.push(...s.lineIdx.filter((i) => !into.lineIdx.includes(i)));
    into.frameIdx.push(...s.frameIdx.filter((i) => !into.frameIdx.includes(i)));
    into.severity = worst(into.severity, s.severity);
  }
  for (const s of out) s.lineIdx.sort((a, b) => a - b);
  return out;
}

function toFinding(ctx: Ctx, s: Suspect, rootText: string): Finding | null {
  if (!s.severity) return null;
  const index = ctx.index;
  const culprits = refs(ctx, jarsOf(ctx, s), s.modId);
  const label = s.name && s.modId && s.name !== s.modId ? `${s.name} (${s.modId})` : (s.modId ?? s.file ?? s.key);
  const fileText = culprits[0] ? ` (${culprits[0].fileName})` : s.file && s.modId ? ` (${s.file})` : '';
  let title: string;
  let explanation: string;
  if (s.source === 'analyser') {
    title = `Forge's crash analysis suspects ${label}`;
    explanation = `Forge matched the crashing stack trace to ${label}${s.version ? ` ${s.version}` : ''}${fileText}.${rootText} Disable it to test; if the game then starts, update or remove it.`;
  } else if (s.source === 'entrypoint') {
    title = `${label} crashed while starting (${s.stage} entrypoint)`;
    explanation = `The loader ran the '${s.stage}' entrypoint of ${label}${fileText} and it threw an exception.${rootText} Update the mod, or disable it to get the game running.`;
  } else {
    title = `${label} failed to load`;
    const failure = s.failure ? ` The loader reported: ${truncate(s.failure, 200)}.` : '';
    const exception = s.exception ? ` Error: ${truncate(s.exception, 200)}.` : rootText;
    explanation = `The mod loader stopped while loading ${label}${fileText}.${failure}${exception} Disable it to get the game running, then look for an update.`;
  }
  if (index && culprits.length === 0) {
    explanation += ` No jar for ${label} is in the mods folder now, so this report may be older than the current mods.`;
  }
  return finding(ctx, {
    code: 'C-SUSPECTED',
    severity: s.severity,
    title,
    explanation,
    culprits,
    evidence: [logEvidence(ctx, s.lineIdx, { frames: mapFrames(ctx, s.frameIdx).slice(0, 5), context: 1 })],
    fixes: culprits.length > 0 ? disable(culprits[0]) : [manual(`Disable or remove ${label} from the mods folder.`)],
    discriminator: s.modId ?? s.file ?? s.key,
    unresolved: culprits.length === 0 ? [s.modId ?? s.file ?? s.key] : [],
  });
}

export const suspectedPattern: CrashPattern = {
  id: 'suspected-mods',
  codes: ['C-SUSPECTED'],
  anchors: [
    // NeoForge loading-error screen (owner's list); a Fabric/Quilt entrypoint failure aborts
    // the launch.
    ...fatal('Loading errors encountered', 'Could not execute entrypoint stage'),
    // Crash-report section content (the report header is the fatal trigger) and loader lines
    // that are followed by a fatal marker when loading really stops.
    ...contextual(
      'Suspected Mod: ',
      'Suspected Mods: ',
      '-- MOD ',
      '-- Mod loading issue',
      'Mod File: ',
      'Mod file: ',
      'Failure message: ',
      'Exception message: ',
      'has failed to load correctly',
      'has class loading errors',
      'encountered an error',
      'Failed to create mod instance',
      'Exception while loading entries for entrypoint',
    ),
  ],
  match(input) {
    const ctx = ctxOf(input);
    const suspects = collect(ctx);
    if (suspects.length === 0) return [];
    const rc = innermostCause(ctx);
    const rootText = rc ? ` Innermost error: ${truncate(`${rc.cls}${rc.message ? `: ${rc.message}` : ''}`, 200)}.` : '';
    return suspects.flatMap((s) => toFinding(ctx, s, rootText) ?? []);
  },
};
