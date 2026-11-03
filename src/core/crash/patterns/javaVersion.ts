/**
 * C-JAVA-VERSION: the game runs on the wrong Java (crash-formats.md §3.9).
 * - `UnsupportedClassVersionError: X has been compiled by a more recent version of the Java
 *   Runtime (class file version 65.0), this version … only recognizes class file versions up to 61.0`
 * - Java 7-era `Unsupported major.minor version 52.0`
 * - Fabric/Quilt builtin `java` dependency: `… requires version 21 or later of 'OpenJDK …' (java),
 *   but only the wrong version is present: 17!`
 * - LaunchWrapper (1.12.2) on Java 9+: `… cannot be cast to class java.net.URLClassLoader`
 * - generic loader text `requires Java 21` / `Java 21 or newer is required`.
 */
import type { CrashPattern, Finding, Severity } from '../../model';
import { ctxOf, disable, finding, gate, logEvidence, manual, refs, worst, type Ctx } from '../context';
import { jarLabel, jarsForModId, jarsForPackage, topLevel } from '../jars';
import { javaFeatureForClassMajor, minJavaForMinecraft } from '../javaVersions';
import { normalizeClassName, packageOf } from '../text';
import { contextual, fatal } from '../tiers';

const CLASS_VERSION = /UnsupportedClassVersionError: ([\w$/.]+) has been compiled by a more recent version of the Java Runtime \(class file version (\d+)(?:\.\d+)?\), this version of the Java Runtime only recognizes class file versions up to (\d+)(?:\.\d+)?/;
const OLD_MAJOR = /UnsupportedClassVersionError: ([\w$/.]+) : Unsupported major\.minor version (\d+)\.\d+|Unsupported major\.minor version (\d+)\.\d+/;
const FABRIC_JAVA = /(?:[Mm]od )?'([^']+)' \(([\w.-]+)\) (\S+) requires (.+?) of '[^']*' \(java\), but only the wrong version is present: (\d+)/;
const LAUNCHWRAPPER = /cannot be cast to class java\.net\.URLClassLoader/;
const GENERIC = /(?:requires|needs) Java (\d+)(?: or (?:newer|later|above))?|Java (\d+) (?:or (?:newer|later|above) )?is required/;

interface Hit {
  needed: number | null;
  current: number | null;
  /** Mod that needs the newer Java (null for Minecraft/loader itself). */
  modId?: string;
  cls?: string;
  legacy?: boolean;
  lineIdx: number[];
  severity: Severity | null;
}

function parseRequiredJava(range: string): number | null {
  const m = /(\d+)/.exec(range);
  return m ? Number(m[1]) : null;
}

function toFinding(ctx: Ctx, h: Hit): Finding | null {
  if (!h.severity) return null;
  const index = ctx.index;
  const mcMin = ctx.mcVersion ? minJavaForMinecraft(ctx.mcVersion) : null;
  const evidence = [logEvidence(ctx, h.lineIdx, { context: 2 })];

  if (h.legacy) {
    return finding(ctx, {
      code: 'C-JAVA-VERSION',
      severity: h.severity,
      title: 'This Minecraft version needs Java 8',
      explanation:
        'The legacy launcher (Minecraft 1.12.2 and older with Forge) cannot run on Java 9 or newer; it expects its class loader to be a URLClassLoader.',
      culprits: [],
      evidence,
      fixes: [manual('Install Java 8 (64-bit) and select it for this instance in your launcher.')],
      discriminator: 'legacy-java8',
    });
  }

  // Which jar holds the too-new class (if it is a mod class, not Minecraft or the loader)?
  let jar = h.modId && index ? jarsForModId(h.modId, index)[0] : undefined;
  if (!jar && h.cls && index && !/^(?:net\.minecraft\.|com\.mojang\.|cpw\.mods\.|net\.minecraftforge\.|net\.neoforged\.|net\.fabricmc\.loader\.)/.test(h.cls)) {
    jar = jarsForPackage(packageOf(h.cls), index, true)[0];
  }
  const top = jar && index ? topLevel(jar, index) : undefined;
  const modLabel = top ? `${jarLabel(top, h.modId)} (${top.fileName})` : h.modId;
  const need = h.needed;
  const current = h.current;
  // A mod needing more Java than its Minecraft version ships with is built for a newer Minecraft.
  const modTooNew = Boolean(modLabel) && need !== null && mcMin !== null && need > mcMin;
  const culprits = refs(ctx, [top], h.modId);
  const needText = need !== null ? `Java ${need}` : 'a newer Java';
  const steps = [
    `Install ${needText} (64-bit, e.g. Eclipse Temurin ${need ?? ''}) and select it for this instance in your launcher.`.replace('  ', ' '),
  ];
  if (mcMin !== null && ctx.mcVersion) steps.push(`Minecraft ${ctx.mcVersion} itself needs Java ${mcMin} or newer.`);

  if (modTooNew) {
    return finding(ctx, {
      code: 'C-JAVA-VERSION',
      severity: h.severity,
      title: `${modLabel} needs ${needText}, newer than Minecraft ${ctx.mcVersion ?? ''} uses`,
      explanation: `${modLabel} is compiled for ${needText}${current !== null ? ` but the game runs on Java ${current}` : ''}. Minecraft ${ctx.mcVersion ?? ''} only requires Java ${mcMin ?? '?'}, so this build of the mod is most likely meant for a newer Minecraft version.`,
      culprits,
      evidence,
      fixes: [...disable(culprits[0]), manual(`Download the build of ${modLabel} for Minecraft ${ctx.mcVersion ?? 'this version'}.`, ...steps)],
      discriminator: `java:${need ?? '?'}`,
    });
  }

  return finding(ctx, {
    code: 'C-JAVA-VERSION',
    severity: h.severity,
    title: `The game needs ${needText}${current !== null ? ` but runs on Java ${current}` : ''}`,
    explanation: `${modLabel ? `${modLabel} is` : h.cls ? `${h.cls} is` : 'The game is'} compiled for ${needText}${current !== null ? `, and the instance is started with Java ${current}` : ''}. Switch the instance to ${needText} or newer.`,
    culprits,
    evidence,
    fixes: [manual(...steps)],
    discriminator: `java:${need ?? '?'}`,
  });
}

export const javaVersionPattern: CrashPattern = {
  id: 'java-version',
  codes: ['C-JAVA-VERSION'],
  anchors: [
    // The Java launcher could not load the game's main class (too-new class file): the game
    // never starts. LaunchWrapper (≤1.12.2) on Java 9+ fails this cast in its main method.
    ...fatal('Error: LinkageError occurred while loading main class', 'cannot be cast to class java.net.URLClassLoader'),
    // A mod's class can also be probed (and the error caught) by a running game.
    ...contextual(
      'UnsupportedClassVersionError',
      'class file version',
      'Unsupported major.minor version',
      ' (java), but only the wrong version',
      'requires Java ',
    ),
  ],
  match(input) {
    const ctx = ctxOf(input);
    const hits = new Map<string, Hit>();
    const add = (i: number, key: string, init: Omit<Hit, 'lineIdx' | 'severity'>, fatal = true): void => {
      const severity = gate(ctx, i, { fatal });
      if (!severity) return;
      const h = hits.get(key) ?? { ...init, lineIdx: [], severity: null };
      h.lineIdx.push(i);
      h.severity = worst(h.severity, severity);
      hits.set(key, h);
    };
    ctx.lines.forEach((l, i) => {
      const t = l.text;
      const cv = CLASS_VERSION.exec(t);
      if (cv) {
        const needed = javaFeatureForClassMajor(Number(cv[2]));
        const current = javaFeatureForClassMajor(Number(cv[3]));
        add(i, `java:${needed ?? '?'}`, { needed, current, cls: normalizeClassName(cv[1] ?? '') });
        return;
      }
      const old = OLD_MAJOR.exec(t);
      if (old) {
        const major = Number(old[2] ?? old[3]);
        const needed = javaFeatureForClassMajor(major);
        add(i, `java:${needed ?? '?'}`, { needed, current: null, ...(old[1] ? { cls: normalizeClassName(old[1]) } : {}) });
        return;
      }
      const fj = FABRIC_JAVA.exec(t);
      if (fj) {
        const needed = parseRequiredJava(fj[4] ?? '');
        const id = fj[2] ?? '';
        add(i, `java:${needed ?? '?'}`, {
          needed,
          current: Number(fj[5]),
          ...(id && id !== 'minecraft' ? { modId: id } : {}),
        });
        return;
      }
      if (LAUNCHWRAPPER.test(t)) {
        add(i, 'legacy', { needed: 8, current: null, legacy: true });
        return;
      }
      const g = GENERIC.exec(t);
      if (g) {
        const needed = Number(g[1] ?? g[2]);
        if (needed >= 8 && needed <= 40) add(i, `java:${needed}`, { needed, current: null }, false);
      }
    });
    return [...hits.values()].flatMap((h) => toFinding(ctx, h) ?? []);
  },
};
