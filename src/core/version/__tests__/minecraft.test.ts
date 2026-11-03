import { describe, expect, it } from 'vitest';
import type { RawRange } from '../../../bindings';
import { compare, normalizeMinecraft, satisfies } from '../index';
import { snapshotRelease } from '../minecraft';

describe('normalizeMinecraft', () => {
  const cases: Array<[string, string | null]> = [
    ['1.20.1', '1.20.1'],
    ['1.21', '1.21'],
    ['1.21.11', '1.21.11'],
    ['1.8.9', '1.8.9'],
    [' 1.20.1 ', '1.20.1'],
    ['1.20.5-pre1', '1.20.5-beta.1'],
    ['1.20.5 Pre-Release 1', '1.20.5-beta.1'],
    ['1.21.6-pre4', '1.21.6-beta.4'],
    ['1.16-pre3', '1.16-rc.3'],
    ['1.15.2-pre1', '1.15.2-rc.1'],
    ['1.16.2-pre1', '1.16.2-beta.1'],
    ['1.21-rc1', '1.21-rc.1'],
    ['1.21 Release Candidate 1', '1.21-rc.1'],
    ['1.16-rc1', '1.16-rc.9'],
    ['1.21.11-rc1_unobfuscated', '1.21.11-rc.1+unobfuscated'],
    ['1.21.11_unobfuscated', '1.21.11+unobfuscated'],
    ['23w51a', '1.20.5-alpha.23.51.a'],
    ['24w14a', '1.20.5-alpha.24.14.a'],
    ['24w18a', '1.21-alpha.24.18.a'],
    ['23w07a', '1.19.4-alpha.23.7.a'],
    ['18w43a', '1.14-alpha.18.43.a'],
    ['19w14b', '1.14-alpha.19.14.b'],
    ['20w45a', '1.17-alpha.20.45.a'],
    ['21w20a', '1.17-alpha.21.20.a'],
    ['22w24a', '1.19.1-alpha.22.24.a'],
    ['24w44a', '1.21.4-alpha.24.44.a'],
    ['25w02a', '1.21.5-alpha.25.2.a'],
    ['25w21a', '1.21.6-alpha.25.21.a'],
    ['25w31a', '1.21.9-alpha.25.31.a'],
    ['25w45a', '1.21.11-alpha.25.45.a'],
    ['Snapshot 16w02a', '1.9-alpha.16.2.a'],
    ['26w14a', '26.1.1-alpha.26.14.a'],
    ['26.1', '26.1'],
    ['26.1.2', '26.1.2'],
    ['26.3', '26.3'],
    ['26.4-snapshot-6', '26.4-alpha.6'],
    ['26.1-snapshot-1', '26.1-alpha.1'],
    ['26.1-pre-2', '26.1-pre.2'],
    ['26.1-rc-1', '26.1-rc.1'],
    ['26.1.1-rc-1', '26.1.1-rc.1'],
    // Canonical output is accepted (idempotent).
    ['1.20.5-beta.1', '1.20.5-beta.1'],
    ['26.4-alpha.6', '26.4-alpha.6'],
    // Unrecognised.
    ['', null],
    ['foo', null],
    ['b1.7.3', null],
    ['24w16a', null],
    ['26w20a', null],
    ['27w01a', null],
    ['25w46a', '1.21.11-alpha.25.46.a'],
    ['1.20.1-forge', null],
    ['v1.20', null],
  ];
  for (const [input, expected] of cases) {
    it(`${JSON.stringify(input)} → ${String(expected)}`, () => {
      expect(normalizeMinecraft(input)).toBe(expected);
      if (expected !== null) expect(normalizeMinecraft(expected)).toBe(expected);
    });
  }

  it('the snapshot table covers 2018–2025 snapshot cycles', () => {
    expect(snapshotRelease(18, 1)).toBe('1.13');
    expect(snapshotRelease(19, 34)).toBe('1.15');
    expect(snapshotRelease(22, 3)).toBe('1.18.2');
    expect(snapshotRelease(23, 12)).toBe('1.20');
    expect(snapshotRelease(23, 31)).toBe('1.20.2');
    expect(snapshotRelease(23, 40)).toBe('1.20.3');
    expect(snapshotRelease(24, 33)).toBe('1.21.2');
    expect(snapshotRelease(25, 37)).toBe('1.21.9');
    expect(snapshotRelease(25, 50)).toBe('1.21.11');
    expect(snapshotRelease(26, 14)).toBe('26.1.1');
    expect(snapshotRelease(26, 1)).toBeNull();
    expect(snapshotRelease(30, 10)).toBeNull();
  });
});

