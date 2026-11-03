import type { JarRecord, LoaderKind, LogKind, LogSource, ModMeta } from '../../../bindings';
import type { Finding, FindingCode, JarIndex, PackContext } from '../../model';
import { analyzeCrash } from '../analyze';
import { digestFromText } from '../text';

export interface JarSpec {
  file: string;
  mods?: [id: string, name?: string][];
  packages?: string[];
  mixins?: string[];
  loader?: LoaderKind;
  /** Parent jar id: makes this a nested (jar-in-jar) record. */
  parent?: string;
  /** Declared JPMS module name (module-info / Automatic-Module-Name). */
  moduleName?: string;
}

function mod(modId: string, name: string | undefined, loader: LoaderKind): ModMeta {
  return {
    modId,
    version: '1.0.0',
    name: name ?? null,
    loader,
    provides: [],
    environment: 'both',
    mcRange: null,
    loaderRange: null,
    languageLoader: null,
    languageRange: null,
    deps: [],
    metadataFile: loader === 'fabric' ? 'fabric.mod.json' : 'META-INF/mods.toml',
    metadataExcerpt: '',
  };
}

export function jar(spec: JarSpec): JarRecord {
  const loader = spec.loader ?? 'forge';
  const id = spec.parent ? `${spec.parent}!/META-INF/jarjar/${spec.file}` : `mods/${spec.file}`;
  return {
    id,
    path: spec.parent ? `META-INF/jarjar/${spec.file}` : `mods/${spec.file}`,
    fileName: spec.file,
    size: 1000,
    mtimeMs: 0,
    sha1: '0'.repeat(40),
    sha512: '0'.repeat(128),
    disabled: false,
    depth: spec.parent ? 1 : 0,
    parentId: spec.parent ?? null,
    status: { state: 'ok' },
    loaders: [loader],
    mods: (spec.mods ?? []).map(([m, n]) => mod(m, n, loader)),
    packages: spec.packages ?? [],
    mixinConfigs: spec.mixins ?? [],
    maxClassMajor: 61,
    moduleName: spec.moduleName ?? null,
    jarjar: null,
    nested: [],
  };
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key) ?? [];
  list.push(value);
  map.set(key, list);
}

export function buildIndex(jars: readonly JarRecord[]): JarIndex {
  const byId = new Map<string, JarRecord>();
  const byModId = new Map<string, JarRecord[]>();
  const byPackage = new Map<string, JarRecord[]>();
  const byPackageAnyDepth = new Map<string, JarRecord[]>();
  const byMixinConfig = new Map<string, JarRecord[]>();
  const byFileName = new Map<string, JarRecord>();
  for (const j of jars) {
    byId.set(j.id, j);
    for (const m of j.mods) {
      push(byModId, m.modId, j);
      for (const p of m.provides) push(byModId, p, j);
    }
    for (const p of j.packages) {
      push(byPackageAnyDepth, p, j);
      if (j.depth === 0) push(byPackage, p, j);
    }
    for (const c of j.mixinConfigs) push(byMixinConfig, c, j);
    if (j.depth === 0) byFileName.set(j.fileName, j);
  }
  for (const j of jars) if (j.parentId) byId.get(j.parentId)?.nested.push(j.id);
  return { byId, byModId, byPackage, byPackageAnyDepth, byMixinConfig, byFileName };
}

export function source(kind: LogKind, id?: string): LogSource {
  const ids: Record<LogKind, string> = {
    crashReport: 'crash-reports/crash-2026-10-30_19.02.11-client.txt',
    latestLog: 'logs/latest.log',
    debugLog: 'logs/debug.log',
    hsErr: 'hs_err_pid12345.log',
  };
  return { id: id ?? ids[kind], kind, modifiedMs: 0, size: 0 };
}

/** Joins lines with `\n`; template literals cannot hold real tabs reliably, so use `\t`. */
export function text(...lines: string[]): string {
  return `${lines.join('\n')}\n`;
}

export function analyze(
  body: string,
  kind: LogKind,
  jars?: readonly JarRecord[],
  pack?: Partial<PackContext>,
): Finding[] {
  return analyzeCrash({
    digest: digestFromText(body, source(kind)),
    ...(jars ? { index: buildIndex(jars) } : {}),
    ...(pack ? { pack: { mcVersion: null, loader: null, side: 'client', source: 'override', ...pack } } : {}),
  });
}

export function codes(findings: readonly Finding[]): FindingCode[] {
  return findings.map((f) => f.code);
}

export function only(findings: readonly Finding[], code: FindingCode): Finding[] {
  return findings.filter((f) => f.code === code);
}

export function culpritIds(f: Finding | undefined): string[] {
  return f ? f.culprits.map((c) => c.jarId) : [];
}

export function culpritLines(f: Finding | undefined): number[] {
  if (!f) return [];
  return f.evidence.flatMap((e) => (e.kind === 'log' ? e.lines.filter((l) => l.role === 'culprit').map((l) => l.n) : []));
}
