import { describe, expect, it } from 'vitest';
import type { RawRange } from '../../../bindings';
import { compare, parseRange, satisfies } from '../index';

const maven = (raw: string): RawRange => ({ syntax: 'maven', raw: [raw], unrepresentable: null });
const cmp = (a: string, b: string): number => compare(a, b, 'maven', 'other');

describe('Maven ComparableVersion ordering', () => {
  // From Maven's ComparableVersionTest (VERSIONS_QUALIFIER / VERSIONS_NUMBER, maven-artifact 3.6–3.8,
  // the generation FML ships): strictly ascending.
  const qualifierOrder = [
    '1-alpha2snapshot',
    '1-alpha2',
    '1-alpha-123',
    '1-beta-2',
    '1-beta123',
    '1-m2',
    '1-m11',
    '1-rc',
    '1-cr2',
    '1-rc123',
    '1-SNAPSHOT',
    '1',
    '1-sp',
    '1-sp2',
    '1-sp123',
    '1-abc',
    '1-def',
    '1-pom-1',
    '1-1-snapshot',
    '1-1',
    '1-2',
    '1-123',
  ];
  const numberOrder = [
    '2.0',
    '2-1',
    '2.0.a',
    '2.0.0.a',
    '2.0.2',
    '2.0.123',
    '2.1.0',
    '2.1-a',
    '2.1b',
    '2.1-c',
    '2.1-1',
    '2.1.0.1',
    '2.2',
    '2.123',
    '11.a2',
    '11.a11',
    '11.b2',
    '11.b11',
    '11.m2',
    '11.m11',
    '11',
    '11.a',
    '11b',
    '11c',
    '11m',
  ];
  for (const [name, list] of [
    ['qualifiers', qualifierOrder],
    ['numbers', numberOrder],
  ] as const) {
    for (let i = 0; i + 1 < list.length; i++) {
      const a = list[i] ?? '';
      const b = list[i + 1] ?? '';
      it(`${name}: ${a} < ${b}`, () => {
        expect(cmp(a, b)).toBe(-1);
        expect(cmp(b, a)).toBe(1);
      });
    }
  }

  const equal: Array<[string, string]> = [
    ['1', '1.0'],
    ['1', '1.0.0'],
    ['1.0', '1.0.0'],
    ['1', '1-0'],
    ['1', '1.0-0'],
    ['1.0.0', '1.0-ga'],
    ['1ga', '1-ga'],
    ['1ga', '1.ga'],
    ['1', '1-final'],
    ['1', '1.release'],
    ['1a1', '1-alpha-1'],
    ['1a1', '1alpha1'],
    ['1b2', '1-beta-2'],
    ['1m3', '1milestone3'],
    ['1rc', '1cr'],
    ['1X', '1x'],
    ['1-SNAPSHOT', '1-snapshot'],
    ['47.1.0', '47.1'],
    ['47', '47.0.0'],
    ['20.4.0-beta', '20.4-beta'],
  ];
  for (const [a, b] of equal) {
    it(`${a} == ${b}`, () => expect(cmp(a, b)).toBe(0));
  }

  const less: Array<[string, string]> = [
    ['1.0-alpha', '1.0-beta'],
    ['1.0-beta', '1.0-milestone'],
    ['1.0-milestone', '1.0-rc'],
    ['1.0-rc', '1.0-snapshot'],
    ['1.0-snapshot', '1.0'],
    ['1.0', '1.0-sp'],
    ['1.0-sp', '1.0-zzz'],
    ['1.0-foo', '1.0-zzz'],
    ['47.1.0', '47.1.1'],
    ['47.1.99', '47.2.0'],
    ['47.9.9', '47.10'],
    ['20.4.80-beta', '20.4.80'],
    ['21.1.0', '21.1.77'],
    ['1.9', '1.10'],
    ['999999999999999999998', '999999999999999999999'],
  ];
  for (const [a, b] of less) {
    it(`${a} < ${b}`, () => expect(cmp(a, b)).toBe(-1));
  }
});

