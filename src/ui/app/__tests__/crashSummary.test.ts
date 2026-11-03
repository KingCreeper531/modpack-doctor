/** `summarizeCrash` (src/core/crash/summary.ts): the one-line verdict behind notifications. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { analyzeCrash, digestFromText } from '../../../core/crash';
import { HEADLINE_MAX, summarizeCrash } from '../../../core/crash/summary';
import type { Finding } from '../../../core/model';
import { buildJarIndex } from '../../../core/pack';
import { MOCK_INSTANCES, mockJars } from '../mockData';

const FIXTURES = join(__dirname, '..', '..', '..', '..', 'fixtures', 'logs');

function f(code: Finding['code'], severity: Finding['severity'], title: string, files: string[] = []): Finding {
  return {
    id: `${code}-${title}`,
    code,
    severity,
    title,
    explanation: '',
    culprits: files.map((fileName) => ({ jarId: `mods/${fileName}`, fileName })),
    evidence: [],
    fixes: [],
  };
}

describe('summarizeCrash', () => {
  it('is null without an error-severity crash finding', () => {
    expect(summarizeCrash([])).toBeNull();
    expect(summarizeCrash([f('C-SUSPECTED', 'warning', 'x'), f('C-MIXIN', 'info', 'y')])).toBeNull();
    // Static findings never make a crash notification.
    expect(summarizeCrash([f('E-DUP-ID', 'error', 'Two jars declare mod id jei')])).toBeNull();
  });

  it('uses the top-ranked error finding as the likely cause, with its culprit files', () => {
    const s = summarizeCrash([
      f('C-SUSPECTED', 'warning', 'not this'),
      f('C-MIXIN', 'error', 'Mixin failure in Iris (iris.mixins.json)', ['iris-1.8.jar', 'iris-1.8.jar', 'sodium.jar']),
      f('C-ROOT-CAUSE', 'error', 'later'),
    ]);
    expect(s).toEqual({
      headline: 'Modpack crashed — likely cause: Mixin failure in Iris (iris.mixins.json)',
      likelyCause: 'Mixin failure in Iris (iris.mixins.json)',
      culpritFiles: ['iris-1.8.jar', 'sodium.jar'],
    });
  });

  it(`keeps the headline to ${HEADLINE_MAX} characters on one line`, () => {
    const long = `${'A very long diagnosis '.repeat(12)}\nsecond line`;
    const s = summarizeCrash([f('C-NOCLASSDEF', 'error', long, ['a.jar'])])!;
    expect(s.headline.length).toBeLessThanOrEqual(HEADLINE_MAX);
    expect(s.headline).not.toContain('\n');
    expect(s.headline.endsWith('…')).toBe(true);
    expect(s.likelyCause).not.toContain('\n');
  });

  it('has no likely cause when only an unattributed root cause was found', () => {
    const s = summarizeCrash([f('C-ROOT-CAUSE', 'error', 'NullPointerException: x is null')])!;
    expect(s.likelyCause).toBeNull();
    expect(s.headline).toBe('Modpack crashed — NullPointerException: x is null');
    expect(summarizeCrash([f('C-ROOT-CAUSE', 'error', 'NPE (in pipeworks)', ['pipeworks.jar'])])!.likelyCause).toBe('NPE (in pipeworks)');
  });

  it('summarises a real crash report mapped to the mock jars', () => {
    const text = readFileSync(join(FIXTURES, 'forge', 'fg20-mixin-transformer-error.txt'), 'utf8');
    const jars = mockJars(MOCK_INSTANCES[0]!.id);
    const index = buildJarIndex({ instanceId: 'x', startedAtMs: 0, durationMs: 0, jars, declared: [], issues: [] });
    const digest = digestFromText(text, { id: 'crash-reports/crash.txt', kind: 'crashReport', modifiedMs: 0, size: 0 });
    const s = summarizeCrash(analyzeCrash({ digest, index }))!;
    expect(s.headline.startsWith('Modpack crashed — likely cause: ')).toBe(true);
    expect(s.likelyCause).toMatch(/Emberforge|emberforge/);
    expect(s.culpritFiles).toEqual(['emberforge-1.20.1-2.4.0.jar']);
  });

  it('returns null for a clean session log', () => {
    const text = readFileSync(join(FIXTURES, 'forge', 'fg20-clean-benign-cnfe-long.log'), 'utf8');
    const digest = digestFromText(text, { id: 'logs/latest.log', kind: 'latestLog', modifiedMs: 0, size: 0 });
    expect(summarizeCrash(analyzeCrash({ digest }))).toBeNull();
  });
});

describe('logPath', () => {
  it('shows @cwd ids as the launcher folder and leaves game-dir ids alone', async () => {
    const { logPath } = await import('../../components/format');
    const { sourceDir, sourceName } = await import('../crashState');
    expect(logPath('@cwd/hs_err_pid4242.log')).toBe('launcher folder/hs_err_pid4242.log');
    expect(logPath('crash-reports/crash-x-client.txt')).toBe('crash-reports/crash-x-client.txt');
    expect(sourceDir('@cwd/hs_err_pid4242.log')).toBe('launcher folder/');
    expect(sourceName('@cwd/hs_err_pid4242.log')).toBe('hs_err_pid4242.log');
  });
});
