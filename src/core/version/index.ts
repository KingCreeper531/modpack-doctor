/**
 * Version range API (agent C). Implements `VersionApi` from ../model.
 *
 * Syntaxes (see `RawRange` in src-tauri/src/model/scan.rs):
 * - `maven`: Forge/NeoForge `versionRange`. Maven 3 `VersionRange` + `ComparableVersion`
 *   (./maven.ts). A bare version such as `47.1.0` is a Maven *soft requirement*: FML builds
 *   `VersionRange.createFromVersionSpec("47.1.0")`, whose only restriction is "everything", so it
 *   matches every version. `raw` should hold one entry; several entries are OR-ed defensively.
 * - `fabric`: Fabric/Quilt predicates (./fabric.ts). `raw` entries are OR-ed; space-separated
 *   predicates inside one entry are AND-ed.
 * - Empty `raw`, an empty entry or a `*` entry means "any version". `unrepresentable` set →
 *   `{ ok: false }` (the range could not be flattened, so it cannot be evaluated).
 *
 * Subject `minecraft`: the version being tested is first normalised with
 * `normalizeMinecraft` (fabric-loader `McVersionLookup` rules, ./minecraft.ts).
 * - Maven: bounds are normalised too and MC versions are ordered as semantic versions, so
 *   `1.20.5-pre1` (→ `1.20.5-beta.1`) sorts before `1.20.5` and `[1.20,1.21)` behaves as expected.
 *   (Plain Maven ordering would put the unknown qualifier `pre1` *after* the release.)
 * - Fabric: predicate versions are used as written, exactly as fabric-loader does (it only
 *   normalises the game version). So `>=1.20.5-pre1` does NOT match game `1.20.5-pre1` there either
 *   (`beta.1` < `pre1`); reporting that matches what the loader will do.
 * - A tested MC version that does not normalise makes `satisfies` return null.
 *
 * The public functions never throw. Parsed ranges and versions are memoised.
 */
import type { RawRange } from '../../bindings';
import type { RangeParse, VersionApi, VersionSubject } from '../model';
import {
  compareFabricVersions,
  compareSemVer,
  describePredicate,
  parseFabricVersion,
  parsePredicateGroup,
  parseSemVer,
  testPredicate,
  type FabricPredicate,
  type FabricVersion,
  type SemVer,
} from './fabric';
import {
  compareMavenItems,
  describeRestriction,
  parseMaven,
  parseMavenSpec,
  restrictionContains,
  type Comparator,
  type MavenItem,
  type MavenSpec,
} from './maven';
import { normalizeMinecraftVersion } from './minecraft';

type Syntax = RawRange['syntax'];

const CACHE_LIMIT = 4096;

/** Map-backed memo that resets when it grows past CACHE_LIMIT. */
function memo<V>(fn: (key: string) => V): (key: string) => V {
  const cache = new Map<string, V>();
  return (key: string): V => {
    const hit = cache.get(key);
    if (hit !== undefined || cache.has(key)) return hit as V;
    const value = fn(key);
    if (cache.size >= CACHE_LIMIT) cache.clear();
    cache.set(key, value);
    return value;
  };
}

const mavenOf = memo<MavenItem>(parseMaven);
const fabricOf = memo<FabricVersion | null>((s) => parseFabricVersion(s, false));
const mcOf = memo<string | null>(normalizeMinecraftVersion);
const mcSemverOf = memo<SemVer | null>((s) => {
  const n = mcOf(s);
  if (n === null) return null;
  const v = parseSemVer(n, false);
  return typeof v === 'string' ? null : v;
});

function sign(n: number): number {
  return n < 0 ? -1 : n > 0 ? 1 : 0;
}

