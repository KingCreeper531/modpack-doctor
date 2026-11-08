/**
 * "Paste a log" and "Share on mclo.gs" (pure helpers and types; the store wires them).
 *
 * Paste: text the user pastes is digested in TS (`digestPastedText`, same shape and bounds as the
 * Rust digest) and analysed like a file of the selected instance, as the kind of log it looks
 * like (`pastedKind`: a crash report, an hs_err file, or console/latest.log text). It is listed
 * among that instance's logs as a session-only source ({@link PASTED_SOURCE_ID}); it is never
 * sent to Rust, never uploaded and never written to disk, and a new paste replaces it. Mod ids
 * found in it may be looked up on Modrinth (when "Look up mods online" is on), like a log file's.
 *
 * Share: `share_log(instanceId, sourceId)` takes only ids, so the webview can never make Rust
 * upload arbitrary text or files; Rust reads the listed file through the PathGuard, replaces the
 * home folder with `~`, removes login tokens and the computer's user name, keeps the end within
 * mclo.gs's limits and uploads to `api.mclo.gs` only after the confirmation dialog. The link is
 * copied with `navigator.clipboard` (no Tauri permission) and opened through the opener, whose
 * scope is exactly `https://mclo.gs/*`. Rust keeps the upload's delete token for the session
 * (never sent here); `delete_shared_log(id)` deletes the upload with it.
 */
import { openUrl } from '@tauri-apps/plugin-opener';

import type { AppError, LogSource, SharedLog } from '../../bindings';
import { PASTE_MAX_CHARS, PASTE_MAX_LINES, pastedKind } from '../../core/crash/digest';
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

/** What the paste dialog says about where the text goes. */
export function pastePrivacyText(modrinthEnabled: boolean): string {
  return modrinthEnabled
    ? 'The text is not uploaded and not saved; mod names in it may be looked up on Modrinth.'
    : 'The text stays on this computer: it is not uploaded and not saved.';
}

/** UTF-8 byte length of `text` without encoding it (a lone surrogate counts as U+FFFD, 3 bytes). */
export function utf8Length(text: string): number {
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length) {
      const d = text.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        n += 4;
        i++;
      } else n += 3;
    } else n += 3;
  }
  return n;
}

/** The session-only source for pasted text, as the kind of log it looks like. */
export function pastedSource(text: string, now: number): LogSource {
  return { id: PASTED_SOURCE_ID, kind: pastedKind(text), modifiedMs: now, size: utf8Length(text) };
}

const MCLOGS_PAGE = /^https:\/\/mclo\.gs\/([A-Za-z0-9]+)$/;

/** Only mclo.gs log pages (`https://mclo.gs/<id>`) are ever opened from a share. */
export function isMclogsPage(url: string): boolean {
  return MCLOGS_PAGE.test(url);
}

/** The log id of a mclo.gs page link, or null. */
export function mclogsId(url: string): string | null {
  return MCLOGS_PAGE.exec(url)?.[1] ?? null;
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

/** What the share confirmation says is changed before the upload. */
export const SHARE_PRIVACY_TEXT =
  'Before the upload your home folder is replaced with ~, and login tokens, account IDs and your computer’s user name are removed. Your Minecraft player name stays visible.';

/** A share refusal as shown in the dialog; offline gets its own sentence. */
export function shareErrorText(e: AppError): string {
  if (e.kind === 'offline') return 'This computer seems to be offline, so nothing was uploaded. Check the connection and try again.';
  return e.message;
}
