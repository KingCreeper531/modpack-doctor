/** Store-level E-DEP-RANGE advice: the store fetches Create's versions and the finding names one. */
import { describe, expect, it, vi } from 'vitest';

import type { MrVersion, ScanResult } from '../../../bindings';
import { runChecks } from '../../../core/checks';
import { forge } from '../../../core/checks/__tests__/fixtures';
import { mrVersion } from '../../../core/modrinth/__tests__/fixtures';
import type { Finding } from '../../../core/model';
import { fixLabel } from '../../components/labels';
import type { Result } from '../ipc';
import { MOCK_INSTANCES, mockJars } from '../mockData';
import { mockIdentifiedVersion } from '../mockModrinth';
import { fixVersions } from '../modrinthState';
import { rangeText } from '../../screens/inspector/Plate';
import { mockStore, until } from './helpers';

const ATM = MOCK_INSTANCES[0]!;
const CREATE_JAR = 'mods/create-1.20.1-0.5.1.f.jar';
const ADDON = forge({ file: 'create-addon-2.0.jar', mods: [{ id: 'createaddon', name: 'Create Addon', deps: [{ id: 'create', range: '[6.0,)' }] }] });

const depRange = (fs: readonly Finding[]) => fs.find((f) => f.code === 'E-DEP-RANGE' && f.culprits[0]?.modId === 'createaddon');

describe('E-DEP-RANGE advice in the store', () => {
  it('fetches the dependency project versions once and offers "Update Create to 6.0.6"', async () => {
    const m = mockStore({}, (input) => runChecks(input));
    const cmd = m.backend.commands;
    const scan = cmd.scanInstance.bind(cmd);
    vi.spyOn(cmd, 'scanInstance').mockImplementation(async (id: string) => {
      const r = (await scan(id)) as Result<ScanResult>;
      return r.status === 'ok' && id === ATM.id ? { status: 'ok', data: { ...r.data, jars: [...r.data.jars, ADDON] } } : r;
    });
    const createSha1 = mockJars(ATM.id).find((j) => j.id === CREATE_JAR)!.sha1;
    const createProject = mockIdentifiedVersion(createSha1)?.projectId ?? null;
    expect(createProject).not.toBeNull();
    const versions = cmd.modrinthProjectVersions.bind(cmd);
    const asked: string[] = [];
    vi.spyOn(cmd, 'modrinthProjectVersions').mockImplementation(async (projectId: string, loaders: string[], gameVersions: string[], types: string[]) => {
      asked.push(projectId);
      if (projectId !== createProject) return versions(projectId, loaders, gameVersions, types);
      const v = (id: string, n: string, date: string): MrVersion =>
        mrVersion({ id, projectId, versionNumber: n, datePublished: date, loaders: ['forge'], gameVersions: ['1.20.1'] });
      return { status: 'ok', data: [v('c606', '6.0.6', '2025-07-01T10:00:00Z'), v('c604', '6.0.4', '2025-03-01T10:00:00Z')] };
    });
    await m.store.getState().init();
    await until(() => m.store.getState().modrinth[ATM.id]?.status === 'done', 4000);
    await until(() => depRange(m.store.getState().scans[ATM.id]?.findings ?? [])?.fixes[0]?.kind === 'replace', 4000);
    const f = depRange(m.store.getState().scans[ATM.id]!.findings)!;
    expect(f.fixes[0]).toEqual({ kind: 'replace', jarId: CREATE_JAR, versionId: 'c606' });
    expect(f.title).toMatch(/ — switch Create to 6\.0\.6$/);
    const st = m.store.getState().modrinth[ATM.id]!;
    expect(fixLabel(f.fixes[0]!, {}, fixVersions(st.ctx, st.resolutions, st.depRange))).toBe('Update Create to 6.0.6');
    // Asked once per context for Create's project.
    expect(asked.filter((p) => p === createProject)).toHaveLength(1);
  });
});

describe('inspector range text', () => {
  it('shows an unfilled placeholder for what it is', () => {
    expect(rangeText({ syntax: 'maven', raw: ['[${create_version},)'], unrepresentable: null })).toBe(
      "[${create_version},) — any version (the mod's metadata has an unfilled placeholder: `${create_version}`)",
    );
    expect(rangeText({ syntax: 'maven', raw: ['[6.0,)'], unrepresentable: null })).toBe('[6.0,)');
    expect(rangeText({ syntax: 'fabric', raw: ['*'], unrepresentable: null })).toBe('any');
  });
});
