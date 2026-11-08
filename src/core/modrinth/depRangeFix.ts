/**
 * E-DEP-RANGE with Modrinth: name the concrete version to switch to, and offer a `replace` fix
 * when the Rust planner can carry it out (CONTRACTS invariants 8 and 14).
 *
 * The static finding (checks/depRange.ts, wording in checks/depRangeText.ts) says "X needs Create
 * 6.0 or newer; you have 0.5.1.f". This module adds, when Modrinth data is available:
 *
 * 1. **Switch the dependency.** The newest version of the dependency's Modrinth project that
 *    - is a `release` (a `beta` only when no release fits, or with `includeBeta`), never alpha;
 *    - lists the pack's Modrinth loader (`modrinthLoaders`) and the pack's MC version;
 *    - has a download file (`downloadFile`, invariant 8);
 *    - has a `versionNumber` we can read as the mod's own version (`modVersionFromModrinth`:
 *      loader / MC / slug decorations stripped, must start with a digit and no longer name the MC
 *      version). When the installed jar is identified on Modrinth, its own `versionNumber` must
 *      read as the jar's declared version, or the project's numbering is not trusted at all;
 *    - satisfies the declared range (`versionApi.satisfies`, the range's own syntax: Maven for
 *      Forge/NeoForge, Fabric for Fabric/Quilt) and does not violate any other loaded mod's
 *      declared range on the same dependency.
 *    The project is the installed jar's (identified by hash), else `modrinth_resolve_mod_id`.
 *    `replace` is offered only when Rust will accept it: the installed provider is a top-level jar
 *    identified by hash, the chosen version is in the same project and published after it (no
 *    downgrades, invariant 8). Otherwise the advice names the version as a manual step.
 * 2. **Else switch the dependent mod.** When no dependency version fits, a version of the
 *    dependent mod (identified by hash, same project) for the pack's loader + MC whose Modrinth
 *    dependency list names the installed dependency's exact version id. Modrinth has no ranges,
 *    so that is the only thing we can know; `replace` under the same rules.
 * 3. **Else say so plainly**: "No Create version for Forge 1.20.1 matches 6.0 or newer ([6.0,));
 *    look for a version of X made for Create 0.5.1.f." — only after the version list was read
 *    and every candidate could be evaluated.
 * Anything unsure leaves the static finding unchanged. `.mrpack` packs get nothing (read-only).
 *
 * Flow (the UI, `src/ui/app/store.ts`): `depRangeRequests` lists the lookups still needed
 * (`modrinth_resolve_mod_id`, `modrinth_project_versions` with the pack's update filters and
 * `["release","beta"]`); the answers go into `DepRangeData`; `enrichDepRangeFindings` rewrites the
 * findings. A finding is matched to its dependency by recomputing its stable id. Pure.
 */
import type { Dependency, FixAction, MrProject, MrVersion } from '../../bindings';
import { isBuiltinDependency } from '../checks/builtins';
import { contextFor, type CheckContext, type ModEntry } from '../checks/context';
import { dependencyName, packTarget } from '../checks/depRangeText';
import { manual, modName, rawRange } from '../checks/evidence';
import { findingId } from '../crash/id';
import type { CheckInput, Finding, ModrinthContext } from '../model';
import { versionApi } from '../version';
import { hasPlaceholder } from '../version/placeholders';
import { rangeInWords } from '../version/words';
import { downloadFile, isNewerVersion, modrinthLoaders } from './index';

/** Modrinth answers the UI collected for E-DEP-RANGE advice. */
export interface DepRangeData {
  /** Lower-case mod id → `modrinth_resolve_mod_id` answer (null: Modrinth has no such project). */
  projectsByModId: Readonly<Record<string, MrProject | null>>;
  /** Project id → `modrinth_project_versions` for the pack's loaders + MC, release and beta. */
  versionsByProject: Readonly<Record<string, readonly MrVersion[]>>;
}

export function emptyDepRangeData(): DepRangeData {
  return { projectsByModId: {}, versionsByProject: {} };
}

export type DepRangeRequest = { kind: 'resolveModId'; modId: string } | { kind: 'projectVersions'; projectId: string };

