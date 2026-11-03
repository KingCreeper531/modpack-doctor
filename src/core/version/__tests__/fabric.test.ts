import { describe, expect, it } from 'vitest';
import type { RawRange } from '../../../bindings';
import { compare, parseRange, satisfies } from '../index';

const fabric = (...raw: string[]): RawRange => ({ syntax: 'fabric', raw, unrepresentable: null });
const cmp = (a: string, b: string): number => compare(a, b, 'fabric', 'other');

describe('Fabric SemanticVersion ordering', () => {
  const ascending = [
    '0.9.9',
    '0.14.21',
    '0.15.0-beta.1',
    '0.15.0-beta.2',
    '0.15.0-beta.10',
    '0.15.0-rc.1',
    '0.15.0',
    '0.15.1',
    '0.15.11',
    '0.16',
    '1.0.0-alpha',
    '1.0.0-alpha.1',
    '1.0.0-alpha.beta',
    '1.0.0-beta',
    '1.0.0-beta.2',
    '1.0.0-beta.11',
    '1.0.0-rc.1',
    '1.0.0',
    '1.0.0.1',
    '1.2',
    '1.10',
  ];
  for (let i = 0; i + 1 < ascending.length; i++) {
    const a = ascending[i] ?? '';
    const b = ascending[i + 1] ?? '';
    it(`${a} < ${b}`, () => {
      expect(cmp(a, b)).toBe(-1);
      expect(cmp(b, a)).toBe(1);
    });
  }

  const equal: Array<[string, string]> = [
    ['1.20', '1.20.0'],
    ['1', '1.0.0.0'],
    ['0.92.2+1.20.1', '0.92.2+1.20.4'],
    ['0.92.2+build.7', '0.92.2'],
    ['1.0.0-beta.01', '1.0.0-beta.1'],
  ];
  for (const [a, b] of equal) {
    it(`${a} == ${b} (missing = 0, build ignored)`, () => expect(cmp(a, b)).toBe(0));
  }

  it('StringVersion fallback orders lexically', () => {
    expect(cmp('mc1.20.1-0.5.8', 'mc1.20.1-0.5.9')).toBe(-1);
    expect(cmp('abc', 'abc')).toBe(0);
  });
});

