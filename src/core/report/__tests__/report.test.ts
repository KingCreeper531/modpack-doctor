/**
 * Report export (CONTRACTS invariant 16): structure, `~` for the home folder everywhere,
 * determinism, JSON round trip and key order, Markdown escaping, fix labels, file name.
 */
import { describe, expect, it } from 'vitest';
import type { DeclaredFile } from '../../../bindings';
import { fabric, instance, modrinth, mrProject, mrVersion, scan } from '../../checks/__tests__/fixtures';
import type { Finding } from '../../model';
import { buildReport, NON_AFFILIATION, REPORT_SCHEMA_VERSION, reportFileName, reportJson, reportMarkdown, type ReportDoc, type ReportInput } from '../index';
import { homeScrubber, mdCode, mdInline, mdText } from '../text';

const GAME_DIR = 'C:\\Users\\Bob\\AppData\\Roaming\\PrismLauncher\\instances\\All the Mods\\minecraft';

const sodium = fabric({ file: 'sodium-0.5.8.jar', mods: [{ id: 'sodium', name: 'Sodium', version: '0.5.8' }] });
const extra = fabric({ file: 'sodium-extra.jar', mods: [{ id: 'sodium-extra' }] });
const old = fabric({ file: 'old.jar', mods: [{ id: 'old' }], disabled: true });
const pack = { mcVersion: '1.20.1', loader: { kind: 'fabric' as const, version: '0.16.5' }, side: 'client' as const, source: 'launcher' as const };

const missingDep: Finding = {
  id: 'E-MISSING-DEP:00000001',
  code: 'E-MISSING-DEP',
  severity: 'error',
  title: 'Sodium Extra requires "reeses-sodium-options", which is not installed',
  explanation: 'Sodium Extra lists "reeses-sodium-options" as a required dependency. Logs are in C:\\Users\\Bob\\AppData\\Roaming.',
  culprits: [{ jarId: extra.id, fileName: extra.fileName, modId: 'sodium-extra' }],
  evidence: [
    {
      kind: 'metadata',
      jarId: extra.id,
      file: 'fabric.mod.json',
      excerpt: ['{', '  "id": "sodium-extra",', '  "depends": {', '    "reeses-sodium-options": "*"', '  },', '  "x": 1,', '  "y": 2,', '  "z": 3', '}'].join('\n'),
      highlight: [4],
    },
    { kind: 'note', text: 'Pack: Fabric 0.16.5 on Minecraft 1.20.1 (from launcher metadata)' },
  ],
  fixes: [
    { kind: 'installDependency', modId: 'reeses-sodium-options', versionId: 'RSO-VER' },
    { kind: 'manual', steps: ['Install the mod with id "reeses-sodium-options".', 'Or disable sodium-extra.jar.'] },
  ],
  missingModIds: ['reeses-sodium-options'],
};

const tricky: Finding = {
  id: 'W-CORRUPT-JAR:00000002',
  code: 'W-CORRUPT-JAR',
  severity: 'warning',
  title: 'Weird | name `with` backticks *and* _stars_',
  explanation: '# not a heading',
  culprits: [{ jarId: sodium.id, fileName: sodium.fileName }],
  evidence: [{ kind: 'note', text: 'contains ``` a fence\nand /home/bob/.minecraft and C:/USERS/BOB/x and c:\\\\users\\\\bob\\\\y and C:\\Users\\Bobby\\z' }],
  fixes: [
    { kind: 'disable', jarId: sodium.id },
    { kind: 'replace', jarId: sodium.id, versionId: 'SODIUM-NEW' },
    { kind: 'replace', jarId: sodium.id, versionId: 'UNKNOWN-VER' },
    { kind: 'enable', jarId: old.id },
    { kind: 'removeDuplicate', keep: sodium.id, remove: extra.id },
    { kind: 'installDependency', modId: 'cloth-config', versionId: 'CLOTH-VER' },
  ],
};

