/**
 * Per-input view shared by every check: the jar index plus the loader/side/nesting rules that
 * decide which metadata entries the game actually loads. Built once per `CheckInput` (cached).
 *
 * Vocabulary used by the checks:
 * - *active* jar: `isActive` (not disabled, readable, ancestors active).
 * - *relevant* entry: a `ModMeta` the pack's loader reads (`loaderAccepts`); all entries when the
 *   pack loader is unknown.
 * - *loaded* entry: relevant and not excluded by its environment for the pack side (Fabric/Quilt
 *   `environment: client` and Forge `clientSideOnly` mods are skipped on a dedicated server;
 *   Fabric `environment: server` mods are skipped on a client).
 * - *loaded* jar: active, has at least one loaded entry (or no metadata at all — a plain library),
 *   and its parent is loaded (the loader never opens jars nested in a mod it skipped).
 * - *effective* entries: what the loader keeps after de-duplicating nested copies:
 *   - every loaded entry of a loaded top-level jar;
 *   - for nested jars, one selected copy per JarJar `group:artifact` (Forge/NeoForge) or per mod
 *     id (Fabric/Quilt JiJ) — `selectNested` — and only entries whose mod id no top-level jar
 *     declares or provides (a top-level mod overrides a bundled copy).
 */
import type { JarRecord, ModEnvironment, ModMeta, Side } from '../../bindings';
import type { CheckInput, Evidence, JarIndex, PackContext } from '../model';
import { buildJarIndex, describePack, loaderAccepts, topLevelOf, versionSyntaxFor } from '../pack';
import { versionApi } from '../version';

export interface ModEntry {
  /** Jar that holds the metadata (nested jar for bundled mods). */
  jar: JarRecord;
  mod: ModMeta;
  /** Top-level ancestor: what the user sees, disables and replaces. */
  top: JarRecord;
}

export interface CheckContext {
  readonly input: CheckInput;
  readonly pack: PackContext;
  readonly index: JarIndex;
  /** Every scanned jar (incl. disabled), by id. */
  readonly all: ReadonlyMap<string, JarRecord>;
  /** Active top-level jars, sorted by id. */
  readonly topLevel: readonly JarRecord[];
  /** Loaded jars at any depth, top-level first, then by id. */
  readonly loadedJars: readonly JarRecord[];
  /** Loaded top-level jars, sorted by id. */
  readonly loadedTopLevel: readonly JarRecord[];
  readonly effective: readonly ModEntry[];
  relevant(jar: JarRecord): ModMeta[];
  loaded(jar: JarRecord): ModMeta[];
  isLoaded(jar: JarRecord): boolean;
  topOf(jar: JarRecord): JarRecord;
  /** Loaded entries (any depth) whose mod id or `provides` is `modId`. Presence check. */
  providers(modId: string): readonly ModEntry[];
  /**
   * Entries whose version the loader would actually use for `modId`: top-level providers when
   * any exist; otherwise nested ones — only the selected copy for JarJar libraries (FML keeps one
   * per `group:artifact`), every copy for Fabric/Quilt JiJ (the resolver may pick any of them).
   */
  versionProviders(modId: string): readonly ModEntry[];
  /** `note` evidence describing the pack identity and where it came from. */
  readonly packNote: Evidence;
}

export function sideAccepts(env: ModEnvironment, side: Side): boolean {
  if (env === 'client') return side === 'client';
  if (env === 'server') return side === 'server';
  return true;
}

