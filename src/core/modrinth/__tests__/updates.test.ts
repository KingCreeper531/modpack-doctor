/**
 * M5 review: no downgrades (CONTRACTS invariant 8 — an update must be published after the
 * identified version, missing dates → not offered), the beta fallback for users on a pre-release
 * newer than the last release, `ModrinthContext.updateStatus`, the "sole file counts dropped
 * files" rule, and Quilt accepting Fabric updates.
 */
import { describe, expect, it } from 'vitest';
import type { FixAction, HashLookup, MrFile, MrVersion } from '../../../bindings';
import { fabric, pack, quilt, scan } from '../../checks/__tests__/fixtures';
import type { Finding, FindingCode, ModrinthContext } from '../../model';
import { betaFallbackHashes, buildModrinthContext, chooseVersion, downloadFile, enrichFindings, isNewerVersion, jarMatch, planQueries } from '../index';
import {
  CLOTH_CONFIG,
  FABRIC_API,
  SHA_CLOTH,
  SHA_SODIUM_BETA1,
  SHA_SODIUM_NEW,
  SHA_SODIUM_OLD,
  SHA_UNKNOWN,
  SODIUM,
  SODIUM_0814,
  SODIUM_0815_B1,
  SODIUM_0815_B2,
  SODIUM_ALPHA,
  SODIUM_BETA,
  SODIUM_NEW,
  SODIUM_OLD,
  lookup,
  mrFile,
  mrVersion,
  projectLookup,
} from './fixtures';

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}

function ctxOf(over: Partial<ModrinthContext> = {}): ModrinthContext {
  return { versions: {}, projects: {}, updates: {}, failed: [], offline: false, ...over };
}

function finding(code: FindingCode, over: Partial<Finding> = {}): Finding {
  return { id: `${code}:0000`, code, severity: 'error', title: code, explanation: '', culprits: [], evidence: [], fixes: [], ...over };
}

const dated = (v: MrVersion, datePublished: string | null | undefined, id = `${v.id}x`): MrVersion => ({ ...v, id, datePublished });

// ---- isNewerVersion ----------------------------------------------------------------------------

describe('isNewerVersion (by datePublished, strictly later)', () => {
  const at = (datePublished: string | null | undefined, id = 'cand0001'): MrVersion => mrVersion({ id, projectId: SODIUM.id, datePublished });
  const base = at('2026-10-15T18:40:52.770031Z', 'curr0001');

  it.each<[string, MrVersion, MrVersion, boolean]>([
    ['later release', SODIUM_NEW, SODIUM_OLD, true],
    ['earlier release (the live 0.8.14 vs 0.8.15-beta.1 downgrade)', SODIUM_0814, SODIUM_0815_B1, false],
    ['later beta', SODIUM_0815_B2, SODIUM_0815_B1, true],
    ['same version', SODIUM_NEW, SODIUM_NEW, false],
    ['equal dates, other version', at('2026-10-15T18:40:52.770031Z'), base, false],
    ['one microsecond later (beyond Date.parse precision)', at('2026-10-15T18:40:52.770032Z'), base, true],
    ['one microsecond earlier', at('2026-10-15T18:40:52.770030Z'), base, false],
    ['no fraction vs fraction', at('2026-10-15T18:40:53Z'), base, true],
    ['offset zone: 20:40:52+02:00 is 18:40:52Z, before .770031', at('2026-10-15T20:40:52+02:00'), base, false],
    ['offset zone: later in UTC', at('2026-10-15T14:41:00-04:00'), base, true],
    ['candidate date missing (undefined)', at(undefined), base, false],
    ['candidate date null', at(null), base, false],
    ['candidate date empty', at(''), base, false],
    ['current date missing', SODIUM_0815_B2, at(undefined, 'curr0002'), false],
    ['both dates missing', at(undefined), at(undefined, 'curr0002'), false],
    ['garbage date', at('yesterday'), base, false],
    ['date without a time', at('2027-01-01'), base, false],
    ['date-time without a zone (ambiguous)', at('2027-01-01T00:00:00'), base, false],
    ['impossible calendar date', at('2027-02-30T00:00:00Z'), base, false],
    ['impossible time', at('2027-01-01T24:00:00Z'), base, false],
  ])('%s → %s', (_name, candidate, current, expected) => {
    expect(isNewerVersion(candidate, current)).toBe(expected);
  });
});

