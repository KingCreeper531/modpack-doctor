/**
 * `Finding.missingModIds` on the two producers (E-MISSING-DEP, C-MISSING-MANDATORY): the loader
 * mod id as declared (lower-case), deduplicated and sorted; finding ids unchanged.
 */
import { describe, expect, it } from 'vitest';
import { fabric, forge, neoforge, only, pack, quilt, run } from '../../checks/__tests__/fixtures';
import { analyze, jar, text } from '../../crash/__tests__/helpers';
import { findingId } from '../../crash/id';
import { missingModIds } from '../index';

describe('E-MISSING-DEP missingModIds', () => {
  it.each([
    ['fabric', () => fabric({ file: 'sodium-extra.jar', mods: [{ id: 'sodium-extra', deps: [{ id: 'sodium', range: '>=0.5.0' }] }] }), pack('fabric', '1.20.1', '0.16.5'), 'sodium-extra', 'sodium'],
    ['quilt', () => quilt({ file: 'q.jar', mods: [{ id: 'qmod', deps: [{ id: 'qsl' }] }] }), pack('quilt', '1.20.1', '0.26.0'), 'qmod', 'qsl'],
    ['forge', () => forge({ file: 'coolmod.jar', mods: [{ id: 'coolmod', deps: [{ id: 'architectury', range: '[9.1.12,)' }] }] }), pack('forge', '1.20.1', '47.3.0'), 'coolmod', 'architectury'],
    ['neoforge', () => neoforge({ file: 'n.jar', mods: [{ id: 'nmod', deps: [{ id: 'geckolib', range: '[4.4,)' }] }] }), pack('neoforge', '1.21.1', '21.1.77'), 'nmod', 'geckolib'],
    ['mixed-case declaration', () => forge({ file: 'old.jar', mods: [{ id: 'oldmod', deps: [{ id: 'CoolLib' }] }] }), pack('forge', '1.20.1', '47.3.0'), 'oldmod', 'coollib'],
  ])('%s: names the absent id; id unchanged', (_name, make, p, requester, expected) => {
    const j = make();
    const [f, ...rest] = only(run([j], p), 'E-MISSING-DEP');
    expect(rest).toEqual([]);
    expect(f?.missingModIds).toEqual([expected]);
    // Original declared id (case kept) in the discriminator, as before.
    const declared = j.mods[0]?.deps.find((d) => d.modId.toLowerCase() === expected)?.modId;
    expect(f?.id).toBe(findingId('E-MISSING-DEP', [j.id], `${requester}->${declared}`));
  });

  it('one finding per missing dependency, each with its own id', () => {
    const j = fabric({ file: 'big.jar', mods: [{ id: 'big', deps: [{ id: 'fabric-api' }, { id: 'cloth-config' }] }] });
    const fs = only(run([j], pack('fabric', '1.20.1', '0.16.5')), 'E-MISSING-DEP');
    expect(fs.map((f) => f.missingModIds)).toEqual(expect.arrayContaining([['fabric-api'], ['cloth-config']]));
    expect(missingModIds(fs)).toEqual(['cloth-config', 'fabric-api']);
  });

  it('is absent on other static findings', () => {
    const j = fabric({ file: 'x.jar', mods: [{ id: 'x', mc: '~1.19.2', deps: [{ id: 'y', range: '>=2.0' }] }] });
    const y = fabric({ file: 'y.jar', mods: [{ id: 'y', version: '1.0.0' }] });
    const fs = run([j, y], pack('fabric', '1.20.1', '0.16.5'));
    expect(fs.length).toBeGreaterThan(0);
    expect(fs.every((f) => f.missingModIds === undefined)).toBe(true);
  });
});

describe('C-MISSING-MANDATORY missingModIds', () => {
  const jars = [
    jar({ file: 'coolmod-1.0.jar', mods: [['coolmod', 'Cool Mod']] }),
    jar({ file: 'otherthing-2.0.jar', mods: [['otherthing']] }),
    jar({ file: 'oldmod-1.19.2-1.0.jar', mods: [['oldmod']] }),
    jar({ file: 'mobsplus-3.0.jar', mods: [['mobsplus']] }),
    jar({ file: 'geckolib-forge-1.20.1-4.2.1.jar', mods: [['geckolib', 'GeckoLib 4']] }),
  ];
  const log = text(
    '[30Oct2026 18:00:05.112] [main/ERROR] [net.minecraftforge.fml.loading.ModSorter/LOADING]: Missing or unsupported mandatory dependencies:',
    "\tMod ID: 'architectury', Requested by: 'coolmod', Expected range: '[9.1.12,)', Actual version: '[MISSING]'",
    "\tMod ID: 'architectury', Requested by: 'otherthing', Expected range: '[9.0,)', Actual version: '[MISSING]'",
    "\tMod ID: 'neoforge', Requested by: 'mobsplus', Expected range: '[20.4,)', Actual version: '[MISSING]'",
    "\tMod ID: 'minecraft', Requested by: 'oldmod', Expected range: '[1.19.2,1.19.3)', Actual version: '1.20.1'",
    "\tMod ID: 'geckolib', Requested by: 'mobsplus', Expected range: '[4.4,)', Actual version: '4.2.1'",
  );

  it('only the "not installed" finding carries the id; platform and version mismatches do not; ids unchanged', () => {
    const fs = only(analyze(log, 'latestLog', jars), 'C-MISSING-MANDATORY');
    const arch = fs.find((f) => f.title.includes('architectury'));
    expect(arch?.missingModIds).toEqual(['architectury']);
    expect(arch?.id).toBe(findingId('C-MISSING-MANDATORY', ['mods/coolmod-1.0.jar', 'mods/otherthing-2.0.jar'], 'missing:architectury'));
    const others = fs.filter((f) => f !== arch);
    expect(others.length).toBe(3);
    expect(others.every((f) => f.missingModIds === undefined)).toBe(true);
    expect(missingModIds(fs)).toEqual(['architectury']);
  });

  it('translated NeoForge text', () => {
    const body = text(
      '[18:00:05] [main/FATAL] [x/]: Mod loading has failed',
      'net.neoforged.fml.ModLoadingException: Loading errors encountered:',
      '\t- Mod coolmod requires architectury 13.0.0 or above',
      '\t  Currently, architectury is not installed',
      '\t- Mod otherthing requires cloth_config 15.0 or above',
      '\t  Currently, cloth_config is not installed',
    );
    const fs = only(analyze(body, 'latestLog', jars), 'C-MISSING-MANDATORY');
    expect(fs.map((f) => f.missingModIds)).toEqual(expect.arrayContaining([['architectury'], ['cloth_config']]));
    expect(missingModIds(fs)).toEqual(['architectury', 'cloth_config']);
  });
});
