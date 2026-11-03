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
  [/font-family:[^;}]*\bInter\b|fontFamily:\s*['"`][^'"`]*\b(?:Inter|Geist|system-ui)\b/, 'banned font'],
  [/\b(?:[pm][trblxyse]?|gap(?:-[xy])?|space-[xy]|inset(?:-[xy])?|top|right|bottom|left)-(?:\d+\.\d+|[3579]|1[13579])\b/, 'spacing off the 8px grid'],
  [/\bring-[\w[]/, 'ring utility (box-shadow glow); focus uses the global outline'],
  [/\btransition-all\b/, 'transition-all (animate only the property that changes)'],
  [/\bduration-(?:18[1-9]|19\d|[2-9]\d\d|\d{4,})\b/, 'duration above 180ms'],
  [/\btext-\[(?:19|[2-9]\d|\d{3,})px\]/, 'text larger than 18px'],
  [/\b(?:borderRadius|boxShadow)\s*:/, 'inline radius / shadow style'],
  [/(?:^|[;{\s])(?:box-shadow|border-radius)\s*:/m, 'raw box-shadow / border-radius in CSS'],
  // Emoji_Presentation (not Extended_Pictographic): arrows like ↔ and ↵ are typographic glyphs.
  [/✨|\p{Emoji_Presentation}|️/u, 'emoji / sparkle'],
];

/**
 * Arbitrary spacing values (`pl-[14px]`) are pixel geometry inside a component (e.g. 16px minus a
 * 2px rule, a thumb inset 2px in its track); they must at least sit on the 2px hairline grid.
 * Layout spacing uses the 8px scale (BANNED above).
 */
function offGridArbitrary(src: string): string[] {
  const re = /\b(?:[pm][trblxyse]?|gap(?:-[xy])?|space-[xy]|inset(?:-[xy])?|top|right|bottom|left)-\[(-?\d+(?:\.\d+)?)px\]/g;
  return [...src.matchAll(re)].filter((m) => Number(m[1]) % 2 !== 0).map((m) => m[0]);
}

describe('design lint rules catch what they claim to', () => {
  const caught = (s: string) => BANNED.some(([re]) => re.test(s)) || offGridArbitrary(s).length > 0;
  const bad = [
    'rounded-xl', 'rounded-full', 'bg-linear-to-r', 'backdrop-blur', 'animate-bounce', 'shadow-lg',
    'drop-shadow-md', 'ring-2', 'ring-[3px]', 'transition-all', 'duration-500', 'text-[24px]', 'p-5',
    'ps-3', 'gap-1.5', 'p-[13px]', 'style={{ borderRadius: 8 }}', 'a { box-shadow: 0 0 4px red }',
    "fontFamily: 'Inter, sans-serif'", 'font-family: system-ui', '✨', '🔧', "from 'lucide-react'",
  ];
  const good = [
    'rounded-1', 'rounded-2', 'shadow-overlay', 'duration-160', 'text-[18px]', 'p-2', 'p-1', 'pl-[14px]',
    'top-[2px]', 'string-length', 'focus ring offset', '↵', '→', '⋯', 'transition-colors',
  ];
  for (const s of bad) it(`flags ${s}`, () => expect(caught(s)).toBe(true));
  for (const s of good) it(`allows ${s}`, () => expect(caught(s)).toBe(false));
});

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
        expect(offGridArbitrary(src), `arbitrary spacing off the 2px grid in ${rel}`).toEqual([]);
      });
    }
    if (rel !== 'styles/tokens.css') {
      it(`${rel}: no raw colours outside tokens.css`, () => {
        expect(src).not.toMatch(/#[0-9a-fA-F]{3,8}\b(?![-\w])/);
        // Literal colour values only; colours computed from parsed tokens (`rgba(${…})`) are fine.
        expect(src).not.toMatch(/\b(?:rgba?|hsla?|oklch|oklab|lab|lch)\(\s*[\d.]|\bcolor-mix\(/);
      });
    }
  }
});