// ---- buildModrinthContext: updates + updateStatus ----------------------------------------------

type Answer = MrVersion | 'absent' | 'failed';

interface Row {
  name: string;
  current: MrVersion;
  /** Release lookup (`updates`); null = no update lookup ran. */
  release: Answer | null;
  releaseOffline?: boolean;
  /** Beta-only fallback (`betaFallback`); null = not run. */
  fallback?: Answer | null;
  fallbackOffline?: boolean;
  update: MrVersion | null;
  status: 'update' | 'upToDate' | 'noCompatible' | 'unknown';
}

const SHA = SHA_SODIUM_BETA1;

function answerLookup(a: Answer | null | undefined, offline = false): HashLookup | null {
  if (a === null || a === undefined) return null;
  if (a === 'absent') return lookup({}, { offline });
  if (a === 'failed') return lookup({}, { failed: [SHA], offline });
  // Rust echoes the requested hash; the UI may hand upper-case keys (lower-cased by core).
  return lookup({ [SHA.toUpperCase()]: a }, { offline });
}

const undatedBeta2 = dated(SODIUM_0815_B2, undefined);
const undatedRelease = dated(SODIUM_0814, null);
const sameDayRelease = dated(SODIUM_0814, SODIUM_0815_B1.datePublished, 'rEl08150');
const otherProject = mrVersion({ id: 'fApI0100', projectId: FABRIC_API.id, datePublished: '2026-11-01T00:00:00.000000Z' });
const alphaNewer = dated({ ...SODIUM_0815_B2, versionType: 'alpha' }, '2026-11-02T00:00:00.000000Z', 'aLph0816');

