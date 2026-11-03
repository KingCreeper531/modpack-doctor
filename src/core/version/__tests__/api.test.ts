import { describe, expect, it } from 'vitest';
import type { RawRange } from '../../../bindings';
import type { VersionApi } from '../../model';
import { versionApi } from '../index';

const api: VersionApi = versionApi;
const r = (syntax: RawRange['syntax'], raw: string[], unrepresentable: string | null = null): RawRange => ({
  syntax,
  raw,
  unrepresentable,
});

describe('versionApi', () => {
  it('unrepresentable ranges cannot be evaluated (both syntaxes)', () => {
    for (const syntax of ['maven', 'fabric'] as const) {
      const range = r(syntax, [], '{"all":[{"any":["1"]}]}');
      const p = api.parseRange(range, 'other');
      expect(p.ok).toBe(false);
      if (!p.ok) expect(p.error).toContain('too complex');
      expect(api.satisfies('1', range, 'other')).toBeNull();
    }
  });

  it('empty raw means any version', () => {
    expect(api.satisfies('1.2.3', r('fabric', []), 'other')).toBe(true);
    expect(api.satisfies('1.2.3', r('maven', []), 'other')).toBe(true);
    expect(api.satisfies('26.4-snapshot-6', r('fabric', []), 'minecraft')).toBe(true);
  });

  it('caches parsed ranges (same object for equal input)', () => {
    const a = api.parseRange(r('fabric', ['>=0.15']), 'other');
    const b = api.parseRange(r('fabric', ['>=0.15']), 'other');
    expect(a).toBe(b);
    expect(api.parseRange(r('fabric', ['>=0.15']), 'minecraft')).not.toBe(a);
  });

  it('never throws on hostile input', () => {
    const bad: unknown[] = [null, undefined, 42, {}, { syntax: 'maven' }, { syntax: 'nope', raw: [], unrepresentable: null }, { syntax: 'fabric', raw: [1], unrepresentable: null }];
    for (const value of bad) {
      const range = value as RawRange;
      expect(() => api.parseRange(range, 'other')).not.toThrow();
      expect(api.parseRange(range, 'other').ok).toBe(false);
      expect(api.satisfies('1', range, 'other')).toBeNull();
    }
    expect(() => api.compare(null as unknown as string, '1', 'maven', 'other')).not.toThrow();
    expect(api.normalizeMinecraft(undefined as unknown as string)).toBeNull();
    const ok = api.parseRange(r('fabric', ['>=1']), 'other');
    expect(ok.ok && ok.matches(null as unknown as string)).toBe(false);
  });

  it('empty version strings are unparseable', () => {
    expect(api.satisfies('', r('fabric', ['>=1']), 'other')).toBeNull();
    expect(api.satisfies('  ', r('maven', ['[1,)']), 'other')).toBeNull();
  });

  it('compare returns -1 / 0 / 1', () => {
    expect(api.compare('1.0', '1.0.0', 'maven', 'other')).toBe(0);
    expect(api.compare('47.1.0', '47.2.0', 'maven', 'other')).toBe(-1);
    expect(api.compare('0.16.0', '0.15.11', 'fabric', 'other')).toBe(1);
    expect(api.compare('26.1', '1.21.11', 'fabric', 'minecraft')).toBe(1);
  });

  // Real-world declarations as the scanner passes them, with the pack version tested.
  const realWorld: Array<[string, RawRange, 'minecraft' | 'other', string, boolean]> = [
    ['Forge loader dep [47,)', r('maven', ['[47,)']), 'other', '47.3.0', true],
    ['Forge mc dep [1.20,1.20.2)', r('maven', ['[1.20,1.20.2)']), 'minecraft', '1.20.1', true],
    ['Forge mc dep [1.20.1]', r('maven', ['[1.20.1]']), 'minecraft', '1.20.1', true],
    ['Forge mc dep [1.20.1] on 1.20.4', r('maven', ['[1.20.1]']), 'minecraft', '1.20.4', false],
    ['Forge mc dep [1.20.1,1.21) on 1.21.1', r('maven', ['[1.20.1,1.21)']), 'minecraft', '1.21.1', false],
    ['NeoForge [20.4,)', r('maven', ['[20.4,)']), 'other', '20.4.237', true],
    ['NeoForge [21.1.0,) on 20.6', r('maven', ['[21.1.0,)']), 'other', '20.6.119', false],
    ['NeoForge mc [1.21,1.21.2)', r('maven', ['[1.21,1.21.2)']), 'minecraft', '1.21.1', true],
    ['NeoForge mc [1.21.11,) on 26.1', r('maven', ['[1.21.11,)']), 'minecraft', '26.1', true],
    ['Fabric loader >=0.15', r('fabric', ['>=0.15']), 'other', '0.16.10', true],
    ['Fabric loader >=0.15 on 0.14.25', r('fabric', ['>=0.15']), 'other', '0.14.25', false],
    ['Fabric mc ~1.20.1', r('fabric', ['~1.20.1']), 'minecraft', '1.20.4', true],
    ['Fabric array is OR', r('fabric', ['>=0.14.21', '<0.16']), 'other', '0.17.0', true],
    ['Fabric array is OR (neither)', r('fabric', ['<0.14', '>=0.16']), 'other', '0.15.2', false],
    ['Fabric mc AND', r('fabric', ['>=1.20 <1.21']), 'minecraft', '1.20.6', true],
    ['Fabric mc 1.21.x on 1.21.11', r('fabric', ['1.21.x']), 'minecraft', '1.21.11', true],
    ['Fabric mc 1.21.x on 26.1', r('fabric', ['1.21.x']), 'minecraft', '26.1', false],
    ['Fabric API >=0.92.0+1.20.1', r('fabric', ['>=0.92.0+1.20.1']), 'other', '0.92.2+1.20.1', true],
    ['Quilt any-of', r('fabric', ['1.20.1', '1.20.2', '1.20.4']), 'minecraft', '1.20.2', true],
  ];
  for (const [name, range, subject, version, expected] of realWorld) {
    it(`${name}: ${version} → ${String(expected)}`, () => {
      expect(api.satisfies(version, range, subject)).toBe(expected);
    });
  }
});