const PLATFORM_IDS: readonly string[] = ['minecraft', 'forge', 'neoforge'];
const LOADER_WORDS: readonly string[] = ['neoforge', 'forge', 'fabric', 'quilt'];

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The mod's own version from a Modrinth `versionNumber`, or null when it can't be read with
 * confidence: `mc1.20.1-0.5.13-fabric` → `0.5.13`, `6.0.6+mc1.20.1` → `6.0.6`,
 * `create-1.20.1-6.0.6` (slug `create`) → `6.0.6`, `v2.1` → `2.1`.
 */
export function modVersionFromModrinth(versionNumber: string, mc: string | null, slug?: string | null): string | null {
  let s = typeof versionNumber === 'string' ? versionNumber.trim() : '';
  const m = mc?.trim() ?? '';
  const pieces = [...LOADER_WORDS, ...(m ? [`mc${escapeRe(m)}`, escapeRe(m)] : []), ...(slug ? [escapeRe(slug)] : [])];
  const sep = '[-+_ ]+';
  for (let changed = true; changed; ) {
    changed = false;
    for (const p of pieces) {
      const next = s.replace(new RegExp(`^(?:${p})${sep}`, 'i'), '').replace(new RegExp(`${sep}(?:${p})$`, 'i'), '');
      if (next !== s) {
        s = next;
        changed = true;
      }
    }
  }
  s = s.replace(/^v(?=\d)/i, '');
  if (!/^\d[0-9A-Za-z.+\-_]*$/.test(s)) return null;
  if (m && s.includes(m)) return null;
  // Another Minecraft version glued to the number (`1.19.2-6.0.6`): not the mod's own version.
  if (/^(?:mc)?1\.(?:[2-9]|[12]\d)(?:\.\d{1,2})?[-+_]\d/i.test(s) || /[-+_](?:mc)?1\.(?:[2-9]|[12]\d)(?:\.\d{1,2})?$/i.test(s)) return null;
  return s;
}

interface Target {
  finding: Finding;
  ctx: CheckContext;
  e: ModEntry;
  dep: Dependency;
  providers: readonly ModEntry[];
  /** The top-level provider whose jar a `replace` would swap (first one). */
  provider: ModEntry | null;
  /** Other loaded entries' declared ranges on the same dependency. */
  others: readonly { entry: ModEntry; dep: Dependency }[];
}

function enforced(e: ModEntry, dep: Dependency, side: 'client' | 'server'): boolean {
  const fml = e.mod.loader === 'forge' || e.mod.loader === 'neoforge' || e.mod.loader === 'legacyforge';
  if (!(dep.kind === 'required' || (fml && dep.kind === 'optional'))) return false;
  const s = dep.side?.trim().toUpperCase();
  return s === 'CLIENT' ? side === 'client' : s === 'SERVER' ? side === 'server' : true;
}

function targetsOf(findings: readonly Finding[], input: CheckInput): Target[] {
  if (input.instance.launcher === 'mrpack') return [];
  const ctx = contextFor(input);
  const out: Target[] = [];
  for (const f of findings) {
    if (f.code !== 'E-DEP-RANGE' || f.severity !== 'error') continue;
    const first = f.culprits[0];
    if (!first?.modId) continue;
    const jarIds = f.culprits.map((c) => c.jarId);
    for (const e of ctx.effective) {
      if (e.top.id !== first.jarId || e.mod.modId !== first.modId) continue;
      for (const dep of e.mod.deps) {
        if (PLATFORM_IDS.includes(dep.modId) || isBuiltinDependency(dep.modId, ctx.pack)) continue;
        if (findingId('E-DEP-RANGE', jarIds, `${e.mod.modId}->${dep.modId}`) !== f.id) continue;
        // An unfilled `${…}` placeholder: no version can satisfy it; the static text says so.
        if (hasPlaceholder(dep.range)) continue;
        const providers = ctx.versionProviders(dep.modId, ctx.connector.via(e.jar)).filter((p) => p.jar.id !== e.jar.id);
        if (providers.length === 0) continue;
        const others: { entry: ModEntry; dep: Dependency }[] = [];
        for (const o of ctx.effective) {
          if (o === e || o.jar.id === e.jar.id) continue;
          for (const d of o.mod.deps) if (d.modId === dep.modId && enforced(o, d, ctx.pack.side)) others.push({ entry: o, dep: d });
        }
        out.push({ finding: f, ctx, e, dep, providers, provider: providers.find((p) => p.jar.depth === 0) ?? null, others });
      }
    }
  }
  return out;
}

