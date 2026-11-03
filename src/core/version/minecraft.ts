/**
 * Minecraft version normalisation, mirroring fabric-loader's `McVersionLookup`
 * (`getRelease` + `normalizeVersion`), so that MC versions become semantic versions that
 * order correctly:
 *
 * | Input                | Canonical                 | Notes                                   |
 * |----------------------|---------------------------|-----------------------------------------|
 * | `1.20.1`             | `1.20.1`                  | releases are kept as written (no `.0`)  |
 * | `1.20.5-pre1`        | `1.20.5-beta.1`           | `rc.` instead of `beta.` for ≤ 1.16     |
 * | `1.21-rc1`           | `1.21-rc.1`               | 1.16 RCs are numbered on from 8 pre-releases |
 * | `23w51a`             | `1.20.5-alpha.23.51.a`    | target release from the snapshot table  |
 * | `26.1`, `26.1.2`     | `26.1`, `26.1.2`          | year-based releases                     |
 * | `26.4-snapshot-6`    | `26.4-alpha.6`            | year-based snapshot                     |
 * | `26.1-pre-2`         | `26.1-pre.2`              | year-based pre-release                  |
 * | `26.1-rc-1`          | `26.1-rc.1`               | year-based release candidate            |
 *
 * Pre-release identifiers sort `alpha < beta < pre < rc < (release)`, so
 * `26.3 < 26.4-alpha.6 < 26.4-pre.1 < 26.4-rc.1 < 26.4`, and
 * `1.20.4 < 1.20.5-alpha.23.51.a < 1.20.5-beta.1 < 1.20.5-rc.1 < 1.20.5`.
 *
 * Not covered (returns null): Beta/Alpha/Classic/Indev, experimental snapshots, April Fools
 * specials other than 26w14a, and snapshots outside the table.
 */

const DATE_BASED = /^(\d{2})\.(\d+)(?:\.(\d+))?(?:-(snapshot|pre|rc)-(\d+))?$/;
const RELEASE = /^1\.(\d+)(?:\.(\d+))?(?:-(\d+))?(?:[ _](unobfuscated))?$/;
const PRE_RELEASE = /^(1\.\d+(?:\.\d+)?)(?:-pre| pre-?release ?)(\d+)(?:-(\d+))?(?:[ _](unobfuscated))?$/;
const RELEASE_CANDIDATE = /^(1\.\d+(?:\.\d+)?)(?:-rc| rc| release candidate )(\d+)(?:-(\d+))?(?:[ _](unobfuscated))?$/;
const SNAPSHOT = /^(?:snapshot )?(\d+)w0?(0|[1-9]\d*)([a-z])(?:-(\d+)|[ _](unobfuscated))?$/;
/** Already-canonical output (makes normalisation idempotent). */
const CANONICAL =
  /^(?:1\.\d+(?:\.\d+)?|\d{2}\.\d+(?:\.\d+)?)(?:-(?:alpha|beta|pre|rc)(?:\.[0-9a-z]+)+)?(?:\+[0-9a-z.]+)?$/;

/**
 * Legacy `YYwWWx` snapshots → the release they lead up to, as `[fromYYWW, toYYWW, release]`
 * (inclusive, YYWW = year * 100 + week). Checked in order; copied from fabric-loader.
 */
const SNAPSHOT_TABLE: ReadonlyArray<readonly [number, number, string]> = [
  [2614, 2614, '26.1.1'], // 2026 April Fools snapshot
  [2541, 9999, '1.21.11'],
  [2531, 2537, '1.21.9'],
  [2515, 2521, '1.21.6'],
  [2502, 2510, '1.21.5'],
  [2444, 2499, '1.21.4'],
  [2433, 2440, '1.21.2'],
  [2418, 2421, '1.21'],
  [2351, 2414, '1.20.5'],
  [2340, 2346, '1.20.3'],
  [2331, 2335, '1.20.2'],
  [2312, 2318, '1.20'],
  [2300, 2307, '1.19.4'],
  [2242, 2299, '1.19.3'],
  [2224, 2224, '1.19.1'],
  [2211, 2219, '1.19'],
  [2203, 2207, '1.18.2'],
  [2137, 2144, '1.18'],
  [2045, 2120, '1.17'],
  [2027, 2030, '1.16.2'],
  [2006, 2022, '1.16'],
  [1934, 1999, '1.15'],
  [1843, 1914, '1.14'],
  [1830, 1833, '1.13.1'],
  [1743, 1822, '1.13'],
  [1731, 1731, '1.12.1'],
  [1706, 1718, '1.12'],
  [1650, 1650, '1.11.1'],
  [1632, 1644, '1.11'],
  [1620, 1621, '1.10'],
  [1614, 1615, '1.9.3'],
  [1531, 1607, '1.9'],
  [1402, 1434, '1.8'],
  [1347, 1349, '1.7.3'],
  [1336, 1343, '1.7'],
  [1316, 1326, '1.6'],
  [1311, 1312, '1.5.1'],
  [1301, 1310, '1.5'],
  [1249, 1250, '1.4.6'],
  [1232, 1242, '1.4'],
  [1215, 1230, '1.3'],
  [1203, 1208, '1.2'],
  [1147, 1201, '1.1'],
];

