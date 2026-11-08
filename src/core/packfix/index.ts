/**
 * Edits for the fixed copy of an opened `.mrpack` ("Save fixed copy…"). Pure.
 *
 * A pack is read-only (CONTRACTS invariant 15): `runChecks` strips the normal instance fixes
 * from its findings and adds `Finding.packEdits` instead (`forPack`). Rust plans the edits
 * (`plan_pack_fix`) and writes a NEW `.mrpack`; the opened file is never changed.
 *
 * - Declared files (`mrpackDeclared.ts` attaches these itself, it knows the Modrinth facts):
 *   E-WRONG-LOADER / E-MC-RANGE → `replaceDeclared` with the newer compatible version of the same
 *   project when the Modrinth context has one (`declaredMatch` state `update`, with a
 *   `downloadFile`), then `removeDeclared`; E-MISSING-DEP → `addProject` (the UI resolves the
 *   project's newest compatible version into an `addDependency`).
 * - Override jars (`overridePackEdits`): E-WRONG-LOADER and W-CORRUPT-JAR → `removeOverride` for
 *   each culprit that is an override jar; E-MISSING-DEP at **error** severity (truly missing, not
 *   the warning a pack gets while its downloads can't be confirmed) → `removeOverride` of the jar
 *   that needs it; E-DUP-ID → `removeOverride` for each copy its `removeDuplicate` fixes remove.
 *   Only top-level jars directly in an override `mods/` folder qualify (Rust refuses others).
 */
import type { DeclaredFile, JarRecord, MrVersion, PackEdit } from '../../bindings';
import type { CheckInput, Finding, PackEditSuggestion } from '../model';

const OVERRIDE_DIRS = ['overrides/', 'client-overrides/', 'server-overrides/'] as const;

function basename(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? path : path.slice(i + 1);
}

/** A jar directly in `overrides/mods/`, `client-overrides/mods/` or `server-overrides/mods/`. */
export function isOverrideJarPath(path: string): boolean {
  const dir = OVERRIDE_DIRS.find((d) => path.startsWith(d));
  if (!dir) return false;
  const rest = path.slice(dir.length);
  return rest.length > 5 && rest.slice(0, 5).toLowerCase() === 'mods/' && !rest.slice(5).includes('/') && rest.toLowerCase().endsWith('.jar');
}

export function removeDeclaredEdit(file: DeclaredFile): PackEditSuggestion {
  return { kind: 'edit', label: `Remove ${basename(file.path)}`, edit: { kind: 'removeDeclared', path: file.path } };
}

export function replaceDeclaredEdit(file: DeclaredFile, update: MrVersion): PackEditSuggestion {
  return {
    kind: 'edit',
    label: `Replace with ${update.versionNumber}`,
    edit: { kind: 'replaceDeclared', path: file.path, versionId: update.id },
  };
}

export function addProjectEdit(projectId: string, title: string): PackEditSuggestion {
  return { kind: 'addProject', label: `Add ${title}`, projectId, title };
}

export function removeOverrideEdit(jar: JarRecord): PackEditSuggestion {
  return { kind: 'edit', label: `Remove ${jar.fileName}`, edit: { kind: 'removeOverride', entry: jar.path } };
}

/**
 * What an edit changes, for "one edit per subject" (the same keys Rust uses): a declared path, an
 * override entry, or an added version.
 */
export function packEditKey(edit: PackEdit): string {
  switch (edit.kind) {
    case 'removeDeclared':
    case 'replaceDeclared':
      return `declared:${edit.path}`;
    case 'removeOverride':
      return `override:${edit.entry}`;
    case 'addDependency':
      return `add:${edit.versionId}`;
  }
}

/** Identity of a suggestion (for de-duplication and "already chosen"). */
export function suggestionKey(s: PackEditSuggestion): string {
  return s.kind === 'addProject' ? `project:${s.projectId}` : JSON.stringify(s.edit);
}

function overrideJar(input: CheckInput, jarId: string): JarRecord | null {
  const jar = input.scan.jars.find((j) => j.id === jarId);
  return jar && jar.depth === 0 && isOverrideJarPath(jar.path) ? jar : null;
}

/** `removeOverride` suggestions for an override-jar finding (see the module docs). */
export function overridePackEdits(f: Finding, input: CheckInput): PackEditSuggestion[] {
  let ids: string[] = [];
  switch (f.code) {
    case 'E-WRONG-LOADER':
    case 'W-CORRUPT-JAR':
      ids = f.culprits.map((c) => c.jarId);
      break;
    case 'E-MISSING-DEP':
      if (f.severity === 'error') ids = f.culprits.map((c) => c.jarId);
      break;
    case 'E-DUP-ID':
      ids = f.fixes.flatMap((x) => (x.kind === 'removeDuplicate' ? [x.remove] : []));
      break;
    default:
      return [];
  }
  const out: PackEditSuggestion[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    const jar = overrideJar(input, id);
    if (!jar || seen.has(jar.path)) continue;
    seen.add(jar.path);
    out.push(removeOverrideEdit(jar));
  }
  return out;
}

/**
 * A finding as a pack shows it: no instance fixes (the pack is read-only), plus the edits its
 * fixed copy can make (existing `packEdits` first, then override-jar removals; no duplicates).
 */
export function forPack(f: Finding, input: CheckInput): Finding {
  const extra = overridePackEdits(f, input);
  const base = f.fixes.length > 0 ? { ...f, fixes: [] } : f;
  if (extra.length === 0) return base;
  const merged: PackEditSuggestion[] = [];
  const keys = new Set<string>();
  for (const s of [...(f.packEdits ?? []), ...extra]) {
    const k = suggestionKey(s);
    if (keys.has(k)) continue;
    keys.add(k);
    merged.push(s);
  }
  return { ...base, packEdits: merged };
}