function sha1Of(e: ModEntry): string {
  return e.jar.sha1.trim().toLowerCase();
}

/** The identified Modrinth version of a top-level entry's jar. */
function identified(e: ModEntry | null, mr: ModrinthContext): MrVersion | undefined {
  return e && e.jar.depth === 0 && !e.jar.disabled ? mr.versions[sha1Of(e)] : undefined;
}

function suggestible(v: MrVersion): boolean {
  return v.versionType === 'release' || v.versionType === 'beta';
}

/** Lists the pack's loader + MC (the server filter is not trusted alone), downloadable. */
function compatible(v: MrVersion, loaders: readonly string[], mc: string): boolean {
  return (
    suggestible(v) &&
    v.loaders.some((l) => loaders.includes(l.toLowerCase())) &&
    v.gameVersions.some((g) => g.trim() === mc) &&
    downloadFile(v) !== null
  );
}

function newestFirst(a: MrVersion, b: MrVersion): number {
  return isNewerVersion(a, b) ? -1 : isNewerVersion(b, a) ? 1 : 0;
}

/** Release first (beta only when no release, or `includeBeta`). */
function preferRelease<T>(items: readonly T[], versionOf: (t: T) => MrVersion, includeBeta: boolean): T | null {
  if (includeBeta) return items[0] ?? null;
  return items.find((t) => versionOf(t).versionType === 'release') ?? items.find((t) => versionOf(t).versionType === 'beta') ?? null;
}

interface DepProject {
  id: string;
  title: string;
  slug: string | null;
}

type Advice =
  | { kind: 'switchDep'; project: DepProject; version: MrVersion; replace: FixAction | null; downgrade: boolean }
  | { kind: 'switchDependent'; project: DepProject; version: MrVersion; replace: FixAction | null }
  | { kind: 'noDepVersion'; project: DepProject; conflict: { version: MrVersion; other: { entry: ModEntry; dep: Dependency } } | null };

function depProject(t: Target, mr: ModrinthContext, data: DepRangeData): DepProject | 'resolve' | null {
  const cur = identified(t.provider, mr);
  if (cur) {
    const p = mr.projects[cur.projectId];
    return { id: cur.projectId, title: p?.title ?? dependencyName(t.dep.modId, t.providers), slug: p?.slug ?? null };
  }
  const key = t.dep.modId.toLowerCase();
  if (!(key in data.projectsByModId)) return 'resolve';
  const p = data.projectsByModId[key];
  return p ? { id: p.id, title: p.title || dependencyName(t.dep.modId, t.providers), slug: p.slug || null } : null;
}

