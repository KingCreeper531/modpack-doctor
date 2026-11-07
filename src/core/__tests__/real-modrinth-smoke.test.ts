/**
 * Real Modrinth smoke test (dev only). Skipped unless SMOKE_DIR points at a folder filled by
 *   cargo run --release --example smoke_scan -- <dir>
 *   cargo run --release --example smoke_modrinth -- <dir> <cache dir>
 * Runs the M5 pipeline (buildModrinthContext → runChecks → enrichFindings) on live Modrinth data
 * for every real instance and prints match counts. Flags SUSPECT updates: a suggested version
 * whose loaders or game versions do not include the pack's, or an alpha.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import type { HashLookup, Instance, ProjectLookup, ScanResult } from '../../bindings';
import { runChecks } from '../checks';
import { buildModrinthContext, enrichFindings, jarMatch, modrinthLoaders } from '../modrinth';
import { resolvePack } from '../pack';

const dir = process.env.SMOKE_DIR;

describe.skipIf(!dir)('real Modrinth lookups (SMOKE_DIR)', () => {
  it('builds the context, enriches findings and suggests only compatible updates', () => {
    const lines: string[] = [];
    let suspects = 0;
    for (const f of readdirSync(dir ?? '').filter((x) => x.endsWith('.modrinth.json'))) {
      const base = join(dir ?? '', f.replace(/\.modrinth\.json$/, '.json'));
      if (!existsSync(base)) continue;
      const { instance, scan } = JSON.parse(readFileSync(base, 'utf8')) as { instance: Instance; scan: ScanResult };
      const mr = JSON.parse(readFileSync(join(dir ?? '', f), 'utf8')) as {
        identify: HashLookup;
        updates: HashLookup | null;
        betaFallback: HashLookup | null;
        projects: ProjectLookup;
      };
      const pack = resolvePack(instance, scan, null);
      const ctx = buildModrinthContext({ identify: mr.identify, updates: mr.updates, betaFallback: mr.betaFallback, projects: mr.projects });
      const findings = enrichFindings(runChecks({ instance, scan, pack, modrinth: ctx }), ctx, {}, scan.jars);
      const counts = { matched: 0, update: 0, beta: 0, missing: 0, unknown: 0 };
      const loaders = modrinthLoaders(pack);
      for (const jar of scan.jars.filter((j) => j.depth === 0)) {
        const m = jarMatch(jar, ctx);
        counts[m.state]++;
        if (m.state !== 'update') continue;
        if (m.beta) counts.beta++;
        const u = m.update;
        const bad =
          u.versionType === 'alpha' ||
          !u.loaders.some((l) => loaders.includes(l)) ||
          (pack.mcVersion !== null && !u.gameVersions.includes(pack.mcVersion));
        if (bad) {
          suspects++;
          lines.push(`    SUSPECT ${jar.fileName} → ${u.versionNumber} [${u.versionType}] loaders=${u.loaders.join(',')} mc=${u.gameVersions.join(',')}`);
        }
      }
      const replaces = findings.flatMap((x) => x.fixes).filter((x) => x.kind === 'replace').length;
      lines.push(
        `${instance.name} (${pack.loader?.kind ?? '?'} ${pack.mcVersion ?? '?'}): ` +
          `${counts.matched} matched · ${counts.update} update (${counts.beta} beta) · ${counts.missing} not on Modrinth · ` +
          `${counts.unknown} unknown · ${replaces} replace fixes`,
      );
    }
    console.log(`\n${lines.join('\n')}\n\nsuspect updates: ${suspects}\n`);
    expect(lines.length).toBeGreaterThan(0);
  });
});