const info: Finding = {
  id: 'I-NOT-ON-MODRINTH:x',
  code: 'I-NOT-ON-MODRINTH',
  severity: 'info',
  title: 'Not on Modrinth (possibly CurseForge or manual)',
  explanation: 'One jar.',
  culprits: [{ jarId: 'mods/declared.jar', fileName: 'declared.jar' }],
  evidence: [],
  fixes: [],
};

const crash: Finding = {
  id: 'C-MIXIN:1',
  code: 'C-MIXIN',
  severity: 'error',
  title: 'Mixin apply failed in sodium',
  explanation: 'A mixin failed.',
  culprits: [{ jarId: sodium.id, fileName: sodium.fileName, modId: 'sodium' }],
  evidence: [
    {
      kind: 'log',
      source: 'crash-reports/crash-2026-11-07_12.00.00-client.txt',
      lines: [
        { n: 12, text: 'at C:\\Users\\Bob\\AppData\\x.Main', role: 'context' },
        { n: 10, text: 'Mixin apply failed', role: 'culprit' },
        { n: 11, text: 'Caused by: x', role: 'context' },
      ],
      frames: [],
    },
  ],
  fixes: [],
};

const declaredFile: DeclaredFile = { path: 'mods/declared.jar', sha1: 'd'.repeat(40), sha512: '0'.repeat(128), size: 1, client: 'required', server: 'required', downloads: [] };

function input(over: Partial<ReportInput> = {}): ReportInput {
  const sodiumVer = mrVersion({ id: 'SODIUM-OLD', projectId: 'AANobbMI', versionNumber: '0.5.8' });
  const sodiumNew = mrVersion({ id: 'SODIUM-NEW', projectId: 'AANobbMI', versionNumber: '0.5.11', datePublished: '2030-01-01T00:00:00Z' });
  const sodiumWithDate = { ...sodiumVer, datePublished: '2024-01-01T00:00:00Z' };
  return {
    instance: instance({ name: 'All the Mods', launcher: 'prism', root: GAME_DIR, gameDir: GAME_DIR, loader: pack.loader, mcVersion: '1.20.1' }),
    pack,
    scan: { ...scan(sodium, extra, old), declared: [declaredFile], issues: [{ subject: 'mods/x', message: 'unreadable' }], durationMs: 1234 },
    findings: [missingDep, tricky, info],
    crashes: { 'logs/latest.log': [], 'crash-reports/crash-2026-11-07_12.00.00-client.txt': [crash] },
    modrinth: modrinth({
      versions: { [sodium.sha1]: sodiumWithDate },
      updates: { [sodium.sha1]: sodiumNew },
      projects: { AANobbMI: mrProject({ id: 'AANobbMI', title: 'Sodium' }) },
      failed: [extra.sha1],
    }),
    appVersion: '0.1.0',
    generatedAtMs: Date.UTC(2026, 10, 7, 12, 34, 56),
    homeDir: 'c:/users/bob/',
    ...over,
  };
}

