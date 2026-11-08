/**
 * Instance config files that change what the loader enforces (docs/research/loader-enforcement.md,
 * "Instance config files"): NeoForge `config/fml.toml` `dependencyOverrides`
 * (checks/fmlOverrides.ts) and Sinytra Connector `config/connector.json` (checks/connector.ts).
 */
import { describe, expect, it } from 'vitest';
import type { JarRecord, LoaderKind } from '../../../bindings';
import type { Finding, FindingCode, PackContext, Severity } from '../../model';
import { connectorAliases, CONNECTOR_ALIASES } from '../connector';
import { contextFor } from '../context';
import { fmlOverrideSupport } from '../fmlOverrides';
import { connectorJson, fabric, fmlToml, forge, input, neoforge, notes, only, pack, run, runWithConfig } from './fixtures';

const neo = pack('neoforge', '1.21.1', '21.1.172');

function sev(findings: readonly Finding[], code: FindingCode): Severity[] {
  return only(findings, code).map((f) => f.severity);
}

describe('fml.toml dependency overrides: which NeoForge versions have them', () => {
  it.each<[LoaderKind, string | null, string | null, 'yes' | 'assumed' | 'no']>([
    ['neoforge', '1.21.1', '21.1.81', 'yes'],
    ['neoforge', '1.21.1', '21.1.80', 'no'],
    ['neoforge', '1.21.1', '21.1.228', 'yes'],
    ['neoforge', '1.21.3', '21.3.41-beta', 'yes'],
    ['neoforge', '1.21.3', '21.3.40-beta', 'no'],
    ['neoforge', '1.21.3', '21.3.95', 'yes'],
    ['neoforge', '1.21.4', '21.4.0-beta', 'yes'],
    ['neoforge', '1.21.8', '21.8.47', 'yes'],
    ['neoforge', '26.1', '26.1.0.12-beta', 'yes'],
    ['neoforge', '1.21', '21.0.167', 'no'],
    ['neoforge', '1.21.2', '21.2.1-beta', 'no'],
    ['neoforge', '1.20.4', '20.4.237', 'no'],
    ['neoforge', '1.20.1', '47.1.106', 'no'],
    ['neoforge', '1.21.1', null, 'assumed'],
    ['neoforge', '1.21.3', null, 'assumed'],
    ['neoforge', '1.21.5', null, 'yes'],
    ['neoforge', '1.20.6', null, 'no'],
    ['neoforge', null, null, 'assumed'],
    ['forge', '1.20.1', '47.3.0', 'no'],
    ['forge', '1.21.1', '52.0.1', 'no'],
  ])('%s %s %s → %s', (loader, mc, version, expected) => {
    expect(fmlOverrideSupport(pack(loader, mc, version)).kind).toBe(expected);
  });
});

