// @vitest-environment happy-dom
/** M7 UI logic: shortcut guards, the J/K cursor, menu contents per row kind, palette commands, report export. */
import { describe, expect, it, vi } from 'vitest';

import { MOCK_INSTANCES, MOCK_PICKED_PACK } from '../mockData';
import { enterIsFree, isTypingTarget, moveCursor, shortcutOf, suppressesDefault, visibleList, type KeyInput } from '../keyboard';
import { exportMenu, findingMenu, findingSummary, instanceMenu, isAction, modMenu, removable, tidy, separator, type MenuEntry } from '../menus';
import { paletteGroups, runPaletteCommand, type PaletteActions } from '../paletteCommands';
import { guessHomeDir, reportInput } from '../report';
import { REPORT_NOTICE_MS } from '../store';
import { finding, mockStore, until } from './helpers';

const key = (k: string, target: EventTarget | null = document.body, mods: Partial<KeyInput> = {}): KeyInput => ({
  key: k,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  target,
  ...mods,
});

const ids = (entries: readonly MenuEntry[]) => entries.map((e) => (isAction(e) ? e.id : '—'));

describe('shortcuts', () => {
  it('maps the keys of invariant 17', () => {
    expect(shortcutOf(key('k', document.body, { ctrlKey: true }))).toBe('palette');
    expect(shortcutOf(key('K', document.body, { metaKey: true }))).toBe('palette');
    expect(shortcutOf(key('j'))).toBe('next');
    expect(shortcutOf(key('k'))).toBe('previous');
    expect(shortcutOf(key('Enter'))).toBe('toggle');
    expect(shortcutOf(key('r', document.body, { ctrlKey: true }))).toBe('rescan');
    expect(shortcutOf(key('Escape'))).toBe('escape');
    expect(shortcutOf(key('j', document.body, { ctrlKey: true }))).toBeNull();
    expect(shortcutOf(key('J', document.body, { shiftKey: true }))).toBeNull();
    expect(shortcutOf(key('j', document.body, { defaultPrevented: true }))).toBeNull();
    expect(shortcutOf(key('Enter', document.body, { repeat: true }))).toBeNull();
  });

  it('never fires while typing in an input, textarea, select or contenteditable', () => {
    const input = document.createElement('input');
    const area = document.createElement('textarea');
    const select = document.createElement('select');
    const editable = document.createElement('div');
    editable.setAttribute('contenteditable', 'true');
    const inner = document.createElement('span');
    editable.appendChild(inner);
    for (const t of [input, area, select, editable, inner]) {
      expect(isTypingTarget(t)).toBe(true);
      for (const k of [key('j', t), key('k', t), key('Enter', t), key('Escape', t), key('r', t, { ctrlKey: true }), key('k', t, { ctrlKey: true })]) {
        expect(shortcutOf(k)).toBeNull();
      }
    }
    // The reload is still swallowed while typing (it would discard everything).
    expect(suppressesDefault(key('r', input, { ctrlKey: true }))).toBe(true);
    // The palette's own input may close the palette.
    const cmdk = document.createElement('input');
    cmdk.setAttribute('cmdk-input', '');
    expect(shortcutOf(key('k', cmdk, { ctrlKey: true }))).toBe('palette');
    expect(shortcutOf(key('j', cmdk))).toBeNull();
  });

  it('leaves Enter to focused controls and to the work order panel', () => {
    const button = document.createElement('button');
    expect(enterIsFree(button)).toBe(false);
    expect(shortcutOf(key('Enter', button))).toBeNull();
    const order = document.createElement('section');
    order.setAttribute('data-work-order', '');
    const inside = document.createElement('div');
    order.appendChild(inside);
    document.body.appendChild(order);
    expect(enterIsFree(inside)).toBe(false);
    order.remove();
    expect(enterIsFree(document.body)).toBe(true);
    expect(enterIsFree(document.createElement('div'))).toBe(true);
  });

  it('moves the cursor without wrapping and starts over when it left the list', () => {
    const list = ['a', 'b', 'c'];
    expect(moveCursor(list, null, 1)).toBe('a');
    expect(moveCursor(list, null, -1)).toBe('c');
    expect(moveCursor(list, 'a', 1)).toBe('b');
    expect(moveCursor(list, 'c', 1)).toBe('c');
    expect(moveCursor(list, 'a', -1)).toBe('a');
    expect(moveCursor(list, 'gone', 1)).toBe('a');
    expect(moveCursor([], 'a', 1)).toBeNull();
  });

  it('walks the list on screen: findings, a crash source diagnosis, nothing on history', async () => {
    const make = () => [finding('f1', 'error', ['mods/a.jar']), finding('f2', 'warning', ['mods/b.jar'])];
    const { store } = mockStore({}, make);
    await store.getState().init();
    const id = store.getState().selectedInstanceId!;
    await until(() => store.getState().scans[id]?.status === 'done');
    expect(visibleList(store.getState())).toEqual({ kind: 'finding', ids: ['f1', 'f2'] });
    store.getState().moveCursor(1);
    store.getState().moveCursor(1);
    expect(store.getState().cursor).toBe('f2');
    store.getState().toggleCursor();
    expect(store.getState().cursorToggle).toEqual({ id: 'f2', n: 1 });
    store.getState().setFindingsTab(id, 'history');
    expect(store.getState().cursor).toBeNull();
    expect(visibleList(store.getState())).toBeNull();
    store.getState().moveCursor(1);
    expect(store.getState().cursor).toBeNull();
    store.getState().setFindingsTab(id, 'crashes');
    await until(() => {
      const c = store.getState().crashes[id];
      return !!c?.selectedSourceId && c.analyses[c.selectedSourceId]?.status === 'done';
    });
    expect(visibleList(store.getState())?.kind).toBe('crash');
  });
});