function analyze(t: Target, mr: ModrinthContext, data: DepRangeData, includeBeta: boolean): { advice: Advice | null; needs: DepRangeRequest[] } {
  const none = { advice: null, needs: [] };
  const mc = t.ctx.pack.mcVersion?.trim() ?? '';
  const loaders = modrinthLoaders(t.ctx.pack);
  if (!mc || loaders.length === 0 || mr.offline) return none;
  const project = depProject(t, mr, data);
  if (project === null) return none;
  if (project === 'resolve') return { advice: null, needs: [{ kind: 'resolveModId', modId: t.dep.modId.toLowerCase() }] };
  const versions = data.versionsByProject[project.id];
  if (!versions) return { advice: null, needs: [{ kind: 'projectVersions', projectId: project.id }] };

  const syntax = t.dep.range.syntax;
  // Calibrate: the installed jar's own Modrinth number must read as its declared version.
  const current = identified(t.provider, mr);
  if (current && current.projectId === project.id && t.provider) {
    const n = modVersionFromModrinth(current.versionNumber, mc, project.slug);
    if (n === null || versionApi.compare(n, t.provider.mod.version, syntax, 'other') !== 0) return none;
  }
  const readable: { v: MrVersion; num: string }[] = [];
  let unreadable = 0;
  for (const v of versions) {
    if (v.projectId !== project.id || !compatible(v, loaders, mc)) continue;
    const num = modVersionFromModrinth(v.versionNumber, mc, project.slug);
    if (num === null) unreadable++;
    else readable.push({ v, num });
  }
  if (unreadable > 0 && readable.length === 0) return none;
  const fits = readable.filter((c) => versionApi.satisfies(c.num, t.dep.range, 'other') === true);
  const fitsAll = fits.filter((c) => t.others.every((o) => versionApi.satisfies(c.num, o.dep.range, 'other') !== false));
  const order = (a: { v: MrVersion; num: string }, b: { v: MrVersion; num: string }) =>
    -versionApi.compare(a.num, b.num, syntax, 'other') || newestFirst(a.v, b.v);
  const chosen = preferRelease([...fitsAll].sort(order), (c) => c.v, includeBeta);
  if (chosen) {
    const sameProject = !!current && current.projectId === chosen.v.projectId;
    const newer = sameProject && !!current && isNewerVersion(chosen.v, current);
    const replace: FixAction | null = newer && t.provider ? { kind: 'replace', jarId: t.provider.top.id, versionId: chosen.v.id } : null;
    return { advice: { kind: 'switchDep', project, version: chosen.v, replace, downgrade: sameProject && !newer }, needs: [] };
  }
  // A fitting version that breaks another mod's range is no way out either.
  const blocked = [...fits].sort(order)[0];
  const conflictWith = blocked ? t.others.find((o) => versionApi.satisfies(blocked.num, o.dep.range, 'other') === false) : undefined;
  if (unreadable > 0 && !blocked) return none; // An unreadable version might have fitted.
  const fallback: Advice = {
    kind: 'noDepVersion',
    project,
    conflict: blocked && conflictWith ? { version: blocked.v, other: conflictWith } : null,
  };

  // The other way round: a version of the dependent mod made for the installed dependency.
  const xCurrent = identified(t.e.jar.depth === 0 ? t.e : null, mr);
  if (!xCurrent || !current) return { advice: fallback, needs: [] };
  const xVersions = data.versionsByProject[xCurrent.projectId];
  if (!xVersions) return { advice: fallback, needs: [{ kind: 'projectVersions', projectId: xCurrent.projectId }] };
  const accepting = xVersions
    .filter((v) => v.projectId === xCurrent.projectId && v.id !== xCurrent.id && compatible(v, loaders, mc))
    .filter((v) => v.dependencies.some((d) => d.versionId === current.id && d.dependencyType !== 'incompatible'))
    .sort(newestFirst);
  const xv = preferRelease(accepting, (v) => v, includeBeta);
  if (!xv) return { advice: fallback, needs: [] };
  const replace: FixAction | null = isNewerVersion(xv, xCurrent) ? { kind: 'replace', jarId: t.e.top.id, versionId: xv.id } : null;
  return { advice: { kind: 'switchDependent', project, version: xv, replace }, needs: [] };
}

/**
 * The Modrinth lookups still needed to advise on the E-DEP-RANGE findings (deduplicated, in
 * finding order). `input` is the `CheckInput` the findings came from; `mr` its Modrinth context.
 */
