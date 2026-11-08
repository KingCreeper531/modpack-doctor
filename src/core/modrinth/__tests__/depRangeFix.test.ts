import { describe, expect, it } from 'vitest';
import type { JarRecord, MrVersion } from '../../../bindings';
import { forge, fabric, input as checkInput, modrinth, only, pack } from '../../checks/__tests__/fixtures';
import { runChecks } from '../../checks';
import type { Finding, ModrinthContext, PackContext } from '../../model';
import {
  depRangeRequests,
  depRangeVersions,
  emptyDepRangeData,
  enrichDepRangeFindings,
  modVersionFromModrinth,
  type DepRangeData,
} from '../depRangeFix';
import { mrProject, mrVersion } from './fixtures';

const CREATE = mrProject({ id: 'LNytGWDc', slug: 'create', title: 'Create' });
const ADDON = mrProject({ id: 'AdDoNaaa', slug: 'create-addon', title: 'Create Addon' });
const SHA_CREATE = 'c4ea7e0000000000000000000000000000000001';
const SHA_ADDON = 'add0000000000000000000000000000000000001';

const createV = (id: string, versionNumber: string, datePublished: string, over: Partial<MrVersion> = {}): MrVersion =>
  mrVersion({ id, projectId: CREATE.id, versionNumber, datePublished, loaders: ['forge'], gameVersions: ['1.20.1'], ...over });

const C_051F = createV('c051f', '0.5.1.f', '2023-06-12T17:31:40Z');
const C_051J = createV('c051j', '0.5.1.j', '2024-10-01T10:00:00Z');
const C_604 = createV('c604', '6.0.4', '2025-03-01T10:00:00Z');
const C_606 = createV('c606', '6.0.6', '2025-07-01T10:00:00Z');
/** Newest first, as `modrinth_project_versions` returns them. */
const CREATE_VERSIONS = [C_606, C_604, C_051J];

const P = pack('forge', '1.20.1', '47.3.0');

function jars(range: string, createVersion: string, addonName = 'Create Addon'): JarRecord[] {
  return [
    forge({ file: 'create-addon.jar', sha1: SHA_ADDON, mods: [{ id: 'createaddon', name: addonName, deps: [{ id: 'create', range }] }] }),
    forge({ file: `create-${createVersion}.jar`, sha1: SHA_CREATE, mods: [{ id: 'create', name: 'Create', version: createVersion }] }),
  ];
}

function ctxWith(installed: MrVersion | null, extra: Partial<ModrinthContext> = {}): ModrinthContext {
  return modrinth({ versions: installed ? { [SHA_CREATE]: installed } : {}, projects: { [CREATE.id]: CREATE }, ...extra });
}

function setup(range: string, createVersion: string, mr: ModrinthContext, list: JarRecord[] = jars(range, createVersion), p: PackContext = P) {
  const input = { ...checkInput(list, p), modrinth: mr };
  const findings = runChecks(input);
  return { input, findings, dep: only(findings, 'E-DEP-RANGE') };
}

function data(versionsByProject: DepRangeData['versionsByProject'], projectsByModId: DepRangeData['projectsByModId'] = {}): DepRangeData {
  return { projectsByModId, versionsByProject };
}

function steps(f: Finding | undefined): string {
  return (f?.fixes ?? []).flatMap((x) => (x.kind === 'manual' ? x.steps : [])).join(' ');
}