describe('context menu contents', () => {
  const noop = { setEnabled: vi.fn(), inspect: vi.fn(), copy: vi.fn(), open: vi.fn() };
  const mod = { id: 'mods/jei.jar', fileName: 'jei.jar', enabled: true, nested: false, declared: false, pack: false, planBlocked: null, modrinthUrl: 'https://modrinth.com/mod/jei' };

  it('mod rows: Disable/Enable plans, inspect, copy, Modrinth when identified', () => {
    const items = modMenu(mod, noop);
    expect(ids(items)).toEqual(['toggle', '—', 'inspect', 'copy-name', 'open-modrinth']);
    const toggle = items[0]!;
    expect(isAction(toggle) && toggle.label).toBe('Disable…');
    if (isAction(toggle)) toggle.run();
    expect(noop.setEnabled).toHaveBeenCalledWith('mods/jei.jar', false);
    expect(ids(modMenu({ ...mod, enabled: false, modrinthUrl: null }, noop))).toEqual(['toggle', '—', 'inspect', 'copy-name']);
    const blocked = modMenu({ ...mod, planBlocked: 'A work order is open.' }, noop)[0]!;
    expect(isAction(blocked) && blocked.disabled).toBe(true);
    // Nested jars follow their parent.
    expect(ids(modMenu({ ...mod, nested: true }, noop))).toEqual(['inspect', 'copy-name', 'open-modrinth']);
  });

  it('pack rows never offer a mutating item', () => {
    expect(ids(modMenu({ ...mod, pack: true }, noop))).toEqual(['inspect', 'copy-name', 'open-modrinth']);
    expect(ids(modMenu({ ...mod, pack: true, declared: true }, noop))).toEqual(['inspect', 'copy-name', 'open-modrinth']);
    const f = { code: 'E-MC-RANGE', title: 'Built for 1.21.1', culprits: ['x.jar'], firstFix: 'Disable x.jar', pack: true, planBlocked: null };
    expect(ids(findingMenu(f, { copy: vi.fn(), applyFirstFix: vi.fn(), inspect: vi.fn() }))).toEqual(['copy-summary', 'inspect']);
    const packMenu = instanceMenu({ launcher: 'mrpack', watching: false, watchPending: false, scanned: true }, { rescan: vi.fn(), setWatch: vi.fn(), exportReport: vi.fn(), remove: vi.fn() });
    expect(ids(packMenu)).toEqual(['rescan', '—', 'export-markdown', 'export-json', '—', 'remove']);
  });

  it('finding rows: copy summary, apply first fix (planned), inspect', () => {
    const act = { copy: vi.fn(), applyFirstFix: vi.fn(), inspect: vi.fn() };
    const f = { code: 'E-DUP-ID', title: 'Two jars declare jei', culprits: ['a.jar', 'b.jar'], firstFix: 'Disable a.jar', pack: false, planBlocked: null };
    const items = findingMenu(f, act);
    expect(ids(items)).toEqual(['copy-summary', 'apply-fix', 'inspect']);
    for (const it of items) if (isAction(it)) it.run();
    expect(act.copy).toHaveBeenCalledWith('E-DUP-ID  Two jars declare jei  (a.jar, b.jar)');
    expect(act.applyFirstFix).toHaveBeenCalledTimes(1);
    expect(ids(findingMenu({ ...f, firstFix: null }, act))).toEqual(['copy-summary', 'inspect']);
    expect(findingSummary({ code: 'I-X', title: 't', culprits: [] })).toBe('I-X  t');
  });

  it('instance rows: watch on/off, export, remove only for added folders and packs', () => {
    const act = { rescan: vi.fn(), setWatch: vi.fn(), exportReport: vi.fn(), remove: vi.fn() };
    const launcher = instanceMenu({ launcher: 'prism', watching: true, watchPending: false, scanned: false }, act);
    expect(ids(launcher)).toEqual(['rescan', 'watch', '—', 'export-markdown', 'export-json']);
    const watch = launcher[1]!;
    expect(isAction(watch) && watch.label).toBe('Stop watching for crashes');
    if (isAction(watch)) watch.run();
    expect(act.setWatch).toHaveBeenCalledWith(false);
    expect(launcher.filter(isAction).filter((e) => e.id.startsWith('export')).every((e) => e.disabled)).toBe(true);
    expect(ids(instanceMenu({ launcher: 'manual', watching: false, watchPending: false, scanned: true }, act)).at(-1)).toBe('remove');
    expect(removable('curseforge')).toBe(false);
    expect(ids(exportMenu(true, act))).toEqual(['export-markdown', 'export-json']);
  });

  it('tidies separators', () => {
    const a = { id: 'a', label: 'A', run: () => undefined };
    expect(ids(tidy([separator('s0'), a, separator('s1'), separator('s2'), a, separator('s3')]))).toEqual(['a', '—', 'a']);
  });
});

