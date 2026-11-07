/**
 * Report export (CONTRACTS invariant 16), UI side: the `ReportInput` from what the screen shows
 * (static findings after Modrinth enrichment, every crash source analysed so far, the Modrinth
 * context the mod table uses), then `src/core/report` builds the document and `save_report`
 * writes it where the user picks.
 *
 * Home folder: the webview has no path API (no `core:path` permission, CONTRACTS invariant 1), so
 * the home folder is derived from the instance's own paths (`C:\Users\<name>`, `/Users/<name>`,
 * `/home/<name>`). A game dir outside the home folder needs no replacement; anything else falls
 * back to '' (no replacement).
 */
import type { AppError, ReportFormat } from '../../bindings';
import type { Finding } from '../../core/model';
import type { ReportDoc, ReportInput } from '../../core/report';
import { viewContext } from './modrinthState';
import type { AppState } from './store';

/** The frozen `src/core/report` API (injectable for tests). */
export interface ReportCoreApi {
  buildReport(input: ReportInput): ReportDoc;
  reportMarkdown(doc: ReportDoc): string;
  reportJson(doc: ReportDoc): string;
  reportFileName(doc: ReportDoc): string;
}

const HOME_PATTERNS: readonly RegExp[] = [
  /^([A-Za-z]:[\\/]+Users[\\/]+[^\\/]+)(?=[\\/]|$)/i,
  /^(\/Users\/[^/]+)(?=\/|$)/,
  /^(\/home\/[^/]+)(?=\/|$)/,
  /^(\/root)(?=\/|$)/,
  /^(\/var\/home\/[^/]+)(?=\/|$)/,
];

/** The home folder named by the first path that lives in one, else ''. */
export function guessHomeDir(paths: readonly string[]): string {
  for (const p of paths) {
    for (const re of HOME_PATTERNS) {
      const m = re.exec(p);
      if (m?.[1]) return m[1];
    }
  }
  return '';
}

/** Why a report cannot be built yet, or null. */
export function reportBlock(s: Pick<AppState, 'scans' | 'discovery'>, instanceId: string): string | null {
  if (!s.discovery?.instances.some((i) => i.id === instanceId)) return 'This instance is no longer in the list.';
  const sc = s.scans[instanceId];
  if (!sc?.result || !sc.pack || sc.status === 'idle') return 'Scan the instance before exporting a report.';
  return null;
}

export function reportInput(
  s: Pick<AppState, 'scans' | 'discovery' | 'crashes' | 'modrinth'>,
  instanceId: string,
  meta: { appVersion: string; generatedAtMs: number },
): ReportInput | null {
  const instance = s.discovery?.instances.find((i) => i.id === instanceId);
  const sc = s.scans[instanceId];
  if (!instance || !sc?.result || !sc.pack) return null;
  const crashes: Record<string, readonly Finding[]> = {};
  for (const [sourceId, a] of Object.entries(s.crashes[instanceId]?.analyses ?? {})) {
    if (a.status === 'done' && a.findings.length) crashes[sourceId] = a.findings;
  }
  return {
    instance,
    pack: sc.pack,
    scan: sc.result,
    findings: sc.findings,
    crashes,
    modrinth: viewContext(s.modrinth[instanceId], sc.result),
    appVersion: meta.appVersion,
    generatedAtMs: meta.generatedAtMs,
    homeDir: guessHomeDir([instance.gameDir, instance.root]),
  };
}

/** Builds the document and renders it in `format`; throws what the core throws. */
export function renderReport(core: ReportCoreApi, input: ReportInput, format: ReportFormat): { name: string; contents: string } {
  const doc = core.buildReport(input);
  const contents = format === 'json' ? core.reportJson(doc) : core.reportMarkdown(doc);
  return { name: core.reportFileName(doc), contents };
}

/** What the instance header shows about the last export. */
export type ReportState =
  | { status: 'saving'; format: ReportFormat }
  | { status: 'saved'; format: ReportFormat; path: string }
  | { status: 'error'; format: ReportFormat; error: AppError };
