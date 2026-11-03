/** Crash analysis and watch mode in the store (M4), against the mock backend and the real rules core. */
import { describe, expect, it, vi } from 'vitest';

import type { CrashDetected, DiscoveryReport } from '../../../bindings';
import { CRASH_ANCHORS } from '../../../core/crash';
import type { CrashSummary } from '../../../core/crash/summary';
import { CRASH_NOTIFICATION_FALLBACK_TITLE, crashNotification, defaultSourceId, digestView, sortSources, upsertSource } from '../crashState';
import type { Result } from '../ipc';
import { MOCK_INSTANCES } from '../mockData';
import { notifierFrom, type Notifier } from '../notify';
import { watchAnchors } from '../store';
import { finding, mockStore, until } from './helpers';

const ATM = MOCK_INSTANCES[0]!.id;
const ATM_NAME = MOCK_INSTANCES[0]!.name;
const FO = MOCK_INSTANCES[1]!.id;
const FO_NAME = MOCK_INSTANCES[1]!.name;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
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

  it('a listing error is kept per instance (permission); a .mrpack lists no logs, as in Rust', async () => {
    const m = mockStore({ scenario: 'errors' });
    await m.store.getState().init();
    await until(() => m.store.getState().crashes[ATM]?.sourcesStatus === 'error');
    expect(m.store.getState().crashes[ATM]!.sourcesError).toMatchObject({ kind: 'permission' });
    m.store.getState().selectInstance(MRPACK);
    await until(() => m.store.getState().crashes[MRPACK]?.sourcesStatus === 'done');
    expect(m.store.getState().crashes[MRPACK]).toMatchObject({ sources: [], sourcesError: null, selectedSourceId: null });
    // Rust (commands/logs.rs) refuses to read or watch a .mrpack: the mock does too.
    expect((await m.backend.commands.readLogDigest(MRPACK, 'logs/latest.log', ['x'], null)).status).toBe('error');
    expect(await m.backend.commands.setWatch(MRPACK, true, watchAnchors())).toMatchObject({ status: 'error', error: { kind: 'invalid' } });
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

  /** The mock's discovery report without the given instances. */
  async function reportWithout(m: ReturnType<typeof mockStore>, ...ids: string[]): Promise<Result<DiscoveryReport>> {
    const r = await m.backend.commands.discoverInstances();
    if (r.status !== 'ok') throw new Error('discovery failed');
    return { status: 'ok', data: { ...r.data, instances: r.data.instances.filter((i) => !ids.includes(i.id)) } };
  }

  it('re-arms after every discovery load: never an absent id, again when it comes back, never twice while armed', async () => {
    const m = mockStore({ scenario: 'crash', crashDelayMs: 60_000 });
    const sw = vi.spyOn(m.backend.commands, 'setWatch');
    const armedIds = () => sw.mock.calls.map((c) => c[0]);
    // Startup: FO is watched but not on disk right now.
    vi.spyOn(m.backend.commands, 'discoverInstances').mockResolvedValueOnce(await reportWithout(m, FO));
    await m.store.getState().init();
    await until(() => m.backend.watches().has(ATM) && !m.store.getState().watchPending[ATM]);
    expect(armedIds()).toEqual([ATM]);
    expect(m.store.getState().watchErrors[FO]).toBeUndefined();
    // A discovery load that lists FO again arms it; ATM is armed already.
    await m.store.getState().addLauncherRoot('prism');
    await until(() => m.backend.watches().has(FO) && !m.store.getState().watchPending[FO]);
    expect(armedIds()).toEqual([ATM, FO]);
    // ATM vanishes (Rust stops its watcher on rediscovery): nothing is armed for it…
    vi.spyOn(m.backend.commands, 'pickLauncherRoot').mockResolvedValueOnce(await reportWithout(m, ATM));
    await m.store.getState().addLauncherRoot('prism');
    await sleep(10);
    expect(armedIds()).toEqual([ATM, FO]);
    // …and it is re-armed when it reappears.
    await m.store.getState().addLauncherRoot('prism');
    await until(() => armedIds().length === 3 && !m.store.getState().watchPending[ATM]);
    expect(armedIds()).toEqual([ATM, FO, ATM]);
    for (const [, enabled, anchors] of sw.mock.calls) {
      expect(enabled).toBe(true);
      expect(anchors).toEqual(watchAnchors());
    }
  });

  it('a failed re-arm shows its error and is retried on the next discovery load', async () => {
    const m = mockStore({ scenario: 'crash', crashDelayMs: 60_000 });
    const real = m.backend.commands.setWatch;
    let failures = 1;
    const sw = vi.spyOn(m.backend.commands, 'setWatch').mockImplementation(async (id, enabled, anchors) => {
      if (id === FO && failures-- > 0) return { status: 'error', error: { kind: 'io', message: 'The logs folder could not be watched.', path: null } };
      return real(id, enabled, anchors);
    });
    await m.store.getState().init();
    await until(() => !!m.store.getState().watchErrors[FO] && m.backend.watches().has(ATM));
    expect(m.backend.watches().has(FO)).toBe(false);
    // The toggle was disabled while arming, and is usable again.
    expect(m.store.getState().watchPending).toEqual({});
    await m.store.getState().addLauncherRoot('prism');
    await until(() => m.backend.watches().has(FO) && !m.store.getState().watchPending[FO]);
    expect(m.store.getState().watchErrors[FO]).toBeUndefined();
    expect(sw.mock.calls.filter((c) => c[0] === ATM)).toHaveLength(1);
    expect(sw.mock.calls.filter((c) => c[0] === FO)).toHaveLength(2);
  });

  it('turning watch off and on again keeps re-arm from repeating it', async () => {
    const m = mockStore();
    await ready(m);
    const sw = vi.spyOn(m.backend.commands, 'setWatch');
    await m.store.getState().setWatch(ATM, true);
    await m.store.getState().addLauncherRoot('prism');
    await sleep(10);
    expect(sw).toHaveBeenCalledTimes(1);
    await m.store.getState().setWatch(ATM, false);
    expect(sw).toHaveBeenCalledTimes(2);
    await m.store.getState().addLauncherRoot('prism');
    await sleep(10);
    // Not watched any more: nothing to re-arm.
    expect(sw).toHaveBeenCalledTimes(2);
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
  it('analyses the episode source, notifies once naming the instance and the likely cause, alerts and selects the crash', async () => {
    const { notifier, sent } = recordingNotifier('sent');
    const m = mockStore({}, undefined, undefined, { notifier });
    await ready(m);
    m.store.getState().selectInstance(FO);
    const e = m.backend.crash(ATM, 7)!;
    await until(() => !!m.store.getState().crashAlerts[ATM]);
    const st = m.store.getState();
    const a = analysis(m, ATM, e.source.id)!;
    expect(a.summary).not.toBeNull();
    expect(sent).toEqual([{ title: `${ATM_NAME} crashed`, body: `Likely cause: ${a.summary!.likelyCause!}` }]);
    expect(sent[0]!.body).toMatch(/Pipeworks/);
    expect(sent[0]!.body).not.toContain(a.summary!.headline);
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
    expect(sent.map((s) => s.title).sort()).toEqual([`${ATM_NAME} crashed`, `${FO_NAME} crashed`].sort());
    // ATM is open (its crash is on screen): only FO's crash is unseen.
    expect(m.store.getState().selectedInstanceId).toBe(ATM);
    expect(Object.keys(m.store.getState().crashAlerts)).toEqual([FO]);
  });

  it('race: a Refresh while the episode is read still announces it exactly once', async () => {
    // Reviewer's repro: CrashDetected with a stat that differs from the listing (size - 1, as
    // for a file still being written), loadLogSources right away, every digest read 30 ms late.
    const { notifier, sent } = recordingNotifier('sent');
    const m = mockStore({}, undefined, undefined, { notifier });
    await ready(m);
    m.store.getState().selectInstance(FO);
    await until(() => m.store.getState().crashes[FO]?.sourcesStatus === 'done');
    const real = m.backend.commands.readLogDigest;
    const read = vi.spyOn(m.backend.commands, 'readLogDigest').mockImplementation(async (...args) => {
      await sleep(30);
      return real(...args);
    });
    const listed = m.store.getState().crashes[ATM]!.sources.find((s) => s.id === NEWEST_CRASH)!;
    const e: CrashDetected = { instanceId: ATM, episode: 1, source: { ...listed, size: listed.size - 1 }, triggers: [{ kind: 'processExit', pid: 1 }] };
    m.backend.emitCrashDetected(e);
    void m.store.getState().loadLogSources(ATM);
    await until(() => sent.length > 0);
    await sleep(80);
    expect(sent).toEqual([{ title: `${ATM_NAME} crashed`, body: expect.stringMatching(/^Likely cause: /) as string }]);
    expect(m.store.getState().crashAlerts[ATM]).toMatchObject({ episode: 1, sourceId: NEWEST_CRASH });
    expect(analysis(m, ATM, NEWEST_CRASH)?.status).toBe('done');
    // The Refresh shared the episode's read instead of starting another one.
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('race: a forced re-read (Retry) during the episode read hands the episode the newer analysis', async () => {
    const { notifier, sent } = recordingNotifier('denied');
    const m = mockStore({}, undefined, undefined, { notifier });
    await ready(m);
    m.store.getState().selectInstance(FO);
    const real = m.backend.commands.readLogDigest;
    vi.spyOn(m.backend.commands, 'readLogDigest').mockImplementation(async (...args) => {
      await sleep(30);
      return real(...args);
    });
    const listed = m.store.getState().crashes[ATM]!.sources.find((s) => s.id === NEWEST_CRASH)!;
    m.backend.emitCrashDetected({ instanceId: ATM, episode: 2, source: listed, triggers: [{ kind: 'processExit', pid: 1 }] });
    await sleep(5);
    void m.store.getState().analyzeLogSource(ATM, NEWEST_CRASH, true);
    await until(() => m.store.getState().crashBanner !== null);
    await sleep(80);
    expect(sent).toHaveLength(1);
    expect(m.store.getState().crashBanner).toMatchObject({ instanceId: ATM, episode: 2 });
    expect(m.store.getState().crashAlerts[ATM]).toMatchObject({ episode: 2 });
  });

  it('race: a listing that started before the crash file existed keeps the announced file listed', async () => {
    const { notifier, sent } = recordingNotifier('sent');
    const m = mockStore({}, undefined, undefined, { notifier });
    await ready(m);
    m.store.getState().selectInstance(FO);
    const real = m.backend.commands.listLogSources;
    // The listing sees the folder before the crash report is written, and answers late.
    const before = await real(ATM);
    vi.spyOn(m.backend.commands, 'listLogSources').mockImplementationOnce(async () => {
      await sleep(20);
      return before;
    });
    const realRead = m.backend.commands.readLogDigest;
    vi.spyOn(m.backend.commands, 'readLogDigest').mockImplementation(async (...args) => {
      await sleep(40);
      return realRead(...args);
    });
    void m.store.getState().loadLogSources(ATM);
    const e = m.backend.crash(ATM, 5)!;
    await until(() => sent.length === 1);
    const c = m.store.getState().crashes[ATM]!;
    expect(c.sources.some((s) => s.id === e.source.id)).toBe(true);
    expect(c.selectedSourceId).toBe(e.source.id);
  });

  it('a crash in the open instance notifies but raises no unseen alert; the crash is on screen', async () => {
    const { notifier, sent } = recordingNotifier('sent');
    const m = mockStore({}, undefined, undefined, { notifier });
    await ready(m);
    expect(m.store.getState().selectedInstanceId).toBe(ATM);
    const e = m.backend.crash(ATM, 1)!;
    await until(() => sent.length === 1);
    const st = m.store.getState();
    expect(st.crashAlerts[ATM]).toBeUndefined();
    expect(st.findingsTab[ATM]).toBe('crashes');
    expect(st.crashes[ATM]!.selectedSourceId).toBe(e.source.id);
    expect(st.crashes[ATM]!.pane).toBe('diagnosis');
    // Another instance's crash is unseen until it is opened.
    m.backend.crash(FO, 2);
    await until(() => sent.length === 2);
    expect(m.store.getState().crashAlerts[FO]).toMatchObject({ episode: 2 });
    m.store.getState().selectInstance(FO);
    expect(m.store.getState().crashAlerts[FO]).toBeUndefined();
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

  it('crashNotification: "<instance> crashed", the likely cause, else the finding title; never the headline', () => {
    const top = finding('c1', 'error', [], { code: 'C-ROOT-CAUSE', title: 'java.lang.IllegalStateException: boom' });
    const known: CrashSummary = { headline: 'Modpack crashed — likely cause: Pipeworks broke', likelyCause: 'Pipeworks broke', culpritFiles: [] };
    expect(crashNotification('All the Mods 9', known, [top], 'crash-reports/c.txt')).toEqual({ title: 'All the Mods 9 crashed', body: 'Likely cause: Pipeworks broke' });
    expect(crashNotification(null, known, [top], 'crash-reports/c.txt').title).toBe(CRASH_NOTIFICATION_FALLBACK_TITLE);
    expect(crashNotification('  ', known, [top], 'crash-reports/c.txt').title).toBe('Modpack crashed');
    const unknown: CrashSummary = { headline: 'Modpack crashed — java.lang.IllegalStateException: boom', likelyCause: null, culpritFiles: [] };
    const n = crashNotification('ATM9', unknown, [finding('w', 'warning', []), top], 'crash-reports/c.txt');
    expect(n).toEqual({ title: 'ATM9 crashed', body: 'java.lang.IllegalStateException: boom' });
    expect(n.body).not.toBe(unknown.headline);
    // No usable title: point at the file rather than repeat the headline.
    const blank = crashNotification('ATM9', { headline: 'Modpack crashed', likelyCause: null, culpritFiles: [] }, [{ ...top, title: '' }], 'crash-reports/c.txt');
    expect(blank.body).toBe('See c.txt in Modpack Doctor.');
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
