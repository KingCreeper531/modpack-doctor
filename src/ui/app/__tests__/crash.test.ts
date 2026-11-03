/** Crash analysis and watch mode in the store (M4), against the mock backend and the real rules core. */
import { describe, expect, it, vi } from 'vitest';

import type { CrashDetected } from '../../../bindings';
import { CRASH_ANCHORS } from '../../../core/crash';
import { defaultSourceId, digestView, sortSources, upsertSource } from '../crashState';
import { MOCK_INSTANCES } from '../mockData';
import { notifierFrom, type Notifier } from '../notify';
import { CRASH_NOTIFICATION_TITLE, watchAnchors } from '../store';
import { mockStore, until } from './helpers';

const ATM = MOCK_INSTANCES[0]!.id;
const FO = MOCK_INSTANCES[1]!.id;
const MRPACK = MOCK_INSTANCES.find((i) => i.launcher === 'mrpack')!.id;
const NEWEST_CRASH = 'crash-reports/crash-2026-11-03_14.22.07-client.txt';
const EMBERFORGE = 'mods/emberforge-1.20.1-2.4.0.jar';

function recordingNotifier(result: 'sent' | 'denied' = 'sent') {
  const sent: Array<{ title: string; body: string }> = [];
  const notifier: Notifier = {
    notify: vi.fn(async (title: string, body: string) => {
      sent.push({ title, body });
      return result;
    }),
  };
  return { notifier, sent };
}

async function ready(m: ReturnType<typeof mockStore>, id = ATM) {
  await m.store.getState().init();
  await until(() => m.store.getState().scans[id]?.status === 'done' && m.store.getState().crashes[id]?.sourcesStatus === 'done');
}

const analysis = (m: ReturnType<typeof mockStore>, id: string, sourceId: string) => m.store.getState().crashes[id]?.analyses[sourceId];

