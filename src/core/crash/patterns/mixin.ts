/**
 * C-MIXIN: a mixin failed to apply. Strings from SpongePowered Mixin and the FabricMC fork
 * (crash-formats.md §3.2). The mixin config is mapped to its jar with `index.byMixinConfig`;
 * Fabric/Quilt messages also name the mod (`from mod coolmod`).
 */
import type { JarRecord } from '../../../bindings';
import type { CrashPattern, Finding, Severity } from '../../model';
import { ctxOf, disable, finding, gate, listText, logEvidence, manual, refs, traceAt, worst, type Ctx } from '../context';
import { jarByFileName, jarsForModId, jarsForPackage, jarLabel, uniqueTopLevel } from '../jars';
import { basename, normalizeClassName, packageOf, simpleName, truncate } from '../text';

const CFG = String.raw`([\w.$-]+\.json)`;
const MOD = String.raw`([\w.()-]+)`;

interface Hit {
  config?: string;
  mixin?: string;
  modId?: string;
  target?: string;
  error?: string;
}

const MATCHERS: readonly { re: RegExp; read(m: RegExpExecArray): Hit }[] = [
  {
    // FabricMC fork: Mixin apply for mod <modid> failed <cfg>:<Mixin> from mod <modid> -> <target>: <exClass> <msg>
    re: new RegExp(String.raw`Mixin apply for mod ${MOD} failed ${CFG}:([\w.$]+)(?: from mod ${MOD})? -> ([\w.$/]+): (.*)$`),
    read: (m) => ({ modId: m[1], config: m[2], mixin: m[3], target: m[5], error: m[6] }),
  },
  {
    // Upstream: Mixin apply failed <cfg>:<Mixin> -> <target>: <exClass> <msg>
    re: new RegExp(String.raw`Mixin apply failed ${CFG}:([\w.$]+) -> ([\w.$/]+): (.*)$`),
    read: (m) => ({ config: m[1], mixin: m[2], target: m[3], error: m[4] }),
  },
  {
    re: new RegExp(String.raw`Mixin prepare failed preparing ([\w.$]+) in ${CFG}: (.*)$`),
    read: (m) => ({ mixin: m[1], config: m[2], error: m[3] }),
  },
  {
    // MixinApplyError / MixinPrepareError: Mixin [cfg:M from mod x] from phase [P] in config [cfg] FAILED during APPLY
    re: new RegExp(String.raw`Mixin \[${CFG}:([\w.$]+)(?: from mod ${MOD})?\] from phase \[\w+\] in config \[[\w.$-]+\.json\] FAILED during (\w+)`),
    read: (m) => ({ config: m[1], mixin: m[2], modId: m[3], error: `failed during ${m[4] ?? 'APPLY'}` }),
  },
  {
    // Critical injection failure: <ann> <handler> in <cfg>:<Mixin>( from mod x)? failed injection check
    re: new RegExp(String.raw`Critical injection failure: (.*?) in ${CFG}:([\w.$]+)(?: from mod ${MOD})? failed injection check`),
    read: (m) => ({ config: m[2], mixin: m[3], modId: m[4], error: `Critical injection failure: ${m[1] ?? ''}` }),
  },
  {
    // InvalidInjectionException / InvalidMixinException: … [PHASE -> cfg:Mixin( from mod x)? -> …]
    re: new RegExp(String.raw`(Invalid(?:Injection|Mixin|Accessor)Exception|Critical injection failure)(.*?)\[[^\]]*?-> ${CFG}:([\w.$]+)(?: from mod ${MOD})? ->`),
    read: (m) => ({ config: m[3], mixin: m[4], modId: m[5], error: `${m[1] ?? ''}${m[2] ?? ''}`.trim() }),
  },
  {
    re: new RegExp(String.raw`Error encountered whilst initialising mixin config '${CFG}'(?:: (.*))?`),
    read: (m) => ({ config: m[1], error: m[2] ?? 'config could not be initialised' }),
  },
  {
    // Wrappers without a config: their cause usually carries one; kept as a fallback.
    re: /Mixin transformation of ([\w.$/]+) failed/,
    read: (m) => ({ target: m[1] }),
  },
  {
    re: /MixinTransformerError: An unexpected critical error was encountered/,
    read: () => ({}),
  },
];

