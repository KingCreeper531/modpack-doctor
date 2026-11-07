/**
 * Report export (M7, CONTRACTS invariant 16). FROZEN API — implementation owned by the M7 core
 * agent. Pure: builds the report from what the UI already holds; `save_report` (Rust) writes it.
 *
 * Privacy: every string of the report (titles, explanations, evidence, culprits, log sources, the
 * game dir, the instance name) has the user's home folder replaced by `~` (`homeScrubber`:
 * either separator, any case, NFC/NFD, UTF-8 percent-encoded, Windows 8.3 short names, UNC admin
 * shares `\\host\C$\…`, whole folder names only; strings come out NFC). Jar paths are relative
 * to the game dir (`mods/sodium-0.5.8.jar`, `overrides/mods/x.jar`; a `.mrpack` index entry by its
 * index path), log sources are their relative source ids.
 *
 * Determinism: the same input gives the same document, Markdown and JSON byte for byte. Findings
 * keep the order they were given in (`runChecks` / `analyzeCrash` order); crash sources are sorted
 * by id; `generatedAt` is the ISO-8601 UTC form of `generatedAtMs` (the file name's date too).
 *
 * `counts` cover the static AND crash findings in the report. `modrinth` counts every top-level
 * jar (enabled or disabled) and every `.mrpack` declared file by its match state
 * (`jarMatch` / `declaredMatch`); null without a Modrinth context. Fix labels come from a small
 * pure labeler (`./text.ts`, `fixLabel`), never from UI code.
 */
import type { Instance, LoaderInfo, ScanResult } from '../../bindings';
import type { Finding, ModrinthContext, PackContext } from '../model';
import { declaredMatch, jarMatch } from '../modrinth';
import { LOADER_NAMES } from '../pack';
import { evidenceText, fixLabel, homeScrubber, mdCellCode, mdCode, mdFence, mdInline, mdText, type VersionFacts } from './text';

export const REPORT_SCHEMA_VERSION = 1;

export interface ReportInput {
  instance: Instance;
  pack: PackContext;
  scan: ScanResult;
  /** Static findings (after Modrinth enrichment, if any). */
  findings: readonly Finding[];
  /** Crash findings by log source id (e.g. `crash-reports/crash-….txt`). */
  crashes?: Readonly<Record<string, readonly Finding[]>>;
  modrinth?: ModrinthContext | null;
  /** App version, e.g. `0.1.0`. */
  appVersion: string;
  /** Epoch ms the report was generated. */
  generatedAtMs: number;
  /**
   * The user's home folder (absolute, any separators), replaced by `~` wherever it appears so the
   * report carries no personal path. Empty string = no replacement.
   */
  homeDir: string;
}

/** The report as plain data; `reportJson` serialises exactly this (plus `schemaVersion`). */
export interface ReportDoc {
  schemaVersion: 1;
  app: { name: 'Modpack Doctor'; version: string };
  generatedAt: string;
  instance: { name: string; launcher: string; gameDir: string; mcVersion: string | null; loader: string | null; side: string };
  pack: { mcVersion: string | null; loader: string | null; source: PackContext['source'] };
  scan: { jars: number; topLevel: number; disabled: number; issues: number; durationMs: number };
  counts: { error: number; warning: number; info: number };
  findings: ReportFinding[];
  crashes: Array<{ source: string; findings: ReportFinding[] }>;
  modrinth: { identified: number; updates: number; notOnModrinth: number; unknown: number } | null;
}

export interface ReportFinding {
  code: string;
  severity: Finding['severity'];
  title: string;
  explanation: string;
  culprits: string[];
  /** Evidence rendered to text lines (metadata excerpts, log lines with numbers, notes). */
  evidence: string[];
  /** Human labels of the suggested fixes (never executed by the report). */
  fixes: string[];
}

// ---- building ----------------------------------------------------------------------------------

const NAME = 'Modpack Doctor';
export const NON_AFFILIATION = 'Not affiliated with or endorsed by Modrinth, Mojang, Microsoft, Forge, NeoForge, Fabric, or Quilt.';