describe('crash analysis flow', () => {
  it('lists sources newest first, selects the newest crash report and analyses it with jar mapping', async () => {
    const m = mockStore();
    await ready(m);
    const c = m.store.getState().crashes[ATM]!;
    expect(c.sources.map((s) => s.modifiedMs)).toEqual([...c.sources.map((s) => s.modifiedMs)].sort((a, b) => b - a));
    expect(c.sources[0]!.id).toBe('logs/latest.log');
    expect(c.selectedSourceId).toBe(NEWEST_CRASH);
    await until(() => analysis(m, ATM, NEWEST_CRASH)?.status === 'done' && !!analysis(m, ATM, NEWEST_CRASH)?.mapped);
    const a = analysis(m, ATM, NEWEST_CRASH)!;
    const top = a.findings[0]!;
    expect(top.code).toBe('C-MIXIN');
    expect(top.culprits.map((x) => x.jarId)).toEqual([EMBERFORGE]);
    expect(a.summary?.culpritFiles).toEqual(['emberforge-1.20.1-2.4.0.jar']);
    // Only the selected source was read.
    expect(analysis(m, ATM, 'logs/latest.log')).toBeUndefined();
  });

  it('reads the digest with every anchor text and re-uses it after a rescan', async () => {
    const m = mockStore();
    const read = vi.spyOn(m.backend.commands, 'readLogDigest');
    await ready(m);
    await until(() => analysis(m, ATM, NEWEST_CRASH)?.status === 'done');
    expect(read).toHaveBeenCalledTimes(1);
    expect(read.mock.calls[0]![2]).toEqual(CRASH_ANCHORS.map((x) => x.text));
    await m.store.getState().scan(ATM);
    expect(read).toHaveBeenCalledTimes(1);
    expect(analysis(m, ATM, NEWEST_CRASH)!.mapped).toBe(true);
  });

  it('selecting another source analyses it once; a clean log has no findings and no summary', async () => {
    const m = mockStore();
    await ready(m);
    m.store.getState().selectLogSource(ATM, 'logs/debug.log');
    await until(() => analysis(m, ATM, 'logs/debug.log')?.status === 'done');
    expect(analysis(m, ATM, 'logs/debug.log')!.findings.filter((f) => f.severity === 'error')).toEqual([]);
    expect(analysis(m, ATM, 'logs/debug.log')!.summary).toBeNull();
    const read = vi.spyOn(m.backend.commands, 'readLogDigest');
    m.store.getState().selectLogSource(ATM, 'logs/debug.log');
    await m.store.getState().analyzeLogSource(ATM, 'logs/debug.log');
    expect(read).not.toHaveBeenCalled();
  });

  it('a listing error is kept per instance (permission), and unavailable stays neutral', async () => {
    const m = mockStore({ scenario: 'errors' });
    await m.store.getState().init();
    await until(() => m.store.getState().crashes[ATM]?.sourcesStatus === 'error');
    expect(m.store.getState().crashes[ATM]!.sourcesError).toMatchObject({ kind: 'permission' });
    m.store.getState().selectInstance(MRPACK);
    await until(() => m.store.getState().crashes[MRPACK]?.sourcesStatus === 'error');
    expect(m.store.getState().crashes[MRPACK]!.sourcesError?.kind).toBe('unavailable');
  });

  it('a digest error becomes an error analysis that Retry (force) reads again', async () => {
    const m = mockStore();
    const read = vi.spyOn(m.backend.commands, 'readLogDigest').mockResolvedValueOnce({
      status: 'error',
      error: { kind: 'io', message: 'The file could not be read.', path: null },
    });
    await ready(m);
    await until(() => analysis(m, ATM, NEWEST_CRASH)?.status === 'error');
    expect(analysis(m, ATM, NEWEST_CRASH)!.error?.kind).toBe('io');
    await m.store.getState().analyzeLogSource(ATM, NEWEST_CRASH, true);
    expect(analysis(m, ATM, NEWEST_CRASH)!.status).toBe('done');
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('a jar selection can find the crash findings that cite it (selectCrash opens the crash view)', async () => {
    const m = mockStore();
    await ready(m);
    await until(() => !!analysis(m, ATM, NEWEST_CRASH)?.mapped);
    const f = analysis(m, ATM, NEWEST_CRASH)!.findings[0]!;
    m.store.getState().selectCrash(ATM, NEWEST_CRASH, f.id);
    const st = m.store.getState();
    expect(st.selection).toEqual({ kind: 'crash', id: f.id, sourceId: NEWEST_CRASH });
    expect(st.findingsTab[ATM]).toBe('crashes');
    // A rescan keeps a crash selection whose finding still exists.
    await m.store.getState().scan(ATM);
    expect(m.store.getState().selection).toEqual({ kind: 'crash', id: f.id, sourceId: NEWEST_CRASH });
  });
});

describe('watch mode', () => {
  it('re-arms every watched instance once at startup, with the tiered anchors', async () => {
    const m = mockStore({ scenario: 'crash', crashDelayMs: 60_000 });
    const sw = vi.spyOn(m.backend.commands, 'setWatch');
    await Promise.all([m.store.getState().init(), m.store.getState().init()]);
    await until(() => m.backend.watches().size === 2);
    await m.store.getState().init();
    expect(sw).toHaveBeenCalledTimes(2);
    expect(sw.mock.calls.map((c) => c[0]).sort()).toEqual([ATM, FO].sort());
    for (const [, enabled, anchors] of sw.mock.calls) {
      expect(enabled).toBe(true);
      expect(anchors).toEqual(watchAnchors());
      expect(new Set(anchors.map((x) => x.tier))).toEqual(new Set(['fatal', 'contextual']));
      expect(anchors.find((x) => x.text === '---- Minecraft Crash Report ----')?.tier).toBe('fatal');
      expect(anchors.find((x) => x.text === 'Caused by: ')?.tier).toBe('contextual');
    }
  });

  it('re-arms nothing when no instance is watched', async () => {
    const m = mockStore();
    const sw = vi.spyOn(m.backend.commands, 'setWatch');
    await ready(m);
    expect(sw).not.toHaveBeenCalled();
  });

  it('the toggle calls set_watch and mirrors Settings.watched; errors stay per instance', async () => {
    const m = mockStore();
    await ready(m);
    await m.store.getState().setWatch(ATM, true);
    expect(m.backend.settings().watched).toEqual([ATM]);
    expect(m.store.getState().settings.watched).toEqual([ATM]);
    expect(m.backend.watches().get(ATM)).toEqual(watchAnchors());
    await m.store.getState().setWatch(ATM, false);
    expect(m.backend.settings().watched).toEqual([]);
    expect(m.store.getState().settings.watched).toEqual([]);
    vi.spyOn(m.backend.commands, 'setWatch').mockResolvedValueOnce({
      status: 'error',
      error: { kind: 'unavailable', message: "Watching for crashes isn't available in this version of Modpack Doctor yet.", path: null },
    });
    await m.store.getState().setWatch(ATM, true);
    expect(m.store.getState().watchErrors[ATM]?.kind).toBe('unavailable');
    expect(m.store.getState().settings.watched).toEqual([]);
  });
});

describe('CrashDetected', () => {
  it('analyses the episode source, notifies once with the likely cause, alerts and selects the crash', async () => {
    const { notifier, sent } = recordingNotifier('sent');
    const m = mockStore({}, undefined, undefined, { notifier });
    await ready(m);
    m.store.getState().selectInstance(FO);
    const e = m.backend.crash(ATM, 7)!;
    await until(() => !!m.store.getState().crashAlerts[ATM]);
    const st = m.store.getState();
    const a = analysis(m, ATM, e.source.id)!;
    expect(a.summary).not.toBeNull();
    expect(sent).toEqual([{ title: CRASH_NOTIFICATION_TITLE, body: a.summary!.likelyCause! }]);
    expect(sent[0]!.body).toMatch(/Pipeworks/);
    expect(st.crashes[ATM]!.sources[0]!.id).toBe(e.source.id);
    expect(st.crashes[ATM]!.selectedSourceId).toBe(e.source.id);
    expect(st.findingsTab[ATM]).toBe('crashes');
    expect(st.crashBanner).toBeNull();
    // Opening the instance clears the alert and shows the crash.
    m.store.getState().selectInstance(ATM);
    expect(m.store.getState().crashAlerts[ATM]).toBeUndefined();
    expect(m.store.getState().crashes[ATM]!.selectedSourceId).toBe(e.source.id);
  });

  it('drops a duplicate episode', async () => {
    const { notifier, sent } = recordingNotifier('sent');
    const m = mockStore({}, undefined, undefined, { notifier });
    await ready(m);
    const read = vi.spyOn(m.backend.commands, 'readLogDigest');
    const e = m.backend.crash(ATM, 3)!;
    m.backend.emitCrashDetected(e);
    m.backend.emitCrashDetected({ ...e });
    await until(() => sent.length === 1);
    await new Promise((r) => setTimeout(r, 20));
    expect(sent).toHaveLength(1);
    expect(read).toHaveBeenCalledTimes(1);
    // A new episode of the same instance is handled again.
    m.backend.crash(ATM, 4);
    await until(() => sent.length === 2);
  });

  it('never notifies for an analysis without an error-severity crash finding', async () => {
    const { notifier } = recordingNotifier('sent');
    const m = mockStore({}, undefined, undefined, { notifier });
    await ready(m);
    const debug = m.store.getState().crashes[ATM]!.sources.find((s) => s.id === 'logs/debug.log')!;
    const e: CrashDetected = { instanceId: ATM, episode: 1, source: debug, triggers: [{ kind: 'processExit', pid: 1 }] };
    m.backend.emitCrashDetected(e);
    await until(() => analysis(m, ATM, debug.id)?.status === 'done');
    await new Promise((r) => setTimeout(r, 20));
    expect(notifier.notify).not.toHaveBeenCalled();
    expect(m.store.getState().crashAlerts[ATM]).toBeUndefined();
    expect(m.store.getState().crashBanner).toBeNull();
  });

  it('permission denied → in-app banner instead; Show opens the crash, Dismiss clears it', async () => {
    const api = { isGranted: vi.fn(async () => false), request: vi.fn(async () => 'denied'), send: vi.fn() };
    const m = mockStore({}, undefined, undefined, { notifier: notifierFrom(api) });
    await ready(m);
    m.store.getState().selectInstance(FO);
    const e = m.backend.crash(ATM, 1)!;
    await until(() => m.store.getState().crashBanner !== null);
    expect(m.store.getState().crashBanner).toMatchObject({ instanceId: ATM, sourceId: e.source.id });
    expect(api.send).not.toHaveBeenCalled();
    m.store.getState().openCrashAlert(m.store.getState().crashBanner!);
    const st = m.store.getState();
    expect(st.selectedInstanceId).toBe(ATM);
    expect(st.crashBanner).toBeNull();
    expect(st.selection).toMatchObject({ kind: 'crash', sourceId: e.source.id });
    // Asked once per run: the second crash does not ask again.
    m.backend.crash(FO, 2);
    await until(() => m.store.getState().crashBanner?.instanceId === FO);
    expect(api.request).toHaveBeenCalledTimes(1);
    m.store.getState().dismissCrashBanner();
    expect(m.store.getState().crashBanner).toBeNull();
  });

  it('the crash scenario fires once per watched instance after re-arming', async () => {
    const { notifier, sent } = recordingNotifier('sent');
    const m = mockStore({ scenario: 'crash', crashDelayMs: 5 }, undefined, undefined, { notifier });
    await m.store.getState().init();
    await until(() => sent.length === 2, 4000);
    expect(Object.keys(m.store.getState().crashAlerts).sort()).toEqual([ATM, FO].sort());
  });
});

describe('notifier', () => {
  it('asks once; granted sends, a refusal sticks for the run', async () => {
    const granted = { isGranted: vi.fn(async () => false), request: vi.fn(async () => 'granted'), send: vi.fn() };
    const n = notifierFrom(granted);
    expect(await Promise.all([n.notify('t', 'a'), n.notify('t', 'b')])).toEqual(['sent', 'sent']);
    expect(granted.request).toHaveBeenCalledTimes(1);
    expect(granted.send).toHaveBeenCalledWith('t', 'a');
    const failing = { isGranted: vi.fn(async () => { throw new Error('no plugin'); }), request: vi.fn(async () => 'granted'), send: vi.fn() };
    const d = notifierFrom(failing);
    expect(await d.notify('t', 'x')).toBe('denied');
    expect(await d.notify('t', 'y')).toBe('denied');
    expect(failing.isGranted).toHaveBeenCalledTimes(1);
    expect(failing.send).not.toHaveBeenCalled();
  });
});

describe('crashState helpers', () => {
  const s = (id: string, kind: 'crashReport' | 'latestLog' | 'hsErr', modifiedMs: number) => ({ id, kind, modifiedMs, size: 1 });

  it('defaults to the newest crash report or hs_err, else the newest log', () => {
    expect(defaultSourceId([s('logs/latest.log', 'latestLog', 9), s('crash-reports/a.txt', 'crashReport', 5), s('hs_err_pid1.log', 'hsErr', 7)])).toBe('hs_err_pid1.log');
    expect(defaultSourceId([s('logs/latest.log', 'latestLog', 9)])).toBe('logs/latest.log');
    expect(defaultSourceId([])).toBeNull();
  });

  it('upserts a source keeping newest-first order', () => {
    const list = sortSources([s('a', 'latestLog', 1), s('b', 'crashReport', 3)]);
    expect(upsertSource(list, s('a', 'latestLog', 5)).map((x) => x.id)).toEqual(['a', 'b']);
  });

  it('digestView marks every culprit line and keeps chunk gaps', () => {
    const digest = {
      source: s('logs/latest.log', 'latestLog', 0),
      totalLines: 100,
      truncated: true,
      chunks: [
        { startLine: 1, lines: ['a', 'b'], reasons: [{ kind: 'head' as const }] },
        { startLine: 50, lines: ['c\r', 'd'], reasons: [{ kind: 'tail' as const }] },
      ],
    };
    const v = digestView(digest, [
      {
        id: 'x', code: 'C-OOM', severity: 'error', title: '', explanation: '', culprits: [], fixes: [],
        evidence: [{ kind: 'log', source: 'logs/latest.log', lines: [{ n: 51, text: 'd', role: 'culprit' }], frames: [{ line: 51, jarId: 'mods/a.jar' }] }],
      },
    ]);
    expect(v.lines.map((l) => [l.n, l.text, l.role])).toEqual([
      [1, 'a', 'context'],
      [2, 'b', 'context'],
      [50, 'c', 'context'],
      [51, 'd', 'culprit'],
    ]);
    expect(v.frames).toEqual([{ line: 51, jarId: 'mods/a.jar' }]);
  });
});