describe('command palette', () => {
  it('lists instances, actions, findings (with codes and culprits) and mods; packs get no watch or history', async () => {
    const { store } = mockStore({}, () => [finding('dup', 'error', ['mods/jei-1.20.1-forge-15.2.0.27.jar'], { title: 'Two jars declare jei' })]);
    await store.getState().init();
    const id = store.getState().selectedInstanceId!;
    await until(() => store.getState().scans[id]?.status === 'done');
    const groups = paletteGroups(store.getState(), false);
    expect(groups.map((g) => g.heading)).toEqual(['Instances', 'Actions', 'Findings', 'Mods']);
    expect(groups[0]!.items).toHaveLength(MOCK_INSTANCES.length);
    const actions = groups[1]!.items.map((i) => i.id);
    for (const a of ['rescan', 'refresh-modrinth', 'toggle-watch', 'export-markdown', 'export-json', 'open-mrpack', 'add-folder', 'show-findings', 'show-crashes', 'show-history', 'theme:system', 'theme:dark', 'theme:light']) {
      expect(actions).toContain(a);
    }
    expect(groups[1]!.items.find((i) => i.id === 'rescan')?.shortcut).toBe('Ctrl+R');
    expect(groups[2]!.items[0]).toMatchObject({ id: 'finding:dup', code: 'E-DUP-ID', label: 'Two jars declare jei' });
    expect(groups[2]!.items[0]!.keywords).toContain('jei-1.20.1-forge-15.2.0.27.jar');

    await store.getState().openMrpack();
    await until(() => store.getState().scans[MOCK_PICKED_PACK.id]?.status === 'done');
    const packActions = paletteGroups(store.getState(), true)[1]!.items;
    expect(packActions.map((i) => i.id)).not.toContain('toggle-watch');
    expect(packActions.map((i) => i.id)).not.toContain('show-history');
    expect(packActions.find((i) => i.id === 'rescan')?.shortcut).toBe('⌘R');
  });

  it('runs commands through store actions, never a work order', () => {
    const a: PaletteActions = {
      selectInstance: vi.fn(),
      scan: vi.fn(async () => undefined),
      refreshModrinth: vi.fn(async () => undefined),
      setWatch: vi.fn(async () => undefined),
      exportReport: vi.fn(async () => undefined),
      openMrpack: vi.fn(async () => undefined),
      addFolder: vi.fn(async () => undefined),
      setFindingsTab: vi.fn(),
      setTheme: vi.fn(),
      goToFinding: vi.fn(),
      revealJar: vi.fn(),
    };
    const s = { selectedInstanceId: 'i1', settings: { watched: ['i1'] } } as unknown as Parameters<typeof runPaletteCommand>[1];
    runPaletteCommand('instance:i2', s, a);
    runPaletteCommand('finding:f:1', s, a);
    runPaletteCommand('mod:mods/a.jar', s, a);
    runPaletteCommand('theme:dark', s, a);
    runPaletteCommand('rescan', s, a);
    runPaletteCommand('toggle-watch', s, a);
    runPaletteCommand('export-json', s, a);
    runPaletteCommand('show-crashes', s, a);
    runPaletteCommand('open-mrpack', s, a);
    expect(a.selectInstance).toHaveBeenCalledWith('i2');
    expect(a.goToFinding).toHaveBeenCalledWith('f:1');
    expect(a.revealJar).toHaveBeenCalledWith('mods/a.jar');
    expect(a.setTheme).toHaveBeenCalledWith('dark');
    expect(a.scan).toHaveBeenCalledWith('i1');
    expect(a.setWatch).toHaveBeenCalledWith('i1', false);
    expect(a.exportReport).toHaveBeenCalledWith('i1', 'json');
    expect(a.setFindingsTab).toHaveBeenCalledWith('i1', 'crashes');
    expect(a.openMrpack).toHaveBeenCalledTimes(1);
  });
});

