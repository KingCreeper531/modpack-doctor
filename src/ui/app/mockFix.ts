/**
 * The fix engine of the browser preview (mockIpc.ts), with the semantics of CONTRACTS invariants
 * 8 and 14 over an in-memory copy of each mock instance's jars. Dev only: reachable through the
 * mock backend, which `createBackend` drops from production bundles.
 *
 * - Plan never mutates. It resolves jar ids against the current (mutable) jar list, records each
 *   op's preconditions (source present with its sha1; destination absent), re-validates Modrinth
 *   versions (loader incl. NeoForge 1.20.1 → forge and Quilt → fabric, MC version, same project
 *   for `replace`, published after the current version, the download-file rule) and refuses the
 *   whole order with a readable error naming the action. `replace` / `installDependency` need
 *   Modrinth on and reachable (`offline`). A destination that exists is refused (`conflict`).
 * - Orders are single-use and expire 15 minutes after planning (`notFound`). Execute refuses while
 *   the game runs (`gameRunning`, order kept), while the instance is scanned or another order of
 *   it runs (`conflict`). Ops run in order with an `OpStatus` per step (running, then done /
 *   failed / skipped, with small delays); each re-checks its preconditions. The first failure
 *   rolls every completed op back (reverse order) and skips the rest.
 * - `replace` plans as two ops, like the design fixtures: the download (which names the jar it
 *   replaces) and the move of the old jar into the backup snapshot.
 * - Backups: one snapshot per executed fix order, newest first, with the moved-out jars and the
 *   sha1 of every touched path afterwards. Undo is per action: reverse ops planned from the
 *   snapshot, each checking the current file against the recorded "after" state; a mismatch
 *   refuses that action ("changed since"). Executed undos mark `undoneActions`.
 * - All the Mods 9 starts with a seeded history: a disable whose undo is a single rename (Enter),
 *   an update of Curios API (undo = remove the new jar + restore the old one), a removal plus a
 *   disable whose jar was renamed back by hand since (its undo is refused), and an older order
 *   that is fully undone.
 */
import type {
  AppError,
  BackupEntry,
  FileOp,
  FixAction,
  Instance,
  JarRecord,
  LoaderKind,
  OpState,
  OpStatus,
  PackIdentity,
  PackOverride,
  PlannedOp,
  WorkOrder,
  WorkOrderResult,
} from '../../bindings';
import { downloadFile, modrinthLoaders } from '../../core/modrinth';
import type { Result } from './ipc';
import { mockJarAt, mockJars, type MockModSpec } from './mockData';
import { mockIdentifiedVersion, mockRegisterJar, mockVersionById } from './mockModrinth';

/** Orders expire this long after planning (CONTRACTS invariant 14). */
export const ORDER_TTL_MS = 15 * 60_000;

export const EXPIRED_MESSAGE = 'This work order expired — review the fixes again.';

/** The instance with the seeded backup history (All the Mods 9). */
export const SEEDED_HISTORY_INSTANCE = '3f9c2a71d0b84e15';

const APP_DATA = 'C:\\Users\\alex\\AppData\\Roaming\\io.github.kingcreeper531.modpackdoctor';

const LOADER: Record<LoaderKind, string> = {
  forge: 'Forge',
  neoforge: 'NeoForge',
  fabric: 'Fabric',
  quilt: 'Quilt',
  legacyforge: 'Legacy Forge',
  unknown: 'an unknown loader',
};

export interface MockFixOptions {
  /** Delay of each op step (running, then done). */
  opMs: number;
  /** `fixfail`: the 2nd op of every order fails (the only op of a one-op order), then rollback. */
  failSecondOp: boolean;
  /** `expired`: the first execute answers `notFound`, as after 15 minutes. */
  expireFirst: boolean;
  /** `gamerunning`: every execute is refused. */
  gameRunning: boolean;
  /** Screenshot hook: the op at this index starts running and never finishes. */
  holdOpAt: number | null;
}

export interface MockFixDeps {
  instance(id: string): Instance | undefined;
  override(id: string): PackOverride | null;
  /** Modrinth switched off or unreachable. */
  offline(): boolean;
  scanning(id: string): boolean;
  emit(s: OpStatus): void;
  now(): number;
  sleep(ms: number): Promise<void>;
}

/** What one op needs to hold right before it runs (recorded at plan time). */
interface Pre {
  /** Must exist with this sha1. */
  source: { path: string; sha1: string } | null;
  /** Must be absent. */
  dest: string | null;
  /** For a download: the jar the verified file becomes. */
  created: JarRecord | null;
}

