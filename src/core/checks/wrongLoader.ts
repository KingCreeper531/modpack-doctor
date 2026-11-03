/**
 * E-WRONG-LOADER: an active top-level jar the pack's loader does not load as a mod. Severity
 * follows what the loader actually does (docs/research/loader-enforcement.md, third round):
 *
 * | Situation | Forge 1.13+ · NeoForge < 1.20.6 | NeoForge 1.20.6+ / 21.x | Fabric | Quilt | Legacy FML (< 1.13) |
 * |---|---|---|---|---|---|
 * | metadata the loader doesn't read (Fabric-only, neoforge.mods.toml on Forge, mods.toml on NeoForge ≥ 1.20.5, Quilt-only) | info: ignored | warning: skipped, "Warnings while loading mods" screen (`brokenfile.fabric` / `minecraft_forge` / `quilt` / `unknown`) | — | — | none (classpath) |
 * | a file the loader reads *requires* the other FML loader (`neoforge` on Forge, `forge` on NeoForge ≥ 1.20.2) | error | error | — | — | — |
 * | Forge/NeoForge (or Quilt-only) jar | — | — | warning: ignored | warning: blocking "unsupported mods" prompt | — |
 * | no mods metadata, no recognised `FMLModType` | none | ONE warning per pack listing them ("not a mod file") | none | none | none |
 *
 * - NeoForge's switch to the warning screen came with FML 3.0.19 inside 1.20.6; every 1.20.6
 *   build (and an unknown MC version) is treated as warning.
 * - A recognised `FMLModType` (MOD / GAMELIBRARY / LIBRARY, LANGPROVIDER on Forge) makes modern
 *   FML load the jar: no finding.
 * - Legacy FML: a `mods.toml`-only jar is an error ("made for Minecraft 1.13+") only when its
 *   declared `minecraft` range excludes the pack version (real 1.12.2 mods ship leftover templates).
 * - Not reported: entries of an `unknown` loader, jars with a parse error in a file the loader
 *   reads (W-CORRUPT-JAR), Fabric jars Sinytra Connector loads or skips (checks/connector.ts),
 *   unknown or vanilla packs.
 * Fix: disable the jar (each jar, for the "not a mod file" list).
 */
import type { JarRecord, LoaderKind, ModMeta } from '../../bindings';
import type { Check, Finding, Severity } from '../model';
import {
  describeLoader,
  FABRIC_JSON,
  fmlEra,
  fmlLoadsModType,
  LOADER_NAMES,
  loaderAccepts,
  loaderReadsFile,
  mcIs,
  metadataLessJarLoaded,
  MODS_TOML,
  NEOFORGE_TOML,
  QUILT_JSON,
} from '../pack';
import { versionApi } from '../version';
import { contextFor } from './context';
import { disable, jarRef, listText, makeFinding, metadataEvidence, modIdLines, modName, plural } from './evidence';

/** NeoForge's `brokenfile.*` key for a jar it skips. */
function brokenFileKind(declared: readonly ModMeta[]): string {
  const files = new Set(declared.map((m) => m.metadataFile));
  if (files.has(FABRIC_JSON)) return 'brokenfile.fabric';
  if (files.has(MODS_TOML)) return 'brokenfile.minecraft_forge';
  if (files.has(QUILT_JSON)) return 'brokenfile.quilt';
  return 'brokenfile.unknown';
}

/** A read entry that declares a required dependency on the other FML loader. */
function otherLoaderRequirement(kind: LoaderKind, mc: string | null, jar: JarRecord, declared: readonly ModMeta[]): ModMeta | undefined {
  const other = kind === 'forge' ? 'neoforge' : kind === 'neoforge' ? 'forge' : null;
  // On 1.20.1 NeoForge is Forge 47.x-compatible both ways (CONTRACTS invariant 12); with an
  // unknown MC version it might be 1.20.1, so nothing is reported.
  if (other === null || mc === null || mcIs(mc, '1.20.1')) return undefined;
  return declared.find(
    (m) => loaderReadsFile(kind, mc, jar, m.metadataFile) && m.deps.some((d) => d.modId === other && d.kind === 'required'),
  );
}

