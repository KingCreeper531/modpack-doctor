/**
 * Crash reports and logs for the browser preview (mockIpc.ts), taken verbatim from the
 * fixture corpus (fixtures/logs, real-format texts) with Vite `?raw` imports. Dev only: this
 * module is reachable only through the mock backend, which `createBackend` drops from
 * production bundles (`import.meta.env.DEV`).
 *
 * The jars these logs name (emberforge, pipeworks, hearthhud, glintful, trinketry…) are part of
 * the mock jar sets (mockData.ts), so the crash analysis maps frames and mixin configs to jars
 * exactly as it would against a real scan.
 */
import type { LogKind, LogSource } from '../../bindings';
import fabCleanLong from '../../../fixtures/logs/fabric/fab21-clean-session-long.log?raw';
import fabMixin from '../../../fixtures/logs/fabric/fab21-mixin-transformation-failed.txt?raw';
import fabRootCause from '../../../fixtures/logs/fabric/fab21-root-cause-chain.txt?raw';
import fgCleanLong from '../../../fixtures/logs/forge/fg20-clean-benign-cnfe-long.log?raw';
import fgLateCrash from '../../../fixtures/logs/forge/fg20-distance-early-noclassdef-late-crash.log?raw';
import fgMixin from '../../../fixtures/logs/forge/fg20-mixin-transformer-error.txt?raw';
import fgOom from '../../../fixtures/logs/forge/fg20-oom-heap.txt?raw';
import fgSuspectedMixin from '../../../fixtures/logs/forge/fg20-suspected-mods-mixin.txt?raw';
import fgSuspected from '../../../fixtures/logs/forge/fg20-suspected-mod.txt?raw';
import hsErrNvidia from '../../../fixtures/logs/jvm/hs_err_pid20516-nvidia-nvoglv64.log?raw';

export interface MockLog {
  id: string;
  kind: LogKind;
  /** How long before "now" the file was last written. */
  ageMs: number;
  text: string;
}

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const ATM9 = '3f9c2a71d0b84e15';
const FABULOUSLY = '8a1e40c6f7d23b90';

/** Files already on disk when the app starts, per instance. */
const LOGS: Record<string, MockLog[]> = {
  [ATM9]: [
    { id: 'logs/latest.log', kind: 'latestLog', ageMs: 25 * MIN, text: fgLateCrash },
    { id: 'logs/debug.log', kind: 'debugLog', ageMs: 26 * MIN, text: fgCleanLong },
    { id: 'crash-reports/crash-2026-11-03_14.22.07-client.txt', kind: 'crashReport', ageMs: 2 * HOUR, text: fgMixin },
    { id: 'crash-reports/crash-2026-11-01_20.03.44-client.txt', kind: 'crashReport', ageMs: 2 * DAY, text: fgSuspectedMixin },
    { id: 'crash-reports/crash-2026-10-29_18.11.02-server.txt', kind: 'crashReport', ageMs: 5 * DAY, text: fgOom },
    { id: 'hs_err_pid20516.log', kind: 'hsErr', ageMs: 6 * DAY, text: hsErrNvidia },
  ],
  [FABULOUSLY]: [
    { id: 'logs/latest.log', kind: 'latestLog', ageMs: 1 * HOUR, text: fabCleanLong },
    { id: 'crash-reports/crash-2026-10-30_19.02.11-client.txt', kind: 'crashReport', ageMs: 4 * DAY, text: fabRootCause },
  ],
};

/** The crash each watched instance has in `?scenario=crash` (a new file, then `CrashDetected`). */
const CRASHES: Record<string, { log: MockLog; delayMs: number; pid: number }> = {
  [ATM9]: {
    log: { id: 'crash-reports/crash-2026-11-03_16.48.30-client.txt', kind: 'crashReport', ageMs: 0, text: fgSuspected },
    delayMs: 3000,
    pid: 14872,
  },
  [FABULOUSLY]: {
    log: { id: 'crash-reports/crash-2026-11-03_16.48.41-client.txt', kind: 'crashReport', ageMs: 0, text: fabMixin },
    delayMs: 4500,
    pid: 9932,
  },
};

export function mockLogs(instanceId: string): MockLog[] {
  return LOGS[instanceId] ?? [];
}

export function mockCrash(instanceId: string): { log: MockLog; delayMs: number; pid: number } | null {
  return CRASHES[instanceId] ?? null;
}

export function mockCrashInstances(): string[] {
  return Object.keys(CRASHES);
}

/** Byte size as Rust reports it (UTF-8). */
export function byteSize(text: string): number {
  return new TextEncoder().encode(text).length;
}

export function toSource(log: MockLog, now: number): LogSource {
  return { id: log.id, kind: log.kind, modifiedMs: now - log.ageMs, size: byteSize(log.text) };
}
