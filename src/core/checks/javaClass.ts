/**
 * W-JAVA-CLASS: a loaded top-level jar has class files compiled for a newer Java than the pack's
 * Minecraft version requires (`minJavaForMinecraft`). A launcher that picks Java by Minecraft
 * version then crashes with `UnsupportedClassVersionError`.
 * - **warning** when the top-level jar's *own* classes need the newer Java (the user may already
 *   run a newer Java, so not an error);
 * - **info** when only a bundled (nested, loaded) jar does: "a bundled module (X) needs Java N; it
 *   may be optional" — e.g. c2me-neoforge ships an optional natives-math module built for Java 25
 *   that is only used when available.
 * One finding per top-level jar. Skipped when the MC version is unknown/unrecognised or no class
 * version was sampled. Fix: manual (run a newer Java, or use a build for the pack's Java).
 */
import type { JarRecord } from '../../bindings';
import { javaFeatureForClassMajor, minJavaForMinecraft } from '../crash/javaVersions';
import type { Check, Finding } from '../model';
import { contextFor } from './context';
import { jarRef, makeFinding, manual } from './evidence';

export const javaClassCheck: Check = {
  id: 'java-class-version',
  codes: ['W-JAVA-CLASS'],
  run(input) {
    const ctx = contextFor(input);
    const mc = ctx.pack.mcVersion;
    const minJava = mc === null ? null : minJavaForMinecraft(mc);
    if (mc === null || minJava === null) return [];
    const nestedWorst = new Map<string, { jar: JarRecord; major: number }>();
    for (const jar of ctx.loadedJars) {
      if (jar.depth === 0 || jar.maxClassMajor === null) continue;
      const top = ctx.topOf(jar);
      const cur = nestedWorst.get(top.id);
      if (!cur || jar.maxClassMajor > cur.major) nestedWorst.set(top.id, { jar, major: jar.maxClassMajor });
    }
    const needsNewer = (major: number | null | undefined): number | null => {
      if (major === null || major === undefined) return null;
      const n = javaFeatureForClassMajor(major);
      return n !== null && n > minJava ? n : null;
    };
    const out: Finding[] = [];
    for (const top of ctx.loadedTopLevel) {
      const first = ctx.loaded(top)[0];
      const own = needsNewer(top.maxClassMajor);
      if (own !== null && top.maxClassMajor !== null) {
        out.push(
          makeFinding({
            code: 'W-JAVA-CLASS',
            severity: 'warning',
            title: `${top.fileName} needs Java ${own}, but Minecraft ${mc} ships with Java ${minJava}`,
            explanation:
              `${top.fileName} contains classes compiled for Java ${own} (class file version ${top.maxClassMajor}). Minecraft ${mc} is normally run with Java ${minJava}, ` +
              `and an older Java crashes with "UnsupportedClassVersionError" when the mod loads. ` +
              `Run the instance with Java ${own} or newer, or use a build of the mod made for Java ${minJava}.`,
            culprits: [jarRef(top, first?.modId)],
            evidence: [{ kind: 'note', text: `Highest class file version in ${top.fileName}: ${top.maxClassMajor} (Java ${own}).` }, ctx.packNote],
            fixes: [
              manual(
                `In your launcher's instance settings, select a Java ${own} (or newer) runtime.`,
                `Or replace ${top.fileName} with a build of the mod that targets Java ${minJava}.`,
              ),
            ],
            discriminator: '',
          }),
        );
        continue;
      }
      const worst = nestedWorst.get(top.id);
      const bundled = worst ? needsNewer(worst.major) : null;
      if (!worst || bundled === null) continue;
      const module = worst.jar.fileName;
      out.push(
        makeFinding({
          code: 'W-JAVA-CLASS',
          severity: 'info',
          title: `${top.fileName}: a bundled module (${module}) needs Java ${bundled}; it may be optional`,
          explanation:
            `${top.fileName} itself runs on Java ${minJava}, but the bundled ${worst.jar.path} contains classes compiled for Java ${bundled} ` +
            `(class file version ${worst.major}). Mods often ship such modules as optional extras used only on a newer Java. ` +
            `If the game crashes with "UnsupportedClassVersionError" naming it, run the instance with Java ${bundled} or newer.`,
          culprits: [jarRef(top, first?.modId)],
          evidence: [{ kind: 'note', text: `Highest class file version in ${worst.jar.path} (bundled in ${top.fileName}): ${worst.major} (Java ${bundled}).` }, ctx.packNote],
          fixes: [manual(`Only if the game crashes because of it: select a Java ${bundled} (or newer) runtime for the instance.`)],
          discriminator: '',
        }),
      );
    }
    return out;
  },
};
