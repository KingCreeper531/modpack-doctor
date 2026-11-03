/**
 * C-NOCLASSDEF: `NoClassDefFoundError` / `ClassNotFoundException` (crash-formats.md §3.7) and
 * Forge's `Attempted to load class … for invalid dist …`.
 *
 * Only reported when the occurrence is part of the crash: an ERROR/FATAL record (or a raw
 * trace / crash report) that a crash follows. DEBUG/INFO/WARN occurrences — common and harmless
 * during a normal launch (optional integrations probing for classes) — are ignored; an ERROR
 * without a crash is only a warning.
 */
import type { JarRecord } from '../../../bindings';
import type { CrashPattern, Finding, Severity } from '../../model';
import {
  ctxOf,
  disable,
  finding,
  framesAfter,
  gate,
  logEvidence,
  manual,
  mapFrames,
  refs,
  traceAt,
  worst,
  type Ctx,
  type MappedFrame,
} from '../context';
import { jarLabel, jarsForPackage, topLevel, uniqueTopLevel } from '../jars';
import { normalizeClassName, packageOf, simpleName } from '../text';

const MISSING = /\b(NoClassDefFoundError|ClassNotFoundException)(?::\s*|\s+)([A-Za-z_$][\w$]*(?:[./][\w$]+)+)/;
const INVALID_DIST = /Attempted to load class ([\w$/.]+) for invalid dist (\w+)/;
const INIT_FAILED = /NoClassDefFoundError: Could not initialize class/;

/** Package prefix → the mod that usually provides it (hint when nothing in the pack does). */
const KNOWN_PROVIDERS: readonly [string, string][] = [
  ['dev.architectury.', 'Architectury API (architectury)'],
  ['me.shedaniel.clothconfig2.', 'Cloth Config API (cloth-config)'],
  ['me.shedaniel.autoconfig.', 'Cloth Config API (cloth-config)'],
  ['net.fabricmc.fabric.', 'Fabric API (fabric-api)'],
  ['org.quiltmc.qsl.', 'Quilted Fabric API / QSL (qsl)'],
  ['software.bernie.geckolib.', 'GeckoLib (geckolib)'],
  ['mod.azure.azurelib.', 'AzureLib (azurelib)'],
  ['top.theillusivec4.curios.', 'Curios API (curios)'],
  ['dev.emi.trinkets.', 'Trinkets (trinkets)'],
  ['com.terraformersmc.modmenu.', 'Mod Menu (modmenu)'],
  ['dev.isxander.yacl3.', 'YetAnotherConfigLib (yet_another_config_lib_v3)'],
  ['dev.isxander.yacl.', 'YetAnotherConfigLib (yet-another-config-lib)'],
  ['mezz.jei.', 'Just Enough Items (jei)'],
  ['snownee.jade.', 'Jade (jade)'],
  ['dev.emi.emi.', 'EMI (emi)'],
  ['me.shedaniel.rei.', "Roughly Enough Items (roughlyenoughitems)"],
  ['com.llamalad7.mixinextras.', 'MixinExtras (mixinextras)'],
  ['kotlin.', 'a Kotlin language adapter (fabric-language-kotlin / kotlinforforge)'],
  ['thedarkcolour.kotlinforforge.', 'Kotlin for Forge (kotlinforforge)'],
  ['net.blay09.mods.balm.', 'Balm (balm)'],
  ['fuzs.puzzleslib.', 'Puzzles Lib (puzzleslib)'],
  ['com.teamresourceful.resourcefullib.', 'Resourceful Lib (resourcefullib)'],
  ['io.wispforest.owo.', 'oωo-lib (owo)'],
  ['dev.ftb.mods.ftblibrary.', 'FTB Library (ftblibrary)'],
  ['vazkii.patchouli.', 'Patchouli (patchouli)'],
  ['com.github.alexthe666.citadel.', 'Citadel (citadel)'],
  ['net.createmod.catnip.', 'Ponder / Catnip (ponder)'],
  ['com.simibubi.create.', 'Create (create)'],
  ['team.reborn.energy.', 'Team Reborn Energy (team_reborn_energy)'],
  ['dev.latvian.mods.rhino.', 'Rhino (rhino)'],
  ['dev.latvian.mods.kubejs.', 'KubeJS (kubejs)'],
  ['com.mrcrayfish.framework.', 'Framework (framework)'],
  ['net.optifine.', 'OptiFine'],
  ['net.minecraftforge.', 'Forge (this mod is for Forge, not this loader)'],
  ['net.neoforged.', 'NeoForge (this mod is for NeoForge, not this loader)'],
];

