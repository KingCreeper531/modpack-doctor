import { describe, expect, it } from 'vitest';
import type { RawRange } from '../../../bindings';
import { forge, fabric, only, pack, run } from '../../checks/__tests__/fixtures';
import { describeRange } from '../../checks/evidence';
import { satisfies } from '../index';
import { describePlaceholderRange, hasPlaceholder, rangePlaceholders } from '../placeholders';
import { rangeInWords } from '../words';

const maven = (...raw: string[]): RawRange => ({ syntax: 'maven', raw, unrepresentable: null });
const fab = (...raw: string[]): RawRange => ({ syntax: 'fabric', raw, unrepresentable: null });

const CREATE_NOTE = "the mod's metadata has an unfilled placeholder: `${create_version}`";

describe('unfilled placeholders: evaluation matches FML (Maven 3.8.5 ComparableVersion)', () => {
  // `${create_version}` parses as one string item; strings sort below numbers, and `$` sorts
  // below every letter, so a placeholder lower bound is below every real version.
  it.each<[string, string, boolean | null]>([
    ['[${create_version},)', '0.5.1.f', true],
    ['[${create_version},)', '6.0.6', true],
    ['[${create_version},)', 'v1.0', true],
    ['[${big_forge_version},)', '47.3.0', true],
    ['[${minecraft_version},)', '1.20.1', true],
    ['(,${x})', '0.0.1', false],
    ['[${x}]', '1.0', false],
    ['[1.0,${x})', '1.5', null], // "Range defies version ordering": FML throws, the mod fails to load
    ['${create_version}', '0.5.1.f', true], // a bare version is a soft requirement
  ])('%s with %s → %s', (range, version, expected) => {
    expect(satisfies(version, maven(range), 'other')).toBe(expected);
  });

  it('Fabric: a placeholder is a non-semantic version, so only the literal string would match', () => {
    expect(satisfies('6.0.6', fab('>=${create_version}'), 'other')).toBe(false);
    expect(satisfies('6.0.6', fab('${create_version}'), 'other')).toBe(false);
    expect(satisfies('6.0.6', fab('>${create_version}'), 'other')).toBe(null);
  });
});

describe('describePlaceholderRange', () => {
  it.each<[RawRange, string | null]>([
    [maven('[${create_version},)'), `any version (${CREATE_NOTE})`],
    [maven('${create_version}'), `any version (${CREATE_NOTE})`],
    [maven('[${a},${b})'), "no real version (the mod's metadata has unfilled placeholders: `${a}`, `${b}`)"],
    [maven('(,${x})'), "no real version (the mod's metadata has an unfilled placeholder: `${x}`)"],
    [maven('[1.0,${x})'), "a range the loader can't read (the mod's metadata has an unfilled placeholder: `${x}`)"],
    [maven('[6.0-${build},)'), "≥ 6.0-${build} (the mod's metadata has an unfilled placeholder: `${build}`)"],
    [fab('>=${create_version}'), `no real version (${CREATE_NOTE})`],
    [fab('>=${x}', '>=2.0'), "≥ 2.0 (the mod's metadata has an unfilled placeholder: `${x}`)"],
    [maven('[6.0,)'), null],
    [fab('>=0.15'), null],
  ])('%j → %s', (range, expected) => {
    expect(describePlaceholderRange(range)).toBe(expected);
  });

  it('tokens', () => {
    expect(rangePlaceholders(maven('[${a},${b})', '[${a},)'))).toEqual(['${a}', '${b}']);
    expect(hasPlaceholder(maven('[1,2)'))).toBe(false);
  });

  it('describeRange (every check) and rangeInWords use it', () => {
    expect(describeRange(maven('[${create_version},)'))).toBe(`any version (${CREATE_NOTE})`);
    expect(describeRange(maven('[${minecraft_version},)'), 'minecraft')).toBe("any version (the mod's metadata has an unfilled placeholder: `${minecraft_version}`)");
    expect(rangeInWords(maven('[${create_version},)'))).toBe(`any version (${CREATE_NOTE})`);
  });
});

describe('rangeInWords', () => {
  it.each<[RawRange, string]>([
    [maven('[6.0,)'), '6.0 or newer'],
    [maven('(6.0,)'), 'newer than 6.0'],
    [maven('(,7.0]'), '7.0 or older'],
    [maven('[0.5.1,0.5.2)'), '0.5.1 or newer, but older than 0.5.2'],
    [maven('[1.2]'), 'exactly 1.2'],
    [maven('[1,2),[3,)'), '1 or newer, but older than 2; or 3 or newer'],
    [fab('>=0.15 <0.16'), '0.15 or newer, but older than 0.16'],
    [fab('~1.20.1'), '1.20.1 or newer, but older than 1.21'],
  ])('%j → %s', (range, expected) => {
    expect(rangeInWords(range)).toBe(expected);
  });
});

describe('a real mods.toml published with unfilled Gradle placeholders (Forge 1.20.1)', () => {
  const P = pack('forge', '1.20.1', '47.3.0');
  const addon = forge({
    file: 'addon.jar',
    mods: [{ id: 'addon', name: 'Addon', loaderDep: '[${big_forge_version},)', mc: '[${minecraft_version},)', deps: [{ id: 'create', range: '[${create_version},)' }] }],
  });

  it('with Create installed: no dependency, loader or Minecraft range finding (FML accepts every version)', () => {
    const create = forge({ file: 'create-0.5.1.f.jar', mods: [{ id: 'create', name: 'Create', version: '0.5.1.f' }] });
    const findings = run([addon, create], P);
    expect(only(findings, 'E-DEP-RANGE')).toEqual([]);
    expect(only(findings, 'E-LOADER-RANGE')).toEqual([]);
    expect(only(findings, 'E-MC-RANGE')).toEqual([]);
  });

  it('without Create: E-MISSING-DEP never shows the placeholder as a version requirement', () => {
    const [f] = only(run([addon], P), 'E-MISSING-DEP');
    expect(f?.title).toBe('Addon requires "create", which is not installed');
    const steps = f?.fixes.flatMap((x) => (x.kind === 'manual' ? x.steps : [])).join(' ') ?? '';
    expect(steps).not.toContain('${create_version}');
  });

  it('Fabric: a placeholder predicate matches no real version, and says why', () => {
    const x = fabric({ file: 'x.jar', mods: [{ id: 'x', name: 'X', deps: [{ id: 'sodium', range: '>=${sodium_version}' }] }] });
    const s = fabric({ file: 'sodium.jar', mods: [{ id: 'sodium', name: 'Sodium', version: '0.5.8' }] });
    const [f] = only(run([x, s], pack('fabric', '1.20.1', '0.16.5')), 'E-DEP-RANGE');
    expect(f?.title).toBe("X's dependency on Sodium is an unfilled placeholder (`${sodium_version}`) that no version matches; you have 0.5.8 (sodium.jar)");
    expect(f?.fixes[0]).toEqual({ kind: 'manual', steps: ['Replace x.jar with another build of X for Fabric 1.20.1; this one declares Sodium as >=${sodium_version}.'] });
  });
});
