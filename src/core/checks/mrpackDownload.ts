/**
 * W-MRPACK-DOWNLOAD (warning, CONTRACTS invariant 15): a file declared by a `.mrpack` index
 * (`ScanResult.declared`) lists a download URL outside Modrinth's allowlist. One finding per
 * declared file with at least one such URL; every offending URL is a `note` in the evidence. Works
 * offline (no Modrinth data needed). No fixes: packs are read-only and nothing is ever downloaded.
 *
 * Index entries that are not declared files are checked too, because a launcher may still install
 * them: `ScanResult.unverifiedDownloads` (entries Rust skipped — bad hash, unsafe or folder path,
 * no path — or that a later entry with the same path shadows), plus any declared entry shadowed
 * here by `declaredFiles`. One finding per entry (`entry` as given, cleaned; `files[<i>]` when it
 * had no path), culprit `{ jarId: entry, fileName: basename }`, id `findingId(code, [entry],
 * 'unverified')`, with a note that the entry was skipped or shadowed and may still be installed.
 *
 * A URL is inside the allowlist only when all of this holds (anything else, including a URL that
 * cannot be parsed, counts as outside — the check errs towards warning):
 * - scheme `https` (any case);
 * - no user info (`user:pass@host`): `https://cdn.modrinth.com@evil.example/` really goes to
 *   `evil.example`, and a URL that hides its host is reported whatever the host;
 * - no explicit port other than 443;
 * - the host, lower-cased, is exactly one of `cdn.modrinth.com`, `github.com`,
 *   `raw.githubusercontent.com`, `gitlab.com`. Subdomains (`evil.github.com`), suffixes
 *   (`github.com.evil.example`), a trailing dot, IP literals, percent-encoded or non-ASCII hosts
 *   (IDN lookalikes such as `cdn.modrınth.com`) and punycode (`xn--…`) are all outside;
 * - no whitespace, control characters or backslashes anywhere (WHATWG parsers treat `\` as `/`
 *   and strip some whitespace, so such URLs could resolve differently than they read).
 * The parser is hand-written: `src/core` has no `URL` global (no DOM or Node libs).
 */
import type { DeclaredFile } from '../../bindings';
import type { Check, CheckInput, Evidence, Finding, JarRef } from '../model';
import { contextFor } from './context';
import { makeFinding, plural } from './evidence';
import { declaredFiles, declaredRef, indexNote } from './mrpackDeclared';

/** Modrinth's download host allowlist for `.mrpack` files (modrinth.com docs, "Modpack format"). */
export const MRPACK_DOWNLOAD_HOSTS: readonly string[] = ['cdn.modrinth.com', 'github.com', 'raw.githubusercontent.com', 'gitlab.com'];

const ALLOWED: ReadonlySet<string> = new Set(MRPACK_DOWNLOAD_HOSTS);

export type DownloadVerdict =
  | { allowed: true; host: string }
  /** `host`: lower-cased host as written (null when the URL has none we could read). */
  | { allowed: false; host: string | null; reason: string };

/** Longest URL looked at; longer ones are "outside" (invalid). */
const MAX_URL = 4096;

