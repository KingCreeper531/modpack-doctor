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

/** What a fix button knows about a Modrinth version (`replace` / `installDependency`). */
export interface FixVersionInfo {
  versionNumber: string;
  /** Not a release: labelled "(beta)" (CONTRACTS invariant 8). */
  beta: boolean;
  /** Modrinth project title. */
  title?: string;
}

/** Modrinth version id → facts, from the instance's Modrinth context and resolutions. */
export type FixVersions = Readonly<Record<string, FixVersionInfo>>;

/**
 * Default fix-button label. `names` maps jar ids to display names (mod name or file name);
 * unknown ids fall back to the jar's file name. `versions` names the Modrinth versions of
 * `replace` / `installDependency` fixes: `Update Sodium to 0.5.11`,
 * `Update Sodium to 0.6.0-beta.2 (beta)`, `Install Cloth Config 15.0.140`.
 */
export function fixLabel(fix: FixAction, names: Readonly<Record<string, string>> = {}, versions: FixVersions = {}): string {
  const name = (id: string) => names[id] ?? basename(id);
  const beta = (v: FixVersionInfo) => (v.beta ? ' (beta)' : '');
  switch (fix.kind) {
    case 'disable':
      return `Disable ${name(fix.jarId)}`;
    case 'enable':
      return `Enable ${name(fix.jarId)}`;
    case 'removeDuplicate':
      return `Remove ${name(fix.remove)}, keep ${name(fix.keep)}`;
    case 'replace': {
      const v = versions[fix.versionId];
      if (!v) return `Replace ${name(fix.jarId)}`;
      return `Update ${v.title ?? name(fix.jarId)} to ${v.versionNumber}${beta(v)}`;
    }
    case 'installDependency': {
      const v = versions[fix.versionId];
      if (!v) return `Install ${fix.modId}`;
      return `Install ${v.title ?? fix.modId} ${v.versionNumber}${beta(v)}`;
    }
    case 'manual':
      return 'Show steps';
  }
}

/** Severity a finding code's prefix implies (`E-` error, `W-` warning, `I-` info); `C-` implies none. */
export function codeSeverity(code: string): Severity | null {
  return code.startsWith('E-') ? 'error' : code.startsWith('W-') ? 'warning' : code.startsWith('I-') ? 'info' : null;
}

/** Short lowercase word shown after a code whose prefix disagrees with the finding's severity. */
export const SEVERITY_SHORT: Record<Severity, string> = { error: 'error', warning: 'warn', info: 'info' };

/**
 * The word to show after `code`, or null when the prefix already says it (or says nothing, as
 * `C-` codes don't). Checks may lower an `E-` code to warning or info (E-MC-RANGE on an
 * optional mod, E-DUP-ID between identical copies), which must not read as an error.
 */
export function severityQualifier(code: string, severity: Severity): string | null {
  const implied = codeSeverity(code);
  return implied === null || implied === severity ? null : SEVERITY_SHORT[severity];
}
