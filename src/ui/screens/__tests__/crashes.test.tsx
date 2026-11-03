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