describe('buildModrinthContext: no downgrades, beta fallback, updateStatus', () => {
  it.each<Row>([
    // Release lookup decides.
    { name: 'newer release → update', current: SODIUM_OLD, release: SODIUM_NEW, update: SODIUM_NEW, status: 'update' },
    { name: 'newer release wins over a newer beta fallback', current: SODIUM_OLD, release: SODIUM_NEW, fallback: SODIUM_BETA, update: SODIUM_NEW, status: 'update' },
    { name: 'release equals current → up to date', current: SODIUM_NEW, release: SODIUM_NEW, update: null, status: 'upToDate' },
    { name: 'up to date on a release: the fallback is ignored', current: SODIUM_NEW, release: SODIUM_NEW, fallback: SODIUM_BETA, update: null, status: 'upToDate' },
    { name: 'release with the same date, other id → not newer, up to date', current: SODIUM_0815_B1, release: sameDayRelease, fallback: SODIUM_0815_B2, update: null, status: 'upToDate' },
    { name: 'release without a date → not offered, unknown', current: SODIUM_OLD, release: undatedRelease, fallback: SODIUM_BETA, update: null, status: 'unknown' },
    { name: 'current without a date → not offered, unknown', current: dated(SODIUM_OLD, undefined, SODIUM_OLD.id), release: SODIUM_NEW, update: null, status: 'unknown' },
    { name: 'includeBeta lookup returning a newer beta directly', current: SODIUM_0814, release: SODIUM_0815_B2, update: SODIUM_0815_B2, status: 'update' },
    // The live downgrade: Sodium 0.8.15-beta.1 identified, the release lookup answers 0.8.14.
    { name: 'older release, no fallback run → never offered, up to date', current: SODIUM_0815_B1, release: SODIUM_0814, update: null, status: 'upToDate' },
    { name: 'older release, newer beta in the fallback → beta update', current: SODIUM_0815_B1, release: SODIUM_0814, fallback: SODIUM_0815_B2, update: SODIUM_0815_B2, status: 'update' },
    { name: 'older release, fallback returns the current beta → up to date', current: SODIUM_0815_B1, release: SODIUM_0814, fallback: SODIUM_0815_B1, update: null, status: 'upToDate' },
    { name: 'older release, fallback returns the same older release → up to date', current: SODIUM_0815_B1, release: SODIUM_0814, fallback: SODIUM_0814, update: null, status: 'upToDate' },
    { name: 'older release, fallback has nothing → up to date', current: SODIUM_0815_B1, release: SODIUM_0814, fallback: 'absent', update: null, status: 'upToDate' },
    { name: 'older release, fallback failed → unknown', current: SODIUM_0815_B1, release: SODIUM_0814, fallback: 'failed', update: null, status: 'unknown' },
    { name: 'older release, fallback cache-only without answer → unknown', current: SODIUM_0815_B1, release: SODIUM_0814, fallback: 'absent', fallbackOffline: true, update: null, status: 'unknown' },
    { name: 'older release, undated beta in the fallback → not offered, unknown', current: SODIUM_0815_B1, release: SODIUM_0814, fallback: undatedBeta2, update: null, status: 'unknown' },
    // No compatible release: beta-only fallback.
    { name: 'no release, newer beta → beta update', current: SODIUM_OLD, release: 'absent', fallback: SODIUM_BETA, update: SODIUM_BETA, status: 'update' },
    { name: 'no release, fallback beta older than the current beta → up to date', current: SODIUM_0815_B2, release: 'absent', fallback: SODIUM_0815_B1, update: null, status: 'upToDate' },
    { name: 'no release, fallback beta with the same date → up to date', current: SODIUM_0815_B1, release: 'absent', fallback: dated(SODIUM_0815_B1, SODIUM_0815_B1.datePublished), update: null, status: 'upToDate' },
    { name: 'no release, fallback has nothing → no compatible version', current: SODIUM_OLD, release: 'absent', fallback: 'absent', update: null, status: 'noCompatible' },
    { name: 'no release, fallback not run (includeBeta) → no compatible version', current: SODIUM_OLD, release: 'absent', update: null, status: 'noCompatible' },
    { name: 'no release, fallback failed → unknown', current: SODIUM_OLD, release: 'absent', fallback: 'failed', update: null, status: 'unknown' },
    { name: 'no release, undated beta → not offered, unknown', current: SODIUM_OLD, release: 'absent', fallback: undatedBeta2, update: null, status: 'unknown' },
    { name: 'release lookup answered an alpha → fallback decides', current: SODIUM_OLD, release: SODIUM_ALPHA, fallback: SODIUM_BETA, update: SODIUM_BETA, status: 'update' },
    { name: 'alpha only, anywhere → no compatible version', current: SODIUM_0815_B1, release: 'absent', fallback: alphaNewer, update: null, status: 'noCompatible' },
    { name: 'answers from another project are ignored', current: SODIUM_OLD, release: otherProject, fallback: otherProject, update: null, status: 'noCompatible' },
    // Unknown: no lookup, failed, cache-only without an answer.
    { name: 'no update lookup ran (unknown loader / MC) → unknown, fallback ignored', current: SODIUM_OLD, release: null, fallback: SODIUM_BETA, update: null, status: 'unknown' },
    { name: 'release lookup failed for the hash → unknown, fallback ignored', current: SODIUM_OLD, release: 'failed', fallback: SODIUM_BETA, update: null, status: 'unknown' },
    { name: 'release lookup cache-only without an answer → unknown, fallback ignored', current: SODIUM_OLD, release: 'absent', releaseOffline: true, fallback: SODIUM_BETA, update: null, status: 'unknown' },
    { name: 'release lookup cache-only with a cached newer release → update', current: SODIUM_OLD, release: SODIUM_NEW, releaseOffline: true, update: SODIUM_NEW, status: 'update' },
  ])('$name', (row) => {
    const ctx = buildModrinthContext({
      identify: lookup({ [SHA]: row.current }),
      updates: answerLookup(row.release, row.releaseOffline),
      betaFallback: answerLookup(row.fallback, row.fallbackOffline),
    });
    expect(ctx.updates[SHA] ?? null).toEqual(row.update);
    expect(Object.keys(ctx.updates)).toEqual(row.update ? [SHA] : []);
    expect(ctx.updateStatus).toEqual({ [SHA]: row.status });
    // jarMatch agrees with the context.
    const jar = fabric({ file: 'sodium.jar', mods: [{ id: 'sodium' }], sha1: SHA });
    const m = jarMatch(jar, ctx);
    expect(m.state).toBe(row.update ? 'update' : 'matched');
    if (m.state === 'update') expect(m.beta).toBe(row.update?.versionType !== 'release');
  });

  it('updateStatus covers every identified sha1 (lower-case), never unidentified or failed ones', () => {
    const cloth = mrVersion({ id: 'cLoTh011', projectId: CLOTH_CONFIG.id, datePublished: '2023-06-08T20:15:02.181207Z' });
    const ctx = buildModrinthContext({
      identify: lookup(
        { [SHA_SODIUM_OLD.toUpperCase()]: SODIUM_OLD, [SHA_SODIUM_NEW]: SODIUM_NEW, [SHA]: SODIUM_0815_B1, [SHA_CLOTH]: cloth },
        { failed: [SHA_UNKNOWN] },
      ),
      updates: lookup({ [SHA_SODIUM_OLD]: SODIUM_NEW, [SHA_SODIUM_NEW]: SODIUM_NEW, [SHA]: SODIUM_0814 }),
      betaFallback: lookup({ [SHA]: SODIUM_0815_B2 }),
    });
    expect(ctx.updateStatus).toEqual({
      [SHA_SODIUM_OLD]: 'update',
      [SHA_SODIUM_NEW]: 'upToDate',
      [SHA]: 'update',
      [SHA_CLOTH]: 'noCompatible',
    });
    expect(Object.keys(ctx.updates).sort()).toEqual([SHA, SHA_SODIUM_OLD].sort());
    expect(ctx.updates[SHA]).toBe(SODIUM_0815_B2);
  });

  it('no update lookup at all: every identified sha1 is unknown, nothing offered', () => {
    const ctx = buildModrinthContext({ identify: lookup({ [SHA_SODIUM_OLD]: SODIUM_OLD, [SHA_SODIUM_NEW]: SODIUM_NEW }) });
    expect(ctx.updateStatus).toEqual({ [SHA_SODIUM_OLD]: 'unknown', [SHA_SODIUM_NEW]: 'unknown' });
    expect(ctx.updates).toEqual({});
    expect(buildModrinthContext({ identify: lookup({}, { offline: true }) }).updateStatus).toEqual({});
  });

  it('does not mutate its inputs (fallback included)', () => {
    const args = deepFreeze({
      identify: lookup({ [SHA.toUpperCase()]: SODIUM_0815_B1, [SHA_SODIUM_OLD]: SODIUM_OLD }),
      updates: lookup({ [SHA]: SODIUM_0814, [SHA_SODIUM_OLD]: SODIUM_NEW }),
      betaFallback: lookup({ [SHA]: SODIUM_0815_B2 }),
      projects: projectLookup({ sodium: SODIUM }),
    });
    const before = JSON.stringify(args);
    const ctx = buildModrinthContext(args);
    expect(JSON.stringify(args)).toBe(before);
    expect(ctx.updates[SHA]).toBe(SODIUM_0815_B2);
  });
});

