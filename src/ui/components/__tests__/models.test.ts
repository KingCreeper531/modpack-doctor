import { describe, expect, it } from 'vitest';

import type { PlannedOp, WorkOrder } from '../../../bindings';
import { basename, formatAgo, formatBytes, formatDuration, formatInt, opNumber, plural } from '../format';
import { fixLabel, probeResult } from '../labels';
import { buildLogRows, excerptLines, gutterChars } from '../logModel';
import { matchMask, matchRuns } from '../paletteModel';
import { rovingIndex } from '../roving';
import { describeOp, enterExecutes } from '../workOrderModel';

describe('format', () => {
  it('formats numbers, sizes and times', () => {
    expect(formatInt(1204)).toBe('1,204');
    expect(formatBytes(319_488)).toBe('312 KB');
    expect(formatBytes(900)).toBe('900 B');
    expect(formatBytes(4.2 * 1024 * 1024)).toBe('4.2 MB');
    expect(formatAgo(2100)).toBe('2.1s ago');
    expect(formatAgo(185_000)).toBe('3m ago');
    expect(formatDuration(840)).toBe('840ms');
    expect(formatDuration(64_000)).toBe('1m 04s');
    expect(plural(1, 'error')).toBe('1 error');
    expect(plural(3, 'error')).toBe('3 errors');
    expect(opNumber(0)).toBe('01');
  });

  it('takes the file name of jar ids', () => {
    expect(basename('mods/sodium-0.5.8.jar')).toBe('sodium-0.5.8.jar');
    expect(basename('mods/x.jar#disabled')).toBe('x.jar');
    expect(basename('mods/a.jar!/META-INF/jarjar/b.jar')).toBe('b.jar');
  });
});

describe('labels', () => {
  it('describes probe results with tones', () => {
    expect(probeResult({ state: 'notInstalled' })).toEqual({ text: 'not installed', tone: 'faint' });
    expect(probeResult({ state: 'found', count: 0 })).toEqual({ text: '0 instances', tone: 'dim' });
    expect(probeResult({ state: 'found', count: 1 }).text).toBe('1 instance');
    expect(probeResult({ state: 'permissionDenied' }).tone).toBe('err');
  });
  it('labels fixes', () => {
    expect(fixLabel({ kind: 'disable', jarId: 'mods/sodium.jar' })).toBe('Disable sodium.jar');
    expect(fixLabel({ kind: 'disable', jarId: 'mods/sodium.jar' }, { 'mods/sodium.jar': 'Sodium' })).toBe('Disable Sodium');
    expect(fixLabel({ kind: 'removeDuplicate', keep: 'mods/a.jar', remove: 'mods/b.jar' })).toBe('Remove b.jar, keep a.jar');
  });
});

describe('buildLogRows', () => {
  const lines = [
    { n: 10, text: 'a', role: 'context' as const },
    { n: 11, text: 'b', role: 'culprit' as const },
    { n: 1215, text: 'c', role: 'context' as const },
  ];
  it('inserts gap dividers and attaches frame jars', () => {
    const rows = buildLogRows(lines, [{ line: 11, jarId: 'mods/x.jar' }, { line: 11, jarId: 'mods/x.jar' }]);
    expect(rows).toEqual([
      { kind: 'line', n: 10, text: 'a', culprit: false, jarIds: [] },
      { kind: 'line', n: 11, text: 'b', culprit: true, jarIds: ['mods/x.jar'] },
      { kind: 'gap', count: 1203 },
      { kind: 'line', n: 1215, text: 'c', culprit: false, jarIds: [] },
    ]);
  });
  it('marks head and tail elision when the total is known', () => {
    const rows = buildLogRows(lines, [], 2000);
    expect(rows[0]).toEqual({ kind: 'gap', count: 9 });
    expect(rows[rows.length - 1]).toEqual({ kind: 'gap', count: 785 });
    expect(gutterChars(rows)).toBe(4);
  });
  it('splits metadata excerpts with highlights', () => {
    expect(excerptLines('a\r\nb\nc\n', [2])).toEqual([
      { n: 1, text: 'a', role: 'context' },
      { n: 2, text: 'b', role: 'culprit' },
      { n: 3, text: 'c', role: 'context' },
    ]);
  });
});

