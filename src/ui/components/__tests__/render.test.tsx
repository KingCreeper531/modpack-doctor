// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { LogLine } from '../../../core/model';
import { FINDINGS, PALETTE_GROUPS } from '../../design/fixtures';
import { CommandPalette } from '../CommandPalette';
import { LogViewer } from '../LogViewer';
import { Resizer } from '../Resizer';
import { Toggle } from '../Toggle';
import { TriageRow } from '../TriageRow';

afterEach(cleanup);

const has = (el: Element | null | undefined, cls: string) => !!el && el.classList.contains(cls);

describe('LogViewer culprit contrast rule (DESIGN §2)', () => {
  const lines: LogLine[] = [
    { n: 40, text: 'context before', role: 'context' },
    { n: 41, text: 'Caused by: java.lang.NoClassDefFoundError', role: 'culprit' },
    { n: 43, text: 'after a one-line gap', role: 'context' },
  ];

  it('uses fg-dim numbers and fg text on culprit rows, never fg-faint or err-text', () => {
    const onJarClick = vi.fn();
    const { container } = render(
      <LogViewer lines={lines} frames={[{ line: 41, jarId: 'mods/x.jar' }]} jarLabel={() => 'x.jar'} onJarClick={onJarClick} />,
    );
    const culprits = container.querySelectorAll('.bg-hl-line');
    expect(culprits).toHaveLength(1);
    const row = culprits[0]!;
    const [gutter, text] = Array.from(row.children).filter((c) => c.tagName === 'SPAN' && !c.hasAttribute('aria-hidden'));
    expect(gutter?.textContent).toBe('41');
    expect(has(gutter, 'text-fg-dim')).toBe(true);
    expect(has(text, 'text-fg')).toBe(true);
    for (const el of [row, ...Array.from(row.querySelectorAll('*'))]) {
      expect(has(el, 'text-fg-faint'), `fg-faint on hl-line: ${el.outerHTML.slice(0, 80)}`).toBe(false);
      expect(has(el, 'text-err-text'), 'err-text on hl-line').toBe(false);
    }
    // The 2px signal marker.
    expect(row.querySelector('.bg-signal')).not.toBeNull();
    // Mapped frame renders as a clickable chip.
    fireEvent.click(screen.getByRole('button', { name: 'x.jar' }));
    expect(onJarClick).toHaveBeenCalledWith('mods/x.jar');
  });

  it('keeps context rows at fg-faint numbers / fg-dim text and labels gaps in the singular', () => {
    const { container } = render(<LogViewer lines={lines} />);
    const gutter = Array.from(container.querySelectorAll('span')).find((s) => s.textContent === '40');
    expect(has(gutter, 'text-fg-faint')).toBe(true);
    expect(has(gutter?.nextElementSibling, 'text-fg-dim')).toBe(true);
    expect(screen.getByText(/⋯ 1 line$/)).toBeTruthy();
  });
});

describe('Toggle', () => {
  it('reports aria-pressed and changes its label with the state', () => {
    const onChange = vi.fn();
    const { rerender } = render(<Toggle on={false} label="sodium" onChange={onChange} />);
    const btn = screen.getByRole('button');
    expect(btn.getAttribute('aria-pressed')).toBe('false');
    expect(btn.getAttribute('aria-label')).toBe('sodium disabled');
    fireEvent.click(btn);
    expect(onChange).toHaveBeenCalledWith(true);
    rerender(<Toggle on label="sodium" onChange={onChange} />);
    expect(btn.getAttribute('aria-pressed')).toBe('true');
    expect(btn.getAttribute('aria-label')).toBe('sodium enabled');
  });
});