describe('fml.toml dependency overrides: E-MISSING-DEP', () => {
  const create = (): JarRecord => neoforge({ file: 'create-6.0.jar', mods: [{ id: 'create', name: 'Create', deps: [{ id: 'flywheel', range: '[1.0,2.0)' }] }] });

  it('without an override: error', () => {
    expect(sev(run([create()], neo), 'E-MISSING-DEP')).toEqual(['error']);
  });

  it('"-flywheel" for create: info, says so, no install fix', () => {
    const plain = only(run([create()], neo), 'E-MISSING-DEP')[0];
    const f = only(runWithConfig([create()], neo, fmlToml({ create: ['-flywheel'] })), 'E-MISSING-DEP')[0];
    expect(f?.severity).toBe('info');
    expect(f?.id).toBe(plain?.id); // same finding, stable id
    expect(f?.title).toBe('Create requires "flywheel" ≥ 1.0 and < 2.0, which is not installed — overridden in config/fml.toml');
    expect(f?.explanation).toContain('dependencyOverrides.create = "-flywheel"');
    expect(f?.explanation).not.toContain('Assumed');
    expect(f?.missingModIds).toBeUndefined();
    expect(f?.fixes).toEqual([{ kind: 'manual', steps: [expect.stringContaining('remove "-flywheel" from dependencyOverrides.create')] }]);
    expect(notes(f)).toEqual(['Relaxed by config/fml.toml: dependencyOverrides.create = "-flywheel".', expect.stringMatching(/^Pack: NeoForge 21\.1\.172/)]);
  });

  it.each<[string, Record<string, string[]>]>([
    ['"+flywheel" only adds ordering', { create: ['+flywheel'] }],
    ['an entry without +/- is ignored (as FML does)', { create: ['flywheel'] }],
    ['another target', { flywheel: ['-create'], jei: ['-flywheel'] }],
    ['keys are case-sensitive', { Create: ['-flywheel'] }],
    ['dep ids are exact', { create: ['-Flywheel'] }],
  ])('stays an error: %s', (_name, overrides) => {
    expect(sev(runWithConfig([create()], neo, fmlToml(overrides)), 'E-MISSING-DEP')).toEqual(['error']);
  });

  it('NeoForge before 21.1.81: unchanged error with a note that the override has no effect', () => {
    const f = only(runWithConfig([create()], pack('neoforge', '1.21.1', '21.1.80'), fmlToml({ create: ['-flywheel'] })), 'E-MISSING-DEP')[0];
    expect(f?.severity).toBe('error');
    expect(f?.missingModIds).toEqual(['flywheel']);
    expect(notes(f)[0]).toBe(
      'config/fml.toml has dependencyOverrides.create = "-flywheel", but NeoForge 21.1.80 predates dependency overrides (NeoForge 21.1.81 on 1.21.1, 21.3.41-beta on 1.21.3, every 1.21.4+ build), so it has no effect.',
    );
  });

  it('Forge has none: unchanged error with a note', () => {
    const j = forge({ file: 'create-forge.jar', mods: [{ id: 'create', name: 'Create', deps: [{ id: 'flywheel' }] }] });
    const f = only(runWithConfig([j], pack('forge', '1.20.1', '47.3.0'), fmlToml({ create: ['-flywheel'] })), 'E-MISSING-DEP')[0];
    expect(f?.severity).toBe('error');
    expect(notes(f)[0]).toContain('but Forge has no dependency overrides, so it has no effect');
  });

  it('NeoForge version unknown on 1.21.1: applied, and the wording says it was assumed', () => {
    const f = only(runWithConfig([create()], pack('neoforge', '1.21.1', null), fmlToml({ create: ['-flywheel'] })), 'E-MISSING-DEP')[0];
    expect(f?.severity).toBe('info');
    expect(f?.explanation).toContain('Assumed: dependency overrides exist from NeoForge 21.1.81');
    expect(f?.explanation.length).toBeLessThanOrEqual(700);
  });
});

