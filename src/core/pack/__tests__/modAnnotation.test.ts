/**
 * Legacy Forge `@Mod` annotation entries: the scanner gives them the annotated class as
 * `metadataFile` (`com/example/MyMod.class`). Legacy FML (Forge on MC < 1.13) reads them like
 * `mcmod.info`; 1.13+ loaders never do.
 */
import { describe, expect, it } from 'vitest';
import type { JarRecord, LoaderKind } from '../../../bindings';
import { codes, jar, only, pack, run, type JarSpec } from '../../checks/__tests__/fixtures';
import { entryRelevant, isModClassFile, metadataFilesRead } from '../index';

const CLASS = 'com/example/MyMod.class';
const MODS = 'META-INF/mods.toml';

/** A jar whose legacy entries come from `@Mod` classes instead of mcmod.info. */
function annotated(spec: JarSpec): JarRecord {
  const j = jar({ maxClassMajor: 52, ...spec }, 'legacyforge');
  j.mods.forEach((m, i) => {
    m.metadataFile = i === 0 ? CLASS : `com/example/Other${i}.class`;
    m.metadataExcerpt = `// net.minecraftforge.fml.common.Mod on com.example.MyMod\n@Mod(\n    modid = "${m.modId}"\n)`;
  });
  return j;
}

describe('metadataFilesRead with @Mod classes', () => {
  it.each<[LoaderKind, string | null, string[], string[] | null]>([
    ['forge', '1.12.2', [CLASS, 'mcmod.info'], [CLASS, 'mcmod.info']],
    ['forge', '1.7.10', [CLASS], [CLASS, 'mcmod.info']],
    ['legacyforge', null, [CLASS, MODS], [CLASS, 'mcmod.info']],
    ['forge', null, [CLASS], [CLASS, MODS, 'mcmod.info']],
    ['forge', '1.20.1', [CLASS, MODS], [MODS]],
    ['neoforge', '1.21.1', [CLASS], ['META-INF/neoforge.mods.toml']],
    ['fabric', '1.12.2', [CLASS], ['fabric.mod.json']],
    ['unknown', '1.12.2', [CLASS], null],
  ])('%s on %s with %j → %j', (loader, mc, present, expected) => {
    const read = metadataFilesRead(loader, mc, present);
    expect(read === null ? null : [...read].sort()).toEqual(expected === null ? null : [...expected].sort());
  });

  it('isModClassFile', () => {
    expect(isModClassFile(CLASS)).toBe(true);
    expect(isModClassFile('mcmod.info')).toBe(false);
    expect(isModClassFile(MODS)).toBe(false);
  });

  it('entryRelevant: read by Forge 1.12.2 / 1.7.10, ignored on 1.13+', () => {
    const j = annotated({ file: 'm.jar', mods: [{ id: 'm' }] });
    const m = j.mods[0];
    if (!m) throw new Error('no mod');
    expect(entryRelevant('forge', '1.12.2', j, m)).toBe(true);
    expect(entryRelevant('forge', '1.7.10', j, m)).toBe(true);
    expect(entryRelevant('forge', null, j, m)).toBe(true);
    expect(entryRelevant('forge', '1.20.1', j, m)).toBe(false);
    expect(entryRelevant('neoforge', '1.21.1', j, m)).toBe(false);
    expect(entryRelevant('fabric', '1.12.2', j, m)).toBe(false);
  });
});

describe('checks on @Mod entries', () => {
  const rl = pack('forge', '1.12.2', '14.23.5.2860');

  it('a required dependency from the annotation is enforced on 1.12.2', () => {
    const m = annotated({ file: 'm.jar', mods: [{ id: 'm', deps: [{ id: 'baubles', range: '[1.5,)' }] }] });
    const found = run([m], rl);
    expect(codes(found)).toEqual(['E-MISSING-DEP']);
    expect(found[0]?.evidence.some((e) => e.kind === 'metadata' && e.file === CLASS)).toBe(true);
    const baubles = jar({ file: 'Baubles.jar', mods: [{ id: 'baubles', version: '1.5.2' }], maxClassMajor: 52 }, 'legacyforge');
    expect(run([m, baubles], rl)).toEqual([]);
  });

  it('acceptedMinecraftVersions is enforced (unlike mcmod.info mcversion)', () => {
    const old = annotated({ file: 'old.jar', mods: [{ id: 'old', mc: '[1.10.2]' }] });
    expect(only(run([old], rl), 'E-MC-RANGE').map((f) => f.severity)).toEqual(['error']);
    const ok = annotated({ file: 'ok.jar', mods: [{ id: 'ok', mc: '[1.12,1.12.2]' }] });
    expect(run([ok], rl)).toEqual([]);
  });

  it('an optional (after:) dependency is range-checked when installed', () => {
    const m = annotated({ file: 'm.jar', mods: [{ id: 'm', deps: [{ id: 'jei', kind: 'optional', range: '[4.15,)' }] }] });
    const jei = jar({ file: 'jei.jar', mods: [{ id: 'jei', version: '4.8.0' }], maxClassMajor: 52 }, 'legacyforge');
    expect(codes(run([m, jei], rl))).toEqual(['E-DEP-RANGE']);
    expect(run([m], rl)).toEqual([]);
  });

  it('a duplicate id across jars (annotation + mcmod.info) is an error on legacy FML', () => {
    const a = annotated({ file: 'a.jar', mods: [{ id: 'x', version: '1.0' }] });
    const b = jar({ file: 'b.jar', mods: [{ id: 'x', version: '2.0' }], maxClassMajor: 52 }, 'legacyforge');
    expect(only(run([a, b], rl), 'E-DUP-ID').map((f) => f.severity)).toEqual(['error']);
  });

  it('on a 1.13+ pack the annotation entry is never read: its dependencies do not count', () => {
    const m = annotated({ file: 'm.jar', mods: [{ id: 'm', deps: [{ id: 'baubles' }], mc: '[1.12.2]' }] });
    const found = run([m], pack('forge', '1.20.1', '47.3.0'));
    expect(only(found, 'E-MISSING-DEP')).toEqual([]);
    expect(only(found, 'E-MC-RANGE')).toEqual([]);
    expect(codes(found)).toEqual(['E-WRONG-LOADER']);
  });
});
