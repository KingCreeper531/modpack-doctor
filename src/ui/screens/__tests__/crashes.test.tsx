// @vitest-environment happy-dom
/** Crash view, evidence chips, watch toggle, rail alert and banner (M4), rendered. */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { LogLine } from '../../../core/model';
import { App } from '../../app/App';
import { mockStore, until } from '../../app/__tests__/helpers';
import { MOCK_INSTANCES } from '../../app/mockData';
import { LogViewer, VIRTUAL_ROWS } from '../../components/LogViewer';

afterEach(cleanup);

function setViewport(width: number) {
  (window as unknown as { happyDOM: { setViewport(v: { width: number; height: number }): void } }).happyDOM.setViewport({ width, height: 900 });
  window.dispatchEvent(new Event('resize'));
}

beforeEach(() => setViewport(1600));

const ATM = MOCK_INSTANCES[0]!;
const FO = MOCK_INSTANCES[1]!;
const MRPACK = MOCK_INSTANCES.find((i) => i.launcher === 'mrpack')!;
const NEWEST_CRASH = 'crash-reports/crash-2026-11-03_14.22.07-client.txt';
const EMBERFORGE = 'mods/emberforge-1.20.1-2.4.0.jar';

async function renderApp(...args: Parameters<typeof mockStore>) {
  const m = mockStore(...args);
  render(<App store={m.store} />);
  await act(async () => {
    await m.store.getState().init();
    await until(() => m.store.getState().scans[ATM.id]?.status === 'done');
    await until(() => !!m.store.getState().crashes[ATM.id]?.analyses[NEWEST_CRASH]?.mapped);
  });
  return m;
}

