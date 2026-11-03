/** Pure helpers added for the M3 review: layout, override validation, codes, clipping, fades. */
import { describe, expect, it } from 'vitest';

import type { LogLine } from '../../../core/model';
import { codeSeverity, severityQualifier } from '../../components/labels';
import { clipExcerpt } from '../../components/logModel';
import { keepsOutline } from '../../components/tileGridModel';
import { inspectorLayout, MIN_WORKSPACE, RAIL_WIDTH } from '../layout';
import { checkOverride, MC_HINT, VERSION_EMPTY_HINT, VERSION_SPACE_HINT } from '../override';

describe('inspectorLayout', () => {
  it('docks at full preferred width when there is room', () => {
    expect(inspectorLayout(1920, 360)).toEqual({ mode: 'docked', width: 360 });
    expect(inspectorLayout(1280, 360)).toEqual({ mode: 'docked', width: 360 });
    expect(inspectorLayout(1280, 640)).toEqual({ mode: 'docked', width: 1280 - RAIL_WIDTH - MIN_WORKSPACE });
  });

  it('shrinks toward 280px, then becomes a drawer below ~1170px', () => {
    expect(inspectorLayout(RAIL_WIDTH + MIN_WORKSPACE + 280, 640)).toEqual({ mode: 'docked', width: 280 });
    expect(inspectorLayout(1100, 360)).toEqual({ mode: 'drawer', width: 360 });
    expect(inspectorLayout(960, 360).mode).toBe('drawer');
    expect(inspectorLayout(960, 640).width).toBe(640);
    expect(inspectorLayout(900, 640).width).toBe(900 - RAIL_WIDTH - 48);
  });

  it('keeps the workspace at least MIN_WORKSPACE wide whenever docked', () => {
    for (let vw = 960; vw <= 2560; vw += 7) {
      const l = inspectorLayout(vw, 640);
      if (l.mode === 'docked') expect(vw - RAIL_WIDTH - l.width).toBeGreaterThanOrEqual(MIN_WORKSPACE);
      expect(l.width).toBeGreaterThanOrEqual(280);
    }
  });
});

describe('checkOverride', () => {
  it('accepts recognised MC versions (legacy, year-based, snapshots) and blank fields', () => {
    for (const mc of ['1.20.1', '26.1', '24w14a', '1.20.5-pre1', '']) {
      expect(checkOverride({ mc, kind: '', version: '', side: '' }).valid).toBe(true);
    }
    expect(checkOverride({ mc: '', kind: '', version: '', side: '' }).override).toBeNull();
    expect(checkOverride({ mc: ' 1.21.1 ', kind: 'neoforge', version: '21.1.77', side: 'server' }).override).toEqual({
      mcVersion: '1.21.1',
      loader: { kind: 'neoforge', version: '21.1.77' },
      side: 'server',
    });
  });

  it('refuses an unrecognised MC version with a hint', () => {
    const c = checkOverride({ mc: '1.20.1 forge', kind: '', version: '', side: '' });
    expect(c.valid).toBe(false);
    expect(c.override).toBeNull();
    expect(c.errors.mc).toBe(MC_HINT);
    expect(checkOverride({ mc: 'banana', kind: '', version: '', side: '' }).errors.mc).toBe(MC_HINT);
  });

  it('requires a loader version without spaces once a loader is picked', () => {
    expect(checkOverride({ mc: '', kind: 'forge', version: '  ', side: '' }).errors.version).toBe(VERSION_EMPTY_HINT);
    expect(checkOverride({ mc: '', kind: 'forge', version: '47.3 .0', side: '' }).errors.version).toBe(VERSION_SPACE_HINT);
    expect(checkOverride({ mc: '', kind: 'forge', version: '47.3.0', side: '' }).valid).toBe(true);
    expect(checkOverride({ mc: '', kind: '', version: 'ignored', side: '' }).errors.version).toBeUndefined();
  });
});

describe('code vs severity', () => {
  it('reads the severity a prefix implies', () => {
    expect(codeSeverity('E-DUP-ID')).toBe('error');
    expect(codeSeverity('W-JAVA-CLASS')).toBe('warning');
    expect(codeSeverity('I-SPLIT-PKG')).toBe('info');
    expect(codeSeverity('C-MIXIN')).toBeNull();
  });

  it('qualifies only codes whose prefix disagrees', () => {
    expect(severityQualifier('E-DUP-ID', 'error')).toBeNull();
    expect(severityQualifier('E-DUP-ID', 'warning')).toBe('warn');
    expect(severityQualifier('E-MC-RANGE', 'info')).toBe('info');
    expect(severityQualifier('W-CORRUPT-JAR', 'error')).toBe('error');
    expect(severityQualifier('C-ROOT-CAUSE', 'error')).toBeNull();
  });
});

describe('clipExcerpt', () => {
  const lines = (n: number, culprit: number[]): LogLine[] =>
    Array.from({ length: n }, (_, i) => ({ n: i + 1, text: `l${i + 1}`, role: culprit.includes(i + 1) ? 'culprit' : 'context' }));

  it('leaves short excerpts alone', () => {
    expect(clipExcerpt(lines(12, [3]), 12)).toEqual({ lines: lines(12, [3]), clipped: false });
  });

  it('keeps a window around the first highlighted line', () => {
    const c = clipExcerpt(lines(40, [20, 22]), 12);
    expect(c.clipped).toBe(true);
    expect(c.lines.map((l) => l.n)).toEqual([18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29]);
    expect(clipExcerpt(lines(40, []), 12).lines[0]!.n).toBe(1);
    expect(clipExcerpt(lines(40, [39]), 12).lines.at(-1)!.n).toBe(40);
  });
});

describe('keepsOutline', () => {
  it('keeps the unscanned outline through a fade that starts from unscanned or interrupts one', () => {
    expect(keepsOutline('unscanned')).toBe(true);
    expect(keepsOutline('ok')).toBe(false);
    expect(keepsOutline('ok', { outline: true })).toBe(true);
    expect(keepsOutline('warning', { outline: false })).toBe(false);
  });
});