interface Missing {
  cls: string;
  dist?: string;
  lineIdx: number[];
  first: number;
  severity: Severity | null;
}

function isMinecraft(cls: string): boolean {
  return /^(?:net\.minecraft\.|com\.mojang\.)/.test(cls);
}

function knownProvider(cls: string): string | undefined {
  return KNOWN_PROVIDERS.find(([p]) => cls.startsWith(p))?.[1];
}

/** Frames that attempted the load: the occurrence's own trace segment first, then the rest. */
function requesterFrames(ctx: Ctx, i: number, exclude: ReadonlySet<string>): MappedFrame[] {
  const t = traceAt(ctx, i) ?? ctx.traces.find((tr) => tr.start > i && tr.start <= i + 2);
  // Indented causes (`-fml.txt` `	Caused by 0: …` + `		at …`) are not column-0 traces.
  if (!t) return mapFrames(ctx, framesAfter(ctx, i), exclude);
  const own = t.segments.findIndex((s, k) => s.idx <= i && (t.segments[k + 1]?.idx ?? Infinity) > i);
  const ordered = own >= 0 ? [t.segments[own], ...t.segments.filter((_, k) => k !== own)] : t.segments;
  return mapFrames(ctx, ordered.flatMap((s) => s?.frames ?? []), exclude);
}