describe('E-DEP-RANGE static wording (no Modrinth)', () => {
  it('states the range in words, the installed version, and what to switch to', () => {
    const [f] = only(runChecks(checkInput(jars('[6.0,)', '0.5.1.f'), P)), 'E-DEP-RANGE');
    expect(f?.title).toBe('Create Addon needs Create 6.0 or newer; you have 0.5.1.f (create-0.5.1.f.jar)');
    expect(f?.explanation).toContain('You have Create 0.5.1.f in create-0.5.1.f.jar');
    expect(f?.explanation).toContain('Switch Create to 6.0 or newer');
    expect(f?.fixes[0]).toEqual({
      kind: 'manual',
      steps: [
        'Switch Create to 6.0 or newer ([6.0,)) made for Forge 1.20.1: replace create-0.5.1.f.jar with it.',
        'Or use a version of Create Addon made for Create 0.5.1.f.',
      ],
    });
    expect(f?.fixes[1]).toEqual({ kind: 'disable', jarId: 'mods/create-addon.jar' });
  });

  it('a bounded range reads as "X or newer, but older than Y"', () => {
    const [f] = only(runChecks(checkInput(jars('[0.5.1,0.5.2)', '6.0.6'), P)), 'E-DEP-RANGE');
    expect(f?.title).toBe('Create Addon needs Create 0.5.1 or newer, but older than 0.5.2; you have 6.0.6 (create-6.0.6.jar)');
  });
});

