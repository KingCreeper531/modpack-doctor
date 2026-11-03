/**
 * Class-file major version → Java release (docs/research/crash-formats.md §3.9), and the minimum
 * Java a Minecraft version needs.
 */

const OLD_MAJORS: Readonly<Record<number, string>> = { 45: '1.1', 46: '1.2', 47: '1.3', 48: '1.4' };

/** Java release label for a class-file major version (45 → "1.1", 52 → "8", 65 → "21"); null below 45. */
export function javaForClassMajor(major: number): string | null {
  if (!Number.isInteger(major) || major < 45) return null;
  return OLD_MAJORS[major] ?? String(major - 44);
}

/** Java feature number for comparisons (45–48 → 1, 52 → 8, 69 → 25); null below 45. */
export function javaFeatureForClassMajor(major: number): number | null {
  if (!Number.isInteger(major) || major < 45) return null;
  return major < 49 ? 1 : major - 44;
}

/** Class-file major version produced by a Java feature release (8 → 52, 21 → 65). */
export function classMajorForJava(feature: number): number {
  return feature + 44;
}

/**
 * Minimum Java feature release for a Minecraft version, or null when the version is not
 * recognised. Handles legacy `1.x.y` (incl. `-preN`/`-rcN`), weekly snapshots `YYwWWa` and
 * year-based releases (`26.1`, `26.1.2`, `26.4-snapshot-6`).
 */
export function minJavaForMinecraft(mc: string): number | null {
  const v = mc.trim();
  const legacy = /^1\.(\d+)(?:\.(\d+))?(?:[-_ ].*)?$/.exec(v);
  if (legacy) {
    const minor = Number(legacy[1]);
    const patch = Number(legacy[2] ?? '0');
    if (minor <= 16) return 8;
    if (minor === 17) return 16;
    if (minor <= 19) return 17;
    if (minor === 20) return patch >= 5 ? 21 : 17;
    return 21;
  }
  const snapshot = /^(\d{2})w(\d{2})[a-z]$/.exec(v);
  if (snapshot) {
    const year = Number(snapshot[1]);
    const week = Number(snapshot[2]);
    if (year < 21 || (year === 21 && week < 19)) return 8;
    if (year === 21 && week < 37) return 16;
    if (year < 24 || (year === 24 && week < 14)) return 17;
    return year >= 26 ? 25 : 21;
  }
  const yearBased = /^(\d{2})\.\d+(?:\.\d+)?(?:-.*)?$/.exec(v);
  if (yearBased && Number(yearBased[1]) >= 26) return 25;
  return null;
}
