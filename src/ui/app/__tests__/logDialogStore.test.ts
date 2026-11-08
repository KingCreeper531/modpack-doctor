/**
 * Store parts of "Paste a log" and "Share on mclo.gs" (review M1, M3, M4): pasted text is
 * analysed as the kind of log it is, the share dialog cannot be closed or replaced while an
 * upload runs, and an upload can be deleted again.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import type { Result } from '../ipc';
import type { SharedLog } from '../../../bindings';
import { PASTED_SOURCE_ID, pastedSource, utf8Length } from '../logTools';
import { MOCK_INSTANCES } from '../mockData';
import { mockStore, until } from './helpers';

const ROOT = join(__dirname, '..', '..', '..', '..');
const fixture = (path: string): string => readFileSync(join(ROOT, 'fixtures', 'logs', path), 'utf8');
const ATM = MOCK_INSTANCES[0]!;

async function ready() {
  const m = mockStore();
  await m.store.getState().init();
  await until(() => m.store.getState().scans[ATM.id]?.status === 'done');
  return m;
}

describe('pasted text is analysed as the kind of log it is (M1)', () => {
  it('a pasted crash report is a crash report', async () => {
    const m = await ready();
    m.store.getState().analyzePastedText(ATM.id, fixture('fabric/fab20-noclassdef-missing-dep.txt'));
    const c = m.store.getState().crashes[ATM.id]!;
    expect(c.sources.find((s) => s.id === PASTED_SOURCE_ID)?.kind).toBe('crashReport');
    const a = c.analyses[PASTED_SOURCE_ID]!;
    expect(a.status).toBe('done');
    expect(a.digest?.source.kind).toBe('crashReport');
    expect(a.findings.some((f) => f.severity === 'error')).toBe(true);
  });

  it('a pasted hs_err file is an hs_err file, with its native-crash finding', async () => {
    const m = await ready();
    m.store.getState().analyzePastedText(ATM.id, fixture('jvm/hs_err_pid20516-nvidia-nvoglv64.log'));
    const c = m.store.getState().crashes[ATM.id]!;
    expect(c.sources.find((s) => s.id === PASTED_SOURCE_ID)?.kind).toBe('hsErr');
    const a = c.analyses[PASTED_SOURCE_ID]!;
    expect(a.digest?.source.kind).toBe('hsErr');
    expect(a.findings.map((f) => f.code)).toContain('C-NATIVE');
  });

  it('console text stays a log, and the size is counted in UTF-8 bytes without encoding', () => {
    expect(pastedSource('Error: Could not create the Java Virtual Machine.\n', 0).kind).toBe('latestLog');
    for (const t of ['', 'abc', 'Jürgen', '€', '\u{1F525}', 'a\ud800b', '\udc00']) {
      expect(utf8Length(t), JSON.stringify(t)).toBe(new TextEncoder().encode(t).length);
    }
  });
});

describe('the share dialog while an upload runs (M3)', () => {
  it('cannot be closed or replaced until the upload is answered', async () => {
    const m = await ready();
    let answer: (r: Result<SharedLog>) => void = () => undefined;
    vi.spyOn(m.backend.commands, 'shareLog').mockImplementation(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    );
    const st = () => m.store.getState();
    const dialog = { kind: 'share' as const, instanceId: ATM.id, sourceId: 'logs/latest.log' };
    st().setLogDialog(dialog);
    const pending = st().shareLog(ATM.id, 'logs/latest.log');
    expect(st().logDialogBusy).toBe(true);
    st().setLogDialog(null);
    st().setLogDialog({ kind: 'paste', instanceId: ATM.id });
    expect(st().logDialog).toEqual(dialog);

    answer({ status: 'ok', data: { url: 'https://mclo.gs/Late1', rawUrl: 'https://api.mclo.gs/1/raw/Late1', totalLines: 1, sentLines: 1, truncated: false } });
    await pending;
    expect(st().logDialogBusy).toBe(false);
    st().setLogDialog(null);
    expect(st().logDialog).toBeNull();
  });

  it('a failed upload releases the dialog too', async () => {
    const m = await ready();
    vi.spyOn(m.backend.commands, 'shareLog').mockRejectedValue(new Error('bridge gone'));
    const r = await m.store.getState().shareLog(ATM.id, 'logs/latest.log');
    expect(r.status).toBe('error');
    expect(m.store.getState().logDialogBusy).toBe(false);
  });
});

describe('deleting an upload (M4)', () => {
  it('passes only the id of an mclo.gs link to Rust', async () => {
    const m = await ready();
    const del = vi.spyOn(m.backend.commands, 'deleteSharedLog');
    const shared = await m.store.getState().shareLog(ATM.id, 'logs/latest.log');
    expect(shared.status).toBe('ok');
    const url = shared.status === 'ok' ? shared.data.url : '';
    expect(await m.store.getState().deleteSharedLog(url)).toEqual({ status: 'ok', data: null });
    expect(del).toHaveBeenCalledWith('Mock1');
    expect(m.backend.deletedShares()).toEqual(['Mock1']);
    // Twice: the mock, like Rust, has no delete key any more.
    const again = await m.store.getState().deleteSharedLog(url);
    expect(again.status === 'error' && again.error.kind).toBe('notFound');
  });

  it('refuses anything that is not a mclo.gs page link without calling Rust', async () => {
    const m = await ready();
    const del = vi.spyOn(m.backend.commands, 'deleteSharedLog');
    for (const url of ['https://evil.example/Mock1', 'https://mclo.gs/a/b', 'https://api.mclo.gs/1/raw/Mock1', '']) {
      const r = await m.store.getState().deleteSharedLog(url);
      expect(r.status, url).toBe('error');
    }
    expect(del).not.toHaveBeenCalled();
    expect(m.store.getState().logDialogBusy).toBe(false);
  });
});
