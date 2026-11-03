/** Test helpers: a controllable frame scheduler, fake rules-core, and quick mock stores. */
import type { Instance, PackOverride, ScanResult } from '../../../bindings';
import type { CheckInput, Finding, PackContext } from '../../../core/model';
import { createMockBackend, type MockOptions } from '../mockIpc';
import { createAppStore, type AppStore, type CoreApi } from '../store';

export function manualFrames() {
  const queue: Array<() => void> = [];
  return {
    frame: (cb: () => void) => {
      queue.push(cb);
    },
    get pending() {
      return queue.length;
    },
    run() {
      for (const cb of queue.splice(0)) cb();
    },
  };
}

export function finding(id: string, severity: Finding['severity'], jarIds: string[], extra: Partial<Finding> = {}): Finding {
  return {
    id,
    code: severity === 'error' ? 'E-DUP-ID' : severity === 'warning' ? 'W-CORRUPT-JAR' : 'I-SPLIT-PKG',
    severity,
    title: `${id} title`,
    explanation: `${id} explanation`,
    culprits: jarIds.map((jarId) => ({ jarId, fileName: jarId.slice(jarId.lastIndexOf('/') + 1) })),
    evidence: [],
    fixes: [{ kind: 'disable', jarId: jarIds[0] ?? 'mods/x.jar' }],
    ...extra,
  };
}

/** A fake core: pack from the override (else the instance); findings from `make`. */
export function fakeCore(make: (input: CheckInput) => Finding[] = () => []) {
  const calls: CheckInput[] = [];
  const core: CoreApi = {
    resolvePack: (instance: Instance, _scan: ScanResult, override?: PackOverride | null): PackContext => ({
      mcVersion: override?.mcVersion ?? instance.mcVersion,
      loader: override?.loader ?? instance.loader,
      side: override?.side ?? instance.side,
      source: override ? 'override' : 'launcher',
    }),
    runChecks: (input) => {
      calls.push(input);
      return make(input);
    },
  };
  return { core, calls };
}

export function mockStore(opts: Partial<MockOptions> = {}, make?: (input: CheckInput) => Finding[], initialSelect?: string) {
  const backend = createMockBackend({ scanMs: 0, latencyMs: 0, ...opts });
  const frames = manualFrames();
  const { core, calls } = fakeCore(make);
  let t = 1_000_000;
  const store: AppStore = createAppStore({ backend, core, frame: frames.frame, now: () => (t += 100), initialSelect: initialSelect ?? null });
  return { store, backend, frames, calls };
}

/** Resolve once `pred` holds (polls the microtask/timer queue). */
export async function until(pred: () => boolean, ms = 2000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error('until: timed out');
    await new Promise((r) => setTimeout(r, 1));
  }
}
