import { describe, expect, it } from 'vitest';

import type { MrProject, MrVersion } from '../../../bindings';
import { isModrinthPage } from '../external';
import { iconPathOf, iconSrc, isNetworkError, noticeParts, noticeText, projectUrl, sideSupport, updateWords } from '../modrinthState';

const project = (p: Partial<MrProject>): MrProject => ({
  id: 'P',
  slug: 'sodium',
  title: 'Sodium',
  projectType: 'mod',
  environment: [],
  clientSide: 'unknown',
  serverSide: 'unknown',
  iconPath: null,
  ...p,
});

describe('modrinth view helpers', () => {
  it('never lets a remote URL through as an icon', () => {
    const convert = (p: string) => `asset://${p}`;
    expect(iconSrc('C:\\cache\\icons\\a.png', convert)).toBe('asset://C:\\cache\\icons\\a.png');
    expect(iconSrc('C:\\cache\\icons\\a.png', null)).toBeNull();
    expect(iconSrc('https://cdn.modrinth.com/data/x/icon.png', convert)).toBeNull();
    expect(iconSrc('data:image/svg+xml,%3Csvg%2F%3E', null)).toBe('data:image/svg+xml,%3Csvg%2F%3E');
    expect(iconSrc(null, convert)).toBeNull();
  });

  it('words the notice (DESIGN §10) and the rate-limit countdown', () => {
    expect(noticeText(null, 0)).toBeNull();
    expect(noticeText({ kind: 'offline' }, 0)).toBe('Modrinth unreachable — static checks only');
    expect(noticeText({ kind: 'rateLimited', retryAt: 42_000 }, 0)).toBe('Modrinth rate limit · retrying in 42 s');
    expect(noticeText({ kind: 'rateLimited', retryAt: 1_000 }, 5_000)).toBe('Modrinth rate limit · retrying in 0 s');
    expect(noticeText({ kind: 'rateLimited', retryAt: null }, 0)).toBe('Modrinth rate limit — static checks only');
    expect(noticeText({ kind: 'partial' }, 0)).toBe('Modrinth: some lookups failed');
    expect(noticeText({ kind: 'failed' }, 0)).toBe('Modrinth lookup failed — static checks only');
  });

  it('keeps the countdown and the head; only optional words drop on a narrow strip', () => {
    const visible = (n: Parameters<typeof noticeParts>[0]) =>
      noticeParts(n, 0)!
        .filter((p) => !p.optional)
        .map((p) => p.text)
        .join('');
    expect(visible({ kind: 'rateLimited', retryAt: 42_000 })).toBe('Modrinth · retrying in 42 s');
    expect(visible({ kind: 'offline' })).toBe('Modrinth unreachable');
    expect(visible({ kind: 'partial' })).toBe('Modrinth: some lookups failed');
  });

  it('says "up to date" only when the lookup established it', () => {
    const filters = { loaders: ['forge'], gameVersions: ['1.20.1'] };
    const target = { loaderName: 'Forge', mcVersion: '1.20.1' };
    expect(updateWords('upToDate', filters, target)).toEqual({ tone: 'ok', text: 'up to date' });
    expect(updateWords('noCompatible', filters, target)).toEqual({ tone: 'dim', text: 'no version for Forge 1.20.1 on Modrinth' });
    expect(updateWords('unknown', filters, target).text).toBe('update check unavailable');
    expect(updateWords(undefined, filters, target).text).toBe('update check unavailable');
    expect(updateWords('upToDate', null, target).text).toBe('not checked (pack MC version or loader unknown)');
  });

  it('isNetworkError: only network and offline', () => {
    expect(['network', 'offline', 'rateLimited', 'internal', 'invalid'].map((kind) => isNetworkError({ kind: kind as never }))).toEqual([true, true, false, false, false]);
  });

  it('icon paths from the second pass win over the lookup’s', () => {
    expect(iconPathOf(project({ iconPath: null }), { P: 'C:\\icons\\P.png' })).toBe('C:\\icons\\P.png');
    expect(iconPathOf(project({ iconPath: 'C:\\icons\\old.png' }), {})).toBe('C:\\icons\\old.png');
    expect(iconPathOf(null, { P: 'x' })).toBeNull();
  });

  it('prefers the v3 environment over the legacy side fields', () => {
    const v = { environment: 'client_only' } as MrVersion;
    expect(sideSupport(v, project({ clientSide: 'required', serverSide: 'required' }))).toBe('client only');
    expect(sideSupport(null, project({ environment: ['server_only_client_optional'] }))).toBe('server; client optional');
    expect(sideSupport(null, project({ clientSide: 'required', serverSide: 'unsupported' }))).toBe('client required · server unsupported');
    expect(sideSupport(null, null)).toBe('unknown');
  });

  it('links only to project pages on modrinth.com', () => {
    expect(projectUrl({ slug: 'cloth-config' })).toBe('https://modrinth.com/mod/cloth-config');
    expect(isModrinthPage('https://modrinth.com/mod/cloth-config')).toBe(true);
    expect(isModrinthPage('https://modrinth.com.evil.example/mod/x')).toBe(false);
    expect(isModrinthPage('http://modrinth.com/mod/x')).toBe(false);
  });
});