describe('buildReport', () => {
  const doc = buildReport(input());

  it('summarises instance, pack, scan, counts (static + crash) and Modrinth', () => {
    expect(doc.schemaVersion).toBe(REPORT_SCHEMA_VERSION);
    expect(doc.app).toEqual({ name: 'Modpack Doctor', version: '0.1.0' });
    expect(doc.generatedAt).toBe('2026-11-07T12:34:56.000Z');
    expect(doc.instance).toEqual({
      name: 'All the Mods',
      launcher: 'prism',
      gameDir: '~\\AppData\\Roaming\\PrismLauncher\\instances\\All the Mods\\minecraft',
      mcVersion: '1.20.1',
      loader: 'Fabric 0.16.5',
      side: 'client',
    });
    expect(doc.pack).toEqual({ mcVersion: '1.20.1', loader: 'Fabric 0.16.5', source: 'launcher' });
    expect(doc.scan).toEqual({ jars: 3, topLevel: 3, disabled: 1, issues: 1, durationMs: 1234 });
    expect(doc.counts).toEqual({ error: 2, warning: 1, info: 1 });
    // sodium: update; sodium-extra: failed → unknown; old.jar: missing; declared.jar: missing.
    expect(doc.modrinth).toEqual({ identified: 1, updates: 1, notOnModrinth: 2, unknown: 1 });
    expect(buildReport(input({ modrinth: null })).modrinth).toBeNull();
  });

  it('keeps finding order, renders culprits as relative paths, evidence as text and fixes as labels', () => {
    expect(doc.findings.map((f) => f.code)).toEqual(['E-MISSING-DEP', 'W-CORRUPT-JAR', 'I-NOT-ON-MODRINTH']);
    const [dep, weird, notOn] = doc.findings;
    expect(dep?.culprits).toEqual(['mods/sodium-extra.jar (sodium-extra)']);
    expect(notOn?.culprits).toEqual(['mods/declared.jar (.mrpack index)']);
    expect(dep?.evidence[0]).toBe(
      ['mods/sodium-extra.jar!/fabric.mod.json', '  2 |   "id": "sodium-extra",', '  3 |   "depends": {', '> 4 |     "reeses-sodium-options": "*"', '  5 |   },', '  6 |   "x": 1,', '  …'].join('\n'),
    );
    expect(dep?.evidence[1]).toBe('Pack: Fabric 0.16.5 on Minecraft 1.20.1 (from launcher metadata)');
    expect(dep?.fixes).toEqual(['Install reeses-sodium-options (version RSO-VER)', 'Manual: Install the mod with id "reeses-sodium-options". Or disable sodium-extra.jar.']);
    expect(weird?.fixes).toEqual([
      'Disable sodium-0.5.8.jar',
      'Replace sodium-0.5.8.jar with Sodium 0.5.11',
      'Replace sodium-0.5.8.jar with version UNKNOWN-VER',
      'Enable old.jar.disabled',
      'Remove sodium-extra.jar (moved to a backup), keep sodium-0.5.8.jar',
      'Install cloth-config (version CLOTH-VER)',
    ]);
  });

  it('crash sections are sorted by source; log lines numbered with the culprit marked', () => {
    expect(doc.crashes.map((c) => c.source)).toEqual(['crash-reports/crash-2026-11-07_12.00.00-client.txt', 'logs/latest.log']);
    expect(doc.crashes[0]?.findings[0]?.evidence[0]).toBe(
      ['crash-reports/crash-2026-11-07_12.00.00-client.txt', '> 10 | Mixin apply failed', '  11 | Caused by: x', '  12 | at ~\\AppData\\x.Main'].join('\n'),
    );
  });

  it('replaces the home folder with ~ everywhere (either separator, any case, escaped), but not a longer folder name', () => {
    const json = reportJson(doc);
    const md = reportMarkdown(doc);
    for (const text of [json, md]) {
      expect(text).not.toMatch(/users[\\/]+bob(?!by)/i);
      expect(text).toContain('Bobby');
    }
    const note = doc.findings[1]?.evidence[0] ?? '';
    expect(note).toContain('/home/bob/.minecraft'); // another user's home is not ours
    expect(note).toContain('~/x');
    expect(note).toContain('~\\\\y');
    expect(note).toContain('C:\\Users\\Bobby\\z');
    expect(doc.findings[0]?.explanation).toContain('Logs are in ~\\AppData\\Roaming.');
  });

  it('is deterministic', () => {
    const again = buildReport(input());
    expect(again).toEqual(doc);
    expect(reportJson(again)).toBe(reportJson(doc));
    expect(reportMarkdown(again)).toBe(reportMarkdown(doc));
  });

  it('no home → nothing replaced', () => {
    expect(buildReport(input({ homeDir: '' })).instance.gameDir).toBe(GAME_DIR);
    expect(buildReport(input({ homeDir: 'C:\\' })).instance.gameDir).toBe(GAME_DIR);
  });
});

