/**
 * Real crash-log smoke test (dev only). Skipped unless CRASH_SMOKE_DIR points at the output of
 *   cargo run --release --example smoke_crash -- <dir>
 * Runs analyzeCrash on every real crash report / latest.log / hs_err digest and prints the
 * findings. A log that reached the title screen ("reachedGame") must not produce an
 * error-severity crash finding: those are false positives, listed under FALSE POSITIVE.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import type { Instance, LogDigest, ScanResult } from '../../bindings';
import { analyzeCrash } from '../crash';
import { buildJarIndex, resolvePack } from '../pack';

const dir = process.env.CRASH_SMOKE_DIR;

describe.skipIf(!dir)('real crash logs (CRASH_SMOKE_DIR)', () => {
  it('analyses every log and reports false positives on logs that reached the game', () => {
    const lines: string[] = [];
    let falsePositives = 0;
    for (const f of readdirSync(dir ?? '').filter((x) => x.endsWith('.json'))) {
      const data = JSON.parse(readFileSync(join(dir ?? '', f), 'utf8')) as {
        instance: Instance;
        scan: ScanResult | null;
        logs: Array<{ digest: LogDigest; reachedGame: boolean }>;
      };
      const pack = data.scan ? resolvePack(data.instance, data.scan, null) : undefined;
      const index = data.scan ? buildJarIndex(data.scan) : undefined;
      for (const { digest, reachedGame } of data.logs) {
        const findings = analyzeCrash({ digest, ...(index ? { index } : {}), ...(pack ? { pack } : {}) });
        const errors = findings.filter((x) => x.severity === 'error');
        const tag = reachedGame && errors.length ? '  FALSE POSITIVE' : '';
        if (tag) falsePositives++;
        lines.push(
          `${data.instance.name} :: ${digest.source.id} (${digest.totalLines} lines${reachedGame ? ', reached game' : ''}) — ` +
            `${errors.length} E · ${findings.length - errors.length} other${tag}`,
          ...findings.slice(0, 4).map((x) => `    ${x.severity[0]?.toUpperCase()} ${x.code}: ${x.title} [${x.culprits.map((c) => c.fileName).join(', ')}]`),
        );
      }
    }
    console.log(`\n${lines.join('\n')}\n\nfalse positives: ${falsePositives}\n`);
    expect(lines.length).toBeGreaterThan(0);
  });
});
