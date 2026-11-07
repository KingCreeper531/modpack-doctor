/**
 * Context menus of the three row kinds, wired to the store: menus.ts decides what each row
 * offers, this module supplies the state it reads and the actions it calls (the same store
 * actions as the buttons, so Disable/Enable and Apply first fix only plan a work order).
 */
import { fixLabel } from '../components/labels';
import { jarMatch } from '../../core/modrinth';
import { fixBlockReason } from './derive';
import { chord } from './keyboard';
import { openExternal } from './external';
import { copyText } from './menuHost';
import { findingMenu, instanceMenu, modMenu, type MenuEntry } from './menus';
import { fixVersions, matchProject, projectUrl, viewContext } from './modrinthState';
import type { AppState, AppStore } from './store';

/** Why nothing can be planned for the instance right now, or null (mirrors the fix buttons). */
export function planBlocked(s: AppState, instanceId: string): string | null {
  const o = s.order;
  if (o) return o.instanceId === instanceId ? 'A work order is open.' : 'A work order for another instance is open.';
  return fixBlockReason(s.scans[instanceId]);
}

function modrinthUrlFor(s: AppState, instanceId: string, sha1: string, jar?: Parameters<typeof jarMatch>[0]): string | null {
  const sc = s.scans[instanceId];
  const ctx = viewContext(s.modrinth[instanceId], sc?.result ?? null);
  if (!ctx) return null;
  try {
    if (jar) {
      const p = matchProject(jarMatch(jar, ctx));
      return p ? projectUrl(p) : null;
    }
    const v = ctx.versions[sha1.trim().toLowerCase()];
    const p = v ? ctx.projects[v.projectId] : undefined;
    return p ? projectUrl(p) : null;
  } catch {
    return null;
  }
}

/** A mod-table row: a jar (top-level or nested) or a `.mrpack` declared file. */
export function modMenuFor(store: AppStore, rowId: string): MenuEntry[] {
  const s = store.getState();
  const id = s.selectedInstanceId;
  const sc = id ? s.scans[id] : undefined;
  if (!id || !sc?.result) return [];
  const pack = s.discovery?.instances.find((i) => i.id === id)?.launcher === 'mrpack';
  const a = s;
  const actions = {
    setEnabled: (jarId: string, enabled: boolean) => void a.setJarEnabled(jarId, enabled),
    inspect: (jarId: string) => a.select({ kind: 'jar', id: jarId }),
    copy: (text: string) => void copyText(text),
    open: (url: string) => void openExternal(url, s.backendKind),
  };
  const jar = sc.result.jars.find((j) => j.id === rowId);
  if (jar) {
    return modMenu(
      {
        id: jar.id,
        fileName: jar.fileName,
        enabled: !jar.disabled,
        nested: jar.depth > 0,
        declared: false,
        pack,
        planBlocked: planBlocked(s, id),
        modrinthUrl: modrinthUrlFor(s, id, jar.sha1, jar),
      },
      actions,
    );
  }
  const file = sc.result.declared.find((d) => d.path === rowId);
  if (!file) return [];
  return modMenu(
    {
      id: file.path,
      fileName: file.path.slice(file.path.lastIndexOf('/') + 1),
      enabled: true,
      nested: false,
      declared: true,
      pack: true,
      planBlocked: 'read-only',
      modrinthUrl: modrinthUrlFor(s, id, file.sha1),
    },
    actions,
  );
}

/** A static finding (`kind: 'finding'`) or a crash finding of `sourceId`. */
export function findingMenuFor(store: AppStore, findingId: string, sourceId?: string): MenuEntry[] {
  const s = store.getState();
  const id = s.selectedInstanceId;
  if (!id) return [];
  const sc = s.scans[id];
  const f = sourceId
    ? s.crashes[id]?.analyses[sourceId]?.findings.find((x) => x.id === findingId)
    : sc?.findings.find((x) => x.id === findingId);
  if (!f) return [];
  const pack = s.discovery?.instances.find((i) => i.id === id)?.launcher === 'mrpack';
  const names: Record<string, string> = {};
  for (const j of sc?.result?.jars ?? []) names[j.id] = j.fileName;
  const fix = f.fixes.find((x) => x.kind !== 'manual') ?? null;
  const m = s.modrinth[id];
  const versions = fixVersions(viewContext(m, sc?.result ?? null), m?.resolutions ?? {});
  return findingMenu(
    {
      code: f.code,
      title: f.title,
      culprits: f.culprits.map((c) => names[c.jarId] ?? c.fileName),
      firstFix: fix ? fixLabel(fix, names, versions) : null,
      pack,
      planBlocked: planBlocked(s, id) ?? (s.fixPending[f.id] ? 'Planning…' : null),
    },
    {
      copy: (text) => void copyText(text),
      applyFirstFix: () => {
        if (fix) void s.fix(f.id, fix, 'triage');
      },
      inspect: () => (sourceId ? s.select({ kind: 'crash', id: f.id, sourceId }) : s.select({ kind: 'finding', id: f.id })),
    },
  );
}

/** An instance rail row. */
export function instanceMenuFor(store: AppStore, instanceId: string): MenuEntry[] {
  const s = store.getState();
  const inst = s.discovery?.instances.find((i) => i.id === instanceId);
  if (!inst) return [];
  const sc = s.scans[instanceId];
  return instanceMenu(
    {
      launcher: inst.launcher,
      watching: s.settings.watched.includes(instanceId),
      watchPending: !!s.watchPending[instanceId],
      scanned: !!sc?.result && !!sc.pack,
      ...(s.selectedInstanceId === instanceId ? { rescanShortcut: chord('r') } : {}),
    },
    {
      rescan: () => void s.scan(instanceId),
      setWatch: (on) => void s.setWatch(instanceId, on),
      exportReport: (format) => void s.exportReport(instanceId, format),
      remove: () => void s.removeInstance(instanceId),
    },
  );
}
