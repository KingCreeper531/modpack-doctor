/**
 * "Paste a log" and "Share on mclo.gs" (pure helpers and types; the store wires them).
 *
 * Paste: text the user pastes is digested in TS (`digestPastedText`, same shape and bounds as the
 * Rust digest) and analysed like a file of the selected instance. It is listed among that
 * instance's logs as a session-only source ({@link PASTED_SOURCE_ID}); it is never sent to Rust,
 * never uploaded and never written to disk, and a new paste replaces it.
 *
 * Share: `share_log(instanceId, sourceId)` takes only ids, so the webview can never make Rust
 * upload arbitrary text or files; Rust reads the listed file through the PathGuard, replaces the
 * home folder with `~`, keeps the end within mclo.gs's limits and uploads to `api.mclo.gs` only
 * after the confirmation dialog. The link is copied with `navigator.clipboard` (no Tauri
 * permission) and opened through the opener, whose scope is exactly `https://mclo.gs/*`.
 */
import { openUrl } from '@tauri-apps/plugin-opener';

import type { AppError, LogSource, SharedLog } from '../../bindings';
import { PASTE_MAX_CHARS, PASTE_MAX_LINES } from '../../core/crash/digest';
import type { Backend } from './ipc';

/** The pasted text's source id; never a file path (Rust ids never contain a space). */
export const PASTED_SOURCE_ID = 'pasted text';

export function isPastedSource(id: string): boolean {
  return id === PASTED_SOURCE_ID;
}

export type LogDialog =
  | { kind: 'paste'; instanceId: string }
  | { kind: 'share'; instanceId: string; sourceId: string };

/** What the paste dialog says about the limits. */
export const PASTE_LIMIT_TEXT = `Up to ${(PASTE_MAX_CHARS / 1_000_000).toFixed(0)} MB or ${PASTE_MAX_LINES.toLocaleString('en-US')} lines; longer text keeps its end.`;

/** The session-only source for pasted text. */
export function pastedSource(text: string, now: number): LogSource {
  return { id: PASTED_SOURCE_ID, kind: 'latestLog', modifiedMs: now, size: new TextEncoder().encode(text).length };
}

/** Only mclo.gs log pages (`https://mclo.gs/<id>`) are ever opened from a share. */
export function isMclogsPage(url: string): boolean {
  return /^https:\/\/mclo\.gs\/[A-Za-z0-9]+$/.test(url);
}

export async function openMclogs(url: string, kind: Backend['kind']): Promise<void> {
  if (!isMclogsPage(url)) return;
  if (kind === 'tauri') await openUrl(url).catch(() => undefined);
  else if (kind === 'mock' && typeof window !== 'undefined') window.open(url, '_blank', 'noopener,noreferrer');
}

/** Copies `text` with the browser clipboard API; false when it is unavailable or refused. */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (typeof navigator === 'undefined' || !navigator.clipboard) return false;
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** The line under the link after a successful share. */
export function sharedNote(s: SharedLog): string {
  if (!s.truncated) return `All ${s.totalLines.toLocaleString('en-US')} lines were uploaded.`;
  return `The log was too long for mclo.gs: the last ${s.sentLines.toLocaleString('en-US')} of ${s.totalLines.toLocaleString(
    'en-US',
  )} lines were uploaded (the end, where crashes are), with a note at the top saying the start was left out.`;
}

/** A share refusal as shown in the dialog; offline gets its own sentence. */
export function shareErrorText(e: AppError): string {
  if (e.kind === 'offline') return 'This computer seems to be offline, so nothing was uploaded. Check the connection and try again.';
  return e.message;
}