// ---- betaFallbackHashes ------------------------------------------------------------------------

describe('betaFallbackHashes', () => {
  const cloth = mrVersion({ id: 'cLoTh011', projectId: CLOTH_CONFIG.id, datePublished: '2023-06-08T20:15:02.181207Z' });
  const SHA_ALPHA = 'a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1';
  const SHA_UNDATED = 'd0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0';
  const identify = lookup(
    {
      [SHA_SODIUM_OLD.toUpperCase()]: SODIUM_OLD, // newer release → no
      [SHA_SODIUM_NEW]: SODIUM_NEW, // up to date → no
      [SHA]: SODIUM_0815_B1, // older release (pre-release user) → yes
      [SHA_CLOTH]: cloth, // no release → yes
      [SHA_UNKNOWN]: dated(SODIUM_OLD, SODIUM_OLD.datePublished, 'fAiLeD01'), // release lookup failed → no
      [SHA_ALPHA]: dated(SODIUM_OLD, SODIUM_OLD.datePublished, 'aLpHa001'), // alpha answer → yes
      [SHA_UNDATED]: dated(SODIUM_0815_B1, undefined, 'uNdAtEd1'), // cannot order → no
    },
    { failed: ['ffffffffffffffffffffffffffffffffffffffff'] },
  );
  const updates = lookup(
    {
      [SHA_SODIUM_OLD]: SODIUM_NEW,
      [SHA_SODIUM_NEW]: SODIUM_NEW,
      [SHA.toUpperCase()]: SODIUM_0814,
      [SHA_ALPHA]: SODIUM_ALPHA,
      [SHA_UNDATED]: SODIUM_0814,
    },
    { failed: [SHA_UNKNOWN.toUpperCase()] },
  );

  it('identified sha1s with no usable release, or an older one; lower-case and sorted', () => {
    expect(betaFallbackHashes(identify, updates, false)).toEqual([SHA, SHA_ALPHA, SHA_CLOTH].sort());
  });

  it.each<[string, HashLookup | null | undefined, boolean, string[]]>([
    ['includeBeta: the first call already covered betas', updates, true, []],
    ['no update lookup ran', null, false, []],
    ['undefined update lookup', undefined, false, []],
    ['cache-only: absent means "not cached" (no fallback), an older cached release still qualifies', { ...updates, offline: true }, false, [SHA, SHA_ALPHA].sort()],
  ])('%s', (_name, upd, includeBeta, expected) => {
    expect(betaFallbackHashes(identify, upd, includeBeta)).toEqual(expected);
  });

  it('is exactly the set whose fallback answer buildModrinthContext uses', () => {
    // Give every identified hash a newer beta in the fallback: only the listed ones may take it.
    const newest = (v: MrVersion): MrVersion => ({ ...v, id: `${v.id}-nb`, versionType: 'beta', datePublished: '2027-01-01T00:00:00.000000Z' });
    const fallbackFound: Record<string, MrVersion> = {};
    for (const [sha1, v] of Object.entries(identify.found)) fallbackFound[sha1.toLowerCase()] = newest(v);
    const ctx = buildModrinthContext({ identify, updates, betaFallback: lookup(fallbackFound) });
    const tookFallback = Object.entries(ctx.updates)
      .filter(([, v]) => v.id.endsWith('-nb'))
      .map(([sha1]) => sha1)
      .sort();
    expect(tookFallback).toEqual(betaFallbackHashes(identify, updates, false));
  });

  it('does not mutate its inputs', () => {
    const i = deepFreeze(structuredClone(identify));
    const u = deepFreeze(structuredClone(updates));
    expect(betaFallbackHashes(i, u, false)).toEqual([SHA, SHA_ALPHA, SHA_CLOTH].sort());
  });
});