describe('palette matching', () => {
  it('prefers contiguous matches, falls back to subsequence', () => {
    expect(matchMask('sodium', 'sod')).toEqual([true, true, true, false, false, false]);
    expect(matchMask('Rescan instance', 'rsi')?.filter(Boolean)).toHaveLength(3);
    expect(matchMask('sodium', 'xyz')).toBeNull();
    expect(matchRuns('sodium', [true, true, true, false, false, false])).toEqual([
      { text: 'sod', hit: true },
      { text: 'ium', hit: false },
    ]);
  });
});

describe('work order', () => {
  const rename: PlannedOp = { actionIndex: 0, op: { op: 'rename', from: 'mods/a.jar.disabled', to: 'mods/a.jar' } };
  const download: PlannedOp = {
    actionIndex: 0,
    op: {
      op: 'download',
      projectTitle: 'sodium',
      versionNumber: '0.5.11',
      sizeBytes: 319_488,
      url: 'https://cdn.modrinth.com/data/AANobbMI/versions/x/sodium.jar',
      sha512: 'ab',
      dest: 'mods/sodium-0.5.11.jar',
      replaces: 'mods/sodium-0.5.8.jar',
    },
  };
  const order = (kind: WorkOrder['kind'], ops: PlannedOp[]) => ({ kind, ops });

  it('lets Enter execute only a single-rename undo', () => {
    expect(enterExecutes(order('undo', [rename]))).toBe(true);
    expect(enterExecutes(order('fix', [rename]))).toBe(false);
    expect(enterExecutes(order('undo', [rename, rename]))).toBe(false);
    expect(enterExecutes(order('undo', [download]))).toBe(false);
    expect(enterExecutes(order('undo', []))).toBe(false);
  });

  it('describes ops as checklist lines', () => {
    expect(describeOp(download.op)).toEqual({
      verb: 'download',
      subject: 'sodium 0.5.11 (312 KB) from cdn.modrinth.com',
      target: 'mods/sodium-0.5.11.jar',
      detail: 'replaces mods/sodium-0.5.8.jar',
    });
    expect(describeOp(rename.op)).toMatchObject({ verb: 'rename', subject: 'mods/a.jar.disabled', target: 'mods/a.jar' });
  });
});

describe('roving keys', () => {
  it('radio groups: all arrows wrap, Home/End jump, other keys are ignored', () => {
    expect(rovingIndex('ArrowRight', 0, 3)).toBe(1);
    expect(rovingIndex('ArrowDown', 2, 3)).toBe(0);
    expect(rovingIndex('ArrowLeft', 0, 3)).toBe(2);
    expect(rovingIndex('ArrowUp', 1, 3)).toBe(0);
    expect(rovingIndex('Home', 2, 3)).toBe(0);
    expect(rovingIndex('End', 0, 3)).toBe(2);
    expect(rovingIndex('Enter', 0, 3)).toBeNull();
    expect(rovingIndex('ArrowRight', -1, 3)).toBe(1);
    expect(rovingIndex('Home', 0, 0)).toBeNull();
  });

  it('horizontal tab lists take Left/Right/Home/End only', () => {
    expect(rovingIndex('ArrowRight', 1, 2, 'tabs')).toBe(0);
    expect(rovingIndex('ArrowLeft', 0, 2, 'tabs')).toBe(1);
    expect(rovingIndex('ArrowDown', 0, 2, 'tabs')).toBeNull();
    expect(rovingIndex('End', 0, 2, 'tabs')).toBe(1);
  });
});
