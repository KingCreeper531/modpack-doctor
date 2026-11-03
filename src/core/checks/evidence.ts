/**
 * Shared finding helpers: culprit refs, metadata excerpts with highlighted lines, wording.
 */
import type { DependencyKind, FixAction, JarRecord, ModMeta, RawRange } from '../../bindings';
import { findingId } from '../crash/id';
import type { Evidence, Finding, FindingCode, JarRef, Severity } from '../model';
import { versionApi } from '../version';
import type { CheckContext, ModEntry } from './context';

export function jarRef(jar: JarRecord, modId?: string): JarRef {
  return modId === undefined ? { jarId: jar.id, fileName: jar.fileName } : { jarId: jar.id, fileName: jar.fileName, modId };
}

/** Culprit for a metadata entry: the top-level jar the user acts on, tagged with the mod id. */
export function entryRef(e: ModEntry): JarRef {
  return jarRef(e.top, e.mod.modId);
}

/** "Sodium" or the mod id. */
export function modName(mod: ModMeta): string {
  return mod.name?.trim() || mod.modId;
}

/** "Sodium (sodium-0.5.8.jar)", or "Foo (bundled in bar.jar)" for a nested entry. */
export function entryLabel(e: ModEntry): string {
  const where = e.jar.depth === 0 ? e.top.fileName : `bundled in ${e.top.fileName}`;
  return `${modName(e.mod)} (${where})`;
}

/** Human description of a range ("[47,)" → "47 or newer"), falling back to the raw text. */
export function describeRange(range: RawRange, subject: 'minecraft' | 'other' = 'other'): string {
  const parsed = versionApi.parseRange(range, subject);
  if (parsed.ok) return parsed.describe();
  return rawRange(range);
}

export function rawRange(range: RawRange): string {
  if (range.unrepresentable) return range.unrepresentable;
  return range.raw.length === 0 ? '*' : range.raw.join(' || ');
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function listText(items: readonly string[], max = 5): string {
  if (items.length <= max) return items.join(', ');
  return `${items.slice(0, max).join(', ')} and ${items.length - max} more`;
}

export function makeFinding(args: {
  code: FindingCode;
  severity: Severity;
  title: string;
  explanation: string;
  culprits: JarRef[];
  evidence: Evidence[];
  fixes: FixAction[];
  discriminator: string;
}): Finding {
  const { code, discriminator, ...rest } = args;
  return {
    id: findingId(code, args.culprits.map((c) => c.jarId), discriminator),
    code,
    ...rest,
  };
}

export function disable(jar: JarRecord): FixAction {
  return { kind: 'disable', jarId: jar.id };
}

export function manual(...steps: string[]): FixAction {
  return { kind: 'manual', steps };
}

// ---- Metadata excerpt line finding -------------------------------------------------------------

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function lines(excerpt: string): string[] {
  return excerpt.split(/\r?\n/);
}

function isToml(mod: ModMeta): boolean {
  return mod.metadataFile.endsWith('.toml');
}

const JSON_KEYS: Readonly<Record<DependencyKind, readonly string[]>> = {
  required: ['depends'],
  optional: ['suggests', 'depends'],
  recommended: ['recommends'],
  incompatible: ['breaks'],
  breaks: ['breaks'],
  conflicts: ['conflicts'],
};

const TOML_HEADER = /^\s*\[\[?\s*([^\]]+?)\s*\]\]?\s*$/;

/**
 * 1-based excerpt lines of a dependency entry: TOML — the `modId = "dep"` line inside the
 * `[[dependencies.<modId>]]` block plus that block's `versionRange` line; JSON — the line naming
 * the dependency (after the `depends`/`breaks`/… key when present) plus a following `versions`
 * line for Quilt objects. Empty when the entry is not in the excerpt (it is capped at 16 KiB).
 */
