/**
 * Files a `.mrpack` index declares (`ScanResult.declared`, CONTRACTS invariant 15), checked with
 * Modrinth data only — they are never downloaded, so there is no jar metadata to read. Override
 * jars (`overrides/`, `client-overrides/`, `server-overrides/`) are ordinary `JarRecord`s and get
 * every other static check. Nothing here runs without a Modrinth context, or when it is offline.
 * A declared file is identified by its sha1 in `ModrinthContext.versions` (`declaredMatch`).
 *
 * Culprit of a declared file: `JarRef { jarId: <index path>, fileName: <basename> }`, no `modId`
 * (`declaredRef`). The index path (`mods/sodium-0.5.8.jar`) is relative to the instance folder
 * the pack would install into and never collides with an override jar id (those start with
 * `overrides/`, `client-overrides/` or `server-overrides/`). Findings carry NO fixes and no
 * `missingModIds` (packs are read-only, so `enrichFindings` adds nothing either). They carry
 * `packEdits` for the pack's fixed copy instead (`src/core/packfix`): E-WRONG-LOADER / E-MC-RANGE
 * → replace with the context's newer compatible version of the same project (when there is one)
 * and remove; E-MISSING-DEP → add the dependency project.
 *
 * - **E-WRONG-LOADER** (error), mods only (path under `mods/`): the version lists at least one mod
 *   loader and none the pack runs. Accepted: the pack loader's Modrinth names (`modrinthLoaders`:
 *   Quilt also accepts `fabric`, NeoForge on 1.20.1 also `forge`), plus `neoforge` for Forge on
 *   1.20.1 (NeoForge 1.20.1 ↔ Forge 47.x, CONTRACTS finding-code table). A Quilt-only version on
 *   a Fabric pack is reported (Fabric does not read quilt.mod.json). Unknown or vanilla pack
 *   loader → nothing. Versions listing only non-mod "loaders" (`datapack`, `minecraft`, shader
 *   loaders) → nothing.
 * - **E-MC-RANGE**, mods only: the version's `gameVersions` do not include the pack's MC version.
 *   **error**; lowered to **warning** when the list holds another release of the same line
 *   (`1.20` / `1.20.2` for a `1.20.1` pack, `26.1` for `26.1.2`): Modrinth lists what the author
 *   tagged, and the jar's own range often admits the neighbour. Unknown MC or empty list → nothing.
 * - **E-MISSING-DEP**, lowered to **warning** for declared files (the code keeps its `E-` name;
 *   the severity field says warning): Modrinth knows project ids only, and a jar it cannot see
 *   into may provide the dependency under another name. A `required` Modrinth dependency (by
 *   project id) of an identified declared file is not installed on a side where that file is.
 *   Present on a side = a declared file (env not `unsupported` for that side) or an active
 *   top-level override jar for that side (`overrides/` both, `client-overrides/` client,
 *   `server-overrides/` server) identified as that project or as a project that provides it
 *   (`PROJECT_PROVIDES`: Quilted Fabric API provides Fabric API), or an override jar whose
 *   relevant mod ids / `provides` equal the project's slug (`-` ≡ `_`, case-insensitive) when the
 *   project is in `ctx.projects`. When any file on that side is unknown (lookup failed, no sha1),
 *   the side is skipped: it could be the provider. Skipped too: dependencies with only a version
 *   id or on the file's own project; every dependency of a version whose mod loaders exclude the
 *   pack's (it is another loader's build; E-WRONG-LOADER covers it under `mods/`); a dependency
 *   that exists for one loader family only (`LOADER_FAMILY_DEPS`: Fabric API, Quilted Fabric API,
 *   Fabric Language Kotlin) when the pack's loader is not in it (a multi-loader version lists
 *   Fabric API for its Fabric build). Unknown / vanilla pack loader → no loader-based skipping.
 * - When two index entries share a path, the last one is checked (`declaredFiles`).
 * - **I-NOT-ON-MODRINTH** (info): every declared file not identified (`declaredMatch` →
 *   `missing`; failed lookups are unknown, not missing) in ONE aggregate finding with a stable id
 *   (`findingId('I-NOT-ON-MODRINTH', [], 'declared-aggregate')`), separate from the override jars'
 *   aggregate.
 *
 * Every finding's evidence: a `note` naming the index entry, `note`s with the Modrinth facts
 * (version, loaders, game versions, dependency), and the pack note. Ids: `findingId(code,
 * [index path], 'declared…')`, stable across rescans.
 */