describe('fml.toml dependency overrides: ranges and incompatibilities', () => {
  it('E-DEP-RANGE: an out-of-range dependency removed by the override → info', () => {
    const jars = [
      neoforge({ file: 'addon.jar', mods: [{ id: 'addon', deps: [{ id: 'create', range: '[6.0,7.0)' }] }] }),
      neoforge({ file: 'create.jar', mods: [{ id: 'create', version: '0.5.1' }] }),
    ];
    expect(sev(run(jars, neo), 'E-DEP-RANGE')).toEqual(['error']);
    const f = only(runWithConfig(jars, neo, fmlToml({ addon: ['-create'] })), 'E-DEP-RANGE')[0];
    expect(f?.severity).toBe('info');
    expect(f?.title).toMatch(/— overridden in config\/fml\.toml$/);
  });

  it('E-DEP-RANGE: an optional dependency (enforced when present) too', () => {
    const jars = [
      neoforge({ file: 'addon.jar', mods: [{ id: 'addon', deps: [{ id: 'jei', kind: 'optional', range: '[19,)' }] }] }),
      neoforge({ file: 'jei.jar', mods: [{ id: 'jei', version: '15.2.0' }] }),
    ];
    expect(sev(run(jars, neo), 'E-DEP-RANGE')).toEqual(['error']);
    expect(sev(runWithConfig(jars, neo, fmlToml({ addon: ['-jei'] })), 'E-DEP-RANGE')).toEqual(['info']);
  });

  it('E-MC-RANGE: "-minecraft" removes the Minecraft constraint', () => {
    const j = neoforge({ file: 'old.jar', mods: [{ id: 'old', mc: '[1.20.6]' }] });
    expect(sev(run([j], neo), 'E-MC-RANGE')).toEqual(['error']);
    expect(sev(runWithConfig([j], neo, fmlToml({ old: ['-minecraft'] })), 'E-MC-RANGE')).toEqual(['info']);
    // A compatibility-table info stays info, now saying the override removed it.
    const j121 = neoforge({ file: 'j121.jar', mods: [{ id: 'j121', mc: '[1.21]' }] });
    const f = only(runWithConfig([j121], neo, fmlToml({ j121: ['-minecraft'] })), 'E-MC-RANGE')[0];
    expect([f?.severity, f?.title.endsWith('overridden in config/fml.toml')]).toEqual(['info', true]);
  });

  it('E-LOADER-RANGE: "-neoforge" removes the loader constraint', () => {
    const j = neoforge({ file: 'new.jar', mods: [{ id: 'new', loaderDep: '[21.1.200,)' }] });
    expect(sev(run([j], neo), 'E-LOADER-RANGE')).toEqual(['error']);
    expect(sev(runWithConfig([j], neo, fmlToml({ new: ['-neoforge'] })), 'E-LOADER-RANGE')).toEqual(['info']);
    expect(sev(runWithConfig([j], neo, fmlToml({ new: ['-minecraft'] })), 'E-LOADER-RANGE')).toEqual(['error']);
  });

  it('E-INCOMPAT: "-<target>" removes incompatible and discouraged clauses', () => {
    const jars = [
      neoforge({ file: 'a.jar', mods: [{ id: 'a', deps: [{ id: 'b', kind: 'incompatible' }, { id: 'c', kind: 'conflicts' }] }] }),
      neoforge({ file: 'b.jar', mods: [{ id: 'b' }] }),
      neoforge({ file: 'c.jar', mods: [{ id: 'c' }] }),
    ];
    expect(sev(run(jars, neo), 'E-INCOMPAT')).toEqual(['error', 'warning']);
    expect(sev(runWithConfig(jars, neo, fmlToml({ a: ['-b', '-c'] })), 'E-INCOMPAT')).toEqual(['info', 'info']);
  });

  it("doesn't touch Fabric mods loaded through Connector (Fabric's resolver ignores fml.toml)", () => {
    const jars = [
      neoforge({ file: 'connector.jar', mods: [{ id: 'connector' }] }),
      fabric({ file: 'fab.jar', mods: [{ id: 'fab', deps: [{ id: 'missing-lib' }] }] }),
    ];
    expect(sev(runWithConfig(jars, neo, fmlToml({ fab: ['-missing-lib'] })), 'E-MISSING-DEP')).toEqual(['error']);
  });

  it('no config file: same findings as before', () => {
    const j = neoforge({ file: 'x.jar', mods: [{ id: 'x', deps: [{ id: 'y' }] }] });
    expect(runWithConfig([j], neo, fmlToml({}))).toEqual(run([j], neo));
  });
});

