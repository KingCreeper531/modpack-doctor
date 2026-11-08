/**
 * Unfilled build placeholders in declared version ranges (`[${create_version},)`).
 *
 * Mods are built with Gradle `processResources` filling `${…}` tokens in `mods.toml` /
 * `fabric.mod.json`. A jar published without that step keeps the literal token. It is not a real
 * requirement and must never be shown as one. What the loaders actually do with it — and so what
 * `satisfies` already returns, since `./maven.ts` and `./fabric.ts` mirror them — is:
 *
 * - **FML (Forge 1.20.1 and NeoForge FancyModLoader)**: `versionRange` is read as is (no
 *   `StringSubstitutor`; that only runs on the mod's own `version`) and parsed by
 *   `MavenVersionAdapter.createFromVersionSpec` → Maven 3.8.5 `VersionRange`. A bound such as
 *   `${create_version}` becomes `ComparableVersion` with a single string item. String items sort
 *   below number items (`StringItem.compareTo(IntItem) == -1`), and an unknown qualifier sorts
 *   lexically after `7-`, where `$` (0x24) is below every digit and letter. So a *lower* bound
 *   that starts with `${` is below every real version (`[${x},)` accepts everything); an *upper*
 *   bound that starts with `${` is below every real version too (`(,${x})` accepts nothing, and
 *   `[1.0,${x})` is "Range defies version ordering": FML throws and the mod file fails to load).
 *   A bare `${x}` is a Maven soft requirement: everything matches.
 * - **Fabric / Quilt** (fabric-loader `VersionPredicateParser`): `${x}` is not a semantic version,
 *   so `>=${x}`, `<=${x}` and `${x}` become equality with the literal string `${x}` (no real
 *   version matches) and `>${x}` / `<${x}` fail to parse.
 *
 * `describePlaceholderRange` puts that into words for every check (`describeRange` in
 * `../checks/evidence.ts` calls it first). Pure.
 */
import type { RawRange } from '../../bindings';
import type { VersionSubject } from '../model';
import { compareMavenItems, describeRestriction, parseMaven, parseMavenSpec, type Restriction } from './maven';
import { parseRange } from './index';

const TOKEN = /\$\{[^}]*\}?/g;
const HAS_TOKEN = /\$\{/;

/** The `${…}` tokens of a range (unique, in order). Empty when there are none. */
export function rangePlaceholders(range: RawRange): string[] {
  const out: string[] = [];
  const texts = [...(Array.isArray(range.raw) ? range.raw : []), ...(range.unrepresentable ? [range.unrepresentable] : [])];
  for (const text of texts) {
    if (typeof text !== 'string') continue;
    for (const m of text.matchAll(TOKEN)) if (!out.includes(m[0])) out.push(m[0]);
  }
  return out;
}

/** True when the range text contains an unfilled `${…}` build placeholder. */
export function hasPlaceholder(range: RawRange): boolean {
  return rangePlaceholders(range).length > 0;
}

function note(tokens: readonly string[]): string {
  const list = tokens.map((t) => `\`${t}\``).join(', ');
  return tokens.length === 1
    ? `the mod's metadata has an unfilled placeholder: ${list}`
    : `the mod's metadata has unfilled placeholders: ${list}`;
}

const cmp = (a: string, b: string): number => compareMavenItems(parseMaven(a), parseMaven(b));

/** A bound that sorts below every real version in FML (starts with the placeholder). */
function placeholderBound(bound: string | null): boolean {
  return bound !== null && bound.trimStart().startsWith('${');
}

/**
 * The restrictions with placeholder bounds resolved the way FML orders them: a placeholder lower
 * bound is no bound at all; a placeholder upper bound admits no real version.
 */
function effectiveRestrictions(restrictions: readonly Restriction[]): Restriction[] {
  const out: Restriction[] = [];
  for (const r of restrictions) {
    if (placeholderBound(r.upper)) continue;
    out.push(placeholderBound(r.lower) ? { ...r, lower: null, lowerInclusive: false } : r);
  }
  return out;
}

function describeMaven(range: RawRange, tokens: readonly string[]): string {
  const restrictions: Restriction[] = [];
  for (const entry of range.raw) {
    const spec = parseMavenSpec(entry, cmp);
    if (typeof spec === 'string') return `a range the loader can't read (${note(tokens)})`;
    if (spec.kind === 'all' || spec.kind === 'soft') return `any version (${note(tokens)})`;
    restrictions.push(...spec.restrictions);
  }
  const effective = effectiveRestrictions(restrictions);
  if (effective.length === 0) return `no real version (${note(tokens)})`;
  if (effective.some((r) => r.lower === null && r.upper === null)) return `any version (${note(tokens)})`;
  return `${effective.map((r) => describeRestriction(r, cmp)).join(' or ')} (${note(tokens)})`;
}

function describeFabric(range: RawRange, subject: VersionSubject, tokens: readonly string[]): string {
  // Every OR group that holds a placeholder predicate matches no real version (or fails to parse).
  const clean = range.raw.filter((entry) => !HAS_TOKEN.test(entry));
  if (clean.length === 0) return `no real version (${note(tokens)})`;
  const parsed = parseRange({ ...range, raw: clean }, subject);
  return parsed.ok ? `${parsed.describe()} (${note(tokens)})` : `a range the loader can't read (${note(tokens)})`;
}

/**
 * Words for a range that contains an unfilled `${…}` placeholder, or null when it has none:
 * `[${create_version},)` → "any version (the mod's metadata has an unfilled placeholder:
 * `${create_version}`)". The wording follows what the loader does (see the module comment).
 */
export function describePlaceholderRange(range: RawRange, subject: VersionSubject = 'other'): string | null {
  try {
    const tokens = rangePlaceholders(range);
    if (tokens.length === 0) return null;
    if (range.unrepresentable) return `a range too complex to evaluate (${note(tokens)})`;
    if (range.syntax === 'maven') return describeMaven(range, tokens);
    if (range.syntax === 'fabric') return describeFabric(range, subject, tokens);
    return null;
  } catch {
    return null;
  }
}
