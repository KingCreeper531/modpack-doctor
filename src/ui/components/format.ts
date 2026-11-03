/** Number, size and time formatting shared by the components. Pure. */

const int = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

/** `1204` → `1,204`. */
export function formatInt(n: number): string {
  return int.format(n);
}

/** `312 KB`, `4.2 MB` (binary units, as file managers on Windows show them). */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${Math.round(kb)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
  return `${(mb / 1024).toFixed(1)} GB`;
}

/** `2.1s ago`, `14s ago`, `3m ago`, `2h ago`, `5d ago`. */
export function formatAgo(elapsedMs: number): string {
  const s = Math.max(0, elapsedMs) / 1000;
  if (s < 10) return `${s.toFixed(1)}s ago`;
  if (s < 60) return `${Math.floor(s)}s ago`;
  const m = s / 60;
  if (m < 60) return `${Math.floor(m)}m ago`;
  const h = m / 60;
  if (h < 24) return `${Math.floor(h)}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/** Scan / op durations: `840ms`, `2.1s`, `1m 04s`. */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${String(Math.floor(s % 60)).padStart(2, '0')}s`;
}

/** `plural(1, 'error')` → `1 error`; `plural(3, 'error')` → `3 errors`. */
export function plural(n: number, word: string, many = `${word}s`): string {
  return `${formatInt(n)} ${n === 1 ? word : many}`;
}

/** Last `/`-separated segment (jar ids and relative paths always use `/`). */
export function basename(path: string): string {
  const nested = path.lastIndexOf('!/');
  const tail = nested >= 0 ? path.slice(nested + 2) : path;
  const i = tail.lastIndexOf('/');
  return (i >= 0 ? tail.slice(i + 1) : tail).replace(/#disabled$/, '');
}

/** Host of an absolute URL, or the input when it does not parse. */
export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** Two-digit op number for work-order rows: `01`, `02`, … `10`. */
export function opNumber(index: number): string {
  return String(index + 1).padStart(2, '0');
}

/**
 * A log source id as shown to people: `@cwd/…` ids (a JVM crash log in the launcher's working
 * folder, CONTRACTS invariant 5) read as `launcher folder/…`; game-dir ids are shown as they are.
 */
export function logPath(id: string): string {
  return id.startsWith('@cwd/') ? `launcher folder/${id.slice('@cwd/'.length)}` : id;
}
