/**
 * Pure view derivations from the store's scan state: tile states for the scan grid, mod-table
 * rows, rail pips, severity counts and the `PackIdentity` sent with fixes. No React, no IPC.
 */
import type { GridSort, JarRecord, JarStub, PackIdentity } from '../../bindings';
import type { Finding, PackContext, Severity } from '../../core/model';
import type { ScanStatus } from '../components/InstanceRailRow';
import type { ModRow } from '../components/ModTable';
import type { Tile } from '../components/TileGrid';
import type { TileState } from '../components/tileGridModel';
import type { InstanceScan } from './scanState';

const SEV_RANK: Record<Severity, number> = { error: 0, warning: 1, info: 2 };

/** `mods/a.jar!/META-INF/jarjar/b.jar` → `mods/a.jar`. */
export function topLevelId(jarId: string): string {
  const i = jarId.indexOf('!/');
  return i < 0 ? jarId : jarId.slice(0, i);
}

export interface SeverityCount {
  error: number;
  warning: number;
  info: number;
}

const zero = (): SeverityCount => ({ error: 0, warning: 0, info: 0 });

export function worstOf(c: SeverityCount): Severity | null {
  return c.error ? 'error' : c.warning ? 'warning' : c.info ? 'info' : null;
}

export function severityCounts(findings: readonly Finding[]): SeverityCount {
  const c = zero();
  for (const f of findings) c[f.severity]++;
  return c;
}

/**
 * Findings per jar. `exact`: keyed by the culprit's own id (mod table rows, nested included).
 * `top`: keyed by the top-level jar the culprit lives in (scan-grid tiles).
 * A finding citing the same jar twice counts once.
 */
export function findingsByJar(findings: readonly Finding[]): { exact: Map<string, SeverityCount>; top: Map<string, SeverityCount> } {
  const exact = new Map<string, SeverityCount>();
  const top = new Map<string, SeverityCount>();
  const bump = (m: Map<string, SeverityCount>, id: string, s: Severity) => {
    const c = m.get(id) ?? zero();
    c[s]++;
    m.set(id, c);
  };
  for (const f of findings) {
    const ids = new Set(f.culprits.map((c) => c.jarId));
    for (const id of ids) bump(exact, id, f.severity);
    for (const id of new Set([...ids].map(topLevelId))) bump(top, id, f.severity);
  }
  return { exact, top };
}

/** Display order of top-level jars: the `ScanStarted` order (file name, case-insensitive). */
export function displayStubs(scan: InstanceScan): JarStub[] {
  if (scan.stubs.length || !scan.result) return scan.stubs;
  return scan.result.jars
    .filter((j) => j.depth === 0)
    .map((j) => ({ id: j.id, path: j.path, fileName: j.fileName, disabled: j.disabled }))
    .sort((a, b) => a.fileName.toLowerCase().localeCompare(b.fileName.toLowerCase()));
}

interface TileWithRank extends Tile {
  rank: number;
}

/**
 * Scan-grid tiles. Before a jar's `ScanProgress` arrives it is `unscanned`; then `disabled`,
 * `ok`, or `error` when it could not be parsed. Once checks have run, a jar takes the worst
 * severity among the findings citing it (or any of its nested jars); info alone stays `ok`.
 * While scanning, tiles keep `ScanStarted` order; afterwards `gridSort` applies.
 */
export function deriveTiles(scan: InstanceScan, gridSort: GridSort): Tile[] {
  const stubs = displayStubs(scan);
  const byId = new Map<string, JarRecord>();
  if (scan.result) for (const j of scan.result.jars) if (j.depth === 0) byId.set(j.id, j);
  const checked = scan.status === 'done';
  // While a (re)scan runs, the previous result only supplies labels; states come from progress.
  const scanning = scan.status === 'scanning';
  const top = checked ? findingsByJar(scan.findings).top : new Map<string, SeverityCount>();

  const tiles: TileWithRank[] = stubs.map((stub) => {
    const jar = byId.get(stub.id);
    const meta = jar?.mods[0];
    const label = meta?.modId ?? stub.fileName;
    const version = meta?.version ?? null;
    const parsed = scan.progress[stub.id];
    const disabled = scanning || !jar ? stub.disabled : jar.disabled;
    const counts = top.get(stub.id) ?? zero();
    const worst = worstOf(counts);
    let state: TileState;
    let rank: number;
    if (parsed === undefined && (scanning || !jar)) {
      state = 'unscanned';
      rank = 3;
    } else if (disabled) {
      state = 'disabled';
      rank = 4;
    } else if (checked && (worst === 'error' || worst === 'warning')) {
      state = worst;
      rank = SEV_RANK[worst];
    } else if ((parsed ?? jar?.status.state === 'ok') === false) {
      state = 'error';
      rank = 0;
    } else {
      state = 'ok';
      rank = worst === 'info' ? 2 : 3;
    }
    const count = state === 'error' ? counts.error : state === 'warning' ? counts.warning : 0;
    return { id: stub.id, label, version, state, count, rank };
  });

  if (scan.status === 'scanning' || gridSort === 'name') return tiles.map(stripRank);
  return tiles
    .map((t, i) => ({ t, i }))
    .sort((a, b) => a.t.rank - b.t.rank || a.i - b.i)
    .map(({ t }) => stripRank(t));
}