describe('Fabric predicates', () => {
  // [raw entries (OR), version, expected]
  const cases: Array<[string[], string, boolean]> = [
    [['1.20.1'], '1.20.1', true],
    [['1.20.1'], '1.20.2', false],
    [['=1.20.1'], '1.20.1', true],
    [['=1.20.1'], '1.20.1+build.5', true],
    [['=1.20'], '1.20.0', true],
    [['>=0.15'], '0.15.0', true],
    [['>=0.15'], '0.16.10', true],
    [['>=0.15'], '0.14.25', false],
    [['>=0.15'], '0.15.0-beta.1', false],
    [['>0.15'], '0.15.0', false],
    [['>0.15'], '0.15.1', true],
    [['<=0.15'], '0.15', true],
    [['<=0.15'], '0.15.1', false],
    [['<0.16'], '0.15.11', true],
    [['<0.16'], '0.16.0', false],
    [['<0.16'], '0.16.0-beta.1', true],
    [['~1.20.1'], '1.20.1', true],
    [['~1.20.1'], '1.20.6', true],
    [['~1.20.1'], '1.20', false],
    [['~1.20.1'], '1.21', false],
    [['~1.20.1'], '1.21-beta.1', false],
    [['~1.20'], '1.20.4', true],
    [['^1.2.3'], '1.2.3', true],
    [['^1.2.3'], '1.9.0', true],
    [['^1.2.3'], '2.0.0', false],
    [['^1.2.3'], '1.2.2', false],
    [['^0.15.0'], '0.99.0', true],
    [['1.20.x'], '1.20', true],
    [['1.20.x'], '1.20.6', true],
    [['1.20.x'], '1.21', false],
    [['1.20.x'], '1.19.4', false],
    [['1.21.x'], '1.21.11', true],
    [['1.21.X'], '1.21.4', true],
    [['1.21.*'], '1.21.1', true],
    [['1.x'], '1.21.1', true],
    [['1.x'], '2.0', false],
    [['1.x.x'], '1.5.5', true],
    [['=1.20.x'], '1.20.2', true],
    [['*'], 'anything', true],
    [['>=1.20 <1.21'], '1.20.4', true],
    [['>=1.20 <1.21'], '1.21', false],
    [['>=1.20 <1.21'], '1.19.4', false],
    [['>=0.14.21', '<0.16'], '0.15.3', true],
    [['>=0.14.21', '<0.16'], '0.13.0', true],
    [['>=0.16', '<0.14'], '0.15.0', false],
    [['>=0.16', '<0.14'], '0.16.1', true],
    [['1.20', '1.20.1'], '1.20.1', true],
    [['1.20', '1.20.1'], '1.20.2', false],
    [['>=0.15 * <0.16'], '0.15.5', true],
    [['  >=0.15   <0.16  '], '0.15.5', true],
    // StringVersion fallback: equality only.
    [['mc1.20.1-0.5.8'], 'mc1.20.1-0.5.8', true],
    [['mc1.20.1-0.5.8'], 'mc1.20.1-0.5.9', false],
    [['>=mc1.20.1-0.5.8'], 'mc1.20.1-0.5.8', true],
    [['>=mc1.20.1-0.5.8'], 'mc1.20.1-0.5.9', false],
    [['~weird_version'], 'weird_version', true],
    // Not semantic versions either (VersionParser falls back to StringVersion), so equality only.
    [['1.x.2'], '1.5.2', false],
    [['1.x.2'], '1.x.2', true],
    [['x'], 'x', true],
    [['x'], '1.0', false],
    [['1.20.x-beta.1'], '1.20.1-beta.1', false],
    [['=*'], '*', true],
    [['=*'], '1.0', false],
    // Semantic predicate vs non-semantic version: equal strings only.
    [['>=0.15'], 'mc-0.15', false],
    [['>=0.15'], '0.15-', false],
  ];
  for (const [raw, version, expected] of cases) {
    it(`${version} in ${JSON.stringify(raw)} → ${String(expected)}`, () => {
      expect(satisfies(version, fabric(...raw), 'other')).toBe(expected);
    });
  }

  for (const raw of [[], [''], ['*'], ['   '], ['*', '>=5']]) {
    it(`${JSON.stringify(raw)} means any version`, () => {
      const r = parseRange(fabric(...raw), 'other');
      expect(r.ok && r.matches('0.0.1')).toBe(true);
      expect(r.ok && r.describe()).toBe('any version');
    });
  }

  // fabric-loader rewrites `1.21.x` to 1.21 with an EMPTY pre-release, which sorts below every
  // pre-release of 1.21: pre-releases, RCs and snapshots of 1.21 are inside `1.21.x`.
  const wildcardMc: Array<[string, string, boolean]> = [
    ['1.21.x', '1.21-rc1', true],
    ['1.21.x', '1.21-pre1', true],
    ['1.21.x', '1.21 Pre-Release 2', true],
    ['1.21.x', '24w18a', true],
    ['1.21.x', '24w14a', false],
    ['1.21.x', '1.20.6', false],
    ['1.21.x', '1.22-rc1', false],
    ['1.20.x', '1.20-pre1', true],
    ['1.20.x', '23w12a', true],
    ['1.20.x', '1.20.5-pre1', true],
    ['1.20.x', '1.21-rc1', false],
    ['1.x', '1.0-rc1', true],
    ['1.x', '26.1', false],
    ['26.4.x', '26.4-snapshot-6', true],
    ['26.4.x', '26.4-pre-1', true],
    ['26.4.x', '26.3', false],
    ['=1.21.x', '1.21-rc1', true],
  ];
  for (const [pred, version, expected] of wildcardMc) {
    it(`MC ${version} in ${pred} → ${String(expected)}`, () => {
      expect(satisfies(version, fabric(pred), 'minecraft')).toBe(expected);
    });
  }

  it('wildcards admit pre-releases for non-MC versions too', () => {
    expect(satisfies('0.16.0-beta.1', fabric('0.16.x'), 'other')).toBe(true);
    expect(satisfies('0.17.0-beta.1', fabric('0.16.x'), 'other')).toBe(false);
  });

  const malformed: string[][] = [
    ['>= 0.15'],
    ['>'],
    ['>=1.x'],
    ['~1.20.x'],
    ['<1.20.x'],
    ['>abc'],
    ['<mc1.20'],
    ['>1.x.2'],
    ['>=0.15', '>= 0.16'],
  ];
  for (const raw of malformed) {
    it(`malformed ${JSON.stringify(raw)} → ok:false`, () => {
      const r = parseRange(fabric(...raw), 'other');
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/^Invalid Fabric version predicate ".+": .+/);
      expect(satisfies('1.0', fabric(...raw), 'other')).toBeNull();
    });
  }

  const describeCases: Array<[string[], string]> = [
    [['>=0.15.0 <0.16.0'], '≥ 0.15.0 and < 0.16.0'],
    [['1.20.1'], '1.20.1 only'],
    [['=1.20.1'], '1.20.1 only'],
    [['~1.20.1'], '≥ 1.20.1 and < 1.21'],
    [['^0.15.3'], '≥ 0.15.3 and < 1'],
    [['1.21.x'], '1.21.x'],
    [['>0.1', '<=0.0.5'], '> 0.1 or ≤ 0.0.5'],
    [['mc1.20'], 'mc1.20 only'],
  ];
  for (const [raw, text] of describeCases) {
    it(`describe ${JSON.stringify(raw)} → "${text}"`, () => {
      const r = parseRange(fabric(...raw), 'other');
      expect(r.ok && r.describe()).toBe(text);
    });
  }
});