// ---- jarMatch / enrichFindings: defence in depth on hand-built contexts ------------------------

describe('downgrade guard on hand-built contexts', () => {
  const jar = fabric({ file: 'sodium-fabric-0.8.15-beta.1+mc1.21.11.jar', mods: [{ id: 'sodium' }], sha1: SHA });
  const ref = { jarId: jar.id, fileName: jar.fileName, modId: 'sodium' };

  it.each<[string, MrVersion, boolean]>([
    ['older release (the live Sodium case)', SODIUM_0814, false],
    ['undated update', undatedBeta2, false],
    ['same date, other id', sameDayRelease, false],
    ['other project, newer', otherProject, false],
    ['alpha, newer', alphaNewer, false],
    ['newer beta', SODIUM_0815_B2, true],
  ])('%s → offered: %s', (_name, update, offered) => {
    const ctx = ctxOf({ versions: { [SHA]: SODIUM_0815_B1 }, updates: { [SHA]: update } });
    expect(jarMatch(jar, ctx).state).toBe(offered ? 'update' : 'matched');
    const f = finding('E-MC-RANGE', { culprits: [ref] });
    const [out] = enrichFindings([f], ctx, {}, [jar]);
    const replace: FixAction = { kind: 'replace', jarId: jar.id, versionId: update.id };
    if (offered) expect(out?.fixes).toEqual([replace]);
    else expect(out).toBe(f);
  });
});

