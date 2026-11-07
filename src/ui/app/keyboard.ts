/**
 * Keyboard shortcuts (CONTRACTS invariant 17), as pure functions over a key event and the store
 * state; screens/Shortcuts.tsx owns the single window listener that applies them.
 *
 * | Keys | Shortcut |
 * |---|---|
 * | Ctrl/Cmd+K | open or close the command palette |
 * | J / K | next / previous finding in the visible list (FINDINGS, or a crash source's findings) |
 * | Enter | expand or collapse the row under the keyboard cursor |
 * | Ctrl/Cmd+R | rescan the open instance (the webview reload is always suppressed) |
 * | Esc | close the top-most layer: palette, then the context menu, then the inspector selection |
 *
 * Never while typing: nothing fires when the event comes from an input, textarea, select or
 * contenteditable element (the palette's own input may close the palette with Ctrl/Cmd+K).
 * Never a work order: no shortcut executes or cancels an order. Enter stays bound to DESIGN
 * §6.4's rule (the work order panel handles it), so the global Enter only acts when focus is on
 * nothing interactive, and Esc leaves an open order to its panel.
 */
import type { AppState } from './store';

export type Shortcut = 'palette' | 'next' | 'previous' | 'toggle' | 'rescan' | 'escape';

/** The parts of a `KeyboardEvent` the shortcuts read. */
export interface KeyInput {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  target: EventTarget | null;
  defaultPrevented?: boolean;
  repeat?: boolean;
}

const TYPING_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT']);

function asElement(t: EventTarget | null): Element | null {
  return t && typeof (t as Element).tagName === 'string' ? (t as Element) : null;
}

/** True when the target takes text: an input, textarea, select or contenteditable element. */
export function isTypingTarget(t: EventTarget | null): boolean {
  const el = asElement(t);
  if (!el) return false;
  if (TYPING_TAGS.has(el.tagName)) return true;
  const ce = (el as HTMLElement).isContentEditable;
  if (ce) return true;
  // happy-dom and older engines do not compute isContentEditable.
  return !!el.closest?.('[contenteditable]:not([contenteditable="false"])');
}

/** The command palette's own input (cmdk marks it). */
function isPaletteInput(t: EventTarget | null): boolean {
  return !!asElement(t)?.hasAttribute?.('cmdk-input');
}

const INTERACTIVE = 'a[href],button,input,select,textarea,summary,[role="button"],[role="menuitem"],[role="tab"],[role="row"][tabindex],[tabindex]:not([tabindex="-1"])';

/**
 * The global Enter acts only when focus is on nothing that handles Enter itself (the page body or
 * a plain container): a focused button keeps its own Enter, and so does the work order panel.
 */
export function enterIsFree(t: EventTarget | null): boolean {
  const el = asElement(t);
  if (!el) return true;
  if (el.tagName === 'BODY' || el.tagName === 'HTML') return true;
  if (el.closest?.('[data-work-order]')) return false;
  return !el.matches?.(INTERACTIVE);
}

/** The platform's command modifier: Cmd on macOS, Ctrl elsewhere (either is accepted). */
const command = (e: KeyInput) => e.ctrlKey || e.metaKey;

/** Which shortcut a key press is, or null. Applies the "never while typing" guard. */
export function shortcutOf(e: KeyInput): Shortcut | null {
  if (e.defaultPrevented) return null;
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  if (command(e) && !e.altKey && !e.shiftKey && key === 'k') {
    return !isTypingTarget(e.target) || isPaletteInput(e.target) ? 'palette' : null;
  }
  if (isTypingTarget(e.target)) return null;
  if (command(e) && !e.altKey && !e.shiftKey && key === 'r') return 'rescan';
  if (e.ctrlKey || e.metaKey || e.altKey) return null;
  if (key === 'Escape') return 'escape';
  if (e.shiftKey) return null;
  if (key === 'j') return 'next';
  if (key === 'k') return 'previous';
  if (key === 'Enter' && !e.repeat && enterIsFree(e.target)) return 'toggle';
  return null;
}

/**
 * Ctrl/Cmd+R reloads the webview (and every piece of state with it); it is swallowed even while
 * typing, where it does not rescan.
 */
export function suppressesDefault(e: KeyInput): boolean {
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  return command(e) && !e.altKey && !e.shiftKey && (key === 'r' || key === 'k');
}

/** A finding list the keyboard cursor can walk. */
export interface VisibleList {
  kind: 'finding' | 'crash';
  ids: string[];
  /** For crash findings: the log source shown. */
  sourceId?: string;
}

/**
 * The findings list on screen for the open instance: the static findings on the FINDINGS legend,
 * the selected source's crash findings on CRASHES (diagnosis pane), nothing on HISTORY or the
 * raw log. Packs have FINDINGS only.
 */
export function visibleList(s: Pick<AppState, 'selectedInstanceId' | 'findingsTab' | 'scans' | 'crashes'>): VisibleList | null {
  const id = s.selectedInstanceId;
  if (!id) return null;
  const tab = s.findingsTab[id] ?? 'findings';
  if (tab === 'findings') return { kind: 'finding', ids: (s.scans[id]?.findings ?? []).map((f) => f.id) };
  if (tab !== 'crashes') return null;
  const c = s.crashes[id];
  if (!c || c.pane !== 'diagnosis' || !c.selectedSourceId) return null;
  const a = c.analyses[c.selectedSourceId];
  if (!a || a.status !== 'done') return null;
  return { kind: 'crash', ids: a.findings.map((f) => f.id), sourceId: c.selectedSourceId };
}

/**
 * The cursor after J (+1) or K (-1): from nothing, J lands on the first row and K on the last;
 * it stops at the ends (no wrap). A cursor no longer in the list starts over.
 */
export function moveCursor(ids: readonly string[], cursor: string | null, delta: 1 | -1): string | null {
  if (!ids.length) return null;
  const i = cursor === null ? -1 : ids.indexOf(cursor);
  if (i < 0) return delta > 0 ? ids[0]! : ids[ids.length - 1]!;
  return ids[Math.min(ids.length - 1, Math.max(0, i + delta))]!;
}

/** True on macOS-like platforms (shortcut labels read `⌘K` there, `Ctrl+K` elsewhere). */
export function isMac(nav: { platform?: string; userAgent?: string } | undefined = typeof navigator === 'undefined' ? undefined : navigator): boolean {
  const p = `${nav?.platform ?? ''} ${nav?.userAgent ?? ''}`;
  return /Mac|iPhone|iPad/.test(p);
}

/** `Ctrl+R` / `⌘R`. */
export function chord(key: string, mac = isMac()): string {
  return mac ? `⌘${key.toUpperCase()}` : `Ctrl+${key.toUpperCase()}`;
}