export function dependencyLines(mod: ModMeta, depId: string, kind: DependencyKind = 'required'): number[] {
  const ls = lines(mod.metadataExcerpt);
  const quoted = new RegExp(`["']${escapeRe(depId)}["']`);
  if (isToml(mod)) {
    const ownerOf = (line: string): string | null | undefined => {
      const m = TOML_HEADER.exec(line);
      if (!m) return undefined;
      const name = (m[1] ?? '').replace(/["']/g, '');
      return name.startsWith('dependencies.') ? name.slice('dependencies.'.length) : null;
    };
    const hasOwnBlock = ls.some((l) => ownerOf(l) === mod.modId);
    let owner: string | null = null;
    for (let i = 0; i < ls.length; i++) {
      const line = ls[i] ?? '';
      const o = ownerOf(line);
      if (o !== undefined) {
        owner = o;
        continue;
      }
      if (hasOwnBlock && owner !== mod.modId) continue;
      if (!/modId\s*=/.test(line) || !quoted.test(line)) continue;
      const out = [i + 1];
      for (let k = i + 1; k < ls.length && ownerOf(ls[k] ?? '') === undefined; k++) {
        if (/^\s*versionRange\s*=/.test(ls[k] ?? '')) out.push(k + 1);
      }
      // A versionRange written before modId in the same block.
      for (let k = i - 1; k >= 0 && ownerOf(ls[k] ?? '') === undefined; k--) {
        if (/^\s*versionRange\s*=/.test(ls[k] ?? '')) out.unshift(k + 1);
      }
      return out;
    }
    return [];
  }
  const keys = JSON_KEYS[kind];
  let start = 0;
  for (const key of keys) {
    const at = ls.findIndex((l) => new RegExp(`["']${key}["']\\s*:`).test(l));
    if (at >= 0) {
      start = at;
      break;
    }
  }
  for (const from of start > 0 ? [start, 0] : [0]) {
    for (let i = from; i < ls.length; i++) {
      const line = ls[i] ?? '';
      if (!quoted.test(line)) continue;
      const out = [i + 1];
      if (!new RegExp(`${quoted.source}\\s*:`).test(line)) {
        // Quilt object form: `{ "id": "dep", "versions": ... }` may span lines.
        for (let k = i; k < Math.min(ls.length, i + 4); k++) {
          if (/["']versions["']\s*:/.test(ls[k] ?? '') && k !== i) {
            out.push(k + 1);
            break;
          }
        }
      }
      return out;
    }
  }
  return [];
}

/** 1-based line declaring the mod id (`modId = "x"` / `"id": "x"`). */
export function modIdLines(mod: ModMeta): number[] {
  const id = escapeRe(mod.modId);
  const re = isToml(mod) ? new RegExp(`^\\s*modId\\s*=\\s*["']${id}["']`) : new RegExp(`["']id["']\\s*:\\s*["']${id}["']`);
  const i = lines(mod.metadataExcerpt).findIndex((l) => re.test(l));
  return i >= 0 ? [i + 1] : [];
}

/** 1-based line(s) declaring the environment (`"environment"` / `clientSideOnly`). */
export function environmentLines(mod: ModMeta): number[] {
  const re = isToml(mod) ? /^\s*clientSideOnly\s*=/ : /["']environment["']\s*:/;
  const i = lines(mod.metadataExcerpt).findIndex((l) => re.test(l));
  return i >= 0 ? [i + 1] : [];
}

export function metadataEvidence(jar: JarRecord, mod: ModMeta, highlight: number[]): Evidence {
  return {
    kind: 'metadata',
    jarId: jar.id,
    file: mod.metadataFile,
    excerpt: mod.metadataExcerpt,
    highlight: [...new Set(highlight)].sort((a, b) => a - b),
  };
}

/** Evidence list for one entry: its metadata (when an excerpt exists) and the pack note. */
export function entryEvidence(ctx: CheckContext, e: ModEntry, highlight: number[], ...notes: string[]): Evidence[] {
  const out: Evidence[] = [];
  if (e.mod.metadataExcerpt.length > 0) out.push(metadataEvidence(e.jar, e.mod, highlight));
  for (const text of notes) out.push({ kind: 'note', text });
  out.push(ctx.packNote);
  return out;
}
