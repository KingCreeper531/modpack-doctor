/**
 * Rules-core contract types. FROZEN (M1) — see docs/CONTRACTS.md.
 *
 * `src/core` is pure: no DOM, no Tauri runtime. It may only `import type` from
 * `../bindings` (enforced by src/core/__tests__/purity.test.ts).
 */
import type {
  FixAction,
  Instance,
  JarRecord,
  LoaderInfo,
  LogDigest,
  MrProject,
  MrVersion,
  RawRange,
  ScanResult,
  Side,
  WatchAnchor,
} from '../bindings';

export type Severity = 'error' | 'warning' | 'info';

/** Frozen list. Prefix: E/W/I = static severity default, C = crash/log-derived. */
export const FINDING_CODES = [
  'E-WRONG-LOADER',
  'E-MC-RANGE',
  'E-LOADER-RANGE',
  'E-DEP-RANGE',
  'E-MISSING-DEP',
  'E-DUP-ID',
  'E-SPLIT-PKG',
  'I-SPLIT-PKG',
  'E-INCOMPAT',
  'W-CLIENT-ON-SERVER',
  'W-CORRUPT-JAR',
  'I-NOT-ON-MODRINTH',
  'W-JAVA-CLASS',
  'C-MIXIN',
  'C-RESOLUTION',
  'C-MISSING-MANDATORY',
  'C-FABRIC-INCOMPAT',
  'C-NOCLASSDEF',
  'C-OOM',
  'C-JAVA-VERSION',
  'C-SUSPECTED',
  /** Fallback: innermost `Caused by:` when no specific pattern matched. */
  'C-ROOT-CAUSE',
  /** hs_err native crash (problematic frame in a driver/native library). */
  'C-NATIVE',
] as const;
export type FindingCode = (typeof FINDING_CODES)[number];

export interface JarRef {
  jarId: string;
  fileName: string;
  modId?: string;
}

export interface LogLine {
  /** 1-based line number in the original file. */
  n: number;
  text: string;
  role: 'culprit' | 'context';
}

export interface FrameRef {
  /** Line number (n) of the stack frame. */
  line: number;
  jarId: string;
}

export type Evidence =
  | {
      kind: 'metadata';
      jarId: string;
      /** File inside the jar, e.g. `fabric.mod.json`. */
      file: string;
      excerpt: string;
      /** 1-based line numbers within `excerpt` to highlight. */
      highlight: number[];
    }
  | {
      kind: 'log';
      /** LogSource id (path relative to game dir). */
      source: string;
      lines: LogLine[];
      frames: FrameRef[];
    }
  | {
      kind: 'note';
      /** Plain fact, e.g. "Pack: Forge 47.3.0 (from launcher metadata)". */
      text: string;
    };

export interface Finding {
  /** Stable across rescans: hash of code + sorted culprit jar ids + discriminator. */
  id: string;
  code: FindingCode;
  severity: Severity;
  /** One-line diagnosis (triage row). */
  title: string;
  /** Plain-English explanation (expanded row), ≤ ~600 chars. */
  explanation: string;
  culprits: JarRef[];
  evidence: Evidence[];
  /** Ordered: first = recommended. May be empty. */
  fixes: FixAction[];
  /**
   * Mod ids that are required but absent (E-MISSING-DEP, C-MISSING-MANDATORY), so
   * `src/core/modrinth` can offer `installDependency` without parsing text. Absent elsewhere.
   */
  missingModIds?: string[];
}

/** Effective pack identity (check 1). */
export interface PackContext {
  mcVersion: string | null;
  loader: LoaderInfo | null;
  side: Side;
  source: 'override' | 'launcher' | 'mrpack' | 'majority' | 'unknown';
}

/** Optional Modrinth enrichment; checks must work when absent (offline). */
export interface ModrinthContext {
  /** sha1 → identified version. */
  versions: Record<string, MrVersion>;
  /** project id → project. */
  projects: Record<string, MrProject>;
  /** sha1 → newest compatible version for the pack (may equal current). */
  updates: Record<string, MrVersion>;
  /** sha1s whose lookup failed (unknown, not "missing"). */
  failed: string[];
  offline: boolean;
}