function lex(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareMaven(a: string, b: string): number {
  return compareMavenItems(mavenOf(a), mavenOf(b));
}

function compareFabric(a: string, b: string): number {
  const x = fabricOf(a);
  const y = fabricOf(b);
  if (x === null || y === null) return lex(a, b);
  return compareFabricVersions(x, y);
}

/** MC-aware ordering: normalise, compare as semver; fall back to the syntax's own ordering. */
function compareMinecraft(a: string, b: string, syntax: Syntax): number {
  const x = mcSemverOf(a);
  const y = mcSemverOf(b);
  if (x !== null && y !== null) return compareSemVer(x, y);
  const na = mcOf(a) ?? a;
  const nb = mcOf(b) ?? b;
  return syntax === 'maven' ? compareMaven(na, nb) : compareFabric(na, nb);
}

function comparatorFor(syntax: Syntax, subject: VersionSubject): Comparator {
  if (subject === 'minecraft') return (a, b) => compareMinecraft(a, b, syntax);
  return syntax === 'maven' ? compareMaven : compareFabric;
}

/** Whether `version` can be evaluated at all (non-empty, and a known MC version for MC). */
function versionUsable(version: string, subject: VersionSubject): boolean {
  if (version.length === 0) return false;
  return subject !== 'minecraft' || mcOf(version) !== null;
}

interface Compiled {
  readonly matchesAll: boolean;
  readonly subject: VersionSubject;
  /** Assumes a usable (trimmed) version. */
  test(version: string): boolean;
  describe(): string;
}

function all(subject: VersionSubject, text = 'any version'): Compiled {
  return { matchesAll: true, subject, test: () => true, describe: () => text };
}

function compileMaven(raw: readonly string[], subject: VersionSubject): Compiled | string {
  const cmp = comparatorFor('maven', subject);
  const specs: MavenSpec[] = [];
  for (const entry of raw) {
    const spec = parseMavenSpec(entry, cmp);
    if (typeof spec === 'string') return spec;
    if (spec.kind === 'all') return all(subject);
    specs.push(spec);
  }
  if (specs.length === 0) return all(subject);
  const soft = specs.flatMap((s) => (s.kind === 'soft' ? [s.version] : []));
  // A soft requirement matches everything, and so does an OR that contains one.
  if (soft.length > 0) return all(subject, `any version (recommends ${soft.join(', ')})`);
  const restrictions = specs.flatMap((s) => (s.kind === 'set' ? s.restrictions : []));
  const text = restrictions.length === 0 ? 'no version' : restrictions.map((r) => describeRestriction(r, cmp)).join(' or ');
  return {
    matchesAll: false,
    subject,
    test: (version) => restrictions.some((r) => restrictionContains(r, version, cmp)),
    describe: () => text,
  };
}

function compileFabric(raw: readonly string[], subject: VersionSubject): Compiled | string {
  const groups: FabricPredicate[][] = [];
  for (const entry of raw) {
    const group = parsePredicateGroup(entry);
    if (typeof group === 'string') return `Invalid Fabric version predicate "${entry}": ${group}`;
    if (group.length === 0) return all(subject);
    groups.push(group);
  }
  if (groups.length === 0) return all(subject);
  const toVersion = (version: string): FabricVersion | null =>
    fabricOf(subject === 'minecraft' ? (mcOf(version) ?? version) : version);
  const text = groups.map((g) => g.map(describePredicate).join(' and ')).join(' or ');
  return {
    matchesAll: false,
    subject,
    test: (version) => {
      const v = toVersion(version);
      return v !== null && groups.some((g) => g.every((p) => testPredicate(p, v)));
    },
    describe: () => text,
  };
}

function compile(range: RawRange, subject: VersionSubject): Compiled | string {
  if (typeof range !== 'object' || range === null) return 'Version range is missing.';
  if (range.unrepresentable !== null && range.unrepresentable !== undefined) {
    return `Version range is too complex to evaluate: ${range.unrepresentable}`;
  }
  if (!Array.isArray(range.raw) || range.raw.some((r) => typeof r !== 'string')) {
    return 'Version range is not a list of strings.';
  }
  if (range.syntax === 'maven') {
    const c = compileMaven(range.raw, subject);
    return typeof c === 'string' ? `Invalid Maven version range: ${c}` : c;
  }
  if (range.syntax === 'fabric') return compileFabric(range.raw, subject);
  return `Unknown version range syntax "${String(range.syntax)}".`;
}

function toParse(c: Compiled | string): RangeParse {
  if (typeof c === 'string') return { ok: false, error: c };
  return {
    ok: true,
    matches: (version: string): boolean => {
      try {
        if (c.matchesAll) return true;
        if (typeof version !== 'string') return false;
        const v = version.trim();
        return versionUsable(v, c.subject) && c.test(v);
      } catch {
        return false;
      }
    },
    describe: () => c.describe(),
  };
}

const rangeCache = new Map<string, { parse: RangeParse; compiled: Compiled | null }>();

function cached(range: RawRange, subject: VersionSubject): { parse: RangeParse; compiled: Compiled | null } {
  let key: string;
  try {
    key = JSON.stringify([range.syntax, subject, range.raw, range.unrepresentable]);
  } catch {
    return { parse: { ok: false, error: 'Version range could not be read.' }, compiled: null };
  }
  const hit = rangeCache.get(key);
  if (hit) return hit;
  let compiled: Compiled | string;
  try {
    compiled = compile(range, subject);
  } catch (e) {
    compiled = `Version range could not be parsed (${e instanceof Error ? e.message : 'unexpected error'}).`;
  }
  const entry = { parse: toParse(compiled), compiled: typeof compiled === 'string' ? null : compiled };
  if (rangeCache.size >= CACHE_LIMIT) rangeCache.clear();
  rangeCache.set(key, entry);
  return entry;
}

export function parseRange(range: RawRange, subject: VersionSubject): RangeParse {
  return cached(range, subject).parse;
}

export function satisfies(version: string, range: RawRange, subject: VersionSubject): boolean | null {
  try {
    const { compiled } = cached(range, subject);
    if (compiled === null) return null;
    if (compiled.matchesAll) return true;
    if (typeof version !== 'string') return null;
    const v = version.trim();
    if (!versionUsable(v, subject)) return null;
    return compiled.test(v);
  } catch {
    return null;
  }
}

export function compare(a: string, b: string, syntax: Syntax, subject: VersionSubject): number {
  try {
    const x = a.trim();
    const y = b.trim();
    if (subject === 'minecraft') return sign(compareMinecraft(x, y, syntax));
    return sign(syntax === 'maven' ? compareMaven(x, y) : compareFabric(x, y));
  } catch {
    return a < b ? -1 : a > b ? 1 : 0;
  }
}

export function normalizeMinecraft(version: string): string | null {
  try {
    return typeof version === 'string' ? mcOf(version.trim()) : null;
  } catch {
    return null;
  }
}

export const versionApi: VersionApi = { parseRange, satisfies, compare, normalizeMinecraft };