function loaderText(loader: LoaderInfo | null | undefined): string | null {
  if (!loader) return null;
  const name = loader.kind === 'unknown' ? 'Unknown' : (LOADER_NAMES[loader.kind] ?? String(loader.kind));
  return loader.version ? `${name} ${loader.version}` : name;
}

function isoDate(ms: number): string {
  const d = new Date(Number.isFinite(ms) ? ms : 0);
  return Number.isNaN(d.getTime()) ? new Date(0).toISOString() : d.toISOString();
}

function basename(path: string): string {
  const parts = path.split('/');
  return parts[parts.length - 1] || path;
}

function count(n: unknown): number {
  return typeof n === 'number' && Number.isFinite(n) ? n : 0;
}

/** Facts about every Modrinth version the context knows (identified versions and updates). */
function versionFacts(mr: ModrinthContext | null | undefined): (id: string) => VersionFacts | undefined {
  const byId = new Map<string, VersionFacts>();
  for (const v of [...Object.values(mr?.versions ?? {}), ...Object.values(mr?.updates ?? {})]) {
    if (!v || byId.has(v.id)) continue;
    byId.set(v.id, { versionNumber: v.versionNumber, title: mr?.projects[v.projectId]?.title ?? null, beta: v.versionType !== 'release' });
  }
  return (id) => byId.get(id);
}

function modrinthSummary(input: ReportInput): ReportDoc['modrinth'] {
  const mr = input.modrinth;
  if (!mr) return null;
  const out = { identified: 0, updates: 0, notOnModrinth: 0, unknown: 0 };
  const states = [
    ...input.scan.jars.filter((j) => j.depth === 0).map((j) => jarMatch(j, mr).state),
    ...(input.scan.declared ?? []).map((d) => declaredMatch(d, mr).state),
  ];
  for (const state of states) {
    if (state === 'matched') out.identified++;
    else if (state === 'update') {
      out.identified++;
      out.updates++;
    } else if (state === 'missing') out.notOnModrinth++;
    else out.unknown++;
  }
  return out;
}

/** Fixed key order for the document (JSON output is stable whatever object it was given). */
function canonicalFinding(f: ReportFinding): ReportFinding {
  return {
    code: f.code,
    severity: f.severity,
    title: f.title,
    explanation: f.explanation,
    culprits: [...f.culprits],
    evidence: [...f.evidence],
    fixes: [...f.fixes],
  };
}

function canonical(doc: ReportDoc): ReportDoc {
  return {
    schemaVersion: 1,
    app: { name: NAME, version: doc.app.version },
    generatedAt: doc.generatedAt,
    instance: {
      name: doc.instance.name,
      launcher: doc.instance.launcher,
      gameDir: doc.instance.gameDir,
      mcVersion: doc.instance.mcVersion,
      loader: doc.instance.loader,
      side: doc.instance.side,
    },
    pack: { mcVersion: doc.pack.mcVersion, loader: doc.pack.loader, source: doc.pack.source },
    scan: {
      jars: doc.scan.jars,
      topLevel: doc.scan.topLevel,
      disabled: doc.scan.disabled,
      issues: doc.scan.issues,
      durationMs: doc.scan.durationMs,
    },
    counts: { error: doc.counts.error, warning: doc.counts.warning, info: doc.counts.info },
    findings: doc.findings.map(canonicalFinding),
    crashes: doc.crashes.map((c) => ({ source: c.source, findings: c.findings.map(canonicalFinding) })),
    modrinth: doc.modrinth
      ? { identified: doc.modrinth.identified, updates: doc.modrinth.updates, notOnModrinth: doc.modrinth.notOnModrinth, unknown: doc.modrinth.unknown }
      : null,
  };
}

/** Apply `fn` to every string in a JSON-like value. */
function mapStrings<T>(value: T, fn: (s: string) => string): T {
  if (typeof value === 'string') return fn(value) as T;
  if (Array.isArray(value)) return value.map((v: unknown) => mapStrings(v, fn)) as T;
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = mapStrings(v, fn);
    return out as T;
  }
  return value;
}