/** Target release of a legacy snapshot, e.g. (23, 51) → `1.20.5`. */
export function snapshotRelease(year: number, week: number): string | null {
  if (week > 99) return null;
  const key = year * 100 + week;
  for (const [from, to, release] of SNAPSHOT_TABLE) {
    if (key >= from && key <= to) return release;
  }
  return null;
}

function num(s: string): string {
  return String(Number(s));
}

function normalizeRelease(release: string): string {
  return release.split('.').map(num).join('.');
}

/** `<= 1.16` in Fabric terms (missing components are 0). */
function isLegacyPreRelease(release: string): boolean {
  const [, minor = 0, patch = 0] = release.split('.').map(Number);
  return minor < 16 || (minor === 16 && patch === 0);
}

function withBuild(base: string, ...builds: Array<string | undefined>): string {
  const b = builds.find((x) => x !== undefined && x.length > 0);
  return b === undefined ? base : `${base}+${b}`;
}

/**
 * Canonical (semver-compatible) form of a Minecraft version, or null if unrecognised.
 * Accepts launcher ids (`1.20.5-pre1`, `23w51a`, `26.4-snapshot-6`) and in-game names
 * (`1.20.5 Pre-Release 1`, `1.21 Release Candidate 1`).
 */
export function normalizeMinecraftVersion(input: string): string | null {
  const s = input.trim().toLowerCase();
  if (s.length === 0) return null;

  let m = DATE_BASED.exec(s);
  if (m) {
    const [, year = '', minor = '', patch, kind, n] = m;
    const release = normalizeRelease(patch === undefined ? `${year}.${minor}` : `${year}.${minor}.${patch}`);
    if (kind === undefined || n === undefined) return release;
    return `${release}-${kind === 'snapshot' ? 'alpha' : kind}.${num(n)}`;
  }

  m = RELEASE.exec(s);
  if (m) {
    const [, minor = '', patch, timestamp, unobf] = m;
    const release = patch === undefined ? `1.${num(minor)}` : `1.${num(minor)}.${num(patch)}`;
    return withBuild(release, timestamp, unobf);
  }

  m = PRE_RELEASE.exec(s);
  if (m) {
    const [, rel = '', n = '', timestamp, unobf] = m;
    const release = normalizeRelease(rel);
    const tag = isLegacyPreRelease(release) ? 'rc' : 'beta';
    return withBuild(`${release}-${tag}.${num(n)}`, timestamp, unobf);
  }

  m = RELEASE_CANDIDATE.exec(s);
  if (m) {
    const [, rel = '', n = '', timestamp, unobf] = m;
    const release = normalizeRelease(rel);
    // fabric-loader: 1.16's RCs continue the numbering of its 8 pre-releases (mapped to rc.1-8).
    const build = release === '1.16' ? 8 + Number(n) : Number(n);
    return withBuild(`${release}-rc.${build}`, timestamp, unobf);
  }

  m = SNAPSHOT.exec(s);
  if (m) {
    const [, year = '', week = '', letter = '', timestamp, unobf] = m;
    const release = snapshotRelease(Number(year), Number(week));
    if (release === null) return null;
    return withBuild(`${release}-alpha.${num(year)}.${num(week)}.${letter}`, timestamp, unobf);
  }

  if (CANONICAL.test(s)) return s;
  return null;
}
