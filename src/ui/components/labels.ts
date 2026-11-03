/** Display words for contract enums (launchers, probe results, fixes, severities). Pure. */
import type { FixAction, Launcher, ProbeResult } from '../../bindings';
import type { Severity } from '../../core/model';
import { basename, formatInt } from './format';

/** Rail abbreviations (DESIGN.md §5). */
export const LAUNCHER_ABBR: Record<Launcher, string> = {
  modrinth: 'MR',
  prism: 'PR',
  multimc: 'MMC',
  curseforge: 'CF',
  vanilla: 'VAN',
  manual: 'DIR',
  mrpack: 'PACK',
};

export const LAUNCHER_NAME: Record<Launcher, string> = {
  modrinth: 'Modrinth App',
  prism: 'Prism Launcher',
  multimc: 'MultiMC',
  curseforge: 'CurseForge',
  vanilla: 'Minecraft Launcher',
  manual: 'Added folder',
  mrpack: '.mrpack file',
};

export type ProbeTone = 'faint' | 'dim' | 'ok' | 'err';

/** Empty-state result column (DESIGN.md §10). */
export function probeResult(r: ProbeResult): { text: string; tone: ProbeTone } {
  switch (r.state) {
    case 'notInstalled':
      return { text: 'not installed', tone: 'faint' };
    case 'found':
      return r.count === 0
        ? { text: '0 instances', tone: 'dim' }
        : { text: `${formatInt(r.count)} ${r.count === 1 ? 'instance' : 'instances'}`, tone: 'ok' };
    case 'permissionDenied':
      return { text: 'permission denied', tone: 'err' };
    case 'error':
      return { text: r.message, tone: 'err' };
  }
}

export const SEVERITY_WORD: Record<Severity, string> = { error: 'ERR', warning: 'WARN', info: 'INFO' };

/**
 * Default fix-button label. `names` maps jar ids to display names (mod name or file name);
 * unknown ids fall back to the jar's file name.
 */
export function fixLabel(fix: FixAction, names: Readonly<Record<string, string>> = {}): string {
  const name = (id: string) => names[id] ?? basename(id);
  switch (fix.kind) {
    case 'disable':
      return `Disable ${name(fix.jarId)}`;
    case 'enable':
      return `Enable ${name(fix.jarId)}`;
    case 'removeDuplicate':
      return `Remove ${name(fix.remove)}, keep ${name(fix.keep)}`;
    case 'replace':
      return `Replace ${name(fix.jarId)}`;
    case 'installDependency':
      return `Install ${fix.modId}`;
    case 'manual':
      return 'Show steps';
  }
}
