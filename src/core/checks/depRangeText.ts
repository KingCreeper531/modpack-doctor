/**
 * Wording of an E-DEP-RANGE finding about a mod dependency (depRange.ts), without Modrinth:
 * the required range in words AND the installed version, and what to switch to —
 * "Create Slice & Dice needs Create 6.0 or newer; you have 0.5.1.f (create-0.5.1.f.jar)" and
 * "Switch Create to 6.0 or newer …". With Modrinth, `src/core/modrinth/depRangeFix.ts` adds the
 * concrete version (and a `replace` fix) on top of this text.
 */
import type { Dependency, FixAction } from '../../bindings';
import { LOADER_NAMES } from '../pack';
import { rangePlaceholders } from '../version/placeholders';
import { rangeInWords } from '../version/words';
import type { CheckContext, ModEntry } from './context';
import { disable, entryLabel, manual, modName, rawRange } from './evidence';

/** Display name of a dependency: the providing mod's name when every provider agrees, else `"id"`. */
export function dependencyName(depId: string, providers: readonly ModEntry[]): string {
  const names = [...new Set(providers.map((p) => p.mod.name?.trim() ?? '').filter((n) => n.length > 0))];
  return names.length === 1 && names[0] ? names[0] : `"${depId}"`;
}

/** "Forge 1.20.1", "Fabric", or null when the pack's loader is unknown. */
export function packTarget(ctx: CheckContext): string | null {
  const loader = ctx.pack.loader;
  if (!loader || loader.kind === 'unknown') return null;
  const mc = ctx.pack.mcVersion?.trim();
  return mc ? `${LOADER_NAMES[loader.kind]} ${mc}` : LOADER_NAMES[loader.kind];
}

function where(p: ModEntry): string {
  return p.jar.depth === 0 ? p.jar.fileName : `${p.jar.fileName}, bundled in ${p.top.fileName}`;
}

export interface DepRangeText {
  title: string;
  explanation: string;
  /** Evidence note naming what is installed. */
  installedNote: string;
  fixes: FixAction[];
}

export function depRangeText(ctx: CheckContext, e: ModEntry, dep: Dependency, providers: readonly ModEntry[]): DepRangeText {
  const name = modName(e.mod);
  const depName = dependencyName(dep.modId, providers);
  const wants = rangeInWords(dep.range);
  const raw = rawRange(dep.range);
  const versions = [...new Set(providers.map((p) => p.mod.version))];
  const have = versions.join(' / ') || 'another version';
  const first = providers[0];
  const haveShort = first ? `${first.mod.version} (${where(first)})` : 'another version';
  const installed = providers.map((p) => `${p.mod.version} in ${where(p)}`).join('; ');
  const target = packTarget(ctx);
  const forPack = target ? ` made for ${target}` : '';
  const optional = dep.kind === 'optional' ? ' (optional, but enforced when installed)' : '';
  const bundled = first && first.jar.depth > 0;
  const placeholders = rangePlaceholders(dep.range);
  if (placeholders.length > 0) {
    // Only reached when the loader rejects every real version (Fabric literal match, FML `(,${x})`).
    const tokens = placeholders.map((t) => `\`${t}\``).join(', ');
    return {
      title: `${name}'s dependency on ${depName} is an unfilled placeholder (${tokens}) that no version matches; you have ${haveShort}`,
      explanation:
        `${entryLabel(e)} was published with an unfilled build placeholder in its dependency on ${depName} (${raw}), so the loader ` +
        `matches no real ${depName} version and refuses to start. This is a packaging mistake in ${name}, not in your ${depName}. ` +
        `Use another build of ${name}${target ? ` for ${target}` : ''}, or report it to its author.`,
      installedNote: `Installed ${depName}: ${installed || have}.`,
      fixes: [manual(`Replace ${e.top.fileName} with another build of ${name}${target ? ` for ${target}` : ''}; this one declares ${depName} as ${raw}.`), disable(e.top)],
    };
  }
  const switchStep = bundled
    ? `Switch ${depName} to ${wants} (${raw})${forPack}: it is bundled in ${first.top.fileName}, so install a standalone ${depName} in that range or update ${first.top.fileName}.`
    : `Switch ${depName} to ${wants} (${raw})${forPack}${first ? `: replace ${first.top.fileName} with it` : ''}.`;
  return {
    title: `${name} needs ${depName} ${wants}; you have ${haveShort}`,
    explanation:
      `${entryLabel(e)} depends on ${depName} ${wants} (${raw})${optional}. You have ${depName} ${installed || have}, which is outside that range, ` +
      `so the loader refuses to start or the mods crash on missing classes or methods. ` +
      `Switch ${depName} to ${wants}, or use a version of ${name} made for ${depName} ${have}.`,
    installedNote: `Installed ${depName}: ${installed || have}.`,
    fixes: [manual(switchStep, `Or use a version of ${name} made for ${depName} ${have}.`), disable(e.top)],
  };
}
