/** 32-bit FNV-1a over the string's UTF-16 code units (low byte, then high byte when non-zero). */
export function fnv1a32(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h ^= c & 0xff;
    h = Math.imul(h, 0x01000193);
    if (c > 0xff) {
      h ^= c >>> 8;
      h = Math.imul(h, 0x01000193);
    }
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/**
 * Stable finding id: code + sorted, de-duplicated culprit jar ids + a discriminator (mixin
 * config, package, missing mod id…). Never includes line numbers, so it survives rescans.
 */
export function findingId(code: string, jarIds: readonly string[], discriminator: string): string {
  const ids = [...new Set(jarIds)].sort();
  return `${code}:${fnv1a32(`${code}\u0000${ids.join('\u0001')}\u0000${discriminator}`)}`;
}
