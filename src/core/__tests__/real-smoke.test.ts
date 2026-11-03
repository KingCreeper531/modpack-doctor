/**
 * Real-instance smoke test (dev only). Skipped unless SMOKE_DIR points at the output of
 *   cargo run --release --example smoke_scan -- <dir>
 * Runs resolvePack + runChecks on every scanned instance and prints a per-instance summary,
 * so check changes can be validated against real packs that are known to load.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import type { Instance, ScanResult } from '../../bindings';
import { runChecks } from '../checks';
import { resolvePack } from '../pack';

const dir = process.env.SMOKE_DIR;

describe.skipIf(!dir)('real instances (SMOKE_DIR)', () => {
  it('runs every check without throwing and summarises findings', () => {
    const files = readdirSync(dir ?? '').filter((f) => f.endsWith('.json'));
    expect(files.length).toBeGreaterThan(0);
    const lines: string[] = [];
    for (const f of files) {
      const { instance, scan } = JSON.parse(readFileSync(join(dir ?? '', f), 'utf8')) as { instance: Instance; scan: ScanResult };
      const pack = resolvePack(instance, scan, null);
      const findings = runChecks({ instance, scan, pack });
      const by = (s: string) => findings.filter((x) => x.severity === s).length;
      const errors = findings.filter((x) => x.severity === 'error').map((x) => `${x.code}: ${x.title}`);
      const loader = pack.loader ? `${pack.loader.kind} ${pack.loader.version ?? '?'}` : 'vanilla/unknown';
      lines.push(
        `${instance.name} [${instance.launcher}] ${pack.mcVersion ?? '?'} ${loader} (${pack.source}) — ` +
          `${by('error')} E · ${by('warning')} W · ${by('info')} I`,
        ...errors.map((e) => `    ${e}`),
      );
    }
    console.log(`\n${lines.join('\n')}\n`);
  });
});