describe('Minecraft ordering (Fabric syntax: McVersionLookup normalisation)', () => {
  // Strictly ascending (chronological).
  const ascending = [
    '1.12.2',
    '1.16-pre1',
    '1.16-rc1',
    '1.16',
    '1.19.4',
    '23w12a',
    '1.20-pre1',
    '1.20',
    '1.20.1',
    '1.20.4',
    '23w51a',
    '24w14a',
    '1.20.5-pre1',
    '1.20.5-pre2',
    '1.20.5-rc1',
    '1.20.5',
    '1.20.6',
    '24w18a',
    '1.21-pre1',
    '1.21-rc1',
    '1.21',
    '1.21.1',
    '1.21.10',
    '25w45a',
    '1.21.11-pre1',
    '1.21.11',
    '26.1-snapshot-1',
    '26.1-snapshot-11',
    '26.1-pre-1',
    '26.1-rc-1',
    '26.1',
    '26.1.1',
    '26.1.2',
    '26.2',
    '26.3',
    '26.4-snapshot-1',
    '26.4-snapshot-6',
    '26.4',
  ];
  for (let i = 0; i + 1 < ascending.length; i++) {
    const a = ascending[i] ?? '';
    const b = ascending[i + 1] ?? '';
    it(`fabric: ${a} < ${b}`, () => {
      expect(compare(a, b, 'fabric', 'minecraft')).toBe(-1);
      expect(compare(b, a, 'fabric', 'minecraft')).toBe(1);
    });
  }

  it('1.20 == 1.20.0 for MC', () => {
    expect(compare('1.20', '1.20.0', 'maven', 'minecraft')).toBe(0);
    expect(compare('1.20', '1.20.0', 'fabric', 'minecraft')).toBe(0);
  });
});

describe('Minecraft ordering (Maven syntax: raw ComparableVersion, as FML)', () => {
  // [a, b, expected compare(a, b)] — the subject does not change Maven ordering.
  const cases: Array<[string, string, number]> = [
    ['1.20.5-pre1', '1.20.5', 1], // unknown qualifier `pre` sorts above the release
    ['1.21-pre1', '1.21', 1],
    ['1.21-pre1', '1.21.1', -1],
    ['1.21-rc1', '1.21', -1], // `rc` is a known qualifier, below the release
    ['1.21-pre1', '1.21-rc1', 1],
    ['1.20.1', '1.20.4', -1],
    ['1.21.11', '26.1', -1],
    ['26.1', '26.1.0', 0],
    ['26.4-snapshot-6', '26.4', -1], // `snapshot` is a known qualifier
    ['26.3', '26.4-snapshot-6', -1],
  ];
  for (const [a, b, expected] of cases) {
    it(`maven: compare(${a}, ${b}) = ${expected}`, () => {
      expect(compare(a, b, 'maven', 'minecraft')).toBe(expected);
      expect(compare(a, b, 'maven', 'other')).toBe(expected);
    });
  }
});

