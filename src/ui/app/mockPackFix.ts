/**
 * "Save fixed copy…" in the browser preview (mockIpc.ts): `plan_pack_fix` and `save_fixed_pack`
 * over the mock packs, with the checks and wording of the Rust planner (src-tauri/src/mrpack/
 * fixcopy.rs) where the mock data allows. Nothing is written; a saved copy is a fake Downloads
 * path. Dev only, like the rest of the mock backend.
 *
 * So every kind of edit shows on Explorer Kit 2.1 (`MOCK_PICKED_PACK`), Modrinth answers two
 * extra facts about its index:
 * - its ImmediatelyFast file (built for 1.21.1, E-MC-RANGE) has a newer 1.20.1 build, so the
 *   finding offers Replace as well as Remove;
 * - its Xaero's Minimap version requires Cloth Config API, which the pack lacks (E-MISSING-DEP,
 *   Add Cloth Config API, resolved through `modrinth_project_versions`).
 */
import type { AppError, HashLookup, Instance, MrVersion, PackEdit, PackFixOp, PackFixPlan, SavedPack } from '../../bindings';
import type { Result } from './ipc';
import { MOCK_PICKED_PACK, mockDeclared, mockDeclaredFiles } from './mockData';
import { mockIdentify, mockResolveModId, mockVersionById } from './mockModrinth';

const ok = <T>(data: T): Result<T> => ({ status: 'ok', data });
const err = (kind: AppError['kind'], message: string): Result<never> => ({ status: 'error', error: { kind, message, path: null } });

const PLAN_TTL_MS = 15 * 60 * 1000;
const CDN = 'https://cdn.modrinth.com/';

function declaredSha1(instanceId: string, needle: string): string | null {
  return (mockDeclaredFiles()[instanceId] ?? []).find((d) => d.file.path.includes(needle))?.file.sha1.toLowerCase() ?? null;
}

/** The newer 1.20.1 build of Explorer Kit's ImmediatelyFast (same project as its file). */
function immediatelyFastUpdate(): { sha1: string; version: MrVersion } | null {
  const sha1 = declaredSha1(MOCK_PICKED_PACK.id, 'ImmediatelyFast');
  const current = sha1 ? mockIdentify([sha1]).found[sha1] : undefined;
  if (!sha1 || !current) return null;
  const id = 'IFst1201';
  const filename = 'ImmediatelyFast-Fabric-1.2.21+1.20.1.jar';
  return {
    sha1,
    version: {
      ...current,
      id,
      versionNumber: '1.2.21+1.20.1',
      name: 'ImmediatelyFast 1.2.21+1.20.1',
      gameVersions: ['1.20.1'],
      loaders: ['fabric'],
      datePublished: '2024-09-12T10:21:07.000000Z',
      files: [
        {
          url: `${CDN}data/${current.projectId}/versions/${id}/${encodeURIComponent(filename)}`,
          filename,
          size: 498_312,
          primary: true,
          sha1: 'f'.repeat(40),
          sha512: 'e'.repeat(128),
          fileType: null,
        },
      ],
    },
  };
}

/** `modrinth_identify` plus Explorer Kit's Xaero's Minimap → Cloth Config dependency. */
export function packFixIdentify(lookup: HashLookup): HashLookup {
  const sha1 = declaredSha1(MOCK_PICKED_PACK.id, 'Xaeros');
  const cloth = mockResolveModId('cloth_config');
  const hit = sha1 ? lookup.found[sha1] : undefined;
  if (!sha1 || !cloth || !hit) return lookup;
  const dep = { versionId: null, projectId: cloth.id, fileName: null, dependencyType: 'required' };
  return { ...lookup, found: { ...lookup.found, [sha1]: { ...hit, dependencies: [...hit.dependencies, dep] } } };
}

/** `modrinth_find_updates` plus the ImmediatelyFast 1.20.1 build (Fabric 1.20.1 filters only). */
export function packFixUpdates(lookup: HashLookup, sha1s: string[], loaders: string[], gameVersions: string[]): HashLookup {
  const u = immediatelyFastUpdate();
  if (!u || !sha1s.some((s) => s.toLowerCase() === u.sha1) || !loaders.includes('fabric') || !gameVersions.includes('1.20.1')) return lookup;
  return { ...lookup, found: { ...lookup.found, [u.sha1]: u.version } };
}

function versionById(id: string): MrVersion | null {
  const u = immediatelyFastUpdate();
  if (u?.version.id === id) return u.version;
  return mockVersionById(id)?.version ?? null;
}

function sizeText(n: number): string {
  return n >= 1024 * 1024 ? `${(n / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.ceil(n / 1024))} KB`;
}

function key(e: PackEdit): string {
  return e.kind === 'removeOverride' ? `override:${e.entry}` : e.kind === 'addDependency' ? `add:${e.versionId}` : `declared:${e.path}`;
}

interface Stored {
  plan: PackFixPlan;
  expires: number;
}

export interface MockPackFixEngine {
  plan(instance: Instance | undefined, edits: PackEdit[], jarPaths: readonly string[]): Result<PackFixPlan>;
  save(planId: string): Result<SavedPack | null>;
  /** Test hooks. */
  cancelNextSave: boolean;
  failNextSave: AppError | null;
  saved(): readonly SavedPack[];
  /** Expire every stored plan (as if 15 minutes passed). */
  expireAll(): void;
}