const DUPLICATE_CONFIG = new RegExp(String.raw`A mixin config named ${CFG} is provided by both (\S+) and (\S+)`);

interface Group {
  key: string;
  config?: string;
  mixins: Set<string>;
  modId?: string;
  target?: string;
  error?: string;
  lineIdx: number[];
  severity: Severity | null;
}

function clean(text: string | undefined): string | undefined {
  const t = text?.trim();
  return t ? t : undefined;
}

function cleanMod(modId: string | undefined): string | undefined {
  const t = clean(modId);
  return t && t !== '(unknown)' ? t : undefined;
}

function isMinecraftClass(cls: string): boolean {
  return /^(?:net\.minecraft\.|com\.mojang\.)/.test(cls);
}

function configJars(ctx: Ctx, g: Group): JarRecord[] {
  const index = ctx.index;
  if (!index) return [];
  const byConfig = g.config ? (index.byMixinConfig.get(g.config) ?? []) : [];
  if (byConfig.length > 0) return uniqueTopLevel(byConfig, index);
  return g.modId ? uniqueTopLevel(jarsForModId(g.modId, index), index) : [];
}

function toFinding(ctx: Ctx, g: Group): Finding | null {
  if (!g.severity) return null;
  const owners = configJars(ctx, g);
  const index = ctx.index;
  const target = g.target ? normalizeClassName(g.target) : undefined;
  const targetJars =
    index && target && !isMinecraftClass(target)
      ? uniqueTopLevel(jarsForPackage(packageOf(target), index, true), index).filter((j) => !owners.some((o) => o.id === j.id))
      : [];
  const culprits = refs(ctx, [...owners, ...targetJars.slice(0, 1)], g.modId);
  const guessedMod = g.modId ?? (g.config ? g.config.replace(/(?:[.-]mixins?)?\.json$/, '').split('.')[0] : undefined);
  const ownerLabel = owners[0] ? `${jarLabel(owners[0], g.modId)} (${owners[0].fileName})` : (guessedMod ?? 'an unknown mod');
  const mixinText = g.mixins.size > 0 ? listText([...g.mixins]) : undefined;
  const title = g.config
    ? `Mixin ${mixinText ? `${mixinText} ` : ''}from ${owners[0] ? jarLabel(owners[0], g.modId) : (guessedMod ?? g.config)} failed${target ? ` on ${simpleName(target)}` : ''}`
    : `A mixin failed to transform ${target ? simpleName(target) : 'a class'}`;
  const parts = [
    g.config
      ? `The mixin config ${g.config}${mixinText ? ` (${mixinText})` : ''} from ${ownerLabel} could not be applied${target ? ` to ${target}` : ''}.`
      : `Mixin could not transform ${target ?? 'a class'}; the log does not name the mixin config.`,
    g.error ? `Error: ${truncate(g.error, 220)}.` : '',
    targetJars[0]
      ? `The target class belongs to ${jarLabel(targetJars[0])} (${targetJars[0].fileName}); the two mods are probably incompatible versions.`
      : 'This usually means the mod is built for a different Minecraft or loader version, or another mod changed the same code.',
  ];
  const owner = culprits[0];
  const fixes = owner
    ? [...disable(owner), manual(`Update ${owner.modId ?? owner.fileName} to a build for this Minecraft and loader version, or keep it disabled.`)]
    : [manual(`Find the mod that ships ${g.config ?? 'the failing mixin'} and update or remove it.`)];
  return finding(ctx, {
    code: 'C-MIXIN',
    severity: g.severity,
    title,
    explanation: parts.filter(Boolean).join(' '),
    culprits,
    evidence: [logEvidence(ctx, g.lineIdx, { context: 2 })],
    fixes,
    discriminator: g.config ?? `target:${target ?? 'unknown'}`,
    unresolved: owners.length === 0 && guessedMod ? [g.config ?? guessedMod] : [],
  });
}

