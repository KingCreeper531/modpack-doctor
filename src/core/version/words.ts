/**
 * A declared range in plain words for advice text: `[6.0,)` → "6.0 or newer",
 * `[0.5.1,0.5.2)` → "0.5.1 or newer, but older than 0.5.2", `>=0.15 <0.16` → the same shape,
 * `[1.2]` → "exactly 1.2". Built on `parseRange(…).describe()` (one source of truth for both
 * syntaxes); placeholders get `describePlaceholderRange`. Falls back to the raw text. Pure.
 */
import type { RawRange } from '../../bindings';
import type { VersionSubject } from '../model';
import { parseRange } from './index';
import { describePlaceholderRange } from './placeholders';

function atomInWords(atom: string): string {
  const m = /^(≥|>|≤|<)\s+(\S+)$/.exec(atom.trim());
  if (m) {
    const v = m[2] ?? '';
    switch (m[1]) {
      case '≥':
        return `${v} or newer`;
      case '>':
        return `newer than ${v}`;
      case '≤':
        return `${v} or older`;
      default:
        return `older than ${v}`;
    }
  }
  const only = /^(\S+) only$/.exec(atom.trim());
  if (only) return `exactly ${only[1] ?? ''}`;
  return atom.trim();
}

/** "≥ 6.0 and < 7" → "6.0 or newer, but older than 7". */
export function describedInWords(described: string): string {
  return described
    .split(' or ')
    .map((group) => {
      const atoms = group.split(' and ').map(atomInWords);
      return atoms.length === 2 ? `${atoms[0]}, but ${atoms[1]}` : atoms.join(' and ');
    })
    .join('; or ');
}

export function rangeInWords(range: RawRange, subject: VersionSubject = 'other'): string {
  const placeholder = describePlaceholderRange(range, subject);
  if (placeholder) return placeholder;
  const parsed = parseRange(range, subject);
  if (parsed.ok) return describedInWords(parsed.describe());
  if (range.unrepresentable) return range.unrepresentable;
  return range.raw.length === 0 ? '*' : range.raw.join(' || ');
}