import type { DeclaredFile, JarRecord, MrProject, MrVersion, Side } from '../../bindings';
import { findingId } from '../crash/id';
import type { Check, CheckInput, Evidence, Finding, JarRef, ModrinthContext, PackContext, PackEditSuggestion } from '../model';
import { declaredMatch, downloadFile, modrinthLoaders, type JarMatch } from '../modrinth';
import { addProjectEdit, removeDeclaredEdit, replaceDeclaredEdit } from '../packfix';
import { describeLoader, LOADER_NAMES } from '../pack';
import { versionApi } from '../version';
import { contextFor, type CheckContext } from './context';
import { listText, makeFinding, plural } from './evidence';

// ---- shared helpers (also used by mrpackDownload.ts and the report) -----------------------------

function basename(path: string): string {
  const parts = path.split('/');
  return parts[parts.length - 1] || path;
}

/** Culprit for a declared file: its index path as the id, the basename as the file name. */
export function declaredRef(file: DeclaredFile): JarRef {
  return { jarId: file.path, fileName: basename(file.path) };
}

/**
 * Declared files of the input, de-duplicated by path, sorted by path. When two index entries share
 * a path the LAST one wins: a launcher installing the pack writes them in order, so the last
 * overwrites the first (Rust keeps the last too and reports the duplicate as a `ScanIssue`).
 */