/** Classify one download URL (see the header for the rules). Never throws. */
export function classifyDownloadUrl(url: unknown): DownloadVerdict {
  if (typeof url !== 'string' || url.length === 0) return { allowed: false, host: null, reason: 'it is empty' };
  if (url.length > MAX_URL) return { allowed: false, host: null, reason: 'it is too long to be a normal download link' };
  // C0 controls, space, DEL, C1 controls, backslash.
  if (/[\u0000- \u007f-\u009f\\]/.test(url)) {
    return { allowed: false, host: null, reason: 'it contains spaces, control characters or backslashes' };
  }
  const m = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/?#]*)(?:[/?#].*)?$/.exec(url);
  if (!m) return { allowed: false, host: null, reason: 'it is not a valid absolute URL' };
  const scheme = (m[1] ?? '').toLowerCase();
  const authority = m[2] ?? '';
  const at = authority.lastIndexOf('@');
  if (at >= 0) {
    const realHost = authority.slice(at + 1).toLowerCase() || null;
    return { allowed: false, host: realHost, reason: 'it contains user info before the host ("…@host"), which hides where it really points' };
  }
  if (authority.startsWith('[')) return { allowed: false, host: authority.toLowerCase(), reason: 'its host is an IP address' };
  const hp = /^([^:]*)(?::([^:]*))?$/.exec(authority);
  if (!hp) return { allowed: false, host: null, reason: 'it is not a valid absolute URL' };
  const host = (hp[1] ?? '').toLowerCase();
  const port = hp[2];
  if (host.length === 0) return { allowed: false, host: null, reason: 'it has no host' };
  if (scheme !== 'https') return { allowed: false, host, reason: `it uses ${scheme}, not https` };
  if (port !== undefined && port !== '' && port !== '443') return { allowed: false, host, reason: `it uses port ${port}` };
  if (!/^[a-z0-9.-]+$/.test(host)) {
    return { allowed: false, host, reason: 'its host contains non-ASCII or encoded characters (possibly a lookalike of an allowed host)' };
  }
  if (!ALLOWED.has(host)) return { allowed: false, host, reason: `${host} is not on Modrinth's allowlist` };
  return { allowed: true, host };
}

/** URLs are shown in full up to this length (evidence stays readable). */
const MAX_SHOWN = 300;

function shown(url: string): string {
  const flat = url.replace(/[\u0000-\u001f\u007f-\u009f]/g, '�');
  return flat.length > MAX_SHOWN ? `${flat.slice(0, MAX_SHOWN)}…` : flat;
}

type Bad = { url: string; verdict: Extract<DownloadVerdict, { allowed: false }> };

/** The URLs of `urls` outside the allowlist, with why. */
function badUrls(urls: readonly unknown[]): Bad[] {
  return urls.flatMap((url) => {
    const verdict = classifyDownloadUrl(url);
    return verdict.allowed ? [] : [{ url: typeof url === 'string' ? url : String(url), verdict }];
  });
}

/** " from <host>" when every bad URL names the same host, else "". */
function fromHost(bad: readonly Bad[]): string {
  const hosts = [...new Set(bad.flatMap((b) => (b.verdict.host ? [b.verdict.host] : [])))].sort();
  return hosts.length === 1 ? ` from ${hosts[0]}` : '';
}

function urlNotes(bad: readonly Bad[]): Evidence[] {
  return bad.map((b): Evidence => ({ kind: 'note', text: `Download URL ${shown(b.url)}: ${b.verdict.reason}.` }));
}

function findingFor(file: DeclaredFile, bad: Bad[], packNote: Evidence): Finding {
  const ref = declaredRef(file);
  const where = fromHost(bad);
  return makeFinding({
    code: 'W-MRPACK-DOWNLOAD',
    severity: 'warning',
    title: `${ref.fileName} downloads${where} outside Modrinth's allowed hosts`,
    explanation:
      `The .mrpack index lists ${plural(bad.length, 'download URL')} for ${file.path} that Modrinth would not accept ` +
      `(allowed: ${MRPACK_DOWNLOAD_HOSTS.join(', ')}, over https). A launcher installing this pack fetches the file from there, ` +
      `so it may come from an untrusted source, or the launcher may refuse the pack. Modpack Doctor never downloads it. ` +
      `Get the pack from its official page, or ask its author to host the file on Modrinth.`,
    culprits: [ref],
    evidence: [
      indexNote(file),
      ...urlNotes(bad),
      packNote,
    ],
    fixes: [],
    discriminator: 'declared',
  });
}

/** Longest entry name shown (Rust already caps it at 256 characters). */
const MAX_ENTRY = 256;

