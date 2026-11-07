/**
 * Realistic JarRecord builders for check tests. Metadata excerpts are generated in the real file
 * formats (mods.toml, neoforge.mods.toml, fabric.mod.json, quilt.mod.json, mcmod.info) so the
 * evidence line highlighting is exercised too.
 */
import type {
  Dependency,
  DependencyKind,
  Instance,
  JarRecord,
  JarStatus,
  LoaderKind,
  ModEnvironment,
  ModMeta,
  MrProject,
  MrVersion,
  RawRange,
  ScanResult,
  Side,
} from '../../../bindings';
import { fnv1a32 } from '../../crash/id';
import type { CheckInput, Finding, FindingCode, ModrinthContext, PackContext } from '../../model';
import { runChecks } from '../index';

export interface DepSpec {
  id: string;
  kind?: DependencyKind;
  range?: string | string[];
  side?: string;
}

export interface ModSpec {
  id: string;
  version?: string;
  name?: string;
  loader?: LoaderKind;
  /** Range of the `minecraft` dependency (Maven string for Forge-family, Fabric string/array). */
  mc?: string | string[];
  /** Range of the loader dependency (forge / neoforge / fabricloader / quilt_loader). */
  loaderDep?: string | string[];
  /** Forge `side` of the `minecraft` / loader dependency ("CLIENT", "SERVER", "BOTH"). */
  mcSide?: string;
  loaderSide?: string;
  deps?: DepSpec[];
  provides?: string[];
  env?: ModEnvironment;
  /** Forge-family only: `META-INF/mods.toml` instead of `neoforge.mods.toml` for NeoForge. */
  modsToml?: boolean;
}

export interface JarSpec {
  file: string;
  mods?: ModSpec[];
  packages?: string[];
  disabled?: boolean;
  status?: JarStatus;
  /** Metadata files that failed to parse (the jar stays `ok` when another file parsed). */
  metadataErrors?: { file: string; reason: string }[];
  jarjar?: { group: string; artifact: string; range?: string; version?: string };
  sha1?: string;
  maxClassMajor?: number | null;
  mtimeMs?: number;
  moduleName?: string;
  /** Override the generated metadata excerpt for every mod. */
  excerpt?: string;
}

const LOADER_DEP: Record<LoaderKind, string | null> = {
  forge: 'forge',
  neoforge: 'neoforge',
  fabric: 'fabricloader',
  quilt: 'quilt_loader',
  legacyforge: null,
  unknown: null,
};

function syntaxOf(loader: LoaderKind): RawRange['syntax'] {
  return loader === 'fabric' || loader === 'quilt' ? 'fabric' : 'maven';
}

export function range(loader: LoaderKind, r: string | string[] | undefined): RawRange {
  const syntax = syntaxOf(loader);
  if (r === undefined) return { syntax, raw: syntax === 'fabric' ? ['*'] : [], unrepresentable: null };
  return { syntax, raw: Array.isArray(r) ? r : [r], unrepresentable: null };
}

function metadataFile(spec: ModSpec, loader: LoaderKind): string {
  switch (loader) {
    case 'neoforge':
      return spec.modsToml ? 'META-INF/mods.toml' : 'META-INF/neoforge.mods.toml';
    case 'forge':
      return 'META-INF/mods.toml';
    case 'fabric':
      return 'fabric.mod.json';
    case 'quilt':
      return 'quilt.mod.json';
    default:
      return 'mcmod.info';
  }
}

function json(v: unknown): string {
  return JSON.stringify(v);
}

