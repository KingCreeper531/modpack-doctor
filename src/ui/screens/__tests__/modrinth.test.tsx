// @vitest-environment happy-dom
/** Modrinth in the UI (M5): mod table column and icons, summary notice, inspector, settings. */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CheckInput, Finding } from '../../../core/model';
import { App } from '../../app/App';
import { finding, mockStore, until } from '../../app/__tests__/helpers';
import { MOCK_INSTANCES } from '../../app/mockData';
import { createMockBackend } from '../../app/mockIpc';
import { createAppStore } from '../../app/store';
import { ModTable, type ModRow } from '../../components/ModTable';

afterEach(cleanup);

/**
 * happy-dom lays nothing out, so the virtualised table would render no rows: give every element
 * a 1200×800 box while these tests run.
 */
function withLayout() {
  let restore: (() => void) | null = null;
  beforeEach(() => {
    const rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ x: 0, y: 0, top: 0, left: 0, right: 1200, bottom: 800, width: 1200, height: 800, toJSON: () => ({}) } as DOMRect);
    const oh = vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(800);
    const ow = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1200);
    restore = () => {
      rect.mockRestore();
      oh.mockRestore();
      ow.mockRestore();
    };
  });
  afterEach(() => restore?.());
}

function setViewport(width: number) {
  (window as unknown as { happyDOM: { setViewport(v: { width: number; height: number }): void } }).happyDOM.setViewport({ width, height: 900 });
  window.dispatchEvent(new Event('resize'));
}
beforeEach(() => setViewport(1600));

const ATM = MOCK_INSTANCES[0]!;
const AD_ASTRA = 'mods/ad_astra-forge-1.20.1-1.15.18.jar';
const CREATE = 'mods/create-1.20.1-0.5.1.f.jar';
const OPTIFINE = 'mods/OptiFine_1.20.1_HD_U_I6.jar';

const checks = (input: CheckInput): Finding[] => [
  finding('missing', 'error', [AD_ASTRA], { code: 'E-MISSING-DEP', missingModIds: ['botarium'], fixes: [], title: 'Ad Astra needs botarium' }),
  ...(input.modrinth ? [finding('notmr', 'info', [OPTIFINE], { code: 'I-NOT-ON-MODRINTH', fixes: [], title: '1 jar is not on Modrinth' })] : []),
];

async function renderApp(opts: Parameters<typeof mockStore>[0] = {}, extra: Parameters<typeof mockStore>[3] = {}) {
  const m = mockStore(opts, checks, undefined, extra);
  render(<App store={m.store} />);
  await act(async () => {
    await m.store.getState().init();
  });
  return m;
}

const enriched = async (m: ReturnType<typeof mockStore>) =>
  act(async () => {
    await until(() => !!m.store.getState().modrinth[ATM.id]?.resolutions.botarium, 4000);
  });

const row = (r: Partial<ModRow> & { id: string }): ModRow => ({
  name: r.id,
  modId: null,
  version: '1.0',
  loader: 'fabric',
  modrinth: { state: 'matched' },
  findings: { error: 0, warning: 0, info: 0 },
  enabled: true,
  ...r,
});