function stripRank({ rank: _rank, ...t }: TileWithRank): Tile {
  void _rank;
  return t;
}

/** Per-jar Modrinth column and icon (modrinthState.ts `modrinthRowView`). */
export type ModrinthRowView = (jar: JarRecord) => Pick<ModRow, 'modrinth' | 'iconUrl'>;

const UNKNOWN_VIEW: ModrinthRowView = () => ({ modrinth: { state: 'offline' }, iconUrl: null });

/**
 * Mod-table rows in file-name order; nested jars become children. The Modrinth column is `—`
 * (unknown) unless `modrinth` says otherwise.
 */
export function deriveModRows(scan: InstanceScan, modrinth: ModrinthRowView = UNKNOWN_VIEW): ModRow[] {
  const stubs = displayStubs(scan);
  if (!scan.result) {
    return stubs.map((s) => ({
      id: s.id,
      name: s.fileName,
      modId: null,
      version: null,
      loader: null,
      modrinth: { state: 'offline' },
      findings: zero(),
      enabled: !s.disabled,
    }));
  }
  const byId = new Map(scan.result.jars.map((j) => [j.id, j]));
  const { exact } = findingsByJar(scan.findings);
  const row = (j: JarRecord): ModRow => {
    const meta = j.mods[0];
    const kids = j.nested.map((id) => byId.get(id)).filter((k): k is JarRecord => !!k);
    const mr = modrinth(j);
    const r: ModRow = {
      id: j.id,
      name: meta?.name ?? meta?.modId ?? j.fileName,
      modId: meta?.modId ?? null,
      version: meta?.version ?? null,
      loader: j.loaders[0] ?? null,
      modrinth: mr.modrinth,
      iconUrl: mr.iconUrl ?? null,
      findings: exact.get(j.id) ?? zero(),
      enabled: !j.disabled,
    };
    if (kids.length) r.children = kids.map(row);
    return r;
  };
  return stubs.map((s) => byId.get(s.id)).filter((j): j is JarRecord => !!j).map(row);
}

/** Rail pip from the last scan. A failed scan shows as an error; a running one as hollow. */
export function instanceStatus(scan: InstanceScan | undefined): ScanStatus {
  if (!scan) return 'unscanned';
  // A feature this build lacks (e.g. .mrpack scanning) is not a failed scan.
  if (scan.status === 'error') return scan.error?.kind === 'unavailable' ? 'unscanned' : 'error';
  if (scan.status !== 'done') return 'unscanned';
  const w = worstOf(severityCounts(scan.findings));
  return w === 'error' ? 'error' : w === 'warning' ? 'warning' : 'ok';
}

/** The identity sent with `plan_work_order`, or null while the MC version or loader is unknown. */
export function packIdentity(pack: PackContext | null): PackIdentity | null {
  if (!pack || !pack.mcVersion || !pack.loader) return null;
  return { mcVersion: pack.mcVersion, loader: pack.loader };
}

/**
 * Why fix buttons are disabled for an instance, or null when fixes can be planned: a fix is
 * checked against the pack's Minecraft version and loader (`PackIdentity`), so both must be known.
 */
export function fixBlockReason(scan: Pick<InstanceScan, 'result' | 'pack'> | undefined): string | null {
  if (!scan?.result) return 'Fixes can be planned once the scan has finished.';
  if (packIdentity(scan.pack)) return null;
  return "The pack's Minecraft version or loader is unknown. Set them under Pack identity in the inspector to plan fixes.";
}

/** Class-file major version → Java release (`65` → `21`). */
export function javaRelease(major: number): number {
  return major - 44;
}