export function createMockPackFix(now: () => number): MockPackFixEngine {
  const plans = new Map<string, Stored>();
  const saved: SavedPack[] = [];
  let n = 0;

  const engine: MockPackFixEngine = {
    cancelNextSave: false,
    failNextSave: null,
    saved: () => saved,
    expireAll: () => {
      for (const p of plans.values()) p.expires = 0;
    },

    plan(instance, edits, jarPaths) {
      if (!instance) return err('notFound', 'This pack is no longer open. Open it again, then review the edits.');
      if (instance.launcher !== 'mrpack') return err('invalid', `Invalid request: "${instance.name}" is not an opened .mrpack file; only packs are saved as fixed copies.`);
      if (edits.length === 0) return err('invalid', 'Invalid request: there are no edits to apply to the copy.');
      const declared = mockDeclared(instance.id);
      const paths = new Set(declared.map((d) => d.path));
      const touched = new Map<string, string>();
      const newPaths: Array<{ path: string; label: string }> = [];
      const ops: PackFixOp[] = [];
      const refuse = (label: string, why: string) => err('invalid', `Invalid request: ${label}: ${why}.`);
      for (const e of edits) {
        const subject = e.kind === 'removeOverride' ? e.entry : e.kind === 'addDependency' ? e.versionId : e.path;
        const label = e.kind === 'replaceDeclared' ? `Replace ${subject}` : e.kind === 'addDependency' ? `Add version ${subject}` : `Remove ${subject}`;
        const other = touched.get(key(e));
        if (other) return refuse(label, `"${other}" already changes ${subject}; keep only one of them`);
        touched.set(key(e), label);
        if (e.kind === 'removeDeclared') {
          if (!paths.has(e.path)) return refuse(label, "the pack's index lists no file at that path");
          ops.push({ kind: 'remove', subject: e.path, detail: "Left out of the copy's index, so launchers no longer download it.", url: null });
          continue;
        }
        if (e.kind === 'removeOverride') {
          if (!jarPaths.includes(e.entry)) {
            return refuse(label, "that is not a jar directly in the mods folder of the pack's overrides, client-overrides or server-overrides");
          }
          ops.push({ kind: 'removeOverride', subject: e.entry, detail: 'Left out of the copy: the jar is not copied, so installing the copy does not add it.', url: null });
          continue;
        }
        const v = versionById(e.versionId);
        if (!v) return refuse(label, `Modrinth does not know version ${e.versionId}`);
        const file = v.files.find((f) => f.primary) ?? v.files[0];
        if (!file || !file.url.startsWith(CDN) || file.size === null) return refuse(label, 'Modrinth did not report a usable download for this version');
        if (!v.loaders.includes('fabric') || !v.gameVersions.includes(instance.mcVersion ?? '')) {
          return refuse(label, `version ${v.versionNumber} does not list this pack's loader and Minecraft ${instance.mcVersion ?? 'version'}`);
        }
        const source = `${v.name} (${sizeText(file.size)}) from cdn.modrinth.com`;
        if (e.kind === 'replaceDeclared') {
          const old = declared.find((d) => d.path === e.path);
          if (!old) return refuse(label, "the pack's index lists no file at that path");
          const next = `${e.path.slice(0, e.path.lastIndexOf('/') + 1)}${file.filename}`;
          const env = old.client || old.server ? `keeps the entry's env (client ${old.client ?? 'unset'}, server ${old.server ?? 'unset'})` : 'keeps having no env, so launchers install it on both client and server';
          newPaths.push({ path: next, label });
          ops.push({ kind: 'replace', subject: e.path, detail: `Becomes ${next}: ${source}; ${env}.`, url: file.url });
        } else {
          const next = `mods/${file.filename}`;
          newPaths.push({ path: next, label: `Add ${v.name}` });
          ops.push({ kind: 'add', subject: next, detail: `New index entry: ${source}. It has no env, so launchers install it on both client and server.`, url: file.url });
        }
      }
      const removed = new Set(edits.flatMap((e) => (e.kind === 'removeDeclared' || e.kind === 'replaceDeclared' ? [e.path.toLowerCase()] : [])));
      for (const { path, label } of newPaths) {
        const clash = [...paths].some((p) => !removed.has(p.toLowerCase()) && p.toLowerCase() === path.toLowerCase()) || newPaths.filter((q) => q.path.toLowerCase() === path.toLowerCase()).length > 1;
        if (clash) return refuse(label, `the copy would list ${path.toLowerCase()} more than once (letter case ignored); remove the other entry first`);
      }
      for (const [id, p] of plans) if (p.plan.instanceId === instance.id) plans.delete(id);
      const id = (++n).toString(16).padStart(32, '0');
      const fileName = instance.root.slice(instance.root.lastIndexOf('\\') + 1);
      const plan: PackFixPlan = { id, instanceId: instance.id, packFileName: fileName, ops, warnings: [] };
      plans.set(id, { plan, expires: now() + PLAN_TTL_MS });
      return ok(plan);
    },

    save(planId) {
      const p = plans.get(planId);
      if (!p || p.expires <= now()) {
        plans.delete(planId);
        return err('notFound', 'Could not find this fixed-copy plan: it expired or was already used — review the edits again.');
      }
      if (engine.cancelNextSave) {
        engine.cancelNextSave = false;
        return ok(null);
      }
      if (engine.failNextSave) {
        const e = engine.failNextSave;
        engine.failNextSave = null;
        return { status: 'error', error: e };
      }
      plans.delete(planId);
      const stem = p.plan.packFileName.replace(/\.mrpack$/i, '');
      const fileName = `${stem} (fixed).mrpack`;
      const s: SavedPack = { path: `C:\\Users\\alex\\Downloads\\${fileName}`, fileName };
      saved.push(s);
      return ok(s);
    },
  };
  return engine;
}
