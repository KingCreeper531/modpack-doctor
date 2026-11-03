/**
 * C-RESOLUTION: JPMS split packages / duplicate modules on Forge (1.17+) and NeoForge
 * (crash-formats.md §3.3). Every phrasing names two modules; both are mapped to jars, and the
 * package itself is looked up in the index (the jars that really contain it).
 */
import type { JarRecord } from '../../../bindings';
import type { CrashPattern, Finding, Severity } from '../../model';
import { ctxOf, finding, gate, listText, logEvidence, manual, refs, worst, type Ctx } from '../context';
import { jarLabel, jarsForModule, jarsForPackage, uniqueTopLevel } from '../jars';
import { fatal } from '../tiers';

interface Conflict {
  /** Package, or `module:<name>` for duplicate modules. */
  key: string;
  pkg?: string;
  modules: string[];
  /** Innocent module that reads the package (first phrasing's `to module C`). */
  reader?: string;
  lineIdx: number[];
  severity: Severity | null;
}

const NAME = String.raw`([\w.$-]+)`;
const PHRASES: readonly { re: RegExp; read(m: RegExpExecArray): Omit<Conflict, 'key' | 'lineIdx' | 'severity'> }[] = [
  {
    // Modules A and B export package P to module C
    re: new RegExp(String.raw`Modules ${NAME} and ${NAME} export package ${NAME} to module ${NAME}`),
    read: (m) => ({ modules: [m[1] ?? '', m[2] ?? ''], pkg: m[3] ?? '', reader: m[4] ?? '' }),
  },
  {
    // Module A contains package P, module B exports package P to A
    re: new RegExp(String.raw`Module ${NAME} contains package ${NAME}, module ${NAME} exports package ${NAME} to ${NAME}`),
    read: (m) => ({ modules: [m[1] ?? '', m[3] ?? ''], pkg: m[2] ?? '' }),
  },
  {
    // Module X reads package Y from both A and B (owner's spec; not in JDK 11/17/21 sources)
    re: new RegExp(String.raw`Module ${NAME} reads package ${NAME} from both ${NAME} and ${NAME}`),
    read: (m) => ({ modules: [m[3] ?? '', m[4] ?? ''], pkg: m[2] ?? '', reader: m[1] ?? '' }),
  },
  {
    // Module A reads more than one module named B / reads another module named B
    re: new RegExp(String.raw`Module ${NAME} reads (?:more than one module|another module) named ${NAME}`),
    read: (m) => ({ modules: [m[2] ?? ''], reader: m[1] ?? '' }),
  },
  {
    // LayerInstantiationException: Package P in more than one module / cannot be imported from multiple loaders
    re: new RegExp(String.raw`Package ${NAME} (?:in more than one module|cannot be imported from multiple loaders)`),
    read: (m) => ({ modules: [], pkg: m[1] ?? '' }),
  },
];

function trimName(name: string): string {
  return name.replace(/[.,;:]+$/, '');
}

function jarsFor(ctx: Ctx, c: Conflict): { jars: JarRecord[]; unresolved: string[] } {
  const index = ctx.index;
  if (!index) return { jars: [], unresolved: [] };
  const unresolved: string[] = [];
  const found: JarRecord[] = [];
  if (c.pkg) found.push(...jarsForPackage(c.pkg, index));
  for (const mod of c.modules) {
    const js = jarsForModule(mod, index);
    if (js.length === 0) unresolved.push(mod);
    // A duplicate-module error names one module twice: keep every copy.
    found.push(...(c.pkg ? js.slice(0, 1) : js));
  }
  // Modules that map to no jar stay named (in a note) even when the other side resolved.
  return { jars: uniqueTopLevel(found, index), unresolved };
}

function toFinding(ctx: Ctx, c: Conflict): Finding | null {
  if (!c.severity) return null;
  const { jars, unresolved } = jarsFor(ctx, c);
  const culprits = refs(ctx, jars);
  const names = jars.length >= 2 ? jars.map((j) => `${jarLabel(j)} (${j.fileName})`) : c.modules;
  const who = listText(names.length > 0 ? names : ['two jars']);
  const title = c.pkg
    ? `Package ${c.pkg} is provided by ${names.length >= 2 ? listText(jars.map((j) => j.fileName)) : listText(c.modules)}`
    : `Module ${c.modules[0] ?? ''} is loaded twice`;
  const explanation = c.pkg
    ? `Forge/NeoForge load mods as Java modules, and a package may only come from one of them. ${who} both contain ${c.pkg}${c.reader ? ` (needed by ${c.reader}, which is probably innocent)` : ''}. Usually two copies of the same library, or a mod that bundles a library another jar also provides.`
    : `Two jars declare the module ${c.modules[0] ?? ''}${c.reader ? ` (read by ${c.reader})` : ''}. This is a duplicate jar or library (for example two copies of the same mod, or a library a mod already bundles).`;
  return finding(ctx, {
    code: 'C-RESOLUTION',
    severity: c.severity,
    title,
    explanation,
    culprits,
    evidence: [logEvidence(ctx, c.lineIdx, { context: 3 })],
    fixes: [
      manual(
        `Remove or update one of ${who}; keep the one other mods depend on.`,
        'If one of them is a standalone library jar that another mod already bundles, remove the standalone copy.',
      ),
    ],
    discriminator: c.key,
    unresolved,
  });
}

export const resolutionPattern: CrashPattern = {
  id: 'jpms-resolution',
  codes: ['C-RESOLUTION'],
  // All fatal (owner's list): the module layer cannot be built, so the game never starts. The
  // phrasings are JDK Resolver / module-loader messages that only appear in that failure.
  anchors: fatal(
    'java.lang.module.ResolutionException',
    'LayerInstantiationException',
    'export package ',
    'exports package ',
    'reads package ',
    'reads more than one module named',
    'reads another module named',
    'in more than one module',
    'cannot be imported from multiple loaders',
  ),
  match(input) {
    const ctx = ctxOf(input);
    const conflicts = new Map<string, Conflict>();
    ctx.lines.forEach((l, i) => {
      for (const { re, read } of PHRASES) {
        const m = re.exec(l.text);
        if (!m) continue;
        const raw = read(m);
        const pkg = raw.pkg ? trimName(raw.pkg) : undefined;
        const modules = raw.modules.map(trimName).filter(Boolean);
        const key = pkg ?? `module:${modules[0] ?? ''}`;
        const c = conflicts.get(key) ?? { key, modules: [], lineIdx: [], severity: null };
        if (pkg) c.pkg = pkg;
        for (const mod of modules) if (!c.modules.includes(mod)) c.modules.push(mod);
        if (raw.reader && !c.reader) c.reader = trimName(raw.reader);
        c.lineIdx.push(i);
        c.severity = worst(c.severity, gate(ctx, i, { fatal: true }));
        conflicts.set(key, c);
        return;
      }
    });
    return [...conflicts.values()].flatMap((c) => toFinding(ctx, c) ?? []);
  },
};
