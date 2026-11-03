/**
 * Fabric / Quilt version semantics, mirroring fabric-loader's `SemanticVersionImpl`,
 * `StringVersion`, `VersionParser` and `VersionPredicateParser`.
 *
 * - A SemanticVersion has one or more numeric components, an optional `-prerelease`
 *   (dot-separated identifiers) and an optional `+build` (ignored for ordering).
 * - Missing components compare as 0, so `1.20` == `1.20.0`.
 * - Anything that is not a SemanticVersion becomes a StringVersion: it is only ever equal
 *   to an identical string (and ordered lexically when two versions must be ordered).
 * - Predicates: `=` (default), `>=`, `<=`, `>`, `<`, `~` (same major.minor, ≥ v),
 *   `^` (same major, ≥ v), and wildcards `1.20.x` / `1.x` (only with `=` or no operator).
 *   A predicate version that is not semantic (`mc1.20-0.5`, `1.x.2`) falls back to exact string
 *   equality, and is an error with `>` / `<` — as in fabric-loader.
 *   Space-separated predicates inside one string are AND-ed; `*` alone means "no constraint".
 */

/** Sentinel for an `x` / `X` / `*` component (only in predicates). */
const WILDCARD = -1;
const MAX_INT = 2147483647;
const DOT_SEPARATED_ID = /^(?:[-0-9A-Za-z]+(?:\.[-0-9A-Za-z]+)*)?$/;
const DIGITS = /^[0-9]+$/;

export interface SemVer {
  /** Numeric components; `WILDCARD` (-1) for an `x` component. Trailing wildcards collapsed. */
  readonly comps: readonly number[];
  readonly pre: string | null;
  readonly build: string | null;
  /** Index of the first wildcard component, or -1. */
  readonly wildcardAt: number;
  /** The string as written. */
  readonly raw: string;
}

export type FabricVersion =
  | { readonly kind: 'semver'; readonly v: SemVer }
  | { readonly kind: 'string'; readonly raw: string };

/** Parse a SemanticVersion; returns an error message instead of throwing. */
export function parseSemVer(input: string, storeX: boolean): SemVer | string {
  let version = input;
  let build: string | null = null;
  let pre: string | null = null;

  const plus = version.indexOf('+');
  if (plus >= 0) {
    build = version.slice(plus + 1);
    version = version.slice(0, plus);
  }
  const dash = version.indexOf('-');
  if (dash >= 0) {
    pre = version.slice(dash + 1);
    version = version.slice(0, dash);
  }
  if (pre !== null && !DOT_SEPARATED_ID.test(pre)) return `invalid pre-release "${pre}"`;
  if (build !== null && !DOT_SEPARATED_ID.test(build)) return `invalid build metadata "${build}"`;
  if (version.length === 0) return 'no version numbers';
  if (version.endsWith('.')) return 'version ends with "."';
  if (version.startsWith('.')) return 'first version component is empty';

  const parts = version.split('.');
  const comps: number[] = [];
  let wildcardAt = -1;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i] ?? '';
    if (storeX) {
      if (part === 'x' || part === 'X' || part === '*') {
        if (pre !== null) return 'pre-release versions cannot use x-ranges';
        comps.push(WILDCARD);
        if (wildcardAt < 0) wildcardAt = i;
        continue;
      }
      if (i > 0 && comps[i - 1] === WILDCARD) return 'a wildcard may not be followed by a number (1.x.2)';
    }
    if (part.trim().length === 0) return 'missing version number component';
    if (!DIGITS.test(part)) return `"${part}" is not a number`;
    const n = Number(part);
    if (n > MAX_INT) return `"${part}" is too large`;
    comps.push(n);
  }
  if (storeX && comps.length === 1 && comps[0] === WILDCARD) return 'a bare "x" is not a version';
  const collapsed = wildcardAt > 0 && comps.length > wildcardAt + 1 ? comps.slice(0, wildcardAt + 1) : comps;
  return { comps: collapsed, pre, build, wildcardAt, raw: input };
}

/** VersionParser.parse: SemanticVersion, else StringVersion. Empty input → null. */
export function parseFabricVersion(input: string, storeX = false): FabricVersion | null {
  if (input.length === 0) return null;
  const sem = parseSemVer(input, storeX);
  return typeof sem === 'string' ? { kind: 'string', raw: input } : { kind: 'semver', v: sem };
}

function component(v: SemVer, i: number): number {
  if (i < v.comps.length) return v.comps[i] ?? 0;
  return v.comps[v.comps.length - 1] === WILDCARD ? WILDCARD : 0;
}

function hasWildcard(v: SemVer): boolean {
  return v.wildcardAt >= 0;
}

