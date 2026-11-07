/**
 * Command palette contents (DESIGN §6.7): pure, from the store state. Groups: INSTANCES (switch),
 * ACTIONS, FINDINGS (the open instance's static findings, matched by code, title and culprit file
 * names), MODS (its top-level jars). `runPaletteCommand` maps an id back to store actions. No
 * command executes a work order; packs get no watch or history commands. "Check for updates"
 * opens About and checks (CONTRACTS invariant 18); nothing in the palette installs an update.
 */
import { LAUNCHER_ABBR } from '../components/labels';
import { chord } from './keyboard';
import type { AppState } from './store';

export interface PaletteCommand {
  id: string;
  label: string;
  /** Mono detail after the label (a version, a file name). */
  detail?: string;
  /** Mono prefix in a fixed column (finding codes). */
  code?: string;
  /** Extra words the filter matches (culprit file names). */
  keywords?: string[];
  shortcut?: string;
}

export interface PaletteCommandGroup {
  heading: string;
  items: PaletteCommand[];
}

type PaletteState = Pick<
  AppState,
  'discovery' | 'selectedInstanceId' | 'scans' | 'settings'
>;

export function paletteGroups(s: PaletteState, mac?: boolean): PaletteCommandGroup[] {
  const instances = s.discovery?.instances ?? [];
  const id = s.selectedInstanceId;
  const inst = instances.find((i) => i.id === id) ?? null;
  const sc = id ? s.scans[id] : undefined;
  const pack = inst?.launcher === 'mrpack';
  const scanned = !!sc?.result && sc.status !== 'idle';
  const groups: PaletteCommandGroup[] = [];

  groups.push({
    heading: 'Instances',
    items: instances.map((i) => ({
      id: `instance:${i.id}`,
      label: i.name,
      detail: [LAUNCHER_ABBR[i.launcher], i.mcVersion, i.loader ? `${i.loader.kind} ${i.loader.version}` : null].filter(Boolean).join(' '),
    })),
  });

  const actions: PaletteCommand[] = [];
  if (inst) {
    actions.push({ id: 'rescan', label: 'Rescan', detail: inst.name, shortcut: chord('r', mac) });
    if (s.settings.modrinthEnabled && sc?.status === 'done') actions.push({ id: 'refresh-modrinth', label: 'Refresh Modrinth', detail: inst.name });
    if (!pack) {
      const on = s.settings.watched.includes(inst.id);
      actions.push({ id: 'toggle-watch', label: on ? 'Stop watching for crashes' : 'Watch for crashes', detail: inst.name });
    }
    if (scanned) {
      actions.push({ id: 'export-markdown', label: 'Export report (Markdown)', detail: '.md' });
      actions.push({ id: 'export-json', label: 'Export report (JSON)', detail: '.json' });
    }
    actions.push({ id: 'show-findings', label: 'Show Findings' });
    actions.push({ id: 'show-crashes', label: 'Show Crashes' });
    // A pack is never changed: no backups, no HISTORY legend.
    if (!pack) actions.push({ id: 'show-history', label: 'Show History' });
  }
  actions.push({ id: 'open-mrpack', label: 'Open .mrpack…' });
  actions.push({ id: 'add-folder', label: 'Add folder…' });
  for (const t of ['system', 'dark', 'light'] as const) {
    actions.push({ id: `theme:${t}`, label: `Theme: ${t[0]!.toUpperCase()}${t.slice(1)}`, ...(s.settings.theme === t ? { detail: 'current' } : {}) });
  }
  actions.push({ id: 'check-updates', label: 'Check for updates', detail: 'github.com', keywords: ['update', 'version', 'release'] });
  actions.push({ id: 'about', label: 'About Modpack Doctor', keywords: ['version', 'licence', 'license', 'disclaimer'] });
  groups.push({ heading: 'Actions', items: actions });

  if (sc?.findings.length) {
    const names = new Map((sc.result?.jars ?? []).map((j) => [j.id, j.fileName]));
    groups.push({
      heading: 'Findings',
      items: sc.findings.map((f) => ({
        id: `finding:${f.id}`,
        code: f.code,
        label: f.title,
        keywords: [f.code, ...f.culprits.map((c) => names.get(c.jarId) ?? c.fileName)],
      })),
    });
  }

  const jars = (sc?.result?.jars ?? []).filter((j) => j.depth === 0);
  if (jars.length) {
    groups.push({
      heading: 'Mods',
      items: jars.map((j) => {
        const meta = j.mods[0];
        return {
          id: `mod:${j.id}`,
          label: meta?.name ?? meta?.modId ?? j.fileName,
          detail: meta?.version ?? j.fileName,
          keywords: [j.fileName, ...(meta?.modId ? [meta.modId] : [])],
        };
      }),
    });
  }
  return groups.filter((g) => g.items.length);
}

/** Store actions a palette command may use (never an order's execute or cancel). */
export type PaletteActions = Pick<
  AppState,
  | 'selectInstance'
  | 'scan'
  | 'refreshModrinth'
  | 'setWatch'
  | 'exportReport'
  | 'openMrpack'
  | 'addFolder'
  | 'setFindingsTab'
  | 'setTheme'
  | 'goToFinding'
  | 'revealJar'
> &
  /** About and the update check (M8); optional so a caller without them still type-checks. */
  Partial<Pick<AppState, 'setAboutOpen' | 'checkUpdate'>>;

export function runPaletteCommand(commandId: string, s: Pick<AppState, 'selectedInstanceId' | 'settings'>, a: PaletteActions): void {
  const id = s.selectedInstanceId;
  const [head, ...rest] = commandId.split(':');
  const arg = rest.join(':');
  switch (head) {
    case 'instance':
      a.selectInstance(arg);
      return;
    case 'finding':
      a.goToFinding(arg);
      return;
    case 'mod':
      a.revealJar(arg);
      return;
    case 'theme':
      if (arg === 'system' || arg === 'dark' || arg === 'light') a.setTheme(arg);
      return;
    case 'open-mrpack':
      void a.openMrpack();
      return;
    case 'add-folder':
      void a.addFolder();
      return;
    case 'about':
      a.setAboutOpen?.(true);
      return;
    case 'check-updates':
      a.setAboutOpen?.(true);
      void a.checkUpdate?.();
      return;
  }
  if (!id) return;
  switch (commandId) {
    case 'rescan':
      void a.scan(id);
      return;
    case 'refresh-modrinth':
      void a.refreshModrinth(id);
      return;
    case 'toggle-watch':
      void a.setWatch(id, !s.settings.watched.includes(id));
      return;
    case 'export-markdown':
      void a.exportReport(id, 'markdown');
      return;
    case 'export-json':
      void a.exportReport(id, 'json');
      return;
    case 'show-findings':
      a.setFindingsTab(id, 'findings');
      return;
    case 'show-crashes':
      a.setFindingsTab(id, 'crashes');
      return;
    case 'show-history':
      a.setFindingsTab(id, 'history');
      return;
  }
}