export const wrongLoaderCheck: Check = {
  id: 'wrong-loader',
  codes: ['E-WRONG-LOADER'],
  run(input) {
    const ctx = contextFor(input);
    const kind = ctx.pack.loader?.kind;
    if (!kind || kind === 'unknown') return [];
    const mc = ctx.pack.mcVersion;
    const era = fmlEra(kind, mc);
    const loaderName = LOADER_NAMES[kind];
    const packLoader = describeLoader(ctx.pack);
    const out: Finding[] = [];
    const notMods: JarRecord[] = [];

    for (const jar of ctx.topLevel) {
      if (ctx.isDropped(jar)) continue; // E-DUP-ID covers dropped copies
      if ((jar.metadataErrors ?? []).some((e) => loaderReadsFile(kind, mc, jar, e.file))) continue;
      const declared = jar.mods.filter((m) => m.loader !== 'unknown');
      // (d) is checked first: it applies even when the entry is otherwise relevant (a
      // neoforge.mods.toml requiring `forge`).
      const requires = era !== null && era !== 'legacy' ? otherLoaderRequirement(kind, mc, jar, declared) : undefined;
      if (!requires) {
        if (ctx.relevant(jar).length > 0) continue;
        if (ctx.connector.ignored(jar) !== null) continue; // skipped silently by Sinytra Connector
        if (era !== null && era !== 'legacy' && fmlLoadsModType(kind, jar.fmlModType)) continue; // loaded via FMLModType
      }
      if (declared.length === 0) {
        if (era === 'warn' && jar.mods.length === 0 && !metadataLessJarLoaded(kind, mc, jar)) notMods.push(jar);
        continue;
      }
      const loaders = [...new Set(declared.map((m) => LOADER_NAMES[m.loader]))];
      const declaredNote = {
        kind: 'note' as const,
        text: `Declared loader${loaders.length > 1 ? 's' : ''}: ${loaders.join(', ')} (${[...new Set(declared.map((m) => m.metadataFile))].join(', ')}).`,
      };
      const push = (severity: Severity, first: ModMeta, title: string, explanation: string, highlight: number[]): void => {
        out.push(
          makeFinding({
            code: 'E-WRONG-LOADER',
            severity,
            title,
            explanation,
            culprits: [jarRef(jar, first.modId)],
            evidence: [...(first.metadataExcerpt ? [metadataEvidence(jar, first, highlight)] : []), declaredNote, ctx.packNote],
            fixes: [disable(jar)],
            discriminator: '',
          }),
        );
      };

      // (d) A file the loader reads requires the other FML loader → missing dependency → error.
      if (requires) {
        const other = kind === 'forge' ? 'neoforge' : 'forge';
        const name = modName(requires);
        const dep = requires.deps.find((d) => d.modId === other);
        const lines = modIdLines(requires);
        const depLine = requires.metadataExcerpt.split(/\r?\n/).findIndex((l) => new RegExp(`modId\\s*=\\s*["']${other}["']`).test(l));
        push(
          'error',
          requires,
          `${jar.fileName} requires ${LOADER_NAMES[other]}, but this pack runs ${loaderName}`,
          `${loaderName} reads ${name}'s ${requires.metadataFile}, which lists a required dependency on "${other}"` +
            `${dep && dep.range.raw.length > 0 ? ` (${dep.range.raw.join(', ')})` : ''}. ${loaderName} does not provide "${other}", so it stops at ` +
            `startup with a missing-dependency error. Disable ${jar.fileName} and install the ${loaderName} build of ${name}, if one exists.`,
          depLine >= 0 ? [...lines, depLine + 1] : lines,
        );
        continue;
      }

      const unread = declared.find((m) => loaderAccepts(kind, mc, m) && !loaderReadsFile(kind, mc, jar, m.metadataFile));
      const first = unread ?? declared[0];
      if (!first) continue;
      const name = modName(first);

      if (era === 'legacy') {
        // Legacy FML finds mods by their @Mod class; other jars go on the classpath. A
        // mods.toml-only jar is reported only with positive evidence it targets 1.13+.
        const tomlOnly = declared.every((m) => m.metadataFile === MODS_TOML || m.metadataFile === NEOFORGE_TOML);
        const modern =
          tomlOnly && mc !== null && declared.some((m) => m.mcRange !== null && versionApi.satisfies(mc, m.mcRange, 'minecraft') === false);
        if (!modern) continue;
        push(
          'error',
          first,
          `${jar.fileName} is made for Minecraft 1.13+, but this pack runs ${mc}`,
          `${name} (${jar.fileName}) only declares itself in ${first.metadataFile}, a format introduced with Minecraft 1.13. ` +
            `Forge on ${mc} never reads that file; it finds the mod class and refuses it as made for a different Minecraft version. ` +
            `Disable it and install the build of ${name} for ${mc}, if one exists.`,
          modIdLines(first),
        );
        continue;
      }

      const what = unread
        ? `only has ${unread.metadataFile}, which ${loaderName}${mc ? ` on ${mc}` : ''} does not read`
        : `is a ${loaders.join('/')} mod`;
      const missing = 'Anything that depends on it will be missing.';
      if (era === 'silent') {
        push(
          'info',
          first,
          unread ? `${jar.fileName} ${what} — ignored by the loader` : `${jar.fileName} ${what} — ignored by ${loaderName}`,
          `${name} (${jar.fileName}) ${what}${unread ? '' : `, which ${packLoader} does not load`}. ${loaderName} skips it silently ` +
            `(only a debug log line), so the game starts without it. ${missing} Disable it, or install the ${loaderName} build of ${name}.`,
          modIdLines(first),
        );
      } else if (era === 'warn') {
        const key = brokenFileKind(declared);
        push(
          'warning',
          first,
          `${jar.fileName} ${what} — skipped by ${loaderName}`,
          `${name} (${jar.fileName}) ${what}${unread ? '' : `, which ${packLoader} does not load`}. ${loaderName} skips it and lists it on the ` +
            `"Warnings while loading mods" screen (${key}) at every launch. ${missing} Disable it, or install the ${loaderName} build of ${name}.`,
          modIdLines(first),
        );
      } else if (kind === 'fabric') {
        push(
          'warning',
          first,
          `${jar.fileName} ${what} — ignored by Fabric Loader`,
          `${name} (${jar.fileName}) ${what}, so Fabric Loader ignores it (one warning line in the log). ${missing} ` +
            `Disable it, or install the Fabric build of ${name}.`,
          modIdLines(first),
        );
      } else if (kind === 'quilt') {
        push(
          'warning',
          first,
          `${jar.fileName} ${what} — Quilt shows a blocking prompt`,
          `${name} (${jar.fileName}) ${what}. Quilt Loader shows a blocking "unsupported mods" prompt at launch (Exit / Continue), ` +
            `and if you continue the mod is not loaded. ${missing} Disable it, or install the Quilt or Fabric build of ${name}.`,
          modIdLines(first),
        );
      }
    }

    if (notMods.length > 0) {
      const names = notMods.map((j) => j.fileName);
      out.push(
        makeFinding({
          code: 'E-WRONG-LOADER',
          severity: 'warning',
          title: `${plural(notMods.length, 'jar')} in the mods folder ${notMods.length === 1 ? 'is' : 'are'} not a mod file`,
          explanation:
            `${listText(names, 6)} ${notMods.length === 1 ? 'has' : 'have'} no mod metadata and no FMLModType, so ${loaderName} skips ` +
            `${notMods.length === 1 ? 'it' : 'them'} and lists ${notMods.length === 1 ? 'it' : 'them'} on the "Warnings while loading mods" screen ` +
            `(brokenfile.unknown). If ${notMods.length === 1 ? 'it is' : 'they are'} not needed, disable ${notMods.length === 1 ? 'it' : 'them'}.`,
          culprits: notMods.map((j) => jarRef(j)),
          evidence: [{ kind: 'note', text: `Not mod files: ${names.join(', ')}.` }, ctx.packNote],
          fixes: notMods.map(disable),
          discriminator: 'not-a-mod-file',
        }),
      );
    }
    return out;
  },
};