describe('Minecraft ranges', () => {
  const maven = (raw: string): RawRange => ({ syntax: 'maven', raw: [raw], unrepresentable: null });
  const fabric = (...raw: string[]): RawRange => ({ syntax: 'fabric', raw, unrepresentable: null });

  const cases: Array<[RawRange, string, boolean | null]> = [
    [maven('[1.20,1.21)'), '1.20.1', true],
    [maven('[1.20,1.21)'), '1.20.5-pre1', true],
    // FML: raw ComparableVersion. `23w51a` parses as 23.w.51.a, far above 1.21.
    [maven('[1.20,1.21)'), '23w51a', false],
    [maven('[1.20,1.21)'), '1.21', false],
    [maven('[1.20,1.21)'), '1.21-rc1', true],
    [maven('[1.20,1.21)'), '1.21-pre1', false],
    [maven('[1.21,)'), '1.21-pre1', true],
    [maven('[1.20,1.21)'), '1.19.4', false],
    [maven('[1.20,1.20.2)'), '1.20.1', true],
    [maven('[1.20,1.20.2)'), '1.20.2', false],
    [maven('[1.20,1.20.2)'), '1.20', true],
    [maven('[1.20.1]'), '1.20.1', true],
    [maven('[1.20.1]'), '1.20.2', false],
    [maven('[1.20.5,)'), '1.20.5-pre1', true],
    [maven('(,1.20.5)'), '1.20.5-pre1', false],
    [maven('[1.20.5-pre1,)'), '1.20.5-pre1', true],
    // FML quirk: the release sorts *below* its own pre-release in ComparableVersion.
    [maven('[1.20.5-pre1,)'), '1.20.5', false],
    [maven('[1.20.5-pre1,)'), '1.20.6', true],
    [maven('[1.21,)'), '26.1', true],
    [maven('[1.21,26)'), '26.1', false],
    [maven('[26.1,26.2)'), '26.1.2', true],
    [maven('[26.4,)'), '26.4-snapshot-6', false],
    [maven('(26.3,26.4]'), '26.4-snapshot-6', true],
    [maven('1.20.1'), '1.19.2', true],
    // Maven parses every non-empty string, MC-shaped or not (as FML does).
    [maven('[1.20,1.21)'), 'not-a-version', false],
    [maven('[1.20,1.21)'), '', null],
    [fabric('1.20.1'), '1.20.1', true],
    [fabric('>=1.20 <1.21'), '1.20.4', true],
    [fabric('~1.20.1'), '1.20.4', true],
    [fabric('~1.20.1'), '1.21', false],
    [fabric('1.21.x'), '1.21.11', true],
    [fabric('1.21.x'), '24w18a', true],
    [fabric('>=1.21-alpha.24.18.a'), '24w18a', true],
    [fabric('1.20.x'), '23w51a', true],
    [fabric('>=1.20.5-beta.1'), '1.20.5-pre1', true],
    [fabric('>=1.20.5-beta.1'), '1.20.5-pre2', true],
    [fabric('>=1.20.5-beta.1'), '23w51a', false],
    // Like fabric-loader, predicate versions are not normalised: beta.1 < pre1.
    [fabric('>=1.20.5-pre1'), '1.20.5-pre1', false],
    [fabric('>=1.20.5'), '1.20.5-pre1', false],
    [fabric('>=26.1'), '26.3', true],
    [fabric('>=26.1'), '1.21.11', false],
    [fabric('>=26.4-alpha.1'), '26.4-snapshot-6', true],
    [fabric('<26.4'), '26.4-snapshot-6', true],
    [fabric('26.1.x'), '26.1.2', true],
    [fabric('>=1.21.11 <26.2'), '26.1', true],
    [fabric('>=1.21'), 'nonsense', null],
    [fabric('*'), 'nonsense', true],
  ];
  for (const [range, version, expected] of cases) {
    it(`MC ${version} in ${range.syntax} ${JSON.stringify(range.raw)} → ${String(expected)}`, () => {
      expect(satisfies(version, range, 'minecraft')).toBe(expected);
    });
  }
});