describe('homeScrubber', () => {
  it.each<[string, string, string]>([
    ['C:\\Users\\Bob', 'C:\\Users\\Bob\\mods', '~\\mods'],
    ['C:\\Users\\Bob', 'c:\\users\\bob\\mods', '~\\mods'],
    ['C:\\Users\\Bob', 'C:/Users/Bob/mods', '~/mods'],
    ['C:\\Users\\Bob', 'file:///C:/Users/Bob/x', 'file:///~/x'],
    ['C:\\Users\\Bob', 'C:\\\\Users\\\\Bob\\\\x', '~\\\\x'],
    ['C:\\Users\\Bob', 'end C:\\Users\\Bob.', 'end ~.'],
    ['C:\\Users\\Bob', 'C:\\Users\\Bobby\\x', 'C:\\Users\\Bobby\\x'],
    ['C:\\Users\\Bob', 'C:\\Users\\Bob-old\\x', 'C:\\Users\\Bob-old\\x'],
    ['/home/bob/', '/home/bob/.minecraft and /home/bob', '~/.minecraft and ~'],
    ['/home/bob', '/home/bobby', '/home/bobby'],
    ['C:\\Users\\Bob Smith', 'file:///C:/Users/Bob%20Smith/x and C:\\Users\\Bob Smith\\y', 'file:///~/x and ~\\y'],
    ['/Users/a.b (x)', '/Users/a.b (x)/y and /Users/aXb (x)/y', '~/y and /Users/aXb (x)/y'],
    ['/', '/home/bob', '/home/bob'],
    ['', 'C:\\Users\\Bob', 'C:\\Users\\Bob'],
  ])('home %j: %j → %j', (home, text, expected) => {
    expect(homeScrubber(home)(text)).toBe(expected);
  });
});

describe('reportJson', () => {
  const doc = buildReport(input());

  it('round-trips through JSON.parse', () => {
    const parsed = JSON.parse(reportJson(doc)) as ReportDoc;
    expect(parsed).toEqual(doc);
    expect(reportJson(parsed)).toBe(reportJson(doc));
  });

  it('has a stable key order whatever order the object was built in', () => {
    const keys = Object.keys(JSON.parse(reportJson(doc)) as object);
    expect(keys).toEqual(['schemaVersion', 'app', 'generatedAt', 'instance', 'pack', 'scan', 'counts', 'findings', 'crashes', 'modrinth']);
    const shuffled = Object.fromEntries(Object.entries(doc).reverse()) as unknown as ReportDoc;
    const reversedFinding = { ...shuffled, findings: doc.findings.map((f) => Object.fromEntries(Object.entries(f).reverse())) } as unknown as ReportDoc;
    expect(reportJson(reversedFinding)).toBe(reportJson(doc));
    expect(reportJson(doc).endsWith('}\n')).toBe(true);
    expect(reportJson(doc)).toContain('\n  "schemaVersion": 1,\n');
  });
});