function byId(a: JarRecord, b: JarRecord): number {
  return a.depth - b.depth || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/** Version of a nested copy used for JarJar selection. */
function copyVersion(jar: JarRecord): string {
  return jar.jarjar?.version ?? jar.mods[0]?.version ?? '';
}

/**
 * Pick the copy the loader keeps from several nested copies of one library.
 * JarJar: the highest version inside every copy's declared range; when no copy satisfies all
 * ranges, the highest version (FML then reports the conflict itself). JiJ: the highest version.
 * Ties → smallest jar id.
 */
export function selectNested(copies: readonly JarRecord[]): JarRecord | undefined {
  if (copies.length <= 1) return copies[0];
  const jarjar = copies.every((c) => c.jarjar !== null);
  const syntax = jarjar ? 'maven' : versionSyntaxFor(copies[0]?.mods[0]?.loader ?? 'fabric');
  const newest = (list: readonly JarRecord[]): JarRecord | undefined =>
    [...list].sort((a, b) => versionApi.compare(copyVersion(b), copyVersion(a), syntax, 'other') || byId(a, b))[0];
  if (!jarjar) return newest(copies);
  const ranges = copies.flatMap((c) => (c.jarjar?.range ? [c.jarjar.range] : []));
  const ok = copies.filter((c) =>
    ranges.every((r) => versionApi.satisfies(copyVersion(c), { syntax: 'maven', raw: [r], unrepresentable: null }, 'other') !== false),
  );
  return newest(ok.length > 0 ? ok : copies);
}

const cache = new WeakMap<CheckInput, CheckContext>();

export function contextFor(input: CheckInput): CheckContext {
  const hit = cache.get(input);
  if (hit) return hit;
  const ctx = build(input);
  cache.set(input, ctx);
  return ctx;
}

function build(input: CheckInput): CheckContext {
  const { pack, scan } = input;
  const index = buildJarIndex(scan);
  const all = new Map(scan.jars.map((j) => [j.id, j] as const));
  const sorted = [...scan.jars].sort(byId);
  const active = sorted.filter((j) => index.byId.has(j.id));

  const packKind = pack.loader?.kind ?? 'unknown';
  const relevantMemo = new Map<string, ModMeta[]>();
  const relevant = (jar: JarRecord): ModMeta[] => {
    let r = relevantMemo.get(jar.id);
    if (!r) {
      r = jar.mods.filter((m) => loaderAccepts(packKind, pack.mcVersion, m));
      relevantMemo.set(jar.id, r);
    }
    return r;
  };
  const loaded = (jar: JarRecord): ModMeta[] => relevant(jar).filter((m) => sideAccepts(m.environment, pack.side));
  const activeIds = new Set(active.map((j) => j.id));
  const loadedMemo = new Map<string, boolean>();
  const isLoaded = (jar: JarRecord): boolean => {
    const memo = loadedMemo.get(jar.id);
    if (memo !== undefined) return memo;
    loadedMemo.set(jar.id, false); // cycle guard
    let ok = activeIds.has(jar.id) && (jar.mods.length === 0 || loaded(jar).length > 0);
    if (ok && jar.parentId !== null) {
      const parent = all.get(jar.parentId);
      ok = parent !== undefined && isLoaded(parent);
    }
    loadedMemo.set(jar.id, ok);
    return ok;
  };
  const topOf = (jar: JarRecord): JarRecord => topLevelOf(jar, all);

  const loadedJars = active.filter(isLoaded);
  const topLevel = active.filter((j) => j.depth === 0);
  const loadedTopLevel = loadedJars.filter((j) => j.depth === 0);

  // Presence map: every loaded entry by mod id and provides.
  const providerMap = new Map<string, ModEntry[]>();
  for (const jar of loadedJars) {
    const top = topOf(jar);
    for (const mod of loaded(jar)) {
      const entry: ModEntry = { jar, mod, top };
      for (const id of new Set([mod.modId, ...mod.provides])) {
        const list = providerMap.get(id) ?? [];
        list.push(entry);
        providerMap.set(id, list);
      }
    }
  }

  // Nested de-duplication.
  const topIds = new Set<string>();
  for (const jar of loadedTopLevel) for (const m of loaded(jar)) [m.modId, ...m.provides].forEach((id) => topIds.add(id));
  const groups = new Map<string, JarRecord[]>();
  for (const jar of loadedJars) {
    if (jar.depth === 0) continue;
    const first = loaded(jar)[0];
    const key = jar.jarjar ? `jarjar:${jar.jarjar.group}:${jar.jarjar.artifact}` : first ? `mod:${first.modId}` : `jar:${jar.id}`;
    const list = groups.get(key) ?? [];
    list.push(jar);
    groups.set(key, list);
  }
  const selected = new Set<string>();
  for (const copies of groups.values()) {
    const pick = selectNested(copies);
    if (pick) selected.add(pick.id);
  }

  const effective: ModEntry[] = [];
  for (const jar of loadedJars) {
    if (jar.depth > 0 && !selected.has(jar.id)) continue;
    const top = topOf(jar);
    for (const mod of loaded(jar)) {
      if (jar.depth > 0 && topIds.has(mod.modId)) continue;
      effective.push({ jar, mod, top });
    }
  }

  const providers = (modId: string): readonly ModEntry[] => providerMap.get(modId) ?? [];
  const versionProviders = (modId: string): readonly ModEntry[] => {
    const list = providers(modId);
    const tops = list.filter((e) => e.jar.depth === 0);
    if (tops.length > 0) return tops;
    return list.filter((e) => e.jar.jarjar === null || selected.has(e.jar.id));
  };

  return {
    input,
    pack,
    index,
    all,
    topLevel,
    loadedJars,
    loadedTopLevel,
    effective,
    relevant,
    loaded,
    isLoaded,
    topOf,
    providers,
    versionProviders,
    packNote: { kind: 'note', text: describePack(pack) },
  };
}