describe('crashes panel', () => {
  it('lists the log sources newest first with kind, mono path, age and size', async () => {
    await renderApp();
    fireEvent.click(screen.getByRole('tab', { name: /Crashes/ }));
    expect(screen.getByRole('tab', { name: /Crashes/ }).getAttribute('aria-selected')).toBe('true');
    const list = screen.getByRole('list', { name: 'Crash reports and logs' });
    const rows = within(list).getAllByRole('button');
    expect(rows[0]!.getAttribute('title')).toBe('logs/latest.log');
    expect(rows[0]!.textContent).toMatch(/latest log/);
    expect(rows[0]!.textContent).toMatch(/25m ago/);
    expect(rows[0]!.textContent).toMatch(/KB/);
    const selected = rows.find((r) => r.getAttribute('aria-current') === 'true')!;
    expect(selected.getAttribute('title')).toBe(NEWEST_CRASH);
  });

  it('crash findings are triage rows marked with their file; expanding shows the log with amber culprit lines', async () => {
    const m = await renderApp();
    fireEvent.click(screen.getByRole('tab', { name: /Crashes/ }));
    const list = screen.getByRole('list', { name: /Crash findings/ });
    const items = within(list).getAllByRole('listitem');
    expect(within(items[0]!).getByTestId('origin').textContent).toBe('from crash-2026-11-03_14.22.07-client.txt');
    // The top error is open already.
    const toggle = within(items[0]!).getAllByRole('button').find((b) => b.hasAttribute('aria-expanded'))!;
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    const log = within(items[0]!).getByRole('region', { name: `Excerpt of ${NEWEST_CRASH}` });
    const culprit = log.querySelector('.bg-hl-line');
    expect(culprit?.textContent).toMatch(/emberforge\.mixins\.json/);
    // Clicking the row selects the crash finding for the inspector.
    fireEvent.click(toggle);
    const sel = m.store.getState().selection;
    expect(sel).toMatchObject({ kind: 'crash', sourceId: NEWEST_CRASH });
    const inspector = screen.getByRole('complementary', { name: 'Inspector' });
    expect(inspector.querySelector('dl[aria-label="Log source"]')).toBeTruthy();
    expect(inspector.querySelector('dl[aria-label="Log source"]')!.textContent).toContain(NEWEST_CRASH);
  });

  it('a culprit chip selects the jar; the jar inspector lists the crash findings citing it', async () => {
    const m = await renderApp();
    fireEvent.click(screen.getByRole('tab', { name: /Crashes/ }));
    const list = screen.getByRole('list', { name: /Crash findings/ });
    fireEvent.click(within(list).getAllByRole('button', { name: 'emberforge-1.20.1-2.4.0.jar' })[0]!);
    expect(m.store.getState().selection).toEqual({ kind: 'jar', id: EMBERFORGE });
    expect(m.store.getState().revealJarId).toBe(EMBERFORGE);
    const inspector = screen.getByRole('complementary', { name: 'Inspector' });
    const citing = within(inspector).getByRole('region', { name: 'Crash findings for this jar' });
    fireEvent.click(within(citing).getByRole('button', { name: /C-MIXIN/ }));
    expect(m.store.getState().selection).toMatchObject({ kind: 'crash', sourceId: NEWEST_CRASH });
  });

  it('Log shows the whole digest; long logs are virtualised', async () => {
    const m = await renderApp();
    fireEvent.click(screen.getByRole('tab', { name: /Crashes/ }));
    await act(async () => {
      m.store.getState().selectLogSource(ATM.id, 'logs/latest.log');
      await until(() => m.store.getState().crashes[ATM.id]?.analyses['logs/latest.log']?.status === 'done');
    });
    fireEvent.click(screen.getByRole('radio', { name: 'Log' }));
    const region = screen.getByRole('region', { name: 'Log logs/latest.log' });
    const rendered = region.querySelectorAll('[data-line]').length;
    expect(rendered).toBeGreaterThan(0);
    expect(rendered).toBeLessThan(200);
  });

  it('Diagnosis / Log is a radio group: one tab stop, arrows, Home and End move and select', async () => {
    const m = await renderApp();
    fireEvent.click(screen.getByRole('tab', { name: /Crashes/ }));
    const group = screen.getByRole('radiogroup', { name: 'Show' });
    const [diagnosis, log] = within(group).getAllByRole('radio') as [HTMLElement, HTMLElement];
    expect(diagnosis.getAttribute('aria-checked')).toBe('true');
    expect([diagnosis.tabIndex, log.tabIndex]).toEqual([0, -1]);
    diagnosis.focus();
    fireEvent.keyDown(diagnosis, { key: 'ArrowRight' });
    expect(m.store.getState().crashes[ATM.id]!.pane).toBe('log');
    const g2 = screen.getByRole('radiogroup', { name: 'Show' });
    const [d2, l2] = within(g2).getAllByRole('radio') as [HTMLElement, HTMLElement];
    expect(l2.getAttribute('aria-checked')).toBe('true');
    expect([d2.tabIndex, l2.tabIndex]).toEqual([-1, 0]);
    expect(document.activeElement).toBe(l2);
    fireEvent.keyDown(l2, { key: 'ArrowRight' }); // wraps
    expect(m.store.getState().crashes[ATM.id]!.pane).toBe('diagnosis');
    fireEvent.keyDown(screen.getByRole('radio', { name: 'Diagnosis' }), { key: 'End' });
    expect(m.store.getState().crashes[ATM.id]!.pane).toBe('log');
    fireEvent.keyDown(screen.getByRole('radio', { name: 'Log' }), { key: 'Home' });
    expect(m.store.getState().crashes[ATM.id]!.pane).toBe('diagnosis');
    fireEvent.keyDown(screen.getByRole('radio', { name: 'Diagnosis' }), { key: 'ArrowUp' });
    expect(m.store.getState().crashes[ATM.id]!.pane).toBe('log');
  });

  it('the FINDINGS / CRASHES tabs: Left/Right wrap, Home/End jump, only the active tab is a tab stop', async () => {
    const m = await renderApp();
    const findings = screen.getByRole('tab', { name: /Findings/ });
    findings.focus();
    fireEvent.keyDown(findings, { key: 'End' });
    expect(m.store.getState().findingsTab[ATM.id]).toBe('crashes');
    const crashes = screen.getByRole('tab', { name: /Crashes/ });
    expect(document.activeElement).toBe(crashes);
    expect([screen.getByRole('tab', { name: /Findings/ }).tabIndex, crashes.tabIndex]).toEqual([-1, 0]);
    fireEvent.keyDown(crashes, { key: 'Home' });
    expect(m.store.getState().findingsTab[ATM.id]).toBe('findings');
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: /Findings/ }));
    fireEvent.keyDown(screen.getByRole('tab', { name: /Findings/ }), { key: 'ArrowLeft' });
    expect(m.store.getState().findingsTab[ATM.id]).toBe('crashes');
    // Up/Down are not tab keys in a horizontal tab list.
    fireEvent.keyDown(screen.getByRole('tab', { name: /Crashes/ }), { key: 'ArrowDown' });
    expect(m.store.getState().findingsTab[ATM.id]).toBe('crashes');
  });

  it('the tile order switch follows the same radio pattern', async () => {
    const m = await renderApp();
    const group = screen.getByRole('radiogroup', { name: 'Tile order' });
    const name = within(group).getByRole('radio', { name: 'Name' });
    expect([name.tabIndex, within(group).getByRole('radio', { name: 'Severity' }).tabIndex]).toEqual([0, -1]);
    fireEvent.keyDown(name, { key: 'ArrowRight' });
    expect(m.store.getState().settings.gridSort).toBe('severity');
    expect(document.activeElement).toBe(within(group).getByRole('radio', { name: 'Severity' }));
    fireEvent.keyDown(within(group).getByRole('radio', { name: 'Severity' }), { key: 'Home' });
    expect(m.store.getState().settings.gridSort).toBe('name');
  });

  it('a .mrpack has no watch toggle, and its crashes tab says why it has no logs', async () => {
    const m = await renderApp();
    expect(screen.getByRole('button', { name: /^Watch for crashes/ })).toBeTruthy();
    await act(async () => {
      m.store.getState().selectInstance(MRPACK.id);
      await until(() => m.store.getState().crashes[MRPACK.id]?.sourcesStatus === 'done');
    });
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(MRPACK.name);
    expect(screen.queryByRole('button', { name: /^Watch for crashes/ })).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: /Crashes/ }));
    const panel = screen.getByRole('tabpanel');
    expect(within(panel).queryByRole('alert')).toBeNull();
    expect(within(panel).getByRole('status').textContent).toMatch(/\.mrpack file .* has no crash reports or logs/);
  });

  it('a listing error renders as an error row with Retry', async () => {
    const m = mockStore({ scenario: 'errors' });
    render(<App store={m.store} />);
    await act(async () => {
      await m.store.getState().init();
      await until(() => m.store.getState().crashes[ATM.id]?.sourcesStatus === 'error');
    });
    fireEvent.click(screen.getByRole('tab', { name: /Crashes/ }));
    const panel = screen.getByRole('tabpanel');
    const alert = within(panel).getByRole('alert');
    expect(within(alert).getByText('permission')).toBeTruthy();
    const list = vi.spyOn(m.backend.commands, 'listLogSources');
    await act(async () => {
      fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }));
    });
    expect(list).toHaveBeenCalledWith(ATM.id);
  });
});