// ---- downloadFile: "sole file" counts dropped files --------------------------------------------

describe('downloadFile: the sole-file rule counts dropped files (invariant 8)', () => {
  const file = (name: string, over: Partial<MrFile> = {}): MrFile => mrFile({ filename: name, primary: false, ...over });
  const v = (files: MrFile[], over: Partial<MrVersion> = {}): MrVersion => mrVersion({ id: 'OihdIimA', projectId: SODIUM.id, files, ...over });

  it.each<[string, MrVersion, string | null]>([
    ['sole remaining file, none primary, nothing dropped', v([file('a.jar')]), 'a.jar'],
    ['sole remaining file, none primary, one dropped (off-CDN)', v([file('a.jar')], { droppedFiles: 1 }), null],
    ['sole remaining file, none primary, several dropped', v([file('a.jar')], { droppedFiles: 3 }), null],
    ['sole file after excluded types, one dropped', v([file('a-sources.jar', { fileType: 'sources-jar' }), file('a.jar')], { droppedFiles: 1 }), null],
    ['primary remaining, a secondary dropped', v([file('a.jar', { primary: true }), file('b.jar')], { droppedFiles: 1 }), 'a.jar'],
    ['primary dropped', v([file('a.jar')], { droppedFiles: 1, primaryDropped: true }), null],
    ['nothing remaining, one dropped', v([], { droppedFiles: 1 }), null],
  ])('%s', (_name, version, expected) => {
    expect(downloadFile(version)?.filename ?? null).toBe(expected);
  });

  it('chooseVersion skips a version whose sole file is ambiguous', () => {
    const r2 = mrVersion({ id: 'r2', projectId: CLOTH_CONFIG.id, files: [file('cloth-2.jar')], droppedFiles: 1 });
    const r1 = mrVersion({ id: 'r1', projectId: CLOTH_CONFIG.id });
    expect(chooseVersion([r2, r1], false)?.id).toBe('r1');
    expect(chooseVersion([r2], true)).toBeNull();
  });
});

// ---- Quilt accepts Fabric ----------------------------------------------------------------------

describe('Quilt packs accept Fabric-only updates (CONTRACTS invariant 8)', () => {
  it('queries both loaders and offers a fabric-only update, with a replace fix', () => {
    const quiltPack = pack('quilt', '1.20.1', '0.26.4');
    // A Fabric mod on a Quilt pack (Quilt loads Fabric mods), plus a native Quilt mod.
    const sodiumJar = fabric({ file: 'sodium-fabric-mc1.20-0.4.10.jar', mods: [{ id: 'sodium' }], sha1: SHA_SODIUM_OLD });
    const qsl = quilt({ file: 'qfapi-7.4.0.jar', mods: [{ id: 'quilted_fabric_api' }], sha1: SHA_UNKNOWN });
    const q = planQueries(scan(sodiumJar, qsl), quiltPack);
    expect(q.updates).toEqual({ loaders: ['quilt', 'fabric'], gameVersions: ['1.20.1'] });

    const fabricOnly = { ...SODIUM_NEW, loaders: ['fabric'] };
    const ctx = buildModrinthContext({
      identify: lookup({ [SHA_SODIUM_OLD]: SODIUM_OLD }),
      updates: lookup({ [SHA_SODIUM_OLD]: fabricOnly }),
      projects: projectLookup({ AANobbMI: SODIUM }),
    });
    expect(ctx.updateStatus).toEqual({ [SHA_SODIUM_OLD]: 'update' });
    expect(jarMatch(sodiumJar, ctx)).toEqual({ state: 'update', version: SODIUM_OLD, project: SODIUM, update: fabricOnly, beta: false });
    const f = finding('E-MC-RANGE', { culprits: [{ jarId: sodiumJar.id, fileName: sodiumJar.fileName, modId: 'sodium' }] });
    expect(enrichFindings([f], ctx, {}, [sodiumJar, qsl])[0]?.fixes).toEqual([{ kind: 'replace', jarId: sodiumJar.id, versionId: fabricOnly.id }]);
  });
});