describe('ModTable Modrinth column', () => {
  withLayout();
  const rows = [
    row({ id: 'a', name: 'Alpha', modrinth: { state: 'offline' } }),
    row({ id: 'b', name: 'Bravo', modrinth: { state: 'missing' } }),
    row({ id: 'c', name: 'Charlie', modrinth: { state: 'update', version: '0.6.0-beta.2', beta: true }, iconUrl: 'data:image/svg+xml,%3Csvg%2F%3E' }),
    row({ id: 'd', name: 'Delta', modrinth: { state: 'matched' } }),
    row({ id: 'e', name: 'Echo', modrinth: { state: 'update', version: '0.5.11' } }),
  ];

  it('renders every state per DESIGN §6.6, with a beta label on beta updates', () => {
    render(<ModTable rows={rows} sort={null} onSort={() => undefined} />);
    const cells = (name: string) => screen.getByRole('row', { name });
    expect(within(cells('Alpha')).getByTitle('Modrinth status unknown').className).toContain('text-fg-faint');
    expect(within(cells('Bravo')).getByText('not on Modrinth').className).toContain('text-fg-faint');
    expect(within(cells('Delta')).getByText('matched').className).toContain('text-ok');
    const beta = within(cells('Charlie'));
    expect(beta.getByText('0.6.0-beta.2')).toBeTruthy();
    expect(beta.getByText('beta')).toBeTruthy();
    expect(beta.getByText('update').parentElement!.className).toContain('text-signal');
    expect(within(cells('Echo')).queryByText('beta')).toBeNull();
  });

  it('shows the icon when there is one, else (or when it fails to load) the loader glyph', () => {
    render(<ModTable rows={rows} sort={null} onSort={() => undefined} />);
    const icon = within(screen.getByRole('row', { name: 'Charlie' })).getByTestId('mod-icon');
    expect(icon.getAttribute('src')).toMatch(/^data:image\/svg\+xml,/);
    expect(within(screen.getByRole('row', { name: 'Delta' })).queryByTestId('mod-icon')).toBeNull();
    fireEvent.error(icon);
    expect(within(screen.getByRole('row', { name: 'Charlie' })).queryByTestId('mod-icon')).toBeNull();
  });

  it('sorts by the Modrinth column: updates, matched, not on Modrinth, unknown', () => {
    const onSort = vi.fn();
    const { rerender } = render(<ModTable rows={rows} sort={null} onSort={onSort} />);
    fireEvent.click(screen.getByRole('columnheader', { name: /Modrinth/ }).querySelector('button') ?? screen.getByRole('columnheader', { name: /Modrinth/ }));
    expect(onSort).toHaveBeenCalledWith({ key: 'modrinth', dir: 'asc' });
    rerender(<ModTable rows={rows} sort={{ key: 'modrinth', dir: 'asc' }} onSort={onSort} />);
    const names = screen.getAllByRole('row').slice(1).map((r) => r.getAttribute('aria-label'));
    expect(names).toEqual(['Charlie', 'Echo', 'Delta', 'Bravo', 'Alpha']);
  });
});