/** Generate a metadata excerpt in the loader's real format. */
function excerptFor(spec: ModSpec, loader: LoaderKind, deps: Dependency[]): string {
  const version = spec.version ?? '1.0.0';
  if (loader === 'forge' || loader === 'neoforge' || loader === 'legacyforge') {
    if (loader === 'legacyforge') return `[\n  {\n    "modid": "${spec.id}",\n    "version": "${version}"\n  }\n]\n`;
    const lines = [
      'modLoader="javafml"',
      `loaderVersion="${loader === 'neoforge' ? '[4,)' : '[47,)'}"`,
      'license="MIT"',
      ...(spec.env === 'client' ? ['clientSideOnly=true'] : []),
      '',
      '[[mods]]',
      `modId="${spec.id}"`,
      `version="${version}"`,
      `displayName="${spec.name ?? spec.id}"`,
    ];
    for (const d of deps) {
      const type = d.kind === 'incompatible' ? 'incompatible' : d.kind === 'conflicts' ? 'discouraged' : d.kind === 'optional' ? 'optional' : 'required';
      lines.push('', `[[dependencies.${spec.id}]]`, `modId="${d.modId}"`, `type="${type}"`);
      lines.push(`versionRange="${d.range.raw[0] ?? ''}"`, 'ordering="NONE"', `side="${d.side ?? 'BOTH'}"`);
    }
    return `${lines.join('\n')}\n`;
  }
  const byKey = (kinds: DependencyKind[]): Record<string, string | string[]> =>
    Object.fromEntries(deps.filter((d) => kinds.includes(d.kind)).map((d) => [d.modId, d.range.raw.length === 1 ? (d.range.raw[0] ?? '*') : d.range.raw]));
  if (loader === 'fabric') {
    const lines = ['{', '  "schemaVersion": 1,', `  "id": ${json(spec.id)},`, `  "version": ${json(version)},`, `  "name": ${json(spec.name ?? spec.id)},`];
    lines.push(`  "environment": ${json(spec.env === 'client' ? 'client' : spec.env === 'server' ? 'server' : '*')},`);
    if (spec.provides) lines.push(`  "provides": ${json(spec.provides)},`);
    const sections: [string, DependencyKind[]][] = [
      ['depends', ['required']],
      ['recommends', ['recommended']],
      ['suggests', ['optional']],
      ['breaks', ['breaks']],
      ['conflicts', ['conflicts']],
    ];
    for (const [key, kinds] of sections) {
      const entries = Object.entries(byKey(kinds));
      if (entries.length === 0) continue;
      lines.push(`  "${key}": {`);
      entries.forEach(([id, r], i) => lines.push(`    ${json(id)}: ${json(r)}${i < entries.length - 1 ? ',' : ''}`));
      lines.push('  },');
    }
    lines.push('  "license": "MIT"', '}');
    return `${lines.join('\n')}\n`;
  }
  // Quilt: object dependencies, one key per line.
  const lines = ['{', '  "schema_version": 1,', '  "quilt_loader": {', `    "id": ${json(spec.id)},`, `    "version": ${json(version)},`];
  if (spec.provides) lines.push(`    "provides": ${json(spec.provides)},`);
  for (const [key, kinds] of [['depends', ['required', 'optional']], ['breaks', ['incompatible']]] as [string, DependencyKind[]][]) {
    const list = deps.filter((d) => kinds.includes(d.kind));
    if (list.length === 0) continue;
    lines.push(`    "${key}": [`);
    list.forEach((d, i) => {
      lines.push('      {', `        "id": ${json(d.modId)},`, `        "versions": ${json(d.range.raw.length === 1 ? d.range.raw[0] : d.range.raw)}`);
      lines.push(`      }${i < list.length - 1 ? ',' : ''}`);
    });
    lines.push('    ],');
  }
  lines.push('    "intermediate_mappings": "net.fabricmc:intermediary"', '  },', `  "minecraft": { "environment": ${json(spec.env === 'client' ? 'client' : '*')} }`, '}');
  return `${lines.join('\n')}\n`;
}

