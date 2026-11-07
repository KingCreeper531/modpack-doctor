/**
 * `.mrpack` declared files in the Modrinth flow (CONTRACTS invariant 15): `planQueries` identifies
 * them like top-level jars; `declaredMatch` gives their state with the jar rules.
 */
import { describe, expect, it } from 'vitest';
import type { DeclaredFile, ScanResult } from '../../../bindings';
import { fabric, nested, pack, scan } from '../../checks/__tests__/fixtures';
import type { ModrinthContext } from '../../model';
import { declaredMatch, jarMatch, planQueries } from '../index';
import { SHA_CLOTH, SHA_SODIUM_NEW, SHA_SODIUM_OLD, SHA_UNKNOWN, SODIUM, SODIUM_NEW, SODIUM_OLD } from './fixtures';

function declared(path: string, sha1: string): DeclaredFile {
  return { path, sha1, sha512: '0'.repeat(128), size: 1, client: 'required', server: 'required', downloads: [] };
}

function ctxOf(over: Partial<ModrinthContext> = {}): ModrinthContext {
  return { versions: {}, projects: {}, updates: {}, failed: [], offline: false, ...over };
}

describe('planQueries with declared files', () => {
  it('identifies declared sha1s with the top-level jars: lower-case, deduplicated, sorted, no empty hashes', () => {
    const jar = fabric({ file: 'sodium.jar', sha1: SHA_SODIUM_OLD });
    const child = nested(jar, { file: 'lib.jar', sha1: 'f'.repeat(40) }, 'fabric');
    const result: ScanResult = {
      ...scan(jar, child),
      declared: [declared('mods/cloth.jar', SHA_CLOTH.toUpperCase()), declared('mods/sodium.jar', ` ${SHA_SODIUM_OLD} `), declared('mods/none.jar', '')],
    };
    expect(planQueries(result, pack('fabric', '1.20.1')).identify).toEqual([SHA_CLOTH, SHA_SODIUM_OLD].sort());
  });

  it('tolerates a ScanResult without `declared` (older builds)', () => {
    const jar = fabric({ file: 'sodium.jar', sha1: SHA_SODIUM_OLD });
    const old = { instanceId: 'x', startedAtMs: 0, durationMs: 0, jars: [jar], issues: [] } as unknown as ScanResult;
    expect(planQueries(old, pack('fabric', '1.20.1')).identify).toEqual([SHA_SODIUM_OLD]);
  });
});

describe('declaredMatch', () => {
  const file = declared('mods/sodium.jar', SHA_SODIUM_OLD.toUpperCase());

  it.each<[string, ModrinthContext | null, string]>([
    ['no context', null, 'unknown'],
    ['offline', ctxOf({ offline: true }), 'unknown'],
    ['failed lookup', ctxOf({ failed: [SHA_SODIUM_OLD] }), 'unknown'],
    ['completed lookup, not found', ctxOf(), 'missing'],
    ['identified', ctxOf({ versions: { [SHA_SODIUM_OLD]: SODIUM_OLD }, projects: { [SODIUM.id]: SODIUM } }), 'matched'],
    ['identified with a newer update', ctxOf({ versions: { [SHA_SODIUM_OLD]: SODIUM_OLD }, updates: { [SHA_SODIUM_OLD]: SODIUM_NEW } }), 'update'],
  ])('%s → %s', (_name, ctx, state) => {
    expect(declaredMatch(file, ctx).state).toBe(state);
  });

  it('an empty sha1 is unknown, never missing', () => {
    expect(declaredMatch(declared('mods/x.jar', ''), ctxOf()).state).toBe('unknown');
  });

  it('matches jarMatch for the same hash', () => {
    const ctx = ctxOf({ versions: { [SHA_SODIUM_NEW]: SODIUM_NEW }, projects: { [SODIUM.id]: SODIUM } });
    const jar = fabric({ file: 'sodium.jar', sha1: SHA_SODIUM_NEW });
    expect(declaredMatch(declared('mods/sodium.jar', SHA_SODIUM_NEW), ctx)).toEqual(jarMatch(jar, ctx));
    expect(declaredMatch(declared('mods/u.jar', SHA_UNKNOWN), ctx)).toEqual(jarMatch(fabric({ file: 'u.jar', sha1: SHA_UNKNOWN }), ctx));
  });
});
