/**
 * Design gate (DESIGN.md §11–§12). Grep-level checks that the banned look can't creep in:
 * runs over every .ts/.tsx/.css file under src/ui, src/styles and src/main.tsx (presentation
 * code; src/core has no styling). tokens.css is the only file allowed raw hex.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(__dirname, '..', '..');

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return name === '__tests__' || name === 'node_modules' ? [] : files(p);
    return /\.(ts|tsx|css)$/.test(name) && name !== 'bindings.ts' ? [p] : [];
  });
}

const SCANNED = [...files(join(SRC, 'ui')), ...files(join(SRC, 'styles')), join(SRC, 'main.tsx')];

const BANNED: Array<[RegExp, string]> = [
  [/\brounded-(?!1\b|2\b|none\b)[\w[\]-]+/, 'radius above 4px (use rounded-1 / rounded-2)'],
  [/\b(bg|from|via|to)-(linear|radial|conic|gradient)/, 'gradient utility'],
  [/(linear|radial|conic)-gradient\(/, 'CSS gradient'],
  [/\bbackdrop-|backdrop-filter/, 'backdrop blur / frosted glass'],
  [/\bblur(-|\()/, 'blur'],
  [/\banimate-/, 'animation utility (motion is token-driven transitions only)'],
  [/\bshadow-(?!overlay\b)[\w[\]-]+/, 'shadow other than shadow-overlay'],
  [/\btext-shadow|drop-shadow/, 'glow / drop shadow'],
  [/lucide/i, 'Lucide icons'],
  [/['"]Inter['"]|\bGeist\b|font-family:\s*system-ui/, 'banned font'],
  [/\b(?:[pm][trblxy]?|gap(?:-[xy])?|space-[xy])-(?:\d+\.\d+|[3579]|1[13579])\b/, 'spacing off the 8px grid'],
  // Emoji_Presentation (not Extended_Pictographic): arrows like ↔ and ↵ are typographic glyphs.
  [/✨|\p{Emoji_Presentation}|️/u, 'emoji / sparkle'],
];

describe('design lint', () => {
  for (const file of SCANNED) {
    const rel = relative(SRC, file).split(sep).join('/');
    const src = readFileSync(file, 'utf8');
    // tailwind.css names the defaults it wipes (`--animate-*: initial`), so it is exempt.
    if (rel !== 'styles/tailwind.css') {
      it(`${rel}: no banned styles`, () => {
        for (const [re, why] of BANNED) {
          expect(src, `${why} in ${rel}`).not.toMatch(re);
        }
      });
    }
    if (rel !== 'styles/tokens.css') {
      it(`${rel}: no raw hex colours`, () => {
        expect(src).not.toMatch(/#[0-9a-fA-F]{3,8}\b(?![-\w])/);
      });
    }
  }
});
