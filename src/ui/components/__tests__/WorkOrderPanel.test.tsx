// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { OpStatus, WorkOrder } from '../../../bindings';
import { STATUSES_RUNNING, WORK_ORDER_FIX, WORK_ORDER_RESTORE, WORK_ORDER_UNDO } from '../../design/fixtures';
import { WorkOrderPanel } from '../WorkOrderPanel';

afterEach(cleanup);

function setup(order = WORK_ORDER_FIX, phase: 'review' | 'running' | 'finished' = 'review') {
  const onExecute = vi.fn();
  const onCancel = vi.fn();
  render(<WorkOrderPanel order={order} phase={phase} onExecute={onExecute} onCancel={onCancel} />);
  const panel = screen.getByLabelText(new RegExp(`^Work order ${order.id}`));
  return { onExecute, onCancel, panel };
}

describe('WorkOrderPanel keyboard gating (DESIGN §6.4)', () => {
  it('blocks Enter on a focused Execute button for a fix order with downloads', () => {
    const { onExecute } = setup(WORK_ORDER_FIX);
    const execute = screen.getByRole('button', { name: 'Execute' });
    execute.focus();
    // fireEvent returns false when the handler called preventDefault (no native click follows).
    expect(fireEvent.keyDown(execute, { key: 'Enter' })).toBe(false);
    expect(onExecute).not.toHaveBeenCalled();
    // Space and clicks still work.
    expect(fireEvent.keyDown(execute, { key: ' ' })).toBe(true);
    fireEvent.click(execute);
    expect(onExecute).toHaveBeenCalledTimes(1);
  });

  it('ignores Enter on the panel for a fix order and shows no ↵ hint', () => {
    const { onExecute, panel } = setup(WORK_ORDER_FIX);
    fireEvent.keyDown(panel, { key: 'Enter' });
    expect(onExecute).not.toHaveBeenCalled();
    expect(screen.queryByText('↵')).toBeNull();
  });

  it('lets Enter execute a single-rename undo and shows the ↵ hint', () => {
    const { onExecute, panel } = setup(WORK_ORDER_UNDO);
    expect(screen.getByText('↵')).toBeTruthy();
    fireEvent.keyDown(panel, { key: 'Enter' });
    expect(onExecute).toHaveBeenCalledTimes(1);
    const execute = screen.getByRole('button', { name: /Execute/ });
    // On the button itself Enter is left to the native click.
    expect(fireEvent.keyDown(execute, { key: 'Enter' })).toBe(true);
  });

  it('cancels with Esc, except while running', () => {
    const a = setup(WORK_ORDER_FIX);
    fireEvent.keyDown(a.panel, { key: 'Escape' });
    expect(a.onCancel).toHaveBeenCalledTimes(1);
    cleanup();
    const b = setup(WORK_ORDER_FIX, 'running');
    fireEvent.keyDown(b.panel, { key: 'Escape' });
    expect(b.onCancel).not.toHaveBeenCalled();
    expect((screen.getByRole('button', { name: 'Executing' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('ignores an auto-repeated Enter (held on a History Undo), on the panel and on a focused Execute', () => {
    const { onExecute, panel } = setup(WORK_ORDER_UNDO);
    expect(fireEvent.keyDown(panel, { key: 'Enter', repeat: true })).toBe(false);
    expect(onExecute).not.toHaveBeenCalled();
    const execute = screen.getByRole('button', { name: /Execute/ });
    execute.focus();
    // preventDefault: no native click from the held key either.
    expect(fireEvent.keyDown(execute, { key: 'Enter', repeat: true })).toBe(false);
    expect(onExecute).not.toHaveBeenCalled();
    // A fresh press still works.
    fireEvent.keyDown(panel, { key: 'Enter' });
    expect(onExecute).toHaveBeenCalledTimes(1);
  });

  it('ignores Enter whose target is outside the panel (a History Undo button, the page)', () => {
    const onExecute = vi.fn();
    render(
      <>
        <button type="button">Undo</button>
        <WorkOrderPanel order={WORK_ORDER_UNDO} onExecute={onExecute} onCancel={() => undefined} autoFocus />
      </>,
    );
    fireEvent.keyDown(screen.getByRole('button', { name: 'Undo' }), { key: 'Enter' });
    fireEvent.keyDown(document.body, { key: 'Enter' });
    fireEvent.keyDown(document, { key: 'Enter' });
    expect(onExecute).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByLabelText(/^Work order 0413/), { key: 'Enter' });
    expect(onExecute).toHaveBeenCalledTimes(1);
  });

  it('never executes an undo by Enter while it is running', () => {
    const { onExecute, panel } = setup(WORK_ORDER_UNDO, 'running');
    fireEvent.keyDown(panel, { key: 'Enter' });
    expect(onExecute).not.toHaveBeenCalled();
  });

  it('Esc closes a finished order; Enter does nothing then', () => {
    const { onCancel, onExecute, panel } = setup(WORK_ORDER_UNDO, 'finished');
    fireEvent.keyDown(panel, { key: 'Enter' });
    expect(onExecute).not.toHaveBeenCalled();
    fireEvent.keyDown(panel, { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Close' })).toBeTruthy();
  });

  it('an expired order never executes, by Enter or click; Plan again replaces it', () => {
    const onPlanAgain = vi.fn();
    const onExecute = vi.fn();
    render(
      <WorkOrderPanel
        order={WORK_ORDER_UNDO}
        expired
        error={{ kind: 'notFound', message: 'This work order expired — review the fixes again.', path: null }}
        onPlanAgain={onPlanAgain}
        onExecute={onExecute}
        onCancel={() => undefined}
      />,
    );
    fireEvent.keyDown(screen.getByLabelText(/^Work order 0413/), { key: 'Enter' });
    expect(screen.queryByText('↵')).toBeNull();
    const execute = screen.getByRole('button', { name: 'Execute' }) as HTMLButtonElement;
    expect(execute.disabled).toBe(true);
    expect(onExecute).not.toHaveBeenCalled();
    expect(screen.getByText('This work order expired — review the fixes again.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Plan again' }));
    expect(onPlanAgain).toHaveBeenCalledTimes(1);
  });

  it('autoFocus moves focus into the panel so Esc / Enter work at once, and back after Execute disables', () => {
    const props = { order: WORK_ORDER_FIX, onExecute: () => undefined, onCancel: () => undefined, autoFocus: true };
    const { rerender } = render(<WorkOrderPanel {...props} />);
    const panel = screen.getByLabelText(/^Work order 0412/);
    expect(document.activeElement).toBe(panel);
    const execute = screen.getByRole('button', { name: 'Execute' });
    execute.focus();
    rerender(<WorkOrderPanel {...props} phase="running" />);
    expect(document.activeElement).toBe(panel);
  });
});

describe('WorkOrderPanel rendering', () => {
  it('renders every op kind as a numbered mono row (rename, backup, download with size and host, restore, remove)', () => {
    const order: WorkOrder = {
      ...WORK_ORDER_FIX,
      ops: [...WORK_ORDER_FIX.ops, ...WORK_ORDER_RESTORE.ops],
    };
    render(<WorkOrderPanel order={order} onExecute={() => undefined} onCancel={() => undefined} />);
    const rows = screen.getAllByRole('listitem').map((li) => li.textContent);
    expect(rows).toHaveLength(7);
    expect(rows[0]).toBe('01renamemods/rubidium-0.7.1.jar → mods/rubidium-0.7.1.jar.disabledpending');
    const dl = WORK_ORDER_FIX.ops[1]!.op;
    const url = dl.op === 'download' ? dl.url : '';
    expect(url).toMatch(/^https:\/\/cdn\.modrinth\.com\//);
    expect(rows[1]).toBe(`02downloadsodium 0.5.11 (312 KB) from cdn.modrinth.com → mods/sodium-0.5.11.jarreplaces mods/sodium-0.5.8.jar${url}pending`);
    expect(rows[2]).toBe('03backupmods/sodium-0.5.8.jar → backup snapshotpending');
    expect(rows[4]).toBe('05restoremods/sodium-0.5.8.jar → mods/sodium-0.5.8.jarexpects absentpending');
    expect(rows[5]).toBe('06removemods/sodium-0.5.11.jar → backup snapshotcreated by fix · sha1 4f2c9e1apending');
    expect(screen.getByText(WORK_ORDER_FIX.backupDir)).toBeTruthy();
    expect(screen.getByText('manual step: set the Java runtime to Java 21 if sodium still fails')).toBeTruthy();
    expect(screen.getByText(`fix · 7 ops`)).toBeTruthy();
  });

  it('a download row shows host + size in its main line and the full CDN URL as a truncated detail line', () => {
    render(<WorkOrderPanel order={WORK_ORDER_FIX} onExecute={() => undefined} onCancel={() => undefined} />);
    const dl = WORK_ORDER_FIX.ops[1]!.op;
    if (dl.op !== 'download') throw new Error('fixture changed');
    const row = screen.getAllByRole('listitem')[1]!;
    expect(row.textContent).toContain('(312 KB) from cdn.modrinth.com');
    const line = screen.getByText(dl.url);
    expect(line.getAttribute('title')).toBe(dl.url);
    expect(line.className).toContain('truncate');
    expect(line.className).toContain('text-fg-faint');
    expect(row.contains(line)).toBe(true);
    // Only downloads have a source URL line.
    const downloads = WORK_ORDER_FIX.ops.filter((p) => p.op.op === 'download').length;
    expect(WORK_ORDER_FIX.ops.length).toBeGreaterThan(downloads);
    expect(document.querySelectorAll('[data-role="source-url"]')).toHaveLength(downloads);
  });

  it('a message on a completed op (a rollback step that failed) shows under it; the plain "rolled back" mark does not', () => {
    const statuses: OpStatus[] = [
      { orderId: WORK_ORDER_FIX.id, index: 0, state: 'done', message: 'Rollback failed: mods/rubidium-0.7.1.jar.disabled is locked.' },
      { orderId: WORK_ORDER_FIX.id, index: 1, state: 'done', message: 'rolled back' },
      { orderId: WORK_ORDER_FIX.id, index: 2, state: 'failed', message: 'locked' },
    ];
    render(<WorkOrderPanel order={WORK_ORDER_FIX} statuses={statuses} phase="finished" onExecute={() => undefined} onCancel={() => undefined} />);
    expect(screen.getByText('Rollback failed: mods/rubidium-0.7.1.jar.disabled is locked.')).toBeTruthy();
    expect(screen.getAllByRole('listitem')[1]!.textContent).not.toContain('rolled backdone');
  });

  it('a running game is a warning line before Execute, which stays enabled (Rust refuses)', () => {
    render(
      <WorkOrderPanel
        order={WORK_ORDER_FIX}
        game={{ running: true, pids: [18244], reason: 'javaw.exe pid 18244 with --gameDir D:\\mc' }}
        onExecute={() => undefined}
        onCancel={() => undefined}
      />,
    );
    const warn = screen.getByRole('status');
    expect(warn.textContent).toContain('game running');
    expect(warn.textContent).toContain('Minecraft is running (javaw.exe pid 18244 with --gameDir D:\\mc). Close it before you execute');
    expect((screen.getByRole('button', { name: 'Execute' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('a gameRunning refusal reads "Close Minecraft first: …" and replaces the warning line', () => {
    render(
      <WorkOrderPanel
        order={WORK_ORDER_FIX}
        game={{ running: true, pids: [1], reason: 'x' }}
        error={{ kind: 'gameRunning', message: 'Minecraft is running for "ATM9". Nothing was changed.', path: null }}
        onExecute={() => undefined}
        onCancel={() => undefined}
      />,
    );
    const row = screen.getByRole('alert');
    expect(row.getAttribute('data-kind')).toBe('gameRunning');
    expect(row.textContent).toContain('Close Minecraft first: Minecraft is running for "ATM9". Nothing was changed.');
    expect(screen.queryByText(/Close it before you execute/)).toBeNull();
    expect((screen.getByRole('button', { name: 'Execute' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('while executing: the running op has the bar, Cancel is disabled, Execute shows Executing', () => {
    const { container } = render(<WorkOrderPanel order={WORK_ORDER_FIX} statuses={STATUSES_RUNNING} phase="running" onExecute={() => undefined} onCancel={() => undefined} />);
    expect(container.querySelectorAll('.md-op-bar')).toHaveLength(1);
    expect((screen.getByRole('button', { name: 'Cancel' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Executing' }) as HTMLButtonElement).disabled).toBe(true);
    const rows = screen.getAllByRole('listitem').map((li) => li.textContent ?? '');
    expect(rows.map((r) => r.match(/(pending|running|done)$/)?.[1])).toEqual(['done', 'running', 'pending', 'pending']);
  });

  it('a successful order: a done line and Close', () => {
    const statuses: OpStatus[] = WORK_ORDER_FIX.ops.map((_, index) => ({ orderId: '0412', index, state: 'done', message: null }));
    render(<WorkOrderPanel order={WORK_ORDER_FIX} statuses={statuses} phase="finished" onExecute={() => undefined} onCancel={() => undefined} />);
    expect(screen.getByRole('status').textContent).toBe('doneDone: 4 operations completed. Each action can be undone from History.');
    expect(screen.queryByRole('button', { name: 'Execute' })).toBeNull();
    expect(screen.getByText('4 done')).toBeTruthy();
  });

  it('a rolled-back order: the failed op message inline and in the outcome, completed ops read "rolled back"', () => {
    const statuses: OpStatus[] = [
      { orderId: '0412', index: 0, state: 'done', message: 'rolled back' },
      { orderId: '0412', index: 1, state: 'failed', message: 'The SHA-512 does not match.' },
      { orderId: '0412', index: 2, state: 'skipped', message: null },
      { orderId: '0412', index: 3, state: 'skipped', message: null },
    ];
    render(<WorkOrderPanel order={WORK_ORDER_FIX} statuses={statuses} phase="finished" rolledBack onExecute={() => undefined} onCancel={() => undefined} />);
    const rows = screen.getAllByRole('listitem').map((li) => li.textContent ?? '');
    expect(rows[0]).toMatch(/rolled back$/);
    expect(rows[1]).toMatch(/The SHA-512 does not match\.failed$/);
    expect(rows[2]).toMatch(/skipped$/);
    const outcome = screen.getByRole('alert');
    expect(outcome.textContent).toBe(
      'rolled backOperation 02 failed: The SHA-512 does not match. Rolled back: every completed operation was reversed, so the files are as they were.',
    );
    expect(screen.getByRole('button', { name: 'Close' })).toBeTruthy();
  });
});
