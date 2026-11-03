import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const CORE = join(__dirname, '..');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return name === '__tests__' ? [] : sourceFiles(p);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [p] : [];
  });
}

/** Remove comments and string/template literal bodies so prose like "any version" can't match. */
function codeOnly(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '')
    .replace(/`(?:\\[\s\S]|[^`\\])*`/g, '``')
    .replace(/'(?:\\.|[^'\\\n])*'/g, "''")
    .replace(/"(?:\\.|[^"\\\n])*"/g, '""');
}

describe('src/core purity', () => {
  const files = sourceFiles(CORE);

  it('has source files to check', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const file of files) {
    const rel = relative(CORE, file);
    const src = readFileSync(file, 'utf8');
    const code = codeOnly(src);

    it(`${rel}: no Tauri, React, Node or DOM dependencies`, () => {
      // Any import form: `from '…'`, side-effect `import '…'`, dynamic `import('…')`, require.
      const spec = /(?:from\s+|import\s*\(?\s*|require\s*\(\s*)['"]([^'"]+)['"]/g;
      for (const m of src.matchAll(spec)) {
        const mod = m[1] ?? '';
        expect(mod, `forbidden import ${mod}`).not.toMatch(/^(@tauri-apps\/|react($|\/|-dom)|node:|fs$|path$|os$)/);
      }
      expect(code).not.toMatch(/\b(window|document|localStorage|sessionStorage|navigator|globalThis\.fetch)\b/);
      expect(code).not.toMatch(/\bfetch\s*\(/);
    });

    it(`${rel}: only type imports from bindings`, () => {
      const valueImport = /^import\s+(?!type\b)[^;]*from\s+['"][./]*\/?bindings['"]/m;
      expect(src).not.toMatch(valueImport);
      expect(src).not.toMatch(/import\s*\(\s*['"][./]*\/?bindings['"]/);
    });

    it(`${rel}: no explicit any`, () => {
      expect(code).not.toMatch(/\bany\b/);
    });
  }
});