describe('E-DEP-RANGE with Modrinth: name the version', () => {
  it('Forge 1.20.1, addon needs create [6.0,), 0.5.1.f installed → replace with Create 6.0.6', () => {
    const mr = ctxWith(C_051F);
    const { input, findings, dep } = setup('[6.0,)', '0.5.1.f', mr);
    expect(dep).toHaveLength(1);
    // The installed jar is identified, so its project is known: only its version list is needed.
    expect(depRangeRequests(findings, input, mr, emptyDepRangeData())).toEqual([{ kind: 'projectVersions', projectId: CREATE.id }]);
    const d = data({ [CREATE.id]: CREATE_VERSIONS });
    expect(depRangeRequests(findings, input, mr, d)).toEqual([]);
    const [f] = only(enrichDepRangeFindings(findings, input, mr, d), 'E-DEP-RANGE');
    expect(f?.id).toBe(dep[0]?.id);
    expect(f?.title).toBe('Create Addon needs Create 6.0 or newer; you have 0.5.1.f (create-0.5.1.f.jar) — switch Create to 6.0.6');
    expect(f?.explanation).toContain('Switch Create to 6.0.6 (the newest Create for Forge 1.20.1 that Create Addon accepts).');
    expect(f?.fixes[0]).toEqual({ kind: 'replace', jarId: 'mods/create-0.5.1.f.jar', versionId: 'c606' });
    expect(f?.fixes.slice(1)).toEqual([
      { kind: 'manual', steps: ['Or use a version of Create Addon made for Create 0.5.1.f.'] },
      { kind: 'disable', jarId: 'mods/create-addon.jar' },
    ]);
    expect(f?.evidence.some((e) => e.kind === 'note' && e.text === 'Modrinth: Create 6.0.6 is the newest Create for Forge 1.20.1 in 6.0 or newer ([6.0,)).')).toBe(true);
    // The pack note stays last.
    expect(f?.evidence[f.evidence.length - 1]).toEqual({ kind: 'note', text: expect.stringContaining('Pack:') });
  });

  it('the reverse: range [0.5.1,0.5.2) with 6.0.6 installed → Create 0.5.1.j, named but not auto-replaced (a downgrade)', () => {
    const mr = ctxWith(C_606);
    const { input, findings } = setup('[0.5.1,0.5.2)', '6.0.6', mr);
    const [f] = only(enrichDepRangeFindings(findings, input, mr, data({ [CREATE.id]: CREATE_VERSIONS })), 'E-DEP-RANGE');
    expect(f?.title).toMatch(/ — switch Create to 0\.5\.1\.j$/);
    expect(f?.explanation).toContain('Switch Create to 0.5.1.j (the newest Create for Forge 1.20.1 that Create Addon accepts).');
    // Rust refuses a `replace` that is not published after the installed version (invariant 8).
    expect(f?.fixes.some((x) => x.kind === 'replace')).toBe(false);
    expect(f?.fixes[0]?.kind).toBe('manual');
    expect(steps(f)).toContain('older than the installed 6.0.6');
    expect(steps(f)).toContain('download Create 0.5.1.j from Modrinth and replace create-6.0.6.jar with it');
  });

  it('newest by version number within the range, not only by date', () => {
    const mr = ctxWith(C_051F);
    const late604 = createV('c604b', '6.0.4', '2025-09-01T10:00:00Z'); // re-upload after 6.0.6
    const { input, findings } = setup('[6.0,)', '0.5.1.f', mr);
    const [f] = only(enrichDepRangeFindings(findings, input, mr, data({ [CREATE.id]: [late604, C_606, C_051J] })), 'E-DEP-RANGE');
    expect(f?.fixes[0]).toEqual({ kind: 'replace', jarId: 'mods/create-0.5.1.f.jar', versionId: 'c606' });
  });

  it('skips versions for another loader or MC version, alpha, and those without a download file', () => {
    const mr = ctxWith(C_051F);
    const list = [
      createV('neo', '6.0.9', '2025-10-01T10:00:00Z', { loaders: ['neoforge'], gameVersions: ['1.21.1'] }),
      createV('mc', '6.0.8', '2025-09-01T10:00:00Z', { gameVersions: ['1.21.1'] }),
      createV('alpha', '6.0.7', '2025-08-01T10:00:00Z', { versionType: 'alpha' }),
      createV('nofile', '6.0.65', '2025-07-15T10:00:00Z', { files: [] }),
      C_604,
    ];
    const { input, findings } = setup('[6.0,)', '0.5.1.f', mr);
    const [f] = only(enrichDepRangeFindings(findings, input, mr, data({ [CREATE.id]: list })), 'E-DEP-RANGE');
    expect(f?.fixes[0]).toEqual({ kind: 'replace', jarId: 'mods/create-0.5.1.f.jar', versionId: 'c604' });
  });

  it('prefers a release; a beta only when no release fits (labelled beta)', () => {
    const mr = ctxWith(C_051F);
    const b = createV('c607b', '6.0.7', '2025-08-01T10:00:00Z', { versionType: 'beta' });
    const { input, findings } = setup('[6.0,)', '0.5.1.f', mr);
    const [withRelease] = only(enrichDepRangeFindings(findings, input, mr, data({ [CREATE.id]: [b, C_606] })), 'E-DEP-RANGE');
    expect(withRelease?.fixes[0]).toMatchObject({ versionId: 'c606' });
    const [betaOnly] = only(enrichDepRangeFindings(findings, input, mr, data({ [CREATE.id]: [b, C_051J] })), 'E-DEP-RANGE');
    expect(betaOnly?.fixes[0]).toMatchObject({ kind: 'replace', versionId: 'c607b' });
    expect(betaOnly?.explanation).toContain('Switch Create to 6.0.7 (beta)');
    const [included] = only(enrichDepRangeFindings(findings, input, mr, data({ [CREATE.id]: [b, C_606] }), true), 'E-DEP-RANGE');
    expect(included?.fixes[0]).toMatchObject({ versionId: 'c607b' });
  });

  it('decorated Modrinth version numbers are read as the mod version', () => {
    const mr = ctxWith(createV('c051f', 'create-1.20.1-0.5.1.f', '2023-06-12T17:31:40Z'));
    const list = [createV('c606', '6.0.6+mc1.20.1-forge', '2025-07-01T10:00:00Z'), createV('c051j', 'mc1.20.1-0.5.1.j', '2024-10-01T10:00:00Z')];
    const { input, findings } = setup('[6.0,)', '0.5.1.f', mr);
    const [f] = only(enrichDepRangeFindings(findings, input, mr, data({ [CREATE.id]: list })), 'E-DEP-RANGE');
    expect(f?.fixes[0]).toEqual({ kind: 'replace', jarId: 'mods/create-0.5.1.f.jar', versionId: 'c606' });
  });

  it('not confident → unchanged: the installed jar\'s Modrinth number does not read as its declared version', () => {
    const mr = ctxWith(createV('c051f', 'Create 0.5.1f build 42', '2023-06-12T17:31:40Z'));
    const { input, findings } = setup('[6.0,)', '0.5.1.f', mr);
    expect(enrichDepRangeFindings(findings, input, mr, data({ [CREATE.id]: CREATE_VERSIONS }))).toEqual(findings);
  });

  it('not confident → unchanged: candidates whose numbers cannot be read', () => {
    const mr = ctxWith(C_051F);
    const list = [createV('x', 'Create Big Update', '2025-07-01T10:00:00Z')];
    const { input, findings } = setup('[6.0,)', '0.5.1.f', mr);
    expect(enrichDepRangeFindings(findings, input, mr, data({ [CREATE.id]: list }))).toEqual(findings);
  });

  it('an unidentified Create jar: resolves the mod id, names the version, no replace (Rust needs the hash)', () => {
    const mr = ctxWith(null);
    const { input, findings } = setup('[6.0,)', '0.5.1.f', mr);
    expect(depRangeRequests(findings, input, mr, emptyDepRangeData())).toEqual([{ kind: 'resolveModId', modId: 'create' }]);
    const resolved = data({}, { create: CREATE });
    expect(depRangeRequests(findings, input, mr, resolved)).toEqual([{ kind: 'projectVersions', projectId: CREATE.id }]);
    const [f] = only(enrichDepRangeFindings(findings, input, mr, data({ [CREATE.id]: CREATE_VERSIONS }, { create: CREATE })), 'E-DEP-RANGE');
    expect(f?.title).toMatch(/ — switch Create to 6\.0\.6$/);
    expect(f?.fixes.some((x) => x.kind === 'replace')).toBe(false);
    expect(steps(f)).toContain('Download Create 6.0.6 from Modrinth and replace create-0.5.1.f.jar with it.');
    // Modrinth has no such project → unchanged.
    expect(enrichDepRangeFindings(findings, input, mr, data({}, { create: null }))).toEqual(findings);
  });

  it('no Create version fits → says so plainly', () => {
    const mr = ctxWith(C_051F);
    const { input, findings } = setup('[7.0,)', '0.5.1.f', mr);
    const [f] = only(enrichDepRangeFindings(findings, input, mr, data({ [CREATE.id]: CREATE_VERSIONS })), 'E-DEP-RANGE');
    expect(f?.fixes[0]).toEqual({
      kind: 'manual',
      steps: ['No Create version for Forge 1.20.1 matches 7.0 or newer ([7.0,)); look for a version of Create Addon made for Create 0.5.1.f.'],
    });
    expect(f?.fixes[1]).toEqual({ kind: 'disable', jarId: 'mods/create-addon.jar' });
  });

  it('no Create version fits → a version of the addon made for the installed Create (Modrinth dependency metadata)', () => {
    const addonCur = mrVersion({ id: 'a1', projectId: ADDON.id, versionNumber: '1.0', loaders: ['forge'], datePublished: '2025-08-01T10:00:00Z' });
    const addonOld = mrVersion({
      id: 'a05',
      projectId: ADDON.id,
      versionNumber: '0.9',
      loaders: ['forge'],
      datePublished: '2024-11-01T10:00:00Z',
      dependencies: [{ versionId: C_051F.id, projectId: CREATE.id, fileName: null, dependencyType: 'required' }],
    });
    const mr = modrinth({ versions: { [SHA_CREATE]: C_051F, [SHA_ADDON]: addonCur }, projects: { [CREATE.id]: CREATE, [ADDON.id]: ADDON } });
    const { input, findings } = setup('[7.0,)', '0.5.1.f', mr);
    const first = data({ [CREATE.id]: CREATE_VERSIONS });
    expect(depRangeRequests(findings, input, mr, first)).toEqual([{ kind: 'projectVersions', projectId: ADDON.id }]);
    // A newer addon build for the installed Create → replace.
    const addonNew = { ...addonOld, id: 'a2', versionNumber: '1.1', datePublished: '2025-09-01T10:00:00Z' };
    const [up] = only(enrichDepRangeFindings(findings, input, mr, data({ [CREATE.id]: CREATE_VERSIONS, [ADDON.id]: [addonNew, addonCur, addonOld] })), 'E-DEP-RANGE');
    expect(up?.title).toMatch(/ — update Create Addon to 1\.1$/);
    expect(up?.explanation).toContain('Update Create Addon to 1.1: Modrinth lists it as made for the installed Create 0.5.1.f.');
    expect(up?.fixes[0]).toEqual({ kind: 'replace', jarId: 'mods/create-addon.jar', versionId: 'a2' });
    // Only an older one → named, but a manual step (no downgrade through `replace`).
    const [down] = only(enrichDepRangeFindings(findings, input, mr, data({ [CREATE.id]: CREATE_VERSIONS, [ADDON.id]: [addonCur, addonOld] })), 'E-DEP-RANGE');
    expect(down?.fixes.some((x) => x.kind === 'replace')).toBe(false);
    expect(steps(down)).toContain('Update Create Addon to 0.9');
    // Modrinth lists no dependency on the installed version → the plain message.
    const [plain] = only(enrichDepRangeFindings(findings, input, mr, data({ [CREATE.id]: CREATE_VERSIONS, [ADDON.id]: [addonCur] })), 'E-DEP-RANGE');
    expect(steps(plain)).toContain('No Create version for Forge 1.20.1 matches 7.0 or newer ([7.0,))');
  });

  it("never suggests a version another mod's declared range rejects", () => {
    const mr = ctxWith(C_051F);
    const list = [
      ...jars('[6.0,)', '0.5.1.f'),
      forge({ file: 'old-addon.jar', mods: [{ id: 'oldaddon', name: 'Old Addon', deps: [{ id: 'create', range: '[0.5.1,6.0.5)' }] }] }),
    ];
    const { input, findings } = setup('[6.0,)', '0.5.1.f', mr, list);
    const [f] = only(enrichDepRangeFindings(findings, input, mr, data({ [CREATE.id]: CREATE_VERSIONS })), 'E-DEP-RANGE');
    expect(f?.fixes[0]).toEqual({ kind: 'replace', jarId: 'mods/create-0.5.1.f.jar', versionId: 'c604' });
    expect(f?.explanation).toContain('that Create Addon and the other mods that depend on it accept');
    // Nothing satisfies both → the conflict is named.
    const strict = [...jars('[6.0,)', '0.5.1.f'), forge({ file: 'old-addon.jar', mods: [{ id: 'oldaddon', name: 'Old Addon', deps: [{ id: 'create', range: '[0.5.1,0.5.2)' }] }] })];
    const s = setup('[6.0,)', '0.5.1.f', mr, strict);
    const [g] = only(enrichDepRangeFindings(s.findings, s.input, mr, data({ [CREATE.id]: CREATE_VERSIONS })), 'E-DEP-RANGE');
    expect(steps(g)).toContain('Create 6.0.6 would suit Create Addon, but Old Addon needs Create 0.5.1 or newer, but older than 0.5.2 ([0.5.1,0.5.2))');
  });

  it('Fabric syntax: >=0.6 with sodium 0.5.8 installed → newest fitting Sodium', () => {
    const SODIUM = mrProject({ id: 'AANobbMI', slug: 'sodium', title: 'Sodium' });
    const sv = (id: string, n: string, date: string) => mrVersion({ id, projectId: SODIUM.id, versionNumber: n, datePublished: date, loaders: ['fabric', 'quilt'] });
    const cur = sv('s058', 'mc1.20.1-0.5.8', '2024-02-01T10:00:00Z');
    const list: JarRecord[] = [
      fabric({ file: 'extra.jar', mods: [{ id: 'sodium-extra', name: 'Sodium Extra', deps: [{ id: 'sodium', range: '>=0.6.0' }] }] }),
      fabric({ file: 'sodium.jar', sha1: SHA_CREATE, mods: [{ id: 'sodium', name: 'Sodium', version: '0.5.8+mc1.20.1' }] }),
    ];
    const mr = modrinth({ versions: { [SHA_CREATE]: cur }, projects: { [SODIUM.id]: SODIUM } });
    const fp = pack('fabric', '1.20.1', '0.16.5');
    const { input, findings } = setup('', '', mr, list, fp);
    // The jar declares `0.5.8+mc1.20.1`; Modrinth calls it `mc1.20.1-0.5.8`: same version.
    const [f] = only(
      enrichDepRangeFindings(findings, input, mr, data({ [SODIUM.id]: [sv('s061', 'mc1.20.1-0.6.1-fabric', '2024-10-01T10:00:00Z'), cur] })),
      'E-DEP-RANGE',
    );
    expect(f?.fixes[0]).toEqual({ kind: 'replace', jarId: 'mods/sodium.jar', versionId: 's061' });
  });

  it('offline, no context, or a .mrpack: nothing changes and nothing is requested', () => {
    const { input, findings } = setup('[6.0,)', '0.5.1.f', ctxWith(C_051F));
    const d = data({ [CREATE.id]: CREATE_VERSIONS });
    expect(enrichDepRangeFindings(findings, input, null, d)).toEqual(findings);
    expect(enrichDepRangeFindings(findings, input, ctxWith(C_051F, { offline: true }), d)).toEqual(findings);
    expect(depRangeRequests(findings, input, ctxWith(C_051F, { offline: true }), emptyDepRangeData())).toEqual([]);
    const packInput = { ...input, instance: { ...input.instance, launcher: 'mrpack' as const } };
    expect(enrichDepRangeFindings(findings, packInput, ctxWith(C_051F), d)).toEqual(findings);
    expect(depRangeRequests(findings, packInput, ctxWith(C_051F), emptyDepRangeData())).toEqual([]);
  });

  it('unknown pack loader or MC version → no advice', () => {
    const mr = ctxWith(C_051F);
    const { input, findings } = setup('[6.0,)', '0.5.1.f', mr, jars('[6.0,)', '0.5.1.f'), pack('forge', null, '47.3.0'));
    expect(depRangeRequests(findings, input, mr, emptyDepRangeData())).toEqual([]);
    expect(enrichDepRangeFindings(findings, input, mr, data({ [CREATE.id]: CREATE_VERSIONS }))).toEqual(findings);
  });

  it('depRangeVersions lists every fetched version with its project title (fix buttons)', () => {
    const out = depRangeVersions(data({ [CREATE.id]: [C_606] }), ctxWith(C_051F));
    expect(out).toEqual([{ version: C_606, title: 'Create' }]);
  });
});

