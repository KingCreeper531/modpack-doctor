/**
 * Acceptance test: the independent crash/log corpus (fixtures/logs, written by a different agent
 * than src/core/crash) run through the analyzer. Schema: fixtures/logs/README.md.
 */
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import type { JarRecord, LogKind, LogSource } from '../../bindings';
import { analyzeCrash, digestFromText } from '../crash';
import type { Finding, JarIndex } from '../model';

const ROOT = join(__dirname, '..', '..', '..', 'fixtures', 'logs');

interface CorpusJar {
  fileName: string;
  modIds: string[];
  packages: string[];
  mixinConfigs: string[];
}
interface Expectation {
  code: Finding['code'];
  culpritFileNames?: string[];
  culpritModIds?: string[];
  lineContains?: string;
}
interface Expected {
  kind: LogKind;
  loader: string;
  mcVersion: string | null;
  jars: CorpusJar[];
  expect: Expectation[];
  forbid: Array<Finding['code']>;
  notes: string;
}

function jarRecord(j: CorpusJar): JarRecord {
  return {
    id: `mods/${j.fileName}`,
    path: `mods/${j.fileName}`,
    fileName: j.fileName,
    size: 0,
    mtimeMs: 0,
    sha1: '',
    sha512: '',
    disabled: false,
    depth: 0,
    parentId: null,
    status: { state: 'ok' },
    metadataErrors: [],
    loaders: [],
    mods: j.modIds.map((modId) => ({
      modId,
      version: '1',
      name: null,
      loader: 'unknown',
      provides: [],
      environment: 'unknown',
      mcRange: null,
      loaderRange: null,
      languageLoader: null,
      languageRange: null,
      deps: [],
      metadataFile: '',
      metadataExcerpt: '',
    })),
    packages: [...j.packages].sort(),
    mixinConfigs: j.mixinConfigs,
    maxClassMajor: null,
    moduleName: null,
    fmlModType: null,
    jarjar: null,
    nested: [],
  };
}

function push<K, V>(m: Map<K, V[]>, k: K, v: V) {
  const list = m.get(k);
  if (list) list.push(v);
  else m.set(k, [v]);
}

function buildIndex(jars: CorpusJar[]): JarIndex {
  const records = jars.map(jarRecord);
  const byModId = new Map<string, JarRecord[]>();
  const byPackage = new Map<string, JarRecord[]>();
  const byMixinConfig = new Map<string, JarRecord[]>();
  for (const r of records) {
    for (const m of r.mods) push(byModId, m.modId, r);
    for (const p of r.packages) push(byPackage, p, r);
    for (const c of r.mixinConfigs) push(byMixinConfig, c, r);
  }
  return {
    byId: new Map(records.map((r) => [r.id, r])),
    byModId,
    byPackage,
    byPackageAnyDepth: byPackage,
    byMixinConfig,
    byFileName: new Map(records.map((r) => [r.fileName, r])),
  };
}

function culpritModIds(f: Finding, index: JarIndex): string[] {
  return f.culprits.flatMap((c) => [
    ...(c.modId ? [c.modId] : []),
    ...(index.byId.get(c.jarId)?.mods.map((m) => m.modId) ?? []),
  ]);
}

function culpritLines(f: Finding): string[] {
  return f.evidence.flatMap((e) => (e.kind === 'log' ? e.lines.filter((l) => l.role === 'culprit').map((l) => l.text) : []));
}

const cases = JSON.parse(readFileSync(join(ROOT, 'index.json'), 'utf8')) as Array<{ file: string; expected: string }>;

describe('crash corpus (fixtures/logs)', () => {
  it('has cases', () => expect(cases.length).toBeGreaterThan(0));

  for (const c of cases) {
    it(c.file, () => {
      const exp = JSON.parse(readFileSync(join(ROOT, c.expected), 'utf8')) as Expected;
      const text = readFileSync(join(ROOT, c.file), 'utf8');
      const source: LogSource = { id: c.file, kind: exp.kind, modifiedMs: 0, size: statSync(join(ROOT, c.file)).size };
      const index = buildIndex(exp.jars);
      const findings = analyzeCrash({ digest: digestFromText(text, source), index });
      const summary = findings.map((f) => `${f.code}[${f.culprits.map((x) => x.fileName).join(',')}]`).join(' ');

      // Ranking: the analyzer's first finding (what the UI and the crash notification lead with)
      // must be one of the expected diagnoses, not a side effect elsewhere in the log.
      if (exp.expect.length > 0) {
        const wanted = new Set(exp.expect.map((e) => e.code));
        expect(wanted.has(findings[0]?.code ?? ('none' as Finding['code'])), `top finding should be one of ${[...wanted].join(', ')}; got: ${summary}`).toBe(true);
      }

      for (const e of exp.expect) {
        expect(
          findings.some((f) => f.code === e.code && f.severity === 'error'),
          `${e.code} should be reported at error severity; got: ${findings.map((f) => `${f.code}:${f.severity}`).join(' ')}`,
        ).toBe(true);
        // The analyzer may split one failure into a finding per culprit (one triage row and fix
        // each). An expectation is met by the union of all findings carrying its code: every
        // expected jar must be blamed and the expected line marked as culprit evidence.
        const candidates = findings.filter((f) => f.code === e.code);
        expect(candidates.length, `expected ${e.code}; got: ${summary || 'nothing'}`).toBeGreaterThan(0);
        const files = candidates.flatMap((f) => f.culprits.map((x) => x.fileName));
        const mods = candidates.flatMap((f) => culpritModIds(f, index));
        const lines = candidates.flatMap(culpritLines);
        for (const n of e.culpritFileNames ?? []) expect(files, `${e.code} should blame ${n}; got: ${summary}`).toContain(n);
        for (const m of e.culpritModIds ?? []) expect(mods, `${e.code} should blame mod ${m}; got: ${summary}`).toContain(m);
        if (e.lineContains !== undefined) {
          const want = e.lineContains;
          expect(
            lines.some((l) => l.includes(want)),
            `${e.code} should mark culprit line containing ${JSON.stringify(want)}; culprit lines: ${JSON.stringify(lines.slice(0, 6))}`,
          ).toBe(true);
        }
      }
      for (const code of exp.forbid) {
        expect(
          findings.some((f) => f.code === code),
          `forbidden ${code} present; got: ${summary}`,
        ).toBe(false);
      }
    });
  }
});