describe('Modrinth in the app', () => {
  withLayout();
  it('fills the Modrinth column, labels fixes, and shows no notice when all went well', async () => {
    const m = await renderApp();
    await enriched(m);
    act(() => m.store.getState().setModSort(ATM.id, { key: 'modrinth', dir: 'asc' }));
    const table = screen.getByRole('grid', { name: 'Mods' });
    expect(within(table).getAllByText('update').length).toBeGreaterThan(0);
    expect(screen.queryByText(/Modrinth unreachable/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Refresh Modrinth' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /E-MISSING-DEP/ }));
    expect(screen.getAllByRole('button', { name: 'Install Botarium 2.3.4' }).length).toBeGreaterThan(0);
    // I-NOT-ON-MODRINTH fires once the context exists, and renders like any finding.
    expect(screen.getByRole('button', { name: /I-NOT-ON-MODRINTH/ })).toBeTruthy();
  });

  it('inspector: project, link (opened outside), version, update and sides; not-on-Modrinth wording', async () => {
    const m = await renderApp();
    await enriched(m);
    act(() => m.store.getState().select({ kind: 'jar', id: CREATE }));
    const inspector = screen.getByRole('complementary', { name: 'Inspector' });
    const plate = within(inspector);
    expect(plate.getAllByText('Create').length).toBeGreaterThan(0);
    expect(plate.getByText('0.5.1.j')).toBeTruthy();
    expect(plate.getByText('client and server')).toBeTruthy();
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    fireEvent.click(plate.getByRole('button', { name: /modrinth\.com\/mod\/create/ }));
    expect(open).toHaveBeenCalledWith('https://modrinth.com/mod/create', '_blank', 'noopener,noreferrer');
    act(() => m.store.getState().select({ kind: 'jar', id: OPTIFINE }));
    expect(within(screen.getByRole('complementary', { name: 'Inspector' })).getByText('Not on Modrinth (possibly CurseForge or manual)')).toBeTruthy();
  });

  it('a beta update reads "beta" in the inspector', async () => {
    const m = await renderApp();
    await enriched(m);
    const fo = MOCK_INSTANCES[1]!;
    act(() => m.store.getState().selectInstance(fo.id));
    await act(async () => {
      await until(() => m.store.getState().modrinth[fo.id]?.status === 'done');
    });
    const ec = m.store.getState().scans[fo.id]!.result!.jars.find((j) => j.fileName.startsWith('entityculling'))!;
    act(() => m.store.getState().select({ kind: 'jar', id: ec.id }));
    const inspector = within(screen.getByRole('complementary', { name: 'Inspector' }));
    expect(inspector.getByText('1.7.1-beta.2')).toBeTruthy();
    expect(inspector.getByText('beta')).toBeTruthy();
    expect(inspector.getByText('client only')).toBeTruthy();
  });

  it('offline: the unreachable notice in fg-dim with an info pip; jars read unknown', async () => {
    const m = await renderApp({ scenario: 'offline' });
    await act(async () => {
      await until(() => m.store.getState().modrinth[ATM.id]?.status === 'done');
    });
    const notice = screen.getByTitle('Modrinth unreachable — static checks only');
    expect(notice.className).toContain('text-fg-dim');
    expect(notice.querySelector('.bg-info')).not.toBeNull();
    act(() => m.store.getState().select({ kind: 'jar', id: CREATE }));
    expect(within(screen.getByRole('complementary', { name: 'Inspector' })).getByText('unknown (Modrinth unreachable)')).toBeTruthy();
  });

  it('rate limit: a countdown notice', async () => {
    const m = await renderApp({ scenario: 'ratelimit' }, { setTimer: () => undefined, now: () => Date.now() });
    await act(async () => {
      await until(() => m.store.getState().modrinth[ATM.id]?.notice?.kind === 'rateLimited');
    });
    expect(screen.getByTitle(/^Modrinth rate limit — retrying in [3-5] s$/)).toBeTruthy();
  });

  it('rail settings switch Modrinth off (a quiet segment) and betas on', async () => {
    const m = await renderApp();
    await enriched(m);
    const group = screen.getByRole('group', { name: 'Modrinth' });
    await act(async () => {
      fireEvent.click(within(group).getByRole('button', { name: 'Beta update suggestions disabled' }));
      await until(() => m.backend.settings().includeBeta);
    });
    await act(async () => {
      fireEvent.click(within(group).getByRole('button', { name: 'Modrinth lookups enabled' }));
      await until(() => m.store.getState().modrinth[ATM.id]?.status === 'off');
    });
    expect(m.backend.settings().modrinthEnabled).toBe(false);
    expect(screen.getByText('Modrinth off')).toBeTruthy();
    expect((within(group).getByRole('button', { name: 'Beta update suggestions enabled' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole('button', { name: 'Refresh Modrinth' })).toBeNull();
  });
});

describe('real checks with Modrinth', () => {
  it('W-CLIENT-ON-SERVER and I-NOT-ON-MODRINTH fire on the server instance and render', async () => {
    const backend = createMockBackend({ scanMs: 0, latencyMs: 0 });
    const store = createAppStore({ backend, frame: (cb) => cb() });
    render(<App store={store} />);
    await act(async () => {
      await store.getState().init();
    });
    const server = MOCK_INSTANCES.find((i) => i.side === 'server')!;
    await act(async () => {
      store.getState().selectInstance(server.id);
      await until(() => store.getState().modrinth[server.id]?.status === 'done', 4000);
    });
    const codes = store.getState().scans[server.id]!.findings.map((f) => f.code);
    expect(codes).toContain('W-CLIENT-ON-SERVER');
    expect(codes).toContain('I-NOT-ON-MODRINTH');
    const list = screen.getByRole('list', { name: /Findings/ });
    expect(within(list).getAllByRole('button', { name: /W-CLIENT-ON-SERVER/ }).length).toBeGreaterThan(0);
    expect(within(list).getByRole('button', { name: /I-NOT-ON-MODRINTH/ })).toBeTruthy();
  });
});