export function depRangeRequests(findings: readonly Finding[], input: CheckInput, mr: ModrinthContext | null | undefined, data: DepRangeData): DepRangeRequest[] {
  if (!mr || mr.offline) return [];
  const out: DepRangeRequest[] = [];
  const seen = new Set<string>();
  for (const t of targetsOf(findings, input)) {
    for (const r of analyze(t, mr, data, false).needs) {
      const key = r.kind === 'resolveModId' ? `m:${r.modId}` : `p:${r.projectId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(r);
    }
  }
  return out;
}

function beta(v: MrVersion): string {
  return v.versionType === 'release' ? '' : ' (beta)';
}

function withNote(f: Finding, text: string): Finding['evidence'] {
  const ev = [...f.evidence];
  // Before the trailing pack note, like the other notes.
  const at = ev.length > 0 && ev[ev.length - 1]?.kind === 'note' ? ev.length - 1 : ev.length;
  ev.splice(at, 0, { kind: 'note', text });
  return ev;
}

function rewrite(t: Target, advice: Advice): Finding {
  const f = t.finding;
  const name = modName(t.e.mod);
  const target = packTarget(t.ctx) ?? 'this pack';
  const dep = advice.project.title;
  const raw = rawRange(t.dep.range);
  const words = rangeInWords(t.dep.range);
  const installed = t.provider?.mod.version ?? t.providers[0]?.mod.version ?? 'the installed version';
  const providerFile = t.provider?.top.fileName ?? t.providers[0]?.top.fileName ?? null;
  const rest = f.fixes.filter((x) => x.kind !== 'manual');
  const otherWay = `Or use a version of ${name} made for ${dep} ${installed}.`;
  switch (advice.kind) {
    case 'switchDep': {
      const v = advice.version;
      const accepts = t.others.length > 0 ? `${name} and the other mods that depend on it accept` : `${name} accepts`;
      const sentence = `Switch ${dep} to ${v.versionNumber}${beta(v)} (the newest ${dep} for ${target} that ${accepts}).`;
      const by =
        advice.downgrade
          ? `It is older than the installed ${installed}, so the app won't swap it automatically: download ${dep} ${v.versionNumber} from Modrinth and replace ${providerFile ?? 'the installed jar'} with it.`
          : `Download ${dep} ${v.versionNumber} from Modrinth and replace ${providerFile ?? 'the installed jar'} with it.`;
      return {
        ...f,
        title: `${f.title} — switch ${dep} to ${v.versionNumber}`,
        explanation: `${f.explanation} ${sentence}`,
        evidence: withNote(f, `Modrinth: ${dep} ${v.versionNumber} is the newest ${dep} for ${target} in ${words} (${raw}).`),
        fixes: advice.replace ? [advice.replace, manual(otherWay), ...rest] : [manual(sentence, by, otherWay), ...rest],
      };
    }
    case 'switchDependent': {
      const v = advice.version;
      const sentence =
        `No ${dep} version for ${target} matches ${words} (${raw}). ` +
        `Update ${name} to ${v.versionNumber}${beta(v)}: Modrinth lists it as made for the installed ${dep} ${installed}.`;
      const by = advice.replace ? null : `Download ${name} ${v.versionNumber} from Modrinth and replace ${t.e.top.fileName} with it.`;
      return {
        ...f,
        title: `${f.title} — update ${name} to ${v.versionNumber}`,
        explanation: `${f.explanation} ${sentence}`,
        evidence: withNote(f, `Modrinth: ${name} ${v.versionNumber} depends on ${dep} ${installed} exactly.`),
        fixes: advice.replace ? [advice.replace, ...rest] : [manual(sentence, ...(by ? [by] : [])), ...rest],
      };
    }
    case 'noDepVersion': {
      const c = advice.conflict;
      const sentence = c
        ? `${dep} ${c.version.versionNumber} would suit ${name}, but ${modName(c.other.entry.mod)} needs ${dep} ${rangeInWords(c.other.dep.range)} (${rawRange(c.other.dep.range)}), ` +
          `and no ${dep} version for ${target} satisfies both. Look for a version of ${name} made for ${dep} ${installed}.`
        : `No ${dep} version for ${target} matches ${words} (${raw}); look for a version of ${name} made for ${dep} ${installed}.`;
      return {
        ...f,
        explanation: `${f.explanation} ${sentence}`,
        evidence: withNote(f, `Modrinth: no ${dep} version for ${target} is in ${words} (${raw}).`),
        fixes: [manual(sentence), ...rest],
      };
    }
  }
}

/**
 * New findings (inputs untouched, ids unchanged) with E-DEP-RANGE advice from Modrinth. Unchanged
 * when `mr` is null/offline, for packs, and wherever the advice would be a guess.
 */
export function enrichDepRangeFindings(
  findings: readonly Finding[],
  input: CheckInput,
  mr: ModrinthContext | null | undefined,
  data: DepRangeData,
  includeBeta = false,
): Finding[] {
  if (!mr || mr.offline) return [...findings];
  const advised = new Map<string, Finding>();
  for (const t of targetsOf(findings, input)) {
    if (advised.has(t.finding.id)) continue;
    const { advice } = analyze(t, mr, data, includeBeta);
    if (advice) advised.set(t.finding.id, rewrite(t, advice));
  }
  return findings.map((f) => advised.get(f.id) ?? f);
}

/**
 * Every version `DepRangeData` holds, with its project title when known: what the fix buttons
 * need to say "Update Create to 6.0.6".
 */
export function depRangeVersions(data: DepRangeData, mr: ModrinthContext | null | undefined): { version: MrVersion; title: string | null }[] {
  const titles = new Map<string, string>();
  for (const p of Object.values(data.projectsByModId)) if (p) titles.set(p.id, p.title);
  const out: { version: MrVersion; title: string | null }[] = [];
  for (const list of Object.values(data.versionsByProject)) {
    for (const v of list) out.push({ version: v, title: mr?.projects[v.projectId]?.title ?? titles.get(v.projectId) ?? null });
  }
  return out;
}
