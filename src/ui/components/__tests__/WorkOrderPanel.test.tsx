// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { WORK_ORDER_FIX, WORK_ORDER_UNDO } from '../../design/fixtures';
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

  it('never executes an undo by Enter while it is running', () => {
    const { onExecute, panel } = setup(WORK_ORDER_UNDO, 'running');
    fireEvent.keyDown(panel, { key: 'Enter' });
    expect(onExecute).not.toHaveBeenCalled();
  });
});
