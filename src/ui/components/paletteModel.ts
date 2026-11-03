/** Command palette match marking (DESIGN.md §6.7: matched characters `fg`, the rest `fg-dim`). */

/**
 * Greedy case-insensitive subsequence match. Returns one flag per character of `label`, or null
 * when `query` is not a subsequence. An empty query matches with nothing marked.
 */
export function matchMask(label: string, query: string): boolean[] | null {
  const mask = new Array<boolean>(label.length).fill(false);
  const q = query.trim().toLowerCase();
  if (!q) return mask;
  const l = label.toLowerCase();
  // Prefer a contiguous hit so `sod` marks the start of `sodium`, not scattered letters.
  const at = l.indexOf(q);
  if (at >= 0) {
    for (let i = at; i < at + q.length; i++) mask[i] = true;
    return mask;
  }
  let qi = 0;
  for (let i = 0; i < l.length && qi < q.length; i++) {
    if (l[i] === q[qi]) {
      mask[i] = true;
      qi++;
    }
  }
  return qi === q.length ? mask : null;
}

/** Splits `label` into runs of matched / unmatched characters for rendering. */
export function matchRuns(label: string, mask: readonly boolean[]): Array<{ text: string; hit: boolean }> {
  const runs: Array<{ text: string; hit: boolean }> = [];
  for (let i = 0; i < label.length; i++) {
    const hit = mask[i] ?? false;
    const last = runs[runs.length - 1];
    if (last && last.hit === hit) last.text += label[i];
    else runs.push({ text: label[i] ?? '', hit });
  }
  return runs;
}