function toFinding(ctx: Ctx, m: Missing): Finding | null {
  if (!m.severity) return null;
  const index = ctx.index;
  const pkg = packageOf(m.cls);
  const providers: JarRecord[] = index && !isMinecraft(m.cls) ? uniqueTopLevel(jarsForPackage(pkg, index, true), index) : [];
  const exclude = new Set(providers.map((p) => p.id));
  const frames = requesterFrames(ctx, m.first, exclude);
  const requester = frames.find((f) => f.hit.jar) ?? frames[0];
  const requesterJar = requester?.hit.jar && index ? topLevel(requester.hit.jar, index) : undefined;
  const requesterLabel = requesterJar ? `${jarLabel(requesterJar)} (${requesterJar.fileName})` : requester?.hit.label;
  const who = requesterLabel ?? 'A mod';
  const evidence = [logEvidence(ctx, m.lineIdx, { frames: frames.slice(0, 5), context: 2 })];
  const unresolved = requester && !requester.hit.jar ? [requester.hit.label] : [];
  const simple = simpleName(m.cls);

  if (m.dist || isMinecraft(m.cls)) {
    const clientOnServer = m.dist !== undefined || /\.client\./.test(m.cls);
    const culprits = refs(ctx, [requesterJar]);
    return finding(ctx, {
      code: 'C-NOCLASSDEF',
      severity: m.severity,
      title: clientOnServer
        ? `${who} loads client-only class ${simple}${m.dist ? ` on a ${m.dist.toLowerCase().replace('_', ' ')}` : ''}`
        : `${who} needs Minecraft class ${simple}, which does not exist in this version`,
      explanation: clientOnServer
        ? `${m.cls} only exists on the client, but ${requesterLabel ?? 'a mod'} tried to load it${m.dist ? ` on a ${m.dist}` : ''}. The mod is client-only (or has a side bug); remove it from the server.`
        : `${m.cls} is part of Minecraft, but this Minecraft version does not have it. ${requesterLabel ?? 'The mod that referenced it'} is built for a different Minecraft version; replace it with a matching build.`,
      culprits,
      evidence,
      fixes: [
        ...disable(culprits[0]),
        manual(
          clientOnServer
            ? `Remove ${requesterLabel ?? 'the client-only mod'} from the server's mods folder (keep it on clients).`
            : `Install the build of ${requesterLabel ?? 'the mod'} made for this Minecraft version.`,
        ),
      ],
      discriminator: m.cls,
      unresolved,
    });
  }

  if (providers.length > 0) {
    const provider = providers[0];
    const providerLabel = provider ? `${jarLabel(provider)} (${provider.fileName})` : pkg;
    const culprits = refs(ctx, [...providers.slice(0, 1), requesterJar]);
    return finding(ctx, {
      code: 'C-NOCLASSDEF',
      severity: m.severity,
      title: `${who} needs ${simple}, which ${providerLabel} does not have`,
      explanation: `${requesterLabel ?? 'A mod'} looked for ${m.cls}. Its package is provided by ${providerLabel}, but this version of it does not contain that class, so the two mods are probably built for different versions of each other.`,
      culprits,
      evidence,
      fixes: [
        manual(
          `Update ${providerLabel} to the version ${requesterLabel ?? 'the other mod'} expects (check its required dependencies), or use an older ${requesterLabel ?? 'mod'} that matches.`,
        ),
        ...(requesterJar ? disable(refs(ctx, [requesterJar])[0]) : []),
      ],
      discriminator: m.cls,
      unresolved,
    });
  }

  const hint = knownProvider(m.cls);
  const culprits = refs(ctx, [requesterJar]);
  return finding(ctx, {
    code: 'C-NOCLASSDEF',
    severity: m.severity,
    title: `${who} needs ${simple}, which is not installed${hint ? ` (likely ${hint})` : ''}`,
    explanation: `${requesterLabel ?? 'A mod'} tried to load ${m.cls}, but no installed jar contains ${pkg}. This is almost always a missing dependency${hint ? `: ${hint}` : ''}.${requesterLabel ? ` Install what ${requesterLabel} requires, or remove it.` : ''}`,
    culprits,
    evidence,
    fixes: [
      manual(
        hint
          ? `Install ${hint} for this Minecraft version and loader.`
          : `Install the mod that provides ${pkg} (check the required dependencies of ${requesterLabel ?? 'the mod that crashed'}).`,
      ),
      ...disable(culprits[0]),
    ],
    discriminator: m.cls,
    unresolved,
  });
}

export const noClassDefPattern: CrashPattern = {
  id: 'no-class-def',
  codes: ['C-NOCLASSDEF'],
  anchors: ['NoClassDefFoundError', 'ClassNotFoundException', 'Attempted to load class', 'for invalid dist'],
  match(input) {
    const ctx = ctxOf(input);
    const found = new Map<string, Missing>();
    ctx.lines.forEach((l, i) => {
      let cls: string | undefined;
      let dist: string | undefined;
      const inv = INVALID_DIST.exec(l.text);
      if (inv) {
        cls = normalizeClassName(inv[1] ?? '');
        dist = inv[2];
      } else {
        if (INIT_FAILED.test(l.text)) return; // static initialiser failure, not a missing class
        const m = MISSING.exec(l.text);
        if (!m) return;
        cls = normalizeClassName(m[2] ?? '');
      }
      if (!cls || !cls.includes('.')) return;
      const severity = gate(ctx, i);
      if (!severity) return;
      const entry = found.get(cls) ?? { cls, lineIdx: [], first: i, severity: null };
      if (dist) entry.dist = dist;
      entry.lineIdx.push(i);
      entry.severity = worst(entry.severity, severity);
      found.set(cls, entry);
    });
    return [...found.values()].flatMap((m) => toFinding(ctx, m) ?? []);
  },
};
