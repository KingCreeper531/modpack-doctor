import { describe, expect, it } from 'vitest';
import type { JarRecord } from '../../../bindings';
import type { Finding } from '../../model';
import { FINDING_CODES } from '../../model';
import { buildJarIndex, resolvePack } from '../../pack';
import { CHECKS, compareFindings, runChecks } from '../index';
import { codes, fabric, forge, input, instance, modrinth, nested, pack, run, scan } from './fixtures';

/** A messy Fabric pack that triggers most checks at once. */
function messyPack(): JarRecord[] {
  const sodium = fabric({ file: 'sodium-0.5.8.jar', mods: [{ id: 'sodium', name: 'Sodium', version: '0.5.8', mc: '~1.20.1', env: 'client' }], maxClassMajor: 65 }); // skipped on a server → no W-JAVA-CLASS
  const sodiumOld = fabric({ file: 'sodium-0.4.10.jar', mods: [{ id: 'sodium', name: 'Sodium', version: '0.4.10', mc: '~1.20.1' }] });
  const extra = fabric({ file: 'sodium-extra.jar', mods: [{ id: 'sodium-extra', mc: '~1.20.1', deps: [{ id: 'reeses-sodium-options' }] }], maxClassMajor: 65 });
  const jei = forge({ file: 'jei-forge.jar', mods: [{ id: 'jei', mc: '[1.20.1]' }] });
  const old = fabric({ file: 'old-1.19.jar', mods: [{ id: 'old', mc: '1.19.x' }] });
  const a = fabric({ file: 'aaa.jar', mods: [{ id: 'aaa' }], packages: ['com.shared'] });
  const b = fabric({ file: 'bbb.jar', mods: [{ id: 'bbb', deps: [{ id: 'aaa', kind: 'conflicts' }] }], packages: ['com.shared'] });
  const broken = fabric({ file: 'zz-broken.jar', status: { state: 'corrupt', reason: 'bad zip' } });
  return [sodium, sodiumOld, extra, jei, old, a, b, broken];
}

describe('CHECKS registry', () => {
  it('has unique ids and covers every static finding code', () => {
    const ids = CHECKS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    const covered = new Set(CHECKS.flatMap((c) => c.codes));
    const staticCodes = FINDING_CODES.filter((c) => !c.startsWith('C-'));
    expect([...covered].sort()).toEqual([...staticCodes].sort());
  });

  it('every check returns nothing for an empty pack', () => {
    for (const c of CHECKS) expect(c.run(input([], pack('fabric', '1.20.1')))).toEqual([]);
  });
});

