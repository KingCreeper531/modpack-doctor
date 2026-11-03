// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { App } from '../../app/App';
import { finding, mockStore, until } from '../../app/__tests__/helpers';
import { MOCK_INSTANCES } from '../../app/mockData';

afterEach(cleanup);

const ATM = MOCK_INSTANCES[0]!;
const JEI_A = 'mods/jei-1.20.1-forge-15.2.0.27.jar';
const JEI_B = 'mods/jei-1.20.1-forge-15.3.0.4.jar';
const CORRUPT = 'mods/betterfoliage-1.20.1-5.0.2.jar';

const findings = () => [
  finding('dup', 'error', [JEI_A, JEI_B], { title: 'Two jars declare mod id jei', explanation: 'Forge refuses two mods with one id.' }),
  finding('corrupt', 'warning', [CORRUPT], { title: 'betterfoliage is not a readable jar' }),
];

async function renderApp(opts: Parameters<typeof mockStore>[0] = {}, make = findings) {
  const m = mockStore(opts, make);
  render(<App store={m.store} />);
  await act(async () => {
    await m.store.getState().init();
  });
  return m;
}

async function scanned(m: Awaited<ReturnType<typeof renderApp>>, id = ATM.id) {
  await act(async () => {
    await until(() => m.store.getState().scans[id]?.status === 'done');
  });
}

describe('shell', () => {
  it('lists every instance in the rail and switches the workspace on click', async () => {
    const m = await renderApp();
    const rail = screen.getByRole('navigation', { name: 'Instance list' });
    expect(within(rail).getAllByRole('button')).toHaveLength(MOCK_INSTANCES.length);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(ATM.name);
    const fo = MOCK_INSTANCES[1]!;
    fireEvent.click(within(rail).getByRole('button', { name: new RegExp(`^${fo.name}`) }));
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(fo.name);
    expect(within(rail).getByRole('button', { name: new RegExp(`^${fo.name}`) }).getAttribute('aria-current')).toBe('true');
    await scanned(m, fo.id);
  });

  it('summary strip: live scanning n/total, then the final line with counts', async () => {
    const frozen = await renderApp({ scenario: 'scanning', scanMs: 0 });
    await act(async () => {
      await until(() => (frozen.store.getState().scans[ATM.id]?.total ?? 0) > 0);
      frozen.frames.run();
    });
    expect(screen.getByText(/^scanning 281\/512$/)).toBeTruthy();
    expect(screen.getByText('Checks run when the scan finishes.')).toBeTruthy();
    cleanup();

    const m = await renderApp();
    await scanned(m);
    expect(screen.getByText('1 error')).toBeTruthy();
    expect(screen.getByText('1 warning')).toBeTruthy();
    expect(screen.getByText('512 mods')).toBeTruthy();
    expect(screen.getByText(/^scanned /)).toBeTruthy();
    expect(screen.getByText('1 E · 1 W · 0 I')).toBeTruthy();
  });

  it('shows the Modrinth-off notice when Modrinth is disabled', async () => {
    await renderApp({ scenario: 'offline' });
    expect(screen.getByText('Modrinth off — static checks only')).toBeTruthy();
  });

  it('triage: a click expands the row, shows it in the inspector, and a fix renders its refusal inline', async () => {
    const m = await renderApp();
    await scanned(m);
    const toggle = screen.getByRole('button', { name: /E-DUP-ID/ });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    const inspector = screen.getByRole('complementary', { name: 'Inspector' });
    expect(within(inspector).getByRole('heading', { name: 'Two jars declare mod id jei' })).toBeTruthy();

    const fix = within(screen.getByRole('list', { name: /Findings/ })).getByRole('button', { name: /^Disable jei/ });
    await act(async () => {
      fireEvent.click(fix);
      await until(() => !!m.store.getState().fixErrors.dup);
    });
    expect(screen.getAllByText('plan_work_order is not implemented yet (M6)').length).toBeGreaterThan(0);
    expect(screen.getAllByRole('alert').length).toBeGreaterThan(0);
  });

  it('a culprit chip selects the jar and the inspector shows its facts', async () => {
    const m = await renderApp();
    await scanned(m);
    fireEvent.click(screen.getAllByRole('button', { name: 'betterfoliage-1.20.1-5.0.2.jar' })[0]!);
    expect(m.store.getState().selection).toEqual({ kind: 'jar', id: CORRUPT });
    expect(m.store.getState().revealJarId).toBe(CORRUPT);
    const inspector = screen.getByRole('complementary', { name: 'Inspector' });
    expect(within(inspector).getByText(/corrupt: Not a valid zip archive/)).toBeTruthy();
    expect(within(inspector).getByText(CORRUPT)).toBeTruthy();
  });

  it('inspector override editor stores the override and re-runs the checks', async () => {
    const m = await renderApp();
    await scanned(m);
    expect(m.calls).toHaveLength(1);
    const form = screen.getByRole('form', { name: 'Pack identity override' });
    fireEvent.change(within(form).getByLabelText('Minecraft'), { target: { value: '1.20.4' } });
    fireEvent.change(within(form).getByLabelText('Loader'), { target: { value: 'neoforge' } });
    fireEvent.change(within(form).getByLabelText('Loader ver.'), { target: { value: '20.4.80' } });
    await act(async () => {
      fireEvent.click(within(form).getByRole('button', { name: 'Apply and recheck' }));
      await until(() => m.calls.length === 2);
    });
    expect(m.backend.settings().overrides[ATM.id]).toEqual({ mcVersion: '1.20.4', loader: { kind: 'neoforge', version: '20.4.80' }, side: null });
    expect(m.calls[1]!.pack).toMatchObject({ mcVersion: '1.20.4', source: 'override' });
    expect(screen.getByText('from your override')).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Clear override' }));
      await until(() => m.calls.length === 3);
    });
    expect(m.backend.settings().overrides[ATM.id]).toBeUndefined();
  });

  it('a failed scan renders an error row with Retry, not a toast', async () => {
    const m = await renderApp({ scenario: 'errors' });
    await act(async () => {
      await until(() => m.store.getState().scans[ATM.id]?.status === 'error');
    });
    const alert = screen.getByRole('alert');
    expect(within(alert).getByText('permission')).toBeTruthy();
    expect(screen.getByText('scan failed')).toBeTruthy();
    const scan = vi.spyOn(m.backend.commands, 'scanInstance');
    await act(async () => {
      fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }));
      await until(() => scan.mock.calls.length === 1);
    });
    expect(scan).toHaveBeenCalledWith(ATM.id);
    expect(document.querySelector('[role="status"][aria-live="assertive"], .toast')).toBeNull();
  });

  it('theme control writes the preference and the resolved data-theme', async () => {
    const m = await renderApp({ theme: 'dark' });
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    await act(async () => {
      fireEvent.click(screen.getByRole('radio', { name: 'Light' }));
    });
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    await act(async () => {
      await until(() => m.backend.settings().theme === 'light');
    });
  });
});

describe('empty state', () => {
  it('shows every probed location, its result, and Add folder', async () => {
    const m = await renderApp({ scenario: 'empty' });
    const table = screen.getByRole('table', { name: 'Launcher locations checked' });
    expect(within(table).getByText('permission denied')).toBeTruthy();
    expect(within(table).getAllByText('not installed')).toHaveLength(2);
    expect(screen.getByText('No instances found yet.')).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getAllByRole('button', { name: 'Add folder' })[0]!);
      await until(() => (m.store.getState().discovery?.instances.length ?? 0) === 1);
    });
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('my-test-pack');
  });
});