export function mod(spec: ModSpec, fallbackLoader: LoaderKind = 'forge', excerpt?: string): ModMeta {
  const loader = spec.loader ?? fallbackLoader;
  const deps: Dependency[] = [];
  if (spec.mc !== undefined) deps.push({ modId: 'minecraft', kind: 'required', range: range(loader, spec.mc), side: spec.mcSide ?? null });
  const loaderDepId = LOADER_DEP[loader];
  if (spec.loaderDep !== undefined && loaderDepId) {
    deps.push({ modId: loaderDepId, kind: 'required', range: range(loader, spec.loaderDep), side: spec.loaderSide ?? null });
  }
  for (const d of spec.deps ?? []) deps.push({ modId: d.id, kind: d.kind ?? 'required', range: range(loader, d.range), side: d.side ?? null });
  const env: ModEnvironment = spec.env ?? (loader === 'fabric' || loader === 'quilt' ? 'both' : 'unknown');
  const file = metadataFile(spec, loader);
  return {
    modId: spec.id,
    version: spec.version ?? '1.0.0',
    name: spec.name ?? null,
    loader,
    provides: spec.provides ?? [],
    environment: env,
    mcRange: spec.mc !== undefined ? range(loader, spec.mc) : null,
    loaderRange: spec.loaderDep !== undefined && loaderDepId ? range(loader, spec.loaderDep) : null,
    languageLoader: loader === 'forge' || loader === 'neoforge' ? 'javafml' : null,
    languageRange: loader === 'forge' || loader === 'neoforge' ? range(loader, loader === 'neoforge' ? '[4,)' : '[47,)') : null,
    deps,
    metadataFile: file,
    metadataExcerpt: excerpt ?? excerptFor(spec, loader, deps),
  };
}

export function sha1Of(text: string): string {
  return (fnv1a32(text) + fnv1a32(`${text}#2`) + fnv1a32(`${text}#3`) + fnv1a32(`${text}#4`) + fnv1a32(`${text}#5`)).slice(0, 40);
}

function record(spec: JarSpec, loader: LoaderKind, id: string, path: string, depth: number, parentId: string | null): JarRecord {
  const mods = (spec.mods ?? []).map((m) => mod(m, loader, spec.excerpt));
  const loaders: LoaderKind[] = [];
  for (const m of mods) if (!loaders.includes(m.loader)) loaders.push(m.loader);
  return {
    id,
    path,
    fileName: spec.disabled ? `${spec.file}.disabled` : spec.file,
    size: 1000,
    mtimeMs: spec.mtimeMs ?? (depth === 0 ? 1_700_000_000_000 : 0),
    sha1: spec.sha1 ?? sha1Of(`${id}:${spec.mods?.[0]?.version ?? ''}`),
    sha512: '0'.repeat(128),
    disabled: spec.disabled ?? false,
    depth,
    parentId,
    status: spec.status ?? { state: 'ok' },
    metadataErrors: spec.metadataErrors ?? [],
    loaders,
    mods,
    packages: [...(spec.packages ?? [])].sort(),
    mixinConfigs: [],
    maxClassMajor: spec.maxClassMajor === undefined ? 61 : spec.maxClassMajor,
    moduleName: spec.moduleName ?? null,
    fmlModType: null,
    jarjar: spec.jarjar ? { group: spec.jarjar.group, artifact: spec.jarjar.artifact, range: spec.jarjar.range ?? null, version: spec.jarjar.version ?? null } : null,
    nested: [],
  };
}

/** Top-level jar in `mods/`. Mods default to `loader` (Forge). */
export function jar(spec: JarSpec, loader: LoaderKind = 'forge'): JarRecord {
  return record(spec, loader, `mods/${spec.file}`, `mods/${spec.disabled ? `${spec.file}.disabled` : spec.file}`, 0, null);
}

export const forge = (spec: JarSpec): JarRecord => jar(spec, 'forge');
export const neoforge = (spec: JarSpec): JarRecord => jar(spec, 'neoforge');
export const fabric = (spec: JarSpec): JarRecord => jar(spec, 'fabric');
export const quilt = (spec: JarSpec): JarRecord => jar(spec, 'quilt');

