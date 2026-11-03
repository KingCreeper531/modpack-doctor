/**
 * Maven version semantics, mirroring Maven 3 `ComparableVersion` and `VersionRange`
 * (what Forge / NeoForge FML use for `versionRange` in mods.toml).
 *
 * Ordering: the string is lower-cased and split into items on `.`, `-` and digit↔letter
 * transitions. A `-` (or a transition) opens a nested sub-list. Numbers compare
 * numerically and sort after strings; qualifiers sort
 * `alpha < beta < milestone < rc = cr < snapshot < "" = ga = final = release < sp`, with unknown
 * qualifiers after `sp`, lexically. `a1` / `b1` / `m1` are alpha / beta / milestone.
 * Trailing zeros / empty qualifiers are dropped, so `1` == `1.0` == `1.0.0` == `1.0-ga`.
 */

const INT = 0;
const STR = 1;
const LIST = 2;

export type MavenItem =
  | { readonly t: typeof INT; readonly v: string }
  | { readonly t: typeof STR; readonly v: string }
  | { readonly t: typeof LIST; readonly items: MavenItem[] };

const QUALIFIERS: readonly string[] = ['alpha', 'beta', 'milestone', 'rc', 'snapshot', '', 'sp'];
const ALIASES: Readonly<Record<string, string>> = { ga: '', final: '', release: '', cr: 'rc' };
const RELEASE_INDEX = String(QUALIFIERS.indexOf(''));

function isDigit(c: string): boolean {
  return c >= '0' && c <= '9';
}

function intItem(digits: string): MavenItem {
  const stripped = digits.replace(/^0+/, '');
  return { t: INT, v: stripped.length === 0 ? '0' : stripped };
}

function strItem(value: string, followedByDigit: boolean): MavenItem {
  let v = value;
  if (followedByDigit && v.length === 1) {
    if (v === 'a') v = 'alpha';
    else if (v === 'b') v = 'beta';
    else if (v === 'm') v = 'milestone';
  }
  return { t: STR, v: ALIASES[v] ?? v };
}

function parseItem(isNumber: boolean, buf: string): MavenItem {
  return isNumber ? intItem(buf) : strItem(buf, false);
}

function isNull(item: MavenItem): boolean {
  if (item.t === INT) return item.v === '0';
  if (item.t === STR) return item.v === '';
  return item.items.length === 0;
}

function normalize(list: MavenItem[]): void {
  for (let i = list.length - 1; i >= 0; i--) {
    const last = list[i];
    if (last === undefined) continue;
    if (isNull(last)) list.splice(i, 1);
    else if (last.t !== LIST) break;
  }
}

/** ComparableVersion.parseVersion. Never throws. */
export function parseMaven(version: string): MavenItem {
  const s = version.toLowerCase();
  const root: MavenItem[] = [];
  let list = root;
  const stack: MavenItem[][] = [root];
  let digit = false;
  let start = 0;

  const openSublist = (): void => {
    const sub: MavenItem[] = [];
    list.push({ t: LIST, items: sub });
    list = sub;
    stack.push(sub);
  };

  for (let i = 0; i < s.length; i++) {
    const c = s.charAt(i);
    if (c === '.') {
      list.push(i === start ? intItem('0') : parseItem(digit, s.slice(start, i)));
      start = i + 1;
    } else if (c === '-') {
      list.push(i === start ? intItem('0') : parseItem(digit, s.slice(start, i)));
      start = i + 1;
      openSublist();
    } else if (isDigit(c)) {
      if (!digit && i > start) {
        list.push(strItem(s.slice(start, i), true));
        start = i;
        openSublist();
      }
      digit = true;
    } else {
      if (digit && i > start) {
        list.push(parseItem(true, s.slice(start, i)));
        start = i;
        openSublist();
      }
      digit = false;
    }
  }
  if (s.length > start) list.push(parseItem(digit, s.slice(start)));
  for (let i = stack.length - 1; i >= 0; i--) {
    const l = stack[i];
    if (l) normalize(l);
  }
  return { t: LIST, items: root };
}

