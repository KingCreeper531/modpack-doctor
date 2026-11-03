import { describe, expect, it } from 'vitest';
import { TITLE_NOT_ON_MODRINTH } from '../notOnModrinth';
import { fabric, forge, modrinth, mrVersion, nested, notes, only, pack, run } from './fixtures';

describe('W-CORRUPT-JAR', () => {
  const p = pack('forge', '1.20.1', '47.3.0');

  it('a damaged zip, a half-parsed jar and an unreadable jar are each reported', () => {
    const zip = forge({ file: 'broken.jar', status: { state: 'corrupt', reason: 'not a valid jar (zip) file: invalid Zip archive' } });
    const half = forge({ file: 'half.jar', mods: [{ id: 'half' }], status: { state: 'corrupt', reason: 'fabric.mod.json: trailing comma' } });
    const locked = forge({ file: 'locked.jar', status: { state: 'unreadable', reason: 'Access is denied. (os error 5)' } });
    const found = only(run([zip, half, locked], p), 'W-CORRUPT-JAR');
    expect(found.map((f) => [f.title, f.severity])).toEqual([
      ['broken.jar is damaged', 'warning'],
      ['half.jar is damaged', 'warning'],
      ['locked.jar cannot be read', 'warning'],
    ]);
    expect(found.every((f) => f.fixes[0]?.kind === 'manual')).toBe(true);
    expect(notes(found[2])[0]).toBe('Read error: Access is denied. (os error 5)');
  });

  it('a damaged nested jar is reported against its top-level jar', () => {
    const host = forge({ file: 'host.jar', mods: [{ id: 'host' }] });
    const bad = nested(host, { file: 'lib.jar', status: { state: 'corrupt', reason: 'bad zip' }, jarjar: { group: 'g', artifact: 'lib' } });
    const [f] = only(run([host, bad], p), 'W-CORRUPT-JAR');
    expect(f?.title).toBe('META-INF/jarjar/lib.jar inside host.jar is damaged');
    expect(f?.culprits).toEqual([{ jarId: 'mods/host.jar', fileName: 'host.jar' }]);
  });

  it('healthy and disabled jars are not reported', () => {
    const ok = forge({ file: 'ok.jar', mods: [{ id: 'ok' }] });
    const off = forge({ file: 'off.jar', disabled: true, status: { state: 'corrupt', reason: 'x' } });
    expect(only(run([ok, off], p), 'W-CORRUPT-JAR')).toEqual([]);
  });
});

describe('W-JAVA-CLASS', () => {
  it.each<[string, number, boolean]>([
    ['1.20.1', 65, true], // Java 21 classes, MC 1.20.1 ships Java 17
    ['1.20.1', 61, false], // Java 17
    ['1.20.6', 65, false], // 1.20.5+ needs Java 21
    ['1.16.5', 60, true], // Java 16 on a Java 8 version
    ['1.21.1', 69, true], // Java 25
  ])('MC %s with class major %i → %s', (mc, major, expected) => {
    const j = fabric({ file: 'm.jar', mods: [{ id: 'm' }], maxClassMajor: major });
    expect(only(run([j], pack('fabric', mc)), 'W-JAVA-CLASS')).toHaveLength(expected ? 1 : 0);
  });

  it('wording and manual fix', () => {
    const j = fabric({ file: 'modern.jar', mods: [{ id: 'm' }], maxClassMajor: 65 });
    const [f] = only(run([j], pack('fabric', '1.20.1')), 'W-JAVA-CLASS');
    expect(f?.title).toBe('modern.jar needs Java 21, but Minecraft 1.20.1 ships with Java 17');
    expect(f?.fixes[0]?.kind).toBe('manual');
  });

  it('a newer bundled jar is reported once against its parent', () => {
    const host = fabric({ file: 'host.jar', mods: [{ id: 'host' }], maxClassMajor: 61 });
    const inner = nested(host, { file: 'inner.jar', mods: [{ id: 'inner' }], maxClassMajor: 65 }, 'fabric');
    const found = only(run([host, inner], pack('fabric', '1.20.1')), 'W-JAVA-CLASS');
    expect(found).toHaveLength(1);
    expect(found[0]?.explanation).toContain('META-INF/jars/inner.jar (bundled in host.jar)');
  });

  it('unknown MC version or no sampled classes → nothing', () => {
    const j = fabric({ file: 'm.jar', mods: [{ id: 'm' }], maxClassMajor: 69 });
    expect(only(run([j], pack('fabric', null)), 'W-JAVA-CLASS')).toEqual([]);
    const none = fabric({ file: 'n.jar', mods: [{ id: 'n' }], maxClassMajor: null });
    expect(only(run([none], pack('fabric', '1.16.5')), 'W-JAVA-CLASS')).toEqual([]);
  });
});

describe('I-NOT-ON-MODRINTH', () => {
  const a = fabric({ file: 'a.jar', mods: [{ id: 'a' }] });
  const b = fabric({ file: 'b-curseforge.jar', mods: [{ id: 'b' }] });
  const c = fabric({ file: 'c-manual.jar', mods: [{ id: 'c' }] });
  const d = fabric({ file: 'd.jar', mods: [{ id: 'd' }] });
  const off = fabric({ file: 'off.jar', disabled: true, mods: [{ id: 'off' }] });
  const p = pack('fabric', '1.20.1');

  it('one info finding listing every unidentified active top-level jar; failed lookups are excluded', () => {
    const ctx = modrinth({ versions: { [a.sha1]: mrVersion({ projectId: 'A' }) }, failed: [d.sha1] });
    const found = only(run([a, b, c, d, off], p, ctx), 'I-NOT-ON-MODRINTH');
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ severity: 'info', title: TITLE_NOT_ON_MODRINTH, fixes: [] });
    expect(found[0]?.culprits.map((x) => x.fileName)).toEqual(['b-curseforge.jar', 'c-manual.jar']);
    expect(TITLE_NOT_ON_MODRINTH).toBe('Not on Modrinth (possibly CurseForge or manual)');
  });

  it('nothing without a Modrinth context, offline, or when everything was identified', () => {
    expect(only(run([a, b], p), 'I-NOT-ON-MODRINTH')).toEqual([]);
    expect(only(run([a, b], p, modrinth({ offline: true })), 'I-NOT-ON-MODRINTH')).toEqual([]);
    const all = modrinth({ versions: { [a.sha1]: mrVersion({ projectId: 'A' }), [b.sha1]: mrVersion({ projectId: 'B' }) } });
    expect(only(run([a, b], p, all), 'I-NOT-ON-MODRINTH')).toEqual([]);
  });

  it('nested jars are not listed', () => {
    const host = fabric({ file: 'host.jar', mods: [{ id: 'host' }] });
    const inner = nested(host, { file: 'inner.jar', mods: [{ id: 'inner' }] }, 'fabric');
    const ctx = modrinth({ versions: { [host.sha1]: mrVersion({ projectId: 'H' }) } });
    expect(only(run([host, inner], p, ctx), 'I-NOT-ON-MODRINTH')).toEqual([]);
  });
});