describe('connector.json', () => {
  const connector = (): JarRecord => neoforge({ file: 'connector.jar', mods: [{ id: 'connector' }] });
  const cloth = (): JarRecord => neoforge({ file: 'cloth-config-neoforge.jar', mods: [{ id: 'cloth_config', version: '15.0.140' }] });
  const needsCloth = (): JarRecord => fabric({ file: 'fab.jar', mods: [{ id: 'fab', deps: [{ id: 'cloth-config2', range: '>=99' }] }] });
  const missing = (p: PackContext, ...extra: Parameters<typeof runWithConfig>[2][]): Severity[] => {
    const jars = [connector(), cloth(), needsCloth()];
    return sev(extra.length > 0 ? runWithConfig(jars, p, extra[0]!) : run(jars, p), 'E-MISSING-DEP');
  };

  it('no file: the default aliases apply (cloth_config satisfies cloth-config2, any version)', () => {
    expect(missing(neo)).toEqual([]);
    expect(sev(run([connector(), cloth(), needsCloth()], neo), 'E-DEP-RANGE')).toEqual([]);
  });

  it('the default file (as Connector writes it) behaves the same', () => {
    const cfg = connectorJson({
      hiddenMods: [],
      globalModAliases: [
        { modId: 'cloth_config', aliases: ['cloth-config2'] },
        { modId: 'playeranimator', aliases: ['player-animator'] },
      ],
    });
    expect(missing(neo, cfg)).toEqual([]);
  });

  it('a file without globalModAliases means no aliases at all', () => {
    expect(missing(neo, connectorJson({ hiddenMods: [] }))).toEqual(['error']);
  });

  it('custom aliases from the file are used instead of the defaults', () => {
    const cfg = connectorJson({ globalModAliases: [{ modId: 'mymod_neo', aliases: ['mymod'] }] });
    const jars = [
      connector(),
      neoforge({ file: 'mymod-neo.jar', mods: [{ id: 'mymod_neo' }] }),
      fabric({ file: 'addon.jar', mods: [{ id: 'addon', deps: [{ id: 'mymod', range: '>=5' }] }] }),
    ];
    expect(sev(run(jars, neo), 'E-MISSING-DEP')).toEqual(['error']);
    expect(runWithConfig(jars, neo, cfg)).toEqual([]);
    expect(missing(neo, cfg)).toEqual(['error']); // the default cloth alias is gone
  });

  it('Connector for 1.21.x rejects a file with an invalid field and uses its defaults', () => {
    const cfg = connectorJson({ globalModAliases: [], invalidFields: ['version'] });
    expect(missing(neo, cfg)).toEqual([]);
  });

  it('Connector for 1.20.1 drops only the invalid field (no aliases left)', () => {
    const p = pack('forge', '1.20.1', '47.3.0');
    const jars = [
      forge({ file: 'connector.jar', mods: [{ id: 'connectormod' }] }),
      forge({ file: 'cloth.jar', mods: [{ id: 'cloth_config' }] }),
      needsCloth(),
    ];
    expect(sev(run(jars, p), 'E-MISSING-DEP')).toEqual([]);
    expect(sev(runWithConfig(jars, p, connectorJson({ invalidFields: ['globalModAliases'] })), 'E-MISSING-DEP')).toEqual(['error']);
    expect(connectorAliases({ hiddenMods: null, globalModAliases: null, invalidFields: ['globalModAliases'] }, true)).toEqual([]);
    expect(connectorAliases({ hiddenMods: null, globalModAliases: null, invalidFields: ['globalModAliases'] }, false)).toBe(CONNECTOR_ALIASES);
  });

  it('hiddenMods only hides native mods from Fabric mods at runtime: no static effect', () => {
    const cfg = connectorJson({ hiddenMods: ['cloth_config'], globalModAliases: [{ modId: 'cloth_config', aliases: ['cloth-config2'] }] });
    const jars = [connector(), cloth(), needsCloth()];
    expect(runWithConfig(jars, neo, cfg)).toEqual(run(jars, neo));
    const i = input(jars, neo);
    expect(contextFor({ ...i, scan: { ...i.scan, loaderConfig: cfg } }).connector.hiddenMods).toEqual(['cloth_config']);
    // A Fabric dependency on a hidden native mod is still satisfied (Connector's resolver sees every FML mod).
    const direct = fabric({ file: 'direct.jar', mods: [{ id: 'direct', deps: [{ id: 'cloth_config' }] }] });
    expect(sev(runWithConfig([connector(), cloth(), direct], neo, cfg), 'E-MISSING-DEP')).toEqual([]);
  });
});
