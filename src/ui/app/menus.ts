/**
 * Context menu contents (CONTRACTS invariant 17), as pure builders: what each row kind offers.
 * Presentation is separate (menuHost.ts: a native Tauri menu, or the DOM menu in the browser).
 *
 * Every item that would change files only *plans* a work order (it calls the same store action
 * as the fix buttons and the mod toggle); nothing executes from a menu. Packs (`launcher:
 * 'mrpack'`) are read-only: their rows never offer Disable/Enable or a fix.
 */
export interface MenuAction {
  kind?: 'item';
  /** Stable id (tests, native menu item ids). */
  id: string;
  label: string;
  /** Shown right-aligned in mono (DOM menu only). */
  shortcut?: string;
  disabled?: boolean;
  run: () => void;
}

export interface MenuSeparator {
  kind: 'separator';
  id: string;
}

export type MenuEntry = MenuAction | MenuSeparator;

export const separator = (id: string): MenuSeparator => ({ kind: 'separator', id });

export function isAction(e: MenuEntry): e is MenuAction {
  return e.kind !== 'separator';
}

/** Drops leading, trailing and doubled separators (items above may be conditional). */
export function tidy(entries: readonly MenuEntry[]): MenuEntry[] {
  const out: MenuEntry[] = [];
  for (const e of entries) {
    if (!isAction(e) && (!out.length || !isAction(out[out.length - 1]!))) continue;
    out.push(e);
  }
  while (out.length && !isAction(out[out.length - 1]!)) out.pop();
  return out;
}

// ---- mod rows --------------------------------------------------------------------------------

export interface ModMenuInput {
  /** The row's jar id (or, for a `.mrpack` declared file, its path). */
  id: string;
  fileName: string;
  enabled: boolean;
  /** Nested jars follow their parent and cannot be toggled. */
  nested: boolean;
  /** A file the `.mrpack` index declares (not in the zip). */
  declared: boolean;
  /** The instance is an opened `.mrpack` (read-only). */
  pack: boolean;
  /** Why a work order cannot be planned right now (another order open, scan running), or null. */
  planBlocked: string | null;
  /** The Modrinth project page when the file was identified. */
  modrinthUrl: string | null;
}

export interface ModMenuActions {
  setEnabled(id: string, enabled: boolean): void;
  inspect(id: string): void;
  copy(text: string): void;
  open(url: string): void;
}

export function modMenu(m: ModMenuInput, act: ModMenuActions): MenuEntry[] {
  const entries: MenuEntry[] = [];
  if (!m.pack && !m.nested && !m.declared) {
    entries.push({
      id: 'toggle',
      label: m.enabled ? 'Disable…' : 'Enable…',
      disabled: m.planBlocked !== null,
      run: () => act.setEnabled(m.id, !m.enabled),
    });
    entries.push(separator('sep-plan'));
  }
  if (!m.declared) entries.push({ id: 'inspect', label: 'Show in inspector', run: () => act.inspect(m.id) });
  entries.push({ id: 'copy-name', label: 'Copy file name', run: () => act.copy(m.fileName) });
  if (m.modrinthUrl) {
    const url = m.modrinthUrl;
    entries.push({ id: 'open-modrinth', label: 'Open on Modrinth', run: () => act.open(url) });
  }
  return tidy(entries);
}

// ---- finding rows ----------------------------------------------------------------------------

export interface FindingMenuInput {
  code: string;
  title: string;
  culprits: readonly string[];
  /** Label of the first plannable fix (`Disable jei.jar`), or null when there is none. */
  firstFix: string | null;
  pack: boolean;
  planBlocked: string | null;
}

export interface FindingMenuActions {
  copy(text: string): void;
  applyFirstFix(): void;
  inspect(): void;
}

/** One line per finding for a bug report: `E-DUP-ID  Two jars declare mod id jei  (a.jar, b.jar)`. */
export function findingSummary(f: Pick<FindingMenuInput, 'code' | 'title' | 'culprits'>): string {
  return `${f.code}  ${f.title}${f.culprits.length ? `  (${f.culprits.join(', ')})` : ''}`;
}

export function findingMenu(f: FindingMenuInput, act: FindingMenuActions): MenuEntry[] {
  const entries: MenuEntry[] = [{ id: 'copy-summary', label: 'Copy summary', run: () => act.copy(findingSummary(f)) }];
  if (!f.pack && f.firstFix) {
    entries.push({ id: 'apply-fix', label: `Apply first fix: ${f.firstFix}…`, disabled: f.planBlocked !== null, run: act.applyFirstFix });
  }
  entries.push({ id: 'inspect', label: 'Show in inspector', run: act.inspect });
  return entries;
}

// ---- instance rail rows ----------------------------------------------------------------------

export interface InstanceMenuInput {
  launcher: string;
  watching: boolean;
  watchPending: boolean;
  /** A finished scan exists, so a report can be built. */
  scanned: boolean;
  rescanShortcut?: string;
}

export interface InstanceMenuActions {
  rescan(): void;
  setWatch(on: boolean): void;
  exportReport(format: 'markdown' | 'json'): void;
  remove(): void;
}

/** Only folders the user added and opened packs can leave the list (`remove_manual_instance`). */
export function removable(launcher: string): boolean {
  return launcher === 'manual' || launcher === 'mrpack';
}

export function instanceMenu(i: InstanceMenuInput, act: InstanceMenuActions): MenuEntry[] {
  const pack = i.launcher === 'mrpack';
  const entries: MenuEntry[] = [{ id: 'rescan', label: 'Rescan', ...(i.rescanShortcut ? { shortcut: i.rescanShortcut } : {}), run: act.rescan }];
  // A .mrpack has no game folder: nothing runs, nothing to watch.
  if (!pack) {
    entries.push({
      id: 'watch',
      label: i.watching ? 'Stop watching for crashes' : 'Watch for crashes',
      disabled: i.watchPending,
      run: () => act.setWatch(!i.watching),
    });
  }
  entries.push(separator('sep-report'));
  entries.push({ id: 'export-markdown', label: 'Export report (Markdown)…', disabled: !i.scanned, run: () => act.exportReport('markdown') });
  entries.push({ id: 'export-json', label: 'Export report (JSON)…', disabled: !i.scanned, run: () => act.exportReport('json') });
  if (removable(i.launcher)) {
    entries.push(separator('sep-remove'));
    entries.push({ id: 'remove', label: pack ? 'Close pack' : 'Remove from list', run: act.remove });
  }
  return tidy(entries);
}

/** The instance header's Export report menu. */
export function exportMenu(scanned: boolean, act: Pick<InstanceMenuActions, 'exportReport'>): MenuEntry[] {
  return [
    { id: 'export-markdown', label: 'Markdown (.md)…', disabled: !scanned, run: () => act.exportReport('markdown') },
    { id: 'export-json', label: 'JSON (.json)…', disabled: !scanned, run: () => act.exportReport('json') },
  ];
}