describe('watch mode in the shell', () => {
  it('the header toggle arms watching; the rail says so', async () => {
    const m = await renderApp();
    const toggle = screen.getByRole('button', { name: 'Watch for crashes disabled' });
    expect(toggle.textContent).toMatch(/Watch for crashes/);
    await act(async () => {
      fireEvent.click(toggle);
      await until(() => m.backend.settings().watched.includes(ATM.id));
    });
    expect(screen.getByRole('button', { name: 'Watch for crashes enabled' })).toBeTruthy();
    const rail = screen.getByRole('navigation', { name: 'Instance list' });
    expect(within(rail).getByRole('button', { name: new RegExp(`^${ATM.name}`) }).textContent).toMatch(/watching/);
  });

  it('a crash in another instance: rail crash mark, banner when not notified, Show opens the crash', async () => {
    const m = await renderApp();
    await act(async () => {
      m.backend.crash(FO.id, 1);
      await until(() => m.store.getState().crashBanner !== null);
    });
    const rail = screen.getByRole('navigation', { name: 'Instance list' });
    const foRow = within(rail).getByRole('button', { name: new RegExp(`^${FO.name}`) });
    expect(within(foRow).getByTestId('rail-crash').textContent).toBe('crash');
    const banner = screen.getByRole('alert', { name: 'Modpack crashed' });
    expect(banner.textContent).toMatch(/Modpack crashed — likely cause: /);
    await act(async () => {
      fireEvent.click(within(banner).getByRole('button', { name: 'Show crash' }));
      await until(() => m.store.getState().crashes[FO.id]?.sourcesStatus === 'done');
    });
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(FO.name);
    expect(screen.getByRole('tab', { name: /Crashes/ }).getAttribute('aria-selected')).toBe('true');
    expect(screen.queryByRole('alert', { name: 'Modpack crashed' })).toBeNull();
    expect(within(rail).queryByTestId('rail-crash')).toBeNull();
  });
});