describe('report export', () => {
  it('derives the home folder from instance paths', () => {
    expect(guessHomeDir(['C:\\Users\\alex\\curseforge\\x'])).toBe('C:\\Users\\alex');
    expect(guessHomeDir(['D:\\servers\\smp', '/home/sam/.minecraft'])).toBe('/home/sam');
    expect(guessHomeDir(['/Users/kim/Library/x'])).toBe('/Users/kim');
    expect(guessHomeDir(['D:\\servers\\smp'])).toBe('');
  });

  it('builds the report with the real core, saves it, shows the path, then clears it', async () => {
    const timers: Array<() => void> = [];
    const { store, backend } = mockStore({}, () => [finding('dup', 'error', ['mods/a.jar'])], undefined, {
      setTimer: (cb) => void timers.push(cb),
      appVersion: '0.1.0',
    });
    await store.getState().init();
    const id = store.getState().selectedInstanceId!;
    await until(() => store.getState().scans[id]?.status === 'done');
    const input = reportInput(store.getState(), id, { appVersion: '0.1.0', generatedAtMs: 0 })!;
    expect(input.homeDir).toBe('C:\\Users\\alex');
    await store.getState().exportReport(id, 'markdown');
    expect(store.getState().reports[id]).toMatchObject({ status: 'saved', format: 'markdown' });
    const saved = backend.reports()[0]!;
    expect(saved.name).toMatch(/^modpack-doctor-all-the-mods-9-\d{4}-\d{2}-\d{2}$/);
    expect(saved.contents).toContain('E-DUP-ID');
    // Invariant 16: no absolute home path in the report.
    expect(saved.contents).not.toContain('C:\\Users\\alex');
    expect(saved.contents).not.toContain('C:/Users/alex');
    await store.getState().exportReport(id, 'json');
    expect(JSON.parse(backend.reports()[1]!.contents)).toMatchObject({ schemaVersion: 1 });
    expect(REPORT_NOTICE_MS).toBeGreaterThan(0);
    for (const t of timers.splice(0)) t();
    expect(store.getState().reports[id]).toBeUndefined();
  });

  it('cancel changes nothing; a refusal or a build failure shows inline', async () => {
    const cancel = mockStore({ scenario: 'reportcancel' });
    await cancel.store.getState().init();
    const id = cancel.store.getState().selectedInstanceId!;
    await until(() => cancel.store.getState().scans[id]?.status === 'done');
    await cancel.store.getState().exportReport(id, 'markdown');
    expect(cancel.store.getState().reports[id]).toBeUndefined();

    const refused = mockStore();
    await refused.store.getState().init();
    await until(() => refused.store.getState().scans[id]?.status === 'done');
    vi.spyOn(refused.backend.commands, 'saveReport').mockResolvedValue({ status: 'error', error: { kind: 'io', message: 'The folder is read-only.', path: null } });
    await refused.store.getState().exportReport(id, 'json');
    expect(refused.store.getState().reports[id]).toMatchObject({ status: 'error', error: { kind: 'io' } });
    refused.store.getState().dismissReport(id);
    expect(refused.store.getState().reports[id]).toBeUndefined();

    const broken = mockStore({}, undefined, undefined, {
      reportCore: {
        buildReport: () => {
          throw new Error('boom');
        },
        reportMarkdown: () => '',
        reportJson: () => '',
        reportFileName: () => 'x',
      },
    });
    await broken.store.getState().init();
    await until(() => broken.store.getState().scans[id]?.status === 'done');
    await broken.store.getState().exportReport(id, 'markdown');
    expect(broken.store.getState().reports[id]).toMatchObject({ status: 'error', error: { kind: 'internal', message: 'The report could not be built: boom' } });

    // Not scanned yet: refused before anything is built.
    const early = mockStore({ scenario: 'scanning' });
    await early.store.getState().init();
    await early.store.getState().exportReport(id, 'markdown');
    expect(early.store.getState().reports[id]).toMatchObject({ status: 'error', error: { kind: 'invalid' } });
  });
});

