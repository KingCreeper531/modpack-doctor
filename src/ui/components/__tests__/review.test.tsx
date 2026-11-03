// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import type { Finding } from '../../../core/model';
import { EmptyState } from '../EmptyState';
import { ErrorRow } from '../ErrorRow';
import { EvidenceView } from '../EvidenceView';
import { TriageRow } from '../TriageRow';

afterEach(cleanup);

const base: Finding = {
  id: 'f1',
  code: 'E-DUP-ID',
  severity: 'warning',
  title: 'Two jars declare mod id jei',
  explanation: 'Identical copies; the loader keeps one.',
  culprits: ['a', 'b', 'c', 'd'].map((x) => ({ jarId: `mods/${x}-very-long-file-name-1.20.1.jar`, fileName: `${x}-very-long-file-name-1.20.1.jar` })),
  evidence: [
    {
      kind: 'metadata',
      jarId: 'mods/a.jar',
      file: 'META-INF/mods.toml',
      excerpt: Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n'),
      highlight: [15],
    },
  ],
  fixes: [{ kind: 'disable', jarId: 'mods/a.jar' }],
};

describe('TriageRow review fixes', () => {
  it('qualifies a lowered E- code with its real severity', () => {
    render(<TriageRow finding={base} expanded={false} onToggle={() => undefined} />);
    const btn = screen.getByRole('button', { name: /E-DUP-ID/ });
    expect(btn.textContent).toContain('E-DUP-IDwarn');
    expect(within(btn).getByText('warn').className).not.toContain('text-err-text');
    cleanup();
    render(<TriageRow finding={{ ...base, severity: 'error' }} expanded={false} onToggle={() => undefined} />);
    expect(screen.queryByText('warn')).toBeNull();
    expect(screen.queryByText('error')).toBeNull();
  });

  it('shows two ellipsizing culprit chips and +N for the rest', () => {
    render(<TriageRow finding={base} expanded={false} onToggle={() => undefined} onJarClick={() => undefined} />);
    const strip = screen.getByTestId('culprits');
    const chips = within(strip).getAllByRole('button');
    expect(chips).toHaveLength(2);
    for (const c of chips) {
      expect(c.className).toContain('shrink');
      expect(c.className).not.toContain('shrink-0');
      expect(c.querySelector('.truncate')).not.toBeNull();
    }
    const more = within(strip).getByText('+2');
    expect(more.getAttribute('title')).toBe('c-very-long-file-name-1.20.1.jar\nd-very-long-file-name-1.20.1.jar');
  });

  it('clips metadata evidence to 12 lines around the highlight with a Show all toggle', () => {
    render(<TriageRow finding={base} expanded onToggle={() => undefined} />);
    const viewer = screen.getByRole('region', { name: /META-INF\/mods.toml/ });
    expect(within(viewer).queryByText('line 1')).toBeNull();
    expect(within(viewer).getByText('line 15')).toBeTruthy();
    const toggle = screen.getByRole('button', { name: 'Show all 30 lines' });
    fireEvent.click(toggle);
    expect(within(screen.getByRole('region', { name: /META-INF\/mods.toml/ })).getByText('line 1')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Show fewer' }).getAttribute('aria-expanded')).toBe('true');
  });

  it('does not promise work orders: no hint unless one is passed', () => {
    render(<TriageRow finding={base} expanded onToggle={() => undefined} />);
    expect(screen.queryByText(/work order/)).toBeNull();
    expect(screen.getByRole('button', { name: /^Disable/ })).toBeTruthy();
  });

  it('the inspector-style view (no clipLines) shows the whole excerpt', () => {
    render(<EvidenceView evidence={base.evidence[0]!} />);
    expect(screen.getByText('line 1')).toBeTruthy();
    expect(screen.getByText('line 30')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Show all/ })).toBeNull();
  });
});

describe('ErrorRow', () => {
  it('renders unavailable neutrally: info rail, dim text, status role, never "internal"', () => {
    render(<ErrorRow error={{ kind: 'unavailable', message: "Applying fixes isn't available in this version of Modpack Doctor yet.", path: null }} />);
    const row = screen.getByRole('status');
    expect(row.querySelector('.bg-info')).not.toBeNull();
    expect(row.querySelector('.bg-err')).toBeNull();
    expect(row.querySelector('.text-err-text')).toBeNull();
    expect(row.textContent).not.toMatch(/internal|unavailable/);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('keeps real failures loud', () => {
    render(<ErrorRow error={{ kind: 'permission', message: 'No access.', path: null }} />);
    const row = screen.getByRole('alert');
    expect(row.querySelector('.bg-err')).not.toBeNull();
    expect(within(row).getByText('permission').className).toContain('text-err-text');
  });
});

describe('EmptyState copy', () => {
  it('does not offer .mrpack files yet', () => {
    render(<EmptyState probes={[]} onAddFolder={() => undefined} />);
    expect(screen.queryByText(/mrpack/)).toBeNull();
  });
});