interface Snapshot {
  entry: BackupEntry;
  dir: string;
  /** Files moved out of the instance, by path relative to the snapshot (`files/…`, `created/…`). */
  files: Map<string, JarRecord[]>;
  /** sha1 of each touched path after the order ran; null = absent. */
  after: Map<string, string | null>;
}

interface Stored {
  order: WorkOrder;
  plannedAt: number;
  pre: Pre[];
  /** Undo orders: the snapshot and the original action index of each of `order.actions`. */
  undo: { backupId: string; indexes: number[] } | null;
}

const ok = <T>(data: T): Result<T> => ({ status: 'ok', data });
const fail = (kind: AppError['kind'], message: string, path: string | null = null): Result<never> => ({
  status: 'error',
  error: { kind, message, path },
});

const base = (path: string) => path.slice(path.lastIndexOf('/') + 1);
const dirOf = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf('/')));
const short = (sha1: string | null | undefined) => (sha1 ? sha1.slice(0, 8) : 'none');
const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

export type MockFixEngine = ReturnType<typeof createMockFix>;

export function createMockFix(opts: MockFixOptions, deps: MockFixDeps) {
  /** Mutable jar lists (top-level and nested, flattened), copied from mockData on first use. */
  const fs = new Map<string, JarRecord[]>();
  const orders = new Map<string, Stored>();
  /** Snapshots per instance, newest first. */
  const backups = new Map<string, Snapshot[]>();
  const seededFor = new Set<string>();
  /** Instances with an order executing. */
  const busy = new Set<string>();
  let nextOrder = 1040;
  let expiredOnce = false;
  const born = deps.now();

  function jarsOf(instanceId: string): JarRecord[] {
    let jars = fs.get(instanceId);
    if (!jars) {
      jars = [...mockJars(instanceId)];
      fs.set(instanceId, jars);
    }
    return jars;
  }

  const topAt = (instanceId: string, path: string) => jarsOf(instanceId).find((j) => j.depth === 0 && j.path === path) ?? null;
  const topById = (instanceId: string, id: string) => jarsOf(instanceId).find((j) => j.depth === 0 && j.id === id) ?? null;

  /** Remove a top-level jar and its nested jars; returns them (top first). */
  function take(instanceId: string, path: string): JarRecord[] {
    const jars = jarsOf(instanceId);
    const top = jars.find((j) => j.depth === 0 && j.path === path);
    if (!top) return [];
    const out = [top, ...jars.filter((j) => j.parentId === top.id)];
    fs.set(
      instanceId,
      jars.filter((j) => !out.includes(j)),
    );
    return out;
  }

  function put(instanceId: string, records: JarRecord[]) {
    fs.set(instanceId, [...jarsOf(instanceId), ...records]);
    const top = records[0];
    if (top) mockRegisterJar(instanceId, top);
  }

  /** Rename a top-level jar in place (its id never changes: ids strip `.disabled`). */
  function rename(instanceId: string, from: string, to: string) {
    const disabled = to.endsWith('.disabled');
    const top = topAt(instanceId, from);
    if (!top) return;
    fs.set(
      instanceId,
      jarsOf(instanceId).map((j) => (j === top ? { ...j, path: to, fileName: base(to), disabled } : j.parentId === top.id ? { ...j, disabled } : j)),
    );
  }

  const snapshotDir = (instanceId: string, ms: number) => `${APP_DATA}\\backups\\${instanceId}\\${ms}`;

  // ── Labels ──────────────────────────────────────────────────────────────────

  function label(instanceId: string, action: FixAction, ops: readonly FileOp[] = []): string {
    const name = (id: string) => base(topById(instanceId, id)?.path ?? id).replace(/\.disabled$/, '');
    const dl = ops.find((o): o is Extract<FileOp, { op: 'download' }> => o.op === 'download');
    switch (action.kind) {
      case 'disable':
        return `Disable ${name(action.jarId)}`;
      case 'enable':
        return `Enable ${name(action.jarId)}`;
      case 'removeDuplicate':
        return `Remove ${name(action.remove)}, keep ${name(action.keep)}`;
      case 'replace':
        return dl ? `Update ${dl.projectTitle} to ${dl.versionNumber}` : `Replace ${name(action.jarId)}`;
      case 'installDependency':
        return dl ? `Install ${dl.projectTitle} ${dl.versionNumber}` : `Install ${action.modId}`;
      case 'manual':
        return 'Manual steps';
    }
  }

  function title(instanceId: string, actions: readonly FixAction[], ops: readonly PlannedOp[], prefix = ''): string {
    const parts = actions.map((a, i) =>
      label(
        instanceId,
        a,
        ops.filter((o) => o.actionIndex === i).map((o) => o.op),
      ),
    );
    const joined = parts.map((p, i) => (i === 0 && !prefix ? p : lowerFirst(p))).join(', ');
    return prefix ? `${prefix}${joined}` : joined;
  }

  // ── Planning ────────────────────────────────────────────────────────────────

  /** The identity the launcher metadata or an override pins (null = not pinned). */
  function pinned(inst: Instance): { mc: string | null; loader: LoaderKind | null } {
    const o = deps.override(inst.id);
    const inferred = inst.metadataSource === 'inferred';
    return {
      mc: o?.mcVersion ?? (inferred ? null : inst.mcVersion),
      loader: o?.loader?.kind ?? (inferred ? null : (inst.loader?.kind ?? null)),
    };
  }

  interface Planned {
    ops: FileOp[];
    pre: Pre[];
    notes: string[];
  }

  /** Paths present as the order would leave them (later actions see earlier ones' effects). */
  type Present = Map<string, string>;

  function planAction(inst: Instance, pack: PackIdentity, action: FixAction, present: Present): Result<Planned> {
    const id = inst.id;
    let name = label(id, action);
    const refuse = (kind: AppError['kind'], why: string, path: string | null = null) => fail(kind, `${name}: ${why}`, path);
    const jar = (jarId: string) => {
      const j = topById(id, jarId);
      return j && present.has(j.path) ? j : null;
    };
    const gone = (jarId: string) =>
      refuse('notFound', `${jarId} is not in the mods folder any more. Rescan the instance and review the fixes again.`, jarId);
    const exists = (path: string, what: string) =>
      refuse('conflict', `${path} already exists, so ${what} would overwrite it. Move or delete one of the two files first.`, path);

    switch (action.kind) {
      case 'manual':
        return ok({ ops: [], pre: [], notes: action.steps.map((s) => `manual step: ${s}`) });
      case 'disable':
      case 'enable': {
        const j = jar(action.jarId);
        if (!j) return gone(action.jarId);
        const off = j.path.endsWith('.disabled');
        if (action.kind === 'disable' && off) return refuse('invalid', `${base(j.path)} is already disabled.`, j.path);
        if (action.kind === 'enable' && !off) return refuse('invalid', `${base(j.path)} is already enabled.`, j.path);
        const to = off ? j.path.slice(0, -'.disabled'.length) : `${j.path}.disabled`;
        if (present.has(to)) return exists(to, 'the rename');
        present.set(to, present.get(j.path)!);
        present.delete(j.path);
        return ok({ ops: [{ op: 'rename', from: j.path, to }], pre: [{ source: { path: j.path, sha1: j.sha1 }, dest: to, created: null }], notes: [] });
      }
      case 'removeDuplicate': {
        const keep = jar(action.keep);
        const remove = jar(action.remove);
        if (!keep) return gone(action.keep);
        if (!remove) return gone(action.remove);
        if (keep.id === remove.id) return refuse('invalid', 'the jar to keep and the jar to remove are the same file.');
        present.delete(remove.path);
        return ok({ ops: [{ op: 'moveToBackup', path: remove.path }], pre: [{ source: { path: remove.path, sha1: remove.sha1 }, dest: null, created: null }], notes: [] });
      }
      case 'replace':
      case 'installDependency': {
        if (deps.offline()) {
          return refuse('offline', 'Modrinth is not reachable (or switched off), so the version cannot be checked again. Try again when Modrinth is reachable.');
        }
        const info = mockVersionById(action.versionId);
        if (!info) return refuse('notFound', `Modrinth has no version ${action.versionId} any more. Refresh Modrinth and review the fixes again.`);
        const v = info.version;
        // From here on the refusal names the version, as the button did.
        name = action.kind === 'replace' ? `Update ${info.title} to ${v.versionNumber}` : `Install ${info.title} ${v.versionNumber}`;
        const accepted = modrinthLoaders({ mcVersion: pack.mcVersion, loader: pack.loader, side: inst.side, source: 'launcher' });
        if (!v.loaders.some((l) => accepted.includes(l))) {
          return refuse('invalid', `that version is for ${v.loaders.join(', ')}, but this pack runs ${LOADER[pack.loader.kind]}. It was not planned.`);
        }
        if (!v.gameVersions.includes(pack.mcVersion)) {
          return refuse('invalid', `that version is for Minecraft ${v.gameVersions.join(', ')}, not ${pack.mcVersion}. It was not planned.`);
        }
        const file = downloadFile(v);
        if (!file) return refuse('invalid', 'that version has no single primary file to download.');
        if (!file.url.startsWith('https://cdn.modrinth.com/')) return refuse('invalid', 'that version is not served from cdn.modrinth.com.');
        const size = file.size;
        if (size === null) return refuse('invalid', `Modrinth does not say how large ${file.filename} is, so it can't be downloaded with a size limit.`);
        let old: JarRecord | null = null;
        if (action.kind === 'replace') {
          old = jar(action.jarId);
          if (!old) return gone(action.jarId);
          const current = mockIdentifiedVersion(old.sha1);
          if (!current) return refuse('invalid', `${base(old.path)} can't be identified on Modrinth by its hash, so it is not replaced automatically.`, old.path);
          if (current.projectId !== v.projectId) return refuse('invalid', `that version belongs to a different Modrinth project than ${base(old.path)}.`, old.path);
          if (!current.datePublished || !v.datePublished || Date.parse(v.datePublished) <= Date.parse(current.datePublished)) {
            return refuse('invalid', `that version is not newer than the installed ${current.versionNumber}; replacing would be a downgrade.`, old.path);
          }
        }
        const dir = old ? dirOf(old.path) : 'mods';
        const dest = `${dir}/${file.filename}`;
        if (present.has(dest)) return exists(dest, 'the download');
        const oldMeta = old?.mods[0];
        const mod: MockModSpec = {
          modId: info.modId,
          version: v.versionNumber,
          name: info.title,
          loader: (v.loaders[0] ?? pack.loader.kind) as LoaderKind,
          mc: pack.loader.kind === 'fabric' || pack.loader.kind === 'quilt' ? `>=${pack.mcVersion}` : `[${pack.mcVersion},)`,
          deps: (oldMeta?.deps ?? [])
            .filter((d) => !['minecraft', 'forge', 'neoforge', 'fabricloader', 'quilt_loader'].includes(d.modId))
            .map((d) => [d.modId, d.kind, d.range.raw[0] ?? '*']),
          env: oldMeta?.environment ?? 'both',
        };
        const created = mockJarAt(dest, mod, { mcVersion: pack.mcVersion, sizeBytes: size, sha1: file.sha1, sha512: file.sha512, mtimeMs: deps.now() });
        const ops: FileOp[] = [
          {
            op: 'download',
            projectTitle: info.title,
            versionNumber: v.versionNumber,
            sizeBytes: size,
            url: file.url,
            sha512: file.sha512,
            dest,
            replaces: old?.path ?? null,
          },
        ];
        const pre: Pre[] = [{ source: null, dest, created }];
        present.set(dest, file.sha1);
        if (old) {
          ops.push({ op: 'moveToBackup', path: old.path });
          pre.push({ source: { path: old.path, sha1: old.sha1 }, dest: null, created: null });
          present.delete(old.path);
        }
        const notes = v.versionType === 'release' ? [] : [`${info.title} ${v.versionNumber} is a ${v.versionType} version, not a release.`];
        return ok({ ops, pre, notes });
      }
    }
  }

  function store(order: WorkOrder, pre: Pre[], undo: Stored['undo']): WorkOrder {
    orders.set(order.id, { order, plannedAt: deps.now(), pre, undo });
    return order;
  }

  function plan(instanceId: string, pack: PackIdentity, actions: FixAction[]): Result<WorkOrder> {
    const inst = deps.instance(instanceId);
    if (!inst) return fail('notFound', 'This instance is no longer on disk. Rescan your launchers to refresh the list.');
    if (inst.launcher === 'mrpack') return fail('invalid', `"${inst.name}" is a .mrpack file; fixes apply to installed instances only.`);
    if (!actions.length) return fail('invalid', 'No fix was given, so there is nothing to plan.');
    const pin = pinned(inst);
    if ((pin.mc && pin.mc !== pack.mcVersion) || (pin.loader && pin.loader !== pack.loader.kind)) {
      return fail(
        'invalid',
        `The pack identity sent with the fix (${pack.mcVersion}, ${LOADER[pack.loader.kind]}) disagrees with the instance's (${pin.mc ?? '?'}, ${pin.loader ? LOADER[pin.loader] : '?'}). Rescan and review the fixes again.`,
      );
    }
    const present: Present = new Map(jarsOf(instanceId).filter((j) => j.depth === 0).map((j) => [j.path, j.sha1]));
    const ops: PlannedOp[] = [];
    const pre: Pre[] = [];
    const notes: string[] = [];
    for (const [i, action] of actions.entries()) {
      const r = planAction(inst, pack, action, present);
      if (r.status === 'error') return r;
      ops.push(...r.data.ops.map((op) => ({ actionIndex: i, op })));
      pre.push(...r.data.pre);
      notes.push(...r.data.notes);
    }
    const now = deps.now();
    return ok(
      store(
        {
          id: String(++nextOrder),
          instanceId,
          kind: 'fix',
          title: title(instanceId, actions, ops),
          actions,
          ops,
          notes,
          backupDir: snapshotDir(instanceId, now),
        },
        pre,
        null,
      ),
    );
  }

  // ── Backups and undo ────────────────────────────────────────────────────────

  function snapshotsOf(instanceId: string): Snapshot[] {
    seed(instanceId);
    let list = backups.get(instanceId);
    if (!list) backups.set(instanceId, (list = []));
    return list;
  }

  function findSnapshot(backupId: string): Snapshot | null {
    const instanceId = backupId.split('/')[0] ?? '';
    return snapshotsOf(instanceId).find((s) => s.entry.id === backupId) ?? null;
  }

  function listBackups(instanceId: string): Result<BackupEntry[]> {
    if (!deps.instance(instanceId)) return fail('notFound', 'This instance is no longer on disk. Rescan your launchers to refresh the list.');
    return ok(snapshotsOf(instanceId).map((s) => ({ ...s.entry, undoneActions: [...s.entry.undoneActions] })));
  }

  /** Reverse ops of one action of a snapshot, checked against the instance as it is now. */
  function reverse(snap: Snapshot, index: number, present: Present): Result<{ ops: FileOp[]; pre: Pre[] }> {
    const instanceId = snap.entry.instanceId;
    const action = snap.entry.actions[index]!;
    const forward = snap.entry.ops.filter((o) => o.actionIndex === index).map((o) => o.op);
    const name = `Undo of "${label(instanceId, action, forward)}"`;
    const changed = (why: string, path: string) =>
      fail('conflict', `${name} was not planned: ${why} Undoing it now would overwrite that change.`, path);
    const ops: FileOp[] = [];
    const pre: Pre[] = [];
    for (const op of [...forward].reverse()) {
      switch (op.op) {
        case 'rename': {
          const want = snap.after.get(op.to) ?? null;
          const cur = present.get(op.to) ?? null;
          if (cur === null) return changed(`${op.to} is not there any more; it was renamed, moved or deleted after the fix.`, op.to);
          if (cur !== want) return changed(`${op.to} changed since the fix (sha1 ${short(want)} expected, ${short(cur)} found).`, op.to);
          if (present.has(op.from)) return changed(`${op.from} exists again.`, op.from);
          ops.push({ op: 'rename', from: op.to, to: op.from });
          pre.push({ source: { path: op.to, sha1: cur }, dest: op.from, created: null });
          present.set(op.from, cur);
          present.delete(op.to);
          break;
        }
        case 'moveToBackup': {
          const backupPath = `files/${op.path}`;
          if (present.has(op.path)) return changed(`${op.path} exists again.`, op.path);
          if (!snap.files.has(backupPath)) return fail('notFound', `${name} was not planned: the backup copy of ${op.path} is missing from the snapshot.`, op.path);
          ops.push({ op: 'restore', backupPath, to: op.path, expectAbsentOrSha1: null });
          pre.push({ source: null, dest: op.path, created: null });
          present.set(op.path, snap.files.get(backupPath)![0]!.sha1);
          break;
        }
        case 'download': {
          const want = snap.after.get(op.dest) ?? null;
          const cur = present.get(op.dest) ?? null;
          if (cur === null || want === null) return changed(`${op.dest} is not there any more; it was renamed, moved or deleted after the fix.`, op.dest);
          if (cur !== want) return changed(`${op.dest} changed since the fix (sha1 ${short(want)} expected, ${short(cur)} found).`, op.dest);
          ops.push({ op: 'removeCreated', path: op.dest, expectSha1: want });
          pre.push({ source: { path: op.dest, sha1: want }, dest: null, created: null });
          present.delete(op.dest);
          break;
        }
        case 'restore':
        case 'removeCreated':
          return fail('invalid', `${name} was not planned: the snapshot records an undo step as a fix.`);
      }
    }
    return ok({ ops, pre });
  }

  function planUndo(backupId: string, actionIndexes: number[] | null): Result<WorkOrder> {
    if (!/^[0-9a-f]{16}\/[0-9]+$/.test(backupId)) return fail('invalid', `${backupId} is not a backup id.`);
    const snap = findSnapshot(backupId);
    if (!snap) return fail('notFound', 'This backup is not in the history any more. Refresh the history and try again.');
    const e = snap.entry;
    const remaining = e.actions.map((_, i) => i).filter((i) => !e.undoneActions.includes(i));
    const wanted = actionIndexes ?? remaining;
    if (!wanted.length) return fail('invalid', 'Every action of this work order is undone already.');
    for (const i of wanted) {
      if (!Number.isInteger(i) || i < 0 || i >= e.actions.length) return fail('invalid', `This work order has no action ${i + 1}.`);
      if (e.undoneActions.includes(i)) return fail('invalid', `Action ${String(i + 1).padStart(2, '0')} of this work order is undone already.`);
    }
    // Later actions first, so each reverse step sees the state the next one left.
    const indexes = [...new Set(wanted)].sort((a, b) => b - a);
    const present: Present = new Map(jarsOf(e.instanceId).filter((j) => j.depth === 0).map((j) => [j.path, j.sha1]));
    const ops: PlannedOp[] = [];
    const pre: Pre[] = [];
    for (const [k, i] of indexes.entries()) {
      if (e.actions[i]!.kind === 'manual') continue;
      const r = reverse(snap, i, present);
      if (r.status === 'error') return r;
      ops.push(...r.data.ops.map((op) => ({ actionIndex: k, op })));
      pre.push(...r.data.pre);
    }
    const actions = indexes.map((i) => e.actions[i]!);
    const forwardLabels = indexes.map((i) =>
      label(
        e.instanceId,
        e.actions[i]!,
        e.ops.filter((o) => o.actionIndex === i).map((o) => o.op),
      ),
    );
    return ok(
      store(
        {
          id: String(++nextOrder),
          instanceId: e.instanceId,
          kind: 'undo',
          title: `Undo: ${forwardLabels.map(lowerFirst).join(', ')}`,
          actions,
          ops,
          notes: [],
          backupDir: snap.dir,
        },
        pre,
        { backupId, indexes },
      ),
    );
  }

  // ── Execution ───────────────────────────────────────────────────────────────

  /** Readable failure for the scripted `fixfail` op. */
  function scriptedFailure(op: FileOp): string {
    switch (op.op) {
      case 'rename':
        return `${op.from} is locked by another program (os error 32); it was not renamed.`;
      case 'moveToBackup':
        return `${op.path} is locked by another program (os error 32); it was not moved into the backup.`;
      case 'download':
        return `The downloaded file's SHA-512 does not match what Modrinth published (expected ${op.sha512.slice(0, 12)}…, got 0c41d2f9a7be…); nothing was installed.`;
      case 'restore':
        return `${op.to} appeared while the work order ran; the backup copy was not restored over it.`;
      case 'removeCreated':
        return `${op.path} is locked by another program (os error 32); it was not moved into the backup.`;
    }
  }

  /** The precondition an op finds broken right before it runs, or null. */
  function broken(instanceId: string, pre: Pre): string | null {
    if (pre.source) {
      const cur = topAt(instanceId, pre.source.path);
      if (!cur) return `${pre.source.path} is not there any more; nothing was changed by this step.`;
      if (cur.sha1 !== pre.source.sha1) return `${pre.source.path} changed since the plan (sha1 ${short(pre.source.sha1)} expected, ${short(cur.sha1)} found).`;
    }
    if (pre.dest && topAt(instanceId, pre.dest)) return `${pre.dest} exists now; it is never overwritten.`;
    return null;
  }

  /** Run one op; returns how to reverse it. */
  function apply(snap: Snapshot, op: FileOp, pre: Pre, record: boolean): () => void {
    const id = snap.entry.instanceId;
    switch (op.op) {
      case 'rename': {
        const sha1 = topAt(id, op.from)?.sha1 ?? null;
        rename(id, op.from, op.to);
        if (record) {
          snap.after.set(op.to, sha1);
          snap.after.set(op.from, null);
        }
        return () => rename(id, op.to, op.from);
      }
      case 'moveToBackup':
      case 'removeCreated': {
        const key = op.op === 'moveToBackup' ? `files/${op.path}` : `created/${op.path}`;
        const moved = take(id, op.path);
        snap.files.set(key, moved);
        if (record) snap.after.set(op.path, null);
        return () => put(id, snap.files.get(key) ?? []);
      }
      case 'download': {
        const created = pre.created!;
        put(id, [created]);
        if (record) snap.after.set(op.dest, created.sha1);
        return () => {
          snap.files.set(`created/${op.dest}`, take(id, op.dest));
        };
      }
      case 'restore': {
        put(id, snap.files.get(op.backupPath) ?? []);
        return () => {
          snap.files.set(op.backupPath, take(id, op.to));
        };
      }
    }
  }

  async function execute(orderId: string): Promise<Result<WorkOrderResult>> {
    const s = orders.get(orderId);
    if (!s || deps.now() - s.plannedAt > ORDER_TTL_MS) {
      orders.delete(orderId);
      return fail('notFound', EXPIRED_MESSAGE);
    }
    if (opts.expireFirst && !expiredOnce) {
      expiredOnce = true;
      orders.delete(orderId);
      return fail('notFound', EXPIRED_MESSAGE);
    }
    const { order } = s;
    const inst = deps.instance(order.instanceId);
    if (!inst) return fail('notFound', 'This instance is no longer on disk. Rescan your launchers to refresh the list.');
    const game = gameStatus(order.instanceId);
    if (game.running) {
      return fail('gameRunning', `Minecraft is running for "${inst.name}" (${game.reason}). Nothing was changed.`, inst.gameDir);
    }
    if (busy.has(order.instanceId)) return fail('conflict', 'Another work order for this instance is running. Wait for it to finish, then execute this one.');
    if (deps.scanning(order.instanceId)) return fail('conflict', 'This instance is being scanned. Execute the work order again when the scan finishes.');
    // Single use: from here on the order is consumed.
    orders.delete(orderId);
    busy.add(order.instanceId);
    try {
      return ok(await run(s, inst));
    } finally {
      busy.delete(order.instanceId);
    }
  }

  async function run({ order, pre, undo, plannedAt }: Stored, inst: Instance): Promise<WorkOrderResult> {
    const id = inst.id;
    let snap: Snapshot;
    if (undo) snap = findSnapshot(undo.backupId)!;
    else {
      // The manifest is written before the first mutation.
      let ms = plannedAt;
      while (snapshotsOf(id).some((x) => x.entry.id === `${id}/${ms}`)) ms++;
      snap = {
        entry: { id: `${id}/${ms}`, instanceId: id, createdAtMs: ms, title: order.title, actions: order.actions, ops: order.ops, undoneActions: [] },
        dir: snapshotDir(id, ms),
        files: new Map(),
        after: new Map(),
      };
    }
    const states: Array<{ state: OpState; message: string | null }> = order.ops.map(() => ({ state: 'pending', message: null }));
    const emit = (index: number, state: OpState, message: string | null = null) => {
      states[index] = { state, message };
      deps.emit({ orderId: order.id, index, state, message });
    };
    const reverts: Array<{ index: number; revert: () => void }> = [];
    const failAt = opts.failSecondOp ? Math.min(1, order.ops.length - 1) : -1;
    let failed = -1;
    for (const [i, planned] of order.ops.entries()) {
      emit(i, 'running');
      if (opts.holdOpAt === i) await new Promise<never>(() => undefined);
      await deps.sleep(opts.opMs);
      const why = i === failAt ? scriptedFailure(planned.op) : broken(id, pre[i]!);
      if (why) {
        emit(i, 'failed', why);
        failed = i;
        break;
      }
      reverts.push({ index: i, revert: apply(snap, planned.op, pre[i]!, !undo) });
      emit(i, 'done');
    }
    let rolledBack = false;
    if (failed >= 0) {
      for (const r of [...reverts].reverse()) {
        await deps.sleep(opts.opMs / 2);
        r.revert();
        emit(r.index, 'done', 'rolled back');
        rolledBack = true;
      }
      for (let k = failed + 1; k < order.ops.length; k++) emit(k, 'skipped');
    }
    if (undo) {
      if (failed < 0) snap.entry.undoneActions = [...new Set([...snap.entry.undoneActions, ...undo.indexes])].sort((a, b) => a - b);
    } else {
      // A rolled-back order leaves nothing to undo: its snapshot is listed with every action undone.
      if (failed >= 0) snap.entry.undoneActions = order.actions.map((_, i) => i);
      snapshotsOf(id).unshift(snap);
    }
    return {
      orderId: order.id,
      backupId: snap.entry.id,
      statuses: states.map((st, index) => ({ orderId: order.id, index, state: st.state, message: st.message })),
      rolledBack,
    };
  }

  function discard(orderId: string): Result<null> {
    orders.delete(orderId);
    return ok(null);
  }

  function gameStatus(instanceId: string): { running: boolean; pids: number[]; reason: string | null } {
    const inst = deps.instance(instanceId);
    if (!opts.gameRunning || !inst || inst.launcher === 'mrpack') return { running: false, pids: [], reason: null };
    return { running: true, pids: [18244], reason: `javaw.exe pid 18244 with --gameDir ${inst.gameDir}` };
  }

  // ── Seeded history (All the Mods 9) ─────────────────────────────────────────

  function seed(instanceId: string) {
    if (instanceId !== SEEDED_HISTORY_INSTANCE || seededFor.has(instanceId)) return;
    seededFor.add(instanceId);
    const H = 3_600_000;
    const list: Snapshot[] = [];
    const add = (agoMs: number, actions: FixAction[], ops: PlannedOp[], undone: number[], files: Array<[string, JarRecord]>, after: Array<[string, string | null]>) => {
      const ms = born - agoMs;
      list.push({
        entry: { id: `${instanceId}/${ms}`, instanceId, createdAtMs: ms, title: title(instanceId, actions, ops), actions, ops, undoneActions: undone },
        dir: snapshotDir(instanceId, ms),
        files: new Map(files.map(([p, j]) => [`files/${p}`, [j]])),
        after: new Map(after),
      });
    };
    const forge = (modId: string, version: string, name: string): MockModSpec => ({ modId, version, name, loader: 'forge', mc: '[1.20.1,1.21)' });

    // 2 h ago: a filler mod disabled; its undo is one rename (Enter may confirm it).
    const off = jarsOf(instanceId)
      .filter((j) => j.depth === 0 && j.disabled)
      .sort((a, b) => a.fileName.localeCompare(b.fileName))[0];
    if (off) {
      const from = off.path.slice(0, -'.disabled'.length);
      add(2 * H, [{ kind: 'disable', jarId: off.id }], [{ actionIndex: 0, op: { op: 'rename', from, to: off.path } }], [], [], [
        [off.path, off.sha1],
        [from, null],
      ]);
    }

    // 1 day ago: Curios API 5.7.0 → 5.9.1 (the current jar); undo removes it and restores 5.7.0.
    const curios = topAt(instanceId, 'mods/curios-forge-5.9.1+1.20.1.jar');
    const curiosV = curios ? mockIdentifiedVersion(curios.sha1) : null;
    if (curios && curiosV) {
      const oldPath = 'mods/curios-forge-5.7.0+1.20.1.jar';
      const old = mockJarAt(oldPath, forge('curios', '5.7.0+1.20.1', 'Curios API'), { mcVersion: '1.20.1', sizeBytes: curios.size - 6144 });
      add(
        26 * H,
        [{ kind: 'replace', jarId: oldPath, versionId: curiosV.id }],
        [
          {
            actionIndex: 0,
            op: {
              op: 'download',
              projectTitle: 'Curios API',
              versionNumber: curiosV.versionNumber,
              sizeBytes: curios.size,
              url: curiosV.files[0]?.url ?? '',
              sha512: curios.sha512,
              dest: curios.path,
              replaces: oldPath,
            },
          },
          { actionIndex: 0, op: { op: 'moveToBackup', path: oldPath } },
        ],
        [],
        [[oldPath, old]],
        [
          [curios.path, curios.sha1],
          [oldPath, null],
        ],
      );
    }

    // 3 days ago: an old JEI removed (restorable), and FastSuite disabled; FastSuite was renamed
    // back by hand since, so undoing that action is refused.
    const fast = topAt(instanceId, 'mods/fastsuite-1.20.1-5.0.1.jar');
    const jeiKeep = topAt(instanceId, 'mods/jei-1.20.1-forge-15.2.0.27.jar');
    if (fast && jeiKeep) {
      const jeiOld = 'mods/jei-1.20.1-forge-15.1.0.11.jar';
      add(
        74 * H,
        [
          { kind: 'removeDuplicate', keep: jeiKeep.id, remove: jeiOld },
          { kind: 'disable', jarId: fast.id },
        ],
        [
          { actionIndex: 0, op: { op: 'moveToBackup', path: jeiOld } },
          { actionIndex: 1, op: { op: 'rename', from: fast.path, to: `${fast.path}.disabled` } },
        ],
        [],
        [[jeiOld, mockJarAt(jeiOld, forge('jei', '15.1.0.11', 'Just Enough Items'), { mcVersion: '1.20.1', sizeBytes: 1_402_880 })]],
        [
          [jeiOld, null],
          [`${fast.path}.disabled`, fast.sha1],
          [fast.path, null],
        ],
      );
    }

    // 9 days ago: two renderers disabled, both undone since.
    const rub = topAt(instanceId, 'mods/rubidium-0.7.1.jar');
    const emb = topAt(instanceId, 'mods/embeddium-0.3.18+mc1.20.1.jar');
    if (rub && emb) {
      add(
        221 * H,
        [
          { kind: 'disable', jarId: rub.id },
          { kind: 'disable', jarId: emb.id },
        ],
        [
          { actionIndex: 0, op: { op: 'rename', from: rub.path, to: `${rub.path}.disabled` } },
          { actionIndex: 1, op: { op: 'rename', from: emb.path, to: `${emb.path}.disabled` } },
        ],
        [0, 1],
        [],
        [],
      );
    }
    backups.set(instanceId, list);
  }

  return {
    jarsOf,
    plan,
    planUndo,
    execute,
    discard,
    listBackups,
    gameStatus,
    /** Test hook: every stored order is now older than 15 minutes. */
    expireAll() {
      for (const s of orders.values()) s.plannedAt -= ORDER_TTL_MS + 1;
    },
    /** Test hook: ids of the stored (planned, not executed or discarded) orders. */
    storedOrders: () => [...orders.keys()],
  };
}