describe('Maven VersionRange', () => {
  // [spec, version, expected]
  const cases: Array<[string, string, boolean]> = [
    ['[1.0,2.0]', '1.0', true],
    ['[1.0,2.0]', '2.0', true],
    ['[1.0,2.0]', '2.0.1', false],
    ['(1.0,2.0)', '1.0', false],
    ['(1.0,2.0)', '1.5', true],
    ['(1.0,2.0)', '2.0', false],
    ['[1.0,2.0)', '2.0', false],
    ['[1.0,2.0)', '1.99', true],
    ['(1.0,2.0]', '1.0', false],
    ['(1.0,2.0]', '2.0', true],
    ['[1.0,)', '1.0', true],
    ['[1.0,)', '999', true],
    ['[1.0,)', '0.9', false],
    ['(1.0,)', '1.0', false],
    ['(1.0,)', '1.0.1', true],
    ['(,1.0]', '1.0', true],
    ['(,1.0]', '0.1', true],
    ['(,1.0]', '1.0.1', false],
    ['(,1.0)', '1.0', false],
    ['(,1.0)', '1.0-rc1', true],
    ['[1.5]', '1.5', true],
    ['[1.5]', '1.5.0', true],
    ['[1.5]', '1.5.1', false],
    ['[1.5]', '1.4', false],
    ['[1,2),[3,4)', '1.5', true],
    ['[1,2),[3,4)', '2.5', false],
    ['[1,2),[3,4)', '3', true],
    ['[1,2),[3,4)', '4', false],
    ['(,1.0],[1.2,)', '1.1', false],
    ['(,1.0],[1.2,)', '1.0', true],
    ['(,1.0],[1.2,)', '5', true],
    ['[1,2],[2,3]', '2', true],
    ['[1.0,1.0]', '1.0', true],
    ['[1.0,1]', '1.0.0', true],
    ['[ 1.0 , 2.0 ]', '1.5', true],
    ['[,]', '42', true],
    // Real-world Forge / NeoForge ranges.
    ['[47,)', '47.2.0', true],
    ['[47,)', '46.0.14', false],
    ['[47.1.3,)', '47.1.0', false],
    ['[47,48)', '47.4.10', true],
    ['[47,48)', '48.0.1', false],
    ['[20.4,)', '20.4.237', true],
    ['[20.4,)', '20.2.88', false],
    ['[21.1.0,)', '21.1.77', true],
    ['[21.1.0,)', '21.0.167', false],
    ['[4,)', '4', true],
    ['[1,)', '2', true],
    ['[21.1.0-beta,)', '21.1.0', true],
    ['[21.1.0,)', '21.1.0-beta', false],
  ];
  for (const [spec, version, expected] of cases) {
    it(`${version} in ${spec} → ${String(expected)}`, () => {
      expect(satisfies(version, maven(spec), 'other')).toBe(expected);
    });
  }

  const soft = ['47.1.0', '1.20.1', '0.1', 'SNAPSHOT'];
  for (const spec of soft) {
    it(`bare "${spec}" is a soft requirement matching everything`, () => {
      const r = parseRange(maven(spec), 'other');
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.matches('0.0.1')).toBe(true);
      expect(r.matches('999')).toBe(true);
      expect(r.describe()).toBe(`any version (recommends ${spec})`);
    });
  }

  for (const spec of ['', '*', '  ']) {
    it(`"${spec}" means any version`, () => {
      const r = parseRange(maven(spec), 'other');
      expect(r.ok && r.matches('1.2.3')).toBe(true);
      expect(r.ok && r.describe()).toBe('any version');
    });
  }

  const malformed = [
    '[1.0',
    '(1.0',
    '[1.0,2.0',
    '(1.0)',
    '[1.0)',
    '(1.0]',
    '[2.0,1.0]',
    '[1,2),3',
    '[1,3),[2,4)',
    '[3,4),[1,2)',
    '[1,2,3]',
    '[]',
    '1.0]',
    '1.0,2.0',
    '[1,2) junk',
    '[1.0,1.0)',
    '(1.0,1.0]',
    '(1.0,1.0)',
    '[1.0,1.0.0)',
    '[1,2),[3,3)',
  ];
  for (const spec of malformed) {
    it(`malformed "${spec}" → ok:false with a message`, () => {
      const r = parseRange(maven(spec), 'other');
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.error).toMatch(/^Invalid Maven version range: .+/);
      expect(satisfies('1.5', maven(spec), 'other')).toBeNull();
    });
  }

  const describeCases: Array<[string, string]> = [
    ['[1.20.1]', '1.20.1 only'],
    ['[47,)', '≥ 47'],
    ['(47,)', '> 47'],
    ['(,1.21)', '< 1.21'],
    ['(,1.21]', '≤ 1.21'],
    ['[1.20,1.20.2)', '≥ 1.20 and < 1.20.2'],
    ['(1,2]', '> 1 and ≤ 2'],
    ['[1,2),[3,4)', '≥ 1 and < 2 or ≥ 3 and < 4'],
    ['[,]', 'any version'],
  ];
  for (const [spec, text] of describeCases) {
    it(`describe ${spec} → "${text}"`, () => {
      const r = parseRange(maven(spec), 'other');
      expect(r.ok && r.describe()).toBe(text);
    });
  }

  it('several raw entries are OR-ed (defensive; Rust sends one)', () => {
    const r: RawRange = { syntax: 'maven', raw: ['[1,2)', '[5,6)'], unrepresentable: null };
    expect(satisfies('5.5', r, 'other')).toBe(true);
    expect(satisfies('3', r, 'other')).toBe(false);
  });
});