/** Control and invisible format characters (bidi controls, zero-width characters, BOM, …). */
const HIDDEN = /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff\ufff9-\ufffb]/g;

/** An entry name made safe to show: hidden characters removed, at most 256 characters. */
function entryLabel(entry: unknown): string {
  const clean = [...(typeof entry === 'string' ? entry : '').replace(HIDDEN, '')].slice(0, MAX_ENTRY).join('');
  return clean.length > 0 ? clean : 'an unnamed index entry';
}

function basename(path: string): string {
  const parts = path.split('/');
  return parts[parts.length - 1] || path;
}

/**
 * Index entries that are not declared files, each with its download links in order: Rust's
 * `unverifiedDownloads` grouped by entry, then declared entries shadowed by a later one with the
 * same path (Rust moves those into `unverifiedDownloads` itself; this covers any other producer).
 */
export function unverifiedEntries(input: CheckInput): { entry: string; urls: unknown[] }[] {
  const byEntry = new Map<string, unknown[]>();
  const add = (entry: unknown, urls: readonly unknown[]) => {
    const label = entryLabel(entry);
    byEntry.set(label, [...(byEntry.get(label) ?? []), ...urls]);
  };
  const unverified: unknown = input.scan.unverifiedDownloads;
  for (const u of Array.isArray(unverified) ? (unverified as unknown[]) : []) {
    if (u && typeof u === 'object') add((u as { entry?: unknown }).entry, [(u as { url?: unknown }).url]);
  }
  const winners = new Set(declaredFiles(input));
  for (const f of input.scan.declared ?? []) {
    if (!f || typeof f.path !== 'string' || f.path.length === 0 || winners.has(f)) continue;
    add(f.path, Array.isArray(f.downloads) ? f.downloads : []);
  }
  return [...byEntry].map(([entry, urls]) => ({ entry, urls }));
}

function unverifiedFinding(entry: string, bad: Bad[], packNote: Evidence): Finding {
  const ref: JarRef = { jarId: entry, fileName: basename(entry) };
  return makeFinding({
    code: 'W-MRPACK-DOWNLOAD',
    severity: 'warning',
    title: `Unchecked index entry ${ref.fileName} downloads${fromHost(bad)} outside Modrinth's allowed hosts`,
    explanation:
      `The .mrpack index lists ${plural(bad.length, 'download URL')} for the entry ${entry} that Modrinth would not accept ` +
      `(allowed: ${MRPACK_DOWNLOAD_HOSTS.join(', ')}, over https). Modpack Doctor did not check this entry's file: it was skipped ` +
      `(for example an invalid path or hash) or a later entry with the same path replaces it. A launcher may still install it and ` +
      `fetch it from there, so it may come from an untrusted source, or the launcher may refuse the pack. Modpack Doctor never ` +
      `downloads it. Get the pack from its official page, or ask its author to host the file on Modrinth.`,
    culprits: [ref],
    evidence: [
      {
        kind: 'note',
        text: `modrinth.index.json entry ${entry} was skipped or shadowed by a later entry with the same path, so its file was not checked; a launcher may still install it.`,
      },
      ...urlNotes(bad),
      packNote,
    ],
    fixes: [],
    discriminator: 'unverified',
  });
}

export const mrpackDownloadCheck: Check = {
  id: 'mrpack-download',
  codes: ['W-MRPACK-DOWNLOAD'],
  run(input) {
    const files = declaredFiles(input);
    const others = unverifiedEntries(input);
    if (files.length === 0 && others.length === 0) return [];
    const packNote = contextFor(input).packNote;
    const out: Finding[] = [];
    for (const file of files) {
      const bad = badUrls(Array.isArray(file.downloads) ? file.downloads : []);
      if (bad.length > 0) out.push(findingFor(file, bad, packNote));
    }
    for (const { entry, urls } of others) {
      const bad = badUrls(urls);
      if (bad.length > 0) out.push(unverifiedFinding(entry, bad, packNote));
    }
    return out;
  },
};