describe('.mrpack in the store', () => {
  it('opens a pack, scans its declared files, never plans a fix for it, and removes it', async () => {
    const { store } = mockStore();
    await store.getState().init();
    await store.getState().openMrpack();
    expect(store.getState().selectedInstanceId).toBe(MOCK_PICKED_PACK.id);
    await until(() => store.getState().scans[MOCK_PICKED_PACK.id]?.status === 'done');
    expect(store.getState().scans[MOCK_PICKED_PACK.id]!.result!.declared).toHaveLength(6);
    await store.getState().fix('x', { kind: 'disable', jarId: 'overrides/mods/explorerkit-branding-2.1.0.jar' });
    expect(store.getState().order).toBeNull();
    expect(store.getState().fixErrors.x?.message).toMatch(/read-only/);
    await store.getState().removeInstance(MOCK_PICKED_PACK.id);
    expect(store.getState().discovery!.instances.some((i) => i.id === MOCK_PICKED_PACK.id)).toBe(false);
    expect(store.getState().selectedInstanceId).toBe(MOCK_INSTANCES[0]!.id);
    // A launcher instance cannot be removed: the refusal lands in the rail.
    await store.getState().removeInstance(MOCK_INSTANCES[0]!.id);
    expect(store.getState().railError?.kind).toBe('notFound');
  });

  it('a pack skips dependency resolution and icons, and asks for its declared versions’ required projects', async () => {
    const { store, backend } = mockStore();
    const resolve = vi.spyOn(backend.commands, 'modrinthResolveModId');
    const icons = vi.spyOn(backend.commands, 'modrinthIcons');
    await store.getState().init();
    await until(() => store.getState().modrinth[MOCK_INSTANCES[0]!.id]?.status === 'done');
    await until(() => icons.mock.calls.length > 0);
    icons.mockClear();
    resolve.mockClear();
    const projects = vi.spyOn(backend.commands, 'modrinthProjects');
    await store.getState().openMrpack();
    await until(() => store.getState().modrinth[MOCK_PICKED_PACK.id]?.status === 'done');
    await new Promise((r) => setTimeout(r, 20));
    expect(resolve).not.toHaveBeenCalled();
    expect(icons).not.toHaveBeenCalled();
    expect(projects).toHaveBeenCalled();
    // Every finding of a pack is fix-free.
    expect(store.getState().scans[MOCK_PICKED_PACK.id]!.findings.every((f) => f.fixes.every((x) => x.kind === 'manual'))).toBe(true);
  });
});
