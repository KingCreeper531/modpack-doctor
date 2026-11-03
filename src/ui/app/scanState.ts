/** Per-instance scan state held by the store (store.ts). */
import type { AppError, JarStub, ScanResult } from '../../bindings';
import type { Finding, PackContext } from '../../core/model';

export type ScanPhase = 'idle' | 'scanning' | 'done' | 'error';

export interface InstanceScan {
  status: ScanPhase;
  /** Every top-level jar from `ScanStarted`, in display (file-name) order. */
  stubs: JarStub[];
  /** jar id → parsed, from `ScanProgress` (applied in batches, one per animation frame). */
  progress: Readonly<Record<string, boolean>>;
  done: number;
  total: number;
  result: ScanResult | null;
  pack: PackContext | null;
  /** The pack identity without any override (the override editor shows it as placeholders). */
  detected: PackContext | null;
  findings: Finding[];
  /** UI clock (ms since epoch) when the scan was requested / when checks finished. */
  startedAt: number | null;
  finishedAt: number | null;
  /** `scan_instance` failed. */
  error: AppError | null;
  /** The checks threw (a bug in src/core); the scan itself succeeded. */
  checksError: AppError | null;
}

export function emptyScan(): InstanceScan {
  return {
    status: 'idle',
    stubs: [],
    progress: {},
    done: 0,
    total: 0,
    result: null,
    pack: null,
    detected: null,
    findings: [],
    startedAt: null,
    finishedAt: null,
    error: null,
    checksError: null,
  };
}