export function declaredFiles(input: CheckInput): DeclaredFile[] {
  const byPath = new Map<string, DeclaredFile>();
  for (const f of input.scan.declared ?? []) {
    if (!f || typeof f.path !== 'string' || f.path.length === 0) continue;
    byPath.set(f.path, f);
  }
  return [...byPath.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** `note` naming the index entry. */
export function indexNote(file: DeclaredFile): Evidence {
  const sha1 = typeof file.sha1 === 'string' && file.sha1.trim().length > 0 ? file.sha1.trim().toLowerCase() : 'missing';
  return { kind: 'note', text: `modrinth.index.json lists ${file.path} (sha1 ${sha1}).` };
}

// ---- rules -------------------------------------------------------------------------------------

/** Modrinth loader names that are mod loaders (others: `datapack`, `minecraft`, shader loaders…). */
const MOD_LOADERS: ReadonlySet<string> = new Set([
  'forge',
  'neoforge',
  'fabric',
  'quilt',
  'liteloader',
  'modloader',
  'rift',
  'legacy-fabric',
  'babric',
  'bta-babric',
  'ornithe',
  'nilloader',
  'java-agent',
]);

function isModPath(path: string): boolean {
  return path.toLowerCase().startsWith('mods/');
}

/** Modrinth loader names the pack accepts; empty when unknown / vanilla (report nothing). */
export function acceptedLoaders(pack: PackContext): Set<string> {
  const out = new Set(modrinthLoaders(pack));
  // NeoForge 1.20.1 ↔ Forge 47.x counts as compatible both ways (finding-code table).
  if (pack.loader?.kind === 'forge' && pack.mcVersion?.trim() === '1.20.1') out.add('neoforge');
  return out;
}

/** `1.20.1` → `1.20`; `26.1.2` → `26.1`; snapshots, pre-releases → null. */
function releaseLine(mc: string): string | null {
  const m = /^(\d+)\.(\d+)(?:\.\d+)?$/.exec(mc.trim());
  return m ? `${m[1]}.${m[2]}` : null;
}

function sameMc(a: string, b: string): boolean {
  if (a.trim() === b.trim()) return true;
  const na = versionApi.normalizeMinecraft(a);
  return na !== null && na === versionApi.normalizeMinecraft(b);
}

function versionLabel(v: MrVersion, project: MrProject | undefined): string {
  return `${project?.title ?? `Modrinth project ${v.projectId}`} ${v.versionNumber} (version ${v.id})`;
}

function versionNote(v: MrVersion, project: MrProject | undefined): Evidence {
  const loaders = v.loaders.length > 0 ? v.loaders.join(', ') : 'none listed';
  const games = v.gameVersions.length > 0 ? listText(v.gameVersions, 12) : 'none listed';
  return { kind: 'note', text: `Modrinth: ${versionLabel(v, project)}; loaders: ${loaders}; game versions: ${games}.` };
}

function displayName(file: DeclaredFile, project: MrProject | undefined): string {
  return project?.title?.trim() || basename(file.path);
}

interface Identified {
  file: DeclaredFile;
  version: MrVersion;
  project: MrProject | undefined;
}

function sideInstalls(file: DeclaredFile, side: Side): boolean {
  const env = side === 'client' ? file.client : file.server;
  return (env ?? '').trim().toLowerCase() !== 'unsupported';
}

function overrideSides(jar: JarRecord): readonly Side[] {
  if (jar.id.startsWith('client-overrides/')) return ['client'];
  if (jar.id.startsWith('server-overrides/')) return ['server'];
  return ['client', 'server'];
}

function sha1Key(sha1: unknown): string {
  return typeof sha1 === 'string' ? sha1.trim().toLowerCase() : '';
}

function normalizeId(id: string): string {
  return id.trim().toLowerCase().replace(/-/g, '_');
}

/**
 * Modrinth projects whose files also provide other projects (by project id): a required
 * dependency on a provided project is met by the provider. Quilted Fabric API (`qvIfYCYJ`) ships
 * Fabric API (`P7dR8mSH`) under Fabric API's mod ids.
 */
export const PROJECT_PROVIDES: Readonly<Record<string, readonly string[]>> = {
  qvIfYCYJ: ['P7dR8mSH'],
};

/**
 * Dependency projects that exist for one loader family only (Modrinth loader names). A
 * multi-loader version lists them for its Fabric/Quilt build; on a pack whose loader is not in
 * the family the dependency does not apply.
 */
export const LOADER_FAMILY_DEPS: Readonly<Record<string, readonly string[]>> = {
  P7dR8mSH: ['fabric', 'quilt'], // Fabric API
  qvIfYCYJ: ['quilt'], // Quilted Fabric API
  Ha28R6CL: ['fabric', 'quilt'], // Fabric Language Kotlin
};

/** The version's mod loaders (lower-cased; `datapack`, `minecraft`, shader loaders left out). */
function modLoadersOf(v: MrVersion): string[] {
  return v.loaders.map((l) => l.trim().toLowerCase()).filter((l) => MOD_LOADERS.has(l));
}

/** What is installed on one side: identified project ids, mod ids of override jars, unknowns. */
interface SideView {
  projects: Set<string>;
  modIds: Set<string>;
  /** A file on this side could not be identified because its lookup failed / it has no hash. */
  unknown: boolean;
}

function sideViews(ctx: CheckContext, mr: ModrinthContext, files: readonly DeclaredFile[]): Record<Side, SideView> {
  const views: Record<Side, SideView> = {
    client: { projects: new Set(), modIds: new Set(), unknown: false },
    server: { projects: new Set(), modIds: new Set(), unknown: false },
  };
  const failed = new Set(mr.failed.map((s) => s.toLowerCase()));
  const note = (side: Side, sha1: string): void => {
    const v = sha1.length > 0 ? mr.versions[sha1] : undefined;
    if (v) {
      views[side].projects.add(v.projectId);
      for (const p of PROJECT_PROVIDES[v.projectId] ?? []) views[side].projects.add(p);
    } else if (sha1.length === 0 || failed.has(sha1)) views[side].unknown = true;
  };
  for (const file of files) {
    for (const side of ['client', 'server'] as const) if (sideInstalls(file, side)) note(side, sha1Key(file.sha1));
  }
  for (const jar of ctx.topLevel) {
    for (const side of overrideSides(jar)) {
      note(side, sha1Key(jar.sha1));
      for (const m of ctx.relevant(jar)) for (const id of [m.modId, ...m.provides]) views[side].modIds.add(normalizeId(id));
    }
  }
  return views;
}

function provided(view: SideView, projectId: string, mr: ModrinthContext): boolean {
  if (view.projects.has(projectId)) return true;
  const slug = mr.projects[projectId]?.slug;
  return !!slug && view.modIds.has(normalizeId(slug));
}

function wrongLoader(ctx: CheckContext, it: Identified): Finding | null {
  const accepted = acceptedLoaders(ctx.pack);
  if (accepted.size === 0 || !isModPath(it.file.path)) return null;
  const loaders = it.version.loaders.map((l) => l.trim().toLowerCase());
  if (modLoadersOf(it.version).length === 0 || loaders.some((l) => accepted.has(l))) return null;
  const name = displayName(it.file, it.project);
  const packLoader = describeLoader(ctx.pack);
  const loaderName = ctx.pack.loader ? LOADER_NAMES[ctx.pack.loader.kind] : packLoader;
  const listed = loaders.filter((l) => MOD_LOADERS.has(l)).join(', ');
  return makeFinding({
    code: 'E-WRONG-LOADER',
    severity: 'error',
    title: `${name} is made for ${listed}, not this pack's loader`,
    explanation:
      `The .mrpack index installs ${it.file.path}, which Modrinth identifies as ${versionLabel(it.version, it.project)}, ` +
      `published for ${listed} only. The pack runs ${packLoader}, so the loader will not load it (or refuses to start) ` +
      `and anything that needs it breaks. The pack author should switch to the ${loaderName} build of ${name}.`,
    culprits: [declaredRef(it.file)],
    evidence: [indexNote(it.file), versionNote(it.version, it.project), ctx.packNote],
    fixes: [],
    discriminator: 'declared',
  });
}

function mcRange(ctx: CheckContext, it: Identified): Finding | null {
  const mc = ctx.pack.mcVersion?.trim();
  const games = it.version.gameVersions;
  if (!mc || games.length === 0 || !isModPath(it.file.path)) return null;
  if (games.some((g) => sameMc(g, mc))) return null;
  const line = releaseLine(mc);
  const neighbour = line !== null && games.some((g) => releaseLine(g) === line);
  const name = displayName(it.file, it.project);
  const listed = listText(games, 6);
  return makeFinding({
    code: 'E-MC-RANGE',
    severity: neighbour ? 'warning' : 'error',
    title: `${name} is listed for Minecraft ${listed}, not ${mc}`,
    explanation:
      `The .mrpack index installs ${it.file.path} (${versionLabel(it.version, it.project)}), which Modrinth lists for ` +
      `Minecraft ${listed}, while the pack runs ${mc}. ` +
      (neighbour
        ? `It is listed for another release of the same line, so the jar's own range may still accept ${mc}; if the game refuses it, the pack needs the build made for ${mc}.`
        : `The loader will most likely refuse it. The pack needs the build of ${name} made for ${mc}.`),
    culprits: [declaredRef(it.file)],
    evidence: [indexNote(it.file), versionNote(it.version, it.project), ctx.packNote],
    fixes: [],
    discriminator: 'declared',
  });
}

function missingDeps(ctx: CheckContext, mr: ModrinthContext, it: Identified, views: Record<Side, SideView>): Finding[] {
  const out: Finding[] = [];
  const accepted = acceptedLoaders(ctx.pack);
  // A version not made for the pack's loader family (E-WRONG-LOADER under mods/) lists the
  // dependencies of another loader's build: none of them apply here.
  const versionLoaders = modLoadersOf(it.version);
  if (accepted.size > 0 && versionLoaders.length > 0 && !versionLoaders.some((l) => accepted.has(l))) return out;
  const seen = new Set<string>();
  for (const dep of it.version.dependencies) {
    const pid = dep.projectId?.trim();
    if (dep.dependencyType !== 'required' || !pid || pid === it.version.projectId || seen.has(pid)) continue;
    seen.add(pid);
    // A multi-loader version lists e.g. Fabric API for its Fabric build: not needed on Forge.
    const family = LOADER_FAMILY_DEPS[pid];
    if (accepted.size > 0 && family && !family.some((l) => accepted.has(l))) continue;
    const sides = (['client', 'server'] as const).filter(
      (side) => sideInstalls(it.file, side) && !views[side].unknown && !provided(views[side], pid, mr),
    );
    if (sides.length === 0) continue;
    const name = displayName(it.file, it.project);
    const depProject = mr.projects[pid];
    const depName = depProject?.title?.trim() || `Modrinth project ${pid}`;
    const where = sides.length === 2 ? '' : ` on the ${sides[0]}`;
    out.push({
      ...makeFinding({
        code: 'E-MISSING-DEP',
        // Warning, not error: Modrinth only knows project ids, and a jar it cannot see into (a
        // file hosted elsewhere, a fork, a bundle) may provide the dependency under another name.
        severity: 'warning',
        title: `${name} requires ${depName}, which the pack does not seem to include${where}`,
        explanation:
          `Modrinth lists ${depName} as a required dependency of ${versionLabel(it.version, it.project)} (${it.file.path}), ` +
          `and no file of the .mrpack index or its override jars is ${depName} as far as Modrinth can tell${where}. ` +
          `Another file may still provide it under a different name; if not, the loader refuses to start with a missing ` +
          `mandatory dependency and the pack needs ${depName} added.`,
        culprits: [declaredRef(it.file)],
        evidence: [
          indexNote(it.file),
          versionNote(it.version, it.project),
          {
            kind: 'note',
            text: `Required dependency: ${depName}${depProject?.slug ? ` (${depProject.slug})` : ''}, project ${pid}${dep.versionId ? `, version ${dep.versionId}` : ''}.`,
          },
          ctx.packNote,
        ],
        fixes: [],
        discriminator: `declared:${pid}`,
      }),
      // The fixed copy can add it (the UI resolves the project's newest compatible version).
      packEdits: [addProjectEdit(pid, depName)],
    });
  }
  return out;
}

/**
 * Fixed-copy edits for a declared file built for another loader or Minecraft version: the newer
 * compatible version of the same project when the context has one (with a download file, listing
 * the pack's loader and MC version), then removing the file.
 */
function declaredFileEdits(ctx: CheckContext, file: DeclaredFile, match: JarMatch): PackEditSuggestion[] {
  const out: PackEditSuggestion[] = [];
  if (match.state === 'update' && downloadFile(match.update)) {
    const loaders = new Set(modrinthLoaders(ctx.pack));
    const mc = ctx.pack.mcVersion?.trim();
    const fits = match.update.loaders.some((l) => loaders.has(l.trim().toLowerCase())) && !!mc && match.update.gameVersions.some((g) => g.trim() === mc);
    if (fits) out.push(replaceDeclaredEdit(file, match.update));
  }
  out.push(removeDeclaredEdit(file));
  return out;
}

export const TITLE_DECLARED_NOT_ON_MODRINTH = 'Listed in the .mrpack index but not on Modrinth';

function notOnModrinth(ctx: CheckContext, missing: readonly DeclaredFile[]): Finding | null {
  if (missing.length === 0) return null;
  const paths = missing.map((f) => f.path);
  const finding = makeFinding({
    code: 'I-NOT-ON-MODRINTH',
    severity: 'info',
    title: TITLE_DECLARED_NOT_ON_MODRINTH,
    explanation:
      `${plural(missing.length, 'file')} that the .mrpack index downloads did not match any file on Modrinth by hash: ` +
      `${listText(paths, 8)}. They are probably hosted elsewhere (see the download URLs). The app cannot check their ` +
      `loader, Minecraft version or dependencies.`,
    culprits: missing.map(declaredRef),
    evidence: [{ kind: 'note', text: `Not found on Modrinth: ${paths.join(', ')}.` }, ctx.packNote],
    fixes: [],
    discriminator: '',
  });
  // One aggregate per pack: the id must not change when the set of files does.
  return { ...finding, id: findingId('I-NOT-ON-MODRINTH', [], 'declared-aggregate') };
}

export const mrpackDeclaredCheck: Check = {
  id: 'mrpack-declared',
  codes: ['E-WRONG-LOADER', 'E-MC-RANGE', 'E-MISSING-DEP', 'I-NOT-ON-MODRINTH'],
  run(input) {
    const mr = input.modrinth;
    const files = declaredFiles(input);
    if (!mr || mr.offline || files.length === 0) return [];
    const ctx = contextFor(input);
    const views = sideViews(ctx, mr, files);
    const out: Finding[] = [];
    const missing: DeclaredFile[] = [];
    for (const file of files) {
      const match = declaredMatch(file, mr);
      if (match.state === 'missing') missing.push(file);
      if (match.state !== 'matched' && match.state !== 'update') continue;
      const it: Identified = { file, version: match.version, project: match.project ?? undefined };
      const loader = wrongLoader(ctx, it);
      if (loader) out.push({ ...loader, packEdits: declaredFileEdits(ctx, file, match) });
      const range = mcRange(ctx, it);
      if (range) out.push({ ...range, packEdits: declaredFileEdits(ctx, file, match) });
      out.push(...missingDeps(ctx, mr, it, views));
    }
    const aggregate = notOnModrinth(ctx, missing);
    if (aggregate) out.push(aggregate);
    return out;
  },
};
