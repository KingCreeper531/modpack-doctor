import { describe, expect, it } from 'vitest';
import type { FixAction, JarRecord, LoaderKind, MrFile, MrVersion } from '../../../bindings';
import { fabric, forge, nested, pack, scan } from '../../checks/__tests__/fixtures';
import type { Finding, FindingCode, ModrinthContext } from '../../model';
import {
  buildModrinthContext,
  chooseVersion,
  downloadFile,
  enrichFindings,
  jarMatch,
  missingModIds,
  modrinthLoaders,
  planQueries,
  projectIdsOf,
  updateVersionTypes,
  type DependencyResolution,
} from '../index';
import {
  ARCHITECTURY,
  CLOTH_CONFIG,
  FABRIC_API,
  SHA_CLOTH,
  SHA_SODIUM_NEW,
  SHA_SODIUM_OLD,
  SHA_UNKNOWN,
  SODIUM,
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

// ---- modrinthLoaders / planQueries -------------------------------------------------------------

describe('modrinthLoaders', () => {
  it.each<[LoaderKind | null, string | null, string[]]>([
    ['forge', '1.20.1', ['forge']],
    ['neoforge', '1.20.1', ['neoforge', 'forge']], // CONTRACTS invariant 12
    ['neoforge', '1.21.1', ['neoforge']],
    ['neoforge', '1.20.2', ['neoforge']],
    ['neoforge', '26.1', ['neoforge']],
    ['neoforge', null, ['neoforge']],
    ['fabric', '1.21.11', ['fabric']],
    ['quilt', '1.20.1', ['quilt', 'fabric']],
    ['legacyforge', '1.12.2', ['forge']],
    ['unknown', '1.20.1', []],
    [null, '1.20.1', []],
  ])('%s on %s → %j', (loader, mc, expected) => {
    expect(modrinthLoaders(pack(loader, mc))).toEqual(expected);
  });
});

describe('planQueries', () => {
  const a = fabric({ file: 'sodium.jar', mods: [{ id: 'sodium' }], sha1: SHA_SODIUM_OLD.toUpperCase() });
  const b = fabric({ file: 'cloth.jar', mods: [{ id: 'cloth-config' }], sha1: SHA_CLOTH, disabled: true });
  const dup = fabric({ file: 'sodium-copy.jar', mods: [{ id: 'sodium' }], sha1: SHA_SODIUM_OLD });
  const child = nested(a, { file: 'lib.jar', mods: [{ id: 'lib' }], sha1: SHA_UNKNOWN }, 'fabric');
  const hashless = fabric({ file: 'broken.jar', sha1: '' });

  it('identifies every top-level jar (enabled or disabled), lower-case, deduplicated, sorted; no nested jars', () => {
    const q = planQueries(scan(a, child, b, dup, hashless), pack('fabric', '1.20.1', '0.16.5'));
    expect(q.identify).toEqual([SHA_SODIUM_OLD, SHA_CLOTH].sort());
  });

  it.each<[LoaderKind | null, string | null, { loaders: string[]; gameVersions: string[] } | null]>([
    ['fabric', '1.20.1', { loaders: ['fabric'], gameVersions: ['1.20.1'] }],
    ['quilt', '1.20.1', { loaders: ['quilt', 'fabric'], gameVersions: ['1.20.1'] }],
    ['neoforge', '1.20.1', { loaders: ['neoforge', 'forge'], gameVersions: ['1.20.1'] }],
    ['fabric', '26.1', { loaders: ['fabric'], gameVersions: ['26.1'] }],
    ['fabric', '26.4-snapshot-6', { loaders: ['fabric'], gameVersions: ['26.4-snapshot-6'] }],
    ['forge', '1.20.1', { loaders: ['forge'], gameVersions: ['1.20.1'] }],
    ['unknown', '1.20.1', null],
    [null, '1.20.1', null],
    ['fabric', null, null],
    ['fabric', '  ', null],
  ])('update filters for %s %s', (loader, mc, expected) => {
    expect(planQueries(scan(a), pack(loader, mc)).updates).toEqual(expected);
  });
});

describe('updateVersionTypes / projectIdsOf', () => {
  it('never includes alpha', () => {
    expect(updateVersionTypes(false)).toEqual(['release']);
    expect(updateVersionTypes(true)).toEqual(['release', 'beta']);
  });

  it('deduplicates and sorts project ids', () => {
    const cloth = mrVersion({ id: 'cLoTh001', projectId: CLOTH_CONFIG.id });
    expect(projectIdsOf(lookup({ [SHA_SODIUM_OLD]: SODIUM_OLD, [SHA_SODIUM_NEW]: SODIUM_NEW, [SHA_CLOTH]: cloth }))).toEqual(['9s6osm5g', 'AANobbMI']);
    expect(projectIdsOf(lookup({}))).toEqual([]);
  });
});

// ---- buildModrinthContext ----------------------------------------------------------------------

describe('buildModrinthContext', () => {
  it('lower-cases sha1 keys, re-keys projects by id, failed/offline from identify only', () => {
    const ctx = buildModrinthContext({
      identify: lookup({ [SHA_SODIUM_OLD.toUpperCase()]: SODIUM_OLD }, { failed: [SHA_CLOTH.toUpperCase(), SHA_CLOTH] }),
      updates: lookup({ [SHA_SODIUM_OLD]: SODIUM_NEW }, { failed: [SHA_UNKNOWN], offline: true }),
      projects: projectLookup({ sodium: SODIUM, P7dR8mSH: FABRIC_API }),
    });
    expect(Object.keys(ctx.versions)).toEqual([SHA_SODIUM_OLD]);
    expect(ctx.updates).toEqual({ [SHA_SODIUM_OLD]: SODIUM_NEW });
    expect(Object.keys(ctx.projects).sort()).toEqual(['AANobbMI', 'P7dR8mSH']);
    expect(ctx.failed).toEqual([SHA_CLOTH]);
    expect(ctx.offline).toBe(false);
  });

  it('offline comes from identify', () => {
    expect(buildModrinthContext({ identify: lookup({}, { offline: true }) }).offline).toBe(true);
  });

  const identify = lookup({ [SHA_SODIUM_OLD]: SODIUM_OLD });
  it.each<[string, MrVersion | undefined, MrVersion | undefined, MrVersion | undefined]>([
    ['release update', SODIUM_NEW, undefined, SODIUM_NEW],
    ['release update wins over beta fallback', SODIUM_NEW, SODIUM_BETA, SODIUM_NEW],
    ['beta-only fallback when no release', undefined, SODIUM_BETA, SODIUM_BETA],
    ['"update" equal to the identified version is dropped', SODIUM_OLD, undefined, undefined],
    ['up to date on release: no beta fallback', SODIUM_OLD, SODIUM_BETA, undefined],
    ['alpha is never an update', SODIUM_ALPHA, undefined, undefined],
    ['alpha in the fallback is never an update', undefined, SODIUM_ALPHA, undefined],
    ['alpha primary falls through to the beta fallback', SODIUM_ALPHA, SODIUM_BETA, SODIUM_BETA],
    ['an update from another project is dropped', mrVersion({ id: 'xxxxxxxx', projectId: FABRIC_API.id }), undefined, undefined],
  ])('%s', (_name, upd, beta, expected) => {
    const ctx = buildModrinthContext({
      identify,
      updates: upd ? lookup({ [SHA_SODIUM_OLD]: upd }) : null,
      betaFallback: beta ? lookup({ [SHA_SODIUM_OLD.toUpperCase()]: beta }) : undefined,
    });
    expect(ctx.updates[SHA_SODIUM_OLD]).toEqual(expected);
    expect(Object.keys(ctx.updates)).toEqual(expected ? [SHA_SODIUM_OLD] : []);
  });

  it('includeBeta lookup may return a beta directly', () => {
    const ctx = buildModrinthContext({ identify, updates: lookup({ [SHA_SODIUM_OLD]: SODIUM_BETA }) });
    expect(ctx.updates[SHA_SODIUM_OLD]).toBe(SODIUM_BETA);
  });

  it('drops updates for jars that were not identified', () => {
    const ctx = buildModrinthContext({ identify: lookup({}, { failed: [SHA_SODIUM_OLD] }), updates: lookup({ [SHA_SODIUM_OLD]: SODIUM_NEW }) });
    expect(ctx.updates).toEqual({});
    expect(ctx.failed).toEqual([SHA_SODIUM_OLD]);
  });

  it('does not mutate its inputs', () => {
    const args = deepFreeze({
      identify: lookup({ [SHA_SODIUM_OLD.toUpperCase()]: SODIUM_OLD }, { failed: [SHA_CLOTH] }),
      updates: lookup({ [SHA_SODIUM_OLD]: SODIUM_NEW }),
      betaFallback: lookup({}),
      projects: projectLookup({ sodium: SODIUM }),
    });
    expect(() => buildModrinthContext(args)).not.toThrow();
  });
});

// ---- jarMatch ----------------------------------------------------------------------------------

describe('jarMatch', () => {
  const sodium = fabric({ file: 'sodium-fabric-mc1.20-0.4.10.jar', mods: [{ id: 'sodium' }], sha1: SHA_SODIUM_OLD.toUpperCase() });
  const sodiumNew = fabric({ file: 'sodium-fabric-0.5.13+mc1.20.1.jar', mods: [{ id: 'sodium' }], sha1: SHA_SODIUM_NEW });
  const curse = fabric({ file: 'curseforge-only.jar', mods: [{ id: 'cf' }], sha1: SHA_UNKNOWN });
  const cloth = fabric({ file: 'cloth.jar', mods: [{ id: 'cloth-config' }], sha1: SHA_CLOTH });
  const child = nested(curse, { file: 'nested-sodium.jar', mods: [{ id: 'sodium' }], sha1: SHA_SODIUM_NEW }, 'fabric');
  const childUnknown = nested(curse, { file: 'nested-lib.jar', mods: [{ id: 'lib' }], sha1: 'abababababababababababababababababababab' }, 'fabric');
  const hashless = fabric({ file: 'broken.jar', sha1: '' });

  const online = buildModrinthContext({
    identify: lookup({ [SHA_SODIUM_OLD]: SODIUM_OLD, [SHA_SODIUM_NEW]: SODIUM_NEW }, { failed: [SHA_CLOTH] }),
    updates: lookup({ [SHA_SODIUM_OLD]: SODIUM_NEW, [SHA_SODIUM_NEW]: SODIUM_NEW }),
    projects: projectLookup({ AANobbMI: SODIUM }),
  });
  const offline: ModrinthContext = { ...online, offline: true };
  const betaCtx = buildModrinthContext({ identify: lookup({ [SHA_SODIUM_OLD]: SODIUM_OLD }), betaFallback: lookup({ [SHA_SODIUM_OLD]: SODIUM_BETA }) });

  it.each<[string, JarRecord, ModrinthContext | null | undefined, string]>([
    ['update available', sodium, online, 'update'],
    ['already newest', sodiumNew, online, 'matched'],
    ['not on Modrinth', curse, online, 'missing'],
    ['failed lookup is unknown', cloth, online, 'unknown'],
    ['offline: identified jar still shows its update from cache', sodium, offline, 'update'],
    ['offline: identified jar still matched from cache', sodiumNew, offline, 'matched'],
    ['offline: unidentified is unknown, never missing', curse, offline, 'unknown'],
    ['no context', sodium, null, 'unknown'],
    ['undefined context', sodium, undefined, 'unknown'],
    ['nested jar identified by sha1', child, online, 'matched'],
    ['nested jar not identified is unknown', childUnknown, online, 'unknown'],
    ['jar without a hash', hashless, online, 'unknown'],
  ])('%s', (_name, jar, ctx, state) => {
    expect(jarMatch(jar, ctx).state).toBe(state);
  });

  it('carries version, project, update and beta flag', () => {
    expect(jarMatch(sodium, online)).toEqual({ state: 'update', version: SODIUM_OLD, project: SODIUM, update: SODIUM_NEW, beta: false });
    expect(jarMatch(sodium, betaCtx)).toEqual({ state: 'update', version: SODIUM_OLD, project: null, update: SODIUM_BETA, beta: true });
    expect(jarMatch(sodiumNew, online)).toEqual({ state: 'matched', version: SODIUM_NEW, project: SODIUM });
  });

  it('ignores an update equal to the current version or an alpha in a hand-built context', () => {
    const ctx = ctxOf({ versions: { [SHA_SODIUM_OLD]: SODIUM_OLD }, updates: { [SHA_SODIUM_OLD]: SODIUM_OLD } });
    expect(jarMatch(sodium, ctx).state).toBe('matched');
    const alpha = ctxOf({ versions: { [SHA_SODIUM_OLD]: SODIUM_OLD }, updates: { [SHA_SODIUM_OLD]: SODIUM_ALPHA } });
    expect(jarMatch(sodium, alpha).state).toBe('matched');
  });
});

// ---- downloadFile / chooseVersion --------------------------------------------------------------

describe('downloadFile (invariant 8, same rule as the Rust planner)', () => {
  const jar = (name: string, over: Partial<MrFile> = {}): MrFile => mrFile({ filename: name, primary: false, ...over });
  const v = (files: MrFile[], over: Partial<MrVersion> = {}): MrVersion => mrVersion({ id: 'OihdIimA', projectId: 'AANobbMI', files, ...over });

  it.each<[string, MrVersion, string | null]>([
    ['primary file', v([jar('a-sources.jar'), jar('a.jar', { primary: true }), jar('b.jar')]), 'a.jar'],
    ['sole file without primary flag', v([jar('a.jar')]), 'a.jar'],
    ['several files, none primary', v([jar('a.jar'), jar('b.jar')]), null],
    ['no files', v([]), null],
    ['primary dropped by the client (non-CDN host)', v([jar('a.jar')], { droppedFiles: 1, primaryDropped: true }), null],
    ['primary dropped even with a primary remaining', v([jar('b.jar', { primary: true })], { droppedFiles: 1, primaryDropped: true }), null],
    ['secondary dropped, primary intact', v([jar('a.jar', { primary: true })], { droppedFiles: 1 }), 'a.jar'],
    ['sources-jar excluded, sole remaining file', v([jar('a-sources.jar', { fileType: 'sources-jar' }), jar('a.jar')]), 'a.jar'],
    ['primary of an excluded type is skipped', v([jar('a-dev.jar', { primary: true, fileType: 'dev-jar' }), jar('a.jar')]), 'a.jar'],
    [
      'every excluded type',
      v([
        jar('s.jar', { fileType: 'sources-jar' }),
        jar('d.jar', { fileType: 'dev-jar' }),
        jar('j.jar', { fileType: 'javadoc-jar' }),
        jar('a.jar.asc', { fileType: 'signature' }),
      ]),
      null,
    ],
    ['only excluded types plus one normal file', v([jar('j.jar', { fileType: 'javadoc-jar' }), jar('a.asc', { fileType: 'signature' }), jar('a.jar')]), 'a.jar'],
    ['resource-pack file types are candidates', v([jar('pack.zip', { fileType: 'required-resource-pack' })]), 'pack.zip'],
    ['two candidates after exclusion, none primary', v([jar('a.jar'), jar('b.zip', { fileType: 'optional-resource-pack' }), jar('s.jar', { fileType: 'sources-jar' })]), null],
  ])('%s', (_name, version, expected) => {
    expect(downloadFile(version)?.filename ?? null).toBe(expected);
  });

  it('returns the file object as given (URL untouched)', () => {
    const f = jar('sodium-fabric-0.5.13+mc1.20.1.jar', { primary: true });
    expect(downloadFile(v([f]))).toBe(f);
    expect(f.url).toContain('%2B');
  });
});

describe('chooseVersion (newest first)', () => {
  const rel = (id: string, over: Partial<MrVersion> = {}) => mrVersion({ id, projectId: CLOTH_CONFIG.id, ...over });
  const beta = (id: string, over: Partial<MrVersion> = {}) => rel(id, { versionType: 'beta', ...over });
  const alpha = (id: string) => rel(id, { versionType: 'alpha' });
  const noFile = { files: [] as MrFile[] };

  it.each<[string, MrVersion[], boolean, string | null]>([
    ['newest release', [rel('r2'), rel('r1')], false, 'r2'],
    ['release over a newer beta', [beta('b3'), rel('r2')], false, 'r2'],
    ['includeBeta: a newer beta wins', [beta('b3'), rel('r2')], true, 'b3'],
    ['includeBeta: newest release still wins when newer', [rel('r4'), beta('b3')], true, 'r4'],
    ['beta-only fallback', [beta('b2'), beta('b1')], false, 'b2'],
    ['alpha never', [alpha('a1')], false, null],
    ['alpha never, even with includeBeta', [alpha('a2'), alpha('a1')], true, null],
    ['alpha skipped for an older release', [alpha('a3'), rel('r1')], false, 'r1'],
    ['release without a downloadable file is skipped', [rel('r2', noFile), rel('r1')], false, 'r1'],
    ['falls back to beta when no release has a file', [rel('r2', noFile), beta('b1')], false, 'b1'],
    ['primaryDropped release is skipped', [rel('r2', { primaryDropped: true }), beta('b1')], false, 'b1'],
    ['nothing usable', [rel('r1', noFile), beta('b1', noFile)], false, null],
    ['empty list', [], false, null],
    ['unknown version type is not suggested', [rel('x1', { versionType: 'snapshot' })], true, null],
  ])('%s', (_name, versions, includeBeta, expected) => {
    expect(chooseVersion(versions, includeBeta)?.id ?? null).toBe(expected);
  });

  it('does not mutate its input', () => {
    const list = deepFreeze([beta('b1'), rel('r1')]);
    expect(chooseVersion(list, false)?.id).toBe('r1');
  });
});

// ---- missingModIds / enrichFindings ------------------------------------------------------------

function finding(code: FindingCode, over: Partial<Finding> = {}): Finding {
  return {
    id: `${code}:0000`,
    code,
    severity: 'error',
    title: code,
    explanation: '',
    culprits: [],
    evidence: [],
    fixes: [],
    ...over,
  };
}

const manualFix: FixAction = { kind: 'manual', steps: ['Do something by hand.'] };

describe('missingModIds', () => {
  it('unions, deduplicates and sorts', () => {
    expect(
      missingModIds([
        finding('E-MISSING-DEP', { missingModIds: ['fabric-api'] }),
        finding('C-MISSING-MANDATORY', { missingModIds: ['architectury', 'cloth-config'] }),
        finding('E-MISSING-DEP', { missingModIds: ['architectury'] }),
        finding('E-DUP-ID'),
      ]),
    ).toEqual(['architectury', 'cloth-config', 'fabric-api']);
    expect(missingModIds([])).toEqual([]);
  });
});

describe('enrichFindings', () => {
  const sodium = fabric({ file: 'sodium-fabric-mc1.20-0.4.10.jar', mods: [{ id: 'sodium' }], sha1: SHA_SODIUM_OLD });
  const cloth = fabric({ file: 'cloth-config-11.0.jar', mods: [{ id: 'cloth-config' }], sha1: SHA_CLOTH });
  const disabledSodium = fabric({ file: 'sodium-old.jar', mods: [{ id: 'sodium' }], sha1: SHA_SODIUM_OLD, disabled: true });
  const child = nested(cloth, { file: 'sodium-nested.jar', mods: [{ id: 'sodium' }], sha1: SHA_SODIUM_OLD }, 'fabric');
  const jars = [sodium, cloth, child, disabledSodium];

  const clothOld = mrVersion({ id: 'cLoTh011', projectId: CLOTH_CONFIG.id, versionNumber: '11.0.99' });
  const clothNoFile = mrVersion({ id: 'cLoTh012', projectId: CLOTH_CONFIG.id, versionNumber: '11.1.106', files: [] });
  const ctx = buildModrinthContext({
    identify: lookup({ [SHA_SODIUM_OLD]: SODIUM_OLD, [SHA_CLOTH]: clothOld }),
    updates: lookup({ [SHA_SODIUM_OLD]: SODIUM_NEW, [SHA_CLOTH]: clothNoFile }),
  });

  const archVersion = mrVersion({ id: 'aRcH0913', projectId: ARCHITECTURY.id, versionNumber: '9.1.13', loaders: ['forge'] });
  const fapiVersion = mrVersion({ id: 'fApI0092', projectId: FABRIC_API.id, versionNumber: '0.92.2+1.20.1', versionType: 'beta' });
  const resolutions: Record<string, DependencyResolution> = {
    architectury: { modId: 'architectury', project: ARCHITECTURY, version: archVersion, beta: false },
    'fabric-api': { modId: 'fabric-api', project: FABRIC_API, version: fapiVersion, beta: true },
    broken: { modId: 'broken', project: FABRIC_API, version: { ...fapiVersion, id: 'nofile', files: [] }, beta: false },
    alpha: { modId: 'alpha', project: FABRIC_API, version: { ...fapiVersion, id: 'alphaV', versionType: 'alpha' }, beta: true },
  };

  const replaceSodium: FixAction = { kind: 'replace', jarId: sodium.id, versionId: SODIUM_NEW.id };
  const sodiumRef = { jarId: sodium.id, fileName: sodium.fileName, modId: 'sodium' };
  const clothRef = { jarId: cloth.id, fileName: cloth.fileName, modId: 'cloth-config' };

  it.each<[FindingCode, boolean]>([
    ['E-WRONG-LOADER', true],
    ['E-MC-RANGE', true],
    ['E-LOADER-RANGE', true],
    ['C-MIXIN', true],
    ['C-ROOT-CAUSE', true],
    ['C-NATIVE', true],
    ['C-MISSING-MANDATORY', true],
    ['E-DUP-ID', false],
    ['E-DEP-RANGE', false],
    ['W-CLIENT-ON-SERVER', false],
    ['I-NOT-ON-MODRINTH', false],
  ])('%s gets a replace fix: %s', (code, expected) => {
    const [out] = enrichFindings([finding(code, { culprits: [sodiumRef], fixes: [manualFix] })], ctx, {}, jars);
    expect(out?.fixes).toEqual(expected ? [replaceSodium, manualFix] : [manualFix]);
  });

  it('skips culprits without an update, with an update that has no download file, or without jars', () => {
    const f = finding('E-MC-RANGE', { culprits: [clothRef, sodiumRef, { jarId: 'mods/gone.jar', fileName: 'gone.jar' }] });
    expect(enrichFindings([f], ctx, {}, jars)[0]?.fixes).toEqual([replaceSodium]);
    // Without the scan's jars no sha1 is known: no replace.
    expect(enrichFindings([f], ctx)[0]).toBe(f);
  });

  it('never replaces nested or disabled jars', () => {
    const f = finding('C-MIXIN', {
      culprits: [
        { jarId: child.id, fileName: child.fileName },
        { jarId: disabledSodium.id, fileName: disabledSodium.fileName },
      ],
    });
    expect(enrichFindings([f], ctx, {}, jars)[0]).toBe(f);
  });

  it('adds installDependency for resolved missing ids first, then replace, then existing fixes', () => {
    const enable: FixAction = { kind: 'enable', jarId: 'mods/architectury.jar' };
    const f = finding('C-MISSING-MANDATORY', {
      culprits: [sodiumRef],
      missingModIds: ['alpha', 'architectury', 'broken', 'fabric-api', 'unresolved'],
      fixes: [enable, manualFix],
    });
    const [out] = enrichFindings([f], ctx, resolutions, jars);
    expect(out?.fixes).toEqual([
      { kind: 'installDependency', modId: 'architectury', versionId: 'aRcH0913' },
      { kind: 'installDependency', modId: 'fabric-api', versionId: 'fApI0092' },
      replaceSodium,
      enable,
      manualFix,
    ]);
    expect(out?.id).toBe(f.id);
    expect(out?.missingModIds).toEqual(f.missingModIds);
  });

  it('E-MISSING-DEP gets installDependency but no replace', () => {
    const f = finding('E-MISSING-DEP', { culprits: [sodiumRef], missingModIds: ['fabric-api'], fixes: [manualFix] });
    expect(enrichFindings([f], ctx, resolutions, jars)[0]?.fixes).toEqual([
      { kind: 'installDependency', modId: 'fabric-api', versionId: 'fApI0092' },
      manualFix,
    ]);
  });

  it('no duplicates: repeated culprits, and fixes already present (idempotent; new fixes supersede stale ones)', () => {
    const stale: FixAction = { kind: 'replace', jarId: sodium.id, versionId: 'stale000' };
    const f = finding('E-WRONG-LOADER', { culprits: [sodiumRef, sodiumRef], fixes: [manualFix, stale] });
    const once = enrichFindings([f], ctx, {}, jars);
    expect(once[0]?.fixes).toEqual([replaceSodium, manualFix]);
    const twice = enrichFindings(once, ctx, {}, jars);
    expect(twice[0]?.fixes).toEqual([replaceSodium, manualFix]);
    const g = finding('E-MISSING-DEP', { missingModIds: ['architectury'] });
    const g2 = enrichFindings(enrichFindings([g], ctx, resolutions, jars), ctx, resolutions, jars);
    expect(g2[0]?.fixes).toEqual([{ kind: 'installDependency', modId: 'architectury', versionId: 'aRcH0913' }]);
  });

  it('keeps finding order and ids; untouched findings are returned as is', () => {
    const a = finding('E-DUP-ID', { id: 'a' });
    const b = finding('E-MC-RANGE', { id: 'b', culprits: [sodiumRef] });
    const c = finding('I-NOT-ON-MODRINTH', { id: 'c' });
    const out = enrichFindings([a, b, c], ctx, {}, jars);
    expect(out.map((f) => f.id)).toEqual(['a', 'b', 'c']);
    expect(out[0]).toBe(a);
    expect(out[1]).not.toBe(b);
    expect(out[2]).toBe(c);
  });

  it.each<[string, ModrinthContext | null | undefined]>([
    ['null', null],
    ['undefined', undefined],
    ['offline', { ...ctx, offline: true }],
  ])('nothing changes when the context is %s', (_name, c) => {
    const f = finding('C-MISSING-MANDATORY', { culprits: [sodiumRef], missingModIds: ['architectury'], fixes: [manualFix] });
    const input = [f];
    const out = enrichFindings(input, c, resolutions, jars);
    expect(out).toEqual(input);
    expect(out).not.toBe(input);
  });

  it('does not mutate its inputs', () => {
    const f = finding('C-MISSING-MANDATORY', { culprits: [sodiumRef, clothRef], missingModIds: ['architectury'], fixes: [manualFix] });
    const findings = deepFreeze([f]);
    const before = JSON.stringify(findings);
    const out = enrichFindings(findings, deepFreeze(ctx), deepFreeze(resolutions), deepFreeze(jars));
    expect(JSON.stringify(findings)).toBe(before);
    expect(out[0]?.fixes).toHaveLength(3);
    expect(f.fixes).toEqual([manualFix]);
  });

  it('works for Forge-family packs too (realistic: NeoForge 1.20.1 culprit with a Forge-loader update)', () => {
    const jei = forge({ file: 'jei-1.20.1-forge-15.2.0.27.jar', mods: [{ id: 'jei' }], sha1: 'e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1' });
    const jeiOld = mrVersion({ id: 'jEi15200', projectId: 'u6dRKJwZ', versionNumber: '15.2.0.27', loaders: ['forge'] });
    const jeiNew = mrVersion({ id: 'jEi15201', projectId: 'u6dRKJwZ', versionNumber: '15.20.0.106', loaders: ['forge', 'neoforge'] });
    const c = buildModrinthContext({ identify: lookup({ [jei.sha1]: jeiOld }), updates: lookup({ [jei.sha1]: jeiNew }) });
    const f = finding('C-ROOT-CAUSE', { culprits: [{ jarId: jei.id, fileName: jei.fileName, modId: 'jei' }] });
    expect(enrichFindings([f], c, undefined, [jei])[0]?.fixes).toEqual([{ kind: 'replace', jarId: jei.id, versionId: 'jEi15201' }]);
  });
});
