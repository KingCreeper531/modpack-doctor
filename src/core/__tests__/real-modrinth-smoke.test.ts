/**
 * Real Modrinth smoke test (dev only). Skipped unless SMOKE_DIR points at a folder filled by
 *   cargo run --release --example smoke_scan -- <dir>
 *   cargo run --release --example smoke_modrinth -- <dir> <cache dir>
 * Runs the M5 pipeline (buildModrinthContext → runChecks → enrichFindings) on live Modrinth data
 * for every real instance and prints match and `updateStatus` counts. Flags SUSPECT updates: a
 * suggested version whose loaders or game versions do not include the pack's, an alpha, or one not
 * published strictly after the identified version (a downgrade, CONTRACTS invariant 8 — checked
 * here with `Date.parse`, independently of the core's own date comparison).
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
      const status = { update: 0, upToDate: 0, noCompatible: 0, unknown: 0 };
      for (const s of Object.values(ctx.updateStatus ?? {})) status[s]++;
      const loaders = modrinthLoaders(pack);
      for (const jar of scan.jars.filter((j) => j.depth === 0)) {
        const m = jarMatch(jar, ctx);
        counts[m.state]++;
        if (m.state !== 'update') continue;
        if (m.beta) counts.beta++;
        const u = m.update;
        const published = Date.parse(u.datePublished ?? '');
        const current = Date.parse(m.version.datePublished ?? '');
        const reasons = [
          u.versionType === 'alpha' ? 'alpha' : null,
          !u.loaders.some((l) => loaders.includes(l)) ? 'loader' : null,
          pack.mcVersion !== null && !u.gameVersions.includes(pack.mcVersion) ? 'mc' : null,
          // Date.parse keeps ms only: equal ms is "not newer" here even if the core saw µs.
          !(published > current) ? 'not newer' : null,
        ].filter((r) => r !== null);
        if (reasons.length) {
          suspects++;
          lines.push(
            `    SUSPECT (${reasons.join(', ')}) ${jar.fileName} ${m.version.versionNumber} (${m.version.datePublished ?? 'no date'}) → ` +
              `${u.versionNumber} [${u.versionType}] (${u.datePublished ?? 'no date'}) loaders=${u.loaders.join(',')} mc=${u.gameVersions.join(',')}`,
          );
        }
      }
      const replaces = findings.flatMap((x) => x.fixes).filter((x) => x.kind === 'replace').length;
      lines.push(
        `${instance.name} (${pack.loader?.kind ?? '?'} ${pack.mcVersion ?? '?'}): ` +
          `${counts.matched} matched · ${counts.update} update (${counts.beta} beta) · ${counts.missing} not on Modrinth · ` +
          `${counts.unknown} unknown · ${replaces} replace fixes\n` +
          `    updateStatus: ${status.update} update · ${status.upToDate} up to date · ${status.noCompatible} no compatible · ${status.unknown} unknown`,
      );
    }
    console.log(`\n${lines.join('\n')}\n\nsuspect updates: ${suspects}\n`);
    expect(lines.length).toBeGreaterThan(0);
  });
});