describe('crash in the open instance', () => {
  it('shows the crash right away: no rail crash mark and no tab pip (nothing unseen)', async () => {
    const m = await renderApp();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(ATM.name);
    let source = '';
    await act(async () => {
      source = m.backend.crash(ATM.id, 1)!.source.id;
      // No notifier in tests: the banner is the notification.
      await until(() => m.store.getState().crashBanner !== null);
    });
    const rail = screen.getByRole('navigation', { name: 'Instance list' });
    expect(within(rail).queryByTestId('rail-crash')).toBeNull();
    const tab = screen.getByRole('tab', { name: /Crashes/ });
    expect(tab.getAttribute('aria-selected')).toBe('true');
    expect(within(tab).queryByRole('img', { name: 'new crash' })).toBeNull();
    const list = screen.getByRole('list', { name: 'Crash reports and logs' });
    expect(within(list).getAllByRole('button').find((r) => r.getAttribute('aria-current') === 'true')!.getAttribute('title')).toBe(source);
    // The banner (notification stand-in) still names the instance.
    expect(screen.getByRole('alert', { name: 'Modpack crashed' }).textContent).toContain(ATM.name);
  });

  it('a crash elsewhere marks the rail and the tab pip until that instance is opened', async () => {
    const m = await renderApp();
    await act(async () => {
      m.backend.crash(FO.id, 1);
      await until(() => !!m.store.getState().crashAlerts[FO.id]);
    });
    const rail = screen.getByRole('navigation', { name: 'Instance list' });
    expect(within(rail).getByRole('button', { name: new RegExp(`^${FO.name}`) }).querySelector('[data-testid="rail-crash"]')).toBeTruthy();
    await act(async () => {
      fireEvent.click(within(rail).getByRole('button', { name: new RegExp(`^${FO.name}`) }));
      await until(() => m.store.getState().crashes[FO.id]?.sourcesStatus === 'done');
    });
    expect(within(rail).queryByTestId('rail-crash')).toBeNull();
    expect(within(screen.getByRole('tab', { name: /Crashes/ })).queryByRole('img', { name: 'new crash' })).toBeNull();
  });
});