describe('TriageRow', () => {
  const finding = FINDINGS[0]!;

  it('exposes aria-expanded and keeps collapsed content out of the tab order', () => {
    const onToggle = vi.fn();
    const { rerender } = render(<TriageRow finding={finding} expanded={false} onToggle={onToggle} />);
    const toggle = screen.getByRole('button', { name: new RegExp(finding.code) });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    const body = document.getElementById(toggle.getAttribute('aria-controls')!)!;
    expect(body.hasAttribute('inert')).toBe(true);
    const inside = body.querySelectorAll('button, [tabindex]');
    expect(inside.length).toBeGreaterThan(0);
    for (const el of inside) expect(el.closest('[inert]')).toBe(body);

    fireEvent.click(toggle);
    expect(onToggle).toHaveBeenCalledTimes(1);

    rerender(<TriageRow finding={finding} expanded onToggle={onToggle} />);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(body.hasAttribute('inert')).toBe(false);
    expect(screen.getByRole('button', { name: /Disable rubidium/ })).toBeTruthy();
  });

  it('marks the focused row with the inset signal outline and the selected row as current', () => {
    const { container } = render(<TriageRow finding={finding} expanded={false} onToggle={() => undefined} focused selected />);
    const row = container.firstElementChild!;
    expect(has(row, 'outline-signal')).toBe(true);
    expect(has(row, 'bg-raised')).toBe(true);
    expect(row.getAttribute('aria-current')).toBe('true');
  });
});

describe('Resizer keyboard', () => {
  function setup(edge: 'start' | 'end' = 'start') {
    const onResize = vi.fn();
    const onCommit = vi.fn();
    render(<Resizer size={360} min={280} max={640} edge={edge} onResize={onResize} onCommit={onCommit} label="Resize inspector" />);
    return { onResize, onCommit, handle: screen.getByRole('separator', { name: 'Resize inspector' }) };
  }

  it('is a focusable separator with its value range', () => {
    const { handle } = setup();
    expect(handle.getAttribute('tabindex')).toBe('0');
    expect(handle.getAttribute('aria-valuenow')).toBe('360');
    expect(handle.getAttribute('aria-valuemin')).toBe('280');
    expect(handle.getAttribute('aria-valuemax')).toBe('640');
  });

  it('steps 8px, 32px with Shift, and jumps with Home/End', () => {
    const { handle, onResize, onCommit } = setup();
    fireEvent.keyDown(handle, { key: 'ArrowLeft' });
    fireEvent.keyDown(handle, { key: 'ArrowRight', shiftKey: true });
    fireEvent.keyDown(handle, { key: 'Home' });
    fireEvent.keyDown(handle, { key: 'End' });
    expect(onResize.mock.calls.map((c) => c[0])).toEqual([368, 328, 280, 640]);
    expect(onCommit).toHaveBeenCalledTimes(4);
  });

  it('leaves other keys alone', () => {
    const { handle, onResize } = setup('end');
    expect(fireEvent.keyDown(handle, { key: 'Tab' })).toBe(true);
    expect(onResize).not.toHaveBeenCalled();
    fireEvent.keyDown(handle, { key: 'ArrowRight' });
    expect(onResize).toHaveBeenCalledWith(368);
  });
});

describe('CommandPalette focus', () => {
  it('focuses the input on open and rings the input row via focus-within', () => {
    render(<CommandPalette groups={PALETTE_GROUPS} onSelect={() => undefined} onClose={() => undefined} />);
    const input = screen.getByPlaceholderText('instance, mod id, or action…');
    expect(document.activeElement).toBe(input);
    const row = input.parentElement!;
    expect(has(row, 'focus-within:outline-signal')).toBe(true);
    expect(has(row, 'focus-within:outline-1')).toBe(true);
  });

  it('does not steal focus when autoFocus is off, and closes on Escape', () => {
    const onClose = vi.fn();
    render(<CommandPalette groups={PALETTE_GROUPS} onSelect={() => undefined} onClose={onClose} autoFocus={false} placement="contained" />);
    const input = screen.getByPlaceholderText('instance, mod id, or action…');
    expect(document.activeElement).not.toBe(input);
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