describe('reportMarkdown', () => {
  const doc = buildReport(input());
  const md = reportMarkdown(doc);

  it('has a summary table, findings by severity, crash sections, Modrinth and the footer', () => {
    expect(md.startsWith('# Modpack Doctor report: All the Mods\n')).toBe(true);
    expect(md).toContain('| | |\n|---|---|\n| Instance | All the Mods |');
    expect(md).toContain('| Game folder | `~\\AppData\\Roaming\\PrismLauncher\\instances\\All the Mods\\minecraft` |');
    expect(md).toContain('| Errors | 2 |');
    const order = ['## Summary', '## Findings', '### Errors (1)', '### Warnings (1)', '### Info (1)', '## Crash analysis', '### `crash-reports/', '#### Errors (1)', '##### `C-MIXIN`', '### `logs/latest.log`', '## Modrinth'];
    let at = -1;
    for (const marker of order) {
      const next = md.indexOf(marker, at + 1);
      expect(next, marker).toBeGreaterThan(at);
      at = next;
    }
    expect(md).toContain('| Identified | Updates available | Not on Modrinth | Unknown |\n|---|---|---|---|\n| 1 | 1 | 2 | 1 |');
    expect(md).toContain('**Culprits:** `mods/sodium-extra.jar (sodium-extra)`');
    expect(md).toContain('1. Install reeses-sodium-options (version RSO-VER)\n2. Manual: Install the mod with id "reeses-sodium-options".');
    expect(md.trimEnd().endsWith(`---\n\nGenerated by Modpack Doctor 0.1.0\n\n${NON_AFFILIATION}`)).toBe(true);
    expect(NON_AFFILIATION).toBe('Not affiliated with or endorsed by Modrinth, Mojang, Microsoft, Forge, NeoForge, Fabric, or Quilt.');
  });

  it('escapes | and backticks (and other markup) in titles; explanations cannot become headings', () => {
    expect(md).toContain('#### `W-CORRUPT-JAR` Weird \\| name \\`with\\` backticks \\*and\\* \\_stars\\_\n');
    expect(md).toContain('\n\\# not a heading\n');
  });

  it('evidence goes in fenced blocks, with a longer fence when the text contains one', () => {
    expect(md).toContain('```text\nmods/sodium-extra.jar!/fabric.mod.json\n');
    expect(md).toContain('````text\ncontains ``` a fence\n');
    expect(md).toContain('\n````\n');
  });

  it('a pack without findings, crashes or Modrinth', () => {
    const empty = reportMarkdown(buildReport(input({ findings: [], crashes: {}, modrinth: null, pack: { ...pack, loader: null, source: 'launcher' } })));
    expect(empty).toContain('No problems found by the static checks.');
    expect(empty).not.toContain('## Crash analysis');
    expect(empty).toContain('Modrinth was not consulted');
    expect(empty).toContain('| Loader | none (vanilla) |');
  });
});

describe('markdown helpers', () => {
  it.each<[string, string]>([
    ['a | b', 'a \\| b'],
    ['`x`', '\\`x\\`'],
    ['line\nbreak', 'line break'],
    ['- list', '\\- list'],
    ['1. one', '1\\. one'],
    ['<script>', '\\<script\\>'],
    ['a & b', 'a &amp; b'],
    ['[link](x)', '\\[link\\](x)'],
    ['Use C#', 'Use C\\#'],
  ])('mdText(%j) = %j', (text, expected) => {
    expect(mdText(text)).toBe(expected);
  });

  it('mdInline leaves block markers alone (mid-line text)', () => {
    expect(mdInline('0.1.0')).toBe('0.1.0');
    expect(mdInline('- x | y')).toBe('- x \\| y');
  });

  it.each<[string, string]>([
    ['plain', '`plain`'],
    ['a`b', '``a`b``'],
    ['`start', '`` `start ``'],
  ])('mdCode(%j) = %j', (text, expected) => {
    expect(mdCode(text)).toBe(expected);
  });
});

describe('reportFileName', () => {
  const base = buildReport(input());
  it.each<[string, string]>([
    ['All the Mods', 'modpack-doctor-all-the-mods-2026-11-07'],
    ['Cobblemon Official Modpack 1.5.2', 'modpack-doctor-cobblemon-official-modpack-1-5-2-2026-11-07'],
    ['Pokémon  Café!!', 'modpack-doctor-pokemon-cafe-2026-11-07'],
    ['../../etc/passwd', 'modpack-doctor-etc-passwd-2026-11-07'],
    ['CON', 'modpack-doctor-con-2026-11-07'],
    ['日本語', 'modpack-doctor-instance-2026-11-07'],
    ['', 'modpack-doctor-instance-2026-11-07'],
    ['x'.repeat(100), `modpack-doctor-${'x'.repeat(48)}-2026-11-07`],
  ])('%j → %j', (name, expected) => {
    expect(reportFileName({ ...base, instance: { ...base.instance, name } })).toBe(expected);
  });
});
