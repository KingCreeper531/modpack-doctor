/**
 * Per-instance crash and log analysis state (M4), held by the store (store.ts), plus pure
 * helpers the crash views share. No React, no IPC.
 *
 * Flow: `list_log_sources` → the user (or the default rule below) picks a source →
 * `read_log_digest(…, CRASH_ANCHOR_TEXTS)` → `analyzeCrash({ digest, index, pack })` → crash
 * findings (C-* codes) plus `summarizeCrash`. The digest is kept, so a finished scan or a pack
 * override re-runs the analysis with jar mapping without reading the file again.
 */
import type { AppError, LogDigest, LogKind, LogSource } from '../../bindings';
import type { CrashSummary } from '../../core/crash/summary';
import type { Finding, FrameRef, LogLine } from '../../core/model';
import { logPath } from '../components/format';

/** The findings panel's legends: static findings, crash analysis, backup history (M6). */
export type FindingsTab = 'findings' | 'crashes' | 'history';
export type CrashPane = 'diagnosis' | 'log';

export interface CrashAnalysis {
  status: 'loading' | 'done' | 'error';
  digest: LogDigest | null;
  findings: Finding[];
  /** Non-null only when an error-severity crash finding exists. */
  summary: CrashSummary | null;
  error: AppError | null;
  /** Whether the findings were mapped against a scan (jar chips, culprits). */
  mapped: boolean;
}

export interface InstanceCrashes {
  sourcesStatus: 'idle' | 'loading' | 'done' | 'error';
  /** Newest first. */
  sources: LogSource[];
  sourcesError: AppError | null;
  selectedSourceId: string | null;
  /** Keyed by source id. */
  analyses: Readonly<Record<string, CrashAnalysis>>;
  pane: CrashPane;
  /** A line the log pane should scroll to (inspector "Show in log"). */
  logLine: number | null;
  /**
   * Bumped on every explicit "Show in log" request, so the log pane scrolls only when asked
   * (again, even to the same line) and never because the digest was re-analysed.
   */
  logRequest: number;
}

/** An announced crash the user has not looked at yet (rail pip, banner). */
export interface CrashAlert {
  instanceId: string;
  episode: number;
  sourceId: string;
  summary: CrashSummary;
}

export function emptyCrashes(): InstanceCrashes {
  return { sourcesStatus: 'idle', sources: [], sourcesError: null, selectedSourceId: null, analyses: {}, pane: 'diagnosis', logLine: null, logRequest: 0 };
}

/** Title of a crash notification when the instance's name is not known. */
export const CRASH_NOTIFICATION_FALLBACK_TITLE = 'Modpack crashed';

/**
 * The native notification for an announced crash. Title: `<instance name> crashed`. Body: the
 * likely cause; when the cause is not known, the top error crash finding's own title; never a
 * repeat of the title or of the summary headline.
 */
export function crashNotification(
  instanceName: string | null | undefined,
  summary: CrashSummary,
  findings: readonly Finding[],
  sourceId: string,
): { title: string; body: string } {
  const name = instanceName?.replace(/\s+/g, ' ').trim();
  const title = name ? `${name} crashed` : CRASH_NOTIFICATION_FALLBACK_TITLE;
  if (summary.likelyCause) return { title, body: `Likely cause: ${summary.likelyCause}` };
  const top = findings.find((f) => f.severity === 'error' && f.code.startsWith('C-'));
  const findingTitle = top?.title.replace(/\s+/g, ' ').trim() ?? '';
  const body = findingTitle && findingTitle !== title && findingTitle !== summary.headline ? findingTitle : `See ${sourceName(sourceId)} in Modpack Doctor.`;
  return { title, body };
}

export const LOG_KIND_LABEL: Record<LogKind, string> = {
  crashReport: 'crash report',
  latestLog: 'latest log',
  debugLog: 'debug log',
  hsErr: 'JVM crash',
  launcherLog: 'console output',
};

/** Newest first; ties by id so the order is stable. */
export function sortSources(sources: readonly LogSource[]): LogSource[] {
  return [...sources].sort((a, b) => b.modifiedMs - a.modifiedMs || a.id.localeCompare(b.id));
}

/** Insert or replace one source, keeping newest-first order. */
export function upsertSource(sources: readonly LogSource[], source: LogSource): LogSource[] {
  return sortSources([...sources.filter((s) => s.id !== source.id), source]);
}

/**
 * The source selected when an instance's logs load (predictable on purpose): the newest crash
 * report or hs_err file; when there is none, the newest log; nothing for an empty list.
 */
export function defaultSourceId(sources: readonly LogSource[]): string | null {
  const sorted = sortSources(sources);
  const crash = sorted.find((s) => s.kind === 'crashReport' || s.kind === 'hsErr');
  return (crash ?? sorted[0])?.id ?? null;
}

/** `crash-reports/crash-…-client.txt` → `crash-…-client.txt`. */
export function sourceName(id: string): string {
  const i = id.lastIndexOf('/');
  return i < 0 ? id : id.slice(i + 1);
}

/** `crash-reports/crash-…-client.txt` → `crash-reports/` (empty for a top-level file). */
export function sourceDir(id: string): string {
  const path = logPath(id);
  const i = path.lastIndexOf('/');
  return i < 0 ? '' : path.slice(0, i + 1);
}

/**
 * The whole digest as log-viewer lines: culprit lines of every finding highlighted, the rest
 * context. Also the union of mapped stack frames (chips), deduplicated.
 */
export function digestView(digest: LogDigest, findings: readonly Finding[]): { lines: LogLine[]; frames: FrameRef[] } {
  const culprit = new Set<number>();
  const frames = new Map<string, FrameRef>();
  for (const f of findings) {
    for (const e of f.evidence) {
      if (e.kind !== 'log' || e.source !== digest.source.id) continue;
      for (const l of e.lines) if (l.role === 'culprit') culprit.add(l.n);
      for (const fr of e.frames) frames.set(`${fr.line}:${fr.jarId}`, fr);
    }
  }
  const lines: LogLine[] = [];
  const seen = new Set<number>();
  for (const chunk of [...digest.chunks].sort((a, b) => a.startLine - b.startLine)) {
    chunk.lines.forEach((raw, i) => {
      const n = chunk.startLine + i;
      if (seen.has(n)) return;
      seen.add(n);
      const text = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
      lines.push({ n, text, role: culprit.has(n) ? 'culprit' : 'context' });
    });
  }
  return { lines, frames: [...frames.values()] };
}

/** First culprit line of a finding's log evidence (for "Show in log"). */
export function firstCulpritLine(f: Finding): number | null {
  for (const e of f.evidence) {
    if (e.kind !== 'log') continue;
    const l = e.lines.find((x) => x.role === 'culprit') ?? e.lines[0];
    if (l) return l.n;
  }
  return null;
}

export interface CitingCrash {
  sourceId: string;
  finding: Finding;
}

/** Crash findings (any analysed source of the instance) that name `jarId` as a culprit. */
export function crashFindingsCiting(crashes: InstanceCrashes | undefined, jarId: string): CitingCrash[] {
  if (!crashes) return [];
  const out: CitingCrash[] = [];
  for (const s of crashes.sources) {
    const a = crashes.analyses[s.id];
    if (a?.status !== 'done') continue;
    for (const f of a.findings) if (f.culprits.some((c) => c.jarId === jarId)) out.push({ sourceId: s.id, finding: f });
  }
  return out;
}
