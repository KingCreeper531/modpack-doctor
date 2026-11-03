// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { App } from '../../app/App';
import { finding, mockStore, until } from '../../app/__tests__/helpers';
import { MOCK_INSTANCES } from '../../app/mockData';

afterEach(cleanup);

const UNAVAILABLE_FIX = "Applying fixes isn't available in this version of Modpack Doctor yet.";

/** happy-dom's viewport; the shell docks the inspector only when the window is wide enough. */
function setViewport(width: number) {
  (window as unknown as { happyDOM: { setViewport(v: { width: number; height: number }): void } }).happyDOM.setViewport({ width, height: 900 });
  window.dispatchEvent(new Event('resize'));
}

beforeEach(() => setViewport(1600));

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
    // Rendered once (beside the triage button, not again in the inspector), neutrally.
    const msg = screen.getAllByText(UNAVAILABLE_FIX);
    expect(msg).toHaveLength(1);
    const row = msg[0]!.closest('[data-kind]')!;
    expect(row.getAttribute('role')).toBe('status');
    expect(row.textContent).not.toContain('internal');
    expect(row.querySelector('.bg-err')).toBeNull();
    expect(within(inspector).queryByText(UNAVAILABLE_FIX)).toBeNull();
    // No promise about work orders while fixes can't run.
    expect(screen.queryByText(/opens a work order/)).toBeNull();

    // The inspector's own button shows the error in the inspector, and only there.
    await act(async () => {
      fireEvent.click(within(inspector).getByRole('button', { name: /^Disable jei/ }));
      await until(() => m.store.getState().fixErrorFrom.dup === 'inspector');
    });
    expect(screen.getAllByText(UNAVAILABLE_FIX)).toHaveLength(1);
    expect(within(inspector).getByText(UNAVAILABLE_FIX)).toBeTruthy();
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

describe('narrow windows', () => {
  it('at 960px the inspector is a drawer: closed by default, opened by a selection or the toggle, closed by Esc', async () => {
    setViewport(960);
    const m = await renderApp();
    await scanned(m);
    expect(screen.queryByRole('complementary', { name: 'Inspector' })).toBeNull();
    expect(screen.queryByRole('separator', { name: 'Resize inspector' })).toBeNull();
    const toggle = screen.getByRole('button', { name: 'Inspector' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(toggle);
    const drawer = screen.getByRole('complementary', { name: 'Inspector' });
    expect(drawer.className).toContain('absolute');
    expect(drawer.className).toContain('shadow-overlay');
    fireEvent.keyDown(drawer, { key: 'Escape' });
    expect(screen.queryByRole('complementary', { name: 'Inspector' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /E-DUP-ID/ }));
    expect(screen.getByRole('complementary', { name: 'Inspector' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Close inspector' }));
    expect(screen.queryByRole('complementary', { name: 'Inspector' })).toBeNull();
  });

  it('wide windows dock the inspector beside a resizer and show no drawer toggle', async () => {
    setViewport(1920);
    await renderApp();
    expect(screen.getByRole('complementary', { name: 'Inspector' }).className).not.toContain('absolute');
    expect(screen.getByRole('separator', { name: 'Resize inspector' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Inspector' })).toBeNull();
  });
});

describe('no backend (production build outside Tauri)', () => {
  it('renders one clear error row and no mock data', async () => {
    const { missingBackend, NO_BACKEND } = await import('../../app/ipc');
    const { createAppStore } = await import('../../app/store');
    const store = createAppStore({ backend: missingBackend() });
    render(<App store={store} />);
    await act(async () => {
      await store.getState().init();
    });
    expect(screen.getByRole('alert').textContent).toContain(NO_BACKEND.message);
    expect(screen.queryByText(/All the Mods/)).toBeNull();
    expect(screen.queryByRole('navigation', { name: 'Instance list' })).toBeNull();
  });
});

describe('override editor', () => {
  it('shows the detected identity as placeholders, even while an override is active', async () => {
    const m = await renderApp();
    await scanned(m);
    await act(async () => {
      await m.store.getState().setOverride(ATM.id, { mcVersion: '1.21.1', loader: null, side: null });
    });
    const form = screen.getByRole('form', { name: 'Pack identity override' });
    const mc = within(form).getByLabelText('Minecraft') as HTMLInputElement;
    expect(mc.value).toBe('1.21.1');
    expect(mc.placeholder).toBe('1.20.1');
    expect(within(form).getByRole('option', { name: 'detected: Forge' })).toBeTruthy();
    fireEvent.change(within(form).getByLabelText('Loader'), { target: { value: 'forge' } });
    expect((within(form).getByLabelText('Loader ver.') as HTMLInputElement).placeholder).toBe('47.3.0');
    fireEvent.change(within(form).getByLabelText('Loader'), { target: { value: 'fabric' } });
    expect((within(form).getByLabelText('Loader ver.') as HTMLInputElement).placeholder).toBe('version');
  });

  it('refuses an unrecognised MC version or a bad loader version with inline hints', async () => {
    const m = await renderApp();
    await scanned(m);
    const spy = vi.spyOn(m.backend.commands, 'setSettings');
    const form = screen.getByRole('form', { name: 'Pack identity override' });
    fireEvent.change(within(form).getByLabelText('Minecraft'), { target: { value: '1.20.1 forge' } });
    expect(within(form).getByText(/Not a Minecraft version this app recognises/)).toBeTruthy();
    expect(within(form).getByLabelText('Minecraft').getAttribute('aria-invalid')).toBe('true');
    fireEvent.change(within(form).getByLabelText('Loader'), { target: { value: 'forge' } });
    fireEvent.change(within(form).getByLabelText('Loader ver.'), { target: { value: '47 3' } });
    expect(within(form).getByText('A loader version has no spaces.')).toBeTruthy();
    await act(async () => {
      fireEvent.submit(form);
    });
    expect(spy).not.toHaveBeenCalled();
    expect((within(form).getByRole('button', { name: 'Apply and recheck' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(within(form).getByLabelText('Minecraft'), { target: { value: '1.20.4' } });
    fireEvent.change(within(form).getByLabelText('Loader ver.'), { target: { value: '49.0.3' } });
    await act(async () => {
      fireEvent.submit(form);
      // `setSettings` is called first and applies the patch only after its (mock) round trip;
      // wait for the store to hold the answer, not just for the call (this raced before).
      await until(() => spy.mock.calls.length === 1 && m.store.getState().settings.overrides[ATM.id] !== undefined);
    });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(m.backend.settings().overrides[ATM.id]).toEqual({ mcVersion: '1.20.4', loader: { kind: 'forge', version: '49.0.3' }, side: null });
  });
});