function lex(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareNumericStrings(a: string, b: string): number {
  const x = a.replace(/^0+(?=\d)/, '');
  const y = b.replace(/^0+(?=\d)/, '');
  if (x.length !== y.length) return x.length < y.length ? -1 : 1;
  return lex(x, y);
}

/** SemanticVersionImpl.compareTo (build metadata ignored). */
export function compareSemVer(a: SemVer, b: SemVer): number {
  const n = Math.max(a.comps.length, b.comps.length);
  for (let i = 0; i < n; i++) {
    const x = component(a, i);
    const y = component(b, i);
    if (x === WILDCARD || y === WILDCARD) continue;
    if (x !== y) return x < y ? -1 : 1;
  }
  if (a.pre === null && b.pre === null) return 0;
  if (a.pre !== null && b.pre !== null) {
    const ta = a.pre.split('.').filter((t) => t.length > 0);
    const tb = b.pre.split('.').filter((t) => t.length > 0);
    for (let i = 0; i < ta.length; i++) {
      const pa = ta[i] ?? '';
      const pb = tb[i];
      if (pb === undefined) return 1;
      const na = DIGITS.test(pa);
      const nb = DIGITS.test(pb);
      if (na && nb) {
        const c = compareNumericStrings(pa, pb);
        if (c !== 0) return c;
      } else if (na) {
        return -1;
      } else if (nb) {
        return 1;
      } else {
        const c = lex(pa, pb);
        if (c !== 0) return c;
      }
    }
    return tb.length > ta.length ? -1 : 0;
  }
  if (a.pre !== null) return hasWildcard(b) ? 0 : -1;
  return hasWildcard(a) ? 0 : 1;
}

/** Version.compareTo: semantic when both are semantic, else lexical on the strings. */
export function compareFabricVersions(a: FabricVersion, b: FabricVersion): number {
  if (a.kind === 'semver' && b.kind === 'semver') return compareSemVer(a.v, b.v);
  return lex(a.kind === 'semver' ? a.v.raw : a.raw, b.kind === 'semver' ? b.v.raw : b.raw);
}

export type FabricOp = '=' | '>=' | '<=' | '>' | '<' | '~' | '^';

/** Order matters: longest operators first (as in VersionComparisonOperator). */
const OPERATORS: readonly FabricOp[] = ['>=', '<=', '>', '<', '=', '~', '^'];

export type FabricPredicate =
  | { readonly kind: 'op'; readonly op: FabricOp; readonly v: SemVer }
  /** `1.20.x` → ≥ 1.20 with components [1, 20] fixed. */
  | { readonly kind: 'prefix'; readonly v: SemVer; readonly written: string }
  /** Non-semantic version: equality with the exact string. */
  | { readonly kind: 'string'; readonly raw: string };

/** One space-separated predicate string (an AND group). Empty array = no constraint. */
export function parsePredicateGroup(entry: string): FabricPredicate[] | string {
  const out: FabricPredicate[] = [];
  for (const token of entry.split(' ')) {
    const s0 = token.trim();
    if (s0.length === 0 || s0 === '*') continue;
    let op: FabricOp = '=';
    let s = s0;
    for (const candidate of OPERATORS) {
      if (s.startsWith(candidate)) {
        op = candidate;
        s = s.slice(candidate.length);
        break;
      }
    }
    if (s.length === 0) {
      return `"${s0}" has no version after the operator (Fabric does not allow a space after "${op}")`;
    }
    const sem = parseSemVer(s, true);
    if (typeof sem !== 'string') {
      if (hasWildcard(sem)) {
        if (op !== '=') return `"${s0}": wildcard versions (.x) cannot be combined with "${op}"`;
        const prefix = sem.comps.slice(0, sem.wildcardAt);
        out.push({
          kind: 'prefix',
          v: { comps: prefix, pre: null, build: sem.build, wildcardAt: -1, raw: prefix.join('.') },
          written: s,
        });
      } else {
        out.push({ kind: 'op', op, v: sem });
      }
    } else if (op === '>' || op === '<') {
      return `"${s0}": "${s}" is not a semantic version, so it cannot be used with "${op}" (${sem})`;
    } else {
      out.push({ kind: 'string', raw: s });
    }
  }
  return out;
}

function inclusive(p: FabricPredicate): boolean {
  return p.kind !== 'op' || (p.op !== '>' && p.op !== '<');
}

export function testPredicate(p: FabricPredicate, version: FabricVersion): boolean {
  if (p.kind === 'string') return (version.kind === 'semver' ? version.v.raw : version.raw) === p.raw;
  if (version.kind === 'string') return inclusive(p) && version.raw === p.v.raw;
  const a = version.v;
  const c = compareSemVer(a, p.v);
  if (p.kind === 'prefix') {
    if (c < 0) return false;
    for (let i = 0; i < p.v.comps.length; i++) if (component(a, i) !== component(p.v, i)) return false;
    return true;
  }
  switch (p.op) {
    case '=':
      return c === 0;
    case '>=':
      return c >= 0;
    case '<=':
      return c <= 0;
    case '>':
      return c > 0;
    case '<':
      return c < 0;
    case '~':
      return c >= 0 && component(a, 0) === component(p.v, 0) && component(a, 1) === component(p.v, 1);
    case '^':
      return c >= 0 && component(a, 0) === component(p.v, 0);
  }
}

export function describePredicate(p: FabricPredicate): string {
  if (p.kind === 'string') return `${p.raw} only`;
  if (p.kind === 'prefix') return p.written;
  const v = p.v.raw;
  switch (p.op) {
    case '=':
      return `${v} only`;
    case '>=':
      return `≥ ${v}`;
    case '<=':
      return `≤ ${v}`;
    case '>':
      return `> ${v}`;
    case '<':
      return `< ${v}`;
    case '~':
      return `≥ ${v} and < ${component(p.v, 0)}.${component(p.v, 1) + 1}`;
    case '^':
      return `≥ ${v} and < ${component(p.v, 0) + 1}`;
  }
}