function lex(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function comparableQualifier(q: string): string {
  const i = QUALIFIERS.indexOf(q);
  return i === -1 ? `${QUALIFIERS.length}-${q}` : String(i);
}

function compareDigits(a: string, b: string): number {
  if (a.length !== b.length) return a.length < b.length ? -1 : 1;
  return lex(a, b);
}

function compareItem(a: MavenItem, b: MavenItem | null): number {
  if (a.t === INT) {
    if (b === null) return a.v === '0' ? 0 : 1;
    return b.t === INT ? compareDigits(a.v, b.v) : 1;
  }
  if (a.t === STR) {
    if (b === null) return lex(comparableQualifier(a.v), RELEASE_INDEX);
    if (b.t === STR) return lex(comparableQualifier(a.v), comparableQualifier(b.v));
    return -1;
  }
  if (b === null) {
    for (const item of a.items) {
      const r = compareItem(item, null);
      if (r !== 0) return r;
    }
    return 0;
  }
  if (b.t === INT) return -1;
  if (b.t === STR) return 1;
  const n = Math.max(a.items.length, b.items.length);
  for (let i = 0; i < n; i++) {
    const l = a.items[i] ?? null;
    const r = b.items[i] ?? null;
    const result = l === null ? (r === null ? 0 : -compareItem(r, null)) : compareItem(l, r);
    if (result !== 0) return result;
  }
  return 0;
}

export function compareMavenItems(a: MavenItem, b: MavenItem): number {
  return compareItem(a, b);
}

export interface Restriction {
  readonly lower: string | null;
  readonly lowerInclusive: boolean;
  readonly upper: string | null;
  readonly upperInclusive: boolean;
}

export type MavenSpec =
  | { readonly kind: 'all' }
  /** A bare version: Maven/FML treat it as a recommendation that matches everything. */
  | { readonly kind: 'soft'; readonly version: string }
  | { readonly kind: 'set'; readonly restrictions: readonly Restriction[] };

export type Comparator = (a: string, b: string) => number;

const RANGE_CHARS = /[[\](),]/;

function parseRestriction(spec: string, cmp: Comparator, whole: string): Restriction | string {
  const lowerInclusive = spec.startsWith('[');
  const upperInclusive = spec.endsWith(']');
  const body = spec.slice(1, -1).trim();
  const comma = body.indexOf(',');
  if (comma < 0) {
    if (!lowerInclusive || !upperInclusive) {
      return `"${spec}" in "${whole}": a single version must be written as [version]`;
    }
    if (body.length === 0) return `"${whole}" contains an empty []`;
    return { lower: body, lowerInclusive: true, upper: body, upperInclusive: true };
  }
  const lowerRaw = body.slice(0, comma).trim();
  const upperRaw = body.slice(comma + 1).trim();
  if (upperRaw.includes(',')) return `"${spec}" in "${whole}" has more than two bounds`;
  const lower = lowerRaw.length === 0 ? null : lowerRaw;
  const upper = upperRaw.length === 0 ? null : upperRaw;
  if (lower !== null && upper !== null && cmp(upper, lower) < 0) {
    return `"${spec}" in "${whole}": the upper bound is below the lower bound`;
  }
  return { lower, lowerInclusive, upper, upperInclusive };
}

/** VersionRange.createFromVersionSpec. Returns an error message instead of throwing. */
export function parseMavenSpec(input: string, cmp: Comparator): MavenSpec | string {
  const spec = input.trim();
  if (spec.length === 0 || spec === '*') return { kind: 'all' };
  const restrictions: Restriction[] = [];
  let rest = spec;
  let previousUpper: string | null = null;
  while (rest.startsWith('[') || rest.startsWith('(')) {
    const close1 = rest.indexOf(')');
    const close2 = rest.indexOf(']');
    let index = close2;
    if (close2 < 0 || (close1 >= 0 && close1 < close2)) index = close1;
    if (index < 0) return `"${spec}" is missing a closing ] or )`;
    const r = parseRestriction(rest.slice(0, index + 1), cmp, spec);
    if (typeof r === 'string') return r;
    if (previousUpper !== null && (r.lower === null || cmp(r.lower, previousUpper) < 0)) {
      return `"${spec}": the ranges overlap or are out of order`;
    }
    restrictions.push(r);
    previousUpper = r.upper;
    rest = rest.slice(index + 1).trim();
    if (rest.startsWith(',')) rest = rest.slice(1).trim();
  }
  if (rest.length > 0) {
    if (restrictions.length > 0) {
      return `"${spec}": after a range, only further ranges in [ ] or ( ) may follow (found "${rest}")`;
    }
    if (RANGE_CHARS.test(rest)) return `"${spec}" is not a valid version or range`;
    return { kind: 'soft', version: rest };
  }
  return { kind: 'set', restrictions };
}

export function restrictionContains(r: Restriction, version: string, cmp: Comparator): boolean {
  if (r.lower !== null) {
    const c = cmp(r.lower, version);
    if (c > 0 || (c === 0 && !r.lowerInclusive)) return false;
  }
  if (r.upper !== null) {
    const c = cmp(r.upper, version);
    if (c < 0 || (c === 0 && !r.upperInclusive)) return false;
  }
  return true;
}

export function describeRestriction(r: Restriction, cmp: Comparator): string {
  if (r.lower !== null && r.upper !== null && r.lowerInclusive && r.upperInclusive && cmp(r.lower, r.upper) === 0) {
    return `${r.lower} only`;
  }
  const parts: string[] = [];
  if (r.lower !== null) parts.push(`${r.lowerInclusive ? '≥' : '>'} ${r.lower}`);
  if (r.upper !== null) parts.push(`${r.upperInclusive ? '≤' : '<'} ${r.upper}`);
  return parts.length === 0 ? 'any version' : parts.join(' and ');
}