export interface CheckInput {
  instance: Instance;
  scan: ScanResult;
  pack: PackContext;
  modrinth?: ModrinthContext;
}

export interface Check {
  /** e.g. 'split-packages' */
  id: string;
  codes: readonly FindingCode[];
  run(input: CheckInput): Finding[];
}

/**
 * Lookup tables built once per scan (src/core/pack/index.ts). Active (non-disabled) jars only,
 * except `byFileName`, which also lists disabled top-level jars under their `.disabled` name
 * (the UI and crash frames look jars up by file name regardless of state). A nested jar is
 * active when its top-level ancestor is.
 *
 * Nested-jar de-duplication: the loader keeps one copy per JarJar `group:artifact`
 * (Forge/NeoForge) or per mod id (Fabric/Quilt JiJ). Checks must not report two parents that
 * nest the same library as E-DUP-ID or E-SPLIT-PKG.
 */
export interface JarIndex {
  byId: ReadonlyMap<string, JarRecord>;
  /** mod id and `provides` ids → jars (top-level and nested). */
  byModId: ReadonlyMap<string, readonly JarRecord[]>;
  /** package → top-level jars whose *own* classes contain it (nested jars excluded). */
  byPackage: ReadonlyMap<string, readonly JarRecord[]>;
  /** package → every jar (any depth) whose own classes contain it; for crash frame mapping. */
  byPackageAnyDepth: ReadonlyMap<string, readonly JarRecord[]>;
  /** mixin config file name → jars (several when a config is duplicated). */
  byMixinConfig: ReadonlyMap<string, readonly JarRecord[]>;
  /** top-level file name → jar, active AND disabled (keyed by the real name incl. `.disabled`). */
  byFileName: ReadonlyMap<string, JarRecord>;
}

export interface CrashInput {
  digest: LogDigest;
  /** Present when the instance has been scanned; enables jar mapping. */
  index?: JarIndex;
  pack?: PackContext;
}

/**
 * A literal, case-sensitive substring with its watch-mode tier (`WatchAnchor` in bindings).
 * - `fatal`: the game cannot continue (crash report header, ResolutionException, missing
 *   mandatory dependencies, incompatible mod set, mod loading failed / loading error screen,
 *   hs_err header). Watch mode notifies promptly.
 * - `contextual`: healthy games log these too (`Caused by`, mixin warnings, NoClassDefFound…).
 *   Recorded silently; analysed only if the game process exits within the context window or a
 *   crash file appears.
 * The digest prefilter (`read_log_digest`) uses every anchor's `text` regardless of tier.
 */
export type CrashAnchor = WatchAnchor;

export interface CrashPattern {
  id: string;
  codes: readonly FindingCode[];
  /** Every anchor this pattern needs kept by the digest, each marked with its watch tier. */
  anchors: readonly CrashAnchor[];
  match(input: CrashInput): Finding[];
}

/**
 * What a version string denotes. With Fabric syntax, `minecraft` enables MC-aware normalisation
 * of the tested version (as fabric-loader does: `23w51a`, `1.20.5-pre1`, `1.21-rc1`, year-based
 * `26.1`, `26.4-snapshot-6`). Maven syntax ignores the subject and compares raw strings with
 * ComparableVersion, exactly as FML does (CONTRACTS invariant 4). `normalizeMinecraft` always
 * normalises.
 */
export type VersionSubject = 'minecraft' | 'other';

/** Version range API implemented by src/core/version (agent C). */
export type RangeParse =
  | { ok: true; matches(version: string): boolean; describe(): string }
  | { ok: false; error: string };

export interface VersionApi {
  parseRange(range: RawRange, subject: VersionSubject): RangeParse;
  /** null when the range or version cannot be parsed (caller reports, never guesses). */
  satisfies(version: string, range: RawRange, subject: VersionSubject): boolean | null;
  /** Negative / 0 / positive. `syntax` picks Maven ComparableVersion vs Fabric semver ordering. */
  compare(a: string, b: string, syntax: RawRange['syntax'], subject: VersionSubject): number;
  /** Canonical MC version for display/comparison, or null if unrecognised. */
  normalizeMinecraft(version: string): string | null;
}