function duplicateConfigFindings(ctx: Ctx): Finding[] {
  const out: Finding[] = [];
  ctx.lines.forEach((l, i) => {
    const m = DUPLICATE_CONFIG.exec(l.text);
    if (!m) return;
    const severity = gate(ctx, i, { fatal: true });
    if (!severity) return;
    const files = [basename(m[2] ?? ''), basename(m[3] ?? '')];
    const jars = ctx.index ? files.map((f) => (ctx.index ? jarByFileName(f, ctx.index) : undefined)) : [];
    const culprits = refs(ctx, jars);
    out.push(
      finding(ctx, {
        code: 'C-MIXIN',
        severity,
        title: `Two jars ship the mixin config ${m[1] ?? ''}`,
        explanation: `${listText(files)} both provide ${m[1] ?? 'the same mixin config'}. This is usually the same mod installed twice; keep one.`,
        culprits,
        evidence: [logEvidence(ctx, [i])],
        fixes: [manual(`Remove one of ${listText(files)} (keep the newer one).`)],
        discriminator: `dup:${m[1] ?? ''}`,
        unresolved: culprits.length < 2 ? files : [],
      }),
    );
  });
  return out;
}

/**
 * A matched line is often a wrapper (`MixinApplyError … FAILED during APPLY`); the reason is the
 * innermost cause of the same stack trace (`InvalidMixinException: @Shadow field … was not
 * located…`). Mark that line as a culprit too and prefer its message as the error.
 */
function addInnermostCause(ctx: Ctx, g: Group): void {
  for (const i of [...g.lineIdx]) {
    const trace = traceAt(ctx, i);
    const inner = trace?.segments[trace.segments.length - 1];
    if (!inner || inner.idx <= i || g.lineIdx.includes(inner.idx)) continue;
    g.lineIdx.push(inner.idx);
    if (!g.error || /^failed during /.test(g.error)) {
      g.error = `${simpleName(inner.cls)}${inner.message ? `: ${inner.message}` : ''}`;
    }
  }
  g.lineIdx.sort((a, b) => a - b);
}

export const mixinPattern: CrashPattern = {
  id: 'mixin',
  codes: ['C-MIXIN'],
  anchors: [
    'Mixin apply failed',
    'Mixin apply for mod ',
    'Mixin prepare failed',
    'FAILED during APPLY',
    'FAILED during PREPARE',
    'MixinTransformerError',
    'MixinApplyError',
    'MixinPrepareError',
    'InvalidInjectionException',
    'InvalidMixinException',
    'Critical injection failure',
    'An unexpected critical error was encountered',
    'Mixin transformation of ',
    'was not located in the target class',
    'Error encountered whilst initialising mixin config',
    'is provided by both',
  ],
  match(input) {
    const ctx = ctxOf(input);
    const groups = new Map<string, Group>();
    const loose: Group = { key: '', mixins: new Set(), lineIdx: [], severity: null };
    ctx.lines.forEach((l, i) => {
      for (const { re, read } of MATCHERS) {
        const m = re.exec(l.text);
        if (!m) continue;
        const hit = read(m);
        const sev = gate(ctx, i);
        if (!sev) return;
        const config = clean(hit.config);
        const g = config
          ? (groups.get(config) ??
            (() => {
              const created: Group = { key: config, config, mixins: new Set(), lineIdx: [], severity: null };
              groups.set(config, created);
              return created;
            })())
          : loose;
        const mixin = clean(hit.mixin);
        if (mixin) g.mixins.add(mixin);
        g.modId ??= cleanMod(hit.modId);
        g.target ??= clean(hit.target);
        g.error ??= clean(hit.error);
        g.lineIdx.push(i);
        g.severity = worst(g.severity, sev);
        return;
      }
    });
    for (const g of [...groups.values(), loose]) addInnermostCause(ctx, g);
    const found = [...groups.values()].flatMap((g) => toFinding(ctx, g) ?? []);
    if (found.length === 0 && loose.lineIdx.length > 0) {
      const f = toFinding(ctx, loose);
      if (f) found.push(f);
    }
    return [...found, ...duplicateConfigFindings(ctx)];
  },
};
