/**
 * Report export (M7, CONTRACTS invariant 16). FROZEN API — implementation owned by the M7 core
 * agent. Pure: builds the report from what the UI already holds; `save_report` (Rust) writes it.
 */
import type { Instance, ScanResult } from '../../bindings';
import type { Finding, ModrinthContext, PackContext } from '../model';

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

/** Build the report data; deterministic for the same input. */
export declare function buildReport(input: ReportInput): ReportDoc;

/** Markdown (GitHub-flavoured) with a summary table, findings by severity, crash sections. */
export declare function reportMarkdown(doc: ReportDoc): string;

/** Pretty-printed JSON of `doc`. */
export declare function reportJson(doc: ReportDoc): string;

/** Default file name without extension: `modpack-doctor-<instance slug>-<YYYY-MM-DD>`. */
export declare function reportFileName(doc: ReportDoc): string;
