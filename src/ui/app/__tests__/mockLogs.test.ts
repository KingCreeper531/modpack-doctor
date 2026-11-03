/** The mock backend's log and watch commands have the exact shapes of the bindings (M4). */
import { describe, expect, it } from 'vitest';

import { MOCK_INSTANCES } from '../mockData';
import { createMockBackend, mockOptionsFromSearch } from '../mockIpc';

const atm = MOCK_INSTANCES[0]!.id;

describe('mock logs and watch commands match the bindings', () => {
  it('list_log_sources: exactly the LogSource fields, newest first, real byte sizes', async () => {
    const b = createMockBackend({ latencyMs: 0 });
    const r = await b.commands.listLogSources(atm);
    if (r.status !== 'ok') throw new Error('expected ok');
    expect(r.data.length).toBeGreaterThan(3);
    for (const s of r.data) {
      expect(Object.keys(s).sort()).toEqual(['id', 'kind', 'modifiedMs', 'size']);
      expect(['crashReport', 'latestLog', 'debugLog', 'hsErr']).toContain(s.kind);
      expect(s.id).not.toMatch(/\\|^[A-Za-z]:/);
      expect(Number.isInteger(s.size) && s.size > 0).toBe(true);
    }
    const times = r.data.map((s) => s.modifiedMs);
    expect(times).toEqual([...times].sort((x, y) => y - x));
    expect(await b.commands.listLogSources('nope')).toMatchObject({ status: 'error', error: { kind: 'notFound' } });
  });

  it('read_log_digest: a LogDigest of the listed file; unlisted ids are refused', async () => {
    const b = createMockBackend({ latencyMs: 0 });
    const r = await b.commands.readLogDigest(atm, 'logs/latest.log', ['Caused by: '], null);
    if (r.status !== 'ok') throw new Error('expected ok');
    expect(Object.keys(r.data).sort()).toEqual(['chunks', 'source', 'totalLines', 'truncated']);
    expect(r.data.source.id).toBe('logs/latest.log');
    expect(r.data.totalLines).toBeGreaterThan(2000);
    expect(r.data.chunks[0]).toMatchObject({ startLine: 1, reasons: [{ kind: 'head' }] });
    expect(r.data.chunks[0]!.lines.some((l) => l.endsWith('\r'))).toBe(false);
    expect(await b.commands.readLogDigest(atm, '../../secret.txt', ['x'], null)).toMatchObject({ status: 'error', error: { kind: 'notFound' } });
  });

  it('set_watch records the anchors and Settings.watched; game_running is a GameStatus', async () => {
    const b = createMockBackend({ latencyMs: 0 });
    expect(await b.commands.setWatch(atm, true, [{ text: '#@!@# Game crashed!', tier: 'fatal' }])).toEqual({ status: 'ok', data: null });
    expect(b.settings().watched).toEqual([atm]);
    expect(b.watches().get(atm)).toEqual([{ text: '#@!@# Game crashed!', tier: 'fatal' }]);
    expect((await b.commands.setWatch(atm, true, [])).status).toBe('error');
    await b.commands.setWatch(atm, false, []);
    expect(b.settings().watched).toEqual([]);
    expect(await b.commands.gameRunning(atm)).toEqual({ status: 'ok', data: { running: false, pids: [], reason: null } });
  });

  it('crash scenario: watched from the start, running until the crash, then a new crash report and one event', async () => {
    const b = createMockBackend({ latencyMs: 0, scenario: 'crash' });
    expect(b.settings().watched.length).toBe(2);
    const g = await b.commands.gameRunning(atm);
    expect(g.status === 'ok' && g.data.running).toBe(true);
    const seen: unknown[] = [];
    await b.events.crashDetected.listen((e) => seen.push(e));
    const e = b.crash(atm, 1)!;
    expect(seen).toEqual([e]);
    expect(e.triggers[0]).toEqual({ kind: 'newCrashReport', source_id: e.source.id });
    const list = await b.commands.listLogSources(atm);
    expect(list.status === 'ok' && list.data[0]!.id).toBe(e.source.id);
    const g2 = await b.commands.gameRunning(atm);
    expect(g2.status === 'ok' && g2.data.running).toBe(false);
    expect(mockOptionsFromSearch('?scenario=crash').scenario).toBe('crash');
  });
});
