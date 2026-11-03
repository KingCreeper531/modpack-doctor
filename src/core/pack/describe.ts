import type { PackContext } from '../model';
import { LOADER_NAMES } from './loaders';

const SOURCE_TEXT: Readonly<Record<PackContext['source'], string>> = {
  override: 'from your override',
  launcher: 'from launcher metadata',
  mrpack: 'from the .mrpack index',
  majority: 'inferred from the installed mods',
  unknown: 'not known',
};

/** "Forge 47.3.0", "Fabric (version unknown)", "Vanilla", "an unknown loader". */
export function describeLoader(pack: PackContext): string {
  const l = pack.loader;
  if (l === null) return pack.source === 'launcher' || pack.source === 'mrpack' ? 'Vanilla' : 'an unknown loader';
  const name = LOADER_NAMES[l.kind];
  if (l.kind === 'unknown') return name;
  return l.version ? `${name} ${l.version}` : `${name} (version unknown)`;
}

/** e.g. "Pack: Forge 47.3.0 on Minecraft 1.20.1 (from launcher metadata)". */
export function describePack(pack: PackContext): string {
  const mc = pack.mcVersion ? `Minecraft ${pack.mcVersion}` : 'an unknown Minecraft version';
  const side = pack.side === 'server' ? ', server' : '';
  return `Pack: ${describeLoader(pack)} on ${mc}${side} (${SOURCE_TEXT[pack.source]})`;
}