describe('runChecks', () => {
  const p = pack('fabric', '1.20.1', '0.16.5', 'server');
  const findings = run(messyPack(), p, modrinth());

  it('finds the expected problems', () => {
    expect(new Set(codes(findings))).toEqual(
      new Set(['E-WRONG-LOADER', 'E-MC-RANGE', 'E-MISSING-DEP', 'E-DUP-ID', 'E-INCOMPAT', 'I-SPLIT-PKG', 'W-CLIENT-ON-SERVER', 'W-CORRUPT-JAR', 'W-JAVA-CLASS', 'I-NOT-ON-MODRINTH']),
    );
  });

  it('is sorted by severity, then code, then first culprit file name', () => {
    const rank = { error: 0, warning: 1, info: 2 } as const;
    for (let i = 1; i < findings.length; i++) {
      const a = findings[i - 1] as Finding;
      const b = findings[i] as Finding;
      expect(compareFindings(a, b)).toBeLessThan(0);
      expect(rank[a.severity]).toBeLessThanOrEqual(rank[b.severity]);
    }
    expect(findings[0]?.severity).toBe('error');
    expect(findings.at(-1)?.severity).toBe('info');
    // Warning-severity E-INCOMPAT (conflicts) sorts among the warnings.
    const incompat = findings.findIndex((f) => f.code === 'E-INCOMPAT');
    const client = findings.findIndex((f) => f.code === 'W-CLIENT-ON-SERVER');
    expect(findings[incompat]?.severity).toBe('warning');
    expect(incompat).toBeLessThan(client);
  });

  it('every finding is well-formed: one-line title, explanation, culprits, pack note, unique id', () => {
    const ids = new Set<string>();
    for (const f of findings) {
      expect(f.title).not.toMatch(/\n/);
      expect(f.title.length).toBeGreaterThan(0);
      expect(f.explanation.length).toBeGreaterThan(20);
      expect(f.explanation.length).toBeLessThanOrEqual(700);
      expect(f.culprits.length).toBeGreaterThan(0);
      expect(f.evidence.some((e) => e.kind === 'note' && e.text.startsWith('Pack: '))).toBe(true);
      expect(f.id.startsWith(`${f.code}:`)).toBe(true);
      expect(ids.has(f.id)).toBe(false);
      ids.add(f.id);
      for (const e of f.evidence) {
        if (e.kind !== 'metadata') continue;
        const lines = e.excerpt.split('\n').length;
        for (const n of e.highlight) expect(n >= 1 && n <= lines).toBe(true);
      }
    }
  });

  it('is deterministic: same input twice, or jars in another order → identical findings', () => {
    expect(run(messyPack(), p, modrinth())).toEqual(findings);
    expect(run(messyPack().reverse(), p, modrinth())).toEqual(findings);
  });

  it('ids survive a disable/re-enable rename (the jar id strips .disabled)', () => {
    const before = run(messyPack(), p, modrinth());
    const jars = messyPack();
    // Disable then re-enable: file name toggles, id stays `mods/old-1.19.jar`.
    const old = jars.find((j) => j.id === 'mods/old-1.19.jar');
    if (!old) throw new Error('fixture');
    old.disabled = true;
    old.fileName = 'old-1.19.jar.disabled';
    const whileDisabled = run(jars, p, modrinth());
    expect(whileDisabled.some((f) => f.culprits.some((c) => c.jarId === old.id))).toBe(false);
    old.disabled = false;
    old.fileName = 'old-1.19.jar';
    old.mtimeMs += 5_000;
    expect(run(jars, p, modrinth()).map((f) => f.id)).toEqual(before.map((f) => f.id));
  });

  it('ids do not depend on evidence (excerpt changes keep the id)', () => {
    const a = fabric({ file: 'a.jar', mods: [{ id: 'a', mc: '~1.19' }] });
    const id1 = run([a], p)[0]?.id;
    const m = a.mods[0];
    if (m) m.metadataExcerpt = `// reformatted\n${m.metadataExcerpt}`;
    expect(run([a], p)[0]?.id).toBe(id1);
  });

  it('drops findings with a duplicate id', () => {
    // Two NeoForge+Forge entries for the same mod in one jar on 1.20.1 both fail the MC range;
    // they share code + culprit + mod id → one finding.
    const both = forge({ file: 'both.jar', mods: [{ id: 'x', loader: 'forge', mc: '[1.19.2]' }, { id: 'x', loader: 'neoforge', mc: '[1.19.2]', modsToml: true }] });
    const f = run([both], pack('forge', '1.20.1'));
    expect(f.filter((x) => x.code === 'E-MC-RANGE')).toHaveLength(1);
  });
});

describe('end-to-end with resolvePack + buildJarIndex', () => {
  it('an inferred Quilt pack running Fabric mods has no loader findings', () => {
    const jars = [
      fabric({ file: 'a.jar', mods: [{ id: 'a', mc: '~1.20.1', deps: [{ id: 'qsl' }] }] }),
      fabric({ file: 'b.jar', mods: [{ id: 'b', mc: '~1.20.1' }] }),
      fabric({ file: 'qsl.jar', mods: [{ id: 'qsl', loader: 'quilt', mc: '~1.20.1' }] }),
    ];
    const s = scan(...jars);
    const inst = instance({ metadataSource: 'inferred', mcVersion: null, loader: null });
    const packCtx = resolvePack(inst, s);
    expect(packCtx).toMatchObject({ mcVersion: '1.20.1', loader: { kind: 'quilt', version: null }, source: 'majority' });
    expect(buildJarIndex(s).byId.size).toBe(3);
    expect(runChecks({ instance: inst, scan: s, pack: packCtx })).toEqual([]);
  });

  it('a nested Fabric API module requiring a newer loader is caught (E-LOADER-RANGE)', () => {
    const host = fabric({ file: 'host.jar', mods: [{ id: 'host', mc: '~1.20.1' }] });
    const mod = nested(host, { file: 'fabric-api-base.jar', mods: [{ id: 'fabric-api-base', loaderDep: '>=0.15.0' }] }, 'fabric');
    const f = run([host, mod], pack('fabric', '1.20.1', '0.14.21'));
    expect(codes(f)).toEqual(['E-LOADER-RANGE']);
    expect(f[0]?.culprits[0]).toEqual({ jarId: 'mods/host.jar', fileName: 'host.jar', modId: 'fabric-api-base' });
  });
});

describe('runChecks on a .mrpack', () => {
  it('strips every fix: a pack is read-only (CONTRACTS invariant 15)', () => {
    const p = pack('fabric', '1.20.1', '0.16.5', 'server');
    const base = input(messyPack(), p, modrinth());
    const normal = runChecks(base);
    expect(normal.some((f) => f.fixes.length > 0)).toBe(true);
    const packed = runChecks({ ...base, instance: { ...base.instance, launcher: 'mrpack' } });
    expect(packed.length).toBe(normal.length);
    expect(packed.every((f) => f.fixes.length === 0)).toBe(true);
  });
});