/** Build the report data; deterministic for the same input. */
export function buildReport(input: ReportInput): ReportDoc {
  const { instance, pack, scan } = input;
  const jars = new Map(scan.jars.map((j) => [j.id, j] as const));
  const declared = new Set((scan.declared ?? []).map((d) => d.path));
  /** Path shown for a jar id: the top-level jar's real relative path, else the id itself. */
  const jarPath = (jarId: string): string => {
    const j = jars.get(jarId);
    return j && j.depth === 0 ? j.path : jarId;
  };
  /** Name in fix labels: the jar's file name, else the id's last segment (`#disabled` dropped). */
  const jarName = (jarId: string): string => jars.get(jarId)?.fileName ?? basename(jarId.replace(/#disabled$/, ''));
  const version = versionFacts(input.modrinth);

  const finding = (f: Finding): ReportFinding => ({
    code: f.code,
    severity: f.severity,
    title: f.title,
    explanation: f.explanation,
    culprits: f.culprits.map((c) => {
      const where = declared.has(c.jarId) && !jars.has(c.jarId) ? `${c.jarId} (.mrpack index)` : jarPath(c.jarId);
      return c.modId ? `${where} (${c.modId})` : where;
    }),
    evidence: f.evidence.map((e) => evidenceText(e, jarPath)),
    fixes: f.fixes.map((fix) => fixLabel(fix, jarName, version)),
  });

  const findings = input.findings.map(finding);
  const crashSources = Object.keys(input.crashes ?? {}).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const crashes = crashSources.map((source) => ({ source, findings: (input.crashes?.[source] ?? []).map(finding) }));
  const counts = { error: 0, warning: 0, info: 0 };
  for (const f of [...findings, ...crashes.flatMap((c) => c.findings)]) counts[f.severity]++;
  const top = scan.jars.filter((j) => j.depth === 0);

  const doc: ReportDoc = {
    schemaVersion: 1,
    app: { name: NAME, version: input.appVersion },
    generatedAt: isoDate(input.generatedAtMs),
    instance: {
      name: instance.name,
      launcher: instance.launcher,
      gameDir: instance.gameDir,
      mcVersion: instance.mcVersion,
      loader: loaderText(instance.loader),
      side: instance.side,
    },
    pack: { mcVersion: pack.mcVersion, loader: loaderText(pack.loader), source: pack.source },
    scan: {
      jars: scan.jars.length,
      topLevel: top.length,
      disabled: top.filter((j) => j.disabled).length,
      issues: scan.issues.length,
      durationMs: count(scan.durationMs),
    },
    counts,
    findings,
    crashes,
    modrinth: modrinthSummary(input),
  };
  return mapStrings(canonical(doc), homeScrubber(input.homeDir));
}

// ---- Markdown ----------------------------------------------------------------------------------

const SEVERITY_HEADING: Readonly<Record<Finding['severity'], string>> = { error: 'Errors', warning: 'Warnings', info: 'Info' };
const SEVERITIES: readonly Finding['severity'][] = ['error', 'warning', 'info'];

const SOURCE_TEXT: Readonly<Record<PackContext['source'], string>> = {
  override: 'your override',
  launcher: 'launcher metadata',
  mrpack: 'the .mrpack index',
  majority: 'inferred from the installed mods',
  unknown: 'not known',
};

function packLoaderText(doc: ReportDoc): string {
  if (doc.pack.loader) return doc.pack.loader;
  return doc.pack.source === 'launcher' || doc.pack.source === 'mrpack' ? 'none (vanilla)' : 'unknown';
}

function renderFinding(f: ReportFinding, level: string): string[] {
  const out = [`${level} ${mdCode(f.code)} ${mdInline(f.title)}`, ''];
  if (f.culprits.length > 0) out.push(`**Culprits:** ${f.culprits.map(mdCode).join(', ')}`, '');
  if (f.explanation.trim().length > 0) out.push(mdText(f.explanation), '');
  if (f.evidence.length > 0) {
    out.push('**Evidence**', '');
    for (const e of f.evidence) out.push(mdFence(e), '');
  }
  if (f.fixes.length > 0) {
    out.push('**Suggested fixes** (the report applies nothing)', '');
    f.fixes.forEach((fix, i) => out.push(`${i + 1}. ${mdText(fix)}`));
    out.push('');
  }
  return out;
}

function renderBySeverity(findings: readonly ReportFinding[], level: string): string[] {
  const out: string[] = [];
  for (const sev of SEVERITIES) {
    const group = findings.filter((f) => f.severity === sev);
    if (group.length === 0) continue;
    out.push(`${level} ${SEVERITY_HEADING[sev]} (${group.length})`, '');
    for (const f of group) out.push(...renderFinding(f, `${level}#`));
  }
  return out;
}

function row(label: string, value: string): string {
  return `| ${label} | ${value} |`;
}

/** Markdown (GitHub-flavoured) with a summary table, findings by severity, crash sections. */
export function reportMarkdown(doc: ReportDoc): string {
  const d = canonical(doc);
  const out: string[] = [`# ${NAME} report: ${mdInline(d.instance.name)}`, ''];

  out.push('## Summary', '', '| | |', '|---|---|');
  out.push(row('Instance', mdInline(d.instance.name)));
  out.push(row('Launcher', mdInline(d.instance.launcher)));
  out.push(row('Game folder', mdCellCode(d.instance.gameDir)));
  out.push(row('Minecraft', mdInline(d.pack.mcVersion ?? 'unknown')));
  out.push(row('Loader', mdInline(packLoaderText(d))));
  out.push(row('Pack identity from', mdInline(SOURCE_TEXT[d.pack.source] ?? String(d.pack.source))));
  if (d.instance.mcVersion !== d.pack.mcVersion || d.instance.loader !== d.pack.loader) {
    out.push(row('Launcher says', mdInline(`Minecraft ${d.instance.mcVersion ?? 'unknown'}, ${d.instance.loader ?? 'no loader'}`)));
  }
  out.push(row('Side', mdInline(d.instance.side)));
  out.push(row('Jars', `${d.scan.jars} (${d.scan.topLevel} top-level, ${d.scan.disabled} disabled)`));
  out.push(row('Scan issues', String(d.scan.issues)));
  out.push(row('Scan time', `${d.scan.durationMs} ms`));
  out.push(row('Errors', String(d.counts.error)));
  out.push(row('Warnings', String(d.counts.warning)));
  out.push(row('Info', String(d.counts.info)));
  out.push(row('Generated', mdInline(d.generatedAt)));
  out.push('');

  out.push('## Findings', '');
  if (d.findings.length === 0) out.push('No problems found by the static checks.', '');
  else out.push(...renderBySeverity(d.findings, '###'));

  if (d.crashes.length > 0) {
    out.push('## Crash analysis', '');
    for (const c of d.crashes) {
      out.push(`### ${mdCode(c.source)}`, '');
      if (c.findings.length === 0) out.push('Nothing recognised in this log.', '');
      else out.push(...renderBySeverity(c.findings, '####'));
    }
  }

  out.push('## Modrinth', '');
  if (d.modrinth) {
    out.push('| Identified | Updates available | Not on Modrinth | Unknown |', '|---|---|---|---|');
    out.push(`| ${d.modrinth.identified} | ${d.modrinth.updates} | ${d.modrinth.notOnModrinth} | ${d.modrinth.unknown} |`, '');
  } else {
    out.push('Modrinth was not consulted for this report (offline or turned off).', '');
  }

  out.push('---', '', `Generated by ${NAME} ${mdInline(d.app.version)}`, '', NON_AFFILIATION, '');
  return out.join('\n');
}

/** Pretty-printed JSON of `doc`. */
export function reportJson(doc: ReportDoc): string {
  return `${JSON.stringify(canonical(doc), null, 2)}\n`;
}

/** Default file name without extension: `modpack-doctor-<instance slug>-<YYYY-MM-DD>`. */
export function reportFileName(doc: ReportDoc): string {
  const slug =
    (typeof doc.instance.name === 'string' ? doc.instance.name : '')
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48)
      .replace(/-+$/, '') || 'instance';
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(typeof doc.generatedAt === 'string' ? doc.generatedAt : '');
  return `modpack-doctor-${slug}-${m?.[1] ?? '1970-01-01'}`;
}
