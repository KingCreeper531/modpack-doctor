/**
 * W-MRPACK-DOWNLOAD (warning, CONTRACTS invariant 15): a file declared by a `.mrpack` index
 * (`ScanResult.declared`) lists a download URL outside Modrinth's allowlist. One finding per
 * declared file with at least one such URL; every offending URL is a `note` in the evidence. Works
 * offline (no Modrinth data needed). No fixes: packs are read-only and nothing is ever downloaded.
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
import type { Check, Evidence, Finding } from '../model';
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

function findingFor(file: DeclaredFile, bad: { url: string; verdict: Extract<DownloadVerdict, { allowed: false }> }[], packNote: Evidence): Finding {
  const ref = declaredRef(file);
  const hosts = [...new Set(bad.flatMap((b) => (b.verdict.host ? [b.verdict.host] : [])))].sort();
  const where = hosts.length === 1 ? ` from ${hosts[0]}` : '';
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
      ...bad.map((b): Evidence => ({ kind: 'note', text: `Download URL ${shown(b.url)}: ${b.verdict.reason}.` })),
      packNote,
    ],
    fixes: [],
    discriminator: 'declared',
  });
}

export const mrpackDownloadCheck: Check = {
  id: 'mrpack-download',
  codes: ['W-MRPACK-DOWNLOAD'],
  run(input) {
    const files = declaredFiles(input);
    if (files.length === 0) return [];
    const packNote = contextFor(input).packNote;
    const out: Finding[] = [];
    for (const file of files) {
      const urls = Array.isArray(file.downloads) ? file.downloads : [];
      const bad = urls.flatMap((url) => {
        const verdict = classifyDownloadUrl(url);
        return verdict.allowed ? [] : [{ url: typeof url === 'string' ? url : String(url), verdict }];
      });
      if (bad.length > 0) out.push(findingFor(file, bad, packNote));
    }
    return out;
  },
};