/**
 * Nested jar inside `parent` (JarJar `META-INF/jarjar/` when `spec.jarjar` is set, Fabric/Quilt
 * `META-INF/jars/` otherwise). Registers it in `parent.nested`. Inherits `disabled`.
 */
export function nested(parent: JarRecord, spec: JarSpec, loader: LoaderKind = 'forge'): JarRecord {
  const entry = spec.jarjar ? `META-INF/jarjar/${spec.file}` : `META-INF/jars/${spec.file}`;
  const child = record({ ...spec, disabled: parent.disabled }, loader, `${parent.id}!/${entry}`, entry, parent.depth + 1, parent.id);
  child.fileName = spec.file;
  parent.nested.push(child.id);
  return child;
}

export function scan(...jars: JarRecord[]): ScanResult {
  return { instanceId: '0123456789abcdef', startedAtMs: 0, durationMs: 10, jars, declared: [], unverifiedDownloads: [], issues: [] };
}

export function instance(over: Partial<Instance> = {}): Instance {
  return {
    id: '0123456789abcdef',
    name: 'Test Pack',
    launcher: 'prism',
    root: '/instances/test',
    gameDir: '/instances/test/minecraft',
    mcVersion: '1.20.1',
    loader: { kind: 'forge', version: '47.3.0' },
    side: 'client',
    metadataSource: 'launcher',
    modCount: 0,
    ...over,
  };
}

export function pack(loader: LoaderKind | null, mcVersion: string | null, version: string | null = null, side: Side = 'client'): PackContext {
  return { mcVersion, loader: loader ? { kind: loader, version } : null, side, source: 'launcher' };
}

export function input(jars: JarRecord[], p: PackContext, modrinth?: ModrinthContext): CheckInput {
  return {
    instance: instance({ mcVersion: p.mcVersion, loader: p.loader, side: p.side }),
    scan: scan(...jars),
    pack: p,
    ...(modrinth ? { modrinth } : {}),
  };
}

export function run(jars: JarRecord[], p: PackContext, modrinth?: ModrinthContext): Finding[] {
  return runChecks(input(jars, p, modrinth));
}

export function only(findings: readonly Finding[], code: FindingCode): Finding[] {
  return findings.filter((f) => f.code === code);
}

export function codes(findings: readonly Finding[]): FindingCode[] {
  return findings.map((f) => f.code);
}

export function mrVersion(over: Partial<MrVersion> & { projectId: string }): MrVersion {
  return {
    id: `v-${over.projectId}`,
    versionNumber: '1.0.0',
    name: 'Release',
    gameVersions: ['1.20.1'],
    loaders: ['fabric'],
    versionType: 'release',
    environment: null,
    files: [],
    droppedFiles: 0,
    primaryDropped: false,
    dependencies: [],
    ...over,
  };
}

export function mrProject(over: Partial<MrProject> & { id: string }): MrProject {
  return {
    slug: over.id,
    title: over.id,
    projectType: 'mod',
    environment: [],
    clientSide: 'unknown',
    serverSide: 'unknown',
    iconPath: null,
    ...over,
  };
}

export function modrinth(over: Partial<ModrinthContext> = {}): ModrinthContext {
  return { versions: {}, projects: {}, updates: {}, failed: [], offline: false, ...over };
}

/** Lines of a metadata evidence excerpt that are highlighted. */
export function highlighted(f: Finding | undefined): string[] {
  const ev = f?.evidence.find((e) => e.kind === 'metadata');
  if (!ev || ev.kind !== 'metadata') return [];
  const lines = ev.excerpt.split('\n');
  return ev.highlight.map((n) => (lines[n - 1] ?? '').trim());
}

export function notes(f: Finding | undefined): string[] {
  return (f?.evidence ?? []).flatMap((e) => (e.kind === 'note' ? [e.text] : []));
}