describe('modVersionFromModrinth', () => {
  it.each<[string, string | null, string | null, string | null]>([
    ['6.0.6', '1.20.1', null, '6.0.6'],
    ['0.5.1.f', '1.20.1', null, '0.5.1.f'],
    ['mc1.20.1-0.5.13-fabric', '1.20.1', null, '0.5.13'],
    ['6.0.6+mc1.20.1', '1.20.1', null, '6.0.6'],
    ['1.20.1-6.0.6', '1.20.1', null, '6.0.6'],
    ['create-1.20.1-6.0.6', '1.20.1', 'create', '6.0.6'],
    ['forge-6.0.6', '1.20.1', null, '6.0.6'],
    ['v2.1', '1.20.1', null, '2.1'],
    ['6.0.6-1.20.1-neoforge', '1.20.1', null, '6.0.6'],
    ['6.0.6 for 1.20.1', '1.20.1', null, null],
    ['Big Update', '1.20.1', null, null],
    ['1.19.2-6.0.6', '1.20.1', null, null],
    ['6.0.6+1.19.2', '1.20.1', null, null],
    ['1.2.3', '1.20.1', null, '1.2.3'],
    ['3.1.0-beta.2', '1.20.1', null, '3.1.0-beta.2'],
  ])('%s (MC %s, slug %s) → %s', (n, mc, slug, expected) => {
    expect(modVersionFromModrinth(n, mc, slug)).toBe(expected);
  });
});