describe('LogViewer scroll requests', () => {
  const lines = (n: number): LogLine[] => Array.from({ length: n }, (_, i) => ({ n: i + 1, text: `line ${i + 1}`, role: 'context' }));
  let scrolled: Element[] = [];
  const original = HTMLElement.prototype.scrollIntoView;
  beforeEach(() => {
    scrolled = [];
    HTMLElement.prototype.scrollIntoView = function (this: Element) {
      scrolled.push(this);
    };
  });
  afterEach(() => {
    HTMLElement.prototype.scrollIntoView = original;
    vi.restoreAllMocks();
  });

  it('scrolls once per request; new lines (a re-analysis) never pull the view back', () => {
    const { rerender } = render(<LogViewer lines={lines(50)} scrollToLine={40} scrollRequest={1} />);
    expect(scrolled.map((e) => e.getAttribute('data-line'))).toEqual(['40']);
    // Same request, new rows identity (scan finished, digest re-analysed).
    rerender(<LogViewer lines={lines(50)} scrollToLine={40} scrollRequest={1} />);
    rerender(<LogViewer lines={lines(50)} scrollToLine={40} scrollRequest={1} totalLines={60} />);
    expect(scrolled).toHaveLength(1);
    // "Show in log" again for the same line scrolls again.
    rerender(<LogViewer lines={lines(50)} scrollToLine={40} scrollRequest={2} />);
    expect(scrolled.map((e) => e.getAttribute('data-line'))).toEqual(['40', '40']);
    rerender(<LogViewer lines={lines(50)} scrollToLine={12} scrollRequest={3} />);
    expect(scrolled.map((e) => e.getAttribute('data-line'))).toEqual(['40', '40', '12']);
    rerender(<LogViewer lines={lines(50)} scrollToLine={null} scrollRequest={3} />);
    rerender(<LogViewer lines={lines(50)} scrollToLine={null} scrollRequest={3} />);
    expect(scrolled).toHaveLength(3);
  });

  it('virtualised (long logs): new rows keep the scroll position; a new request scrolls', async () => {
    const tick = () => act(async () => void (await new Promise((r) => setTimeout(r, 50))));
    // happy-dom has no layout: give the scroller a real height so offsets are not clamped to 0.
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(6000 * 18);
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(300);
    const { rerender } = render(<LogViewer lines={lines(6000)} maxHeight={300} scrollToLine={3000} scrollRequest={1} />);
    await tick();
    const region = screen.getByRole('region');
    expect(region.scrollTop).toBeGreaterThan(0);
    // The user scrolls back to the top; then the digest is re-analysed (new rows).
    region.scrollTop = 0;
    rerender(<LogViewer lines={lines(6000)} maxHeight={300} scrollToLine={3000} scrollRequest={1} />);
    await tick();
    expect(region.scrollTop).toBe(0);
    rerender(<LogViewer lines={lines(6000)} maxHeight={300} scrollToLine={3000} scrollRequest={2} />);
    await tick();
    expect(region.scrollTop).toBeGreaterThan(0);
  });

  it('a request for a line not rendered yet waits for it, then is not repeated', () => {
    const { rerender } = render(<LogViewer lines={lines(10)} scrollToLine={30} scrollRequest={1} />);
    expect(scrolled).toHaveLength(0);
    rerender(<LogViewer lines={lines(50)} scrollToLine={30} scrollRequest={1} />);
    expect(scrolled.map((e) => e.getAttribute('data-line'))).toEqual(['30']);
    rerender(<LogViewer lines={lines(50)} scrollToLine={30} scrollRequest={1} />);
    expect(scrolled).toHaveLength(1);
  });

  it('the crash view keeps a long log where the user scrolled when a rescan re-analyses it', async () => {
    const tick = () => act(async () => void (await new Promise((r) => setTimeout(r, 50))));
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(100_000);
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(300);
    const m = await renderApp();
    const LATEST = 'logs/latest.log';
    fireEvent.click(screen.getByRole('tab', { name: /Crashes/ }));
    await act(async () => {
      m.store.getState().selectLogSource(ATM.id, LATEST);
      await until(() => m.store.getState().crashes[ATM.id]?.analyses[LATEST]?.status === 'done');
    });
    const total = m.store.getState().crashes[ATM.id]!.analyses[LATEST]!.digest!.totalLines;
    await act(async () => m.store.getState().setCrashPane(ATM.id, 'log', total));
    await tick();
    const region = screen.getByRole('region', { name: `Log ${LATEST}` });
    expect(region.querySelectorAll('[data-line]').length).toBeLessThan(200); // virtualised
    expect(region.scrollTop).toBeGreaterThan(0);
    region.scrollTop = 0;
    // A rescan re-analyses the digest (new rows): the view stays where the user scrolled.
    await act(async () => {
      await m.store.getState().scan(ATM.id);
    });
    await tick();
    expect(region.scrollTop).toBe(0);
    expect(m.store.getState().crashes[ATM.id]!.logLine).toBe(total);
  });
});

describe('LogViewer virtualisation', () => {
  const lines = (n: number): LogLine[] => Array.from({ length: n }, (_, i) => ({ n: i + 1, text: `line ${i + 1}`, role: i === n - 2 ? 'culprit' : 'context' }));

  it('renders every row of a short excerpt', () => {
    render(<LogViewer lines={lines(50)} />);
    expect(document.querySelectorAll('[data-line]').length).toBe(50);
  });

  it(`renders only a window past ${VIRTUAL_ROWS} rows, sized for every row`, () => {
    render(<LogViewer lines={lines(6000)} maxHeight={300} />);
    const n = document.querySelectorAll('[data-line]').length;
    expect(n).toBeGreaterThan(0);
    expect(n).toBeLessThan(120);
    const inner = screen.getByRole('region').firstElementChild as HTMLElement;
    expect(inner.style.height).toBe(`${6000 * 18}px`);
  });
});
